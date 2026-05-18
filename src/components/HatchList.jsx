import { useState } from 'react'

function HatchModal({ hatch, onClose }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-title">
          🪲 {hatch.name}
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div style={{ marginBottom: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--stone)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Intensity: 
          </span>
          <span style={{ 
            fontSize: 13, marginLeft: 6, color: 
            hatch.intensity === 'Heavy' ? 'var(--good)' :
            hatch.intensity === 'Moderate' ? 'var(--warn)' : 'var(--stone)'
          }}>
            {hatch.intensity}
          </span>
        </div>
        {hatch.flies?.length > 0 && (
          <div>
            <div style={{ fontSize: 12, color: 'var(--stone)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
              Recommended Flies
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {hatch.flies.map((f, i) => (
                <span key={i} className="chip" style={{ cursor: 'default' }}>🪶 {f}</span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default function HatchList({ hatches }) {
  const [selected, setSelected] = useState(null)

  if (!hatches?.length) return (
    <div style={{ fontSize: 13, color: 'var(--stone)' }}>No major hatches this month</div>
  )

  return (
    <>
      {hatches.map((h, i) => (
        <div key={i} style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '10px 0', borderBottom: i < hatches.length - 1 ? '1px solid var(--border)' : 'none',
        }}>
          <span style={{ fontSize: 14, color: 'var(--foam)' }}>{h.name}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              fontSize: 12, fontStyle: 'italic',
              color: h.intensity === 'Heavy' ? 'var(--good)' : h.intensity === 'Moderate' ? 'var(--warn)' : 'var(--stone)'
            }}>
              {h.intensity}
            </span>
            <button
              onClick={() => setSelected(h)}
              style={{ background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: 6, padding: '2px 8px', fontSize: 11, color: 'var(--stone)', cursor: 'pointer' }}
            >
              ℹ
            </button>
          </div>
        </div>
      ))}
      {selected && <HatchModal hatch={selected} onClose={() => setSelected(null)} />}
    </>
  )
}
