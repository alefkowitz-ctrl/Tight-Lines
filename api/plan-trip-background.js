import { waitUntil } from "@vercel/functions";
import { Resend } from "resend";
import { SB_URL, SB_ANON, jwtSub, todayCount } from "./_lib/supabaseRest.js";
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

async function patchReport(rowId, jwt, fields) {
  try {
    await fetch(SB_URL + "/rest/v1/planner_reports?id=eq." + rowId, {
      method: "PATCH",
      headers: { apikey: SB_ANON, Authorization: "Bearer " + jwt, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(fields)
    });
  } catch (e) { /* best effort — the row staying "processing" forever is a visible-enough symptom to debug from later */ }
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

  // Same rate-limit gate as the on-screen path, same ledger table.
  const gate = await todayCount("planner_reports", jwt);
  if (gate.auth === false) return res.status(401).json({ error: { message: "Your session expired — please sign in again." } });
  const exempt = DEV_UNLIMITED.length > 0 && DEV_UNLIMITED.includes(jwtSub(jwt) || "");
  if (!exempt && gate.count != null && gate.count >= PLANNER_DAILY_LIMIT) {
    return res.status(429).json({ error: { message: "You've reached today's limit of " + PLANNER_DAILY_LIMIT + " trip reports. The limit resets daily." } });
  }

  // Reserve the credit immediately by inserting the row now (status=processing) —
  // matches the existing pattern where the saved row itself IS the rate-limit ledger.
  const reportDate = new Date().toISOString().split("T")[0];
  let rowId;
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

      let savedGauges = [];
      try {
        const sgRes = await fetch(SB_URL + "/rest/v1/saved_gauges?select=*", { headers: { apikey: SB_ANON, Authorization: "Bearer " + jwt } });
        if (sgRes.ok) savedGauges = await sgRes.json();
      } catch { /* home-waters note just won't include anything — non-critical */ }

      const aiCtx = { askAI: askAIServer, geocodePlaces: geocodePlacesServer };

      const report = await runTripPlannerPipeline(
        { loc: { label, lat, lng }, ds, driveMinutes: driveMinutes || 120, wx, pgScaled, savedGauges, pTempMap: {}, flowAvgMap: {} },
        aiCtx,
        null // no onStep — nobody's watching a background job's progress
      );

      const payload = { v: 1, ts: Date.now(), loc: { label, lat, lng }, date, wxData: wx, gauges: pgScaled, report };
      await patchReport(rowId, jwt, { status: "complete", payload });
      await sendReportEmail(resend, notifyEmail, label, ds, report, rowId);
    } catch (e) {
      await patchReport(rowId, jwt, { status: "failed", error_message: String((e && e.message) || e).slice(0, 500) });
      try { await sendFailureEmail(resend, notifyEmail, label); } catch { /* best effort */ }
    }
  })());
}
