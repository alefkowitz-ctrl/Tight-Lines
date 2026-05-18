import { useState, useEffect } from 'react'
import { fetchUSGSRange } from '../lib/api'

const PERIODS = [
  { label: '7d', days: 7 },
  { label: '14d', days: 14 },
  { label: '30d', days: 30 },
]

export default function GaugeChart({ siteNo, siteName, initialCFS }) {
  const [points, setPoints] = useState([])
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState(7)

  useEffect(() => {
    setLoading(true)
    fetchUSGSRange(siteNo, period).then(data => {
      setPoints(data)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [siteNo, period])

  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
      {/* Period selector */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        {PERIODS.map(p => (
          <button
            key={p.days}
            onClick={() => setPeriod(p.days)}
            style={{
              padding: '2px 10px', borderRadius: 20, fontSize: 11, border: '1px solid',
              background: period === p.days ? 'var(--gold)' : 'transparent',
              borderColor: period === p.days ? 'var(--gold)' : 'var(--border)',
              color: period === p.days ? '#0d1f1a' : 'var(--stone)',
              cursor: 'pointer', fontFamily: 'var(--font-mono)',
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      {loading && <div className="loading" style={{ padding: '4px 0', fontSize: 12 }}>Loading chart…</div>}
      {!loading && !points.length && (
        <div style={{ fontSize: 12, color: 'var(--stone)', padding: '4px 0' }}>No data for this period</div>
      )}
      {!loading && points.length > 0 && (() => {
        const W = 340, H = 80, PAD = 8
        const vals = points.map(p => p.cfs)
        const minV = Math.min(...vals), maxV = Math.max(...vals)
        const range = maxV - minV || 1
        const minT = points[0].t, maxT = points[points.length - 1].t
        const tRange = maxT - minT || 1
        const px = t => PAD + ((t - minT) / tRange) * (W - PAD * 2)
        const py = v => H - PAD - ((v - minV) / range) * (H - PAD * 2)
        const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${px(p.t).toFixed(1)} ${py(p.cfs).toFixed(1)}`).join(' ')
        const areaD = pathD + ` L ${px(maxT).toFixed(1)} ${H} L ${px(minT).toFixed(1)} ${H} Z`
        const lastP = points[points.length - 1]
        return (
          <>
            <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
              <defs>
                <linearGradient id={`grad-${siteNo}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="rgba(200,168,75,0.3)" />
                  <stop offset="100%" stopColor="rgba(200,168,75,0)" />
                </linearGradient>
              </defs>
              <path d={areaD} fill={`url(#grad-${siteNo})`} />
              <path d={pathD} fill="none" stroke="var(--gold)" strokeWidth="1.5" strokeLinejoin="round" />
              <circle cx={px(lastP.t)} cy={py(lastP.cfs)} r={4} fill="var(--gold)" />
            </svg>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--stone)', marginTop: 2 }}>
              <span>{period}d ago</span>
              <span>Now · {Math.round(lastP.cfs)} CFS</span>
            </div>
          </>
        )
      })()}
    </div>
  )
}
