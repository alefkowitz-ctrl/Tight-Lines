export const maxDuration = 30;

// Server-side tier -> Stripe Price ID map. The client only ever sends a tier NAME —
// never a price ID directly — so a tampered request can't downgrade what someone is charged.
// LIVE MODE price IDs. Monthly IDs switched over 2026-07-07; annual IDs added 2026-07-28.
const TIER_PRICE = {
  consumer_pro: { monthly: "price_1TqZPC2O6YqV9kpISV9ZLeDk", annual: "price_1TyP0s2O6YqV9kpI420B9MLS" },
  guide_pro: { monthly: "price_1TqZPB2O6YqV9kpI26JPl1t0", annual: "price_1TyP2t2O6YqV9kpIFvxnG4oB" },
  fly_shop_basic: { monthly: "price_1TqZP92O6YqV9kpIK3aoORio", annual: "price_1TyP3a2O6YqV9kpIfTSkPFD7" },
  fly_shop_pro: { monthly: "price_1TqZPD2O6YqV9kpIDYK1dHqB", annual: "price_1TyP1u2O6YqV9kpIpGMhBjzb" }
};

function jwtClaims(jwt) {
  try { return JSON.parse(Buffer.from(String(jwt).split(".")[1] || "", "base64").toString("utf8")); }
  catch (e) { return null; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: { message: "Method not allowed" } });

  const jwt = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return res.status(401).json({ error: { message: "Please sign in to subscribe." } });

  const claims = jwtClaims(jwt);
  const userId = claims?.sub;
  const email = claims?.email;
  if (!userId) return res.status(401).json({ error: { message: "Your session expired — please sign in again." } });

  const tier = req.body?.tier;
  const billing = req.body?.billing === "annual" ? "annual" : "monthly"; // default covers older clients that don't send billing
  const tierPrices = TIER_PRICE[tier];
  const priceId = tierPrices && tierPrices[billing];
  if (!priceId) return res.status(400).json({ error: { message: "Unknown plan selected." } });

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return res.status(500).json({ error: { message: "Payments are not configured yet." } });

  const origin = req.headers.origin || "https://guideschoicefishing.com";

  // Tier is stamped into both the Checkout Session AND the Subscription's own metadata.
  // The webhook needs the latter — customer.subscription.* events carry the Subscription
  // object, not the Checkout Session, as their payload. Billing period is stamped too
  // (informational only — tier gating in Supabase doesn't care about billing frequency).
  const params = new URLSearchParams();
  params.append("mode", "subscription");
  params.append("line_items[0][price]", priceId);
  params.append("line_items[0][quantity]", "1");
  params.append("success_url", origin + "/?checkout=success");
  params.append("cancel_url", origin + "/?checkout=cancel");
  params.append("client_reference_id", userId);
  params.append("metadata[supabase_user_id]", userId);
  params.append("metadata[tier]", tier);
  params.append("metadata[billing]", billing);
  params.append("subscription_data[metadata][supabase_user_id]", userId);
  params.append("subscription_data[metadata][tier]", tier);
  params.append("subscription_data[metadata][billing]", billing);
  if (email) params.append("customer_email", email);

  try {
    const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + secretKey,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: { message: data.error.message || "Could not start checkout." } });
    return res.status(200).json({ url: data.url });
  } catch (e) {
    return res.status(500).json({ error: { message: e.message } });
  }
}
