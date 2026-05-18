import { useState, lazy, Suspense } from 'react'
import { sb } from './lib/supabase'
import { useAuth } from './hooks/useAuth'
import AuthScreen from './components/AuthScreen'
import ConditionsTab from './tabs/ConditionsTab'
import CatchLogTab from './tabs/CatchLogTab'

// Lazy load heavier tabs
const TripsTab = lazy(() => import('./tabs/TripsTab'))
const GuideTab = lazy(() => import('./tabs/GuideTab'))

const TABS = [
  { id: 'conditions', label: 'Conditions', icon: '🌤' },
  { id: 'catches', label: 'Catch Log', icon: '🐟' },
  { id: 'trips', label: 'Trips', icon: '🗓' },
  { id: 'guide', label: 'Guide', icon: '🧭' },
]

export default function App() {
  const { user, loading } = useAuth()
  const [tab, setTab] = useState('conditions')
  const [loc, setLoc] = useState(() => {
    try { return JSON.parse(localStorage.getItem('tl_loc')) } catch { return null }
  })

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--stone)' }}>
      <div className="loading">Loading…</div>
    </div>
  )

  if (!user) return <AuthScreen />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div className="app-header">
        <button className="signout-btn" onClick={() => sb.auth.signOut()}>Sign Out</button>
        <h1 className="app-title">Guide's <em>Choice</em></h1>
        <div className="app-subtitle">Fly Fishing Journal</div>
        {user.email && <div className="app-email">{user.email}</div>}
      </div>

      {/* Nav */}
      <nav className="nav">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`nav-item ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <span>{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>

      {/* Content */}
      <div className="tab-content">
        <Suspense fallback={<div className="loading">Loading…</div>}>
          {tab === 'conditions' && <ConditionsTab user={user} />}
          {tab === 'catches' && <CatchLogTab user={user} loc={loc} />}
          {tab === 'trips' && <TripsTab user={user} loc={loc} />}
          {tab === 'guide' && <GuideTab user={user} loc={loc} />}
        </Suspense>
      </div>
    </div>
  )
}
