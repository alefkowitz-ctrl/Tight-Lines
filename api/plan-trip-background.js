import { waitUntil } from "@vercel/functions";
import { Resend } from "resend";
import { SB_URL, SB_ANON, jwtSub, todayCount, getTier, PLAN_TIERS } from "./_lib/supabaseRest.js";
import { callAnthropicRaw } from "./_lib/anthropicCall.js";
import { runTripPlannerPipeline, filterFishableGauges, directionalSpread } from "../src/lib/tripPlannerPipeline.js";

// Same ceiling Vercel Hobby supports; Pro/Enterprise allow more but this is plenty —
// the full pipeline has run in the 2-4 minute range in on-screen testing.
export const maxDuration = 300;

const PLANNER_DAILY_LIMIT = 5; // same ledger (planner_reports rows) and same number as api/claude.js
const DEV_UNLIMITED = (process.env.VITE_DEV_UNLIMITED_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
const APP_URL = "https://www.guideschoicefishing.com"; // www required — bare domain 308-redirects

// ── Small, stable data-access utilities, intentionally duplicated rather than shared ──
// with src/App.jsx's own geocode/fetchWeather/fetchUSGSLive/etc. Those live in the
// browser bundle and serve several other tabs (Streams, GaugeChart...), so pulling them
// in here would mean touching far more of the app than this feature needs. These are
// deliberately simpler than the client's versions — most notably, the client's
// fetchUSGSLive tries USGS's new water-data API first with a legacy fallback; this just
// calls the legacy endpoint directly, which still carries live data for effectively all
// active gauges today (see GUIDES_CHOICE_CONTEXT.md's note on the USGS API migration
// timeline — legacy isn't retired until Q1 2027). If that gap ever matters in practice,
// promote these to shared USGS-access modules alongside tripPlannerPipeline.js.

function cfsLabel(cfs) {
  if (!cfs || isNaN(cfs)) return { label: "No Data", cls: "fair" };
  return { label: Math.round(cfs).toLocaleString() + " CFS", cls: "" };
}

async function fetchWeatherServer(lat, lng) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,surface_pressure,uv_index&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,surface_pressure_mean,uv_index_max,relative_humidity_2m_mean&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=7`;
  const r = await fetch(url);
  return r.json();
}

async function fetchUSGSLiveServer(lat, lng, radiusDeg) {
  const minLng = Math.round((lng - radiusDeg) * 10000) / 10000;
  const maxLng = Math.round((lng + radiusDeg) * 10000) / 10000;
  const minLat = Math.round((lat - radiusDeg) * 10000) / 10000;
  const maxLat = Math.round((lat + radiusDeg) * 10000) / 10000;
  const bbox = minLng + "," + minLat + "," + maxLng + "," + maxLat;
  try {
    const r = await fetch("https://waterservices.usgs.gov/nwis/iv/?format=json&bBox=" + bbox + "&parameterCd=00060&siteType=ST");
    if (r.ok) { const j = await r.json(); if (j && j.value && j.value.timeSeries) return j; }
  } catch { /* fall through to empty */ }
  return { value: { timeSeries: [] } };
}

// Flow-average baseline — duplicated from src/App.jsx's fetchFlowAvgBatch, same
// "intentionally duplicated small utility" pattern as the rest of this block (2026-08-12).
// Unlocks the "well below average"/"about average" flow language in background reports:
// this endpoint previously always passed flowAvgMap:{} into the pipeline, so every
// background report showed raw CFS with no comparison even though the on-screen path
// has had this since App Dev 23. Fails open to {} — the pipeline already degrades
// gracefully to raw CFS when a siteNo has no baseline.
const USGS_NW_SERVER = "https://api.waterdata.usgs.gov/ogcapi/v0/collections";
function nwSiteNoServer(id) { return String(id || "").replace(/^USGS-/, ""); }
function chunkArrServer(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }
async function fetchFlowAvgBatchServer(siteNos) {
  if (!siteNos || !siteNos.length) return {};
  const e = new Date(); e.setFullYear(e.getFullYear() - 1); e.setDate(e.getDate() + 5);
  const s = new Date(e); s.setDate(s.getDate() - 10);
  const iso = d => d.toISOString().split("T")[0] + "T00:00:00Z";
  const out = {};
  try {
    const chunks = chunkArrServer(siteNos.map(sn => "USGS-" + nwSiteNoServer(sn)), 100);
    for (const chunk of chunks) {
      const r = await fetch(USGS_NW_SERVER + "/daily/items?f=json&limit=10000&monitoring_location_id=" + chunk.join(",") + "&parameter_code=00060&statistic_id=00003&time=" + iso(s) + "/" + iso(e));
      if (!r.ok) continue;
      const d = await r.json();
      const sums = {}, counts = {};
      (d?.features || []).forEach(f => {
        const p = f.properties || {};
        const sn = nwSiteNoServer(p.monitoring_location_id);
        const v = parseFloat(p.value);
        if (sn && !isNaN(v) && v >= 0 && v < 500000) { sums[sn] = (sums[sn] || 0) + v; counts[sn] = (counts[sn] || 0) + 1; }
      });
      Object.keys(sums).forEach(sn => { out[sn] = sums[sn] / counts[sn]; });
    }
  } catch { /* fails open to {} */ }
  return out;
}

async function geocodePlacesServer(query) {
  try {
    const key = process.env.GOOGLE_PLACES_API_KEY;
    if (!key) return null;
    const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "places.location" },
      body: JSON.stringify({ textQuery: query, maxResultCount: 1 })
    });
    const d = await r.json();
    const p = (d.places || [])[0];
    if (!p || !p.location) return null;
    return { lat: p.location.latitude, lng: p.location.longitude };
  } catch { return null; }
}

// Same model-selection/tool-config/text-extraction logic as the client's askClaude —
// only the transport differs (direct Anthropic call here vs. browser fetch("/api/claude")
// there). Keep this in sync with askClaude in src/App.jsx if that ever changes.
async function askAIServer(prompt, useSearch = false, maxTokens = 1200, kind = "cheap", useFetch = false) {
  const body = { model: useSearch ? "claude-sonnet-4-6" : "claude-haiku-4-5-20251001", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] };
  if (useSearch) { body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }]; if (useFetch) body.tools.push({ type: "web_fetch_20250910", name: "web_fetch", max_uses: 3 }); }
  const d = await callAnthropicRaw(body);
  if (d.error) throw new Error(d.error.message || (typeof d.error === "string" ? d.error : "API error"));
  const texts = (d.content || []).map(b => b.type === "text" ? b.text : b.type === "tool_result" ? (Array.isArray(b.content) ? b.content.map(x => x.text || "").join("") : b.content || "") : "").filter(Boolean);
  return texts.join(" ");
}

// The user's JWT is captured when the request comes in, but the save happens 3+ minutes
// later — long enough that a token already near the end of its lifetime expires mid-job,
// which is exactly what was failing here (report generated fine, PATCH came back 4xx).
// The service-role key doesn't expire, so the delayed writes use it instead. It bypasses
// RLS entirely, so every service-role query below MUST scope by user_id itself — that
// safety is no longer being enforced by the database.
const SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// Returns true only if the row was actually confirmed updated. PostgREST returns a
// normal 200/204 "success" even when an UPDATE matches zero rows (e.g. an RLS policy
// silently filtering it out) — the earlier version of this function didn't check for
// that, so a save that silently didn't happen looked identical to one that did, and the
// email still went out pointing at a report with no data. return=representation lets us
// tell the difference: an empty array means nothing was actually updated.
// Scoped by BOTH id and user_id: with the service-role key there's no RLS backstop, so
// this query is the only thing preventing a bad rowId from touching another user's row.
async function patchReport(rowId, userId, fields) {
  try {
    const key = SB_SERVICE || SB_ANON;
    const r = await fetch(SB_URL + "/rest/v1/planner_reports?id=eq." + rowId + "&user_id=eq." + userId, {
      method: "PATCH",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(fields)
    });
    if (!r.ok) { console.error("[plan-trip-background] patchReport HTTP " + r.status, await r.text().catch(() => "")); return false; }
    const d = await r.json().catch(() => null);
    if (!Array.isArray(d) || !d[0]) { console.error("[plan-trip-background] patchReport matched 0 rows for id " + rowId); return false; }
    return true;
  } catch (e) {
    console.error("[plan-trip-background] patchReport threw", e && e.message);
    return false;
  }
}

function firstSentence(text, maxLen = 220) {
  const s = String(text || "").trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1).trim() + "…";
}

async function sendReportEmail(resend, toEmail, label, dateStr, report, rowId) {
  const link = APP_URL + "/?report=" + encodeURIComponent(rowId) + "&tab=plan";
  const teaser = firstSentence(report.recommendation || report.overview || "Your report is ready.");
  const html = `
    <div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;color:#2a2a24;">
      <h2 style="color:#4A5A3F;margin-bottom:4px;">Your fishing report is ready</h2>
      <p style="color:#6b6b60;margin-top:0;">${label} — ${dateStr}</p>
      <p style="line-height:1.5;">${teaser}</p>
      <a href="${link}" style="display:inline-block;background:#d09a4a;color:#0c1e25;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;margin:16px 0;">View Full Report</a>
      <p style="color:#8a8a80;font-size:13px;">This link opens the report in Guide's Choice — sign in if you're not already.</p>
    </div>`;
  await resend.emails.send({
    from: "Guide's Choice <reports@mail.guideschoicefishing.com>",
    to: toEmail,
    subject: "Your " + label + " fishing report is ready",
    html
  });
}

async function sendFailureEmail(resend, toEmail, label) {
  const html = `
    <div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;color:#2a2a24;">
      <h2 style="color:#4A5A3F;">We couldn't finish your report</h2>
      <p style="line-height:1.5;">Something went wrong generating your ${label} fishing report. This didn't use up one of today's reports — feel free to try again from the app.</p>
    </div>`;
  await resend.emails.send({
    from: "Guide's Choice <reports@mail.guideschoicefishing.com>",
    to: toEmail,
    subject: "Your " + label + " fishing report hit a snag",
    html
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: { message: "Method not allowed" } });

  const jwt = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return res.status(401).json({ error: { message: "Please sign in to use AI features." } });

  const { label, lat, lng, date, driveMinutes, notifyEmail } = req.body || {};
  if (lat == null || lng == null || !label) return res.status(400).json({ error: { message: "Missing location." } });
  if (!notifyEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(notifyEmail))) return res.status(400).json({ error: { message: "A valid email address is required." } });
  if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: { message: "Email delivery isn't configured yet." } });
  if (!SB_SERVICE) console.warn("[plan-trip-background] SUPABASE_SERVICE_ROLE_KEY is not set — falling back to the user's JWT, which will likely expire mid-job and fail to save the finished report.");

  // Trip Planner reports are a paid feature (Consumer Pro and up). The on-screen path
  // enforces this before this same background job kicks off, but a request straight to
  // this endpoint (e.g. "Email It To Me Instead" with a free-tier session, or a direct
  // call bypassing the UI) needs its own check — the UI gate alone is not enforcement.
  // Fails open (allows the job to proceed) only on a genuine "can't tell" Supabase
  // hiccup — a definite "free" or "canceled" answer always blocks.
  const exempt = DEV_UNLIMITED.length > 0 && DEV_UNLIMITED.includes(jwtSub(jwt) || "");
  if (!exempt) {
    const tierGate = await getTier(jwt);
    if (tierGate.auth === false) return res.status(401).json({ error: { message: "Your session expired — please sign in again." } });
    if (tierGate.tier != null && !PLAN_TIERS.has(tierGate.tier)) {
      return res.status(403).json({ error: { message: "The AI Trip Planner is a Consumer Pro feature. Upgrade to generate trip reports." } });
    }
  }

  // Same rate-limit gate as the on-screen path, same ledger table.
  const gate = await todayCount("planner_reports", jwt);
  if (gate.auth === false) return res.status(401).json({ error: { message: "Your session expired — please sign in again." } });
  if (!exempt && gate.count != null && gate.count >= PLANNER_DAILY_LIMIT) {
    return res.status(429).json({ error: { message: "You've reached today's limit of " + PLANNER_DAILY_LIMIT + " trip reports. The limit resets daily." } });
  }

  // Reserve the credit immediately by inserting the row now (status=processing) —
  // matches the existing pattern where the saved row itself IS the rate-limit ledger.
  const reportDate = new Date().toISOString().split("T")[0];
  let rowId, rowUserId;
  try {
    const insRes = await fetch(SB_URL + "/rest/v1/planner_reports", {
      method: "POST",
      headers: { apikey: SB_ANON, Authorization: "Bearer " + jwt, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ report_date: reportDate, loc_label: label, lat, lng, status: "processing", notify_email: notifyEmail, payload: null })
    });
    const insData = await insRes.json();
    if (!insRes.ok || !Array.isArray(insData) || !insData[0]) {
      const detail = (insData && (insData.message || insData.hint || insData.details)) || ("HTTP " + insRes.status);
      return res.status(500).json({ error: { message: "Couldn't start the report — " + detail } });
    }
    rowId = insData[0].id;
    // Read the owner back off the inserted row rather than trusting the JWT's claim —
    // this is the value the service-role writes below scope against, and it's what the
    // database itself recorded as the owner.
    rowUserId = insData[0].user_id || jwtSub(jwt);
  } catch (e) {
    return res.status(500).json({ error: { message: "Couldn't start the report — " + (e && e.message || "unknown error") } });
  }

  // Respond now — the popup shows "we'll email you" and the tab can be closed. Everything
  // below continues running on Fluid Compute after the response is sent.
  res.status(200).json({ ok: true, reportId: rowId });

  waitUntil((async () => {
    const resend = new Resend(process.env.RESEND_API_KEY);
    try {
      const [wx, usgs0] = await Promise.all([
        fetchWeatherServer(lat, lng),
        fetchUSGSLiveServer(lat, lng, 2)
      ]);
      const liveTS0 = (usgs0 && usgs0.value && usgs0.value.timeSeries) || [];
      let pgScaled = liveTS0.map(t => {
        const raw = t.values && t.values[0] && t.values[0].value && t.values[0].value[0] && t.values[0].value[0].value;
        const cfs = raw != null ? parseFloat(raw) : null;
        const { label: cfsLbl, cls } = cfsLabel(cfs);
        const siteNo = (t.sourceInfo && t.sourceInfo.siteCode && t.sourceInfo.siteCode[0] && t.sourceInfo.siteCode[0].value) || "";
        const siteLat = parseFloat((t.sourceInfo && t.sourceInfo.geoLocation && t.sourceInfo.geoLocation.geogLocation && t.sourceInfo.geoLocation.geogLocation.latitude) || 0);
        const siteLng = parseFloat((t.sourceInfo && t.sourceInfo.geoLocation && t.sourceInfo.geoLocation.geogLocation && t.sourceInfo.geoLocation.geogLocation.longitude) || 0);
        const dist = Math.sqrt(Math.pow(siteLat - lat, 2) + Math.pow(siteLng - lng, 2));
        return { name: (t.sourceInfo && t.sourceInfo.siteName) || "Unknown", cfs, label: cfsLbl, cls, siteNo, dist, lat: siteLat, lng: siteLng };
      }).filter(s => s.cfs != null && s.cfs >= 0 && s.cfs < 500000).sort((a, b) => a.dist - b.dist);
      pgScaled = directionalSpread([...pgScaled.filter(s => s.cfs >= 15), ...pgScaled.filter(s => s.cfs < 15)], 40, lat, lng);

      const ds = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

      const gSiteNos = filterFishableGauges(pgScaled, lat, lng).map(g => g.siteNo);

      let savedGauges = [];
      let flowAvgMap = {};
      try {
        const sgKey = SB_SERVICE || SB_ANON;
        const sgUrl = SB_SERVICE
          ? SB_URL + "/rest/v1/saved_gauges?select=*&user_id=eq." + rowUserId  // service-role bypasses RLS — scope explicitly
          : SB_URL + "/rest/v1/saved_gauges?select=*";                          // anon+JWT: RLS scopes it
        const [sgRes, fam] = await Promise.all([
          fetch(sgUrl, { headers: { apikey: sgKey, Authorization: "Bearer " + (SB_SERVICE || jwt) } }),
          fetchFlowAvgBatchServer(gSiteNos).catch(() => ({}))
        ]);
        if (sgRes.ok) savedGauges = await sgRes.json();
        flowAvgMap = fam;
      } catch { /* home-waters note just won't include anything — non-critical; flow-avg fails open too */ }

      // pTempMap (water-temp batch) is still NOT computed server-side — separate from this
      // round's fix, affects thermal-risk wording specifically, not the flow-average work.
      // Flagged as its own open item rather than folded in silently.
      const aiCtx = { askAI: askAIServer, geocodePlaces: geocodePlacesServer };

      const report = await runTripPlannerPipeline(
        { loc: { label, lat, lng }, ds, driveMinutes: driveMinutes || 120, wx, pgScaled, savedGauges, pTempMap: {}, flowAvgMap, thorough: true },
        aiCtx,
        null // no onStep — nobody's watching a background job's progress
      );

      const payload = { v: 1, ts: Date.now(), loc: { label, lat, lng }, date, wxData: wx, gauges: pgScaled, report };
      const saved = await patchReport(rowId, rowUserId, { status: "complete", payload });
      if (!saved) throw new Error("Report finished but couldn't be saved — check the planner_reports UPDATE policy in Supabase.");
      await sendReportEmail(resend, notifyEmail, label, ds, report, rowId);
    } catch (e) {
      await patchReport(rowId, rowUserId, { status: "failed", error_message: String((e && e.message) || e).slice(0, 500) });
      try { await sendFailureEmail(resend, notifyEmail, label); } catch { /* best effort */ }
    }
  })());
}
