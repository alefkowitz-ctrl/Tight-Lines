// One-way sync: NOAA's National Water Prediction Service (NWPS) gauges endpoint has no
// server-side geographic filter — confirmed directly, 2026-08-18: state=, bbox=, and
// lat/lon/radius params are all ignored. It always returns its full national list —
// 12,846 gauges, ~13MB, as of that same test. Fetching that live on every trip-planner
// run or Streams-tab load isn't viable: it would blow past the 9-second patience budget
// the Streams tab already races against for DWR, and it's a slow, wasteful call to
// repeat per request. This endpoint instead pulls that list on a schedule (see the
// "crons" entry in vercel.json) and upserts just the location metadata — lid, name,
// lat, lng, state, rfc — into a small Supabase table, so gaugeSources.js can query it
// locally like any other gauge source.
//
// Live status (current reading, forecast) is NOT stored here — that's fetched fresh,
// per-gauge, only for whichever candidates actually match a search, same as every
// other source in this app never caches live values server-side.
//
// Uses SUPABASE_SERVICE_ROLE_KEY (see api/_lib/supabaseRest.js's own note on this env
// var — already set in this project) since this is a privileged bulk write, not a
// user-scoped one.
//
// Callable two ways: (1) Vercel Cron, on the schedule in vercel.json — runs
// automatically; (2) manually, by visiting this URL directly in a browser — this is
// how the FIRST sync gets run right after deploying, since Vercel Cron does not fire
// immediately on deploy, only at its next scheduled time.
//
// Deliberately unauthenticated: this endpoint only reads NOAA's own public data and
// writes non-user-specific rows, so there's nothing sensitive to protect. Worst case
// of someone hitting it repeatedly is a wasted NOAA fetch + a harmless re-upsert of
// identical rows — not a data-safety issue. Flagging this choice rather than making
// it silently, in case that tradeoff ever needs revisiting.

import { SB_URL } from "./_lib/supabaseRest.js";

const NWPS_GAUGES_URL = "https://api.water.noaa.gov/nwps/v1/gauges";

// Batch size for the Supabase upsert. Conservative starting point — NOT yet load-tested
// against this specific table/endpoint (the DWR module's chunkArr(...,100) batching was
// tuned for a URL-length limit on a GET request; this is a JSON POST body instead, so
// the actual constraint here is payload size / execution time, not URL length). If a
// real run shows batch failures, this is the first thing to shrink.
const BATCH_SIZE = 500;

function chunkArr(a, n) {
  const out = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

export default async function handler(req, res) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    res.status(500).json({ ok: false, error: "SUPABASE_SERVICE_ROLE_KEY not set" });
    return;
  }

  let gauges;
  try {
    const r = await fetch(NWPS_GAUGES_URL);
    if (!r.ok) throw new Error("NWPS fetch failed: HTTP " + r.status);
    const d = await r.json();
    gauges = d.gauges || [];
  } catch (e) {
    res.status(502).json({ ok: false, error: "Could not fetch NWPS gauge list: " + e.message });
    return;
  }

  const rows = gauges
    .filter((g) => g.lid && g.latitude != null && g.longitude != null)
    .map((g) => ({
      lid: g.lid,
      name: g.name || null,
      lat: g.latitude,
      lng: g.longitude,
      state: (g.state && g.state.abbreviation) || null,
      rfc: (g.rfc && g.rfc.abbreviation) || null,
      last_synced: new Date().toISOString(),
    }));

  const batches = chunkArr(rows, BATCH_SIZE);
  let written = 0;
  const errors = [];

  for (const batch of batches) {
    try {
      const r = await fetch(SB_URL + "/rest/v1/nwps_gauge_locations?on_conflict=lid", {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(batch),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        errors.push("batch failed (HTTP " + r.status + "): " + body.slice(0, 200));
      } else {
        written += batch.length;
      }
    } catch (e) {
      errors.push("batch threw: " + e.message);
    }
  }

  res.status(errors.length ? 207 : 200).json({
    ok: errors.length === 0,
    totalFetchedFromNWPS: gauges.length,
    totalWithCoords: rows.length,
    written,
    batches: batches.length,
    errors: errors.slice(0, 5), // capped so a fully-failed run doesn't blow up the response
  });
}
