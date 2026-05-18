import { useState, useEffect } from 'react'
import { fetchUSGSRange } from '../lib/api'

export default function GaugeChart({ siteNo, siteName, initialCFS }) {
  const [points, setPoints] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchUSGSRange(siteNo, 7).then(data => {
      setPoints(data)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [siteNo])

  if (loading) return <div className="loading" style={{ padding: '8px 0', fontSize: 12 }}>Loading chart…</div>
  if (!points.length) return <div style={{ fontSize: 12, color: 'var(--stone)', padding: '8px 0' }}>No historical data</div>

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

  // Current marker
  const lastP = points[points.length - 1]
  const cx = px(lastP.t), cy = py(lastP.cfs)

  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        <defs>
          <linearGradient id={`grad-${siteNo}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(200,168,75,0.3)" />
            <stop offset="100%" stopColor="rgba(200,168,75,0)" />
          </linearGradient>
        </defs>
        <path d={areaD} fill={`url(#grad-${siteNo})`} />
        <path d={pathD} fill="none" stroke="var(--gold)" strokeWidth="1.5" strokeLinejoin="round" />
        <circle cx={cx} cy={cy} r={4} fill="var(--gold)" />
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--stone)', marginTop: 2 }}>
        <span>7 days ago</span>
        <span>Now · {Math.round(lastP.cfs)} CFS</span>
      </div>
    </div>
  )
}
