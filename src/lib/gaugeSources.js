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

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

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
async function fetchCODWRLatestValues(abbrevs) {
  if (!abbrevs.length) return {};
  const today = new Date();
  const lookback = new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000); // 2-day window absorbs DWR's ~1-day reporting lag
  const byAbbrev = {};
  const chunks = chunkArr(abbrevs, 100);
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const url =
        CO_DWR_BASE +
        "/surfacewater/surfacewatertsday/?format=json&abbrev=" +
        chunk.join(",") +
        "&min-measDate=" +
        isoDate(lookback) +
        "&max-measDate=" +
        isoDate(today);
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
    if (!prev || new Date(row.measDate) > new Date(prev.measDate)) byAbbrev[row.abbrev] = row;
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
  // MM/DD/YYYY, built from the UTC calendar date (toISOString(), same timezone-safe
  // approach isoDate() above already uses) — never the local calendar date. This
  // function runs in both the browser (a user's own device timezone) and the Vercel
  // server (UTC) per this file's own header comment; deriving the date from local
  // getMonth()/getDate() would make the requested window depend on which environment
  // ran it. Format confirmed directly against DWR's raw endpoint (zero-padded
  // MM/DD/YYYY, e.g. "08/15/2026") — non-ISO, unlike the daily endpoint below.
  const iso = d.toISOString().slice(0, 10);
  const [y, m, day] = iso.split("-");
  return m + "/" + day + "/" + y;
}

// Raw 15-minute telemetry fetch for a single gauge's truly-current reading
// (2026-08-15). fetchCODWRLatestValues above deliberately stays on DWR's DAILY
// endpoint (surfacewatertsday) — right tradeoff for fetchCODWRGauges' area sweep,
// which can touch 100+ stations in one call and only needs "roughly current" at
// acceptable payload size. But DWR doesn't publish a day's row until later that day,
// so "most recent available" from the daily endpoint is routinely YESTERDAY's value,
// not today's. Confirmed directly against the motivating case: BOCPINCO (South
// Boulder Creek above Gross Reservoir at Pinecliffe) showed 47.5 CFS via the daily
// endpoint — Aug 14's row, still the newest one DWR had published — while the actual
// live reading, from this raw endpoint, was 25.5 CFS. Same station a user has pinned
// in My Gauges and is comparing against a competitor app showing the true live value.
// A single pinned gauge is exactly the case where that gap matters and the payload
// cost of one station's worth of raw readings (up to ~192 rows for a 2-day window,
// vs. ~2 for the daily endpoint) is negligible.
async function fetchCODWRRawLatest(abbrev) {
  const today = new Date();
  const lookback = new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000); // same 2-day buffer as fetchCODWRLatestValues, for consistency — far more than the ~15-50min lag actually observed on this endpoint, so it also absorbs a short station outage without extra code
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000); // endDate is EXCLUSIVE on this endpoint — tested directly: endDate=<today's date> silently dropped every reading from today itself (cut off exactly at the prior midnight), passing tomorrow's date is what actually includes today
  const url =
    CO_DWR_BASE +
    "/telemetrystations/telemetrytimeseriesraw/?format=json&abbrev=" +
    abbrev +
    "&parameter=DISCHRG&startDate=" +
    toMDY(lookback) +
    "&endDate=" +
    toMDY(tomorrow);
  const r = await fetchWithTimeout(url, 6000);
  if (!r.ok) return null;
  const d = await r.json();
  const rows = d.ResultList || [];
  if (!rows.length) return null;
  let latest = rows[0];
  for (const row of rows) {
    if (new Date(row.measDateTime) > new Date(latest.measDateTime)) latest = row;
  }
  return latest.measValue != null ? parseFloat(latest.measValue) : null;
}

// Single-station live fetch (2026-08-15, revised same day) — for callers that already
// know exactly which DWR abbrev they want (the saved-gauges "My Gauges" feature) and
// don't need the station-search + dedup + directional-spread machinery
// fetchCODWRGauges does for a fresh area sweep. Originally reused
// fetchCODWRLatestValues (the daily endpoint) to avoid duplicating batching/lookback
// logic — switched to fetchCODWRRawLatest instead once live testing surfaced the
// stale-value gap documented above. fetchCODWRLatestValues/fetchCODWRGauges are
// untouched by this change.
export async function fetchCODWRSingleValue(abbrev) {
  if (!abbrev) return null;
  try {
    return await fetchCODWRRawLatest(abbrev);
  } catch {
    return null;
  }
}
