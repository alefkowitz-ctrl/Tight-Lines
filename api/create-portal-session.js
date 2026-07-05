const SB_URL = "https://geqcnlrwkwicavwixvdn.supabase.co";
const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdlcWNubHJ3a3dpY2F2d2l4dmRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwOTcyNjIsImV4cCI6MjA5MzY3MzI2Mn0.R2IKRDFT0P0vrXKEfcuSv54TDAiiBK0LbQPHiilanjM";

export const maxDuration = 30;

function jwtClaims(jwt) {
  try { return JSON.parse(Buffer.from(String(jwt).split(".")[1] || "", "base64").toString("utf8")); }
  catch (e) { return null; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: { message: "Method not allowed" } });

  const jwt = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return res.status(401).json({ error: { message: "Please sign in to manage your subscription." } });

  const claims = jwtClaims(jwt);
  const userId = claims?.sub;
  if (!userId) return res.status(401).json({ error: { message: "Your session expired — please sign in again." } });

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return res.status(500).json({ error: { message: "Payments are not configured yet." } });

  try {
    // Looked up with the caller's own JWT (not service_role) — RLS already permits a user
    // to read their own subscriptions row, so no elevated key is needed for this lookup.
    const subRes = await fetch(
      SB_URL + "/rest/v1/subscriptions?select=stripe_customer_id&user_id=eq." + encodeURIComponent(userId),
      { headers: { apikey: SB_ANON, Authorization: "Bearer " + jwt } }
    );
    const subRows = await subRes.json();
    const customerId = subRows?.[0]?.stripe_customer_id;

    if (!customerId) {
      return res.status(400).json({ error: { message: "No billing account found for this login — this looks like a complimentary account with no payment history to manage." } });
    }

    const origin = req.headers.origin || "https://guideschoicefishing.com";
    const params = new URLSearchParams();
    params.append("customer", customerId);
    params.append("return_url", origin + "/");

    const r = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + secretKey,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: { message: data.error.message || "Could not open the billing portal." } });
    return res.status(200).json({ url: data.url });
  } catch (e) {
    return res.status(500).json({ error: { message: e.message } });
  }
}
