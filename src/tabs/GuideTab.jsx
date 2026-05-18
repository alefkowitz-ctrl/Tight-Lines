import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { askClaude } from '../lib/api'
import SavedGauges from '../components/SavedGauges'

export default function GuideTab({ user, loc }) {
  const [catches, setCatches] = useState([])
  const [trips, setTrips] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeSection, setActiveSection] = useState('stats')

  useEffect(() => {
    if (!user) return
    async function load() {
      const [{ data: cData }, { data: tData }] = await Promise.all([
        sb.from('catches').select('*').eq('user_id', user.id).order('created_at', { ascending: false }),
        sb.from('trips').select('id,date,location,catches,flies,stream_cfs,air_temp,weather_conditions,guide_notes,trip_cost,tip_amount').eq('user_id', user.id).order('date', { ascending: false }),
      ])
      if (cData) setCatches(cData)
      if (tData) setTrips(tData)
      setLoading(false)
    }
    load()
  }, [user])

  if (loading) return <div className="loading">Loading…</div>

  // Stats
  const totalCatches = catches.length
  const totalTrips = trips.length
  const totalRevenue = trips.reduce((sum, t) => sum + (parseFloat(t.trip_cost) || 0), 0)
  const totalTips = trips.reduce((sum, t) => sum + (parseFloat(t.tip_amount) || 0), 0)
  const speciesCounts = catches.reduce((acc, c) => { acc[c.species] = (acc[c.species] || 0) + 1; return acc }, {})
  const topSpecies = Object.entries(speciesCounts).sort((a, b) => b[1] - a[1]).slice(0, 5)
  const avgCatchesPerTrip = totalTrips > 0 ? (totalCatches / totalTrips).toFixed(1) : '—'

  return (
    <div>
      {/* Section tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, background: 'rgba(0,0,0,0.25)', borderRadius: 12, padding: 4 }}>
        {[['stats', '📊 Stats'], ['season', '📅 Season Log'], ['gauges', '⭐ My Gauges']].map(([id, label]) => (
          <button key={id} onClick={() => setActiveSection(id)} style={{ flex: 1, padding: '8px 4px', borderRadius: 9, border: 'none', background: activeSection === id ? 'var(--surface2)' : 'none', color: activeSection === id ? 'var(--foam)' : 'var(--stone)', fontSize: 12, cursor: 'pointer', fontFamily: 'var(--font-body)', transition: 'all 0.2s' }}>
            {label}
          </button>
        ))}
      </div>

      {/* Stats */}
      {activeSection === 'stats' && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
            {[
              { label: 'Total Catches', value: totalCatches, color: 'var(--foam)' },
              { label: 'Guide Trips', value: totalTrips, color: 'var(--foam)' },
              { label: 'Revenue', value: totalRevenue > 0 ? '$' + totalRevenue.toLocaleString() : '—', color: 'var(--good)' },
              { label: 'Tips', value: totalTips > 0 ? '$' + totalTips.toLocaleString() : '—', color: 'var(--good)' },
              { label: 'Avg Catches / Trip', value: avgCatchesPerTrip, color: 'var(--foam)' },
              { label: 'This Month', value: catches.filter(c => new Date(c.created_at) > new Date(Date.now() - 30 * 86400000)).length, color: 'var(--foam)' },
            ].map(({ label, value, color }) => (
              <div key={label} className="card" style={{ padding: '12px 14px', margin: 0 }}>
                <div style={{ fontSize: 22, color, fontFamily: 'var(--font-display)' }}>{value}</div>
                <div style={{ fontSize: 11, color: 'var(--stone)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 2 }}>{label}</div>
              </div>
            ))}
          </div>

          {topSpecies.length > 0 && (
            <div className="card">
              <div className="card-title">🐟 Top Species</div>
              {topSpecies.map(([species, count], i) => (
                <div key={species} style={{ marginBottom: i < topSpecies.length - 1 ? 10 : 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 3 }}>
                    <span style={{ color: 'var(--foam)' }}>{species}</span>
                    <span style={{ color: 'var(--stone)' }}>{count}</span>
                  </div>
                  <div style={{ height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2 }}>
                    <div style={{ height: '100%', background: 'var(--good)', borderRadius: 2, width: `${(count / topSpecies[0][1]) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {catches.length > 0 && (() => {
            const flyCount = catches.flatMap(c => c.flies || []).reduce((acc, f) => { acc[f] = (acc[f] || 0) + 1; return acc }, {})
            const topFlies = Object.entries(flyCount).sort((a, b) => b[1] - a[1]).slice(0, 5)
            if (!topFlies.length) return null
            return (
              <div className="card">
                <div className="card-title">🪶 Top Flies</div>
                {topFlies.map(([fly, count]) => (
                  <div key={fly} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                    <span style={{ color: 'var(--foam)' }}>{fly}</span>
                    <span style={{ color: 'var(--stone)' }}>{count}×</span>
                  </div>
                ))}
              </div>
            )
          })()}
        </div>
      )}

      {/* Season Log */}
      {activeSection === 'season' && (
        <div>
          <div className="card-title" style={{ marginBottom: 12 }}>📅 Recent Trips</div>
          {trips.length === 0 && <div className="info-box">No trips logged yet.<br /><br />Add clients and trips in the Trips tab.</div>}
          {trips.slice(0, 20).map(t => (
            <div key={t.id} className="card" style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontStyle: 'italic', color: 'var(--foam)' }}>{t.location || 'Unnamed Location'}</div>
                  <div style={{ fontSize: 12, color: 'var(--stone)', marginTop: 3 }}>{t.date}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  {t.catches > 0 && <div style={{ fontSize: 14, color: 'var(--foam)' }}>🐟 {t.catches}</div>}
                  {t.stream_cfs && <div style={{ fontSize: 11, color: 'var(--sky)' }}>{t.stream_cfs} CFS</div>}
                </div>
              </div>
              {t.flies?.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                  {t.flies.slice(0, 3).map((f, i) => <span key={i} className="chip" style={{ cursor: 'default', fontSize: 11 }}>🪶 {f}</span>)}
                  {t.flies.length > 3 && <span style={{ fontSize: 11, color: 'var(--stone)' }}>+{t.flies.length - 3} more</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* My Gauges */}
      {activeSection === 'gauges' && (
        <div>
          <div className="card-sub" style={{ marginBottom: 12 }}>Pin any USGS gauge to keep it at the top of your Conditions tab.</div>
          <SavedGauges user={user} />
        </div>
      )}
    </div>
  )
}
