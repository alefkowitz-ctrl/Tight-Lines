import crypto from "crypto";

// Web-API (Request/Response) handler style — Vercel's current documented way to reach
// the raw request body, which the (req,res) style used elsewhere in this repo does not
// reliably expose. Signature verification MUST run against the exact raw bytes Stripe
// signed; any parsing/re-stringifying before this point breaks it.

const SB_URL = "https://geqcnlrwkwicavwixvdn.supabase.co";

function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = {};
  sigHeader.split(",").forEach(p => {
    const [k, v] = p.split("=");
    parts[k] = v;
  });
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (ageSeconds > 300) return false; // reject events older than 5 min — replay protection
  const signedPayload = timestamp + "." + rawBody;
  const expected = crypto.createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(v1, "hex"));
  } catch (e) { return false; }
}

// service_role key bypasses RLS — required here since Stripe calls this endpoint with no
// Supabase user JWT at all. This key must NEVER reach the client bundle; Vercel env var only.
async function upsertSubscription(row) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  const r = await fetch(SB_URL + "/rest/v1/subscriptions?on_conflict=user_id", {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify(row)
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error("Supabase upsert failed: " + r.status + " " + body);
  }
}

async function findUserIdByCustomer(customerId) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(
    SB_URL + "/rest/v1/subscriptions?select=user_id&stripe_customer_id=eq." + encodeURIComponent(customerId),
    { headers: { apikey: key, Authorization: "Bearer " + key } }
  );
  if (!r.ok) return null;
  const rows = await r.json();
  return rows?.[0]?.user_id || null;
}

export async function POST(request) {
  const rawBody = await request.text();
  const sig = request.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    console.error("stripe-webhook: STRIPE_WEBHOOK_SECRET not set");
    return new Response(JSON.stringify({ error: "Webhook not configured" }), { status: 500 });
  }
  if (!verifyStripeSignature(rawBody, sig, secret)) {
    return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 400 });
  }

  let event;
  try { event = JSON.parse(rawBody); }
  catch (e) { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 }); }

  try {
    const obj = event.data?.object;

    if (event.type === "checkout.session.completed") {
      const userId = obj.client_reference_id || obj.metadata?.supabase_user_id;
      const tier = obj.metadata?.tier;
      if (userId && tier) {
        await upsertSubscription({
          user_id: userId,
          tier,
          status: "active",
          stripe_customer_id: obj.customer || null,
          stripe_subscription_id: obj.subscription || null,
          updated_at: new Date().toISOString()
        });
      }
    }

    if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const userId = obj.metadata?.supabase_user_id || (obj.customer ? await findUserIdByCustomer(obj.customer) : null);
      if (userId) {
        const canceled = event.type === "customer.subscription.deleted";
        const row = {
          user_id: userId,
          status: canceled ? "canceled" : (obj.status || "active"),
          stripe_customer_id: obj.customer || null,
          stripe_subscription_id: obj.id || null,
          current_period_end: obj.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : null,
          updated_at: new Date().toISOString()
        };
        row.tier = canceled ? "free" : (obj.metadata?.tier || undefined);
        if (row.tier === undefined) delete row.tier;
        await upsertSubscription(row);
      }
    }

    return new Response(JSON.stringify({ received: true }), { status: 200 });
  } catch (e) {
    // Return 500 (not a swallowed 200) so Stripe's built-in retry schedule kicks in —
    // a caught error here must still be a visible, retried failure, never a phantom success.
    console.error("stripe-webhook processing error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}
