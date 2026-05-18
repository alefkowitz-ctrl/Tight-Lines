// ── Claude API (via Vercel proxy) ─────────────────────────────────────────────
export async function askClaude(prompt, useSearch = false, maxTokens = 1200) {
  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  }
  if (useSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search' }]
  }
  const res = await fetch('/api/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const d = await res.json()
  return (d.content || []).map(b => b.text || '').filter(Boolean).join('')
}

export async function proxyFetch(url) {
  const res = await fetch('/api/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proxy_url: url }),
  })
  return res.json()
}

// ── Geocoding ─────────────────────────────────────────────────────────────────
export async function geocode(q) {
  const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5`)
  const d = await r.json()
  return d.map(x => ({
    label: x.display_name.split(',').slice(0, 3).join(','),
    lat: parseFloat(x.lat),
    lng: parseFloat(x.lon),
  }))
}

export async function reverseGeocode(lat, lng) {
  const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`)
  const d = await r.json()
  return d.address?.city || d.address?.town || d.address?.county || `${lat.toFixed(2)},${lng.toFixed(2)}`
}

// ── Weather ───────────────────────────────────────────────────────────────────
export async function fetchWeather(lat, lng) {
  const r = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&current=temperature_2m,weathercode,windspeed_10m,winddirection_10m,relativehumidity_2m,surface_pressure,uv_index` +
    `&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&temperature_unit=fahrenheit&windspeed_unit=mph&precipitation_unit=inch&forecast_days=7&timezone=auto`
  )
  return r.json()
}

// ── USGS Gauges ───────────────────────────────────────────────────────────────
export async function fetchUSGSLive(lat, lng) {
  const allTs = []
  const seen = {}

  function dedup(ts) {
    return ts.filter(t => {
      const sno = t.sourceInfo?.siteCode?.[0]?.value || Math.random()
      if (seen[sno]) return false
      seen[sno] = true
      return true
    })
  }

  const rings = [0.3, 0.5, 0.75]
  for (const p of rings) {
    const bbox = [
      Math.round((lng - p) * 10000) / 10000,
      Math.round((lat - p) * 10000) / 10000,
      Math.round((lng + p) * 10000) / 10000,
      Math.round((lat + p) * 10000) / 10000,
    ].join(',')
    try {
      const r = await fetch(`https://waterservices.usgs.gov/nwis/iv/?format=json&bBox=${bbox}&parameterCd=00060`)
      if (r.ok) {
        const d = await r.json()
        allTs.push(...dedup(d.value?.timeSeries || []))
      }
    } catch (e) {
      console.log('USGS ring error:', e.message)
    }
  }
  return { value: { timeSeries: allTs } }
}

export async function fetchUSGSRange(siteNo, days = 7) {
  const end = new Date()
  const start = new Date(end - days * 86400000)
  const fmt = d => d.toISOString().split('T')[0]
  try {
    const r = await fetch(
      `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${siteNo}&parameterCd=00060&startDT=${fmt(start)}&endDT=${fmt(end)}`
    )
    if (!r.ok) return []
    const d = await r.json()
    const vals = d.value?.timeSeries?.[0]?.values?.[0]?.value || []
    return vals.map(v => ({ t: new Date(v.dateTime).getTime(), cfs: parseFloat(v.value) }))
      .filter(v => !isNaN(v.cfs))
  } catch { return [] }
}

export async function fetchUSGSTemp(siteNo) {
  try {
    const r = await fetch(
      `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${siteNo}&parameterCd=00010`
    )
    if (!r.ok) return null
    const d = await r.json()
    const raw = d.value?.timeSeries?.[0]?.values?.[0]?.value?.[0]?.value
    if (raw == null) return null
    return parseFloat(raw) * 9 / 5 + 32 // C to F
  } catch { return null }
}

// ── Storage Upload ────────────────────────────────────────────────────────────
export async function uploadPhotoToStorage(sb, base64DataUrl, folder) {
  if (!sb) return null
  try {
    const res = await fetch(base64DataUrl)
    const blob = await res.blob()
    const ext = blob.type.split('/')[1] || 'jpg'
    const fileName = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
    const { data, error } = await sb.storage.from('trip-photos').upload(fileName, blob, {
      contentType: blob.type,
      upsert: false,
    })
    if (error) { console.log('Storage upload error:', error.message); return null }
    const { data: { publicUrl } } = sb.storage.from('trip-photos').getPublicUrl(fileName)
    return publicUrl
  } catch (e) { console.log('uploadPhotoToStorage failed:', e.message); return null }
}
