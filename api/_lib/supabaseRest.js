// Shared Supabase REST helpers for server-side (Vercel function) code. Single source of
// truth for the rate-limit gate and usage logging — used by both api/claude.js (the
// per-call browser proxy) and api/plan-trip-background.js (the background trip planner),
// so the daily-limit logic can't drift between the two entry points that both spend AI
// budget on the user's behalf.
export const SB_URL = "https://geqcnlrwkwicavwixvdn.supabase.co";
export const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdlcWNubHJ3a3dpY2F2d2l4dmRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwOTcyNjIsImV4cCI6MjA5MzY3MzI2Mn0.R2IKRDFT0P0vrXKEfcuSv54TDAiiBK0LbQPHiilanjM";

export function jwtSub(jwt) { try { return JSON.parse(Buffer.from(String(jwt).split(".")[1] || "", "base64").toString("utf8")).sub || null; } catch (e) { return null; } }

// Count the caller's rows in `table` created today (UTC). Uses the caller's own JWT,
// so RLS guarantees we only ever count their rows. Returns:
//   { auth:false }            -> token invalid/expired
//   { auth:true, count:null } -> Supabase hiccup; treat as unknown (fail open)
//   { auth:true, count:N }
export async function todayCount(table, jwt) {
  try {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const r = await fetch(SB_URL + "/rest/v1/" + table + "?select=id&created_at=gte." + since.toISOString(), {
      headers: { apikey: SB_ANON, Authorization: "Bearer " + jwt, Prefer: "count=exact", Range: "0-0" }
    });
    if (r.status === 401 || r.status === 403) {
      // Distinguish a real auth failure from a table-permission problem (42501).
      // A grants/config mistake must FAIL OPEN — never lock users out of AI features
      // with a misleading "session expired" message.
      let code = "";
      try { const b = await r.json(); code = (b && b.code) || ""; } catch (e) { /* no body */ }
      if (code === "42501") return { auth: true, count: null };
      return { auth: false };
    }
    if (!r.ok && r.status !== 206) return { auth: true, count: null };
    const cr = r.headers.get("content-range") || "";
    const total = parseInt(cr.split("/")[1], 10);
    return { auth: true, count: isNaN(total) ? null : total };
  } catch (e) {
    return { auth: true, count: null };
  }
}

// Log one cheap-call usage row. Awaited but never blocks the AI call on failure.
export async function logUsage(jwt, kind) {
  try {
    await fetch(SB_URL + "/rest/v1/ai_usage", {
      method: "POST",
      headers: { apikey: SB_ANON, Authorization: "Bearer " + jwt, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ kind })
    });
  } catch (e) { /* usage logging must never break the app */ }
}

// Mirrors PLAN_TIERS in src/App.jsx exactly. Kept here as the single server-side
// source of truth so api/claude.js and api/plan-trip-background.js can't drift apart
// from each other, or from the client's own paywall gate.
export const PLAN_TIERS = new Set(["consumer_pro", "guide_pro", "fly_shop_basic", "fly_shop_pro"]);

// Look up the caller's subscription tier — same table, same columns, same "no row /
// canceled / expired comp -> free" rules as the client's own refreshTier in App.jsx,
// so server-side enforcement can never disagree with what the UI already shows. Uses
// the caller's own JWT; RLS scopes the query to their own row, same trust model as
// todayCount above. Returns:
//   { auth:false }            -> token invalid/expired
//   { auth:true, tier:null }  -> Supabase hiccup; unknown — caller should fail OPEN
//                                 (allow the call) rather than block a possible payer
//   { auth:true, tier:"free"|"consumer_pro"|"guide_pro"|"fly_shop_basic"|"fly_shop_pro" }
export async function getTier(jwt) {
  try {
    const r = await fetch(SB_URL + "/rest/v1/subscriptions?select=tier,status,is_comped,current_period_end", {
      headers: { apikey: SB_ANON, Authorization: "Bearer " + jwt }
    });
    if (r.status === 401 || r.status === 403) {
      let code = "";
      try { const b = await r.json(); code = (b && b.code) || ""; } catch (e) { /* no body */ }
      if (code === "42501") return { auth: true, tier: null };
      return { auth: false };
    }
    if (!r.ok) return { auth: true, tier: null };
    const rows = await r.json();
    const data = Array.isArray(rows) ? rows[0] : null;
    if (!data || data.status === "canceled") return { auth: true, tier: "free" };
    if (data.is_comped && data.current_period_end && new Date(data.current_period_end) < new Date()) return { auth: true, tier: "free" };
    return { auth: true, tier: data.tier || "free" };
  } catch (e) {
    return { auth: true, tier: null };
  }
}
