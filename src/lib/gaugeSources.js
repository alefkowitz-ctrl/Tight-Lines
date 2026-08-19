// ============================================================================
// Supplemental river-gauge sources beyond USGS. See SPEC_gauge_sources.md
// (Project Knowledge) for the full design rationale — short version: USGS
// stays exactly as-is everywhere it already runs; these functions are called
// ALONGSIDE the existing fetchUSGSLive/fetchUSGSLiveServer results, and every
// exported fetcher here returns gauges already normalized to the same shape
// those functions' callers already build:
//   { name, cfs, label, cls, siteNo, dist, lat, lng, sourceAgency }
// That means no downstream code (directionalSpread, labGovernor, the
// Streams-tab render, etc.) needs to change — it just sees a longer array.
//
// Import from BOTH the browser bundle (src/App.jsx) and the Vercel server
// function (api/plan-trip-background.js). This file only uses fetch() and
// plain JS — no browser-only or Node-only APIs — so it works unmodified in
// both places, unlike the older USGS layer (which is deliberately duplicated
// client/server — see that file's own comment for why).
// ============================================================================

import { directionalSpread } from "./tripPlannerPipeline.js";

// Deliberately NOT reusing tripPlannerPipeline.js's filterFishableGauges here —
// tested against a real station name and it silently drops the motivating case.
// DWR names tailwater gauges "<creek> BELOW <name> RESERVOIR" (e.g. South
// Boulder Creek's own station: "SOUTH BOULDER CREEK BELOW GROSS RESERVOIR"),
// where USGS convention would say "...BELOW ... DAM" instead. The shared list
// excludes "reservoir" — correct for USGS's own naming, where that word means
// a lake-type site, not a downstream creek — but wrong for DWR's, where it's
// standard tailwater phrasing. Rather than edit the shared USGS-tuned list
// (out of scope — risks changing already-verified USGS filtering behavior),
// this is a separate, DWR-calibrated list: same water-word positive check,
// but drops reservoir/lake/pond/inlet/outlet/tailrace from the exclusions,
// since a pure impoundment name with no creek/river word in it already fails
// the positive check on its own (tested: "GROSS RESERVOIR" alone matches no
// water word either way) — nothing that was safely excluded before becomes
// unsafe by dropping those five words specifically.
const DWR_NON_FISHABLE_WORDS = [
  "canal", "ditch", "drain", "diversion", "lateral", "irrigation", "pipeline",
  "tunnel", "aqueduct", "municipal", "effluent", "waste", "sewage", "outfall",
  "headgate", "bypass", "flume", "return", "delivery", "main", "supply",
  "project", "district", "well", "spring", "seep", "buffer zone", "landfill",
  "plant", "facility", "treatment",
];
const WATER_WORDS = [
  "creek", "river", "brook", " run", " fork", "branch", "stream", "slough",
  "gulch", "canyon", "bayou", "kill", " rio ", " riv", " r ", " cr", " ck", " fk",
];
function isDWRFishableName(name) {
  const n = String(name || "").toLowerCase();
  const hasWater = WATER_WORDS.some((w) => n.includes(w));
  const hasNonFish = DWR_NON_FISHABLE_WORDS.some((w) => n.includes(w));
  return hasWater && !hasNonFish;
}

function cfsLabel(cfs) {
  if (cfs == null || isNaN(cfs)) return { label: "No Data", cls: "fair" };
  return { label: Math.round(cfs).toLocaleString() + " CFS", cls: "" };
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Colorado DWR (dwr.state.co.us) — free, no API key required for this app's
// call volume. Confirmed live 2026-08-14: anonymous access gets 1,000
// requests/day and 600,000 rows/day (checked directly against the API's own
// UserLimits endpoint), far above what a single trip report needs. If usage
// ever grows enough to matter, DWR supports an apiKey URL param the same
// way — nothing else about this function would need to change.
// ---------------------------------------------------------------------------
const CO_DWR_BASE = "https://dwr.state.co.us/Rest/GET/api/v2";

async function fetchCODWRStations(lat, lng, radiusMiles) {
  const url =
    CO_DWR_BASE +
    "/surfacewater/surfacewaterstations/?format=json&latitude=" +
    lat +
    "&longitude=" +
    lng +
    "&radius=" +
    radiusMiles +
    "&units=miles";
  const r = await fetchWithTimeout(url, 6000);
  if (!r.ok) return [];
  const d = await r.json();
  return (d.ResultList || []).filter(
    (s) => s.abbrev && s.latitude != null && s.longitude != null
  );
}

function chunkArr(a, n) {
  const out = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

// Batched into groups of 100 abbrevs per request — tested directly: an
// unbatched request for 655 stations (a real 40-mile-radius result near
// Denver) built a 6,000+ character URL that DWR's server rejected outright
// (404, not a graceful empty result), silently dropping every candidate
// including the motivating South Boulder Creek case. Same batching pattern
// this app already uses for USGS site lookups (chunkArr(...,100)).
//
// Originally pointed at DWR's DAILY endpoint (surfacewatertsday) — reasonable-looking
// tradeoff at the time (one row/station/day vs. ~96 for the raw feed), but wrong in
// practice: DWR doesn't publish a day's row until later that day, so "most recent
// available" was routinely YESTERDAY's value. Fixed once for the My Gauges
// single-value path (fetchCODWRSingleValue, same day), but this shared function feeds
// fetchCODWRGauges too — the Streams tab's auto-populated nearby list — and a user
// confirmed directly afterward that list was still showing the stale number (their own
// starred BOCPINCO card: 48 CFS here vs. the correct ~25 CFS once starred into My
// Gauges). Switched to the raw 15-minute telemetry endpoint here as well, so every
// caller of this function gets the same true-current behavior — no reason area-sweep
// results should be less accurate than a single pinned gauge. Output is normalized to
// {abbrev, value, measDate} below specifically so fetchCODWRGauges' existing
// `v.value`/`v.measDate` consumption doesn't need to change.
async function fetchCODWRLatestValues(abbrevs) {
  if (!abbrevs.length) return {};
  const today = new Date();
  const lookback = new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000); // 2-day window — comfortably absorbs a short station outage; the raw feed's actual lag is only ~15-50min, tested directly
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000); // endDate is EXCLUSIVE on this endpoint — tested directly: passing today's own date silently dropped every reading from today itself, cut off exactly at the prior midnight
  const byAbbrev = {};
  const chunks = chunkArr(abbrevs, 100);
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const url =
        CO_DWR_BASE +
        "/telemetrystations/telemetrytimeseriesraw/?format=json&abbrev=" +
        chunk.join(",") +
        "&parameter=DISCHRG&startDate=" +
        toMDY(lookback) +
        "&endDate=" +
        toMDY(tomorrow);
      try {
        const r = await fetchWithTimeout(url, 6000);
        if (!r.ok) return [];
        const d = await r.json();
        return d.ResultList || [];
      } catch {
        return []; // one bad chunk shouldn't drop the others
      }
    })
  );
  for (const row of results.flat()) {
    const prev = byAbbrev[row.abbrev];
    if (!prev || new Date(row.measDateTime) > new Date(prev.measDate)) {
      byAbbrev[row.abbrev] = { abbrev: row.abbrev, value: row.measValue, measDate: row.measDateTime };
    }
  }
  return byAbbrev;
}

// lat/lng: search origin. radiusMiles: how far out to search (callers use a
// wider radius for the trip planner's full-area sweep, narrower for the
// Streams tab's "nearby" list — see the call sites for the actual numbers in
// use). usgsSiteNos: Set (or array) of siteNo values that ALREADY came back
// with a LIVE reading from this same search's USGS fetch — not just "has a
// usgsSiteId on file." DWR station records can carry a usgsSiteId for a USGS
// gauge that's long dead (this is exactly the South Boulder Creek / BOCBGRCO
// case: DWR lists usgsSiteId 06729450 for it, but that USGS site has had no
// live feed since 1980) — only skip a DWR station when USGS *actually
// returned* a live value for that same site this run.
//
// IMPORTANT for callers: siteNo on a DWR-sourced result is the USGS
// cross-reference ID when DWR has one on file (numeric), or the DWR station
// abbrev when it doesn't (letters, e.g. "BOCBGRCO"). Non-numeric siteNo
// values are NOT valid USGS site numbers — filter them out (a simple
// /^\d+$/ test) before passing a merged siteNo list into any USGS-only
// batch lookup (fetchUSGSTempBatch, fetchFlowAvgBatch, etc.). Tested
// directly: mixing a DWR abbrev into USGS's legacy iv endpoint's sites=
// param returns an HTTP 400 for the WHOLE request, silently dropping temp
// data for every real USGS gauge in the same batch — not just the bad one.
export async function fetchCODWRGauges(lat, lng, radiusMiles, usgsSiteNos) {
  try {
    const stations = await fetchCODWRStations(lat, lng, radiusMiles);
    if (!stations.length) return [];
    const matched = usgsSiteNos instanceof Set ? usgsSiteNos : new Set(usgsSiteNos || []);
    const candidates = stations.filter(
      (s) => !(s.usgsSiteId && matched.has(s.usgsSiteId)) && isDWRFishableName(s.stationName)
    );
    if (!candidates.length) return [];
    const values = await fetchCODWRLatestValues(candidates.map((s) => s.abbrev));
    const normalized = candidates
      .map((s) => {
        const v = values[s.abbrev];
        const cfs = v && v.value != null ? parseFloat(v.value) : null;
        const { label, cls } = cfsLabel(cfs);
        const dist = Math.sqrt(Math.pow(s.latitude - lat, 2) + Math.pow(s.longitude - lng, 2));
        return {
          name: s.stationName || s.abbrev,
          cfs,
          label,
          cls,
          siteNo: s.abbrev, // ALWAYS the DWR abbrev (2026-08-15), never s.usgsSiteId. A
          // usgsSiteId here, when present, is by construction a cross-reference that
          // already failed to return a live USGS reading this run — this candidate only
          // exists because the dedup step above excluded any DWR station whose usgsSiteId
          // DID come back live. Treating that dead ID as this gauge's queryable identity
          // breaks any future re-fetch by it. Confirmed directly: DWR abbrev BOCBGRCO
          // (South Boulder Creek below Gross Reservoir) has a live ~69 CFS reading right
          // now; its usgsSiteId cross-reference, 06729450, has returned zero live USGS
          // timeSeries entries since 1980 — exactly the gauge a user starred from the
          // Streams tab and then saw stuck on "Loading..." forever in My Gauges, because
          // toggleStar persisted this siteNo verbatim and My Gauges only knew how to
          // re-fetch from USGS. usgsSiteId is kept below for reference/display only.
          usgsCrossRef: s.usgsSiteId || null,
          dist,
          lat: s.latitude,
          lng: s.longitude,
          sourceAgency: "CO-DWR",
        };
      })
      .filter((g) => g.cfs != null && g.cfs >= 0 && g.cfs < 500000)
      .sort((a, b) => a.dist - b.dist); // closest first — directionalSpread takes candidates
      // from the FRONT of each compass bucket, so an unsorted array can let a
      // crowded bucket's farther entries edge out its own closest one. Tested
      // directly: without this sort, a 113-candidate batch dropped South
      // Boulder Creek's own gauge even at distance zero from the search point.
    // Same distance-spread budget the USGS path already uses (imported, not
    // reimplemented) — round-robins across compass directions so a dense
    // cluster near the origin can't crowd out a real drainage farther out.
    // 60, not 25: tested directly against a real, dense search (Lafayette, CO — 239
    // qualifying candidates within 100mi). A real, non-redundant gauge (South Boulder
    // Creek below Gross Reservoir) ranked 33rd by pure distance but still lost a
    // 25-slot directional-bucket competition to closer candidates crowding its
    // specific compass direction; empirically it first survives at a 50-slot cap.
    // 60 gives real margin above that. This runs AFTER USGS-redundant candidates are
    // already excluded by the dedup step above, so everything competing here is
    // already gap-filling, non-redundant coverage — no reason to cap it as tightly
    // as a raw, unfiltered candidate pool would need.
    return directionalSpread(normalized, 60, lat, lng);
  } catch (e) {
    return []; // fail closed — a supplemental source going down should never break a report
  }
}

function toMDY(d) {
  // MM/DD/YYYY, built from the UTC calendar date (toISOString()) — never the local
  // calendar date. This function runs in both the browser (a user's own device
  // timezone) and the Vercel server (UTC) per this file's own header comment;
  // deriving the date from local getMonth()/getDate() would make the requested
  // window depend on which environment ran it. Format confirmed directly against
  // DWR's raw endpoint: zero-padded MM/DD/YYYY, e.g. "08/15/2026".
  const iso = d.toISOString().slice(0, 10);
  const [y, m, day] = iso.split("-");
  return m + "/" + day + "/" + y;
}

// Single-station live fetch (2026-08-15) — for callers that already know exactly which
// DWR abbrev they want (the saved-gauges "My Gauges" feature) and don't need the
// station-search + dedup + directional-spread machinery fetchCODWRGauges does for a
// fresh area sweep. Reuses fetchCODWRLatestValues rather than duplicating the
// batching/lookback logic a second time — safe now that shared function is itself
// on the raw/live endpoint (see its comment above for why that changed).
export async function fetchCODWRSingleValue(abbrev) {
  if (!abbrev) return null;
  try {
    const values = await fetchCODWRLatestValues([abbrev]);
    const v = values[abbrev];
    return v && v.value != null ? parseFloat(v.value) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// NOAA NWPS (National Water Prediction Service) — forecast layer, nationwide.
// Adds a 96-hour flow forecast alongside DWR/USGS's observed-only data.
//
// 2026-08-18: an earlier version of this tried to sync NWPS's app-facing
// /v1/gauges endpoint (its full national list — 12,846 gauges, ~13MB, no
// geographic filter) into a local Supabase table on a schedule, since that
// endpoint ignores every filter param (state=, bbox=, lat/lon/radius all
// tested directly and ignored). That endpoint turned out to be unreliable at
// that scale — tested directly: 55+ seconds when it worked, outright
// timeouts 2 of 3 tries. NOAA's own ArcGIS map service underneath the same
// data supports real bounding-box queries instead — tested directly across
// five regions nationwide (CO, AK, NY, WY/MT, front-range CO), consistently
// under 1 second every time — so this fetches live, per-request, the same
// pattern as DWR above. No sync table, no cron job.
// ---------------------------------------------------------------------------
const NWPS_ARCGIS_BASE =
  "https://mapservices.weather.noaa.gov/eventdriven/rest/services/water/riv_gauges/MapServer";
const NWPS_OBSERVED_LAYER = 0;
// Longest forecast horizon this service offers (24/48/72/96hr layers exist;
// 96hr is the closest fit to a typical trip-planning lead time). If a future
// pass wants day-by-day granularity, layers 1–3 (24/48/72hr) use the exact
// same field shape — confirmed directly, not assumed.
const NWPS_FORECAST_LAYER = 4;
const NWPS_FORECAST_HORIZON_HRS = 96;

function milesToNWPSBBox(lat, lng, radiusMiles) {
  const dLat = radiusMiles / 69; // ~69 miles/degree latitude, effectively constant
  const dLng = radiusMiles / (69 * Math.cos((lat * Math.PI) / 180)); // longitude compresses toward the poles
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

async function queryNWPSLayer(layerId, bbox, outFields) {
  const url =
    NWPS_ARCGIS_BASE +
    "/" +
    layerId +
    "/query?where=1%3D1&geometry=" +
    bbox.join(",") +
    "&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=" +
    outFields +
    "&f=json";
  const r = await fetchWithTimeout(url, 6000);
  if (!r.ok) return [];
  const d = await r.json();
  return d.features || [];
}

// Same filter reasoning as isDWRFishableName above, applied to NWPS's own `waterbody`
// field. That field arrives already separated from the place name by ArcGIS's schema
// (e.g. waterbody:"Frying Pan River", location:"Thomasville") — unlike DWR's single
// combined station name, so no textual disambiguation is needed to reach the same
// correctness DWR's filter had to earn the hard way. Reusing the exact same word lists
// rather than re-tuning for NWPS specifically: NOAA's own convention names tailwater
// gauges "<river> below <name> Reservoir/Resv." too (confirmed directly: RUDC2's own
// raw name is "Frying Pan River below Ruedi Resv.", while ITS OWN waterbody field is
// just "Frying Pan River" — the reservoir itself gets a separate gauge entry, e.g.
// TPIC2 waterbody:"Taylor Park Reservoir", confirmed directly). Same motivating case
// DWR's filter already handles correctly, not a fresh guess.
function isNWPSFishableName(waterbody) {
  return isDWRFishableName(waterbody);
}

// Checks BOTH primary and secondary fields for a kcfs value, since NWPS gauges don't
// use a consistent orientation: some report discharge as the SECONDARY field alongside
// a primary stage value (pedts starting with "H", e.g. RUDC2/FPTC2 — primary "ft",
// secondary "kcfs"), while others report discharge directly as the PRIMARY field
// (pedts starting with "Q", e.g. ESSC2/Big Thompson at Lake Estes — primary "kcfs",
// secondary invalid/"-999"). Confirmed directly, 2026-08-18: an earlier version of this
// only checked the secondary field, so every Q-type gauge — including ESSC2, which
// Adam found showing a live 64 cfs forecast directly on water.noaa.gov — was invisible
// to fetchNWPSGauges, understating real coverage everywhere this ran.
function extractCfs(primaryValue, primaryUnit, secondaryValue, secondaryUnit) {
  if (primaryUnit === "kcfs" && primaryValue != null && primaryValue !== "" && primaryValue !== "-999") {
    const n = parseFloat(primaryValue) * 1000;
    if (!isNaN(n)) return n;
  }
  if (secondaryUnit === "kcfs" && secondaryValue != null && secondaryValue !== "" && secondaryValue !== "-999") {
    const n = parseFloat(secondaryValue) * 1000;
    if (!isNaN(n)) return n;
  }
  return null;
}

// lat/lng/radiusMiles: same meaning as fetchCODWRGauges. Returns the same normalized
// shape every other source in this file returns, PLUS two new optional fields callers
// can ignore if they don't care about forecast: forecastCfs, forecastHorizonHrs.
export async function fetchNWPSGauges(lat, lng, radiusMiles) {
  try {
    const bbox = milesToNWPSBBox(lat, lng, radiusMiles);
    const [observedFeatures, forecastFeatures] = await Promise.all([
      queryNWPSLayer(
        NWPS_OBSERVED_LAYER,
        bbox,
        "gaugelid,waterbody,location,observed,units,secvalue,secunit,latitude,longitude"
      ),
      queryNWPSLayer(NWPS_FORECAST_LAYER, bbox, "gaugelid,forecast,units,secvalue,secunit"),
    ]);
    if (!observedFeatures.length) return [];

    const forecastByLid = {};
    for (const f of forecastFeatures) forecastByLid[f.attributes.gaugelid] = f.attributes;

    const normalized = observedFeatures
      .map((f) => {
        const a = f.attributes;
        if (!isNWPSFishableName(a.waterbody)) return null;
        const cfs = extractCfs(a.observed, a.units, a.secvalue, a.secunit);
        const fcAttrs = forecastByLid[a.gaugelid];
        const forecastCfs = fcAttrs ? extractCfs(fcAttrs.forecast, fcAttrs.units, fcAttrs.secvalue, fcAttrs.secunit) : null;
        // Confirmed directly (ESSC2/Big Thompson at Lake Estes): a gauge can have NO
        // current reading of its own (status "obs_not_current") and STILL carry a valid
        // forecast — these are independent facts, not one gating the other. Requiring a
        // current cfs before even checking forecast dropped exactly this gauge from
        // every area sweep, silently, even though fetchNWPSSingleValue found it fine.
        // Only drop when NEITHER value is usable.
        if (cfs == null && forecastCfs == null) return null;
        const { label, cls } = cfs != null ? cfsLabel(cfs) : { label: null, cls: null };
        const dist = Math.sqrt(Math.pow(a.latitude - lat, 2) + Math.pow(a.longitude - lng, 2));
        return {
          name: a.waterbody + (a.location ? " near " + a.location : ""),
          cfs,
          label,
          cls,
          siteNo: a.gaugelid,
          dist,
          lat: a.latitude,
          lng: a.longitude,
          sourceAgency: "NOAA-NWPS",
          forecastCfs, // null when this gauge has no active 96hr discharge forecast — callers must treat that as "don't render", not "zero"
          forecastHorizonHrs: forecastCfs != null ? NWPS_FORECAST_HORIZON_HRS : null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.dist - b.dist); // closest first, same reason as the DWR sort above

    return directionalSpread(normalized, 60, lat, lng);
  } catch (e) {
    return []; // fail closed — a supplemental source going down should never break a report
  }
}

// Attaches a forecast onto gauges the app already shows, rather than adding NWPS as a
// fourth parallel source the way DWR was added as a third. NWPS forecast points are
// frequently the exact same physical gauge as an existing USGS/DWR entry — RFCs
// typically forecast AT established gauge sites — so treating NWPS like DWR (a new
// standalone card) would very often duplicate a river the app already shows a card
// for. Matches by proximity, not name: NWPS's `waterbody` naming and USGS's site
// naming don't share a convention reliable enough to match on text.
//
// Threshold ~0.7 miles (0.01 degrees, same simple degree-distance math every dist
// field in this file already uses) — tight enough this shouldn't ever attach a
// forecast to the wrong tributary. NWPS points with no existing match within that
// distance are dropped, not added as new cards — most forecast-active points ARE
// co-located with a gauge already shown, and this avoids disturbing the
// directionalSpread/count tuning fetchCODWRGauges's own comment above documents.
// Real tradeoff, flagged rather than made silently: a forecast-active tailwater with
// no nearby USGS/DWR gauge already on the list won't surface a forecast badge yet.
export function attachNWPSForecasts(existingGauges, nwpsGauges) {
  if (!nwpsGauges || !nwpsGauges.length) return existingGauges;
  const MATCH_THRESHOLD_DEG = 0.01;
  return existingGauges.map((g) => {
    let closest = null;
    let closestDist = Infinity;
    for (const n of nwpsGauges) {
      if (n.forecastCfs == null) continue; // nothing to attach — don't let it win the closest-match slot
      const d = Math.sqrt(Math.pow(n.lat - g.lat, 2) + Math.pow(n.lng - g.lng, 2));
      if (d < closestDist) {
        closestDist = d;
        closest = n;
      }
    }
    if (closest && closestDist <= MATCH_THRESHOLD_DEG) {
      return { ...g, forecastCfs: closest.forecastCfs, forecastHorizonHrs: closest.forecastHorizonHrs };
    }
    return g;
  });
}

// Single-gauge fetch, for callers that already know the exact NWPS gaugelid (the
// saved-gauges "My Gauges" feature) — mirrors fetchCODWRSingleValue's role for DWR.
// Returns { cfs, forecastCfs } rather than a bare number, since both are useful here
// and neither should be assumed present.
export async function fetchNWPSSingleValue(lid) {
  if (!lid) return null;
  try {
    const [obsFeatures, fcFeatures] = await Promise.all([
      fetchWithTimeout(
        NWPS_ARCGIS_BASE +
          "/" +
          NWPS_OBSERVED_LAYER +
          "/query?where=gaugelid%3D%27" +
          encodeURIComponent(lid) +
          "%27&outFields=observed,units,secvalue,secunit&f=json",
        6000
      ).then((r) => (r.ok ? r.json() : { features: [] })),
      fetchWithTimeout(
        NWPS_ARCGIS_BASE +
          "/" +
          NWPS_FORECAST_LAYER +
          "/query?where=gaugelid%3D%27" +
          encodeURIComponent(lid) +
          "%27&outFields=forecast,units,secvalue,secunit&f=json",
        6000
      ).then((r) => (r.ok ? r.json() : { features: [] })),
    ]);
    const obsAttrs = obsFeatures.features && obsFeatures.features[0] && obsFeatures.features[0].attributes;
    const fcAttrs = fcFeatures.features && fcFeatures.features[0] && fcFeatures.features[0].attributes;
    const cfs = obsAttrs ? extractCfs(obsAttrs.observed, obsAttrs.units, obsAttrs.secvalue, obsAttrs.secunit) : null;
    const forecastCfs = fcAttrs ? extractCfs(fcAttrs.forecast, fcAttrs.units, fcAttrs.secvalue, fcAttrs.secunit) : null;
    if (cfs == null && forecastCfs == null) return null;
    return { cfs, forecastCfs };
  } catch (e) {
    return null;
  }
}
