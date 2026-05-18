import { useState, useRef, useEffect } from 'react'
import { geocode } from '../lib/api'

export default function LocationSearch({ onSelect, initialValue = '', placeholder = 'Search river, city, or state…' }) {
  const [query, setQuery] = useState(initialValue)
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const timer = useRef(null)

  useEffect(() => { setQuery(initialValue) }, [initialValue])

  function handleChange(e) {
    const v = e.target.value
    setQuery(v)
    clearTimeout(timer.current)
    if (v.length < 2) { setResults([]); setOpen(false); return }
    timer.current = setTimeout(async () => {
      setLoading(true)
      const res = await geocode(v).catch(() => [])
      setResults(res)
      setOpen(res.length > 0)
      setLoading(false)
    }, 400)
  }

  function handleSelect(r) {
    setQuery(r.label.split(',')[0])
    setOpen(false)
    onSelect(r)
  }

  return (
    <div style={{ position: 'relative', marginBottom: 12 }}>
      <input
        className="input"
        value={query}
        onChange={handleChange}
        placeholder={placeholder}
        onFocus={() => results.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
      />
      {loading && (
        <div style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: 'var(--stone)' }}>
          …
        </div>
      )}
      {open && results.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
          background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 10,
          marginTop: 4, overflow: 'hidden', boxShadow: 'var(--shadow)',
        }}>
          {results.map((r, i) => (
            <button
              key={i}
              onMouseDown={() => handleSelect(r)}
              style={{
                display: 'block', width: '100%', padding: '10px 14px', background: 'none',
                border: 'none', color: 'var(--foam)', fontSize: 13, textAlign: 'left',
                cursor: 'pointer', borderBottom: i < results.length - 1 ? '1px solid var(--border)' : 'none',
              }}
              onMouseEnter={e => e.target.style.background = 'rgba(255,255,255,0.05)'}
              onMouseLeave={e => e.target.style.background = 'none'}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
