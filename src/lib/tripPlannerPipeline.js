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

// Deterministic backstop for the DISTANCE LANGUAGE RULE in buildLabSynth, which tells the
// model it has no real per-pick drive-time data and must never state a specific number of
// hours/minutes anywhere in the report. Confirmed against a real Churchville, PA report that
// the model violates this anyway ("lie 1.5 to 2 hours north" for water that actually computes
// to 2.55-2.73 hrs via computeDriveMinutes) -- the rule alone isn't reliable, same class of
// gap as scrubBannedFlowWords above. Deliberately does TARGETED SUBSTRING replacement, not
// scrubDamClaims-style clause deletion: this field is routinely one long comma-joined sentence
// covering several waters at once (confirmed against the real overview text), and a clause
// boundary defined only by [.!?;] would delete valid, unrelated content earlier or later in the
// same sentence along with the bad claim. Replaces with vague relative language matching what
// the prompt actually asked for, rather than deleting the phrase outright.
export function scrubDistanceClaims(text){
  if(!text)return text;
  let t=String(text);
  t=t.replace(/\b\d+(?:\.\d+)?\s*(?:to|-|\u2013|\u2014)\s*\d+(?:\.\d+)?\s*hours?\b/gi,"a longer drive");
  t=t.replace(/\bwithin\s+(?:an?|\d+(?:\.\d+)?)\s*hours?\b/gi,"nearby");
  t=t.replace(/\b\d+(?:\.\d+)?\s*hours?\s*(?:away|north|south|east|west|drive)?\b/gi,"a drive");
  t=t.replace(/\b\d+\s*(?:minutes?|mins?)\s*(?:away|north|south|east|west|drive)?\b/gi,"a short drive");
  return t.replace(/\s{2,}/g," ").trim();
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
  // Proper-noun + Dam/Reservoir. Matches BOTH "Golden Dam" and "Golden dam" — the
  // capitalized-proper-noun anchor stays case-sensitive (so this doesn't over-fire on
  // unrelated capitalized words), but the generic noun itself needs to catch either
  // case: AI output routinely lowercases "dam"/"reservoir" ("Clear Creek below Golden
  // dam"), which the original Dam/Reservoir-only match silently let through.
  t=t.replace(/[^.!?;]*\b[A-Z][A-Za-z'.-]*(?:\s+[A-Z][A-Za-z'.-]*){0,3}\s+(?:Reservoir|reservoir|Dam|dam)\b[^.!?;]*[.!?;]?/g,"");
  t=t.replace(/[^.!?;]*\bdam[\s-]?control(?:led|s)?\b[^.!?;]*[.!?;]?/gi,"");
  // Broadened from "tailwater conditions" to any clause naming "tailwater" at all —
  // once a pick is confirmed NOT a tailwater, a clause crediting it with tailwater
  // stability/cold-water status is fabricated regardless of the exact phrasing
  // ("tailwater releases", "popular ... tailwater", etc.), not just that one phrase.
  t=t.replace(/[^.!?;]*\btailwater\b[^.!?;]*[.!?;]?/gi,"");
  t=t.replace(/[^.!?;]*\b(?:bottom[- ]release|regulated\s+releases?|controlled\s+releases?|releases?\s+from\s+(?:the\s+)?(?:dam|reservoir))\b[^.!?;]*[.!?;]?/gi,"");
  t=t.replace(/[^.!?;]*\bbelow\s+the\s+dam\b[^.!?;]*[.!?;]?/gi,"");
  return t.replace(/\s{2,}/g," ").replace(/^\s*[,;]\s*/,"").replace(/\s*[,;]\s*$/,"").trim();
}

// Same fabricated-dam problem as scrubDamClaims, but for the short river NAME field —
// a title like "Clear Creek below Golden dam" has no sentence punctuation, so running
// scrubDamClaims's clause-stripper on it would consume the ENTIRE string (nothing to
// stop the greedy match) and leave an empty name. This instead trims just the
// "below/near <Name> dam/reservoir" tail and keeps the plain stream name; if the
// pattern doesn't match, the name is returned unchanged rather than risking a blank.
export function scrubDamFromName(name){
  const s=String(name||"");
  const stripped=s.replace(/\s*[,\-\u2013\u2014]?\s*\b(?:below|blw|near|nr)\s+(?:the\s+)?[A-Z][A-Za-z'.-]*(?:\s+[A-Z][A-Za-z'.-]*){0,3}\s+(?:Reservoir|reservoir|Dam|dam)\b.*$/,"").trim();
  return stripped||s;
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
    "(3) DISTANCE DISCIPLINE: only recommend water realistically within ~2 hours. Do NOT reach for famous names farther than that. Do NOT let a famous distant fishery crowd out quality water within about an hour. If a gauged stream within range is genuine trout water, keep a place for it. A water being prominently or enthusiastically covered in the RETRIEVED REPORTS is NOT evidence it is close - fly shops and guide reports routinely cover water hours away from any single origin, so judge THIS pick's actual distance from THIS origin on its own, independent of how much attention the sources give it.",
    "(4) For every pick give your best lat and lng so distance can be verified. Set \"source\" to \"gauge\" if the pick matches one of the listed gauges, otherwise \"search\".",
    "(5) Do NOT invent water that appears in neither the reports nor the gauge list. Exclude urban drainage, irrigation, and warmwater bass streams presented as trout water. If the RETRIEVED REPORTS identify a nearby water as warmwater, smallmouth, or bass water - or list it under 'AVOID AS TROUT WATER' - do NOT include it as a trout fishery even when it is gauged or close; trust the reports' species designation over a bare gauge.",
    "(6) If NO genuine trout water is within about 2 hours, say so plainly in the overview, and STILL include the single nearest real trout fishery as one river entry with an honest note that reaching it is a road-trip beyond day-trip range - NEVER return an empty rivers list.",
    "(7) Each river entry must be ONE specific fishery - one tailwater below ONE dam, or one continuous section. NEVER combine two different tailwaters, two different dams, or two far-apart access points into a single entry; if two are both worth recommending, list them as SEPARATE entries each with its own coordinates and access points.",
    "(8) DRAINAGE INTEGRITY: every access point, road, put-in, dam, town, and confluence you list for a river MUST lie on THAT river, within its own drainage. NEVER borrow a neighboring stream's feature - do not put a Bear Creek dam or confluence on Clear Creek, do not list a downstream-plains town and a far-upstream reservoir as two access points on the same canyon stream, do not attach one reservoir's road to a different tailwater. Name only the river's OWN dam and OWN confluence. If you are not certain a specific access point belongs to this exact stream, give a general nearby town or omit it rather than borrowing one from another drainage. This rule is about keeping a CHOSEN river's own features correct - it is NOT a reason to skip a close stream you are less sure of; pick the close stream and give it a general nearby town as access.",
    "(9) PROXIMITY COVERAGE: a real guide starts a client on the CLOSEST quality trout water and only reaches farther for variety. The gauge list above is ordered nearest-first. Always include the nearest genuine trout streams (the closest 2-3 trout drainages within ~30-60 min) BEFORE adding a famous water 1.5-2 hours away. NEVER omit a close gauged trout stream in order to list a distant famous one, and NEVER give two slots to one distant river system while closer trout drainages within range go unlisted. Spread picks across DIFFERENT drainages and DIFFERENT directions from the origin, not a single corridor. One farther marquee water is fine for range, but the closest trout waters must anchor the list. TIE-BREAKER for that one farther marquee slot (added 2026-08-30): when more than one farther water genuinely qualifies, prefer whichever is independently corroborated by TWO OR MORE of the RETRIEVED REPORTS above, especially if those sources describe it in terms like 'premier', 'Gold Medal', 'blue-ribbon', 'renowned', or 'famous' - real cross-source acclaim like that found in this run's own search results is a stronger, more consistent signal than which candidate happens to be marginally closer or was simply mentioned first.",
    "(10) FINAL RANKING - recommendation AND bestFor: rule 9 controls which waters make the candidate list, but does NOT by itself decide which included water is today's single best bet or which wins each bestFor category - do not default to whichever entry is simply closest. Weigh how well each INCLUDED water fits TODAY specifically: on a hot day a stable cold tailwater is often the stronger recommendation than a closer freestone stream precisely because it will not warm past a safe range, even if it takes a little longer to reach; on an overcast, cool, or high-flow day that same tradeoff may not apply. Choose the recommendation and each bestFor category (mostFish, bestScenery, mostSolitude, beginners) based on which included water genuinely best fits today's conditions and that category's own criterion - draw from the FULL rivers list, not only the closest one or two entries, and do not let every category default to the same one or two waters when the list holds real variety. Every water name you use anywhere in overview, recommendation, or any bestFor value MUST be one you also added as its own entry in the rivers list below - never mention a different water by name in these fields, even in passing or as a runner-up, even if it's real and nearby; if it's worth mentioning, add it as its own rivers entry instead of just naming it in prose.",
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

// Same day-trip ceiling used by labGovernor (main picks) and verifyOmissions (the
// "Also consider" list, added 2026-08-12) — hoisted so both apply the identical cutoff
// rather than two constants quietly drifting apart.
const DAY_TRIP_CAP_MIN=150;

// Fetches elevation for a batch of [lat,lng] pairs from Open-Meteo, with one retry and
// a 5s timeout per attempt so a slow/hanging response can't stall report generation.
// Returns null (not a partial/guessed array) if both attempts fail — computeDriveMinutes
// decides what "unknown" should mean, this function never invents a fallback value.
async function fetchElevations(lats,lngs,attempt=1){
  try{
    const eu="https://api.open-meteo.com/v1/elevation?latitude="+lats.join(",")+"&longitude="+lngs.join(",");
    const ctrl=new AbortController();
    const timer=setTimeout(()=>ctrl.abort(),5000);
    let ej;
    try{ const er=await fetch(eu,{signal:ctrl.signal}); ej=await er.json(); }
    finally{ clearTimeout(timer); }
    return Array.isArray(ej.elevation)?ej.elevation:null;
  }catch(e){
    if(attempt<2)return fetchElevations(lats,lngs,attempt+1);
    return null;
  }
}

// Elevation-aware drive-time estimate for a batch of points relative to one origin.
// Returns an array aligned with `points`, each {mi,driveMin} (nulls when there's no
// origin or the point has no coordinates). Extracted 2026-08-12 from labGovernor so
// verifyOmissions can apply the EXACT same day-trip math to the "Also consider" list
// instead of a second, drifting copy of the mountain/circuity logic.
//
// 2026-08-12 hardening: elevation lookup used to fail OPEN — any fetch error silently
// defaulted every point in the batch to flatland speed/circuity (58mph, 1.25x), which
// is the wrong direction to fail for Colorado trout water where mountain/foothill picks
// are the common case, not the exception. This is what produced a ~14 min estimate for
// South Boulder Creek below Gross Reservoir (realistically 50-65+ min up a winding
// mountain road). Now retries once, and on continued failure assumes mountain terrain
// (slower, more conservative — 50mph, 1.6x) for the whole batch instead of flatland.
export async function computeDriveMinutes(points,loc){
  if(!Array.isArray(points))return[];
  const haveOrigin=loc&&loc.lat!=null&&loc.lng!=null;
  if(!haveOrigin)return points.map(()=>({mi:null,driveMin:null}));
  const lats=[loc.lat,...points.map(p=>p.lat!=null?p.lat:loc.lat)];
  const lngs=[loc.lng,...points.map(p=>p.lng!=null?p.lng:loc.lng)];
  const elevs=await fetchElevations(lats,lngs);
  const elevationKnown=Array.isArray(elevs);
  const originElevM=elevationKnown?elevs[0]:null;
  return points.map((p,i)=>{
    if(p.lat==null||p.lng==null)return{mi:null,driveMin:null};
    const mi=Math.round(Math.hypot(p.lat-loc.lat,p.lng-loc.lng)*69);
    const pickElevM=elevationKnown?elevs[i+1]:null;
    const maxFt=(originElevM!=null&&pickElevM!=null)?Math.max(originElevM,pickElevM)*3.281:null;
    // Fail closed: unknown elevation (lookup failed twice, or this one point came back
    // null) assumes mountain terrain rather than flatland — slower/more conservative is
    // the safe direction to be wrong in.
    const mountain=maxFt!=null?maxFt>6500:true;
    const circuity=mountain?1.6:1.25;
    const speed=mountain?50:58;
    return{mi,driveMin:Math.round((mi*circuity)/speed*60)};
  });
}

// Deterministic distance governor: flags every pick beyond the day-trip ring (never
// deletes here — see the 2026-08-30 note below) and reconciles each pick's displayed CFS
// to the live gauge value when one attached.
// opts.thorough (background/email path only, added 2026-08-12): once we know a real
// in-range option exists among THIS report's own picks, an out-of-range pick adds
// nothing but clutter — including a false "Most Fish"/best-bet candidate.
// 2026-08-30 fix: this used to be dropped outright right here, but reconcileBestBet
// (which swaps a dangling recommendation/bestFor reference away from an ineligible pick)
// runs much later and matches ineligible picks by finding them still IN the rivers array.
// Deleting a pick here meant reconcileBestBet had nothing left to match — a report could
// still say "Best Bet Today: Roaring Fork..." with zero corresponding river card, because
// the only water that named check could have swapped to had already vanished. Now this
// just flags the pick with dropIfThorough:true and leaves it in place long enough for
// reconcileBestBet to see and swap it; runTripPlannerPipeline strips dropIfThorough picks
// from the final rivers list AFTER reconcileBestBet runs, not here. The foreground path,
// and the genuine "nothing nearby is in range" case on EITHER path, keep the original
// flag-and-keep behavior unchanged and are never marked dropIfThorough: SELECTION RULE 6
// in buildLabSynth explicitly wants the single nearest real trout fishery included,
// clearly flagged, rather than an empty rivers list — that's a real answer, not clutter.
async function labGovernor(rivers,loc,opts){
  if(!Array.isArray(rivers)||!rivers.length)return rivers;
  const dm=await computeDriveMinutes(rivers,loc);
  const annotated=rivers.map((r,i)=>{
    const cfs=(r.gaugeCfs!=null)?String(Math.round(r.gaugeCfs)):r.cfs;
    const source=r.gaugeSnap?"gauge":(r.source||"search");
    return{...r,cfs,source,miFromOrigin:dm[i].mi,driveMin:dm[i].driveMin};
  });
  const thorough=!!(opts&&opts.thorough);
  const anyInRange=annotated.some(r=>r.driveMin==null||r.driveMin<=DAY_TRIP_CAP_MIN);
  // Nothing the AI picked is genuinely in range — SELECTION RULE 6 in buildLabSynth only
  // ever wanted ONE honestly-flagged fallback water in this case ("STILL include the
  // single nearest real trout fishery... NEVER return an empty rivers list"), not every
  // out-of-range pick the AI happened to return. Without this, a report can read like
  // "three premier options" are within reach when every single one requires an overnight
  // trip. Keep just the closest by drive time; picks with unknown drive time (no origin)
  // fall back to keeping everything, same as before. (2026-08-14)
  let closestOutOfRange=null;
  if(!anyInRange){
    const withKnownDrive=annotated.filter(r=>r.driveMin!=null);
    const pool=withKnownDrive.length?withKnownDrive:annotated;
    closestOutOfRange=pool.reduce((a,b)=>(a.driveMin??Infinity)<=(b.driveMin??Infinity)?a:b);
  }
  return annotated.map(r=>{
    if(r.driveMin==null||r.driveMin<=DAY_TRIP_CAP_MIN)return r;
    if(!anyInRange&&closestOutOfRange&&r!==closestOutOfRange)return null; // drop every out-of-range pick except the single closest
    const hrs=r.driveMin?Math.round(r.driveMin/6)/10:null;
    const note="⚠ Beyond day-trip range"+(hrs?" (~"+hrs+" h drive)":"")+" — plan an overnight rather than a day trip.";
    // thorough+anyInRange: pure clutter once a real in-range anchor exists. Flagged, not
    // deleted, here — actually removed from the list later in runTripPlannerPipeline,
    // AFTER reconcileBestBet has had its chance to swap any recommendation/bestFor text
    // that names it. See the 2026-08-30 note above.
    return {...r,outOfRange:true,dropIfThorough:thorough&&anyInRange,why:(note+" "+(r.why||"")).trim(),conditions:(note+" "+(r.conditions||"")).trim()};
  }).filter(Boolean);
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
// One more targeted, single-water check for a pick the batched pass above came back
// "unsure" on — thorough/background path only (2026-08-12), given its larger time
// budget (queue item, previously discussed not built). The batched call asks about
// every pick in one shot and can come back unsure just from being spread thin across
// several waters at once, not because the water itself is genuinely unclear. Same
// conservative posture as the batched pass: returns null (leave the original verdict
// alone) on any failure, timeout, or a still-unresolved answer.
async function resolveUnsurePick(r,loc,aiCtx){
  try{
    const vp=["You are confirming ONE specific water for a fly fishing trip report near "+((loc&&loc.label)||"the area")+".",
      "Water: "+String(r.name||"?")+(r.type?" (currently labeled "+r.type+")":"")+(r.gaugeSnap?" — nearby gauge: "+r.gaugeSnap:"")+".",
      "A prior pass could not confirm two things for this water and marked it unsure: (1) whether it is a COLDWATER TROUT fishery or a WARMWATER/bass/smallmouth water; (2) whether it is a FREESTONE stream or a TAILWATER (flows directly below a dam or reservoir). Search current public sources specifically for THIS water and try again.",
      "If the water's name includes a specific access point, town, or reach (e.g., 'River Name (Loveland area)', 'near X'), a 'tailwater' verdict must be about THAT SPECIFIC reach — a river can be a genuine tailwater right below its dam and revert to ordinary freestone character well before some of its other named access points. If sources place the dam's cold-water influence as ending well upstream of the named reach, answer 'freestone' even though the river has a tailwater section elsewhere.",
      "Be conservative: answer 'warmwater' only when sources clearly establish it; if still unclear, say so. If 'type' is 'tailwater', you MUST return 'dam' with the actual dam/reservoir name confirmed by your sources — never from memory — or omit 'type' entirely.",
      'Return ONLY JSON, no markdown: {"verdict":"trout|warmwater|unsure","type":"freestone|tailwater","dam":""}. Omit "type" if still unsure; omit "dam" unless "type" is "tailwater".'
    ].join(" ");
    const race=Promise.race([aiCtx.askAI(vp,true,900,"planner"),new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")),60000))]);
    const clean=String(await race||"").replace(/```json|```/g,"").trim();
    const a=clean.indexOf("{"),b=clean.lastIndexOf("}");
    if(a===-1||b<=a)return null;
    const v=JSON.parse(clean.slice(a,b+1));
    return v&&v.verdict?v:null;
  }catch(_r){return null;}
}

// Skeptical verification pass: one batched Sonnet search asks, for each pick, coldwater
// trout vs warmwater/bass. DROP only on a direct contradiction. LABEL 'unsure' picks;
// never penalize on silence; never empty the list. Fail-open.
// opts.thorough: background/email path only — see resolveUnsurePick above.
async function labVerifyPicks(rivers,loc,ground,aiCtx,opts){
  if(!Array.isArray(rivers)||!rivers.length)return rivers;
  const thorough=!!(opts&&opts.thorough);
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
      "A river can be a genuine tailwater immediately below its dam and revert to ordinary freestone character well before some of its other named access points — so when a water's name includes a specific access point, town, or reach (e.g., 'River Name (Loveland area)', 'near X'), your 'tailwater' verdict must be about THAT SPECIFIC reach, not just the river somewhere along its length. If your sources place the dam's cold-water tailwater influence as ending well upstream of the named reach, answer 'freestone' for this pick even though the river has a genuine tailwater section elsewhere.",
      "Return ONLY a JSON array, one object per item, SAME ORDER, no markdown: ",
      '[{"n":1,"verdict":"trout|warmwater|unsure","type":"freestone|tailwater","dam":""}]. Omit "type" if unsure. Omit "dam" entirely unless "type" is "tailwater".',
      "Waters: "+items].join(" ");
    const race=Promise.race([aiCtx.askAI(vp,true,1500,"planner"),new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")),85000))]);
    const clean=String(await race||"").replace(/```json|```/g,"").trim();
    const a=clean.indexOf("["),b=clean.lastIndexOf("]");
    if(a!==-1&&b>a)verdicts=JSON.parse(clean.slice(a,b+1));
  }catch(_v){verdicts=[];}
  const byN=new Map();(Array.isArray(verdicts)?verdicts:[]).forEach((v,i)=>{const n=Number(v&&v.n)||(i+1);byN.set(n,v);});
  if(thorough){
    const unsure=rivers.map((r,i)=>({r,i})).filter(({i})=>!flags[i].avoid&&String((byN.get(i+1)||{}).verdict||"").toLowerCase()==="unsure");
    if(unsure.length){
      const resolved=await Promise.all(unsure.map(({r})=>resolveUnsurePick(r,loc,aiCtx)));
      unsure.forEach(({i},k)=>{if(resolved[k])byN.set(i+1,resolved[k]);});
    }
  }
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
    // 2026-08-30 fix: `ground` used to be accepted as a parameter and never referenced
    // anywhere in this function — a real, confirmed dead-parameter bug, not an AI
    // judgment call. The caller passes it the SAME searchTxt synthesis itself uses,
    // capped here to the same first-5000-char window buildLabSynth already limits
    // itself to (see the [searchDiag] COMBINED-searchTxt logging in labSynth's own
    // caller). Omission-detection was running an entirely separate, independent web
    // search with only "near <location>" for context — rolling the dice again instead
    // of cross-checking the SAME rich material synthesis already had. A well-known
    // water repeatedly confirmed present in searchTxt (South Platte/Deckers/Cheesman,
    // 2026-08-30 chat) could still go unflagged here even when synthesis's own search
    // results named it directly, simply because this separate check never looked.
    const groundExcerpt=String(ground||"").slice(0,5000);
    const promptCtx=[
      "You are a senior fly fishing guide fact-checking a draft trip report near "+((loc&&loc.label)||"the area")+" for "+(dateStr||"today")+".",
      "Streams: "+picks.join(", ")+".",
      riverFlies?("Per-stream fly lists — "+riverFlies+"."):"",
      report.hatches?("Hatch Activity text: "+String(report.hatches).slice(0,600)):"",
      report.bestTimes?("Best Times text: "+String(report.bestTimes).slice(0,300)):"",
      report.tips?("Insider Tips text: "+String(report.tips).slice(0,600)):"",
      report.overview?("Overview text: "+String(report.overview).slice(0,600)):"",
      report.recommendation?("Recommendation text: "+String(report.recommendation).slice(0,600)):"",
      groundExcerpt?("RETRIEVED REPORTS (the same search material the Streams list above was drawn from — check this directly for a prominent water it's missing before relying on a fresh search of your own): "+groundExcerpt):"",
      "Do TWO things:",
      "A) OMISSIONS: up to 3 well-known public trout waters in similar drive range not listed — distinct fisheries, not two sections of one stream. Check the RETRIEVED REPORTS text above FIRST for anything prominent the Streams list is missing before relying on your own search. Format each 'Name (where it is and why an angler would fish it — 6 words max)'. Describe the WATER for the reader; never critique the report or use words like ignored, skipped, missing, left out. Real recognized fisheries only; no invented or marginal water. Empty if none.",
      "B) CORRECTIONS: fix only CLEAR factual errors in the report's OWN content for this date and region — a hatch out of season, wrong fly SIZES for a hatch, a stream wrongly framed as tailwater/freestone in the narrative, unsafe/self-contradictory timing, or the Overview/Recommendation text naming ANY water by name that is not one of the Streams listed above (even a real, well-known one) — that water was never added as its own verified pick, so mentioning it by name is not backed by this report's own data; if you find this, rewrite that field's FULL text with the outside mention removed (fall back to a general phrase like 'other waters in range' if you need to preserve the sentence, or drop the clause entirely) rather than naming it. For each narrative field you change, return its corrected FULL text (same length and tone, only the facts fixed). For each stream whose flies are wrong, return its corrected fly list (recognized canon patterns only, never invented names). Change ONLY clear errors; OMIT anything already correct; never restyle or pad.",
      'Return ONLY JSON, no markdown: {"omissions":["Name — reason"],"fixes":{"hatches":"","bestTimes":"","tips":"","overview":"","recommendation":"","rivers":[{"name":"","flies":["",""]}]}}. Omit every key you are not changing; "fixes" can be empty.'
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
    if(txt(fxIn.overview))fixes.overview=txt(fxIn.overview);
    if(txt(fxIn.recommendation))fixes.recommendation=txt(fxIn.recommendation);
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
    if(!Array.isArray(rivers)||!rivers.length){dbg.outcome="no-rivers";return{result:null,debug:dbg};}
    const named=rivers.filter(r=>r&&r.name);
    if(!named.length){dbg.outcome="no-named-rivers";return{result:null,debug:dbg};}
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
    }catch(te){
      dbg.outcome=(te&&te.message==="timeout")?"timeout":"api-error";
      dbg.error=String((te&&te.message)||te).slice(0,120);
      return{result:null,debug:dbg};
    }
    const clean=String(raw||"").replace(/```json|```/g,"").replace(/<cite[^>]*>|<\/cite>/g,"").trim();
    const a=clean.indexOf("{"),b=clean.lastIndexOf("}");
    if(a===-1||b<=a){dbg.outcome="no-json-in-response";dbg.raw=clean.slice(0,150);return{result:null,debug:dbg};}
    let o;
    try{o=JSON.parse(clean.slice(a,b+1));}catch(pe){dbg.outcome="parse-fail";dbg.raw=clean.slice(a,a+150);return{result:null,debug:dbg};}
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
    return{result:out.length?out:null,debug:dbg};
  }catch(_r){
    dbg.outcome="exception";
    dbg.error=String((_r&&_r.message)||_r).slice(0,120);
    return{result:null,debug:dbg};
  }
}
// Fold omissions into the overview as a clearly-marked footer. Foreground/non-thorough
// path only as of 2026-08-12 — see verifyOmissions/applyVerifiedReviewNotes below for
// the background path's confident replacement.
export function applyReviewNotes(overview,review){
  if(!review||!review.omissions||!review.omissions.length)return overview;
  return (String(overview||"")+" ⚠ Also consider (verify flows): "+review.omissions.join("; ")+".").trim();
}

// Background/thorough path only (2026-08-12): labReviewReport's "omissions" are pure AI
// recall with zero grounding — no geocoding, no distance check, no gauge match — which is
// exactly why the footer had to say "(verify flows)". This does the verification instead
// of disclaiming it: geocode each mention, run it through the SAME day-trip distance math
// as the main picks (computeDriveMinutes), and snap it to a live gauge for a real CFS +
// vs-average reading when one exists nearby. Anything that can't be geocoded, or comes
// back beyond day-trip range, is dropped silently rather than shown half-checked — never
// worse than the current picks list, only ever a bonus on top of it. Caps at 3 (same as
// the review pass already returns). Never throws.
async function verifyOmissions(omissions,loc,gaugeList,flowAvgMap,aiCtx){
  if(!Array.isArray(omissions)||!omissions.length)return[];
  try{
    const regionHint=loc&&loc.label?loc.label.split(",").slice(-1)[0].trim():"";
    const parsed=omissions.map(s=>{
      const m=String(s||"").match(/^(.*?)\s*\(([^)]*)\)\s*$/);
      return m?{name:m[1].trim(),desc:m[2].trim()}:{name:String(s||"").trim(),desc:""};
    }).filter(p=>p.name);
    const geocoded=(await Promise.all(parsed.map(async p=>{
      const g=await geocodeRiver(p.name,regionHint,aiCtx);
      return g?{...p,lat:g.lat,lng:g.lng}:null;
    }))).filter(Boolean);
    if(!geocoded.length)return[];
    const dm=await computeDriveMinutes(geocoded,loc);
    const inRange=geocoded.filter((p,i)=>dm[i].driveMin==null||dm[i].driveMin<=DAY_TRIP_CAP_MIN);
    if(!inRange.length)return[];
    const snapped=snapRiversToGauges(inRange,gaugeList,0.5);
    // TEMP DIAGNOSTIC (2026-08-12) — tracing a confirmed bug: the "Also worth a look"
    // line has twice shown a CFS an order of magnitude off real gauge data (St. Vrain
    // Creek at Lyons: reported 743 CFS vs. a real ~58 CFS; Cache la Poudre canyon:
    // reported 28 CFS vs. a real ~230+ CFS — wrong in opposite directions, so not a
    // single scaling bug). This logs the full candidate gauge list this call searched,
    // plus exactly which gauge each omission matched and at what distance/confidence,
    // so the next reproduction gives real evidence (bad source data vs. a bad match)
    // instead of a guess. Server-side only (this function only runs in `thorough` mode,
    // i.e. the background/email path) — check Vercel's function logs, not the browser
    // console. REMOVE once the root cause is confirmed and fixed.
    console.log("[verifyOmissions] gaugeList size:",Array.isArray(gaugeList)?gaugeList.length:0,
      "| candidates:",(Array.isArray(gaugeList)?gaugeList:[]).map(g=>g.name+": "+g.cfs+"cfs").join(" | "));
    snapped.forEach(p=>{
      console.log("[verifyOmissions] match:",{
        omission:p.name,
        desc:p.desc,
        geocodedLatLng:[p.lat,p.lng],
        matchedGauge:p.gaugeSnap||"(no gauge matched — using AI-reported desc only, no CFS)",
        matchedSiteNo:p.siteNo||null,
        matchedCfs:p.gaugeCfs!=null?p.gaugeCfs:null,
        snapDistMi:p._snapDistMi!=null?p._snapDistMi:null,
        snapScore:p._snapScore!=null?p._snapScore:null
      });
    });
    return snapped.slice(0,3).map(p=>{
      const fva=(p.gaugeCfs!=null)?flowVsAverageLocal(p.gaugeCfs,flowAvgMap[p.siteNo]):null;
      const flowPart=p.gaugeCfs!=null?(Math.round(p.gaugeCfs)+" CFS"+(fva?" ("+fva.label+")":"")):"";
      const parts=[p.desc,flowPart].filter(Boolean);
      const text=p.name+(parts.length?" ("+parts.join(", ")+")":"");
      // Structured, not just display text (2026-08-14) — callers that only want the
      // footer sentence use .text (unchanged from before); the promotion check below
      // needs the real cfs/flowLabel to decide whether this omission is strong enough
      // to headline "Best Bet Today" when every AI-picked river is out of range.
      return {text,name:p.name,desc:p.desc||"",cfs:p.gaugeCfs!=null?Math.round(p.gaugeCfs):null,flowLabel:fva?fva.label:null,lat:p.lat,lng:p.lng};
    });
  }catch(_o){return[];}
}

// Whether the current picks already have a genuine "farther" water covering the ~1hr+
// marquee slot rule 9 asks for. 60 min matches rule 9's own "closest 2-3 trout drainages
// within ~30-60 min" language for the close-anchor zone — anything already past that
// already occupies the marquee-water role. Scope note: this only asks WHETHER a farther
// pick exists, not whether it's the single best-corroborated candidate that could have
// filled that role — a report that already has some (even weak) farther pick keeps it;
// out-competing an already-picked water with a better-corroborated omission is a
// different, broader change than this promotion covers (2026-08-30 chat).
function hasFartherPick(rivers){
  return Array.isArray(rivers)&&rivers.some(r=>r.driveMin!=null&&r.driveMin>60&&!r.outOfRange&&!r.dropIfThorough);
}

// One small, targeted AI call (thorough/background path only) to fill in the fields a
// verified omission doesn't have — verifyOmissions confirms name/distance/gauge-CFS, but
// has no access points, techniques, or fly recommendations, since it was never generated
// as a full pick to begin with. Same search-grounded, fail-open posture as
// resolveUnsurePick above. Returns null on any failure so the caller simply doesn't
// promote rather than shipping a half-built card.
async function fleshOutPromotedPick(omission,loc,aiCtx){
  try{
    const locLabel=(loc&&loc.label)||"the area";
    const flowPart=omission.cfs!=null?(omission.cfs+" CFS"+(omission.flowLabel?" ("+omission.flowLabel+")":"")):"an unconfirmed flow";
    const prompt=["You are a fly fishing guide filling in the remaining details for ONE water that a trip report near "+locLabel+" already confirmed is real, within realistic day-trip range, and currently running "+flowPart+".",
      "Water: "+String(omission.name||"?")+(omission.desc?" — "+omission.desc:"")+".",
      "Using current public sources for THIS specific water, determine: whether it is primarily a Tailwater (directly below a major dam — name the dam if so) or Freestone; a short list of its own real, named access points; conditions/techniques guidance appropriate for today; and fly recommendations.",
      "FLY NAMES: choose ONLY from this recognized national canon, matched to the season and hatch you identify: "+FLY_CANON+". Never invent a pattern name, and never copy a one-off local shop pattern.",
      "CREDIBILITY: never call the flow perfect, ideal, or Goldilocks — say what it suits. Frame crowd level as likelihood from access/popularity, never as fact.",
      'Return ONLY JSON, no markdown: {"type":"Freestone|Tailwater","conditions":"","crowdLevel":"","techniques":"","bestTime":"","accessPoints":[],"flies":[],"why":""}'
    ].join(" ");
    const race=Promise.race([aiCtx.askAI(prompt,true,1200,"planner"),new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")),60000))]);
    const clean=String(await race||"").replace(/```json|```/g,"").trim();
    const a=clean.indexOf("{"),b=clean.lastIndexOf("}");
    if(a===-1||b<=a)return null;
    return JSON.parse(clean.slice(a,b+1));
  }catch{return null;}
}

// 2026-08-30: promotes a verified omission (see verifyOmissions above — already
// geocoded, day-trip-distance-checked, and gauge-matched, despite what an older comment
// on that function still says) into a genuine river[] entry instead of leaving it as a
// one-line overview footnote, when the current picks have no real farther water at all
// (hasFartherPick). This is what a report like the South Platte/Deckers/Cheesman case
// needed: rule 9's synthesis-time corroboration tie-breaker only ever gets a vote on
// candidates the AI already put in its OWN candidate list — it never had a chance to
// apply here, because the water wasn't in that list to begin with; it only surfaced
// later via labReviewReport's separate self-review "omissions" catch, which (until now)
// could only ever become a footnote, never a real pick. Quality gate: requires a real
// live CFS match, same bar the "promote to Best Bet Today when everything's out of
// range" logic below already uses — a vague, gauge-less mention isn't a strong enough
// basis for a full card. thorough-mode only; fails open (returns null, promotes nothing)
// on any failure including the flesh-out call, never a half-built card.
async function promoteOmissionToRiver(verifiedOmissions,rivers,loc,aiCtx,thorough){
  if(!thorough||!Array.isArray(verifiedOmissions)||!verifiedOmissions.length)return null;
  if(hasFartherPick(rivers))return null;
  const candidate=verifiedOmissions.find(v=>v.cfs!=null&&v.lat!=null&&v.lng!=null);
  if(!candidate)return null;
  const detail=await fleshOutPromotedPick(candidate,loc,aiCtx);
  if(!detail)return null;
  // verifyOmissions computes drive time internally to filter to in-range candidates but
  // doesn't return it — every other river card has driveMin/mi set by labGovernor, which
  // already ran before this promotion happens, so a promoted card needs its own pass with
  // the exact same function or the UI's "~X min drive" chip simply won't render for it.
  const dm=await computeDriveMinutes([candidate],loc);
  return {
    name:candidate.name,
    lat:candidate.lat,
    lng:candidate.lng,
    driveMin:dm[0]?dm[0].driveMin:null,
    miFromOrigin:dm[0]?dm[0].mi:null,
    type:detail.type||"Freestone",
    source:"search",
    verified:String(detail.type||"").toLowerCase()==="tailwater"?"tailwater":"",
    cfs:String(candidate.cfs),
    condition:candidate.flowLabel||"",
    crowdLevel:detail.crowdLevel||"",
    conditions:detail.conditions||"",
    techniques:detail.techniques||"",
    bestTime:detail.bestTime||"",
    accessPoints:Array.isArray(detail.accessPoints)?detail.accessPoints:[],
    flies:Array.isArray(detail.flies)?detail.flies:[],
    why:detail.why||(candidate.desc||"A verified, in-range option surfaced during review.")
  };
}

// Confident version of applyReviewNotes for the background/thorough path — takes an
// already-verified list from verifyOmissions and never uses "verify" hedge language,
// since by this point distance is confirmed and flow (when a gauge exists) is real.
export function applyVerifiedReviewNotes(overview,verifiedList){
  if(!Array.isArray(verifiedList)||!verifiedList.length)return overview;
  return (String(overview||"")+" Also worth a look: "+verifiedList.join("; ")+".").trim();
}

export function enforceStreamTypes(rivers,keepVerified=false){
  if(!Array.isArray(rivers))return rivers;
  const damRe=/\b(BLW|BELOW)\b[\s\S]*\b(RES|RESERVOIR|DAM)\b|\b(RES|RESERVOIR|DAM)\b[\s\S]*\bOUTLET\b/i;
  return rivers.map(r=>{
    if(typeof r.type==="string"&&/tailwater/i.test(r.type)){
      const g=String(r.gaugeSnap||"");
      const verified=keepVerified&&/tailwater/i.test(String(r.verified||""));
      if(!damRe.test(g)&&!verified)return{...r,type:"Freestone",name:scrubDamFromName(r.name),condition:scrubDamClaims(r.condition),crowdLevel:scrubDamClaims(r.crowdLevel),why:scrubDamClaims(r.why),conditions:scrubDamClaims(r.conditions),techniques:scrubDamClaims(r.techniques),accessPoints:scrubDamAccessPoints(r.accessPoints)};
    }
    return r;
  });
}

// Snap AI-suggested river coordinates to the nearest matching USGS gauge (surveyed coords beat AI guesses)
// DAM:"RESERVOIR" in ABBR below (2026-08-30 fix): a real name-score-0 failure — the AI
// wrote "South Boulder Creek below Gross DAM" while the live USGS gauge is named
// "...below Gross RESERVOIR". No existing synonym covered it, so this candidate scored 0
// and was skipped entirely (see the score===0 continue below), leaving the entry's CFS as
// whatever unverified number the AI itself supplied — off by roughly 8x from the real
// gauge reading (9 CFS vs. a reported "upper 60s to low 70s"). Anglers say "below X Dam"
// and "below X Reservoir" interchangeably for the same release point nationwide, so this
// is a general fix, not a one-off name patch.
export function snapRiversToGauges(rivers,gaugeList,maxDeg=Infinity){
  if(!Array.isArray(rivers)||!Array.isArray(gaugeList)||!gaugeList.length)return rivers;
  const ABBR={R:"RIVER",RIV:"RIVER",CRK:"CREEK",CR:"CREEK",CK:"CREEK",FK:"FORK",N:"NORTH",S:"SOUTH",E:"EAST",W:"WEST",ST:"SAINT",BLW:"BELOW",BL:"BELOW",ABV:"ABOVE",AB:"ABOVE",HWY:"HIGHWAY",NR:"NEAR",MTN:"MOUNTAIN",RD:"ROAD",FT:"FORT",DAM:"RESERVOIR"};
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
    // Score EVERY candidate (not just track a running "best") so ties at the top score
    // can be detected below — that's the case this whole function was getting wrong.
    const candidates=[];
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
      candidates.push({...g,_d:d,_score:score});
    }
    if(!candidates.length)return r;
    // DISTANCE TOLERANCE FIRST (2026-08-14): apply the caller's maxDeg BEFORE tie-
    // detection, not just at the final attach step below. Confirmed by direct
    // reproduction against a real Denver-area search: adding CO DWR gauges as a
    // supplemental source reintroduced "SOUTH PLATTE RIVER NEAR KERSEY, CO" (~85mi
    // away, plains water, not trout habitat) into the candidate pool via its USGS
    // cross-reference — a site the pre-DWR pipeline never surfaced this far out. A
    // bare "South Platte River" omission then tied Kersey against the correct
    // Deckers/Cheesman gauge (~34mi, in range) on name-score alone, and the OLD code
    // hit the ambiguity guard below and bailed with NO gauge attached, even though
    // Kersey would have failed the maxDeg check anyway had it ever been reached. Pre-
    // filtering to in-tolerance candidates first means a candidate that could never
    // have been the final answer can't block a match to the one that could.
    const inTolerance=Number.isFinite(maxDeg)?candidates.filter(c=>c._d<=maxDeg):candidates;
    if(!inTolerance.length)return r;
    const topScore=Math.max(...inTolerance.map(c=>c._score));
    const top=inTolerance.filter(c=>c._score===topScore);
    // AMBIGUITY GUARD (2026-08-12): streamPart strips the "AT/NEAR/BELOW X" qualifier
    // before scoring, so a bare name like "St. Vrain Creek" or "Clear Creek" scores
    // IDENTICALLY against every gauge on that named creek regardless of which reach -
    // confirmed against live data: bare "Clear Creek" ties FIVE real gauges (5.5 to 84
    // CFS, Loveland Pass down to Golden) at the top score, and "St. Vrain Creek" tied a
    // canyon-adjacent gauge (35.8 CFS) against one below Longmont (743 CFS) - nearest-
    // distance-wins then silently picked whichever happened to be geographically
    // closer, with no signal that the two candidates disagreed by 20x. When 2+
    // DIFFERENT gauges (by siteNo, falling back to name) genuinely tie for the top
    // score AFTER the distance tolerance above has already ruled out the candidates
    // that could never have qualified, the name alone can't tell the REMAINING ones
    // apart - rather than guess, treat it as unresolved: no gauge attaches, the pick
    // keeps its own name/coordinates untouched, same as if nothing had matched.
    // Multiple timeSeries entries for the SAME physical site are not ambiguous and
    // proceed normally.
    const distinctTopIds=new Set(top.map(c=>c.siteNo||c.name));
    if(distinctTopIds.size>1)return r;
    const best=top[0];
    return {...r,lat:best.lat,lng:best.lng,gaugeSnap:best.name,siteNo:best.siteNo||r.siteNo||null,gaugeCfs:best.cfs!=null?best.cfs:null,_snapDistMi:Math.round(best._d*69*10)/10,_snapScore:topScore};
  });
}

// Fusion guard: a real tailwater sits below ONE dam, so its access points cluster within
// a few miles of it. Narrows a fused multi-reach entry to the dam-adjacent cluster and
// flags it. Runs BEFORE labVerifyPicks, so a properly-scoped, single-reach description is
// what the verification question actually evaluates (2026-08-13: a verification-prompt
// fix alone was tried first and didn't resolve a real Big Thompson report - the verifier
// correctly confirmed tailwater because the fused entry's OWN text genuinely centered on
// the dam/tailrace; the bug was upstream of verification, in the pick itself spanning
// three real reaches under one entry).
//
// 2026-08-13: this used to only catch a fusion when the AI embedded literal lat/lng in
// its own access-point text - checked against a real report and it never does. Rewritten
// to geocode named access points via the injected aiCtx instead (same Google Places call
// geocodeRiver already uses - no AI cost).
//
// Anchor choice: prefer the access point whose own text names the dam/reservoir/tailrace
// itself, since that's a stronger "this IS the tailwater point" signal than the pick's own
// r.lat/r.lng - which, when a live gauge snapped, IS the gauge's coordinates, and a gauge
// can snap to the wrong (downstream, non-tailwater) reach in the first place. That's
// exactly what happened in the real case this was built from: gaugeSnap pointed at a
// gauge 20 miles downstream, so anchoring on the pick's own coordinates would have kept
// the wrong cluster and discarded the real tailrace access point.
const DAM_WORD_RE=/\b(dam|reservoir|tailrace|outlet)\b/i;
const coordRe=/(-?\d{1,3}\.\d{2,})[ ,]+(-?\d{1,3}\.\d{2,})/;
function accessPointPlace(s){
  return String(s||"").split(/[(—:\-]/)[0].replace(/\b(access|public|area|TU|BLM|parking|trailhead|bridge|road|pullouts?|section|the)\b/gi,"").replace(/\s+/g," ").trim();
}
async function geocodeAccessPoint(text,regionHint,aiCtx){
  const m=coordRe.exec(String(text));
  if(m)return{lat:parseFloat(m[1]),lng:parseFloat(m[2])};
  try{
    const q=accessPointPlace(text)+(regionHint?", "+regionHint:"");
    if(!q.trim())return null;
    const g=await aiCtx.geocodePlaces(q);
    return g?{lat:g.lat,lng:g.lng}:null;
  }catch{return null;}
}
async function labSplitFused(rivers,aiCtx,regionHint){
  if(!Array.isArray(rivers))return rivers;
  return Promise.all(rivers.map(async r=>{
    if(!/tailwater/i.test(String(r.type||""))||!Array.isArray(r.accessPoints)||r.accessPoints.length<2||!aiCtx)return r;
    const resolved=await Promise.all(r.accessPoints.map(async a=>({str:a,pt:await geocodeAccessPoint(a,regionHint,aiCtx)})));
    const damPoint=resolved.find(x=>DAM_WORD_RE.test(x.str)&&x.pt);
    const anchor=damPoint?damPoint.pt:((r.lat!=null&&r.lng!=null)?{lat:r.lat,lng:r.lng}:null);
    if(!anchor)return r;
    const distMi=p=>p?Math.hypot(p.lat-anchor.lat,p.lng-anchor.lng)*69:null;
    // Elevation check: a genuine tailwater point can only be AT or BELOW the dam's own
    // elevation - water that hasn't yet passed through the dam (upstream headwaters) can
    // sit close by straight-line distance (a park a few miles from the dam's own town)
    // while being a completely different, non-tailwater fishery - distance alone can't
    // tell "close but upstream" from "close and genuinely tailwater". One batched
    // Open-Meteo lookup (same utility computeDriveMinutes already uses elsewhere in this
    // file) catches this. Fails open - a lookup failure never excludes a point that
    // passed the distance check, it only strengthens the check when elevation is available.
    const pts=resolved.map(x=>x.pt);
    const elevs=await fetchElevations([anchor.lat,...pts.map(p=>p?p.lat:anchor.lat)],[anchor.lng,...pts.map(p=>p?p.lng:anchor.lng)]).catch(()=>null);
    const anchorElevM=Array.isArray(elevs)?elevs[0]:null;
    const ELEV_UP_M=45; // ~150 ft - conservative; ordinary downstream drop within one real reach shouldn't trip this
    const tagged=resolved.map((x,i)=>{
      const elevM=Array.isArray(elevs)?elevs[i+1]:null;
      const tooHigh=(anchorElevM!=null&&elevM!=null)&&(elevM-anchorElevM)>ELEV_UP_M;
      return {str:x.str,d:distMi(x.pt),tooHigh};
    });
    const far=tagged.filter(x=>(x.d!=null&&x.d>12)||x.tooHigh);
    if(!far.length)return r;
    const kept=tagged.filter(x=>!((x.d!=null&&x.d>12)||x.tooHigh));
    const keptPlaces=[...new Set(kept.map(x=>accessPointPlace(x.str)).filter(Boolean))];
    const farPlaces=[...new Set(far.map(x=>accessPointPlace(x.str)).filter(Boolean))];
    let name=String(r.name||"");
    farPlaces.forEach(p=>{const esc=p.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");name=name.replace(new RegExp("\\s*[/,]\\s*"+esc,"gi"),"");});
    // 2026-09-06: simplified from a dense engineering-diagnostic sentence (kept for the
    // record: "⚠ This entry's access points spanned more than one stretch of water (X vs Y)
    // — narrowed to the X section that matches its Tailwater label; the other point(s) are
    // a different stretch and not shown here.") to plain wording anglers can actually read.
    // Same substance - which access points this entry covers and which it doesn't - none
    // of the "entry"/"Tailwater label" internal framing.
    const keptLabel=keptPlaces.join("/")||"this";
    const farLabel=farPlaces.join("/")||"another area";
    const note="Note: access points here cover the "+keptLabel+" stretch only — "+farLabel+" is a different section of river and isn't included.";
    const base={...r,name,accessPoints:kept.length?kept.map(x=>x.str):r.accessPoints,why:(note+" "+(r.why||"")).trim()};
    // If the pick's own attached live gauge is itself one of the far points (the gauge
    // snapped to the OTHER stretch, not the one this entry now describes after narrowing),
    // drop the gauge attachment rather than keep showing a flow number for water this entry
    // no longer claims to be about. labGovernor (runs later) already falls back to the AI's
    // own text "cfs" estimate whenever gaugeCfs is absent - no new fallback needed here.
    const gaugeDistMi=(r.gaugeSnap&&r.lat!=null&&r.lng!=null)?distMi({lat:r.lat,lng:r.lng}):null;
    if(gaugeDistMi!=null&&gaugeDistMi>12){
      const{gaugeSnap,gaugeCfs,siteNo,_snapDistMi,_snapScore,...rest}=base;
      return {...rest,lat:anchor.lat,lng:anchor.lng};
    }
    return base;
  }));
}

// Geocode a river name via Google Places (through the injected aiCtx — direct on the
// server, proxied through /api/claude on the browser). Returns {lat,lng} or null.
async function geocodeRiver(name,regionHint,aiCtx){
  try{
    const query=name+(regionHint?", "+regionHint:"")+" river fishing";
    return await aiCtx.geocodePlaces(query);
  }catch{return null;}
}

export async function finalizeLabRivers(rivers,gaugeList,loc,ground,aiCtx,opts){
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
  out=await labSplitFused(out,aiCtx,regionHint);
  out=dropWarmwaterByText(out);
  out=dropWarmUrbanPicks(out);
  out=damNameReconcile(out);
  out=await labGovernor(out,loc,opts);
  out=await labVerifyPicks(out,loc,ground,aiCtx,opts);
  return out;
}

export function finalizeRivers(rivers,gaugeList,loc,ground,aiCtx,opts){
  return finalizeLabRivers(rivers,gaugeList,loc,ground,aiCtx,opts);
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
// findIneligibleMatch (below) to match a free-text field back to the river entry it's
// actually describing.
export function coreRiverName(name){
  return String(name||"").replace(/\s*\([^)]*\)\s*/g,"").trim();
}

// 2026-08-30: no more visible "⚠ X is beyond range — swapping to Y" note. Used to
// explain the swap right in the text; now it just reads as if the eligible pick was the
// answer all along. Also no longer picks the replacement itself — see
// resolveSwapsWithAI/reconcileBestBet below for why "just take the first eligible entry"
// wasn't good enough (a Best Scenery swap has no reason to land on whichever water
// happens to sit first in the array). This just finds whether `text` names an ineligible
// river and, if so, hands back every currently-eligible alternative to choose from.
// Shared eligibility predicate - pulled out of findIneligibleMatch's local closure
// (2026-09-06) so reconcileBestBet can also ask "how many eligible rivers exist at all,"
// not just "is this one river eligible."
function isIneligibleRiver(r){return r.outOfRange===true||(r.restriction&&r.restriction.status==="closure");}

function findIneligibleMatch(text,rivers){
  const norm=nrmName(text);
  const matched=rivers.find(r=>{
    const core=nrmName(coreRiverName(r.name));
    return core&&norm.includes(core);
  });
  if(matched){
    if(!isIneligibleRiver(matched))return null; // matched a real, in-range pick -- nothing to fix
    return{matched,eligible:rivers.filter(r=>r!==matched&&!isIneligibleRiver(r))};
  }
  // No match at all: this field names a river that isn't in rivers[] AT ALL, most commonly
  // because it failed to snap to a gauge AND failed Places geocoding earlier in
  // finalizeLabRivers and was dropped before labGovernor ever got a chance to flag it
  // outOfRange. By rule 10 in buildLabSynth every bestFor/recommendation value is REQUIRED
  // to name a rivers[] entry, so "no match" is never a benign case -- it's exactly as
  // dangling a reference as an outOfRange match, and needs the same swap.
  return{matched:null,eligible:rivers.filter(r=>!isIneligibleRiver(r))};
}

function swapText(alt){
  return String(alt.why||alt.conditions||"See its river card below for details.").trim();
}

// Small, targeted AI call (thorough/background path only — same posture as
// resolveUnsurePick/verifyOmissions above) to pick the best-fit replacement when a swap
// has a genuine CHOICE to make: 2+ eligible candidates left after an ineligible pick is
// swapped out. "Best Scenery" landing on whichever water happened to be array-first isn't
// actually judging scenery. Batches every field that needs resolving into ONE call per
// report (not one per field) since several fields can legitimately point at the same
// ineligible pick. Fields with 0 or 1 eligible candidates need no judgment call and never
// reach here. Fail-open: any error, timeout, or a returned name that doesn't match a real
// candidate falls back to the first eligible candidate in the caller, same as pre-2026-08-30.
async function resolveSwapsWithAI(needs,aiCtx){
  try{
    const items=needs.map((n,i)=>{
      const cands=n.eligible.map(r=>r.name+(r.why?" — "+r.why:r.conditions?" — "+r.conditions:"")).join("  |  ");
      return (i+1)+") Category: \""+n.label+"\". What the original (now-ineligible) pick was praised for: \""+n.originalText+"\". Eligible candidates for THIS category only: "+cands;
    }).join("\n");
    const prompt=["You are picking the single best-fit replacement river for each numbered category below, choosing ONLY from that item's own listed candidates — never a water from a different item's list.",
      "Judge fit the way the category itself implies: a scenery category should be judged on scenery, a solitude category on solitude, a beginners category on approachability, an overall best-bet category on general fit for today. Use each candidate's own description to make that judgment — do not invent facts not present in it.",
      "Return ONLY a JSON array, one object per numbered item, SAME ORDER, no markdown: [{\"n\":1,\"name\":\"\"}] — \"name\" must be copied EXACTLY (character-for-character) from that item's own candidate list.",
      items].join("\n");
    const race=Promise.race([aiCtx.askAI(prompt,false,600,"planner"),new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")),45000))]);
    const clean=String(await race||"").replace(/```json|```/g,"").trim();
    const a=clean.indexOf("["),b=clean.lastIndexOf("]");
    if(a===-1||b<=a)return null;
    const parsed=JSON.parse(clean.slice(a,b+1));
    return Array.isArray(parsed)?parsed:null;
  }catch{return null;}
}

// Auto-swaps "Best Bet Today" AND every bestFor category (mostFish/bestScenery/
// mostSolitude/beginners) when the pick either one is actually about turns out to be
// ineligible. Until 2026-08-12 this only guarded `recommendation` — bestFor is chosen by
// the AI in buildLabSynth BEFORE labGovernor/labVerifyRestrictions run, so a category
// could point at a pick that gets flagged out-of-range or closed moments later, with
// nothing to catch it. Same fail-open posture as before either way.
// 2026-08-30: now async — when a swap has more than one eligible candidate to choose
// between, it asks resolveSwapsWithAI which one actually fits that category (thorough
// mode + a real aiCtx only; otherwise/on failure, falls back to the first eligible
// candidate, same behavior as before this date).
export async function reconcileBestBet(report,aiCtx,opts){
  if(!report||!Array.isArray(report.rivers)||!report.rivers.length)return report;
  const thorough=!!(opts&&opts.thorough);
  const fields=[]; // {kind, key, label, originalText, matched, eligible}
  if(report.recommendation){
    const m=findIneligibleMatch(report.recommendation,report.rivers);
    if(m)fields.push({kind:"recommendation",key:null,label:"today's overall best bet",originalText:report.recommendation,...m});
  }
  if(report.bestFor){
    const LABELS={mostFish:"most fish",bestScenery:"best scenery",mostSolitude:"most solitude",beginners:"best for beginners"};
    Object.keys(LABELS).forEach(k=>{
      const val=report.bestFor[k];
      if(!val)return;
      const m=findIneligibleMatch(val,report.rivers);
      if(m)fields.push({kind:"bestFor",key:k,label:LABELS[k],originalText:val,...m});
    });
  }
  // 2026-09-06 fix: with only one genuinely eligible water left today, mostFish/
  // bestScenery/mostSolitude/beginners have no real distinction left to make - the swap
  // below would otherwise paste the SAME river's `why` text into all four AND Best Bet
  // Today, verbatim (confirmed against a real report: Pohopoco Creek repeated word-for-
  // word across all five slots). Product call: drop the bestFor grid entirely and keep
  // only Best Bet Today rather than manufacture a fake four-way breakdown.
  const totalEligible=report.rivers.filter(r=>!isIneligibleRiver(r)).length;
  if(totalEligible<=1){
    let out=report.bestFor?{...report,bestFor:null}:report;
    const recField=fields.find(f=>f.kind==="recommendation");
    if(recField&&recField.eligible.length)out={...out,recommendation:swapText(recField.eligible[0])};
    return out;
  }

  if(!fields.length)return report;

  const needAI=fields.filter(f=>f.eligible.length>1);
  const aiPicks=(needAI.length&&thorough&&aiCtx&&typeof aiCtx.askAI==="function")?await resolveSwapsWithAI(needAI,aiCtx):null;

  let out=report;
  let bfChanged=false;
  const bf=report.bestFor?{...report.bestFor}:null;
  fields.forEach(f=>{
    if(!f.eligible.length)return; // nothing to swap to — leave the original text untouched
    let alt=f.eligible[0]; // default: first eligible — used as-is when there's only one, or as the fail-open fallback
    if(f.eligible.length>1&&aiPicks){
      const idx=needAI.indexOf(f);
      const pick=aiPicks.find(p=>Number(p&&p.n)===idx+1);
      const byName=pick&&f.eligible.find(r=>nrmName(r.name)===nrmName(String(pick.name||"")));
      if(byName)alt=byName;
    }
    const text=swapText(alt);
    if(f.kind==="recommendation")out={...out,recommendation:text};
    else if(bf){bf[f.key]=text;bfChanged=true;}
  });
  if(bfChanged)out={...out,bestFor:bf};
  return out;
}

// Rewrites overview/recommendation/bestTimes with ONE small, targeted AI call when they
// still mention a river that didn't survive into the final rivers[] list -- e.g. a pick that
// failed gauge-snap AND Places geocoding in finalizeLabRivers and was silently dropped before
// labGovernor ever got a chance to flag it outOfRange (the same underlying failure the
// findIneligibleMatch fix above addresses for single-river fields like a bestFor category).
// These three fields are free-form prose that can mention a dropped water in passing
// alongside other, still-valid content in the SAME sentence -- confirmed against a real report
// that scrubDamClaims-style clause deletion would also delete an adjacent, correct mention,
// since there's no clean sentence boundary between them in a long comma-joined overview. A
// rewrite call, given the actual final river list and told exactly which names are no longer
// valid, can produce grammatically correct prose without needing to find a clause boundary
// itself. Thorough/background path only (same posture as resolveSwapsWithAI) -- and skips the
// AI call entirely unless a field actually still mentions a dropped name, so the common case
// (nothing dropped, or the dropped water was never mentioned in free text) costs nothing.
async function rewriteStaleFreeText(fields,droppedNames,finalRivers,loc,aiCtx,thorough){
  if(!thorough||!aiCtx||typeof aiCtx.askAI!=="function")return fields;
  const dropped=(droppedNames||[]).map(coreRiverName).filter(Boolean);
  if(!dropped.length)return fields;
  const flagged=Object.keys(fields).filter(k=>{
    const val=fields[k];
    if(!val)return false;
    const norm=nrmName(val);
    return dropped.some(n=>{const core=nrmName(n);return core&&norm.includes(core);});
  });
  if(!flagged.length)return fields;
  try{
    const keepList=(finalRivers||[]).map(r=>r.name).filter(Boolean).join(", ")||"none";
    const items=flagged.map((k,i)=>(i+1)+") "+k+": \""+fields[k]+"\"").join("\n");
    const prompt=["You are correcting "+flagged.length+" field(s) of a trout-fishing report near "+(loc&&loc.label||"the trip location")+" so they no longer discuss water that isn't actually in this report.",
      "The ONLY waters actually covered in this report are: "+keepList+".",
      "Each numbered field below currently mentions one or more OTHER waters that did not make the final cut ("+dropped.join(", ")+"). Remove any specific claim about those other waters entirely (do not just soften the wording -- remove it, and don't invent a reason it was excluded such as being too far or out of range, just write as if it was never brought up), while keeping everything else in the field intact, same voice, similar length.",
      "FIELDS:\n"+items,
      "Return ONLY a JSON object no markdown, one key per field name exactly as given, value = the corrected text: {"+flagged.map(k=>"\""+k+"\":\"\"").join(",")+"}"
    ].join(" ");
    const race=Promise.race([aiCtx.askAI(prompt,false,700,"planner"),new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")),30000))]);
    const clean=String(await race||"").replace(/```json|```/g,"").trim();
    const a=clean.indexOf("{"),b=clean.lastIndexOf("}");
    if(a===-1||b<=a)return fields;
    const parsed=JSON.parse(clean.slice(a,b+1));
    const out={...fields};
    flagged.forEach(k=>{ if(parsed&&typeof parsed[k]==="string"&&parsed[k].trim())out[k]=parsed[k].trim(); });
    return out;
  }catch{
    return fields; // fail-open: never block report delivery on this -- worst case the stale
    // mention survives, same as before this fix existed.
  }
}

// Light-touch personalization (App Dev, added after the AI Intel feature): a short,
// deterministic note built from the angler's OWN logged trip history — never an AI
// call, so it can't hallucinate, and never touches river selection/verification above.
// input.anglerHistory is a pre-aggregated summary the caller builds from their own
// personal_trips/catches data — see buildAnglerHistorySummary in App.jsx. Returns null
// (renders nothing) unless there's enough real signal to say something honest.
export function buildPersonalAngle(anglerHistory){
  if(!anglerHistory||!anglerHistory.catchCount||anglerHistory.catchCount<3) return null;
  const {topFlies,topSpecies,cfsRange,weatherMode,clarityMode,crowdMode,catchCount,tripCount}=anglerHistory;
  const clauses=[];
  if(topSpecies) clauses.push(`you've mostly landed ${topSpecies}`);
  if(topFlies&&topFlies.length) clauses.push(`doing best on ${topFlies.join(", ")}`);
  if(cfsRange) clauses.push(`in flows roughly ${cfsRange.low}\u2013${cfsRange.high} CFS`);
  // weatherMode/clarityMode/crowdMode only arrive non-null when modeWithThreshold
  // found a genuine majority (see buildAnglerHistorySummary in App.jsx) — describing
  // conditions you've fished in, not claiming they cause success.
  if(weatherMode) clauses.push(`usually fishing when it's ${weatherMode.toLowerCase()}`);
  if(clarityMode) clauses.push(`typically finding the water ${clarityMode.toLowerCase()}`);
  if(crowdMode) clauses.push(`usually encountering ${crowdMode.toLowerCase()} crowds`);
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
  // Background/email path only (set true in api/plan-trip-background.js) — spends the
  // larger time budget that path has to actually verify/resolve things this synchronous,
  // watched-in-app path instead has to hedge or flag. See labGovernor, labVerifyPicks,
  // verifyOmissions.
  const thorough = !!input.thorough;
  const savedGauges = input.savedGauges||[];
  const pTempMap = input.pTempMap||{};
  const flowAvgMap = input.flowAvgMap||{};
  const driveMinutes = input.driveMinutes||120;

  // Non-USGS sources (sourceAgency set — see src/lib/gaugeSources.js) are already
  // vetted by their own source-calibrated fishable-water filter at fetch time.
  // Re-running filterFishableGauges's USGS-tuned word list on them a second time
  // is not just redundant, it's WRONG for at least one real case: DWR names
  // tailwater gauges "<creek> BELOW <name> RESERVOIR" (South Boulder Creek's own
  // gauge: "SOUTH BOULDER CREEK BELOW GROSS RESERVOIR"), and "reservoir" is one
  // of this filter's exclusion words — tuned correctly for USGS's own naming
  // convention, where that word means a lake-type site, but wrong for DWR's,
  // where it's standard tailwater phrasing. Confirmed by direct reproduction:
  // BOCBGRCO survives gaugeSources.js's own filter, then gets silently dropped
  // right here before ever reaching the AI prompt. Split by source so each
  // source's own filter is the only one that runs on its own gauges.
  const usgsOnly=(pgScaled||[]).filter(g=>!g.sourceAgency);
  const preVetted=(pgScaled||[]).filter(g=>g.sourceAgency);
  const fishableGauges=[...filterFishableGauges(usgsOnly,loc.lat,loc.lng),...preVetted];
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
  // TEMP DIAGNOSTIC (App Dev — South Platte/Deckers/Cheesman omission investigation,
  // 2026-08-24): checks each of the three parallel search calls' RAW text — before any
  // AI pick-selection or filtering touches it — for a mention of this specific known-gap
  // water. Distinguishes "search never surfaced it" (all three log "not found") from
  // "found it and something downstream dropped it" (a snippet logs, but it never makes
  // the final rivers[] list). Scoped to this one known gap rather than a general check;
  // remove once diagnosed.
  try{
    const southRe=/deckers|cheesman|south platte/i;
    const snippet=t=>{const s=String(t||"");const m=s.match(southRe);if(!m)return null;const i=m.index;return s.slice(Math.max(0,i-60),i+90).replace(/\s+/g," ").trim();};
    const report=(label,t)=>console.log("[searchDiag] Deckers/Cheesman/South Platte —",label+":",southRe.test(t)?snippet(t):"not found ("+String(t||"").length+" chars searched)");
    report("searchPrompt1 (shop reports)",parts[0]);
    report("searchPrompt2 (general reports)",parts[1]);
    report("labFetchPrompt (fetched pages)",parts[2]);
    // ROUND 2 (2026-08-25): round 1 confirmed all three raw calls find it — this checks
    // whether the synthPrompt's hard "first 5000 chars" slice of the COMBINED searchTxt
    // (labGround+parts[0]+parts[1], in that order) is what's cutting it before the
    // synthesis AI ever reads it. Remove alongside the round-1 block once diagnosed.
    const cMatch=searchTxt.match(southRe);
    console.log("[searchDiag] Deckers/Cheesman/South Platte — COMBINED searchTxt ("+searchTxt.length+" chars total; synthPrompt uses only the first 5000):",cMatch?("match at index "+cMatch.index+" — "+(cMatch.index<5000?"SURVIVES the 5000-char cutoff":"CUT OFF, past the 5000-char cutoff")):"no match found in combined text (unexpected)");
  }catch(_sd){void 0;}
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
  // Distance-language backstop applies to overview/recommendation/bestFor/per-river fields
  // alike, matching the stated scope of the DISTANCE LANGUAGE RULE itself in buildLabSynth.
  const sbd=t=>scrubDistanceClaims(sb2(t));
  const bf2=rpt.bestFor?{mostFish:sbd(rpt.bestFor.mostFish),bestScenery:sbd(rpt.bestFor.bestScenery),mostSolitude:sbd(rpt.bestFor.mostSolitude),beginners:sbd(rpt.bestFor.beginners)}:null;

  // Captured BEFORE finalizeRivers can drop any pick (failed gauge-snap + geocoding) so the
  // stale-reference rewrite near the end of this function knows what the AI originally
  // proposed, even for names that never make it into the final rivers[] list at all.
  const originalRiverNames=(rpt.rivers||[]).map(r=>r&&r.name).filter(Boolean);

  // Report-level review runs in parallel with finalize (they're independent)
  const reviewPromise=labReviewReport({rivers:rpt.rivers,hatches:rpt.hatches,bestTimes:rpt.bestTimes,tips:rpt.tips,overview:rpt.overview,recommendation:rpt.recommendation},loc,searchTxt,ds,aiCtx).catch(()=>null);
  const restrictionsPromise=labVerifyRestrictions(rpt.rivers,loc,ds,aiCtx).catch(e=>({result:null,debug:{outcome:"promise-reject",error:String((e&&e.message)||e).slice(0,120)}}));

  let builtReport={
    searchNote,
    dataSource:searchTxt.length>200?"current":(fishableGauges.length||(pgScaled||[]).length)?"flows-live":"estimated",
    overview:sbd(rpt.overview),
    recommendation:sbd(rpt.recommendation),
    bestFor:bf2,
    rivers:await finalizeRivers((rpt.rivers||[]).map(r=>({...r,conditions:sbd(r.conditions),techniques:sbd(r.techniques),why:sbd(r.why),bestTime:eThermal?scrubAfternoonPush(clean2(r.bestTime)):clean2(r.bestTime),accessPoints:Array.isArray(r.accessPoints)?r.accessPoints:r.accessPoints?[String(r.accessPoints)]:[],flies:cleanFlyList(Array.isArray(r.flies)?r.flies:r.flies?[String(r.flies)]:[])})),fishableGauges.length?fishableGauges:(pgScaled||[]),loc,searchTxt,aiCtx,{thorough}),
    hatches:sb2(rpt.hatches),
    bestTimes:eThermal?scrubAfternoonPush(sbd(rpt.bestTimes)):sbd(rpt.bestTimes),
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
      if(fx.bestTimes){nb.bestTimes=eThermal?scrubAfternoonPush(sbd(fx.bestTimes)):sbd(fx.bestTimes);changed=true;}
      if(fx.tips){nb.tips=eThermal?(THERMAL_TIP_SOFT+" "+scrubAfternoonPush(sb2(fx.tips))).trim():sb2(fx.tips);changed=true;}
      if(fx.overview){nb.overview=sbd(fx.overview);changed=true;}
      if(fx.recommendation){nb.recommendation=sbd(fx.recommendation);changed=true;}
      if(Array.isArray(fx.rivers)&&fx.rivers.length&&Array.isArray(nb.rivers)){
        const nrm=nrmName;
        nb.rivers=nb.rivers.map(rv=>{
          const m=fx.rivers.find(f=>{const a=nrm(f.name),b=nrm(rv.name);return a&&b&&(a===b||a.startsWith(b)||b.startsWith(a));});
          if(m&&Array.isArray(m.flies)&&m.flies.length){const cleaned=cleanFlyList(m.flies);if(cleaned.length){changed=true;return {...rv,flies:cleaned};}}
          return rv;
        });
      }
      if(review.omissions&&review.omissions.length){
        if(thorough){
          const gaugeListForOmissions=fishableGauges.length?fishableGauges:(pgScaled||[]);
          const verified=await verifyOmissions(review.omissions,loc,gaugeListForOmissions,flowAvgMap,aiCtx).catch(()=>[]);
          if(verified.length){
            nb.overview=applyVerifiedReviewNotes(nb.overview,verified.map(v=>v.text));
            changed=true;

            // 2026-08-30: promote a strong, verified omission into a genuine river card
            // (see promoteOmissionToRiver above for the full reasoning) BEFORE the
            // fallback below runs — this can turn a report that had literally nothing
            // in range into one with a real in-range pick, which naturally defuses the
            // old fallback's own trigger condition (anyRiverInRange) without needing to
            // special-case that interaction here.
            const promoted=await promoteOmissionToRiver(verified,nb.rivers,loc,aiCtx,thorough).catch(()=>null);
            if(promoted){nb.rivers=[...(nb.rivers||[]),promoted];changed=true;}

            // Fallback for when promotion didn't happen (nothing verified had a real
            // CFS, or the flesh-out call failed) and literally every AI-picked river is
            // still out of range (2026-08-14). A verified omission has already been
            // geocoded, day-trip distance checked, and (usually) snapped to a real live
            // gauge — a genuinely closer, real answer beats leaving the AI's original
            // out-of-range "Best Bet Today" text standing unchallenged just because
            // reconcileBestBet (below) had no in-range river CARD to swap to.
            // Scope: only the recommendation line — bestFor categories keep their
            // existing flag-in-place behavior from reconcileBestBet rather than also
            // being upgraded, since each bestFor category's own reasoning (e.g. "most
            // solitude") doesn't necessarily still apply to a different river.
            // 2026-08-30: no visible "⚠ every pick above is beyond range" warning
            // anymore — same silent-swap posture as reconcileBestBet now uses.
            const anyRiverInRange=Array.isArray(nb.rivers)&&nb.rivers.some(r=>!r.outOfRange&&!(r.restriction&&r.restriction.status==="closure"));
            const withCfs=verified.filter(v=>v.cfs!=null);
            if(!anyRiverInRange&&withCfs.length){
              const top=withCfs[0];
              const flowPart=top.flowLabel?(top.cfs+" CFS, "+top.flowLabel):(top.cfs+" CFS");
              nb.recommendation=top.name+(top.desc?" — "+top.desc:"")+", running "+flowPart+".";
            }
          }
          // else: nothing survived verification — say nothing rather than hedge.
        }else{
          nb.overview=applyReviewNotes(nb.overview,review);changed=true;
        }
      }
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
    }
    builtReport=nb2;
  }catch(_rx){void 0;}

  // Must run last: needs the final outOfRange (labGovernor) and restriction
  // (labVerifyRestrictions, just folded in above) flags to know what's eligible. Now
  // async (2026-08-30) — may make one small targeted AI call of its own when a swap has
  // a genuine choice to make between eligible replacements.
  builtReport=await reconcileBestBet(builtReport,aiCtx,{thorough});

  // NOW it's safe to actually remove labGovernor's thorough-mode clutter picks (flagged
  // dropIfThorough, deliberately not deleted at the source — see labGovernor's 2026-08-30
  // note). Doing this here, after reconcileBestBet, is the fix for the 2026-08-30 bug
  // where "Best Bet Today"/bestFor named a water (e.g. Roaring Fork) with zero
  // corresponding river card: reconcileBestBet needed the ineligible pick still present
  // in rivers[] to match and swap the dangling text before it disappears from the report.
  if(Array.isArray(builtReport.rivers)&&builtReport.rivers.some(r=>r.dropIfThorough)){
    builtReport={...builtReport,rivers:builtReport.rivers.filter(r=>!r.dropIfThorough)};
  }

  // Must run AFTER the dropIfThorough strip just above — needs the truly final rivers[]
  // list to know which of the AI's originally-proposed names actually got dropped along the
  // way (failed gauge-snap + geocoding, flagged outOfRange, or closed). Catches exactly the
  // gap reconcileBestBet's single-field swap can't: free-form prose (overview/recommendation/
  // bestTimes) that names a dropped water in passing alongside other, still-valid content in
  // the same sentence. See rewriteStaleFreeText above for why this is a rewrite call rather
  // than a regex clause-strip.
  {
    const finalCoreNames=new Set((builtReport.rivers||[]).map(r=>nrmName(coreRiverName(r.name))));
    const droppedNames=originalRiverNames.filter(n=>!finalCoreNames.has(nrmName(coreRiverName(n))));
    if(droppedNames.length){
      const rewritten=await rewriteStaleFreeText(
        {overview:builtReport.overview,recommendation:builtReport.recommendation,bestTimes:builtReport.bestTimes},
        droppedNames,builtReport.rivers,loc,aiCtx,thorough
      );
      builtReport={...builtReport,...rewritten};
    }
  }

  // Light-touch personalization — deterministic, no AI call, computed last and
  // completely isolated from river selection/verification above it.
  builtReport.personalAngle=buildPersonalAngle(input.anglerHistory);

  return builtReport;
}
