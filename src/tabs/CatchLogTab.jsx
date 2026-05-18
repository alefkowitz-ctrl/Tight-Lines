import { useState, useEffect, useRef } from 'react'
import { sb } from '../lib/supabase'
import { uploadPhotoToStorage, fetchWeather, fetchUSGSLive } from '../lib/api'
import { parseExif, fmtCoord, cfsLabel, isFishable, extractJSON } from '../lib/utils'

const SPECIES = [
  'Rainbow Trout', 'Brown Trout', 'Brook Trout', 'Cutthroat Trout', 'Bull Trout',
  'Lake Trout', 'Steelhead', 'Atlantic Salmon', 'Chinook Salmon', 'Coho Salmon',
  'Sockeye Salmon', 'Whitefish', 'Grayling', 'Bass', 'Bluegill', 'Pike', 'Walleye', 'Other',
]

const BLANK = { species: '', length: '', flies: [], flyInput: '', photo: null, gps: '', time: '', notes: '', sizeEstimating: false }

const WX_DESC = {
  0:'Sunny',1:'Mainly Clear',2:'Partly Cloudy',3:'Overcast',45:'Foggy',
  61:'Rain',63:'Rain',65:'Heavy Rain',71:'Snow',73:'Snow',80:'Showers',95:'Thunderstorm',
}

function CatchMap({ catches }) {
  if (!catches.length) return null
  const withGps = catches.filter(c => {
    if (!c.gps || c.gps === 'Location not recorded') return false
    const m = c.gps.match(/([\d.]+)°([NS]),\s*([\d.]+)°([EW])/)
    return m
  })
  if (!withGps.length) return null

  const pts = withGps.map(c => {
    const m = c.gps.match(/([\d.]+)°([NS]),\s*([\d.]+)°([EW])/)
    return {
      lat: parseFloat(m[1]) * (m[2] === 'S' ? -1 : 1),
      lng: parseFloat(m[3]) * (m[4] === 'W' ? -1 : 1),
      c,
    }
  })

  const lats = pts.map(p => p.lat), lngs = pts.map(p => p.lng)
  const medLat = lats.slice().sort((a, b) => a - b)[Math.floor(lats.length / 2)]
  const medLng = lngs.slice().sort((a, b) => a - b)[Math.floor(lngs.length / 2)]
  const corePts = pts.filter(p => Math.abs(p.lat - medLat) < 2 && Math.abs(p.lng - medLng) < 2)
  const viewPts = corePts.length >= 2 ? corePts : pts
  const vLats = viewPts.map(p => p.lat), vLngs = viewPts.map(p => p.lng)
  const latSpread = Math.max(Math.max(...vLats) - Math.min(...vLats), 0.04)
  const lngSpread = Math.max(Math.max(...vLngs) - Math.min(...vLngs), 0.04)
  const latMid = (Math.min(...vLats) + Math.max(...vLats)) / 2
  const lngMid = (Math.min(...vLngs) + Math.max(...vLngs)) / 2
  const latMin = latMid - latSpread / 2 - latSpread * 0.2
  const latMax = latMid + latSpread / 2 + latSpread * 0.2
  const lngMin = lngMid - lngSpread / 2 - lngSpread * 0.2
  const lngMax = lngMid + lngSpread / 2 + lngSpread * 0.2

  const W = 560, H = 220, P = 24
  const projX = lng => Math.max(P + 6, Math.min(W - P - 6, P + (lng - lngMin) / ((lngMax - lngMin) || 0.01) * (W - P * 2)))
  const ty = lat => Math.max(P + 6, Math.min(H - P - 6, H - P - (lat - latMin) / ((latMax - latMin) || 0.01) * (H - P * 2)))

  const placed = []
  const R = 18
  const pinData = pts.map((pt) => {
    const ox = projX(pt.lng), oy = ty(pt.lat)
    let x = ox, y = oy, found = false
    for (let ring = 0; ring < 8 && !found; ring++) {
      const count = ring === 0 ? 1 : ring * 6
      for (let s = 0; s < count && !found; s++) {
        const a = (s / count) * Math.PI * 2
        const cx2 = ox + ring * R * Math.cos(a)
        const cy2 = oy + ring * R * Math.sin(a)
        if (!placed.some(p => Math.hypot(p.x - cx2, p.y - cy2) < R - 2)) {
          x = cx2; y = cy2; found = true
        }
      }
    }
    placed.push({ x, y })
    return { x, y, pt }
  })

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px 6px' }}>
        <span style={{ fontSize: 12, color: 'var(--gold)', fontFamily: 'var(--font-display)' }}>
          📍 Catch Locations · {withGps.length} mapped
        </span>
      </div>
      <div style={{ background: 'rgba(0,0,0,0.2)' }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
          {[0.25, 0.5, 0.75].map(f => (
            <line key={f} x1={P} x2={W - P} y1={P + (H - P * 2) * f} y2={P + (H - P * 2) * f} stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
          ))}
          {pinData.map(({ x, y, pt }, i) => (
            <g key={i}>
              <circle cx={x} cy={y} r={8} fill="rgba(200,168,75,0.25)" stroke="#c8a84b" strokeWidth="1.5" />
              <circle cx={x} cy={y} r={3} fill="#c8a84b" />
              <title>{(pt.c.species || 'Catch') + (pt.c.length ? ' ' + pt.c.length + '"' : '')}</title>
            </g>
          ))}
        </svg>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '6px 12px 10px' }}>
        {withGps.slice(0, 10).map((c, i) => (
          <span key={i} style={{ fontSize: 11, background: 'rgba(200,168,75,0.15)', border: '1px solid rgba(200,168,75,0.3)', borderRadius: 20, padding: '2px 10px', color: 'var(--gold)' }}>
            📍 {c.species || 'Catch'}{c.length ? ' ' + c.length + '"' : ''}
          </span>
        ))}
      </div>
    </div>
  )
}

function AddCatchModal({ onClose, onSave, loc }) {
  const [form, setForm] = useState(BLANK)
  const [loading, setLoading] = useState(false)
  const camRef = useRef()
  const galRef = useRef()

  async function handlePhoto(e) {
    const file = e.target.files[0]
    if (!file) return
    e.target.value = ''
    const dataUrl = await new Promise(res => { const r = new FileReader(); r.onload = ev => res(ev.target.result); r.readAsDataURL(file) })
    setForm(f => ({ ...f, photo: dataUrl, sizeEstimating: true }))

    // Parse EXIF
    let photoLat = null, photoLng = null, photoTime = null
    try {
      const abuf = await file.arrayBuffer()
      const exif = parseExif(abuf)
      photoLat = exif.lat ?? null
      photoLng = exif.lng ?? null
      if (exif.dateTime) {
        const [datePart, timePart] = exif.dateTime.split(' ')
        const d = new Date(datePart.replace(/:/g, '-') + 'T' + (timePart || '12:00:00'))
        if (!isNaN(d)) photoTime = d.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
      }
    } catch {}

    const lat = photoLat ?? loc?.lat
    const lng = photoLng ?? loc?.lng
    const gps = lat ? fmtCoord(lat, lng) : 'Location not recorded'
    const time = photoTime || new Date().toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
    setForm(f => ({ ...f, gps, time }))

    // Auto-fetch conditions
    if (lat && lng) {
      try {
        const [wx, usgs] = await Promise.all([fetchWeather(lat, lng), fetchUSGSLive(lat, lng)])
        const cur = wx.current
        setForm(f => ({
          ...f,
          airTemp: String(Math.round(cur.temperature_2m)),
          weatherDesc: WX_DESC[cur.weathercode] || '',
          windSpeed: String(Math.round(cur.windspeed_10m)),
        }))
        const ts = usgs.value?.timeSeries || []
        const nearest = ts.map(t2 => {
          const raw = t2.values?.[0]?.value?.[0]?.value
          const cfs = raw != null ? parseFloat(raw) : null
          const sLat = parseFloat(t2.sourceInfo?.geoLocation?.geogLocation?.latitude || 0)
          const sLng = parseFloat(t2.sourceInfo?.geoLocation?.geogLocation?.longitude || 0)
          const dist = Math.sqrt(Math.pow(sLat - lat, 2) + Math.pow(sLng - lng, 2))
          return { name: t2.sourceInfo?.siteName || '', cfs, dist }
        }).filter(x => x.cfs != null && x.cfs >= 0).sort((a, b) => a.dist - b.dist)[0]
        if (nearest) setForm(f => ({ ...f, streamCFS: String(Math.round(nearest.cfs)), streamGaugeName: nearest.name }))
      } catch {}
    }

    // AI fish ID
    try {
      const base64 = dataUrl.split(',')[1]
      const res = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6', max_tokens: 150,
          messages: [{
            role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: file.type || 'image/jpeg', data: base64 } },
              { type: 'text', text: `Identify this fish. Choose from: ${SPECIES.join(', ')}. Reply ONLY with JSON: {"species":"Rainbow Trout","length":14}` },
            ],
          }],
        }),
      })
      const rd = await res.json()
      const parsed = extractJSON((rd.content || [])[0]?.text || '{}')
      if (parsed?.species) setForm(f => ({ ...f, species: parsed.species }))
      if (parsed?.length != null) setForm(f => ({ ...f, length: String(Math.round(parsed.length)), sizeEstimated: true }))
    } catch (e) { console.log('Fish ID failed:', e.message) }

    setForm(f => ({ ...f, sizeEstimating: false }))
  }

  function addFly() {
    if (!form.flyInput?.trim()) return
    setForm(f => ({ ...f, flies: [...f.flies, f.flyInput.trim()], flyInput: '' }))
  }

  function submit() {
    const time = form.time || new Date().toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
    onSave({ ...form, time })
    onClose()
  }

  return (
    <div className="overlay">
      <div className="modal">
        <div className="modal-title">
          🐟 Log a Catch
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {/* Photo */}
        {form.photo ? (
          <div style={{ position: 'relative', marginBottom: 14 }}>
            <img src={form.photo} alt="catch" style={{ width: '100%', borderRadius: 10, maxHeight: 220, objectFit: 'cover' }} />
            {form.sizeEstimating && (
              <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: 'white' }}>
                🤖 Identifying fish…
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => camRef.current?.click()}>📷 Camera</button>
            <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => galRef.current?.click()}>🖼 Gallery</button>
          </div>
        )}
        <input ref={camRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={handlePhoto} />
        <input ref={galRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handlePhoto} />

        {/* Species */}
        <div className="form-group">
          <label className="form-label">Species</label>
          <select className="input" value={form.species} onChange={e => setForm(f => ({ ...f, species: e.target.value }))}>
            <option value="">Select species…</option>
            {SPECIES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        {/* Length */}
        <div className="form-group">
          <label className="form-label">Length (inches){form.sizeEstimated && <span style={{ color: 'var(--sky)', marginLeft: 6, fontSize: 11 }}>AI estimated</span>}</label>
          <input className="input" type="number" value={form.length} onChange={e => setForm(f => ({ ...f, length: e.target.value, sizeEstimated: false }))} placeholder="e.g. 16" />
        </div>

        {/* Flies */}
        <div className="form-group">
          <label className="form-label">Flies Used</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
            {form.flies.map((fly, i) => (
              <span key={i} className="chip">
                🪶 {fly}
                <button onClick={() => setForm(f => ({ ...f, flies: f.flies.filter((_, j) => j !== i) }))} style={{ background: 'none', border: 'none', color: 'var(--stone)', cursor: 'pointer', marginLeft: 2, fontSize: 12 }}>✕</button>
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="input" value={form.flyInput || ''} onChange={e => setForm(f => ({ ...f, flyInput: e.target.value }))} placeholder="e.g. Elk Hair Caddis #14" onKeyDown={e => e.key === 'Enter' && addFly()} />
            <button className="btn btn-secondary" onClick={addFly} style={{ flexShrink: 0 }}>Add</button>
          </div>
        </div>

        {/* GPS */}
        <div className="form-group">
          <label className="form-label">Location</label>
          <input className="input" value={form.gps || ''} onChange={e => setForm(f => ({ ...f, gps: e.target.value }))} placeholder="GPS or location name" />
        </div>

        {/* Notes */}
        <div className="form-group">
          <label className="form-label">Notes</label>
          <textarea className="input" value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Depth, technique, conditions…" rows={3} />
        </div>

        <button className="btn btn-primary btn-full" onClick={submit} disabled={!form.species}>
          Save Catch
        </button>
      </div>
    </div>
  )
}

export default function CatchLogTab({ user, loc }) {
  const [catches, setCatches] = useState([])
  const [loading, setLoading] = useState(true)
  const [addOpen, setAddOpen] = useState(false)
  const [aiSummary, setAiSummary] = useState(null)
  const [aiLoading, setAiLoading] = useState(false)

  useEffect(() => {
    if (!user) return
    sb.from('catches').select('*').eq('user_id', user.id).order('created_at', { ascending: false })
      .then(({ data }) => { if (data) setCatches(data); setLoading(false) })
  }, [user])

  async function addCatch(catchData) {
    let photo = catchData.photo
    if (photo?.startsWith('data:')) {
      const url = await uploadPhotoToStorage(sb, photo, 'catches')
      photo = url || null
    }
    const { data, error } = await sb.from('catches').insert({ user_id: user.id, ...catchData, photo }).select().single()
    if (error) { console.log('Catch insert error:', error.message); alert('Failed to save catch: ' + error.message); return }
    if (data) setCatches(cs => [{ ...catchData, id: data.id, photo: data.photo }, ...cs])
  }

  async function deleteCatch(id) {
    if (!window.confirm('Delete this catch?')) return
    setCatches(cs => cs.filter(c => c.id !== id))
    await sb.from('catches').delete().eq('id', id)
  }

  async function generateAISummary() {
    if (!catches.length) return
    setAiLoading(true)
    try {
      const summary = catches.slice(0, 20).map(c =>
        `${c.species}${c.length ? ' ' + c.length + '"' : ''} on ${(c.flies || []).join(', ') || 'unspecified fly'}${c.gps && c.gps !== 'Location not recorded' ? ' at ' + c.gps : ''}`
      ).join('; ')
      const res = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6', max_tokens: 400,
          messages: [{ role: 'user', content: `Analyze these fly fishing catches and provide a 2-3 sentence trend summary including top species, effective flies, and any patterns you notice. Catches: ${summary}. Be specific and practical. Plain text only.` }],
        }),
      })
      const d = await res.json()
      setAiSummary((d.content || [])[0]?.text || '')
    } catch {}
    setAiLoading(false)
  }

  // Stats
  const species = catches.reduce((acc, c) => { acc[c.species] = (acc[c.species] || 0) + 1; return acc }, {})
  const sorted = Object.entries(species).sort((a, b) => b[1] - a[1])
  const maxCount = sorted[0]?.[1] || 1

  const exportCSV = () => {
    const rows = [['Species', 'Length', 'Flies', 'GPS', 'Time', 'Notes']]
    catches.forEach(c => rows.push([c.species, c.length, (c.flies || []).join('|'), c.gps, c.time, c.notes]))
    const csv = rows.map(r => r.map(v => `"${(v || '').toString().replace(/"/g, '""')}"`).join(',')).join('\n')
    const a = document.createElement('a'); a.href = 'data:text/csv,' + encodeURIComponent(csv); a.download = 'catches.csv'; a.click()
  }

  return (
    <div>
      {/* Stats */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontSize: 14, color: 'var(--gold)', fontFamily: 'var(--font-display)' }}>
            My Catches · {catches.length} Fish
          </div>
          <button className="btn btn-secondary" onClick={exportCSV} style={{ fontSize: 12, padding: '4px 10px' }}>↓ CSV</button>
        </div>
        {sorted.slice(0, 5).map(([sp, count]) => (
          <div key={sp} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 3 }}>
              <span style={{ color: 'var(--foam)' }}>{sp}</span>
              <span style={{ color: 'var(--stone)' }}>{count}</span>
            </div>
            <div style={{ height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2 }}>
              <div style={{ height: '100%', background: 'var(--good)', borderRadius: 2, width: `${(count / maxCount) * 100}%`, transition: 'width 0.5s' }} />
            </div>
          </div>
        ))}
      </div>

      {/* AI Summary */}
      <div style={{ marginBottom: 12 }}>
        {!aiSummary && !aiLoading && catches.length > 0 && (
          <button className="btn btn-primary btn-full" onClick={generateAISummary}>✦ AI Catch Trend Summary</button>
        )}
        {aiLoading && <div className="loading">Analyzing your catches…</div>}
        {aiSummary && (
          <div className="card">
            <div className="card-title">✦ AI Catch Trend Summary</div>
            <div style={{ fontSize: 13, color: 'var(--foam)', lineHeight: 1.7, fontFamily: 'var(--font-body)' }}>{aiSummary}</div>
          </div>
        )}
      </div>

      {/* Map */}
      <CatchMap catches={catches} />

      {/* Catch Cards */}
      {loading && <div className="loading">Loading catches…</div>}
      {!loading && catches.length === 0 && (
        <div className="info-box">
          No catches yet.<br /><br />Tap <strong>+</strong> to log your first fish.
        </div>
      )}
      {catches.map(c => (
        <div key={c.id} className="catch-card">
          {c.photo && <img src={c.photo} alt={c.species} className="catch-card-img" />}
          <div className="catch-card-body">
            <div className="catch-species">{c.species || 'Unknown'}</div>
            <div className="catch-meta">
              {c.length && <span className="catch-meta-item">🎣 {c.length}"</span>}
              {c.time && <span className="catch-meta-item">🕐 {c.time}</span>}
              {c.gps && c.gps !== 'Location not recorded' && <span className="catch-meta-item">📍 {c.gps}</span>}
            </div>
            {c.flies?.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                {c.flies.map((f, i) => <span key={i} className="chip" style={{ cursor: 'default', fontSize: 11 }}>🪶 {f}</span>)}
              </div>
            )}
            {c.notes && <div style={{ fontSize: 12, color: 'var(--stone)', marginTop: 8, fontStyle: 'italic' }}>{c.notes}</div>}
            <div className="catch-actions">
              <button className="catch-action-btn danger" onClick={() => deleteCatch(c.id)}>🗑 Delete</button>
            </div>
          </div>
        </div>
      ))}

      {/* FAB */}
      <button className="fab" onClick={() => setAddOpen(true)}>+</button>

      {addOpen && (
        <AddCatchModal
          onClose={() => setAddOpen(false)}
          onSave={addCatch}
          loc={loc}
        />
      )}
    </div>
  )
}
