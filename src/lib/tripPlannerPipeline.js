// ── Shared Trip Planner pipeline ─────────────────────────────────────────────
// Single source of truth for the search → synthesize → verify → review logic
// used by BOTH:
//   - the on-screen flow in src/App.jsx (TripPlanner component's generate())
//   - the background/email flow in api/plan-trip-background.js
//
// Extracted 2026-07-29 so a future accuracy fix (like the directional-spread
// crowding fix, the warm-urban-gauge exclusion, or the App Dev 39 ranking-rule
// fix) only ever has to happen in ONE place. See GUIDES_CHOICE_CONTEXT.md for
// the history of fixes to this exact logic — that history is why this file
// exists instead of two copies.
//
// Deliberately NOT included here (left as each caller's own responsibility):
//   - Geocoding the destination, fetching weather, and fetching USGS gauges.
//     Those belong to the wider USGS/weather data-access layer shared with
//     other tabs (Streams, GaugeChart, etc.) — moving them here would touch
//     unrelated features far outside this change's scope. Each caller fetches
//     this data its own way and passes it in already-fetched.
//   - Persistence (saveReportRow / planner_reports writes) — the browser and
//     the server use different Supabase access patterns (anon client with a
//     live session vs. a captured JWT), so each caller persists its own result.
//
// AI calls and Google Places lookups are done through an injected `aiCtx`
// object rather than called directly, so this file never needs to know
// whether it's running in the browser (relative fetch("/api/claude") + the
// user's Supabase session) or on the server (direct Anthropic/Places calls
// with server-only API keys):
//
//   aiCtx = {
//     askAI: async (prompt, useSearch, maxTokens, kind, useFetch) => "text",
//     geocodePlaces: async (name, regionHint) => ({lat,lng}) | null
//   }

// ── Warm-urban gauge exclusion (App Dev 34/39) ───────────────────────────────
export const WARM_URBAN_BASE_RE=/\bS(?:OUTH)?\.?\s*PLATTE\b|\bCHERRY\s+CR(?:EEK)?\b/i;
export const WARM_URBAN_PLACE_RE=/\b(DENVER|ENGLEWOOD|COMMERCE\s*CITY|HENDERSON|64TH|88TH|BRIGHTON|FORT\s+LUPTON|UNION\s+AVE(?:NUE)?|GLENDALE)\b/i;
export function isWarmUrbanGauge(name){
  const n=String(name||"");
  return WARM_URBAN_BASE_RE.test(n)&&WARM_URBAN_PLACE_RE.test(n);
}

// Direction-balanced trim: keeps up to `budget` items from `list`, round-robining across 8
// compass directions from the origin instead of taking the nearest N globally. Prevents a
// dense cluster of close gauges in one direction from crowding out a real drainage farther
// out in a different direction, within the same search radius.
export function directionalSpread(list,budget,lat,lng){
  if(!Array.isArray(list)||list.length<=budget)return list;
  const buckets=Array.from({length:8},()=>[]);
  list.forEach(item=>{
    const dy=(item.lat!=null?item.lat:lat)-lat,dx=(item.lng!=null?item.lng:lng)-lng;
    const deg=(Math.atan2(dx,dy)*180/Math.PI+360)%360; // bearing from origin, 0=N, clockwise
    buckets[Math.floor(((deg+22.5)%360)/45)].push(item);
  });
  const out=[];
  let added=true;
  while(added&&out.length<budget){
    added=false;
    for(const b of buckets){
      if(out.length>=budget)break;
      if(b.length){out.push(b.shift());added=true;}
    }
  }
  return out;
}

// Remove whole sentences that push afternoon/midday fishing (applied only under thermal risk)
export function scrubAfternoonPush(text){
  if(!text)return text;
  let t=String(text);
  t=t.replace(/[^.!?]*\bdo(?:n't|\s+not)\s+skip\s+afternoon[^.!?]*[.!?]/gi,"");
  t=t.replace(/[^.!?]*\bafternoon[^.!?]*\b(?:remains|stays|is|can\s+fish|fishes?)\s*(?:highly\s+|acceptably\s+)?(?:viable|productive|fishable|acceptable|well|fine)[^.!?]*[.!?]/gi,"");
  t=t.replace(/[^.!?]*\bmidday[^.!?]*\b(?:productive|acceptable|fishes\s+well|remains|fine)[^.!?]*[.!?]/gi,"");
  t=t.replace(/[^.!?]*\bfish(?:ing)?\s+(?:throughout|across|all)\s+(?:the\s+)?day[^.!?]*[.!?]/gi,"");
  return t.replace(/\s{2,}/g," ").trim();
}

// Softer, non-definite warm-day tip used by the LAB planner (advisory is driven by shop
// reports + air temp, not gauge water temps).
export const THERMAL_TIP_SOFT="On a warm day, consider getting an early start and carrying a stream thermometer \u2014 if the water reads over 65\u00B0F, head home and let the fish rest for a while.";
// Shop/report-flagged heat signal — fires when the retrieved reports flag heat, or the air
// is genuinely hot. High-precision phrases so cold-canyon and generic morning advice don't trip it.
export const HEAT_SHOP_RE=/heat advisory|hoot[\s-]?owl|warm(?:ing)?\s+water|water\s+(?:is|are|has been|getting|turning|running)\s+(?:too\s+)?warm|water\s+temp\w*[^.]{0,40}(?:warm|high|upper\s*60|rising|climbing|push\w*|[78]\d)|too\s+warm\s+for\s+trout|thermal\s+(?:stress|refuge)|rest\s+the\s+fish|let\s+(?:the\s+fish|them)\s+rest|fish(?:ing)?\s+early\s+(?:and|because|due|to)\b|get\s+out\s+early|off\s+the\s+water\s+by\s+(?:mid|early|10|11|noon)/i;

// Banned flow-praise words slipped twice through the prompt rule -> deterministic now
export function scrubBannedFlowWords(text){
  if(!text)return text;
  return String(text).replace(/\bgoldilocks\b/gi,"well-suited").replace(/\b(ideal|perfect)(ly)?\b/gi,(m,w,ly)=>ly?"well":"well-suited");
}

// When a river's Tailwater badge is demoted, dam claims in its prose must go too.
// This only ever runs once a pick has already been determined NOT to be a tailwater, so
// ANY sentence naming a specific controlling dam/reservoir or describing regulated releases
// at that point is fabricated — not just the two literal phrases originally covered here.
// (2026-08-08: the narrower version missed "Cold, steady releases from Ralston Reservoir
// above Golden maintain water temperature..." for Clear Creek, since that sentence never
// contained the words "dam-controlled" or "tailwater conditions".)
export function scrubDamClaims(text){
  if(!text)return text;
  let t=String(text);
  t=t.replace(/[^.!?;]*\b[A-Z][A-Za-z'.-]*(?:\s+[A-Z][A-Za-z'.-]*){0,3}\s+(?:Reservoir|Dam)\b[^.!?;]*[.!?;]?/g,"");
  t=t.replace(/[^.!?;]*\bdam[\s-]?control(?:led|s)?\b[^.!?;]*[.!?;]?/gi,"");
  t=t.replace(/[^.!?;]*\btailwater\s+conditions?\b[^.!?;]*[.!?;]?/gi,"");
  t=t.replace(/[^.!?;]*\b(?:bottom[- ]release|regulated\s+releases?|controlled\s+releases?|releases?\s+from\s+(?:the\s+)?(?:dam|reservoir))\b[^.!?;]*[.!?;]?/gi,"");
  t=t.replace(/[^.!?;]*\bbelow\s+the\s+dam\b[^.!?;]*[.!?;]?/gi,"");
  return t.replace(/\s{2,}/g," ").replace(/^\s*[,;]\s*/,"").trim();
}

// Same purpose as scrubDamClaims, for the accessPoints array — entries are short standalone
// phrases rather than full sentences, so a matching entry is dropped outright instead of
// trimmed mid-phrase.
function scrubDamAccessPoints(accessPoints){
  if(!Array.isArray(accessPoints))return accessPoints;
  const hit=/\b[A-Z][A-Za-z'.-]*(?:\s+[A-Z][A-Za-z'.-]*){0,3}\s+(?:Reservoir|Dam)\b|\bdam[\s-]?control(?:led|s)?\b|\btailwater\b|\bbelow\s+the\s+dam\b/i;
  const kept=accessPoints.filter(a=>!hit.test(String(a||"")));
  return kept.length?kept:accessPoints; // never empty solely because of the scrub
}

// ── Fly-name integrity ────────────────────────────────────────────────────
export const FLY_CANON="Pheasant Tail, Hare's Ear, Copper John, RS2, Zebra Midge, Elk Hair Caddis, Stimulator, Chubby Chernobyl, Parachute Adams, Pat's Rubber Legs, Woolly Bugger, San Juan Worm, Squirmy Worm, Prince Nymph, Griffith's Gnat, Frenchie, Perdigon, Juju Baetis, Rainbow Warrior, Walt's Worm, Sparkle Dun, Comparadun, Higa's SOS, Two-Bit Hooker, Barr's Emerger, Sculpzilla, sculpin pattern, egg pattern (Y2K), Mop Fly, Hot-Spot Pheasant Tail, blue-winged olive / PMD / caddis emergers, Hopper, Ant, Beetle, soft hackle, Bird's Nest";
const NON_FLY_RE=/\b(?:pautzke|power\s?bait|fire\s?bait|gulp!?|berkley|(?:salmon|trout|fish|cured)\s+eggs?(?!\s*(?:pattern|fly|bug|imitation))|\broe\b|night\s?crawler|meal\s?worm|wax\s?worm|maggots?|marshmallow|velveeta|rooster\s?tail|mepps|panther\s?martin|blue\s?fox|kastmaster|little\s?cleo|rapala|spinnerbait|\bspoon\b|(?:canned|kernel|sweet)\s+corn|live\s+bait)\b/i;
const GARBLE_FLY_RE=/(?:^|\s)(?:hatch|hatches|emergence|activity|assortment|selection|various)\s*$/i;
function flyCore(f){return String(f).replace(/\([^)]*\)/g,"").replace(/#?\s?\d+\s?[-\u2013]\s?\d+/g,"").replace(/#\d+/g,"").replace(/\bsize\b/ig,"").replace(/[,;].*$/,"").trim();}
export function cleanFlyList(arr){
  if(!Array.isArray(arr))return [];
  const baitClean=arr.filter(f=>f&&!NON_FLY_RE.test(String(f)));
  const deGarbled=baitClean.filter(f=>!GARBLE_FLY_RE.test(flyCore(f)));
  return deGarbled.length?deGarbled:baitClean; // never empty solely because of the garble guard
}

// Search-driven synthesis prompt: candidates come from the RETRIEVED REPORTS,
// gauges are a live-flow + reality-check layer (not the candidate list).
export function buildLabSynth(a){
  const loc=a.loc,ds=a.ds,wx=a.wx,fishableGauges=a.fishableGauges,pTempMap=a.pTempMap||{},flowAvgMap=a.flowAvgMap||{},savedInRadius=a.savedInRadius||[],thermalRisk=a.thermalRisk,airF=a.airF,maxWaterF=a.maxWaterF,searchTxt=a.searchTxt||"";
  const wxF=wx?Math.round((wx.current&&wx.current.temperature_2m)||0)+"F":"unknown";
  const gaugeBlock=fishableGauges.length?[...fishableGauges].sort((a,b)=>((a.dist!=null?a.dist:9)-(b.dist!=null?b.dist:9))).map(g=>{
    const fva=flowVsAverageLocal(g.cfs,flowAvgMap[g.siteNo]);
    const avgNote=fva?(", "+fva.label+" vs. ~"+fva.avgCfs+" CFS typical for this time of year"):"";
    return g.name+" ("+Math.round(g.cfs||0)+" CFS"+(g.dist!=null?" - ~"+Math.round(g.dist*69)+" mi":"")+avgNote+")";
  }).join("; "):"none";
  const home=savedInRadius.length?(" User home waters: "+savedInRadius.map(s=>s.site_name||s.name||"").filter(Boolean).join(", ")+"."):"";
  const heat=thermalRisk?(" WARM-DAY NOTE"+(airF!=null?" (air "+airF+"F)":"")+": suggest an early start and carrying a stream thermometer; note that if a stream warms past about 65F it is kindest to rest the fish and head home, but do NOT state this as an absolute ban - base any afternoon caution on each water's own elevation and likely temperature, since cold high-country and tailwater can fish well into the day."):"";
  return [
    "You are a fly fishing guide planning a trout day for a client near "+loc.label+". Date: "+ds+". Weather: "+wxF+".",
    "RETRIEVED REPORTS (current intel synthesized from multiple independent public sources - fishing reports, guide services, state wildlife agencies, tourism and reference sites): "+(String(searchTxt).slice(0,5000)||"none")+".",
    "USGS live gauges within range (these are REAL local streams with live flow - use them BOTH to attach live flow AND as a candidate source: include any gauged stream that is genuine trout water near here, but SKIP warmwater or bass streams. They do not replace the reports - combine the two): "+gaugeBlock+"."+home+heat,
    "FLOW LANGUAGE RULE: when a gauge above includes a 'vs. ~X CFS typical' note, that is the ONLY basis for describing how the flow compares to normal (e.g. 'well below average', 'about average') - use that exact phrasing or a close paraphrase, never invent your own characterization of whether a flow is low, moderate, or high. When a gauge has NO such note, describe the raw CFS number and what it suits for wading/technique WITHOUT any comparative judgment (do not say 'moderate' or 'good flows' with no baseline to support it) - stick to what the number itself supports.",
    "DISTANCE LANGUAGE RULE: you do NOT have real drive-time data for any individual pick - never state a specific number of minutes or hours to reach one named water anywhere in this report (this applies to the overview, recommendation, and every per-river field alike). Describe order only, in relative terms (e.g. 'the closest option here', 'a bit farther', 'the longest drive of the group', 'on the way toward X'). The app calculates and displays each pick's real drive time separately from your text - a specific guessed number can only end up contradicting it.",
    "TASK: Like a real guide, name the BEST trout fisheries within about a 2-hour drive of "+loc.label+", ranked best to worst (maximum 6; return fewer if fewer truly deserve it - never pad).",
    "SELECTION RULES: (1) Build the candidate list from TWO sources combined: (a) the trout fisheries the RETRIEVED REPORTS establish near here - this catches tailwaters and famous water that may have no nearby gauge or a gauge named for a dam or lake; and (b) the gauged streams above that are genuine trout water. Do NOT silently drop a close gauged trout stream just because the reports did not mention it, and do NOT include a gauged stream that is warmwater or bass water. Corroborate report-only picks across more than one source where possible.",
    "(2) TAILWATERS: cold water below a dam is often the premier trout fishery in a region; include the relevant tailwater even when no gauge is named like a trout stream. When the reports clearly establish a water is a below-dam tailwater, set its \"verified\" field to \"tailwater\".",
    "(3) DISTANCE DISCIPLINE: only recommend water realistically within ~2 hours. Do NOT reach for famous names farther than that. Do NOT let a famous distant fishery crowd out quality water within about an hour. If a gauged stream within range is genuine trout water, keep a place for it.",
    "(4) For every pick give your best lat and lng so distance can be verified. Set \"source\" to \"gauge\" if the pick matches one of the listed gauges, otherwise \"search\".",
    "(5) Do NOT invent water that appears in neither the reports nor the gauge list. Exclude urban drainage, irrigation, and warmwater bass streams presented as trout water. If the RETRIEVED REPORTS identify a nearby water as warmwater, smallmouth, or bass water - or list it under 'AVOID AS TROUT WATER' - do NOT include it as a trout fishery even when it is gauged or close; trust the reports' species designation over a bare gauge.",
    "(6) If NO genuine trout water is within about 2 hours, say so plainly in the overview, and STILL include the single nearest real trout fishery as one river entry with an honest note that reaching it is a road-trip beyond day-trip range - NEVER return an empty rivers list.",
    "(7) Each river entry must be ONE specific fishery - one tailwater below ONE dam, or one continuous section. NEVER combine two different tailwaters, two different dams, or two far-apart access points into a single entry; if two are both worth recommending, list them as SEPARATE entries each with its own coordinates and access points.",
    "(8) DRAINAGE INTEGRITY: every access point, road, put-in, dam, town, and confluence you list for a river MUST lie on THAT river, within its own drainage. NEVER borrow a neighboring stream's feature - do not put a Bear Creek dam or confluence on Clear Creek, do not list a downstream-plains town and a far-upstream reservoir as two access points on the same canyon stream, do not attach one reservoir's road to a different tailwater. Name only the river's OWN dam and OWN confluence. If you are not certain a specific access point belongs to this exact stream, give a general nearby town or omit it rather than borrowing one from another drainage. This rule is about keeping a CHOSEN river's own features correct - it is NOT a reason to skip a close stream you are less sure of; pick the close stream and give it a general nearby town as access.",
    "(9) PROXIMITY COVERAGE: a real guide starts a client on the CLOSEST quality trout water and only reaches farther for variety. The gauge list above is ordered nearest-first. Always include the nearest genuine trout streams (the closest 2-3 trout drainages within ~30-60 min) BEFORE adding a famous water 1.5-2 hours away. NEVER omit a close gauged trout stream in order to list a distant famous one, and NEVER give two slots to one distant river system while closer trout drainages within range go unlisted. Spread picks across DIFFERENT drainages and DIFFERENT directions from the origin, not a single corridor. One farther marquee water is fine for range, but the closest trout waters must anchor the list.",
    "(10) FINAL RANKING - recommendation AND bestFor: rule 9 controls which waters make the candidate list, but does NOT by itself decide which included water is today's single best bet or which wins each bestFor category - do not default to whichever entry is simply closest. Weigh how well each INCLUDED water fits TODAY specifically: on a hot day a stable cold tailwater is often the stronger recommendation than a closer freestone stream precisely because it will not warm past a safe range, even if it takes a little longer to reach; on an overcast, cool, or high-flow day that same tradeoff may not apply. Choose the recommendation and each bestFor category (mostFish, bestScenery, mostSolitude, beginners) based on which included water genuinely best fits today's conditions and that category's own criterion - draw from the FULL rivers list, not only the closest one or two entries, and do not let every category default to the same one or two waters when the list holds real variety.",
    "CREDIBILITY RULES: label type 'Tailwater' only for water directly below a major dam, otherwise 'Freestone'. NEVER call a flow perfect, ideal, or Goldilocks - say what the number suits (wading, nymphing, dries) and note fish are caught across a wide range. Frame crowd levels as likelihood from access and popularity, never as fact. Base time-of-day advice on the given season and temperatures; with cold spring/early-summer water midday often fishes well, so do not give generic avoid-midday advice unless temps warrant it. Hatch guidance must match the date's month and region. FLY NAMES: name flies ONLY from the recognized national canon, matched to the hatch and season you identified - choose only from: "+FLY_CANON+". You may pick a specific modern pattern from that canon when it fits the hatch, but NEVER invent a pattern name and NEVER copy a one-off local shop or guide pattern from the reports - name only complete, widely recognized patterns a typical fly shop would stock. Every fly must be a full pattern name, never a tying style or descriptor with a generic noun (for example never 'Parachute Hatch' - write 'Parachute Adams'), and never a hatch or event named as if it were a fly. Attach a person's name to a fly only when it is a recognized pattern. In high water fish hold in soft edges and banks - never claim high flow concentrates fish in main-channel runs.",
    "SOURCING: synthesize the reports into your own original assessment. Do NOT rely on a single source and do NOT name, quote, or attribute any specific shop, business, website, or author.",
    "Keep each field to 1 sentence. Return ONLY JSON no markdown: ",
    '{"overview":"","recommendation":"","bestFor":{"mostFish":"","bestScenery":"","mostSolitude":"","beginners":""},"rivers":[{"name":"","lat":0,"lng":0,"type":"","source":"","verified":"","cfs":"","condition":"","crowdLevel":"","conditions":"","techniques":"","bestTime":"","accessPoints":[],"flies":[],"why":""}],"hatches":"","bestTimes":"","tips":"","flyBoxEssentials":[]}'
  ].join(" ");
}
// Small local copy of flowVsAverage (also defined in App.jsx for the live/GaugeChart
// path) — tiny, stable, deterministic; duplicated rather than imported to avoid a
// cross-bundle dependency for one 10-line function.
function flowVsAverageLocal(cfs,avgCfs){
  if(cfs==null||isNaN(cfs)||avgCfs==null||isNaN(avgCfs)||avgCfs<=0)return null;
  const pct=(cfs-avgCfs)/avgCfs;
  let label;
  if(pct<=-0.6)label="well below average";
  else if(pct<=-0.3)label="below average";
  else if(pct<0.3)label="about average";
  else if(pct<0.6)label="above average";
  else label="well above average";
  return{label,pct:Math.round(pct*100),avgCfs:Math.round(avgCfs)};
}

// Deterministic distance governor: drop picks beyond the day-trip ring, and
// reconcile each pick's displayed CFS to the live gauge value when one attached.
async function labGovernor(rivers,loc){
  if(!Array.isArray(rivers)||!rivers.length)return rivers;
  const haveOrigin=loc&&loc.lat!=null&&loc.lng!=null;
  let elevs=null;
  if(haveOrigin){
    try{
      const lats=[loc.lat,...rivers.map(r=>r.lat!=null?r.lat:loc.lat)];
      const lngs=[loc.lng,...rivers.map(r=>r.lng!=null?r.lng:loc.lng)];
      const eu="https://api.open-meteo.com/v1/elevation?latitude="+lats.join(",")+"&longitude="+lngs.join(",");
      const er=await fetch(eu);const ej=await er.json();
      elevs=Array.isArray(ej.elevation)?ej.elevation:null; // meters: [origin, ...picks]
    }catch(e){elevs=null;}
  }
  const originElevM=elevs?elevs[0]:null;
  const CAP_MIN=150;
  const annotated=rivers.map((r,i)=>{
    const cfs=(r.gaugeCfs!=null)?String(Math.round(r.gaugeCfs)):r.cfs;
    const source=r.gaugeSnap?"gauge":(r.source||"search");
    let mi=null,driveMin=null;
    if(haveOrigin&&r.lat!=null&&r.lng!=null){
      mi=Math.round(Math.hypot(r.lat-loc.lat,r.lng-loc.lng)*69);
      const pickElevM=elevs?elevs[i+1]:null;
      const maxFt=(originElevM!=null&&pickElevM!=null)?Math.max(originElevM,pickElevM)*3.281:null;
      const mountain=maxFt!=null&&maxFt>6500; // high country: winding roads + passes
      const circuity=mountain?1.6:1.25;
      const speed=mountain?50:58;
      driveMin=Math.round((mi*circuity)/speed*60);
    }
    return{...r,cfs,source,miFromOrigin:mi,driveMin};
  });
  return annotated.map(r=>{
    if(r.driveMin==null||r.driveMin<=CAP_MIN)return r;
    const hrs=r.driveMin?Math.round(r.driveMin/6)/10:null;
    const note="⚠ Beyond day-trip range"+(hrs?" (~"+hrs+" h drive)":"")+" — plan an overnight rather than a day trip.";
    return {...r,outOfRange:true,why:(note+" "+(r.why||"")).trim(),conditions:(note+" "+(r.conditions||"")).trim()};
  });
}

// Deterministic backstop to the deep-read grounding
const WARM_TEXT_RE=/transition zone|borderline trout|marginal[^.]{0,20}trout|warmwater (?:fishery|stream|water)|primarily (?:bass|smallmouth)|bass (?:water|stream|fishery)/i;
function dropWarmwaterByText(rivers){
  if(!Array.isArray(rivers)||!rivers.length)return rivers;
  const txt=r=>[r.name,r.type,r.why,r.conditions,r.condition,r.techniques].map(v=>String(v||"")).join(" ");
  const kept=rivers.filter(r=>!WARM_TEXT_RE.test(txt(r)));
  return kept.length?kept:rivers;
}

// Deterministic backstop for known Denver-metro warm-urban reaches — checked against
// both the pick's own name and its snapped real USGS gauge name. Never empties the list.
export function dropWarmUrbanPicks(rivers){
  if(!Array.isArray(rivers)||!rivers.length)return rivers;
  const kept=rivers.filter(r=>!isWarmUrbanGauge(r.name)&&!isWarmUrbanGauge(r.gaugeSnap));
  return kept.length?kept:rivers;
}

// ---- Verification layer: authoritative data SUGGESTS, verification DECIDES. ----
function damFromGauge(g){
  const s=String(g||"").toUpperCase();
  const m=s.match(/\b(?:BELOW|BLW)\s+([A-Z][A-Z0-9 .'\-]*?)(?:\s+(?:RES\w*|DAM|LAKE)\b|,|\s+(?:AT|NEAR|NR)\b|$)/);
  return m?m[1].replace(/[^A-Z0-9 ]/g," ").replace(/\s+/g," ").trim():"";
}
function titleCaseWords(s){return String(s||"").toLowerCase().replace(/\b\w/g,c=>c.toUpperCase());}
// Deterministic dam-name fix: when a pick is typed Tailwater and its snapped gauge names a
// dam, but the prose names a DIFFERENT dam, correct the prose to the gauge's dam.
export function damNameReconcile(rivers){
  if(!Array.isArray(rivers))return rivers;
  const damRe=/\b(?:below|blw|under|tailwater (?:below|of))\s+(?:the\s+)?([A-Z][A-Za-z0-9 .'\-]*?)\s+(?:dam|reservoir)\b|\b([A-Z][A-Za-z0-9 .'\-]*?)\s+(?:dam|reservoir)\b/i;
  return rivers.map(r=>{
    if(!/tailwater/i.test(String(r.type||"")))return r;
    const gDam=damFromGauge(r.gaugeSnap);
    if(!gDam)return r;
    const fields=[r.why,r.conditions,r.techniques,r.name].map(v=>String(v||"")).join("  ");
    const m=damRe.exec(fields);
    const pDam=m?String(m[1]||m[2]||"").replace(/[^A-Za-z0-9 ]/g," ").replace(/\s+/g," ").trim().toUpperCase():"";
    if(!pDam)return r;
    const a=gDam.replace(/\s+/g,""),b=pDam.replace(/\s+/g,"");
    if(a===b||a.includes(b)||b.includes(a))return r; // names agree -> no conflict
    const good=titleCaseWords(gDam);
    const re=new RegExp("\\b"+pDam.replace(/[.*+?^${}()|[\]\\]/g,"\\$&").replace(/\s+/g,"\\s+")+"\\b","gi");
    const fix=t=>String(t||"").replace(re,good);
    const note="⚠ Live gauge data places this tailwater below "+good+" Dam; the dam name was corrected.";
    return {...r,why:(note+" "+fix(r.why)).trim(),conditions:fix(r.conditions),techniques:fix(r.techniques)};
  });
}
// Parse the deep-read's "AVOID AS TROUT WATER:" line(s) into normalized stream names.
function parseAvoidList(ground){
  const out=[];const re=/AVOID AS TROUT WATER:\s*([^\n\r]*)/ig;let m;
  while((m=re.exec(String(ground||"")))){
    m[1].split(/[,;]|\band\b/i).forEach(p=>{const t=p.replace(/[^A-Za-z0-9 ]/g," ").replace(/\s+/g," ").trim();if(t.length>=4)out.push(t.toLowerCase());});
  }
  return out;
}
function coreNormBase(s){return String(s||"").toLowerCase().replace(/[^a-z0-9 ]/g," ").replace(/\b(the|creek|river|stream|fork)\b/g," ").replace(/\s+/g," ").trim();}
function coreNormBare(s){return coreNormBase(s).replace(/\b(north|south|east|west|middle|upper|lower)\b/g," ").replace(/\s+/g," ").trim();}
function avoidHit(name,avoid){
  const nFull=coreNormBase(name),nBare=coreNormBare(name);
  if(!nBare)return false;
  const nHasDir=nFull!==nBare;
  return avoid.some(a=>{
    const aFull=coreNormBase(a),aBare=coreNormBare(a);
    if(aBare.length<3)return false;
    if(nHasDir||aFull!==aBare){
      return nFull===aFull;
    }
    return nBare.includes(aBare)||aBare.includes(nBare);
  });
}
// Skeptical verification pass: one batched Sonnet search asks, for each pick, coldwater
// trout vs warmwater/bass. DROP only on a direct contradiction. LABEL 'unsure' picks;
// never penalize on silence; never empty the list. Fail-open.
async function labVerifyPicks(rivers,loc,ground,aiCtx){
  if(!Array.isArray(rivers)||!rivers.length)return rivers;
  const avoid=parseAvoidList(ground);
  const flags=rivers.map(r=>({avoid:avoidHit(r.name,avoid)}));
  if(avoid.length)flags.forEach((f,i)=>{if(f.avoid)console.warn("[labVerifyPicks] dropping \""+(rivers[i]&&rivers[i].name)+"\" — matched AVOID list entry among:",avoid);});
  let verdicts=[];
  try{
    const items=rivers.map((r,i)=>(i+1)+") "+String(r.name||"?")+(r.type?" ["+r.type+"]":"")+(r.gaugeSnap?" (gauge: "+r.gaugeSnap+")":"")).join("  ");
    const vp=["You are a skeptical senior fly fishing guide fact-checking a trip plan near "+((loc&&loc.label)||"the area")+".",
      "For EACH numbered water below, use current public sources to decide TWO things: (1) whether it is a COLDWATER TROUT fishery, or a WARMWATER/bass/smallmouth water that is NOT trout water; (2) whether it is a FREESTONE stream or a TAILWATER (flows directly below a dam or reservoir) — the water's own bracketed label may be wrong, so verify it independently rather than assuming the label given is correct.",
      "Be conservative on both: answer 'warmwater' ONLY when sources clearly establish the water is primarily bass/smallmouth/warmwater and not a trout fishery — if uncertain, answer 'unsure' rather than guessing. Only report a 'type' when your sources clearly establish it one way or the other; omit the field entirely if you're not sure, rather than guessing.",
      "If 'type' is 'tailwater', you MUST also return 'dam' with the actual name of the specific dam or reservoir it flows below, confirmed by your sources — a stream name is often a common one shared by unrelated drainages elsewhere, so do not name a dam from memory or general knowledge, only from what your sources confirm for THIS water. If you cannot confirm the specific dam/reservoir by name, omit 'type' entirely rather than asserting 'tailwater' without one.",
      "Return ONLY a JSON array, one object per item, SAME ORDER, no markdown: ",
      '[{"n":1,"verdict":"trout|warmwater|unsure","type":"freestone|tailwater","dam":""}]. Omit "type" if unsure. Omit "dam" entirely unless "type" is "tailwater".',
      "Waters: "+items].join(" ");
    const race=Promise.race([aiCtx.askAI(vp,true,1500,"planner"),new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")),85000))]);
    const clean=String(await race||"").replace(/```json|```/g,"").trim();
    const a=clean.indexOf("["),b=clean.lastIndexOf("]");
    if(a!==-1&&b>a)verdicts=JSON.parse(clean.slice(a,b+1));
  }catch(_v){verdicts=[];}
  const byN=new Map();(Array.isArray(verdicts)?verdicts:[]).forEach((v,i)=>{const n=Number(v&&v.n)||(i+1);byN.set(n,v);});
  const NOTE_UNSURE="⚠ Species and location not confirmed by current reports — verify locally before relying on this pick.";
  const decided=rivers.map((r,i)=>{
    const v=byN.get(i+1)||{};const verdict=String(v.verdict||"").toLowerCase();
    const drop=flags[i].avoid||verdict==="warmwater";
    let why=r.why,type=r.type,conditions=r.conditions,techniques=r.techniques,accessPoints=r.accessPoints;
    if(!drop&&verdict==="unsure")why=(NOTE_UNSURE+" "+String(r.why||"")).trim();
    // Deterministic type correction (no visible warning) — same "just fix it" pattern as
    // damNameReconcile, rather than surfacing a confusing "mislabeled" sentence to the reader.
    // Catches cases enforceStreamTypes' gauge-name pattern match alone can miss, e.g. a genuine
    // tailwater whose gauge name doesn't literally spell out "BLW ... RES/DAM".
    if(!drop){
      const vType=String(v.type||"").toLowerCase();
      const vDam=String(v.dam||"").trim();
      // A bare "tailwater" verdict with no named dam doesn't override an existing type — same
      // fail-safe posture as "unsure". (2026-08-08: an unnamed tailwater verdict here is what
      // let a fabricated "Ralston Reservoir" survive for Clear Creek at Golden — the verdict
      // alone was trusted with nothing to back it up.)
      if(vType==="tailwater"&&vDam&&!/tailwater/i.test(String(type||""))){
        type="Tailwater";
      }else if(vType==="freestone"&&!/freestone/i.test(String(type||""))){
        type="Freestone";
        why=scrubDamClaims(why);
        conditions=scrubDamClaims(conditions);
        techniques=scrubDamClaims(techniques);
        accessPoints=scrubDamAccessPoints(accessPoints);
      }
    }
    return {r:{...r,why,type,conditions,techniques,accessPoints},drop};
  });
  const kept=decided.filter(d=>!d.drop).map(d=>d.r);
  if(kept.length)return kept;
  const top=decided[0].r; // never empty: keep top-ranked, clearly flagged
  return [{...top,why:("⚠ This pick was flagged during verification and could not be confirmed as trout water — treat as low confidence. "+String(top.why||"")).trim()}];
}

// Report-level review: names well-known trout waters in range the report omitted, and
// flags clear logic faults. Flag-only — never drops a pick, never invents a stream card.
async function labReviewReport(report,loc,ground,dateStr,aiCtx){
  try{
    if(!report||!Array.isArray(report.rivers))return null;
    const picks=report.rivers.map(r=>r&&r.name).filter(Boolean);
    if(!picks.length)return null;
    const riverFlies=report.rivers.filter(r=>r&&r.name).map(r=>r.name+": "+((Array.isArray(r.flies)?r.flies:[]).join(", ")||"(none)")).join(" | ");
    const promptCtx=[
      "You are a senior fly fishing guide fact-checking a draft trip report near "+((loc&&loc.label)||"the area")+" for "+(dateStr||"today")+".",
      "Streams: "+picks.join(", ")+".",
      riverFlies?("Per-stream fly lists — "+riverFlies+"."):"",
      report.hatches?("Hatch Activity text: "+String(report.hatches).slice(0,600)):"",
      report.bestTimes?("Best Times text: "+String(report.bestTimes).slice(0,300)):"",
      report.tips?("Insider Tips text: "+String(report.tips).slice(0,600)):"",
      "Do TWO things:",
      "A) OMISSIONS: up to 3 well-known public trout waters in similar drive range not listed — distinct fisheries, not two sections of one stream. Format each 'Name (where it is and why an angler would fish it — 6 words max)'. Describe the WATER for the reader; never critique the report or use words like ignored, skipped, missing, left out. Real recognized fisheries only; no invented or marginal water. Empty if none.",
      "B) CORRECTIONS: fix only CLEAR factual errors in the report's OWN content for this date and region — a hatch out of season, wrong fly SIZES for a hatch, a stream wrongly framed as tailwater/freestone in the narrative, or unsafe/self-contradictory timing. For each narrative field you change, return its corrected FULL text (same length and tone, only the facts fixed). For each stream whose flies are wrong, return its corrected fly list (recognized canon patterns only, never invented names). Change ONLY clear errors; OMIT anything already correct; never restyle or pad.",
      'Return ONLY JSON, no markdown: {"omissions":["Name — reason"],"fixes":{"hatches":"","bestTimes":"","tips":"","rivers":[{"name":"","flies":["",""]}]}}. Omit every key you are not changing; "fixes" can be empty.'
    ].filter(Boolean).join(" ");
    const race=Promise.race([aiCtx.askAI(promptCtx,true,2600,"planner"),new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")),95000))]);
    const clean=String(await race||"").replace(/```json|```/g,"").replace(/<cite[^>]*>|<\/cite>/g,"").trim();
    const a=clean.indexOf("{"),b=clean.lastIndexOf("}");
    if(a===-1||b<=a)return null;
    const o=JSON.parse(clean.slice(a,b+1));
    const clip=(s,n)=>{s=String(s||"").replace(/<cite[^>]*>|<\/cite>/g,"").replace(/\s+/g," ").trim();return s.length>n?s.slice(0,n-1).trim()+"…":s;};
    const omissions=Array.isArray(o.omissions)?o.omissions.map(x=>clip(x,100)).filter(s=>s.length>=3).slice(0,3):[];
    const fxIn=o.fixes||{};
    const txt=v=>{const s=String(v||"").replace(/<cite[^>]*>|<\/cite>/g,"").trim();return s.length>=20?s:"";};
    const fixes={};
    if(txt(fxIn.hatches))fixes.hatches=txt(fxIn.hatches);
    if(txt(fxIn.bestTimes))fixes.bestTimes=txt(fxIn.bestTimes);
    if(txt(fxIn.tips))fixes.tips=txt(fxIn.tips);
    if(Array.isArray(fxIn.rivers)){
      const rv=fxIn.rivers.map(r=>({name:String((r&&r.name)||"").trim(),flies:(Array.isArray(r&&r.flies)?r.flies:[]).map(f=>String(f||"").replace(/<cite[^>]*>|<\/cite>/g,"").trim()).filter(Boolean).slice(0,8)})).filter(r=>r.name&&r.flies.length);
      if(rv.length)fixes.rivers=rv.slice(0,6);
    }
    return {omissions,fixes};
  }catch(_r){return null;}
}

// Deterministic per-river regulatory-closure check (App Dev 40/41). Runs on the FINAL
// picks only, after synthesis — not every candidate gauge. Root cause this fixes:
// the only prior closure detection was HEAT_SHOP_RE regex-matching whatever text the
// general shop-report search happened to return; a river with no closure mentioned
// in THAT day's search results is not the same as no closure existing, and even a
// hit only set one blanket flag for the whole report, not a per-river note. This is
// a separate, targeted search for exactly the rivers in the final list. One combined
// call for all picks (not one per river) to keep cost/latency down, same shape as
// labReviewReport. Fails open: a timeout/error/parse-miss returns null and the
// report ships without a restriction note rather than guessing either way.
async function labVerifyRestrictions(rivers,loc,dateStr,aiCtx){
  const dbg={outcome:"not-run",checked:0,found:0};
  try{
    if(!Array.isArray(rivers)||!rivers.length){dbg.outcome="no-rivers";console.log("[restrictions]",dbg);return{result:null,debug:dbg};}
    const named=rivers.filter(r=>r&&r.name);
    if(!named.length){dbg.outcome="no-named-rivers";console.log("[restrictions]",dbg);return{result:null,debug:dbg};}
    dbg.checked=named.length;
    const riverList=named.map((r,i)=>{
      const ap=Array.isArray(r.accessPoints)?r.accessPoints.join("; "):(r.accessPoints||"");
      return (i+1)+". "+r.name+(ap?" — access points: "+ap:" — no access points given");
    }).join("\n");
    const ctx=[
      "You are checking current fishing regulations for a trip report near "+((loc&&loc.label)||"the area")+" for "+(dateStr||"today")+".",
      "Here is a numbered list of specific waters, each with its own access points:\n"+riverList,
      "Search for CURRENT hoot-owl restrictions, fishing closures, or other emergency angling restrictions (drought/heat-related or otherwise) from the relevant state wildlife agency and recent news.",
      "IMPORTANT: evaluate each numbered entry INDEPENDENTLY using its own access points, not just its river name. Multiple entries above can share the same river name but describe different, non-contiguous stretches of it — for example one entry may be upstream of a dam or reservoir and another downstream of it, which are physically different pieces of water even though they share a name. A restriction found for one stretch of a named river must NOT be applied to a different entry on the same river unless the restricted reach clearly overlaps with THAT entry's own access points.",
      "EXCEPTION: Closures (fishing completely prohibited, all day) apply to whole rivers, not specific stretches. If you find a closure for a river name that matches any entry for that river, report it without requiring reach overlap verification. Hoot-owl restrictions (2pm-midnight only) ARE reach-specific and require you to verify the restricted reach overlaps with that entry's access points.",
      "A hoot-owl restriction prohibits fishing 2pm-midnight; a closure prohibits fishing entirely.",
      "Only report a restriction you can find from an official state wildlife agency page or a specific, recent (this season) news source — do not guess or infer one from general heat/drought conditions alone.",
      'Return ONLY JSON, no markdown: {"restrictions":[{"name":"copy the water\'s name EXACTLY as given in the numbered list above, character for character, unchanged","status":"hootowl or closure","hours":"e.g. 2pm-midnight, or all day for a closure — omit this field if status is closure","reach":"the restricted stretch, a few words, as your source states it — omit this field if status is closure (closures cover whole river)","asOf":"date or recency of your source, briefly"}]}. For closures: report if the river name matches, even if you aren\'t 100% certain every access point on that river is affected (closures are whole-river). For hoot-owls: only include if you verified the restricted reach overlaps with that entry\'s access points. Empty array if none found.'
    ].filter(Boolean).join(" ");
    let raw;
    try{
      raw=await Promise.race([aiCtx.askAI(ctx,true,2600,"planner"),new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")),95000))]);
      console.log("[restrictions] raw response (first 300 chars):",String(raw||"").slice(0,300));
    }catch(te){
      dbg.outcome=(te&&te.message==="timeout")?"timeout":"api-error";
      dbg.error=String((te&&te.message)||te).slice(0,120);
      console.warn("[restrictions]",dbg);
      return{result:null,debug:dbg};
    }
    const clean=String(raw||"").replace(/```json|```/g,"").replace(/<cite[^>]*>|<\/cite>/g,"").trim();
    const a=clean.indexOf("{"),b=clean.lastIndexOf("}");
    if(a===-1||b<=a){dbg.outcome="no-json-in-response";dbg.raw=clean.slice(0,150);console.warn("[restrictions]",dbg);return{result:null,debug:dbg};}
    let o;
    try{o=JSON.parse(clean.slice(a,b+1));}catch(pe){dbg.outcome="parse-fail";dbg.raw=clean.slice(a,a+150);console.warn("[restrictions]",dbg);return{result:null,debug:dbg};}
    const list=Array.isArray(o.restrictions)?o.restrictions:[];
    const clip=(s,n)=>{s=String(s||"").replace(/<cite[^>]*>|<\/cite>/g,"").replace(/\s+/g," ").trim();return s.length>n?s.slice(0,n-1).trim()+"…":s;};
    const out=list.map(r=>{
      const name=clip(r&&r.name,80);
      if(!name)return null;
      const status=(r&&r.status==="closure")?"closure":"hootowl";
      return {name,status,hours:clip(r&&r.hours,40),reach:clip(r&&r.reach,80),asOf:clip(r&&r.asOf,40)};
    }).filter(Boolean).slice(0,8);
    dbg.found=out.length;
    dbg.outcome=out.length?"found":"clear";
    console.log("[restrictions]",dbg,out.length?out:"");
    return{result:out.length?out:null,debug:dbg};
  }catch(_r){
    dbg.outcome="exception";
    dbg.error=String((_r&&_r.message)||_r).slice(0,120);
    console.warn("[restrictions]",dbg);
    return{result:null,debug:dbg};
  }
}
// Fold omissions into the overview as a clearly-marked footer.
export function applyReviewNotes(overview,review){
  if(!review||!review.omissions||!review.omissions.length)return overview;
  return (String(overview||"")+" ⚠ Also consider (verify flows): "+review.omissions.join("; ")+".").trim();
}

function enforceStreamTypes(rivers,keepVerified=false){
  if(!Array.isArray(rivers))return rivers;
  const damRe=/\b(BLW|BELOW)\b[\s\S]*\b(RES|RESERVOIR|DAM)\b|\b(RES|RESERVOIR|DAM)\b[\s\S]*\bOUTLET\b/i;
  return rivers.map(r=>{
    if(typeof r.type==="string"&&/tailwater/i.test(r.type)){
      const g=String(r.gaugeSnap||"");
      const verified=keepVerified&&/tailwater/i.test(String(r.verified||""));
      if(!damRe.test(g)&&!verified)return{...r,type:"Freestone",why:scrubDamClaims(r.why),conditions:scrubDamClaims(r.conditions),techniques:scrubDamClaims(r.techniques),accessPoints:scrubDamAccessPoints(r.accessPoints)};
    }
    return r;
  });
}

// Snap AI-suggested river coordinates to the nearest matching USGS gauge (surveyed coords beat AI guesses)
function snapRiversToGauges(rivers,gaugeList,maxDeg=Infinity){
  if(!Array.isArray(rivers)||!Array.isArray(gaugeList)||!gaugeList.length)return rivers;
  const ABBR={R:"RIVER",RIV:"RIVER",CRK:"CREEK",CR:"CREEK",CK:"CREEK",FK:"FORK",N:"NORTH",S:"SOUTH",E:"EAST",W:"WEST",ST:"SAINT",BLW:"BELOW",BL:"BELOW",ABV:"ABOVE",AB:"ABOVE",HWY:"HIGHWAY",NR:"NEAR",MTN:"MOUNTAIN",RD:"ROAD",FT:"FORT"};
  const norm=s=>{
    const raw=String(s||"").toUpperCase().replace(/[^A-Z0-9 ]/g," ").split(/\s+/).filter(Boolean);
    return raw.flatMap((t,i)=>{
      if(t==="ST"&&i>0&&/\d/.test(raw[i-1]))return["STREET"];
      return (ABBR[t]||t).split(" ");
    });
  };
  const streamPart=n=>String(n||"").toUpperCase().split(/\s+(?:AT|NEAR|NR|BLW?|BELOW|ABV?|ABOVE)\s+/)[0];
  return rivers.map(r=>{
    const rt=norm(String(r.name||"").replace(/,?\s+[A-Za-z]{2}\.?\s*$/,""));
    if(!rt.length)return r;
    let best=null,bestScore=0;
    for(const g of gaugeList){
      if(!(g.lat&&g.lng))continue;
      const gFull=norm(g.name);
      const gStream=norm(streamPart(g.name));
      let score=0;
      const allInStream=rt.every(t=>gStream.includes(t));
      if(allInStream&&gStream.length===rt.length)score=3;
      else if(allInStream)score=2;
      else if(rt.every(t=>gFull.includes(t)))score=1;
      if(score===0)continue;
      const d=(r.lat&&r.lng)?Math.hypot(g.lat-r.lat,g.lng-r.lng):(g.dist??9);
      if(!best||score>bestScore||(score===bestScore&&d<best._d)){best={...g,_d:d};bestScore=score;}
    }
    return (best&&best._d<=maxDeg)?{...r,lat:best.lat,lng:best.lng,gaugeSnap:best.name,siteNo:best.siteNo||r.siteNo||null,gaugeCfs:best.cfs!=null?best.cfs:null}:r;
  });
}

// Fusion guard: a real tailwater sits below ONE dam, so its access points cluster within
// a few miles. Narrows a fused two-dam entry to the mapped section and flags it.
function labSplitFused(rivers){
  if(!Array.isArray(rivers))return rivers;
  const coordRe=/(-?\d{1,3}\.\d{2,})[ ,]+(-?\d{1,3}\.\d{2,})/;
  const placeOf=s=>String(s||"").split(/[(—:\-]/)[0].replace(/\b(access|public|area|TU|BLM|parking|trailhead|bridge|road|pullouts?|section|the)\b/gi,"").replace(/\s+/g," ").trim();
  return rivers.map(r=>{
    if(!/tailwater/i.test(String(r.type||""))||r.lat==null||r.lng==null||!Array.isArray(r.accessPoints)||r.accessPoints.length<2)return r;
    const dist=(la,lo)=>Math.hypot(la-r.lat,lo-r.lng)*69;
    const tagged=r.accessPoints.map(a=>{const m=coordRe.exec(String(a));return m?{str:a,d:dist(parseFloat(m[1]),parseFloat(m[2]))}:{str:a,d:null};});
    const far=tagged.filter(a=>a.d!=null&&a.d>12);
    if(!far.length)return r;
    const kept=tagged.filter(a=>a.d==null||a.d<=12);
    const keptPlaces=[...new Set(kept.map(a=>placeOf(a.str)).filter(Boolean))];
    const farPlaces=[...new Set(far.map(a=>placeOf(a.str)).filter(Boolean))];
    let name=String(r.name||"");
    farPlaces.forEach(p=>{const esc=p.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");name=name.replace(new RegExp("\\s*[/,]\\s*"+esc,"gi"),"");});
    const note="⚠ This entry appears to combine two tailwaters below different dams. Narrowed to the "+(keptPlaces.join("/")||"mapped")+" section; the "+(farPlaces.join("/")||"other")+" stretch is below a different dam and is a separate fishery.";
    return {...r,name,accessPoints:kept.length?kept.map(a=>a.str):r.accessPoints,why:(note+" "+(r.why||"")).trim()};
  });
}

// Geocode a river name via Google Places (through the injected aiCtx — direct on the
// server, proxied through /api/claude on the browser). Returns {lat,lng} or null.
async function geocodeRiver(name,regionHint,aiCtx){
  try{
    const query=name+(regionHint?", "+regionHint:"")+" river fishing";
    return await aiCtx.geocodePlaces(query);
  }catch{return null;}
}

export async function finalizeLabRivers(rivers,gaugeList,loc,ground,aiCtx){
  let out=snapRiversToGauges(rivers,gaugeList,0.5); // a gauge can only attach within ~35 mi of the pick

  // For any pick that didn't snap to a gauge, try Places geocoding. Drop the pick ONLY if
  // Places found nothing at all — labGovernor (below) is the SINGLE distance authority for
  // "too far", terrain-aware rather than a flat mileage cut (see App Dev 23 follow-up).
  const regionHint=loc&&loc.label?loc.label.split(",").slice(-1)[0].trim():"";
  const geocoded=await Promise.all(out.map(async r=>{
    if(r.gaugeSnap)return r; // already pinned to a surveyed gauge — leave it
    const g=await geocodeRiver(String(r.name||""),regionHint,aiCtx);
    if(g)return{...r,lat:g.lat,lng:g.lng,geocodePinned:true};
    const hasOwnCoord=r.lat!=null&&r.lng!=null&&!isNaN(r.lat)&&!isNaN(r.lng)&&Math.abs(r.lat)<=90&&Math.abs(r.lng)<=180&&(r.lat!==0||r.lng!==0);
    if(hasOwnCoord)return{...r,geocodeApprox:true};
    return null;
  }));
  out=geocoded.filter(Boolean);
  if(!out.length&&rivers.length)out=rivers.slice(0,1); // last resort: never return empty

  out=enforceStreamTypes(out,true);
  out=labSplitFused(out);
  out=dropWarmwaterByText(out);
  out=dropWarmUrbanPicks(out);
  out=damNameReconcile(out);
  out=await labGovernor(out,loc);
  out=await labVerifyPicks(out,loc,ground,aiCtx);
  return out;
}

export function finalizeRivers(rivers,gaugeList,loc,ground,aiCtx){
  return finalizeLabRivers(rivers,gaugeList,loc,ground,aiCtx);
}

// Tiny, generic JSON-extraction helpers — duplicated from App.jsx (also used there by
// unrelated features) rather than imported, to avoid a circular import between this
// file and App.jsx.
function extractJSON(text){
  const c=text.replace(/```json|```/g,"").trim();
  try{const m=c.match(/\{[\s\S]*\}/);if(m)return JSON.parse(m[0]);}catch{}
  try{const m=c.match(/\[[\s\S]*\]/);if(m)return JSON.parse(m[0]);}catch{}
  return null;
}
function repairJSON(text){
  if(!text) return null;
  let c=String(text).replace(/```json|```/g,"").trim();
  const s=c.indexOf("{"), e=c.lastIndexOf("}");
  if(s===-1||e<=s) return null;
  c=c.slice(s,e+1);
  try{return JSON.parse(c);}catch{}
  let out="", inStr=false;
  for(let i=0;i<c.length;i++){
    const ch=c[i];
    if(inStr){
      if(ch==="\\"){ out+=ch+(c[i+1]??""); i++; continue; }
      if(ch==="\n"){ out+="\\n"; continue; }
      if(ch==="\r"){ out+="\\r"; continue; }
      if(ch==="\t"){ out+="\\t"; continue; }
      if(ch==="\""){
        let j=i+1; while(j<c.length&&/\s/.test(c[j]))j++;
        const nx=c[j];
        if(nx===undefined||nx===":"||nx===","||nx==="}"||nx==="]"){ out+="\""; inStr=false; }
        else { out+="\\\""; }
        continue;
      }
      out+=ch; continue;
    } else {
      if(ch==="\""){ out+=ch; inStr=true; continue; }
      if(ch===","){
        let j=i+1; while(j<c.length&&/\s/.test(c[j]))j++;
        if(c[j]==="}"||c[j]==="]"){ continue; }
        out+=ch; continue;
      }
      out+=ch; continue;
    }
  }
  try{return JSON.parse(out);}catch{}
  return null;
}

// Fishable-water filter applied to the raw USGS gauge list before it becomes AI-candidate
// material (same rule the on-screen flow has always used).
const NON_FISHABLE_WORDS=["canal","ditch","drain","diversion","lateral","irrigation","pipeline","tunnel","aqueduct","municipal","effluent","waste","sewage","outfall","reservoir","lake","pond","inlet","outlet","tailrace","headgate","bypass","flume","return","delivery","main","supply","project","district","well","spring","seep","buffer zone","landfill","plant","facility","treatment"];
export function filterFishableGauges(pgScaled,lat,lng){
  return directionalSpread(pgScaled.filter(g=>{
    const n=g.name.toLowerCase();
    const waterWords=["creek","river","brook"," run"," fork","branch","stream","slough","gulch","canyon","bayou","kill"," rio "," riv"," r "," cr"," ck"," fk"];
    const hasWater=waterWords.some(w=>n.includes(w));
    const hasNonFish=NON_FISHABLE_WORDS.some(w=>n.includes(w));
    return hasWater&&!hasNonFish&&!isWarmUrbanGauge(g.name);
  }),25,lat,lng);
}

// Shared name normalizer — was two separate inline copies (in the review-fold and the
// restrictions-fold below); unified here as the single source both use.
export function nrmName(s){return String(s||"").toLowerCase().replace(/[^a-z0-9]/g,"");}

// Strips a trailing parenthetical reach descriptor for loose name matching, e.g.
// "Colorado River (Kremmling to Dotsero tailwater)" -> "Colorado River". Used by
// reconcileBestBet to match the free-text "recommendation" field back to the river
// entry it's actually describing.
export function coreRiverName(name){
  return String(name||"").replace(/\s*\([^)]*\)\s*/g,"").trim();
}

// Auto-swaps the "Best Bet Today" recommendation when the pick it's actually about
// turns out to be ineligible — beyond day-trip range (labGovernor) or closed to fishing
// today (labVerifyRestrictions). Deterministic, no AI: matches the free-text
// recommendation back to a river by name (core name, parenthetical reach stripped),
// and if that river is ineligible, replaces the recommendation with the next eligible
// river's own already-vetted "why" text plus a note explaining the swap. Fail-open:
// if no match is found, or every river is ineligible, the original recommendation is
// left untouched rather than guessing.
export function reconcileBestBet(report){
  if(!report||!report.recommendation||!Array.isArray(report.rivers)||!report.rivers.length)return report;
  const recNorm=nrmName(report.recommendation);
  const ineligible=r=>r.outOfRange===true||(r.restriction&&r.restriction.status==="closure");
  const matched=report.rivers.find(r=>{
    const core=nrmName(coreRiverName(r.name));
    return core&&recNorm.includes(core);
  });
  if(!matched||!ineligible(matched))return report; // no match, or the pick is fine — leave it alone
  const alt=report.rivers.find(r=>r!==matched&&!ineligible(r));
  if(!alt)return report; // nothing eligible to swap to — leave the original, flagged pick as-is
  const reason=matched.restriction&&matched.restriction.status==="closure"?"closed to fishing today":"beyond realistic day-trip range today";
  const note="⚠ "+matched.name+" is "+reason+" — swapping today's best bet to "+alt.name+" instead. ";
  return {...report,recommendation:(note+(alt.why||alt.conditions||"See its river card below for details.")).trim()};
}

// Light-touch personalization (App Dev, added after the AI Intel feature): a short,
// deterministic note built from the angler's OWN logged trip history — never an AI
// call, so it can't hallucinate, and never touches river selection/verification above.
// input.anglerHistory is a pre-aggregated summary the caller builds from their own
// personal_trips/catches data — see buildAnglerHistorySummary in App.jsx. Returns null
// (renders nothing) unless there's enough real signal to say something honest.
export function buildPersonalAngle(anglerHistory){
  if(!anglerHistory||!anglerHistory.catchCount||anglerHistory.catchCount<3) return null;
  const {topFlies,topSpecies,cfsRange,catchCount,tripCount}=anglerHistory;
  const clauses=[];
  if(topSpecies) clauses.push(`you've mostly landed ${topSpecies}`);
  if(topFlies&&topFlies.length) clauses.push(`doing best on ${topFlies.join(", ")}`);
  if(cfsRange) clauses.push(`in flows roughly ${cfsRange.low}\u2013${cfsRange.high} CFS`);
  const base=`Based on your last ${tripCount} logged trip${tripCount===1?"":"s"} (${catchCount} catches)`;
  if(!clauses.length) return base+".";
  return base+" \u2014 "+clauses.join(", ")+".";
}

// ── The orchestrator ─────────────────────────────────────────────────────────
// Takes ALREADY-FETCHED destination/weather/gauge data (each caller fetches this its
// own way — see the file-header note) and runs the full search → synthesize → verify
// → review pipeline. Returns the finished report or throws with a user-facing message.
//
// input: { loc:{label,lat,lng}, ds (formatted date string), driveMinutes, wx, pgScaled
//          (raw USGS gauge array), savedGauges (user's saved gauges, for the "home
//          waters" note — [] if unavailable), pTempMap/flowAvgMap (optional enrichment
//          maps — {} is fine, the prompt degrades gracefully to raw CFS with no
//          vs.-average comparison) }
// aiCtx: { askAI(prompt,useSearch,maxTokens,kind,useFetch), geocodePlaces(name,regionHint) }
// onStep: optional (text, state) => void progress callback
export async function runTripPlannerPipeline(input, aiCtx, onStep){
  const step=(text,state)=>{ if(onStep) onStep(text,state); };
  const { loc, ds, pgScaled, wx } = input;
  const savedGauges = input.savedGauges||[];
  const pTempMap = input.pTempMap||{};
  const flowAvgMap = input.flowAvgMap||{};
  const driveMinutes = input.driveMinutes||120;

  const fishableGauges=filterFishableGauges(pgScaled||[],loc.lat,loc.lng);
  step("Analyzing area conditions…","active");
  const savedInRadius=savedGauges.filter(sg=>{if(!sg.lat||!sg.lng)return false;const d=Math.sqrt(Math.pow((sg.lat||0)-loc.lat,2)+Math.pow((sg.lng||0)-loc.lng,2))*69;return d<=140;});

  // Step 1: shop-report + general search, run in parallel with independent timeouts
  step("Reading shop reports — this can take a couple of minutes…","active");
  const searchPrompt1="Search fly shop websites for current fishing reports for "+ds+" within "+(driveMinutes<60?driveMinutes+" minute":Math.round(driveMinutes/60*10)/10+" hour")+" drive of "+loc.label+". Run SEPARATE searches for the area north of "+loc.label+", south of it, east of it, and west of it - a single combined search tends to satisfice on whichever nearby town comes up first and miss the other directions entirely. Find shops in every nearby town and city in each direction. List every stream mentioned with current conditions and flies working.";
  const searchPrompt2="Search for current trout fishing reports on major rivers and streams within "+(driveMinutes<60?driveMinutes+" minute":Math.round(driveMinutes/60*10)/10+" hour")+" drive of "+loc.label+". Run separate searches covering each compass direction independently (including over mountain passes where relevant) rather than one combined search, so a whole drainage in one direction isn't missed because another direction's results came back first. Note freestone vs tailwater, flows, and crowd levels for "+ds+".";
  let searchFailReason="";
  const withTO=(p,ms)=>Promise.race([p,new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")),ms))]);
  const onFail=e=>{searchFailReason=(e&&e.message==="timeout")?"timed out":"hit an error";return "";};
  const labFetchPrompt="Search for local fly shop fishing report pages within about a 2 hour drive of "+loc.label+". Then FETCH and read in full the 2-3 most relevant shop report pages. Report which trout streams are fishing best right now and why, with each stream's current conditions and its correct LOCAL geography - which canyon, which town, and for tailwaters which dam - stated exactly as the shop reports describe it. Do NOT substitute your own assumptions about where a stream is or which dam a tailwater sits below; if the reports do not say, do not guess. For EACH trout stream, take its access points, the road or canyon it runs through, its dam (if a tailwater) and its confluence from what the shops actually describe for THAT stream - never attach a feature that belongs to a neighboring stream or drainage. ALSO, from the same reports, identify which nearby streams within range are WARMWATER or smallmouth/bass water rather than trout water - local shops know which creeks hold bass, not trout - and list those by name on a separate line beginning 'AVOID AS TROUT WATER:' so they are not recommended as a trout destination. Report what insects are hatching or active (e.g. blue-winged olives, midges, caddis, stoneflies, terrestrials) and the water and conditions, but do NOT list specific commercial or shop fly-pattern names - fly selection is handled separately from the recognized national canon. Synthesize in your own words; do not name, quote, or attribute any specific shop. Be concise.";
  const tasks=[
    withTO(aiCtx.askAI(searchPrompt1,true,6000,"planner"),90000).catch(onFail),
    withTO(aiCtx.askAI(searchPrompt2,true,6000,"planner"),90000).catch(onFail)
  ];
  tasks.push(withTO(aiCtx.askAI(labFetchPrompt,true,7000,"planner",true),115000).catch(()=>""));
  const parts=await Promise.all(tasks);
  const labGround=String(parts[2]||"").trim();
  const searchTxt=((labGround?labGround+" ":"")+String(parts[0]||"")+" "+String(parts[1]||"")).trim();
  const searchNote=searchTxt.length>200?null:(searchFailReason?("Shop-report search "+searchFailReason+" — using live flows"):"No shop reports found — using live flows");

  // Step 2: synthesize into JSON
  step("Building recommendations…","active");
  const airF=(wx&&wx.current&&wx.current.temperature_2m!=null)?Math.round(wx.current.temperature_2m):null;
  const maxWaterF=Object.values(pTempMap).reduce((m,v)=>(v>m?v:m),0);
  const thermalRisk=(airF!=null&&airF>=85)||maxWaterF>=65;
  const shopHeat=HEAT_SHOP_RE.test(searchTxt);
  const eThermal=shopHeat||(airF!=null&&airF>=85);
  const synthPrompt=buildLabSynth({loc,ds,wx,fishableGauges,pTempMap,flowAvgMap,savedInRadius,thermalRisk:eThermal,airF,maxWaterF,searchTxt});
  let reportTxt;
  try{
    reportTxt=await aiCtx.askAI(synthPrompt,false,8000,"planner");
  }catch(se){
    if(se&&se.isLimit)throw se; // daily limit — retrying is pointless
    step("Upstream hiccup — retrying…","active");
    await new Promise(r=>setTimeout(r,2000));
    reportTxt=await aiCtx.askAI(synthPrompt,false,8000,"planner");
  }
  const clean=reportTxt.replace(/```json|```/g,"").trim();
  let rpt=null;
  try{rpt=JSON.parse(clean);}catch(pe){void 0;}
  if(!rpt){const s=clean.indexOf("{"),e=clean.lastIndexOf("}");if(s!==-1&&e>s)try{rpt=JSON.parse(clean.slice(s,e+1));}catch(pe2){void 0;}}
  if(!rpt) rpt=extractJSON(reportTxt);
  if(!rpt) rpt=repairJSON(reportTxt);

  if(!rpt||!(rpt.overview||rpt.rivers)){
    const err=new Error("The research step returned no usable report"+(String(searchTxt||"").length<200?" — the web search came back empty":"")+". Please try again in a moment.");
    throw err;
  }

  const toStr=v=>Array.isArray(v)?v.join(", "):typeof v==="object"&&v?JSON.stringify(v):v||"";
  const clean2=s=>(toStr(s)).replace(/<cite[^>]*>|<\/cite>/g,"");
  const sb2=t=>scrubBannedFlowWords(clean2(t));
  const bf2=rpt.bestFor?{mostFish:sb2(rpt.bestFor.mostFish),bestScenery:sb2(rpt.bestFor.bestScenery),mostSolitude:sb2(rpt.bestFor.mostSolitude),beginners:sb2(rpt.bestFor.beginners)}:null;

  // Report-level review runs in parallel with finalize (they're independent)
  const reviewPromise=labReviewReport({rivers:rpt.rivers,hatches:rpt.hatches,bestTimes:rpt.bestTimes,tips:rpt.tips},loc,searchTxt,ds,aiCtx).catch(()=>null);
  const restrictionsPromise=labVerifyRestrictions(rpt.rivers,loc,ds,aiCtx).catch(e=>({result:null,debug:{outcome:"promise-reject",error:String((e&&e.message)||e).slice(0,120)}}));

  let builtReport={
    searchNote,
    dataSource:searchTxt.length>200?"current":(fishableGauges.length||(pgScaled||[]).length)?"flows-live":"estimated",
    overview:sb2(rpt.overview),
    recommendation:sb2(rpt.recommendation),
    bestFor:bf2,
    rivers:await finalizeRivers((rpt.rivers||[]).map(r=>({...r,conditions:sb2(r.conditions),techniques:sb2(r.techniques),why:sb2(r.why),bestTime:eThermal?scrubAfternoonPush(clean2(r.bestTime)):clean2(r.bestTime),accessPoints:Array.isArray(r.accessPoints)?r.accessPoints:r.accessPoints?[String(r.accessPoints)]:[],flies:cleanFlyList(Array.isArray(r.flies)?r.flies:r.flies?[String(r.flies)]:[])})),fishableGauges.length?fishableGauges:(pgScaled||[]),loc,searchTxt,aiCtx),
    hatches:sb2(rpt.hatches),
    bestTimes:eThermal?scrubAfternoonPush(sb2(rpt.bestTimes)):sb2(rpt.bestTimes),
    tips:eThermal?(THERMAL_TIP_SOFT+" "+scrubAfternoonPush(sb2(rpt.tips))).trim():sb2(rpt.tips),
    flyBoxEssentials:cleanFlyList(Array.isArray(rpt.flyBoxEssentials)?rpt.flyBoxEssentials:[])
  };
  step("Report complete ✓");

  // Fold the review result in once it resolves
  try{
    const review=await reviewPromise;
    if(review){
      const fx=review.fixes||{};
      let changed=false;
      let nb={...builtReport};
      if(fx.hatches){nb.hatches=sb2(fx.hatches);changed=true;}
      if(fx.bestTimes){nb.bestTimes=eThermal?scrubAfternoonPush(sb2(fx.bestTimes)):sb2(fx.bestTimes);changed=true;}
      if(fx.tips){nb.tips=eThermal?(THERMAL_TIP_SOFT+" "+scrubAfternoonPush(sb2(fx.tips))).trim():sb2(fx.tips);changed=true;}
      if(Array.isArray(fx.rivers)&&fx.rivers.length&&Array.isArray(nb.rivers)){
        const nrm=nrmName;
        nb.rivers=nb.rivers.map(rv=>{
          const m=fx.rivers.find(f=>{const a=nrm(f.name),b=nrm(rv.name);return a&&b&&(a===b||a.startsWith(b)||b.startsWith(a));});
          if(m&&Array.isArray(m.flies)&&m.flies.length){const cleaned=cleanFlyList(m.flies);if(cleaned.length){changed=true;return {...rv,flies:cleaned};}}
          return rv;
        });
      }
      if(review.omissions&&review.omissions.length){nb.overview=applyReviewNotes(nb.overview,review);changed=true;}
      if(changed)builtReport=nb;
    }
  }catch(_rv){void 0;}

  // Fold the restrictions result in once it resolves (ran in parallel with the review pass)
  try{
    const rres=await restrictionsPromise;
    const restrictions=rres&&rres.result;
    let matched=0;
    const nb2={...builtReport,restrictionDebug:(rres&&rres.debug)||{outcome:"no-response"}};
    if(restrictions&&restrictions.length&&Array.isArray(nb2.rivers)){
      const nrm=nrmName;
      nb2.rivers=nb2.rivers.map(rv=>{
        const m=restrictions.find(r=>{
          const rn=nrm(r.name), vn=nrm(rv.name);
          if(r.status==="closure"){
            return rn&&vn&&(rn===vn||rn.includes(vn)||vn.includes(rn));
          }else{
            return rn&&vn&&rn===vn;
          }
        });
        if(m)matched++;
        return m?{...rv,restriction:m}:rv;
      });
      nb2.restrictionDebug={...nb2.restrictionDebug,matched};
      console.log("[restrictions] matched",matched,"of",restrictions.length,"reported");
    }
    builtReport=nb2;
  }catch(_rx){void 0;}

  // Must run last: needs the final outOfRange (labGovernor) and restriction
  // (labVerifyRestrictions, just folded in above) flags to know what's eligible.
  builtReport=reconcileBestBet(builtReport);

  // Light-touch personalization — deterministic, no AI call, computed last and
  // completely isolated from river selection/verification above it.
  builtReport.personalAngle=buildPersonalAngle(input.anglerHistory);

  return builtReport;
}
