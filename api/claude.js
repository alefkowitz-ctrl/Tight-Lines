export const maxDuration = 120; // shop-report searches with page reads legitimately need >60s

// ---- Daily per-user rate limits (server-enforced) ----
// Planner runs are counted via saved rows in planner_reports (the report IS the ledger).
// Cheap calls (fish ID, shop curation, CRM summaries, conditions) log one ai_usage row each.
// Counting is by UTC day. The Supabase anon key is public by design (it ships in the app
// bundle); RLS scopes every query to the calling user's own rows.
const PLANNER_DAILY_LIMIT = 5;
const CHEAP_DAILY_LIMIT = 50;
// Accounts exempt from daily limits (the dev's own testing). Configured as a Vercel
// env var (comma-separated Supabase user UUIDs) so no ID lives in the public repo.
const DEV_UNLIMITED = (process.env.VITE_DEV_UNLIMITED_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
function jwtSub(jwt){ try { return JSON.parse(Buffer.from(String(jwt).split(".")[1] || "", "base64").toString("utf8")).sub || null; } catch (e) { return null; } }
const SB_URL = "https://geqcnlrwkwicavwixvdn.supabase.co";
const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdlcWNubHJ3a3dpY2F2d2l4dmRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwOTcyNjIsImV4cCI6MjA5MzY3MzI2Mn0.R2IKRDFT0P0vrXKEfcuSv54TDAiiBK0LbQPHiilanjM";

// Count the caller's rows in `table` created today (UTC). Uses the caller's own JWT,
// so RLS guarantees we only ever count their rows. Returns:
//   { auth:false }            -> token invalid/expired
//   { auth:true, count:null } -> Supabase hiccup; treat as unknown (fail open)
//   { auth:true, count:N }
async function todayCount(table, jwt) {
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
async function logUsage(jwt, kind) {
  try {
    await fetch(SB_URL + "/rest/v1/ai_usage", {
      method: "POST",
      headers: { apikey: SB_ANON, Authorization: "Bearer " + jwt, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ kind })
    });
  } catch (e) { /* usage logging must never break the app */ }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Google Places — closest fly shops (GOOGLE_PLACES_API_KEY from Vercel env). Errors are returned, never hidden.
  if (req.body?.places) {
    try {
      const { lat, lng } = req.body;
      const key = process.env.GOOGLE_PLACES_API_KEY;
      if (!key) return res.status(200).json({ shops: [], placesError: "GOOGLE_PLACES_API_KEY not set" });
      const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location,places.rating,places.nationalPhoneNumber,places.websiteUri"
        },
        body: JSON.stringify({
          textQuery: "fly fishing shop",
          locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 48000.0 } },
          rankPreference: "DISTANCE",
          maxResultCount: 10
        })
      });
      const d = await r.json();
      if (d.error) return res.status(200).json({ shops: [], placesError: (d.error.message || JSON.stringify(d.error)).slice(0, 200) });
      const shops = (d.places || []).map(p => {
        const plat = p.location && p.location.latitude, plng = p.location && p.location.longitude;
        const dist = (plat && plng) ? Math.round(Math.sqrt(Math.pow(plat - lat, 2) + Math.pow(plng - lng, 2)) * 69) : 0;
        return { name: (p.displayName && p.displayName.text) || "", address: p.formattedAddress || "", city: "", state: "", phone: p.nationalPhoneNumber || "", website: p.websiteUri || "", rating: p.rating || null, distanceMiles: dist };
      }).filter(s => s.name).sort((a, b) => (a.distanceMiles || 999) - (b.distanceMiles || 999));
      return res.status(200).json({ shops });
    } catch (e) { return res.status(200).json({ shops: [], placesError: e.message }); }
  }
  
  // Isochrone proxy
  if (req.body?.isochrone) {
    try {
      const { lat, lng, minutes } = req.body;
      const r = await fetch("https://api.openrouteservice.org/v2/isochrones/driving-car", {
        method: "POST",
        headers: {"Content-Type":"application/json","Authorization":"5b3ce3597851110001cf62486e3b30a0a05047e19c9b3543a4e28e6c"},
        body: JSON.stringify({locations:[[lng,lat]],range:[minutes*60],range_type:"time"})
      });
      const data = await r.json();
      return res.status(200).json(data);
    } catch(e) {
      return res.status(500).json({error: e.message});
    }
  }

  // usage_kind is our own field — it must be stripped before forwarding to Anthropic
  const { proxy_url, usage_kind, ...body } = req.body;

  // Proxy mode: forward to CORS-blocked external URLs (DWR, etc.)
  if (proxy_url) {
    try {
      const r = await fetch(proxy_url);
      const data = await r.json();
      return res.status(200).json(data);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ---- Rate-limit gate: applies ONLY to Anthropic calls (the ones that cost money) ----
  const jwt = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return res.status(401).json({ error: { message: "Please sign in to use AI features." } });
  const kind = usage_kind === "planner" ? "planner" : "cheap";
  const table = kind === "planner" ? "planner_reports" : "ai_usage";
  const limit = kind === "planner" ? PLANNER_DAILY_LIMIT : CHEAP_DAILY_LIMIT;
  const exempt = DEV_UNLIMITED.length > 0 && DEV_UNLIMITED.includes(jwtSub(jwt) || "");
  const gate = await todayCount(table, jwt);
  if (gate.auth === false) return res.status(401).json({ error: { message: "Your session expired — please sign in again." } });
  if (!exempt && gate.count != null && gate.count >= limit) {
    return res.status(429).json({ error: { message: kind === "planner"
      ? "You've reached today's limit of " + PLANNER_DAILY_LIMIT + " trip reports. Reports you already ran today are saved in the planner — tap one to reopen it. The limit resets daily."
      : "You've reached today's AI usage limit. It resets daily." } });
  }
  if (kind !== "planner") await logUsage(jwt, kind);

  // Anthropic API — handles both plain and web-search tool calls
  try {
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "web-fetch-2025-09-10"
    };

    // First call
    let response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    let data = await response.json();

    // web_search is a SERVER-side tool: results arrive in the same response.
    // Long searches pause with stop_reason "pause_turn" — continue them until done.
    let iterations = 0;
    while (data && data.stop_reason === "pause_turn" && iterations < 8) {
      iterations++;
      const messages = [
        ...(body.messages || []),
        { role: "assistant", content: data.content }
      ];
      response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers,
        body: JSON.stringify({ ...body, messages })
      });
      data = await response.json();
    }

    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
