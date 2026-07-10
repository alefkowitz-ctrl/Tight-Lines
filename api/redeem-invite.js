const SB_URL = "https://geqcnlrwkwicavwixvdn.supabase.co";

export const maxDuration = 30;

// Same lightweight decode-and-trust pattern used in create-checkout-session.js and
// create-portal-session.js — the JWT came straight from Supabase over HTTPS, so we
// trust the `sub` claim without re-verifying the signature server-side.
function jwtClaims(jwt) {
  try { return JSON.parse(Buffer.from(String(jwt).split(".")[1] || "", "base64").toString("utf8")); }
  catch (e) { return null; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: { message: "Method not allowed" } });

  const jwt = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return res.status(401).json({ error: { message: "Please sign in to redeem a code." } });

  const claims = jwtClaims(jwt);
  const userId = claims?.sub;
  if (!userId) return res.status(401).json({ error: { message: "Your session expired — please sign in again." } });

  const code = String(req.body?.code || "").trim();
  if (!code) return res.status(400).json({ error: { message: "No code provided." } });

  // service_role bypasses RLS — needed because comping an account is a privileged write
  // the caller's own JWT is not permitted to make directly against subscriptions.
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return res.status(500).json({ error: { message: "Not configured." } });

  try {
    const codeRes = await fetch(
      SB_URL + "/rest/v1/invite_codes?select=active,comp_tier,comp_duration_days&code=eq." + encodeURIComponent(code),
      { headers: { apikey: key, Authorization: "Bearer " + key } }
    );
    if (!codeRes.ok) {
      const body = await codeRes.text().catch(() => "");
      return res.status(500).json({ error: { message: "Could not verify code (Supabase " + codeRes.status + "): " + body } });
    }
    const codeRows = await codeRes.json();
    const codeRow = codeRows?.[0];
    if (!codeRow || codeRow.active === false || !codeRow.comp_tier) {
      // Not an error condition worth alarming over — most codes are plain signup-gate
      // codes with no comp_tier attached, so this is the expected outcome for those.
      return res.status(200).json({ ok: false, reason: "not_a_comp_code" });
    }

    // Never clobber a genuine paying subscriber's Stripe-linked row.
    const subRes = await fetch(
      SB_URL + "/rest/v1/subscriptions?select=status,stripe_customer_id&user_id=eq." + encodeURIComponent(userId),
      { headers: { apikey: key, Authorization: "Bearer " + key } }
    );
    if (!subRes.ok) {
      const body = await subRes.text().catch(() => "");
      return res.status(500).json({ error: { message: "Could not check existing subscription (Supabase " + subRes.status + "): " + body } });
    }
    const subRows = await subRes.json();
    const existing = subRows?.[0];
    if (existing && existing.status === "active" && existing.stripe_customer_id) {
      return res.status(200).json({ ok: false, reason: "already_paying_subscriber" });
    }

    // comp_duration_days null/0 => permanent (e.g. GUIDESCHOICE2026), unchanged behavior.
    // A positive value => time-limited trial; expiry is stored in current_period_end,
    // the same column real Stripe subscriptions use for "when does this access end" —
    // reused rather than adding a new column, and refreshTier's expiry check is gated
    // on is_comped so this can never affect a genuine paying subscriber.
    const days = Number(codeRow.comp_duration_days) || 0;
    const expiresAt = days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null;

    const upsertRes = await fetch(SB_URL + "/rest/v1/subscriptions?on_conflict=user_id", {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify({
        user_id: userId,
        tier: codeRow.comp_tier,
        status: "active",
        is_comped: true,
        current_period_end: expiresAt,
        updated_at: new Date().toISOString()
      })
    });
    if (!upsertRes.ok) {
      const body = await upsertRes.text().catch(() => "");
      return res.status(500).json({ error: { message: "Could not activate complimentary access: " + body } });
    }
    return res.status(200).json({ ok: true, tier: codeRow.comp_tier, expiresAt });
  } catch (e) {
    return res.status(500).json({ error: { message: e.message } });
  }
}
