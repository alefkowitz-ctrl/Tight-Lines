import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchWeather, fetchUSGSLive, fetchUSGSTemp, askClaude, reverseGeocode } from '../lib/api'
import { windDir, pressureTrend, fishingPressureNote, getMoonPhase, getHatches, getStateRegLink, isFishable, cfsLabel } from '../lib/utils'
import LocationSearch from '../components/LocationSearch'
import WeekForecast from '../components/WeekForecast'
import GaugeList from '../components/GaugeList'
import HatchList from '../components/HatchList'
import SavedGauges from '../components/SavedGauges'
import { sb } from '../lib/supabase'

const WX_CODES = {
  0:'Sunny',1:'Mainly Clear',2:'Partly Cloudy',3:'Overcast',
  45:'Foggy',48:'Foggy',51:'Light Drizzle',53:'Drizzle',55:'Heavy Drizzle',
  61:'Light Rain',63:'Rain',65:'Heavy Rain',71:'Light Snow',73:'Snow',75:'Heavy Snow',
  80:'Showers',81:'Heavy Showers',82:'Violent Showers',95:'Thunderstorm',96:'Hail Storm',99:'Heavy Hail',
}
const WX_ICON = {
  0:'☀️',1:'🌤',2:'⛅',3:'☁️',45:'🌫',48:'🌫',51:'🌦',53:'🌦',55:'🌧',
  61:'🌧',63:'🌧',65:'🌧',71:'🌨',73:'🌨',75:'❄️',80:'🌦',81:'🌧',82:'⛈',95:'⛈',96:'⛈',99:'⛈',
}

export default function ConditionsTab({ user }) {
  const [loc, setLoc] = useState(() => {
    try { return JSON.parse(localStorage.getItem('tl_loc')) } catch { return null }
  })
  const [weather, setWeather] = useState(null)
  const [wxForecast, setWxForecast] = useState(null)
  const [wxLoading, setWxLoading] = useState(false)
  const [wxError, setWxError] = useState(null)
  const [gauges, setGauges] = useState([])
  const [gaugeLoading, setGaugeLoading] = useState(false)
  const [gaugeError, setGaugeError] = useState(null)
  const [lastUpd, setLastUpd] = useState(null)
  const [gaugesOpen, setGaugesOpen] = useState(false)
  const [condReport, setCondReport] = useState(null)
  const [condReportLoading, setCondReportLoading] = useState(false)
  const [condShops, setCondShops] = useState([])
  const [condShopsLoading, setCondShopsLoading] = useState(false)
  const prevPressureRef = useRef(null)
  const moon = getMoonPhase()
  const hatches = getHatches(new Date().getMonth() + 1)
  const regInfo = getStateRegLink(loc?.label)

  // Auto-detect location on mount
  useEffect(() => {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(async pos => {
      const { latitude: lat, longitude: lng } = pos.coords
      try {
        const label = await reverseGeocode(lat, lng)
        loadConditions({ lat, lng, label })
      } catch {
        loadConditions({ lat, lng, label: `${lat.toFixed(2)}, ${lng.toFixed(2)}` })
      }
    }, () => {}, { timeout: 8000 })
  }, [])

  const loadConditions = useCallback(async (newLoc) => {
    setLoc(newLoc)
    setCondReport(null)
    try { localStorage.setItem('tl_loc', JSON.stringify({ lat: newLoc.lat, lng: newLoc.lng, label: newLoc.label })) } catch {}

    // Weather
    setWxLoading(true); setWxError(null)
    try {
      const d = await fetchWeather(newLoc.lat, newLoc.lng)
      const cur = d.current
      const pressureInHg = cur.surface_pressure * 0.02953
      const prevP = prevPressureRef.current
      prevPressureRef.current = pressureInHg
      const trend = pressureTrend(pressureInHg, prevP)
      setWeather({
        temp: Math.round(cur.temperature_2m),
        desc: WX_CODES[cur.weathercode] || 'Clear',
        icon: WX_ICON[cur.weathercode] || '🌤',
        wind: Math.round(cur.windspeed_10m),
        windDir: windDir(cur.winddirection_10m),
        humidity: cur.relativehumidity_2m,
        uv: cur.uv_index,
        pressure: pressureInHg.toFixed(2),
        pressureTrend: trend,
        pressureNote: fishingPressureNote(pressureInHg),
      })
      setWxForecast(d)
    } catch { setWxError('Weather unavailable') }
    setWxLoading(false)

    // Gauges
    setGaugeLoading(true); setGaugeError(null)
    try {
      const { lat, lng } = newLoc
      const data = await fetchUSGSLive(lat, lng)
      const ts = data.value?.timeSeries || []
      const rawParsed = ts.map(t => {
        const raw = t.values?.[0]?.value?.[0]?.value
        const cfs = raw != null ? parseFloat(raw) : null
        const siteLat = parseFloat(t.sourceInfo?.geoLocation?.geogLocation?.latitude || 0)
        const siteLng = parseFloat(t.sourceInfo?.geoLocation?.geogLocation?.longitude || 0)
        const dist = Math.sqrt(Math.pow(siteLat - lat, 2) + Math.pow(siteLng - lng, 2))
        const distMi = Math.round(dist * 69)
        const name = t.sourceInfo?.siteName || 'Unknown'
        const siteNo = t.sourceInfo?.siteCode?.[0]?.value || ''
        return { name, cfs, siteNo, dist, distMi, lat: siteLat, lng: siteLng, fishable: isFishable(name) }
      }).filter(s => s.fishable && s.cfs != null && s.cfs >= 0 && s.cfs < 500000)
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 50)

      // Fetch water temps in parallel
      const temps = await Promise.all(rawParsed.map(g => fetchUSGSTemp(g.siteNo).catch(() => null)))
      const parsed = rawParsed.map((g, i) => {
        const { label, cls } = cfsLabel(g.cfs)
        return { ...g, label, cls, waterTempF: temps[i] }
      })
      setGauges(parsed)
      setLastUpd(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    } catch { setGaugeError('Could not load stream data') }
    setGaugeLoading(false)
  }, [])

  async function generateCondReport() {
    if (!loc || !weather) return
    setCondReportLoading(true)
    try {
      const gaugeInfo = gauges.slice(0, 5).map(g => `${g.name}: ${Math.round(g.cfs || 0)} CFS`).join(', ')
      const promptParts = [
        'You are a fly fishing guide writing a conditions report.',
        `Location: ${loc.label}.`,
        `Weather: ${weather.temp}°F, ${weather.desc}, wind ${weather.wind}mph ${weather.windDir}, pressure ${weather.pressure}" (${weather.pressureTrend?.label}).`,
        `Nearby streams: ${gaugeInfo || 'no gauge data'}.`,
        `Month: ${new Date().toLocaleString('en-US', { month: 'long' })}.`,
        'Write a 2-3 paragraph fly fishing conditions report.',
        'Cover: current conditions and how they affect fishing, which types of water are fishing best, top fly recommendations.',
        'Be specific and practical. Plain text only.',
      ]
      const txt = await askClaude(promptParts.join(' '), false, 500)
      setCondReport(txt)
    } catch (e) { console.log('cond report failed:', e.message) }
    setCondReportLoading(false)
  }

  async function fetchCondShops() {
    if (!loc) return
    setCondShopsLoading(true)
    setCondShops([])
    try {
      const prompt = 'Search for real fly fishing specialty shops near ' + loc.label + ' (coordinates: ' + loc.lat.toFixed(4) + ',' + loc.lng.toFixed(4) + '). Only include shops physically located near this exact location. Only dedicated fly shops or fly fishing outfitters. No Bass Pro or Cabelas. Return ONLY a JSON array: [{name, address, website, phone, specialty}]'
      const txt = await askClaude(prompt, true, 800)
      const start = txt.indexOf('['), stop = txt.lastIndexOf(']')
      if (start !== -1 && stop > start) {
        const parsed = JSON.parse(txt.slice(start, stop + 1))
        if (Array.isArray(parsed) && parsed.length > 0) setCondShops(parsed.slice(0, 6))
      }
    } catch (e) { console.log('fly shops failed:', e.message) }
    setCondShopsLoading(false)
  }

  return (
    <div>
      {/* Location search */}
      <LocationSearch
        initialValue={loc?.label?.split(',')[0] || ''}
        onSelect={r => loadConditions(r)}
        placeholder="Search location…"
      />

      {!loc && (
        <div className="info-box">
          🔍 <strong>Allow location access</strong> or search above to load conditions.<br /><br />
          Try: <em>"Boulder, CO"</em> · <em>"Madison River, MT"</em>
        </div>
      )}

      {loc && <>
        {/* Weather + Forecast */}
        <div className="card">
          <div className="card-title">
            🌡 Current Weather
            <button className="rfsh" onClick={() => loadConditions(loc)}>↻</button>
          </div>
          {wxLoading && <div className="loading">Fetching weather…</div>}
          {wxError && <div className="error-msg">{wxError}</div>}
          {weather && !wxLoading && <>
            <div className="wx-main">
              <div>
                <div className="wx-temp">{weather.temp}°F</div>
                <div className="wx-desc">{weather.icon} {weather.desc}</div>
              </div>
            </div>
            <div className="wx-grid">
              <div className="wx-item">
                <div className="wx-val">💨 {weather.wind} mph</div>
                <div className="wx-lbl">Wind {weather.windDir}</div>
              </div>
              <div className="wx-item">
                <div className="wx-val">💧 {weather.humidity}%</div>
                <div className="wx-lbl">Humidity</div>
              </div>
              <div className="wx-item">
                <div className="wx-val">☀️ {weather.uv}</div>
                <div className="wx-lbl">UV Index</div>
              </div>
              <div className="wx-item">
                <div className="wx-val" style={{ color: weather.pressureTrend?.color }}>
                  {weather.pressureTrend?.icon} {weather.pressure}"
                </div>
                <div className="wx-lbl">Pressure · {weather.pressureTrend?.label}</div>
              </div>
            </div>
            {weather.pressureNote && (
              <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(0,0,0,0.2)', borderRadius: 10, fontSize: 12, color: 'var(--sky)', fontStyle: 'italic' }}>
                🎣 {weather.pressureNote}
              </div>
            )}
            {wxForecast && <>
              <div className="divider" />
              <WeekForecast data={wxForecast} />
            </>}
          </>}
        </div>

        {/* Saved Gauges */}
        <SavedGauges user={user} />

        {/* Map */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '10px 14px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--gold)', fontFamily: 'var(--font-display)' }}>
              🗺 Nearby Waters{gauges.length > 0 && ` · ${gauges.length} gauges`}
            </span>
            <a
              href={`https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lng}#map=10/${loc.lat}/${loc.lng}`}
              target="_blank" rel="noreferrer"
              style={{ fontSize: 11, color: 'var(--sky)', textDecoration: 'none' }}
            >
              open larger ↗
            </a>
          </div>
          <iframe
            title="map"
            src={`https://www.openstreetmap.org/export/embed.html?bbox=${loc.lng - 0.75}%2C${loc.lat - 0.75}%2C${loc.lng + 0.75}%2C${loc.lat + 0.75}&layer=mapnik&marker=${loc.lat}%2C${loc.lng}`}
            style={{ width: '100%', height: 260, border: 'none', display: 'block' }}
          />
          {gauges.length > 0 && (
            <div style={{ padding: '8px 14px 10px', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {gauges.slice(0, 5).map((g, i) => (
                <span key={i} style={{ fontSize: 11, color: 'var(--stone)' }}>
                  📍 {(g.name || '').split(' ').slice(0, 4).join(' ')} · {Math.round(g.cfs || 0)} CFS
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Stream Gauges */}
        <div className="card">
          <div className="card-title" style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => setGaugesOpen(v => !v)}>
            💧 Stream Gauges
            <span style={{ fontSize: 12, color: 'var(--stone)', marginLeft: 4, fontFamily: 'var(--font-body)' }}>
              {gaugesOpen ? '▲' : '▼'}
            </span>
            <button className="rfsh" onClick={e => { e.stopPropagation(); loadConditions(loc) }}>↻</button>
          </div>
          <div className="card-sub">
            Live USGS · {gauges.length} gauges within 50mi{lastUpd && ` · ${lastUpd}`}
          </div>
          {gaugeLoading && <div className="loading">Loading gauges…</div>}
          {gaugeError && !gaugeLoading && <div className="error-msg">{gaugeError}</div>}
          {gaugesOpen && !gaugeLoading && <GaugeList gauges={gauges} />}
          {!gaugesOpen && !gaugeLoading && gauges.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
              {gauges.slice(0, 5).map((g, i) => (
                <span key={i} style={{ fontSize: 11, background: 'rgba(255,255,255,0.06)', borderRadius: 20, padding: '3px 10px', color: 'var(--stone)' }}>
                  {(g.name || '').split(' ').slice(0, 3).join(' ')} · {Math.round(g.cfs || 0)} CFS
                </span>
              ))}
              {gauges.length > 5 && (
                <span style={{ fontSize: 11, color: 'var(--stone)', padding: '3px 6px' }}>+{gauges.length - 5} more</span>
              )}
            </div>
          )}
        </div>

        {/* Moon Phase */}
        <div className="card">
          <div className="card-title">🌙 Moon Phase</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ fontSize: 42 }}>{moon.emoji}</span>
            <div>
              <div style={{ fontSize: 16, color: 'var(--foam)', fontFamily: 'var(--font-display)' }}>{moon.name}</div>
              <div style={{ fontSize: 12, color: 'var(--stone)', marginTop: 2 }}>{moon.pct}% illuminated</div>
              <div style={{ fontSize: 12, color: 'var(--sky)', marginTop: 4, fontStyle: 'italic' }}>🎣 {moon.note}</div>
            </div>
          </div>
        </div>

        {/* AI Conditions Report */}
        <div className="card">
          <div className="card-title">
            ✦ AI Conditions Report
            {condReport && <button className="rfsh" onClick={generateCondReport}>↻</button>}
          </div>
          {!condReport && !condReportLoading && (
            <button className="btn btn-primary btn-full" onClick={generateCondReport}>
              ✦ Generate Conditions Report
            </button>
          )}
          {condReportLoading && <div className="loading">Generating report…</div>}
          {condReport && (
            <div style={{ fontSize: 13, color: 'var(--foam)', lineHeight: 1.75, fontFamily: 'var(--font-body)', whiteSpace: 'pre-wrap', marginTop: 4 }}>
              {condReport}
            </div>
          )}
        </div>

        {/* Hatches */}
        <div className="card">
          <div className="card-title">🪲 This Month's Hatches</div>
          <HatchList hatches={hatches} />
        </div>

        {/* Regs Link */}
        {regInfo && (
          <div style={{ marginBottom: 12 }}>
            <a href={regInfo.url} target="_blank" rel="noreferrer" style={{
              display: 'block', padding: '12px 16px', background: 'rgba(200,168,75,0.08)',
              border: '1px solid rgba(200,168,75,0.2)', borderRadius: 'var(--radius)',
              color: 'var(--gold)', fontSize: 13, textDecoration: 'none', textAlign: 'center',
            }}>
              📋 {regInfo.name} Fishing Regulations ↗
            </a>
          </div>
        )}

        {/* Fly Shops */}
        <div className="card">
          <div className="card-title">🪝 Nearby Fly Shops</div>
          {condShopsLoading && <div className="loading">Searching…</div>}
          {!condShopsLoading && condShops.length === 0 && (
            <button className="btn btn-secondary btn-full" onClick={fetchCondShops}>
              🔍 Find Fly Shops Near {loc.label.split(',')[0]}
            </button>
          )}
          {condShops.map((s, i) => (
            <div key={i} style={{ padding: '10px 0', borderBottom: i < condShops.length - 1 ? '1px solid var(--border)' : 'none' }}>
              <div style={{ fontSize: 14, color: 'var(--foam)', fontFamily: 'var(--font-display)', fontWeight: 600 }}>{s.name}</div>
              {s.address && <div style={{ fontSize: 12, color: 'var(--stone)', marginTop: 2 }}>{s.address}</div>}
              {s.specialty && <div style={{ fontSize: 12, color: 'var(--sky)', marginTop: 2, fontStyle: 'italic' }}>{s.specialty}</div>}
              {s.website && (
                <a href={s.website} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: 'var(--gold)', textDecoration: 'none', marginTop: 4, display: 'block' }}>
                  {s.website.replace(/^https?:\/\//, '')}
                </a>
              )}
              {s.phone && <div style={{ fontSize: 12, color: 'var(--stone)', marginTop: 2 }}>{s.phone}</div>}
            </div>
          ))}
        </div>
      </>}
    </div>
  )
}
