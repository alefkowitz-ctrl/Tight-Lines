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

    // web_search is a SERVER-side tool: results arrive in the same response.
    // Long searches pause with stop_reason "pause_turn" — continue them until done.
    let iterations = 0;
    while (data && data.stop_reason === "pause_turn" && iterations < 5) {
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
