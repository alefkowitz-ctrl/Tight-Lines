// Shared low-level Anthropic caller for server-side (Vercel function) code. Single source
// of truth for the actual /v1/messages call plus the pause_turn continuation loop that
// long web_search calls need — used by both api/claude.js (the per-call browser proxy,
// which forwards whatever body the client built) and api/plan-trip-background.js (which
// builds request bodies itself and calls Anthropic directly, no browser round trip).
// Takes a pre-built Anthropic request body, returns the raw response JSON as-is — callers
// are responsible for interpreting `data.error` / `data.content` themselves, exactly as
// they already did when this logic lived inline in api/claude.js.
export async function callAnthropicRaw(body) {
  const headers = {
    "Content-Type": "application/json",
    "x-api-key": process.env.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "web-fetch-2025-09-10"
  };

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

  return data;
}
