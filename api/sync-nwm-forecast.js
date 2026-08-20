// Multi-day NWM (National Water Model) forecast sync — SPEC_streamflow_forecast.md,
// Phase 4. Companion to gaugeSources.js's fetchNWMStreamflow(), which gives current
// conditions for any reach on demand; this gives a forward-looking outlook, which can't
// be fetched live per-request (see below), so it's synced on a schedule instead — same
// shape as sync-nwps-gauges.js.
//
// Why this can't be a live per-request fetch, tested directly 2026-08-19: NOAA's raw
// forecast files are ~12.4MB each, one per forecast hour, hosted on AWS
// (noaa-nwm-pds.s3.amazonaws.com) rather than served through any query API — there's no
// "give me hour 72 for reach X" endpoint, only whole-file downloads covering all 2.77M
// reaches per file. Parsing them turned out to be fast and reliable (confirmed directly:
// ~7s total to download 3 files in parallel and extract two known reaches, using
// h5wasm — a WASM HDF5 reader, so no native compilation, which matters since this
// deploys to Vercel) — but "fast" here is single-digit seconds, still far too slow to
// do inline while someone's waiting on a page to load.
//
// Vercel Hobby plan constraints that directly shaped this design (confirmed via Vercel's
// own docs, 2026-08-19 — don't assume these without checking, they change):
//   - Cron jobs: max ONCE PER DAY on Hobby. Every-6-hours (matching NWM's own publish
//     cadence) is not available without upgrading to Pro. This is why the outlook
//     refreshes once daily, not every cycle.
//   - Function execution: 60s hard ceiling on Hobby. Confirmed real timing: downloading
//     5 files in parallel + parsing them sequentially fits well inside that (the 3-file
//     test above took ~7s; 5 files scales roughly linearly and stays well under budget).
//
// Outlook is 5 days out, at daily resolution (forecast hours 24/48/72/96/120) — a
// practical "next few days" view for trip planning, not the full hourly resolution NOAA
// publishes, which would mean far more files than the time/data budget allows or a
// fishing forecast needs.
//
// Tracked reaches come from nwm_tracked_reaches (see nwm_forecast_schema.sql) — seeded
// manually for now with the reaches tested tonight. A follow-up phase can make this
// self-populate from real trip-planner/saved-gauge activity; deliberately not built in
// this same session, to ship one complete, correct slice rather than two half-built
// ones. If that table is empty, this job has nothing to do and exits cleanly.
//
// Uses SUPABASE_SERVICE_ROLE_KEY, same as sync-nwps-gauges.js, for the same reason: a
// privileged bulk write, not a user-scoped one.
//
// Callable two ways, also same as sync-nwps-gauges.js: (1) Vercel Cron on the schedule
// in vercel.json, (2) manually by visiting the URL, which is how to run the first sync
// right after deploying — Cron does not fire immediately on deploy.

import { SB_URL } from "./_lib/supabaseRest.js";
import * as hdf5 from "h5wasm";

const NWM_BUCKET = "https://noaa-nwm-pds.s3.amazonaws.com";
const FORECAST_HOURS = [24, 48, 72, 96, 120]; // 5-day outlook, daily resolution
const CMS_TO_CFS = 35.3147;
const MAX_CYCLE_ATTEMPTS = 6; // walk backward through up to 6 cycles (36h) looking for one that's fully published

function pad2(n) { return String(n).padStart(2, "0"); }
function pad3(n) { return String(n).padStart(3, "0"); }

// NWM cycles run at 00/06/12/18 UTC. Returns [{dateStr, hourStr}] for the most recent
// cycle first, walking backward — used to find a cycle whose files have actually
// finished publishing (outer forecast hours publish hours after the cycle nominally
// starts; confirmed directly: a t00z cycle's f024 file wasn't ready until 06:27 UTC,
// six and a half hours later).
function candidateCycles(count) {
  const out = [];
  const now = new Date();
  let d = new Date(now);
  let h = Math.floor(d.getUTCHours() / 6) * 6;
  for (let i = 0; i < count; i++) {
    out.push({ dateStr: d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()), hourStr: pad2(h) });
    h -= 6;
    if (h < 0) { h = 18; d = new Date(d.getTime() - 24 * 3600 * 1000); }
  }
  return out;
}

function fileUrl(dateStr, hourStr, fhour) {
  return `${NWM_BUCKET}/nwm.${dateStr}/medium_range_blend/nwm.t${hourStr}z.medium_range_blend.channel_rt.f${pad3(fhour)}.conus.nc`;
}

async function cycleIsReady(dateStr, hourStr) {
  // Furthest-out file publishes last — if it exists, the whole cycle is ready.
  try {
    const r = await fetch(fileUrl(dateStr, hourStr, FORECAST_HOURS[FORECAST_HOURS.length - 1]), { method: "HEAD" });
    return r.ok;
  } catch { return false; }
}

async function extractReaches(buffer, reachIds) {
  const vname = "f_" + Math.random().toString(36).slice(2) + ".nc";
  hdf5.FS.writeFile(vname, buffer);
  try {
    const f = new hdf5.File(vname, "r");
    const sfVar = f.get("streamflow");
    const featureIds = f.get("feature_id").value;
    const streamflow = sfVar.value;
    const scale = sfVar.attrs.scale_factor.value[0];
    const idx = new Map();
    for (let i = 0; i < featureIds.length; i++) idx.set(featureIds[i], i);
    const out = {};
    for (const id of reachIds) {
      const i = idx.get(BigInt(id));
      out[id] = i !== undefined ? streamflow[i] * scale * CMS_TO_CFS : null;
    }
    f.close();
    return out;
  } finally {
    try { hdf5.FS.unlink(vname); } catch {}
  }
}

export default async function handler(req, res) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    res.status(500).json({ ok: false, error: "SUPABASE_SERVICE_ROLE_KEY not set" });
    return;
  }

  await hdf5.ready;

  // 1. Which reaches do we need a forecast for?
  let reachIds;
  try {
    const r = await fetch(SB_URL + "/rest/v1/nwm_tracked_reaches?select=reach_id", {
      headers: { apikey: key, Authorization: "Bearer " + key },
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const rows = await r.json();
    reachIds = rows.map((row) => row.reach_id);
  } catch (e) {
    res.status(502).json({ ok: false, error: "Could not read nwm_tracked_reaches: " + e.message });
    return;
  }
  if (!reachIds.length) {
    res.status(200).json({ ok: true, note: "nwm_tracked_reaches is empty — nothing to sync." });
    return;
  }

  // 2. Find the most recent cycle that's actually finished publishing.
  const candidates = candidateCycles(MAX_CYCLE_ATTEMPTS);
  let chosen = null;
  for (const c of candidates) {
    if (await cycleIsReady(c.dateStr, c.hourStr)) { chosen = c; break; }
  }
  if (!chosen) {
    res.status(502).json({ ok: false, error: `No published NWM cycle found in the last ${MAX_CYCLE_ATTEMPTS * 6}h.` });
    return;
  }
  const cycleTime = `${chosen.dateStr.slice(0,4)}-${chosen.dateStr.slice(4,6)}-${chosen.dateStr.slice(6,8)}T${chosen.hourStr}:00:00Z`;

  // 3. Download all 5 checkpoint files in parallel, parse sequentially (h5wasm's
  // virtual filesystem makes true parallel parsing risky within one process).
  let buffers;
  try {
    buffers = await Promise.all(
      FORECAST_HOURS.map(async (fh) => {
        const r = await fetch(fileUrl(chosen.dateStr, chosen.hourStr, fh));
        if (!r.ok) throw new Error(`fh${fh}: HTTP ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      })
    );
  } catch (e) {
    res.status(502).json({ ok: false, error: "Download failed: " + e.message, cycle: chosen }); 
    return;
  }

  const today = new Date(`${chosen.dateStr.slice(0,4)}-${chosen.dateStr.slice(4,6)}-${chosen.dateStr.slice(6,8)}T00:00:00Z`);
  const rows = [];
  for (let i = 0; i < FORECAST_HOURS.length; i++) {
    const dayOut = i + 1;
    const values = await extractReaches(buffers[i], reachIds);
    const validDate = new Date(today.getTime() + FORECAST_HOURS[i] * 3600 * 1000).toISOString().slice(0, 10);
    for (const id of reachIds) {
      rows.push({
        reach_id: id,
        forecast_day: dayOut,
        cfs: values[id],
        valid_date: validDate,
        cycle_time: cycleTime,
        updated_at: new Date().toISOString(),
      });
    }
  }

  // 4. Upsert into the cache.
  let written = 0;
  const errors = [];
  try {
    const r = await fetch(SB_URL + "/rest/v1/nwm_forecast_cache?on_conflict=reach_id,forecast_day", {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      errors.push("upsert failed (HTTP " + r.status + "): " + body.slice(0, 300));
    } else {
      written = rows.length;
    }
  } catch (e) {
    errors.push("upsert threw: " + e.message);
  }

  res.status(errors.length ? 207 : 200).json({
    ok: errors.length === 0,
    cycle: chosen,
    reachesTracked: reachIds.length,
    rowsWritten: written,
    errors,
  });
}
