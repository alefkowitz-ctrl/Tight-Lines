import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { fetchWeather, fetchUSGSLive } from '../lib/api'
import { windDir, cfsLabel } from '../lib/utils'

const FISHING_STYLES = ['Nymphing', 'Dry Fly', 'Streamer', 'Wet Fly', 'Euro Nymphing', 'Indicator', 'Sight Fishing']
const TRIP_TYPES = ['Wade', 'Float', 'Boat', 'Stillwater']
const SKILL_LEVELS = ['Beginner', 'Intermediate', 'Advanced', 'Expert']
const BLANK_TRIP = { date: new Date().toISOString().split('T')[0], location: '', type: 'Wade', styles: [], catches: '', flies: [], flyInput: '', gear: '', guideNotes: '', tripCost: '', tipAmount: '', airTemp: '', waterTemp: '', weatherConditions: '', windSpeed: '', windDir: '', streamCFS: '', streamCondition: '', streamGaugeName: '' }
const WX = { 0:'Sunny',1:'Mainly Clear',2:'Partly Cloudy',3:'Overcast',45:'Foggy',61:'Rain',63:'Rain',80:'Showers',95:'Thunderstorm' }

function GuestForm({ initial, onSave, onCancel, title }) {
  const [form, setForm] = useState(initial || { name:'',email:'',phone:'',notes:'',dietary:'',skillLevel:'' })
  const f = k => e => setForm(g => ({ ...g, [k]: e.target.value }))
  return (
    <div>
      <div className="modal-title">{title}</div>
      <div className="form-group"><label className="form-label">Name *</label><input className="input" value={form.name} onChange={f('name')} placeholder="Full name" /></div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
        <div className="form-group"><label className="form-label">Email</label><input className="input" type="email" value={form.email} onChange={f('email')} /></div>
        <div className="form-group"><label className="form-label">Phone</label><input className="input" type="tel" value={form.phone} onChange={f('phone')} /></div>
      </div>
      <div className="form-group"><label className="form-label">Skill Level</label>
        <select className="input" value={form.skillLevel} onChange={f('skillLevel')}>
          <option value="">Select...</option>{SKILL_LEVELS.map(s=><option key={s}>{s}</option>)}
        </select>
      </div>
      <div className="form-group"><label className="form-label">Dietary / Allergies</label><input className="input" value={form.dietary} onChange={f('dietary')} /></div>
      <div className="form-group"><label className="form-label">Notes</label><textarea className="input" value={form.notes} onChange={f('notes')} rows={3} /></div>
      <div style={{display:'flex',gap:8}}>
        <button className="btn btn-primary" style={{flex:1}} onClick={()=>form.name&&onSave(form)} disabled={!form.name}>Save</button>
        <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

function TripForm({ initial, guestName, onSave, onCancel }) {
  const [form, setForm] = useState(initial || BLANK_TRIP)
  const [fetching, setFetching] = useState(false)
  const f = k => e => setForm(t => ({ ...t, [k]: e.target.value }))
  const fv = (k, v) => setForm(t => ({ ...t, [k]: v }))

  async function fetchConds() {
    if (!form.location) return
    setFetching(true)
    try {
      const r = await fetch('https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(form.location) + '&format=json&limit=1')
      const d = await r.json()
      if (!d.length) { setFetching(false); return }
      const lat = parseFloat(d[0].lat), lng = parseFloat(d[0].lon)
      const [wx, usgs] = await Promise.all([fetchWeather(lat, lng), fetchUSGSLive(lat, lng)])
      const cur = wx.current
      setForm(t => ({ ...t, airTemp: String(Math.round(cur.temperature_2m)), weatherConditions: WX[cur.weathercode] || '', windSpeed: String(Math.round(cur.windspeed_10m)), windDir: windDir(cur.winddirection_10m) }))
      const ts = usgs.value?.timeSeries || []
      const near = ts.map(t2 => { const raw = t2.values?.[0]?.value?.[0]?.value; const cfs = raw != null ? parseFloat(raw) : null; const sLat = parseFloat(t2.sourceInfo?.geoLocation?.geogLocation?.latitude || 0); const sLng = parseFloat(t2.sourceInfo?.geoLocation?.geogLocation?.longitude || 0); return { name: t2.sourceInfo?.siteName || '', cfs, dist: Math.sqrt((sLat-lat)**2+(sLng-lng)**2) } }).filter(x=>x.cfs!=null&&x.cfs>=0).sort((a,b)=>a.dist-b.dist)[0]
      if (near) setForm(t => ({ ...t, streamCFS: String(Math.round(near.cfs)), streamCondition: cfsLabel(near.cfs).label, streamGaugeName: near.name }))
    } catch (e) { console.log('fetchConds error:', e.message) }
    setFetching(false)
  }

  function addFly() { if (!form.flyInput?.trim()) return; setForm(t => ({ ...t, flies: [...t.flies, t.flyInput.trim()], flyInput: '' })) }
  function toggleStyle(s) { setForm(t => ({ ...t, styles: t.styles.includes(s) ? t.styles.filter(x=>x!==s) : [...t.styles, s] })) }

  return (
    <div>
      <div className="modal-title">Add Trip{guestName && <span style={{fontSize:14,color:'var(--stone)',fontWeight:400}}> — {guestName}</span>}</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
        <div className="form-group"><label className="form-label">Date</label><input className="input" type="date" value={form.date} onChange={f('date')} /></div>
        <div className="form-group"><label className="form-label">Type</label><select className="input" value={form.type} onChange={f('type')}>{TRIP_TYPES.map(t=><option key={t}>{t}</option>)}</select></div>
      </div>
      <div className="form-group"><label className="form-label">Location</label>
        <div style={{display:'flex',gap:6}}>
          <input className="input" value={form.location} onChange={f('location')} placeholder="River or access point" />
          <button className="btn btn-secondary" onClick={fetchConds} disabled={fetching||!form.location} style={{flexShrink:0,fontSize:12}}>{fetching?'…':'🌤 Auto'}</button>
        </div>
      </div>
      <div className="form-group"><label className="form-label">Fishing Styles</label>
        <div style={{display:'flex',flexWrap:'wrap',gap:6}}>{FISHING_STYLES.map(s=><button key={s} onClick={()=>toggleStyle(s)} className={'chip'+(form.styles.includes(s)?' active':'')}>{s}</button>)}</div>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
        <div className="form-group"><label className="form-label">Est. Catches</label><input className="input" type="number" value={form.catches} onChange={f('catches')} /></div>
        <div className="form-group"><label className="form-label">Water Temp °F</label><input className="input" type="number" value={form.waterTemp} onChange={f('waterTemp')} /></div>
      </div>
      {(form.airTemp||form.streamCFS) && (
        <div style={{background:'rgba(0,0,0,0.2)',borderRadius:10,padding:'8px 12px',marginBottom:12,fontSize:12,color:'var(--stone)'}}>
          {form.airTemp&&<span style={{marginRight:10}}>🌡 {form.airTemp}°F {form.weatherConditions}</span>}
          {form.streamCFS&&<span>💧 {form.streamCFS} CFS ({form.streamCondition})</span>}
        </div>
      )}
      <div className="form-group"><label className="form-label">Flies Used</label>
        <div style={{display:'flex',flexWrap:'wrap',gap:6,marginBottom:6}}>
          {form.flies.map((fly,i)=><span key={i} className="chip">🪶 {fly}<button onClick={()=>setForm(t=>({...t,flies:t.flies.filter((_,j)=>j!==i)}))} style={{background:'none',border:'none',color:'var(--stone)',cursor:'pointer',marginLeft:2}}>✕</button></span>)}
        </div>
        <div style={{display:'flex',gap:6}}><input className="input" value={form.flyInput||''} onChange={f('flyInput')} placeholder="Add fly pattern" onKeyDown={e=>e.key==='Enter'&&addFly()} /><button className="btn btn-secondary" onClick={addFly} style={{flexShrink:0}}>Add</button></div>
      </div>
      <div className="form-group"><label className="form-label">Gear / Setup</label><input className="input" value={form.gear} onChange={f('gear')} /></div>
      <div className="form-group"><label className="form-label">Guide Notes (private)</label><textarea className="input" value={form.guideNotes} onChange={f('guideNotes')} rows={3} /></div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
        <div className="form-group"><label className="form-label">Trip Cost ($)</label><input className="input" type="number" value={form.tripCost} onChange={f('tripCost')} /></div>
        <div className="form-group"><label className="form-label">Tip ($)</label><input className="input" type="number" value={form.tipAmount} onChange={f('tipAmount')} /></div>
      </div>
      <div style={{display:'flex',gap:8}}><button className="btn btn-primary" style={{flex:1}} onClick={()=>onSave(form)}>Save Trip</button><button className="btn btn-secondary" onClick={onCancel}>Cancel</button></div>
    </div>
  )
}

function TripDetail({ trip, guest, onBack, onReport, reportLoading }) {
  return (
    <div>
      <button className="btn btn-ghost" onClick={onBack} style={{marginBottom:12}}>← Back to {guest?.name}</button>
      <div className="card">
        <div style={{fontFamily:'var(--font-display)',fontSize:20,fontStyle:'italic',color:'var(--foam)',marginBottom:4}}>{trip.location||'Untitled Trip'}</div>
        <div style={{fontSize:13,color:'var(--stone)',marginBottom:12}}>{trip.date} · {trip.type}</div>
        {trip.styles?.length>0&&<div style={{display:'flex',flexWrap:'wrap',gap:6,marginBottom:10}}>{trip.styles.map(s=><span key={s} className="chip" style={{cursor:'default'}}>{s}</span>)}</div>}
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:10}}>
          {trip.catches!=null&&<div style={{background:'rgba(0,0,0,0.2)',borderRadius:8,padding:'8px 12px'}}><div style={{fontSize:20,color:'var(--foam)'}}>{trip.catches}</div><div style={{fontSize:11,color:'var(--stone)',textTransform:'uppercase',letterSpacing:'0.06em'}}>Catches</div></div>}
          {trip.tripCost&&<div style={{background:'rgba(0,0,0,0.2)',borderRadius:8,padding:'8px 12px'}}><div style={{fontSize:20,color:'var(--good)'}}>${trip.tripCost}</div><div style={{fontSize:11,color:'var(--stone)',textTransform:'uppercase',letterSpacing:'0.06em'}}>Revenue</div></div>}
        </div>
        {trip.flies?.length>0&&<div style={{marginBottom:10}}><div style={{fontSize:12,color:'var(--stone)',textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:6}}>Flies</div><div style={{display:'flex',flexWrap:'wrap',gap:6}}>{trip.flies.map((f,i)=><span key={i} className="chip" style={{cursor:'default'}}>🪶 {f}</span>)}</div></div>}
        {trip.guideNotes&&<div style={{marginBottom:10,padding:'10px 12px',background:'rgba(0,0,0,0.2)',borderRadius:8}}><div style={{fontSize:11,color:'var(--stone)',textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:4}}>Guide Notes</div><div style={{fontSize:13,color:'var(--stone)',fontStyle:'italic'}}>{trip.guideNotes}</div></div>}
        {trip.reportText&&<div style={{marginTop:10,padding:'12px 14px',background:'rgba(200,168,75,0.06)',borderRadius:10,borderLeft:'3px solid var(--gold)'}}><div style={{fontSize:11,color:'var(--gold)',textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:6}}>Client Report</div><div style={{fontSize:13,color:'var(--foam)',lineHeight:1.75,fontFamily:'var(--font-body)',whiteSpace:'pre-wrap'}}>{trip.reportText}</div></div>}
        <button className="btn btn-primary btn-full" style={{marginTop:14}} onClick={()=>onReport(trip,guest)} disabled={reportLoading}>{reportLoading?'Generating…':'✦ Generate Client Report'}</button>
      </div>
    </div>
  )
}

export default function TripsTab({ user }) {
  const [guests, setGuests] = useState([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState('list')
  const [selGuest, setSelGuest] = useState(null)
  const [selTrip, setSelTrip] = useState(null)
  const [reportLoading, setReportLoading] = useState(false)

  useEffect(() => {
    if (!user) return
    async function load() {
      const { data: gData } = await sb.from('guests').select('*').eq('user_id', user.id).order('name')
      const { data: tData } = await sb.from('trips').select('*').eq('user_id', user.id).order('date', { ascending: false })
      if (gData) {
        setGuests(gData.map(g => ({
          ...g, skillLevel: g.skill_level,
          trips: (tData||[]).filter(t=>t.guest_id===g.id).map(t=>({
            id:t.id,date:t.date,location:t.location,type:t.type,styles:t.styles||[],catches:t.catches||0,flies:t.flies||[],gear:t.gear,guideNotes:t.guide_notes,photos:[],tripCost:t.trip_cost,tipAmount:t.tip_amount,reportText:t.report_text,airTemp:t.air_temp,waterTemp:t.water_temp,weatherConditions:t.weather_conditions,windSpeed:t.wind_speed,windDir:t.wind_dir,streamCFS:t.stream_cfs,streamCondition:t.stream_condition,streamGaugeName:t.stream_gauge_name,catchDetails:t.catch_details||[]
          }))
        })))
      }
      setLoading(false)
    }
    load()
  }, [user])

  async function saveGuest(form) {
    const payload = { user_id:user.id, name:form.name, email:form.email, phone:form.phone, notes:form.notes, dietary:form.dietary, skill_level:form.skillLevel }
    if (view==='editGuest'&&selGuest) { await sb.from('guests').update(payload).eq('id',selGuest.id); setGuests(gs=>gs.map(g=>g.id===selGuest.id?{...g,...form,trips:g.trips}:g)); setSelGuest(g=>({...g,...form})) }
    else { const {data}=await sb.from('guests').insert(payload).select().single(); if(data) setGuests(gs=>[...gs,{...form,id:data.id,trips:[]}]) }
    setView(view==='editGuest'?'guest':'list')
  }

  async function deleteGuest(id) {
    if (!window.confirm('Delete this client and all their trips?')) return
    await sb.from('trips').delete().eq('guest_id',id); await sb.from('guests').delete().eq('id',id)
    setGuests(gs=>gs.filter(g=>g.id!==id)); setView('list')
  }

  async function saveTrip(form) {
    const { data } = await sb.from('trips').insert({ user_id:user.id,guest_id:selGuest.id,date:form.date,location:form.location,type:form.type,styles:form.styles,catches:parseInt(form.catches)||0,flies:form.flies,gear:form.gear,guide_notes:form.guideNotes,trip_cost:parseFloat(form.tripCost)||null,tip_amount:parseFloat(form.tipAmount)||null,air_temp:form.airTemp,water_temp:form.waterTemp,weather_conditions:form.weatherConditions,wind_speed:form.windSpeed,wind_dir:form.windDir,stream_cfs:form.streamCFS,stream_condition:form.streamCondition,stream_gauge_name:form.streamGaugeName }).select().single()
    if (data) {
      const trip = { ...form, id:data.id, catches:parseInt(form.catches)||0 }
      setGuests(gs=>gs.map(g=>g.id===selGuest.id?{...g,trips:[trip,...(g.trips||[])]}:g))
      setSelGuest(g=>({...g,trips:[trip,...(g.trips||[])]}))
    }
    setView('guest')
  }

  async function generateReport(trip, guest) {
    setReportLoading(true)
    try {
      const parts = ['You are a fly fishing guide writing a trip summary for a client. Only use facts provided. Do not invent anything.','FACTS:','Client: '+guest.name,'Date: '+trip.date,'Location: '+(trip.location||'not specified'),'Type: '+trip.type,'Styles: '+(trip.styles?.join(', ')||'not specified'),'Catches: '+trip.catches,'Flies: '+(trip.flies?.join(', ')||'not specified'),'Gear: '+(trip.gear||'not specified'),'Conditions: '+[trip.airTemp&&trip.airTemp+'°F',trip.weatherConditions,trip.streamCFS&&trip.streamCFS+' CFS'].filter(Boolean).join(', '),'Guide notes: '+(trip.guideNotes||'none'),'Write a warm 2-3 paragraph trip summary. Second person. Plain text only.']
      const res = await fetch('/api/claude', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:500, messages:[{role:'user',content:parts.join(' ')}] }) })
      const d = await res.json()
      const txt = (d.content||[]).map(b=>b.text||'').join('')
      if (txt) {
        await sb.from('trips').update({ report_text:txt }).eq('id',trip.id)
        setSelTrip(t=>({...t,reportText:txt}))
        setGuests(gs=>gs.map(g=>({...g,trips:(g.trips||[]).map(t=>t.id===trip.id?{...t,reportText:txt}:t)})))
      }
    } catch (e) { console.log('report error:', e.message) }
    setReportLoading(false)
  }

  if (loading) return <div className="loading">Loading clients…</div>

  if (view==='addGuest'||view==='editGuest') return <GuestForm initial={view==='editGuest'?selGuest:undefined} title={view==='editGuest'?'Edit Client':'Add Client'} onSave={saveGuest} onCancel={()=>setView(view==='editGuest'?'guest':'list')} />
  if (view==='addTrip') return <TripForm guestName={selGuest?.name} onSave={saveTrip} onCancel={()=>setView('guest')} />
  if (view==='tripDetail'&&selTrip) return <TripDetail trip={selTrip} guest={selGuest} onBack={()=>setView('guest')} onReport={generateReport} reportLoading={reportLoading} />

  if (view==='guest'&&selGuest) return (
    <div>
      <button className="btn btn-ghost" onClick={()=>setView('list')} style={{marginBottom:12}}>← All Clients</button>
      <div className="card">
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
          <div>
            <div style={{fontFamily:'var(--font-display)',fontSize:22,color:'var(--foam)'}}>{selGuest.name}</div>
            {selGuest.skillLevel&&<div style={{fontSize:12,color:'var(--stone)',marginTop:2}}>🎣 {selGuest.skillLevel}</div>}
            {selGuest.email&&<div style={{fontSize:12,color:'var(--sky)',marginTop:4}}>{selGuest.email}</div>}
            {selGuest.phone&&<div style={{fontSize:12,color:'var(--stone)',marginTop:2}}>{selGuest.phone}</div>}
          </div>
          <div style={{display:'flex',gap:6}}>
            <button className="btn btn-secondary" style={{fontSize:12,padding:'6px 12px'}} onClick={()=>setView('editGuest')}>Edit</button>
            <button className="btn btn-ghost" style={{fontSize:12,color:'var(--danger)'}} onClick={()=>deleteGuest(selGuest.id)}>Delete</button>
          </div>
        </div>
        {selGuest.notes&&<div style={{fontSize:13,color:'var(--stone)',marginTop:10,fontStyle:'italic'}}>{selGuest.notes}</div>}
      </div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
        <span style={{fontSize:14,color:'var(--gold)',fontFamily:'var(--font-display)'}}>Trips ({(selGuest.trips||[]).length})</span>
        <button className="btn btn-primary" style={{fontSize:13,padding:'7px 14px'}} onClick={()=>setView('addTrip')}>+ Add Trip</button>
      </div>
      {(selGuest.trips||[]).length===0&&<div className="info-box">No trips yet.</div>}
      {(selGuest.trips||[]).map(trip=>(
        <div key={trip.id} className="trip-card" style={{cursor:'pointer'}} onClick={()=>{setSelTrip(trip);setView('tripDetail')}}>
          <div className="trip-title">{trip.location||'Untitled Trip'}</div>
          <div className="trip-meta"><span>📅 {trip.date}</span><span>🚶 {trip.type}</span>{trip.catches>0&&<span>🐟 {trip.catches} fish</span>}{trip.tripCost&&<span style={{color:'var(--good)'}}>💵 ${trip.tripCost}</span>}</div>
          {trip.reportText&&<div style={{fontSize:11,color:'var(--good)',marginTop:4}}>✓ Report ready</div>}
        </div>
      ))}
    </div>
  )

  return (
    <div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
        <div style={{fontFamily:'var(--font-display)',fontSize:18,color:'var(--gold)'}}>Guide Book · {guests.length} Clients</div>
        <button className="btn btn-primary" style={{fontSize:13,padding:'8px 16px'}} onClick={()=>setView('addGuest')}>+ Client</button>
      </div>
      {guests.length===0&&<div className="info-box">No clients yet.<br/><br/>Add your first client to start tracking guided trips.</div>}
      {guests.map(g=>(
        <div key={g.id} className="card" style={{cursor:'pointer'}} onClick={()=>{setSelGuest(g);setView('guest')}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <div><div style={{fontFamily:'var(--font-display)',fontSize:16,color:'var(--foam)'}}>{g.name}</div><div style={{fontSize:12,color:'var(--stone)',marginTop:3}}>{(g.trips||[]).length} trip{g.trips?.length!==1?'s':''}{g.skillLevel&&' · '+g.skillLevel}</div></div>
            <span style={{color:'var(--stone)',fontSize:18}}>›</span>
          </div>
        </div>
      ))}
    </div>
  )
}
