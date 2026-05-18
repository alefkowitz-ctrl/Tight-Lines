export const maxDuration = 60;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { proxy_url, ...body } = req.body;

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

  // Anthropic API — handles both plain and web-search tool calls
  try {
    // First call
    let response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "interleaved-thinking-2025-05-14"
      },
      body: JSON.stringify(body)
    });
    let data = await response.json();

    // If model used web_search tool, run the agentic loop until stop_reason=end_turn
    let iterations = 0;
    while (data.stop_reason === "tool_use" && iterations < 5) {
      iterations++;
      const toolUseBlocks = (data.content || []).filter(b => b.type === "tool_use");
      if (!toolUseBlocks.length) break;

      // Build tool results — web_search results are already in the response
      // We need to send them back for the model to continue
      const messages = [
        ...(body.messages || []),
        { role: "assistant", content: data.content },
        {
          role: "user",
          content: toolUseBlocks.map(b => ({
            type: "tool_result",
            tool_use_id: b.id,
            content: b.type === "web_search_20250305" ? (b.content || "") : JSON.stringify(b.input)
          }))
        }
      ];

      response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({ ...body, messages })
      });
      data = await response.json();
    }

    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
