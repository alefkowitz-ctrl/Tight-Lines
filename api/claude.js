export const maxDuration = 60;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  
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
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    };

    // First call
    let response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    let data = await response.json();

    // Agentic loop: web_search tool returns tool_use blocks
    // The search RESULTS come back as tool_result_block inside the tool_use content
    // We just need to keep calling until stop_reason === "end_turn"
    let iterations = 0;
    while (data.stop_reason === "tool_use" && iterations < 5) {
      iterations++;
      const toolUseBlocks = (data.content || []).filter(b => b.type === "tool_use");
      if (!toolUseBlocks.length) break;

      // For web_search_20250305, the search results are already embedded 
      // in the tool_use block's content. Pass them back as tool_results.
      const toolResults = toolUseBlocks.map(b => {
        // web_search results come back in b.content as an array of result blocks
        const resultContent = Array.isArray(b.content) 
          ? b.content 
          : (b.content ? [{ type: "text", text: String(b.content) }] : [{ type: "text", text: "No results" }]);
        
        return {
          type: "tool_result",
          tool_use_id: b.id,
          content: resultContent
        };
      });

      const messages = [
        ...(body.messages || []),
        { role: "assistant", content: data.content },
        { role: "user", content: toolResults }
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
