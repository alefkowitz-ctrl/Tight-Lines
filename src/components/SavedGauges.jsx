import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { cfsLabel } from '../lib/utils'
import { fetchUSGSRange } from '../lib/api'

async function fetchGaugeData(gauge) {
  try {
    const siteNo = gauge.site_no
    if (!siteNo) return { ...gauge, cfs: null, label: 'NO DATA', cls: 'nodata' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    const r = await fetch(
      `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${siteNo}&parameterCd=00060`,
      { signal: controller.signal }
    )
    clearTimeout(timer)
    if (!r.ok) return { ...gauge, cfs: null, label: 'NO DATA', cls: 'nodata' }
    const d = await r.json()
    const ts = d.value?.timeSeries || []
    if (!ts.length) return { ...gauge, cfs: null, label: 'NO DATA', cls: 'nodata' }
    const raw = ts[0].values?.[0]?.value?.[0]?.value
    const cfs = raw != null ? parseFloat(raw) : null
    const name = ts[0].sourceInfo?.siteName || gauge.name
    const { label, cls } = cfsLabel(cfs)
    return { ...gauge, cfs, label, cls, name }
  } catch {
    return { ...gauge, cfs: null, label: 'NO DATA', cls: 'nodata' }
  }
}

export default function SavedGauges({ user }) {
  const [saved, setSaved] = useState([])
  const [liveData, setLiveData] = useState([])
  const [showAdd, setShowAdd] = useState(false)
  const [input, setInput] = useState('')
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    if (!user || user.id?.startsWith('local')) return
    sb.from('saved_gauges').select('*').eq('user_id', user.id)
      .then(({ data, error }) => {
        if (data) setSaved(data)
        if (error) console.log('saved_gauges load error:', error.message)
      })
      .catch(e => console.log('saved_gauges fetch error:', e.message))
  }, [user?.id])

  useEffect(() => {
    if (!saved.length) return
    Promise.all(saved.map(fetchGaugeData)).then(setLiveData)
      .catch(e => console.log('gauge data error:', e.message))
  }, [saved.length])

  async function addGauge() {
    if (!input.trim()) return
    setAdding(true)
    const url = input.trim()
    const m = url.match(/sites?[=\/]([0-9]{8,})/i) ||
               url.match(/monitoring-location\/USGS-([0-9]+)/i) ||
               url.match(/^([0-9]{8,15})$/)
    if (!m) {
      alert('Please enter a USGS site number (e.g. 06729500) or waterdata.usgs.gov URL')
      setAdding(false)
      return
    }
    const siteNo = m[1]
    let name = 'Custom Gauge'
    try {
      const r = await fetch(`https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${siteNo}&parameterCd=00060`)
      if (r.ok) {
        const d = await r.json()
        const ts = d.value?.timeSeries || []
        if (ts.length) name = ts[0].sourceInfo?.siteName || name
      }
    } catch {}

    const newGauge = { user_id: user.id, site_no: siteNo, name, url }
    const { data } = await sb.from('saved_gauges').insert(newGauge).select().single()
    if (data) setSaved(gs => [...gs, data])
    setInput('')
    setShowAdd(false)
    setAdding(false)
  }

  async function removeGauge(id) {
    setSaved(gs => gs.filter(g => g.id !== id))
    setLiveData(gs => gs.filter(g => g.id !== id))
    await sb.from('saved_gauges').delete().eq('id', id).catch(() => {})
  }

  return (
    <>
      {saved.length > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 13, color: 'var(--gold)', fontFamily: 'var(--font-display)' }}>⭐ My Gauges</span>
            <button
              onClick={() => setShowAdd(v => !v)}
              style={{ fontSize: 11, background: 'rgba(200,168,75,0.2)', border: '1px solid rgba(200,168,75,0.4)', borderRadius: 20, padding: '3px 10px', color: 'var(--gold)', cursor: 'pointer' }}
            >
              + Add
            </button>
          </div>
          {showAdd && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <input
                value={input} onChange={e => setInput(e.target.value)}
                placeholder="USGS site # or waterdata.usgs.gov URL"
                className="input"
                style={{ flex: 1, fontSize: 12, padding: '6px 10px' }}
                onKeyDown={e => e.key === 'Enter' && addGauge()}
              />
              <button onClick={addGauge} disabled={adding}
                className="btn btn-primary"
                style={{ padding: '6px 14px', fontSize: 12 }}>
                {adding ? '…' : 'Save'}
              </button>
            </div>
          )}
          {liveData.map((g, i) => (
            <div key={g.id || i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: i < liveData.length - 1 ? '1px solid var(--border)' : 'none' }}>
              <div>
                <div style={{ fontSize: 13, color: 'var(--foam)' }}>{g.name || g.site_no}</div>
                <div style={{ fontSize: 12, color: 'var(--stone)', marginTop: 2 }}>
                  {g.cfs != null ? g.cfs.toLocaleString() + ' CFS' : 'Loading…'}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {g.cfs != null && <span className={`badge badge-${g.cls}`}>{g.label}</span>}
                <button onClick={() => removeGauge(g.id)} style={{ background: 'none', border: 'none', color: 'var(--stone)', cursor: 'pointer', fontSize: 16, padding: 4 }}>✕</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add gauge button when no saved gauges */}
      <div style={{ marginBottom: 12 }}>
        {showAdd && saved.length === 0 ? (
          <div className="card">
            <div style={{ fontSize: 13, color: 'var(--gold)', marginBottom: 8, fontFamily: 'var(--font-display)' }}>⭐ Pin a Gauge</div>
            <div style={{ fontSize: 12, color: 'var(--stone)', marginBottom: 8 }}>
              Paste a USGS site number or waterdata.usgs.gov URL for any stream not showing above.
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                value={input} onChange={e => setInput(e.target.value)}
                placeholder="e.g. 06729500 or full URL"
                className="input"
                style={{ fontSize: 12, padding: '6px 10px' }}
                onKeyDown={e => e.key === 'Enter' && addGauge()}
              />
              <button onClick={addGauge} disabled={adding} className="btn btn-primary" style={{ padding: '6px 14px', fontSize: 12 }}>
                {adding ? '…' : 'Save'}
              </button>
            </div>
            <button onClick={() => setShowAdd(false)} style={{ marginTop: 8, fontSize: 11, color: 'var(--stone)', background: 'none', border: 'none', cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        ) : saved.length === 0 && (
          <button
            onClick={() => setShowAdd(true)}
            style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px dashed rgba(255,255,255,0.15)', borderRadius: 'var(--radius)', padding: 10, color: 'var(--stone)', fontSize: 12, cursor: 'pointer' }}
          >
            ⭐ Pin a gauge (e.g. South Boulder Creek)
          </button>
        )}
      </div>
    </>
  )
}
