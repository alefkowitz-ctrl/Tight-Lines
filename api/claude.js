export const maxDuration = 60;

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
