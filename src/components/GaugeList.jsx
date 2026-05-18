import { useState } from 'react'
import { cfsLabel } from '../lib/utils'
import { fetchUSGSTemp } from '../lib/api'
import GaugeChart from './GaugeChart'

function GaugeRow({ g }) {
  const [expanded, setExpanded] = useState(false)
  const { label, cls } = cfsLabel(g.cfs)

  return (
    <div className="gauge-item" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div className="gauge-name">{g.name}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 2, alignItems: 'center' }}>
            <span className="gauge-cfs">{g.cfs != null ? g.cfs.toLocaleString() + ' CFS' : '—'}</span>
            {g.waterTempF && (
              <span style={{ fontSize: 11, color: 'var(--sky)' }}>💧 {Math.round(g.waterTempF)}°F</span>
            )}
            {g.distMi != null && (
              <span className="gauge-dist">{g.distMi}mi</span>
            )}
          </div>
        </div>
        <div className="gauge-right">
          <span className={`badge badge-${cls}`}>{label}</span>
          {g.siteNo && (
            <button className="gauge-chart-toggle" onClick={() => setExpanded(v => !v)}>
              {expanded ? '▲ chart' : '▼ chart'}
            </button>
          )}
        </div>
      </div>
      {expanded && g.siteNo && (
        <GaugeChart siteNo={g.siteNo} siteName={g.name} initialCFS={g.cfs} />
      )}
    </div>
  )
}

export default function GaugeList({ gauges }) {
  if (!gauges.length) return (
    <div style={{ fontSize: 13, color: 'var(--stone)', padding: '8px 0' }}>No gauges found</div>
  )
  return (
    <div>
      {gauges.map((g, i) => <GaugeRow key={g.siteNo || i} g={g} />)}
    </div>
  )
}
