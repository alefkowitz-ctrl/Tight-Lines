import { SB_URL, SB_ANON, jwtSub, todayCount, logUsage, getTier, PLAN_TIERS } from "./_lib/supabaseRest.js";
import { callAnthropicRaw } from "./_lib/anthropicCall.js";

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
  
  // River geocode — Places text search used by finalizeLabRivers fallback.
  // No auth gate: no AI cost. Returns {lat, lng} or {geocodeError}.
  if (req.body?.geocode) {
    try {
      const { query } = req.body;
      const key = process.env.GOOGLE_PLACES_API_KEY;
      if (!key) return res.status(200).json({ geocodeError: "GOOGLE_PLACES_API_KEY not set" });
      const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location"
        },
        body: JSON.stringify({ textQuery: query, maxResultCount: 1 })
      });
      const d = await r.json();
      if (d.error) return res.status(200).json({ geocodeError: (d.error.message || "Places error").slice(0, 200) });
      const p = (d.places || [])[0];
      if (!p?.location) return res.status(200).json({ geocodeError: "No result" });
      return res.status(200).json({ lat: p.location.latitude, lng: p.location.longitude });
    } catch (e) { return res.status(200).json({ geocodeError: e.message }); }
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
  // Trip Planner reports are a paid feature (Consumer Pro and up). The client already
  // hides the Plan tab behind PLAN_TIERS, but that's UI only — without this check,
  // anyone with a valid session (even free tier) could call this endpoint directly with
  // usage_kind:"planner" and get free reports. Fails open (allows the call through)
  // only on a genuine "can't tell" Supabase hiccup — a definite "free" or "canceled"
  // answer always blocks. Dev-exempt accounts skip this, same as the rate limit below.
  if (kind === "planner" && !exempt) {
    const tierGate = await getTier(jwt);
    if (tierGate.auth === false) return res.status(401).json({ error: { message: "Your session expired — please sign in again." } });
    if (tierGate.tier != null && !PLAN_TIERS.has(tierGate.tier)) {
      return res.status(403).json({ error: { message: "The AI Trip Planner is a Consumer Pro feature. Upgrade to generate trip reports." } });
    }
  }
  const gate = await todayCount(table, jwt);
  if (gate.auth === false) return res.status(401).json({ error: { message: "Your session expired — please sign in again." } });
  if (!exempt && gate.count != null && gate.count >= limit) {
    return res.status(429).json({ error: { message: kind === "planner"
      ? "You've reached today's limit of " + PLANNER_DAILY_LIMIT + " trip reports. Reports you already ran today are saved in the planner — tap one to reopen it. The limit resets daily."
      : "You've reached today's AI usage limit. It resets daily." } });
  }
  // NOTE: the usage row is written AFTER the call below, not here. Logging first meant
  // any failure that never produced a result — empty API credit balance, expired key,
  // Anthropic 5xx — still spent a unit of the user's 50/day allowance. During an outage
  // that silently drained a full day's quota on calls that returned nothing, on top of
  // the outage itself. Anthropic doesn't bill failed requests; neither should this.
  // Trade-off accepted: a burst of simultaneous calls can now slip a few over the limit,
  // since none of them have logged yet when the next one checks the count. That's a
  // rounding error on a 50/day cap, and far cheaper than charging users for downtime.

  // Anthropic API — handles both plain and web-search tool calls
  try {
    const data = await callAnthropicRaw(body);
    // callAnthropicRaw returns Anthropic's body as-is and does not throw on an API-level
    // error, so a failure arrives here as data.error rather than an exception — check for
    // it explicitly instead of assuming arrival means success. Awaited before responding:
    // a serverless function can be frozen the moment it replies, which would cut off a
    // fire-and-forget write. logUsage already swallows its own errors.
    if (kind !== "planner" && !(data && data.error)) await logUsage(jwt, kind);
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
