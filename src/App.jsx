import React, { useState, useRef, useEffect, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";
import "./App.css";

// Brand Logo: icon mark + live-text wordmark, built for dark backgrounds.
function Logo({ layout = "horizontal", scale = 1, mark = true, tagline = true }) {
  const px = (n) => Math.round(n * scale);
  const stacked = layout === "stacked";
  const emblem = mark ? (
    <img src="/logo-mark.png" alt="Guide's Choice" aria-hidden="true"
      style={{ height: px(stacked ? 96 : 46), width: px(stacked ? 96 : 46), objectFit: "contain", display: "block" }} />
  ) : null;
  const title = (
    <div style={{ fontFamily: "'Playfair Display',serif", fontWeight: 600, fontSize: px(stacked ? 34 : 23), lineHeight: 1.02, letterSpacing: px(1.5), color: "var(--foam)", whiteSpace: "nowrap" }}>
      {"GUIDE'S CHOICE"}
    </div>
  );
  const tag = tagline ? (
    <div style={{ fontFamily: "'Crimson Pro',serif", fontSize: px(stacked ? 12 : 10), letterSpacing: px(3), textTransform: "uppercase", color: "var(--gold)", marginTop: px(4), whiteSpace: "nowrap" }}>
      Find the Pattern
    </div>
  ) : null;
  if (stacked) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
        {emblem && <div style={{ marginBottom: px(12) }}>{emblem}</div>}
        {title}{tag}
      </div>
    );
  }
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: px(12) }}>
      {emblem}
      <div style={{ textAlign: "left" }}>{title}{tag}</div>
    </div>
  );
}


// ── EXIF Parser ───────────────────────────────────────────────────────────────
function parseExif(buffer){
  const view=new DataView(buffer);
  const result={time:null,gps:null,lat:null,lng:null};
  if(view.getUint16(0)!==0xFFD8) return result; // not JPEG
  let offset=2;
  while(offset<view.byteLength-2){
    const marker=view.getUint16(offset);
    offset+=2;
    if(marker===0xFFE1){ // APP1 - EXIF
      const segLen=view.getUint16(offset);
      const exifStart=offset+2;
      // Check for "Exif" header
      if(view.getUint32(exifStart)===0x45786966){
        const tiffOffset=exifStart+6;
        const littleEndian=view.getUint16(tiffOffset)===0x4949;
        const get16=(o)=>view.getUint16(tiffOffset+o,littleEndian);
        const get32=(o)=>view.getUint32(tiffOffset+o,littleEndian);
        const getString=(o,len)=>{
          let s="";
          for(let i=0;i<len;i++){const c=view.getUint8(tiffOffset+o+i);if(c===0)break;s+=String.fromCharCode(c);}
          return s.trim();
        };
        const getRational=(o)=>{const num=get32(o),den=get32(o+4);return den?num/den:0;};
        const readIFD=(ifdOffset)=>{
          try{
            const count=get16(ifdOffset);
            for(let i=0;i<count;i++){
              const entryOffset=ifdOffset+2+i*12;
              const tag=get16(entryOffset);
              const type=get16(entryOffset+2);
              const numValues=get32(entryOffset+4);
              const valueOffset=entryOffset+8;
              const dataSize=[0,1,1,2,4,8,1,1,2,4,8,4,8][type]||1;
              const totalSize=dataSize*numValues;
              const dataOffset=totalSize>4?get32(valueOffset):valueOffset-tiffOffset;
              if(tag===0x9003||tag===0x0132){ // DateTimeOriginal or DateTime
                const dt=getString(totalSize>4?get32(valueOffset):valueOffset-tiffOffset,20);
                // Format: "YYYY:MM:DD HH:MM:SS"
                if(dt&&dt.length>=19){
                  const[date,time]=dt.split(" ");
                  const[y,mo,d]=date.split(":");
                  const[h,mi,s]=time.split(":");
                  if(y&&y!=="0000"){
                    const dateObj=new Date(+y,+mo-1,+d,+h,+mi,+s||0);
                    result.time=dateObj.toLocaleString("en-US",{month:"long",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit",hour12:true});
                  }
                }
              }
              if(tag===0x8825){ // GPS IFD pointer
                const gpsIFDOffset=get32(valueOffset);
                const gpsCount=get16(gpsIFDOffset);
                let latD=null,lngD=null,latRef="N",lngRef="W";
                for(let g=0;g<gpsCount;g++){
                  const ge=gpsIFDOffset+2+g*12;
                  const gtag=get16(ge);
                  const gvo=ge+8;
                  if(gtag===1){const v=view.getUint8(tiffOffset+gvo);const vc=String.fromCharCode(v);latRef=(vc==="S"||v===83)?"S":"N";}
                  if(gtag===3){const v=view.getUint8(tiffOffset+gvo);const vc=String.fromCharCode(v);lngRef=(vc==="E"||v===69)?"E":"W";void 0;}
                  if(gtag===2){try{const o2=get32(gvo);latD=getRational(o2)+getRational(o2+8)/60+getRational(o2+16)/3600;}catch{}}
                  if(gtag===4){try{const o2=get32(gvo);lngD=getRational(o2)+getRational(o2+8)/60+getRational(o2+16)/3600;}catch{}}
                }
                if(latD!=null&&lngD!=null){
                  result.lat=latRef==="S"?-latD:latD;
                  result.lng=lngRef==="W"?-lngD:lngD;
                  result.gps=Math.abs(result.lat).toFixed(4)+"°"+(result.lat>=0?"N":"S")+", "+Math.abs(result.lng).toFixed(4)+"°"+(result.lng>=0?"E":"W");
                  void 0;
                }
              }
            }
          }catch(e){}
        };
        const ifd0=get32(4);
        readIFD(ifd0);
      }
      offset+=segLen;
    } else if((marker&0xFF00)===0xFF00){
      offset+=view.getUint16(offset);
    } else break;
  }
  return result;
}

// ── Storage Upload Helper (module-level, used by both App and GuideBook) ──────
async function uploadPhotoToStorage(base64DataUrl, folder){
  if(!sb) return null;
  try{
    const res=await fetch(base64DataUrl);
    const blob=await res.blob();
    const ext=blob.type.split("/")[1]||"jpg";
    const fileName=`${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const {data,error}=await sb.storage.from("trip-photos").upload(fileName,blob,{contentType:blob.type,upsert:false});
    if(error){void 0;return null;}
    const {data:{publicUrl}}=sb.storage.from("trip-photos").getPublicUrl(fileName);
    return publicUrl;
  }catch(e){void 0;return null;}
}



// ── Supabase Config ───────────────────────────────────────────────────────────
// Replace these with your actual Supabase project URL and anon key
const SUPABASE_URL = "https://geqcnlrwkwicavwixvdn.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdlcWNubHJ3a3dpY2F2d2l4dmRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwOTcyNjIsImV4cCI6MjA5MzY3MzI2Mn0.R2IKRDFT0P0vrXKEfcuSv54TDAiiBK0LbQPHiilanjM";
const SUPABASE_CONFIGURED = !SUPABASE_URL.includes("REPLACE_WITH");
const sb = SUPABASE_CONFIGURED ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// ── Auth hook ─────────────────────────────────────────────────────────────────
function useAuth(){
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(()=>{
    if(!sb){ setLoading(false); return; }
    // Add timeout in case Supabase is slow on mobile
    const timeout = setTimeout(()=>setLoading(false), 5000);
    sb.auth.getSession().then(({data:{session}})=>{
      clearTimeout(timeout);
      setUser(session?.user ?? null);
      setLoading(false);
    }).catch(()=>{ clearTimeout(timeout); setLoading(false); });
    const {data:{subscription}} = sb.auth.onAuthStateChange((_,session)=>{
      setUser(session?.user ?? null);
    });
    return ()=>{ subscription.unsubscribe(); clearTimeout(timeout); };
  },[]);
  return {user, loading};
}

// ── Login / Signup Screen ─────────────────────────────────────────────────────
function AuthScreen(){
  const [mode, setMode] = useState("login"); // login | signup | reset
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [tempPoints, setTempPoints] = useState([]);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function handleSubmit(){
    setError(""); setSuccess(""); setLoading(true);
    try{
      if(!sb){ setError("Supabase not configured. Add your project URL and anon key to the app."); setLoading(false); return; }
      if(mode==="signup"){
        const{error:e} = await sb.auth.signUp({email, password, options:{data:{full_name:name}}});
        if(e) throw e;
        setSuccess("Check your email to confirm your account, then log in.");
        setMode("login");
      } else if(mode==="login"){
        const{error:e} = await sb.auth.signInWithPassword({email, password});
        if(e) throw e;
      } else {
        const{error:e} = await sb.auth.resetPasswordForEmail(email, {redirectTo: window.location.origin});
        if(e) throw e;
        setSuccess("Password reset email sent! Check your inbox.");
        setMode("login");
      }
    }catch(e){ setError(e.message); }
    finally{ setLoading(false); }
  }

  return(
    <div style={{minHeight:"100vh",background:"var(--deep)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24}}>
      <div style={{width:"100%",maxWidth:380}}>
        <div style={{textAlign:"center",marginBottom:40}}>
          <Logo layout="stacked" scale={1} />
        </div>
        <div style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:18,padding:24}}>
          <div style={{fontFamily:"'Playfair Display',serif",fontSize:18,color:"var(--gold)",marginBottom:20,textAlign:"center"}}>
            {mode==="login"?"Welcome Back":mode==="signup"?"Create Account":"Reset Password"}
          </div>
          {mode==="signup"&&<>
            <label style={{display:"block",fontSize:14,letterSpacing:1.5,textTransform:"uppercase",color:"var(--stone)",marginBottom:5}}>Full Name</label>
            <input className="inp" placeholder="John Smith" value={name} onChange={e=>setName(e.target.value)}/>
          </>}
          <label style={{display:"block",fontSize:14,letterSpacing:1.5,textTransform:"uppercase",color:"var(--stone)",marginBottom:5}}>Email</label>
          <input className="inp" type="email" placeholder="you@email.com" value={email} onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleSubmit()}/>
          {mode!=="reset"&&<>
            <label style={{display:"block",fontSize:14,letterSpacing:1.5,textTransform:"uppercase",color:"var(--stone)",marginBottom:5}}>Password</label>
            <input className="inp" type="password" placeholder="••••••••" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleSubmit()}/>
          </>}
          {error&&<div style={{background:"rgba(150,80,80,0.2)",border:"1px solid rgba(150,80,80,0.4)",borderRadius:10,padding:"10px 14px",fontSize:15,color:"var(--red)",marginBottom:12}}>{error}</div>}
          {success&&<div style={{background:"rgba(90,122,74,0.2)",border:"1px solid rgba(90,122,74,0.4)",borderRadius:10,padding:"10px 14px",fontSize:15,color:"#9cd47a",marginBottom:12}}>{success}</div>}
          <button className="btn btnp" disabled={loading} onClick={handleSubmit} style={{marginTop:4}}>
            {loading?"Please wait…":mode==="login"?"Sign In":mode==="signup"?"Create Account":"Send Reset Email"}
          </button>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:16,flexWrap:"wrap",gap:8}}>
            {mode==="login"&&<>
              <button onClick={()=>{setMode("signup");setError("");}} style={{background:"none",border:"none",color:"var(--sky)",fontSize:15,cursor:"pointer",fontFamily:"'Crimson Pro',serif"}}>Create account</button>
              <button onClick={()=>{setMode("reset");setError("");}} style={{background:"none",border:"none",color:"var(--stone)",fontSize:15,cursor:"pointer",fontFamily:"'Crimson Pro',serif"}}>Forgot password?</button>
            </>}
            {mode!=="login"&&<button onClick={()=>{setMode("login");setError("");}} style={{background:"none",border:"none",color:"var(--sky)",fontSize:15,cursor:"pointer",fontFamily:"'Crimson Pro',serif"}}>← Back to sign in</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

function useLocalStorage(key, initial){
  const [val, setVal] = useState(()=>{
    try{ const s=localStorage.getItem(key); return s?JSON.parse(s):initial; }
    catch{ return initial; }
  });
  function set(v){
    const next = typeof v==="function"?v(val):v;
    setVal(next);
    try{ localStorage.setItem(key, JSON.stringify(next)); }catch{}
  }
  return [val, set];
}

// ── Data ──────────────────────────────────────────────────────────────────────
const HATCHES = {
  0:[{name:"Midge",a:"Heavy"},{name:"Blue Winged Olive",a:"Light"}],
  1:[{name:"Midge",a:"Heavy"},{name:"Blue Winged Olive",a:"Light"}],
  2:[{name:"Midge",a:"Moderate"},{name:"Blue Winged Olive",a:"Moderate"},{name:"Skwala Stonefly",a:"Early"}],
  3:[{name:"Blue Winged Olive",a:"Heavy"},{name:"Skwala Stonefly",a:"Moderate"},{name:"March Brown",a:"Light"}],
  4:[{name:"Pale Morning Dun",a:"Heavy"},{name:"Caddis",a:"Moderate"},{name:"Green Drake",a:"Early"}],
  5:[{name:"Green Drake",a:"Heavy"},{name:"Pale Morning Dun",a:"Heavy"},{name:"Salmonfly",a:"Moderate"},{name:"Caddis",a:"Heavy"}],
  6:[{name:"Caddis",a:"Heavy"},{name:"Pale Morning Dun",a:"Moderate"},{name:"Yellow Sally",a:"Moderate"},{name:"Trico",a:"Early"}],
  7:[{name:"Trico",a:"Heavy"},{name:"Caddis",a:"Moderate"},{name:"Hopper",a:"Heavy"},{name:"Yellow Sally",a:"Light"}],
  8:[{name:"Hopper",a:"Heavy"},{name:"Trico",a:"Moderate"},{name:"Blue Winged Olive",a:"Early"},{name:"Caddis",a:"Light"}],
  9:[{name:"Blue Winged Olive",a:"Heavy"},{name:"Hopper",a:"Moderate"},{name:"Mahogany Dun",a:"Moderate"}],
  10:[{name:"Blue Winged Olive",a:"Heavy"},{name:"Midge",a:"Moderate"},{name:"Mahogany Dun",a:"Light"}],
  11:[{name:"Midge",a:"Heavy"},{name:"Blue Winged Olive",a:"Light"}],
};
const WX_EMOJI={0:"☀️",1:"🌤",2:"⛅",3:"☁️",45:"🌫",48:"🌫",51:"🌦",53:"🌦",55:"🌧",61:"🌧",63:"🌧",65:"🌧",71:"🌨",73:"🌨",75:"❄️",80:"🌦",81:"🌧",95:"⛈",96:"⛈",99:"⛈"};
const WX_DESC={0:"Clear",1:"Mainly Clear",2:"Partly Cloudy",3:"Overcast",45:"Fog",48:"Freezing Fog",51:"Light Drizzle",53:"Drizzle",55:"Heavy Drizzle",61:"Light Rain",63:"Rain",65:"Heavy Rain",71:"Light Snow",73:"Snow",75:"Heavy Snow",80:"Showers",81:"Heavy Showers",95:"Thunderstorm",96:"Hail",99:"Severe Storm"};
const DAYS=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const SPECIES=["Brown Trout","Rainbow Trout","Brook Trout","Cutthroat Trout","Lake Trout","Bull Trout","Steelhead","Largemouth Bass","Smallmouth Bass","Other"];

function cfsLabel(cfs, pct){
  if(!cfs||isNaN(cfs))return{label:"No Data",cls:"fair"};
  // If we have historical pct, use it for labeling
  if(pct!=null){
    if(pct<10)return{label:"Very Low",cls:"low"};
    if(pct<30)return{label:"Low",cls:"low"};
    if(pct<70)return{label:"Good",cls:"good"};
    if(pct<90)return{label:"High",cls:"fair"};
    return{label:"Flood Risk",cls:"high"};
  }
  // Fallback to absolute thresholds
  if(cfs<10)return{label:"Very Low",cls:"low"};
  if(cfs<50)return{label:"Low",cls:"low"};
  if(cfs<500)return{label:"Good",cls:"good"};
  if(cfs<2000)return{label:"High",cls:"fair"};
  return{label:"Flood Risk",cls:"high"};
}
function fmtCoord(lat,lng){return`${Math.abs(lat).toFixed(4)}°${lat>=0?"N":"S"}, ${Math.abs(lng).toFixed(4)}°${lng>=0?"E":"W"}`;}
function extractJSON(text){
  const c=text.replace(/```json|```/g,"").trim();
  try{const m=c.match(/\{[\s\S]*\}/);if(m)return JSON.parse(m[0]);}catch{}
  try{const m=c.match(/\[[\s\S]*\]/);if(m)return JSON.parse(m[0]);}catch{}
  return null;
}

// ── API calls ─────────────────────────────────────────────────────────────────
function getKey(){return true;}

function parseShopArray(txt){
  if(!txt)return null;
  let t=String(txt).replace(/```json|```/g," ");
  let s=t.indexOf("[");
  while(s!==-1){
    const e=t.lastIndexOf("]");
    if(e>s){
      const cand=t.slice(s,e+1);
      try{const p=JSON.parse(cand);if(Array.isArray(p)&&p.length&&typeof p[0]==="object")return p;}catch{}
    }
    s=t.indexOf("[",s+1);
  }
  return null;
}

async function askClaude(prompt, useSearch=false, maxTokens=1200){
  const body={model:useSearch?"claude-sonnet-4-6":"claude-haiku-4-5-20251001",max_tokens:maxTokens,messages:[{role:"user",content:prompt}]};
  if(useSearch)body.tools=[{type:"web_search_20250305",name:"web_search",max_uses:1}];
  const res=await fetch("/api/claude",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  let d;try{d=await res.json();}catch(e){throw new Error("API request failed.");}
  if(d.error)throw new Error(d.error.message||"API error");
  // Handle tool use responses - extract all text blocks including after tool results
  const texts=(d.content||[]).map(b=>b.type==="text"?b.text:b.type==="tool_result"?(Array.isArray(b.content)?b.content.map(x=>x.text||"").join(""):b.content||""):"").filter(Boolean);
  return texts.join(" ");
}
async function geocode(q){
  // Search with extra detail for natural features and small places
  let results=[];
  try{
    const r=await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=8&countrycodes=us&addressdetails=1&extratags=1`,{headers:{"Accept-Language":"en"}});
    if(r.ok) results=await r.json();
  }catch{
    const r=await fetch("/api/claude",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({proxy_url:`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=8&countrycodes=us&addressdetails=1&extratags=1`})});
    const rd=await r.json();results=Array.isArray(rd)?rd:[];
  }
  // Sort: exact name matches and water features first, counties last
  if(!Array.isArray(results)) return [];
  return results.sort((a,b)=>{
    const aIsWater=["river","stream","waterway","creek"].some(t=>(a.type||a.class||"").includes(t));
    const bIsWater=["river","stream","waterway","creek"].some(t=>(b.type||b.class||"").includes(t));
    const aIsCounty=(a.type||"").includes("county")||(a.address?.county&&!a.address?.city&&!a.address?.town&&!a.address?.village&&!a.address?.hamlet);
    const bIsCounty=(b.type||"").includes("county")||(b.address?.county&&!b.address?.city&&!b.address?.town&&!b.address?.village&&!b.address?.hamlet);
    if(aIsWater&&!bIsWater)return -1;
    if(!aIsWater&&bIsWater)return 1;
    if(aIsCounty&&!bIsCounty)return 1;
    if(!aIsCounty&&bIsCounty)return -1;
    return 0;
  });
}
async function reverseGeocode(lat,lng){
  // Try direct first, fall back to proxy if CORS blocked
  try{
    const r=await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`,{headers:{"Accept-Language":"en","User-Agent":"TightLines/1.0"}});
    if(r.ok) return r.json();
  }catch{}
  const r=await fetch("/api/claude",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({proxy_url:`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`})});
  return r.json();
}
async function fetchWeather(lat,lng){
  const url=`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,surface_pressure,uv_index&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,surface_pressure_mean&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=7`;
  try{
    const r=await fetch(url);
    if(r.ok) return r.json();
  }catch{}
  // Fallback: proxy through /api/claude to avoid CORS
  const r2=await fetch("/api/claude",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({proxy_url:url})});
  return r2.json();
}


async function getOrCreateKey(userId){
  const keyName='tl_enc_key_'+userId;
  try{const stored=localStorage.getItem(keyName);if(stored){const raw=Uint8Array.from(atob(stored),c=>c.charCodeAt(0));return await crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['encrypt','decrypt']);}}catch{}
  const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
  const exported=await crypto.subtle.exportKey('raw',key);
  localStorage.setItem(keyName,btoa(String.fromCharCode(...new Uint8Array(exported))));
  return key;
}
async function encryptGPS(gps,key){
  if(!gps||gps==='Location not recorded') return gps;
  try{const iv=crypto.getRandomValues(new Uint8Array(12));const enc=new TextEncoder();const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,enc.encode(gps));const combined=new Uint8Array(12+ct.byteLength);combined.set(iv);combined.set(new Uint8Array(ct),12);return 'ENC:'+btoa(String.fromCharCode(...combined));}catch{return gps;}
}
async function decryptGPS(gps,key){
  if(!gps||!gps.startsWith('ENC:')) return gps;
  try{const combined=Uint8Array.from(atob(gps.slice(4)),c=>c.charCodeAt(0));const iv=combined.slice(0,12),ct=combined.slice(12);const dec=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,ct);return new TextDecoder().decode(dec);}catch{return gps;}
}

function windDir(deg){
  if(deg==null) return "";
  const dirs=["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(deg/22.5)%16];
}

function pressureTrend(current, prev){
  if(!current||!prev) return {icon:"→",label:"Steady",color:"var(--stone)"};
  const diff=current-prev;
  if(diff>1.5) return {icon:"↑↑",label:"Rising Fast",color:"#9cd47a"};
  if(diff>0.3) return {icon:"↑",label:"Rising",color:"#9cd47a"};
  if(diff<-1.5) return {icon:"↓↓",label:"Falling Fast",color:"var(--red)"};
  if(diff<-0.3) return {icon:"↓",label:"Falling",color:"var(--gold)"};
  return {icon:"→",label:"Steady",color:"var(--stone)"};
}

function fishingPressureNote(pressure){
  if(!pressure) return null;
  const p=parseFloat(pressure);
  if(p>30.2) return "High pressure — fish active near surface, dry fly conditions good";
  if(p>29.9) return "Normal pressure — stable feeding, all techniques productive";
  if(p>29.5) return "Low pressure — fish moving to deeper water, nymphs & streamers best";
  return "Very low pressure — storm incoming, fish feeding aggressively before front";
}

function getMoonPhase(date){
  const d = date || new Date();
  const year = d.getFullYear(), month = d.getMonth()+1, day = d.getDate();
  let c = 0, e = 0, jd = 0;
  if(month < 3){ const y=year-1, m=month+12; jd = Math.floor(365.25*(y+4716))+Math.floor(30.6001*(m+1))+day-1524.5; }
  else { jd = Math.floor(365.25*(year+4716))+Math.floor(30.6001*(month+1))+day-1524.5; }
  const b = 2-Math.floor(year/100)+Math.floor(Math.floor(year/100)/4);
  jd += b < 0 ? b : 0;
  const daysSinceNew = (jd - 2451549.5) % 29.53058867;
  const phase = daysSinceNew < 0 ? daysSinceNew + 29.53058867 : daysSinceNew;
  const pct = phase / 29.53058867;
  let name, emoji, fishingNote;
  if(pct < 0.03 || pct > 0.97){ name="New Moon"; emoji="🌑"; fishingNote="Excellent — fish feed actively all day"; }
  else if(pct < 0.22){ name="Waxing Crescent"; emoji="🌒"; fishingNote="Good — morning hatches strong"; }
  else if(pct < 0.28){ name="First Quarter"; emoji="🌓"; fishingNote="Fair — evening bite improving"; }
  else if(pct < 0.47){ name="Waxing Gibbous"; emoji="🌔"; fishingNote="Fair — midday lull likely"; }
  else if(pct < 0.53){ name="Full Moon"; emoji="🌕"; fishingNote="Fish fed overnight — slower daytime bite"; }
  else if(pct < 0.72){ name="Waning Gibbous"; emoji="🌖"; fishingNote="Fair — early morning best"; }
  else if(pct < 0.78){ name="Last Quarter"; emoji="🌗"; fishingNote="Good — evening hatches strong"; }
  else { name="Waning Crescent"; emoji="🌘"; fishingNote="Good — all-day feeding activity"; }
  return { name, emoji, pct, fishingNote };
}

function getStateRegLink(label){
  const s = label||"";
  const states = {
    "CO":"https://cpw.state.co.us/learn/Pages/Fishing.aspx",
    "Colorado":"https://cpw.state.co.us/learn/Pages/Fishing.aspx",
    "MT":"https://fwp.mt.gov/fish/fishing-regulations",
    "Montana":"https://fwp.mt.gov/fish/fishing-regulations",
    "WY":"https://wgfd.wyo.gov/Fishing/Fishing-Regulations",
    "Wyoming":"https://wgfd.wyo.gov/Fishing/Fishing-Regulations",
    "ID":"https://idfg.idaho.gov/fish/fishing/regulations",
    "Idaho":"https://idfg.idaho.gov/fish/fishing/regulations",
    "OR":"https://myodfw.com/articles/2024-25-oregon-sport-fishing-regulations",
    "Oregon":"https://myodfw.com/articles/2024-25-oregon-sport-fishing-regulations",
    "WA":"https://wdfw.wa.gov/fishing/regulations",
    "Washington":"https://wdfw.wa.gov/fishing/regulations",
    "UT":"https://wildlife.utah.gov/regulations.html",
    "Utah":"https://wildlife.utah.gov/regulations.html",
    "NM":"https://www.wildlife.state.nm.us/fishing/regulations/",
    "New Mexico":"https://www.wildlife.state.nm.us/fishing/regulations/",
    "AZ":"https://www.azgfd.com/fishing/regulations/",
    "Arizona":"https://www.azgfd.com/fishing/regulations/",
    "CA":"https://wildlife.ca.gov/Regulations",
    "California":"https://wildlife.ca.gov/Regulations",
  };
  for(const [key,url] of Object.entries(states)){
    if(s.includes(key)) return url;
  }
  return null;
}


async function fetchUSGSStat(siteNo){
  // Fetch the annual max (peak) statistic for a site so we can show % of max
  try{
    var url="https://waterservices.usgs.gov/nwis/stat/?format=json&sites="+siteNo+"&parameterCd=00060&statReportType=annual&statYearType=water";
    var r=await fetch(url);
    if(!r.ok) return null;
    var d=await r.json();
    var ts=(d.value&&d.value.timeSeries)||[];
    if(!ts.length) return null;
    // Find the max statistic value across all years
    var maxVal=0;
    ts.forEach(function(t){
      (t.values||[]).forEach(function(v){
        (v.value||[]).forEach(function(rec){
          var n=parseFloat(rec.value);
          if(!isNaN(n)&&n>maxVal) maxVal=n;
        });
      });
    });
    return maxVal>0?maxVal:null;
  }catch(e){ return null; }
}

async function fetchUSGSRange(siteNo, days){
  var e=new Date(), s=new Date();
  s.setDate(e.getDate()-days);
  function fmt(d){return d.toISOString().split("T")[0];}
  // Use instantaneous values for <=7 days, daily values for longer periods
  var url;
  if(days<=7){
    url="https://waterservices.usgs.gov/nwis/iv/?format=json&sites="+siteNo+"&parameterCd=00060&startDT="+fmt(s)+"&endDT="+fmt(e);
  } else {
    url="https://waterservices.usgs.gov/nwis/dv/?format=json&sites="+siteNo+"&parameterCd=00060&startDT="+fmt(s)+"&endDT="+fmt(e);
  }
  try{
    var r=await fetch(url);
    if(!r.ok) return [];
    var d=await r.json();
    var ts=(d.value&&d.value.timeSeries)||[];
    if(!ts.length) return [];
    var vals=(ts[0].values&&ts[0].values[0]&&ts[0].values[0].value)||[];
    return vals.map(function(v){return{t:v.dateTime,v:parseFloat(v.value)};}).filter(function(v){return !isNaN(v.v)&&v.v>=0&&v.v<500000;});
  }catch(e){ return []; }
}


async function fetchUSGSTemp(siteNo){
  try{
    const url="https://waterservices.usgs.gov/nwis/iv/?format=json&sites="+siteNo+"&parameterCd=00010&siteStatus=active";
    const r=await fetch(url);
    if(!r.ok) return null;
    const d=await r.json();
    const ts=(d.value&&d.value.timeSeries)||[];
    if(!ts.length) return null;
    const raw=ts[0].values?.[0]?.value?.[0]?.value;
    if(raw==null) return null;
    const tempC=parseFloat(raw);
    return isNaN(tempC)?null:Math.round(tempC*9/5+32); // Convert C to F
  }catch{ return null; }
}

async function fetchUSGSLive(lat,lng,radiusDeg=2){
  var rings=[Math.min(radiusDeg*0.4,0.5),Math.min(radiusDeg*0.7,1.0),radiusDeg];
  // Try smallest radius first and return as soon as one has gauges.
  for(var i=0;i<rings.length;i++){
    var p=rings[i];
    var minLng=Math.round((lng-p)*10000)/10000;
    var maxLng=Math.round((lng+p)*10000)/10000;
    var minLat=Math.round((lat-p)*10000)/10000;
    var maxLat=Math.round((lat+p)*10000)/10000;
    var bbox=minLng+","+minLat+","+maxLng+","+maxLat;
    try{
      var r=await fetch("https://waterservices.usgs.gov/nwis/iv/?format=json&bBox="+bbox+"&parameterCd=00060&siteType=ST");
      if(r.ok){var j=await r.json();if(j&&j.value&&j.value.timeSeries&&j.value.timeSeries.length>0) return j;}
    }catch{}
  }
  return {value:{timeSeries:[]}};
}

async function fetchUSGSTempBatch(siteNos){
  if(!siteNos||!siteNos.length) return {};
  try{
    var url="https://waterservices.usgs.gov/nwis/iv/?format=json&sites="+siteNos.join(",")+"&parameterCd=00010";
    var r=await fetch(url);
    if(!r.ok) return {};
    var d=await r.json();
    var out={};
    var ts=(d.value&&d.value.timeSeries)||[];
    ts.forEach(function(t){
      var site=(t.sourceInfo&&t.sourceInfo.siteCode&&t.sourceInfo.siteCode[0]&&t.sourceInfo.siteCode[0].value)||"";
      var raw=t.values&&t.values[0]&&t.values[0].value&&t.values[0].value[0]&&t.values[0].value[0].value;
      if(site&&raw!=null){var c=parseFloat(raw);if(!isNaN(c))out[site]=Math.round(c*9/5+32);}
    });
    return out;
  }catch{ return {}; }
}

async function fetchHistoricalConditions(lat, lng, dateStr, hourStr){
  const results={airTemp:"",weatherDesc:"",windSpeed:"",windDir:"",pressure:"",streamCFS:"",streamCondition:"",streamGaugeName:""};
  const hr=parseInt(hourStr)||12;
  const idx=Math.min(hr,23);
  // Run weather and stream fetch in parallel with a single bbox
  const wxUrl=`https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}&start_date=${dateStr}&end_date=${dateStr}&hourly=temperature_2m,weathercode,windspeed_10m,winddirection_10m,surface_pressure&temperature_unit=fahrenheit&windspeed_unit=mph&timezone=auto`;
  const p=1.5;
  const usgsUrl=`https://waterservices.usgs.gov/nwis/dv/?format=json&bBox=${(lng-p).toFixed(2)},${(lat-p).toFixed(2)},${(lng+p).toFixed(2)},${(lat+p).toFixed(2)}&parameterCd=00060&startDT=${dateStr}&endDT=${dateStr}&siteType=ST`;
  const [wxRes,usgsRes]=await Promise.allSettled([fetch(wxUrl),fetch(usgsUrl)]);
  try{
    if(wxRes.status==="fulfilled"&&wxRes.value.ok){
      const wx=await wxRes.value.json();
      if(wx.hourly){
        results.airTemp=wx.hourly.temperature_2m?.[idx]!=null?String(Math.round(wx.hourly.temperature_2m[idx])):"";
        const code=wx.hourly.weathercode?.[idx];
        results.weatherDesc=(WX_EMOJI[code]||"")+" "+(WX_DESC[code]||"");
        results.windSpeed=wx.hourly.windspeed_10m?.[idx]!=null?String(Math.round(wx.hourly.windspeed_10m[idx])):"";
        results.windDir=wx.hourly.winddirection_10m?.[idx]!=null?windDir(wx.hourly.winddirection_10m[idx]):"";
        results.pressure=wx.hourly.surface_pressure?.[idx]!=null?(wx.hourly.surface_pressure[idx]*0.02953).toFixed(2):"";
      }
    }
  }catch{}
  try{
    if(usgsRes.status==="fulfilled"&&usgsRes.value.ok){
      const d=await usgsRes.value.json();
      const ts=(d.value?.timeSeries)??[];
      const parsed=ts.map(t=>{
        const raw=t.values?.[0]?.value?.[0]?.value;
        const cfs=raw!=null?parseFloat(raw):null;
        const sLat=parseFloat(t.sourceInfo?.geoLocation?.geogLocation?.latitude||0);
        const sLng=parseFloat(t.sourceInfo?.geoLocation?.geogLocation?.longitude||0);
        const dist=Math.sqrt(Math.pow(sLat-lat,2)+Math.pow(sLng-lng,2));
        return{name:t.sourceInfo?.siteName??"",cfs,dist,label:cfsLabel(cfs,null).label};
      }).filter(x=>x.cfs!=null&&!isNaN(x.cfs)&&x.cfs>=0&&x.cfs<500000).sort((a,b)=>a.dist-b.dist);
      if(parsed.length){
        results.streamCFS=String(Math.round(parsed[0].cfs));
        results.streamCondition=parsed[0].label;
        results.streamGaugeName=parsed[0].name;
      }
    }
  }catch{}
  return results;
}

async function fetchUSGSHistory(lat,lng){
  var p=1.5;
  var minLng=lng-p, minLat=lat-p, maxLng=lng+p, maxLat=lat+p;
  var e=new Date(), s=new Date();
  s.setDate(e.getDate()-30);
  function fmt(d){return d.toISOString().split("T")[0];}
  var bbox=minLng+","+minLat+","+maxLng+","+maxLat;
  try{
    var url="https://waterservices.usgs.gov/nwis/dv/?format=json&bBox="+bbox+"&parameterCd=00060&siteType=ST&siteStatus=active&startDT="+fmt(s)+"&endDT="+fmt(e);
    var r=await fetch(url);
    if(!r.ok) throw new Error("failed");
    var d=await r.json();
    var ts=(d.value&&d.value.timeSeries)||[];
    if(ts.length>0) return d;
    throw new Error("empty");
  }catch(err){
    // Try wider area
    var p2=2.5;
    var bbox2=(lng-p2)+","+(lat-p2)+","+(lng+p2)+","+(lat+p2);
    try{
      var url2="https://waterservices.usgs.gov/nwis/dv/?format=json&bBox="+bbox2+"&parameterCd=00060&siteType=ST&siteStatus=active&startDT="+fmt(s)+"&endDT="+fmt(e);
      var r2=await fetch(url2);
      if(!r2.ok) throw new Error("failed2");
      return r2.json();
    }catch(e2){
      return{value:{timeSeries:[]}};
    }
  }
}

function cleanLabel(item){
  const a=item.address||{};
  const st=a.state_code||a.state||"";
  // For water features, use the water name + nearest named place for context
  const water=a.river||a.stream||a.waterway||a.creek||a.brook;
  if(water){
    const nearby=a.city||a.town||a.village||a.hamlet||a.suburb||a.county||"";
    if(nearby&&st) return `${water}, ${nearby}, ${st}`;
    if(nearby) return `${water}, ${nearby}`;
    return st?`${water}, ${st}`:water;
  }
  // For named places, prefer specific over general, always include state
  const place=a.hamlet||a.village||a.town||a.city||a.suburb||a.neighbourhood||a.county||item.display_name.split(",")[0];
  return st?`${place}, ${st}`:place;
}
function locIcon(item){
  const t=(item.type||item.class||"").toLowerCase();
  if(["river","stream","waterway"].some(x=>t.includes(x)))return"🏞";
  if(["city","town","village"].some(x=>t.includes(x)))return"🏙";
  return"📍";
}

function GpsLocation({gps}){
  if(!gps)return null;
  // Handle "46.8535°N, 114.0358°W" format
  const dmsMatch=gps.match(/([\d.]+)[°\s]*([NS])[\s,]+([\d.]+)[°\s]*([EW])/i);
  if(dmsMatch){
    const lat=parseFloat(dmsMatch[1])*(dmsMatch[2].toUpperCase()==="S"?-1:1);
    const lng=parseFloat(dmsMatch[3])*(dmsMatch[4].toUpperCase()==="W"?-1:1);
    return <a href={`https://maps.google.com/?q=${lat},${lng}`} target="_blank" rel="noopener noreferrer">{gps}</a>;
  }
  const nums=gps.match(/-?[\d.]+/g);
  if(!nums||nums.length<2)return <span>{gps}</span>;
  return <a href={`https://maps.google.com/?q=${nums[0]},${nums[1]}`} target="_blank" rel="noopener noreferrer">{gps}</a>;
}
// ── SVG Flow Chart ────────────────────────────────────────────────────────────
// ── SVG Flow Chart ────────────────────────────────────────────────────────────
function FlowChart({points,label}){
  if(!points||points.length<2)return null;
  const W=300,H=90,PL=38,PR=8,PT=6,PB=22;
  const iW=W-PL-PR,iH=H-PT-PB;
  const vals=points.map(p=>p.v);
  const minV=Math.min(...vals),maxV=Math.max(...vals),range=maxV-minV||1;
  const px=i=>PL+(i/(points.length-1))*iW;
  const py=v=>PT+iH-((v-minV)/range)*iH;
  const lp=points.map((p,i)=>`${px(i)},${py(p.v)}`).join(" ");
  const ap=`${PL},${PT+iH} `+points.map((p,i)=>`${px(i)},${py(p.v)}`).join(" ")+` ${PL+iW},${PT+iH}`;
  const yt=[minV,(minV+maxV)/2,maxV];
  const xi=[0,Math.floor(points.length/2),points.length-1];
  return(
    <div>
      {label&&<div style={{fontSize:14,color:"var(--stone)",marginBottom:4,fontStyle:"italic"}}>{label}</div>}
      <svg width={W} height={H} style={{display:"block",maxWidth:"100%"}}>
        <defs><linearGradient id="fg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#b8d4dc" stopOpacity="0.35"/><stop offset="100%" stopColor="#b8d4dc" stopOpacity="0.03"/></linearGradient></defs>
        {[0,0.5,1].map((f,i)=><line key={i} x1={PL} x2={PL+iW} y1={PT+iH*(1-f)} y2={PT+iH*(1-f)} stroke="rgba(255,255,255,0.07)" strokeWidth="1"/>)}
        {yt.map((v,i)=><text key={i} x={PL-4} y={py(v)+4} textAnchor="end" fontSize="9" fill="#8a8a7a">{v>=1000?`${(v/1000).toFixed(1)}k`:Math.round(v)}</text>)}
        {xi.map((idx,i)=>{const d=new Date(points[idx].t);return<text key={i} x={px(idx)} y={H-4} textAnchor="middle" fontSize="9" fill="#8a8a7a">{`${d.getMonth()+1}/${d.getDate()}`}</text>;})}
        <polygon points={ap} fill="url(#fg)"/>
        <polyline points={lp} fill="none" stroke="#b8d4dc" strokeWidth="2" strokeLinejoin="round"/>
        <circle cx={px(points.length-1)} cy={py(points[points.length-1].v)} r="3" fill="#c8a84b"/>
      </svg>
    </div>
  );
}

// ── API Key Setup ─────────────────────────────────────────────────────────────
function ApiKeySetup({onSave}){
  const [val,setVal]=useState("");
  return(
    <div className="api-setup">
      <p>🔑 <strong>Optional: Add your Anthropic API key</strong> to enable AI fishing reports and fly shop search. Get a key at <strong>console.anthropic.com</strong> — costs a few cents per report.</p>
      <input className="api-input" type="password" placeholder="sk-ant-api..." value={val} onChange={e=>setVal(e.target.value)}/>
      <button className="api-save" onClick={()=>{if(val.trim()){localStorage.setItem("anthropic_key",val.trim());onSave();}}}>Save API Key</button>
    </div>
  );
}


// ── Hatch Detail Modal ────────────────────────────────────────────────────────
const HATCH_DETAILS = {
  "Midge":{ latin:"Chironomidae", sizes:"#18-26", timing:"Year-round, best 10am-2pm", depth:"Surface & film", patterns:["Zebra Midge","Mercury Midge","Disco Midge","Griffiths Gnat"], tip:"Use a size 22-24 in winter. Dead drift just below the surface." },
  "Blue Winged Olive":{ latin:"Baetis spp.", sizes:"#16-22", timing:"10am-3pm on overcast days", depth:"Surface emerger", patterns:["RS2","Pheasant Tail","Sparkle Dun","Parachute BWO"], tip:"Fish hatches on cold, cloudy days. Trout key in on emergers just under the film." },
  "Pale Morning Dun":{ latin:"Ephemerella spp.", sizes:"#14-18", timing:"Morning to early afternoon", depth:"Surface", patterns:["PMD Cripple","Sparkle Dun PMD","Comparadun","Pheasant Tail"], tip:"Cripples and emergers outfish duns. Match size precisely." },
  "Caddis":{ latin:"Trichoptera", sizes:"#12-16", timing:"Evening, dusk", depth:"Surface & subsurface", patterns:["Elk Hair Caddis","X Caddis","Breadcrust","Pupa"], tip:"Skate a dry fly or swing a soft hackle in the evening. Trout go crazy." },
  "Green Drake":{ latin:"Drunella grandis", sizes:"#10-12", timing:"Midday, brief hatch", depth:"Surface", patterns:["Parachute Green Drake","Wulff","Slate Wing Olive","Usual"], tip:"One of the best hatches of the year. Be ready — it can be intense but short." },
  "Trico":{ latin:"Tricorythodes spp.", sizes:"#20-26", timing:"Early morning spinner fall", depth:"Surface", patterns:["Trico Spinner","CDC Trico","Poly Wing Spinner"], tip:"Fish the spinner fall at dawn. Use long fine tippet and be patient." },
  "Hopper":{ latin:"Acrididae (terrestrial)", sizes:"#6-12", timing:"Afternoon, windy days", depth:"Surface", patterns:["Dave's Hopper","Chubby Chernobyl","Parachute Hopper","Fat Albert"], tip:"Slap the fly on the water near grassy banks. Trout love a big meal." },
  "Salmonfly":{ latin:"Pteronarcys californica", sizes:"#2-6", timing:"Late afternoon, early evening", depth:"Surface", patterns:["Sofa Pillow","Cheryl's Salmonfly","Bird's Stonefly"], tip:"Fish the edges and banks. This is a bucket list hatch — fish go wild." },
  "Skwala Stonefly":{ latin:"Skwala parallela", sizes:"#8-12", timing:"Midday warmth", depth:"Surface", patterns:["Skwala Dry","Peacock Skwala","Girdle Bug"], tip:"First big hatch of spring. Fish sunny, warm afternoons in March." },
  "March Brown":{ latin:"Rhithrogena morrisoni", sizes:"#12-14", timing:"Afternoon", depth:"Surface", patterns:["March Brown Parachute","Hare's Ear","Soft Hackle"], tip:"A reliable early season hatch. Fish the emerger in broken water." },
  "Yellow Sally":{ latin:"Isoperla spp.", sizes:"#14-16", timing:"Afternoon", depth:"Surface", patterns:["Yellow Sally","Stimulator","Yellow Humpy"], tip:"Small stonefly. Fish near rocky runs and riffles in summer." },
  "Mahogany Dun":{ latin:"Paraleptophlebia spp.", sizes:"#16-18", timing:"Afternoon, overcast days", depth:"Surface", patterns:["Mahogany Dun","Comparadun","Pheasant Tail"], tip:"Fall hatch. Fish slow, flat water with long leaders." },
};

function MoonCard(){
  const m = getMoonPhase();
  return(
    <div>
      <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:8}}>
        <span style={{fontSize:42}}>{m.emoji}</span>
        <div>
          <div style={{fontFamily:"'Playfair Display',serif",fontSize:18,color:"var(--foam)"}}>{m.name}</div>
          <div style={{fontSize:15,color:"var(--stone)",marginTop:2}}>{Math.round(m.pct*100)}% illuminated</div>
        </div>
      </div>
      <div style={{fontSize:15,color:"var(--sky)",fontStyle:"italic",padding:"8px 12px",background:"rgba(0,0,0,0.2)",borderRadius:10}}>🎣 {m.fishingNote}</div>
    </div>
  );
}

function RegsLink({label}){
  const url = getStateRegLink(label||"");
  if(!url) return null;
  return(
    <div className="card">
      <div className="ctitle">📋 Fishing Regulations</div>
      <a href={url} target="_blank" rel="noreferrer" style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:"rgba(0,0,0,0.2)",borderRadius:12,color:"var(--sky)",textDecoration:"none",fontSize:14}}>
        🔗 View current regulations for this state
      </a>
    </div>
  );
}



// Hatch predictions: shows all seasonally/regionally appropriate hatches with temp-range context.
// Temp data is informational — notes tell users when each hatch peaks, not a filter gate.
function predictHatches(opts){
  const month=opts.month,t=opts.waterTempF!=null?opts.waterTempF:null;
  const lng=opts.lng!=null?opts.lng:-100,west=lng<=-100,bigWater=(opts.maxCfs||0)>400;
  const src=opts.tempGaugeName?" ("+opts.tempGaugeName+")":"";
  const R=[
    {name:"Midges",months:[1,2,3,4,5,6,7,8,9,10,11,12],lo:33,hi:70,flies:["Zebra Midge #18-22","Griffith's Gnat #18-22","RS2 #20-22"],timing:"Midday in cold months, mornings and evenings in summer",base:0.55,note:"Year-round staple; often the only game in cold water"},
    {name:"Blue-Winged Olive (Baetis)",months:[3,4,5,9,10,11],lo:40,hi:58,flies:["Pheasant Tail #16-20","BWO Comparadun #16-20","RS2 #18-20"],timing:"Afternoons; best on overcast days",base:0.7,note:"Cloudy, drizzly days bring the heaviest emergences"},
    {name:"Skwala Stonefly",months:[2,3,4],lo:40,hi:50,west:true,flies:["Pat's Rubber Legs #8-10","Skwala Dry #10"],timing:"Warmest part of the day",base:0.5,note:"Early-season western stonefly on freestone rivers"},
    {name:"Mother's Day Caddis",months:[4,5],lo:48,hi:56,west:true,flies:["Elk Hair Caddis #14-16","Sparkle Pupa #14-16"],timing:"Afternoons",base:0.6,note:"Can blanket western rivers when temps hit the low 50s"},
    {name:"Salmonfly",months:[5,6,7],lo:50,hi:58,west:true,big:true,flies:["Chubby Chernobyl #6-8","Pat's Rubber Legs #4-8"],timing:"Midday; the hatch moves upstream day by day",base:0.6,note:"Big western freestones only; trout key on them hard"},
    {name:"Golden Stonefly",months:[6,7],lo:52,hi:62,west:true,flies:["Yellow Stimulator #8-10","Golden Stone Nymph #8-10"],timing:"Mornings and evenings",base:0.55,note:"Follows the salmonfly hatch on many western rivers"},
    {name:"Pale Morning Dun",months:[6,7,8],lo:54,hi:66,west:true,flies:["PMD Comparadun #16-18","Split Case PMD #16-18"],timing:"Late morning into early afternoon",base:0.7,note:"The premier summer mayfly across the West"},
    {name:"October Caddis",months:[9,10],lo:45,hi:55,west:true,flies:["Orange Stimulator #8-10","October Caddis Pupa #8-10"],timing:"Afternoons",base:0.5,note:"Big orange caddis of western fall"},
    {name:"Quill Gordon",months:[3,4],lo:45,hi:52,east:true,flies:["Quill Gordon #12-14","Pheasant Tail #14"],timing:"Early afternoon on the first warm days",base:0.5,note:"The earliest major eastern mayfly"},
    {name:"Hendrickson",months:[4,5],lo:50,hi:56,east:true,flies:["Hendrickson #12-14","Red Quill #12-14","Pheasant Tail #14"],timing:"Early to mid afternoon",base:0.7,note:"The classic eastern spring hatch"},
    {name:"March Brown",months:[5,6],lo:50,hi:58,east:true,flies:["March Brown #10-12","Hare's Ear Nymph #12"],timing:"Sporadic through the afternoon",base:0.5,note:"Large eastern mayfly, never blanket but reliable"},
    {name:"Sulphur",months:[5,6,7],lo:55,hi:65,east:true,flies:["Sulphur Comparadun #16-18","Sulphur Spinner #16-18"],timing:"Evenings; spinner falls at dusk",base:0.7,note:"The East's premier early-summer mayfly"},
    {name:"Light Cahill",months:[6,7],lo:58,hi:66,east:true,flies:["Light Cahill #14-16","Cahill Spinner #14-16"],timing:"Evenings",base:0.55,note:"Reliable eastern summer evening mayfly"},
    {name:"Hexagenia (Hex)",months:[6,7],lo:60,hi:70,east:true,flies:["Hex Dun #4-6","Hex Nymph #6"],timing:"At dusk and after dark",base:0.55,note:"The giant Midwest night hatch \u2014 Michigan and Wisconsin famous"},
    {name:"Slate Drake (Isonychia)",months:[5,6,9,10],lo:52,hi:64,east:true,flies:["Isonychia #10-12","Mahogany Dun #12"],timing:"Afternoons and evenings",base:0.5,note:"Eastern swimmer mayfly, both early summer and fall"},
    {name:"Caddis (evening)",months:[5,6,7,8,9],lo:52,hi:68,flies:["Elk Hair Caddis #14-18","X-Caddis #14-16","Soft Hackle #14-16"],timing:"Last two hours before dark",base:0.7,note:"Reliable summer evening activity on most trout water"},
    {name:"Green Drake",months:[6,7],lo:54,hi:62,flies:["Green Drake #10-12","Hare's Ear Nymph #10-12"],timing:"Afternoons, often during unsettled weather",base:0.5,note:"Short but famous; trout abandon caution for them"},
    {name:"Yellow Sally",months:[6,7,8],lo:55,hi:65,flies:["Yellow Sally #14-16","Yellow Stimulator #14"],timing:"Afternoons and evenings",base:0.5,note:"Small summer stonefly, easy to overlook"},
    {name:"Trico",months:[7,8,9],lo:58,hi:70,flies:["Trico Spinner #20-24","Trico Dun #20-22"],timing:"Early mornings; spinner fall around 8-10am",base:0.55,note:"Tiny flies, picky fish, great dry-fly fishing"},
    {name:"Terrestrials (hoppers, ants, beetles)",months:[7,8,9],lo:58,hi:74,flies:["Hopper #8-12","Ant #14-18","Beetle #14-16"],timing:"Warm, breezy afternoons near grassy banks",base:0.6,note:"Not a hatch but a major summer food source"},
    {name:"Mahogany Dun",months:[9,10],lo:45,hi:55,flies:["Mahogany Dun #16-18","Pheasant Tail #16-18"],timing:"Afternoons",base:0.5,note:"Dependable fall mayfly as BWOs taper"}
  ];
  const out=[];
  for(const r of R){
    if(!r.months.includes(month))continue;
    if(r.west===true&&!west)continue;
    if(r.east===true&&west)continue;
    if(r.big&&!bigWater)continue;
    let tempCtx="";
    if(t!==null){
      if(t<r.lo-4) tempCtx=" Water at "+Math.round(t)+"\u00b0F is still cold for this hatch \u2014 watch as temps approach "+r.lo+"\u00b0F.";
      else if(t<r.lo) tempCtx=" Water approaching the hatch window ("+Math.round(t)+"\u00b0F, peaks at "+r.lo+"\u2013"+r.hi+"\u00b0F) \u2014 could see early activity.";
      else if(t<=r.hi) tempCtx=" \u2713 Water at "+Math.round(t)+"\u00b0F is in prime range \u2014 should be active.";
      else tempCtx=" Water has warmed past peak for this hatch ("+Math.round(t)+"\u00b0F, peaks at "+r.lo+"\u2013"+r.hi+"\u00b0F).";
    }
    const gaugeNote=t!==null&&opts.tempGaugeName?" Temp reading from "+opts.tempGaugeName+".":"";
    const timingNote=". Best fished "+r.timing.charAt(0).toLowerCase()+r.timing.slice(1)+".";
    out.push({name:r.name,likelihood:r.base>=0.65?"High":"Moderate",waterTempRange:r.lo+"-"+r.hi+"\u00b0F",flies:r.flies,timing:r.timing,notes:r.note+timingNote+" Typically active when water reaches "+r.lo+"\u2013"+r.hi+"\u00b0F."+tempCtx+gaugeNote,_s:r.base});
  }
  out.sort((a,b)=>b._s-a._s);
  const top=out.slice(0,6).map(function(h){const o={...h};delete o._s;return o;});
  if(t!==null&&t>=70) top.push({name:"Warm Water Caution",likelihood:"High",waterTempRange:"Above 70\u00b0F",flies:["Fish early morning or evening only"],timing:"Avoid midday fishing",notes:"Water at "+Math.round(t)+"\u00b0F"+src+" is approaching stress levels for trout (critical above 68\u00b0F). Release fish quickly and consider skipping midday."});
  return top;
}

function HatchMatcher({loc, waterTemp, gauges, autoRun, prefetchedResult, prefetchedLoading}){
  const [result,setResult]=React.useState(prefetchedResult||null);
  const [loading,setLoading]=React.useState(prefetchedLoading||false);
  const [open,setOpen]=React.useState(!!prefetchedResult);
  React.useEffect(()=>{if(prefetchedResult&&!result){setResult(prefetchedResult);setOpen(true);setLoading(false);}},[prefetchedResult]);
  React.useEffect(()=>{setLoading(!!prefetchedLoading);},[prefetchedLoading]);
  React.useEffect(()=>{if(autoRun&&loc?.lat&&loc?.lng&&!result&&!loading){const t=setTimeout(()=>runMatcher(),1500);return()=>clearTimeout(t);}},[autoRun,loc?.lat,loc?.lng]);
  async function runMatcher(){
    if(!loc) return;
    const gl=(gauges&&gauges.length?gauges:window._loadedGauges)||[];
    const nearTG=gl.filter(g=>g.waterTempF&&(g.dist==null||g.dist<=20)).find(g=>g.waterTempF)||null;
    const localTemp=waterTemp||nearTG?.waterTempF||null;
    const maxCfs=gl.reduce((m,g)=>Math.max(m,g.cfs||0),0);
    setResult(predictHatches({month:new Date().getMonth()+1,waterTempF:localTemp,lng:(loc&&loc.lng!=null)?loc.lng:null,maxCfs,tempGaugeName:nearTG?.name||null}));
    setOpen(true);setLoading(false);
  }
  return(
    React.createElement('div',{className:"card"},
      React.createElement('div',{className:"ctitle",style:{cursor:"pointer",userSelect:"none"},onClick:()=>open?setOpen(false):runMatcher()},
        "🪲 Predicted Hatches",
        React.createElement('span',{style:{fontSize:15,color:"var(--stone)",marginLeft:8,fontFamily:"sans-serif"}},open?"▲ collapse":"▼ show prediction"),
        loc&&React.createElement('button',{className:"rfsh",onClick:e=>{e.stopPropagation();runMatcher();}},"↻")
      ),
      React.createElement('div',{className:"csub"},"Prediction from live water temp, flows & season — not a real-time hatch report"),
      loading&&React.createElement('div',{className:"loading"},"Matching hatches…"),
      open&&!loading&&result&&result.map((h,i)=>
        React.createElement('div',{key:i,style:{padding:"10px 0",borderBottom:i<result.length-1?"1px solid rgba(255,255,255,0.06)":"none"}},
          React.createElement('div',{style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}},
            React.createElement('span',{style:{fontSize:14,color:"var(--foam)",fontFamily:"'Crimson Pro',serif",fontWeight:600}},h.name),
            React.createElement('span',{style:{fontSize:14,padding:"2px 8px",borderRadius:20,background:h.likelihood==="High"?"rgba(90,122,74,0.3)":h.likelihood==="Moderate"?"rgba(200,168,75,0.2)":"rgba(255,255,255,0.06)",color:h.likelihood==="High"?"#9cd47a":h.likelihood==="Moderate"?"var(--gold)":"var(--stone)"}},h.likelihood)
          ),
          React.createElement('div',{style:{fontSize:14,color:"var(--stone)",marginBottom:6}},"Water: "+h.waterTempRange+" · "+h.timing),
          React.createElement('div',{style:{display:"flex",flexWrap:"wrap",gap:4,marginBottom:6}},
            (h.flies||[]).map((f,j)=>React.createElement('a',{key:j,className:"chip",href:"https://www.google.com/search?q="+encodeURIComponent(f+" fly pattern")+"&tbm=isch",target:"_blank",rel:"noreferrer",style:{textDecoration:"none",cursor:"pointer"}},"🪶 "+f))
          ),
          h.notes&&React.createElement('div',{style:{fontSize:15,color:"var(--sky)",fontStyle:"italic"}},h.notes)
        )
      ),
      open&&!loading&&(!result||result.length===0)&&React.createElement('div',{style:{fontSize:15,color:"var(--stone)",fontStyle:"italic"}},"Tap ↻ to match hatches for current conditions.")
    )
  );
}

function HatchList({hatches}){
  const [selHatch, setSelHatch] = useState(null);
  return(
    <>
      {selHatch&&<HatchModal hatch={selHatch} onClose={()=>setSelHatch(null)}/>}
      {hatches.map(h=>(
        <div className="hr" key={h.name} style={{cursor:"pointer"}} onClick={()=>setSelHatch(h)}>
          <span className="hn">{h.name}</span>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span className="ha">{h.a}</span>
            <span style={{fontSize:14,color:"var(--stone)"}}>ℹ</span>
          </div>
        </div>
      ))}
    </>
  );
}


function HatchModal({hatch, onClose}){
  const d = HATCH_DETAILS[hatch.name] || {};
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:200,display:"flex",alignItems:"flex-end",justifyContent:"center"}} onClick={onClose}>
      <div style={{background:"var(--deep)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:"20px 20px 0 0",padding:"24px 20px 40px",width:"100%",maxWidth:430}} onClick={e=>e.stopPropagation()}>
        <div style={{width:36,height:4,background:"rgba(255,255,255,0.2)",borderRadius:2,margin:"0 auto 20px"}}/>
        <div style={{fontFamily:"'Playfair Display',serif",fontSize:22,color:"var(--gold)",marginBottom:4}}>{hatch.name}</div>
        {d.latin&&<div style={{fontSize:15,color:"var(--stone)",fontStyle:"italic",marginBottom:16}}>{d.latin}</div>}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16}}>
          {[["Hook Size",d.sizes||"Varies"],["Activity",hatch.a],["Timing",d.timing||"Seasonal"],["Depth",d.depth||"Surface"]].map(([l,v])=>(
            <div key={l} style={{background:"rgba(0,0,0,0.25)",borderRadius:10,padding:"10px 12px"}}>
              <div style={{fontSize:14,color:"var(--stone)",textTransform:"uppercase",letterSpacing:1,marginBottom:3}}>{l}</div>
              <div style={{fontSize:15,color:"var(--foam)"}}>{v}</div>
            </div>
          ))}
        </div>
        {d.patterns&&<>
          <div style={{fontSize:14,color:"var(--gold)",letterSpacing:1,textTransform:"uppercase",marginBottom:8}}>Matching Patterns</div>
          <div className="chips" style={{marginBottom:14}}>
            {d.patterns.map((p,i)=><a key={i} className="chip" href={`https://www.google.com/search?q=${encodeURIComponent(p+" fly pattern")}&tbm=isch`} target="_blank" rel="noreferrer" style={{textDecoration:"none"}}>🪶 {p}</a>)}
          </div>
        </>}
        {d.tip&&<div style={{background:"rgba(44,95,110,0.2)",border:"1px solid rgba(44,95,110,0.4)",borderRadius:12,padding:"12px 14px",fontSize:15,color:"var(--sky)",lineHeight:1.6}}>💡 {d.tip}</div>}
        <button className="btn" style={{width:"100%",marginTop:16}} onClick={onClose}>Done</button>
      </div>
    </div>
  );
}


// ── Week Forecast Component ───────────────────────────────────────────────────
function WeekForecast({data, highlightDay}){
  const [selDay, setSelDay] = useState(highlightDay||0);
  if(!data?.daily?.time) return null;
  const d = data.daily;

  const sel = selDay < d.time.length ? selDay : 0;
  const selDate = new Date(d.time[sel]+"T12:00:00");
  const selWind = d.wind_speed_10m_max?.[sel];
  const selGust = d.wind_gusts_10m_max?.[sel];
  const selWindDir = d.wind_direction_10m_dominant?.[sel];
  const selPres = d.surface_pressure_mean?.[sel];
  const selPresInHg = selPres ? (selPres*0.02953).toFixed(2) : null;

  // Pressure trend vs previous day
  const prevPres = sel>0 && d.surface_pressure_mean?.[sel-1];
  const trend = selPresInHg&&prevPres ? pressureTrend(parseFloat(selPresInHg),(prevPres*0.02953)) : null;

  return(
    <div>
      {/* 7-day strip */}
      <div style={{display:"flex",gap:4,overflowX:"auto",paddingBottom:4,marginBottom:10}}>
        {d.time.slice(0,7).map((date,i)=>{
          const dt=new Date(date+"T12:00:00");
          const isHi = i===(highlightDay??-1);
          const isSel = i===sel;
          return(
            <div key={i} onClick={()=>setSelDay(i)}
              style={{flex:"0 0 auto",width:54,background:isSel?"var(--water)":isHi?"rgba(200,168,75,0.15)":"rgba(0,0,0,0.2)",
                border:`1px solid ${isSel?"var(--water)":isHi?"var(--gold)":"rgba(255,255,255,0.08)"}`,
                borderRadius:10,padding:"8px 4px",textAlign:"center",cursor:"pointer",transition:"all .15s"}}>
              <div style={{fontSize:13,color:isSel?"var(--foam)":"var(--stone)",textTransform:"uppercase",letterSpacing:.5}}>{DAYS[dt.getDay()]}</div>
              <div style={{fontSize:22,margin:"4px 0"}}>{WX_EMOJI[d.weather_code?.[i]]||"🌡"}</div>
              <div style={{fontFamily:"'Playfair Display',serif",fontSize:16,color:isSel?"var(--foam)":"var(--foam)"}}>{Math.round(d.temperature_2m_max?.[i])}°</div>
              <div style={{fontSize:14,color:"var(--stone)"}}>{Math.round(d.temperature_2m_min?.[i])}°</div>
              {(d.precipitation_probability_max?.[i]??0)>0&&<div style={{fontSize:15,color:"#7ec8c8"}}>💧{d.precipitation_probability_max[i]}%</div>}
            </div>
          );
        })}
      </div>
      {/* Selected day detail */}
      <div style={{background:"rgba(0,0,0,0.2)",borderRadius:12,padding:"12px 14px"}}>
        <div style={{fontSize:17,color:"var(--gold)",fontFamily:"'Playfair Display',serif",marginBottom:10}}>
          {selDate.toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})}
          {" — "}{WX_DESC[d.weather_code?.[sel]]||""}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          <div style={{background:"rgba(0,0,0,0.2)",borderRadius:10,padding:"10px 8px",textAlign:"center"}}>
            <div style={{fontSize:13,color:"var(--stone)",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>High / Low</div>
            <div style={{fontFamily:"'Playfair Display',serif",fontSize:22,color:"var(--foam)"}}>{Math.round(d.temperature_2m_max?.[sel])}°</div>
            <div style={{fontSize:16,color:"var(--stone)"}}>{Math.round(d.temperature_2m_min?.[sel])}°</div>
          </div>
          <div style={{background:"rgba(0,0,0,0.2)",borderRadius:10,padding:"10px 8px",textAlign:"center"}}>
            <div style={{fontSize:15,color:"var(--stone)",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>Wind</div>
            <div style={{fontSize:17,color:"var(--foam)"}}>💨 {selWind?Math.round(selWind):"—"} mph</div>
            {selGust&&<div style={{fontSize:15,color:"var(--stone)"}}>Gusts {Math.round(selGust)}</div>}
            {selWindDir!=null&&<div style={{fontSize:15,color:"var(--sky)"}}>{windDir(selWindDir)}</div>}
          </div>
          <div style={{background:"rgba(0,0,0,0.2)",borderRadius:10,padding:"10px 8px",textAlign:"center"}}>
            <div style={{fontSize:15,color:"var(--stone)",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>Pressure</div>
            <div style={{fontSize:18,color:trend?.color||"var(--foam)",fontWeight:"bold"}}>{selPresInHg||"—"}"</div>
            {trend&&<div style={{fontSize:15,color:trend.color}}>{trend.icon} {trend.label}</div>}
          </div>
          <div style={{background:"rgba(0,0,0,0.2)",borderRadius:10,padding:"10px 8px",textAlign:"center"}}>
            <div style={{fontSize:15,color:"var(--stone)",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>Rain Chance</div>
            <div style={{fontSize:18,color:"var(--foam)"}}>🌧 {d.precipitation_probability_max?.[sel]??0}%</div>
          </div>
        </div>

      </div>
    </div>
  );
}

// ── Gauge Chart ──────────────────────────────────────────────────────────────
const TIMEFRAMES = [
  {label:"7D",  days:7},
  {label:"30D", days:30},
  {label:"90D", days:90},
  {label:"1Y",  days:365},
];

function GaugeChart({siteNo, siteName, initialCFS}){
  const [days, setDays]     = useState(30);
  const [points, setPoints] = useState([]);
  const [histAvg, setHistAvg] = useState([]);
  const [tempPoints, setTempPoints] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(()=>{
    if(!siteNo) return;
    setLoading(true);
    // Fetch current year data
    fetchUSGSRange(siteNo, days).then(pts=>{
      setPoints(pts);
      setLoading(false);
    });
    // Fetch prior year same period for historical average
    (async()=>{
      try{
        const e=new Date(); e.setFullYear(e.getFullYear()-1);
        const s=new Date(e); s.setDate(s.getDate()-days);
        const fmt=d=>d.toISOString().split("T")[0];
        const [flowRes,tempRes]=await Promise.all([
          fetch("https://waterservices.usgs.gov/nwis/dv/?format=json&sites="+siteNo+"&parameterCd=00060&startDT="+fmt(s)+"&endDT="+fmt(e)+"&statCd=00003"),
          fetch("https://waterservices.usgs.gov/nwis/dv/?format=json&sites="+siteNo+"&parameterCd=00010&startDT="+fmt(s)+"&endDT="+fmt(e)+"&statCd=00003")
        ]);
        const flowD=await flowRes.json();
        const ts=flowD.value?.timeSeries?.[0]?.values?.[0]?.value||[];
        const avg=ts.map(v=>({t:v.dateTime,v:parseFloat(v.value)})).filter(v=>!isNaN(v.v)&&v.v>0&&v.v<500000);
        setHistAvg(avg);
        try{
          const tempD=await tempRes.json();
          const tts=tempD.value?.timeSeries?.[0]?.values?.[0]?.value||[];
          const temps=tts.map(v=>({t:v.dateTime,v:parseFloat(v.value)*9/5+32})).filter(v=>!isNaN(v.v)&&v.v>0&&v.v<100);
          setTempPoints(temps);
        }catch{}
      }catch{}
    })();
  },[siteNo, days]);

  // SVG chart
  const W=290, H=90, PL=38, PR=8, PT=6, PB=22;
  const iW=W-PL-PR, iH=H-PT-PB;

  function renderChart(){
    if(!points.length) return null;
    const vals=points.map(p=>p.v);
    const minV=Math.min(...vals), maxV=Math.max(...vals), range=maxV-minV||1;
    const px=i=>PL+(i/(points.length-1))*iW;
    const py=v=>PT+iH-((v-minV)/range)*iH;
    const linePts=points.map((p,i)=>`${px(i)},${py(p.v)}`).join(" ");
    const areaPts=`${PL},${PT+iH} `+points.map((p,i)=>`${px(i)},${py(p.v)}`).join(" ")+` ${PL+iW},${PT+iH}`;

    // X axis labels — show 3 evenly spaced dates
    const xIdxs=[0,Math.floor(points.length/2),points.length-1];
    const yTicks=[minV,(minV+maxV)/2,maxV];

    // Temp line (secondary y-axis scaled independently)
    const tempLine=tempPoints&&tempPoints.length>1?(()=>{
      const tVals=tempPoints.map(p=>p.v);
      const tMin=Math.min(...tVals),tMax=Math.max(...tVals),tRange=tMax-tMin||1;
      const tStart=new Date(points[0].t).getTime(),tEnd=new Date(points[points.length-1].t).getTime(),tSpan=tEnd-tStart||1;
      const tPts=tempPoints.map(p=>{
        const tx=PL+((new Date(p.t).getTime()-tStart)/tSpan)*iW;
        const ty=PT+iH-((p.v-tMin)/tRange)*iH;
        return tx+","+ty;
      }).join(" ");
      return tPts;
    })():null;
    // Current value dot
    const lastPt=points[points.length-1];
    const dotX=PL+iW, dotY=py(lastPt.v);

    return(
      <svg width={W} height={H} style={{display:"block",maxWidth:"100%"}}>
        <defs>
          <linearGradient id={`fg-${siteNo}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#b8d4dc" stopOpacity="0.4"/>
            <stop offset="100%" stopColor="#b8d4dc" stopOpacity="0.02"/>
          </linearGradient>
        </defs>
        {[0,0.5,1].map((f,i)=>(
          <line key={i} x1={PL} x2={PL+iW} y1={PT+iH*(1-f)} y2={PT+iH*(1-f)} stroke="rgba(255,255,255,0.06)" strokeWidth="1"/>
        ))}
        {yTicks.map((v,i)=>(
          <text key={i} x={PL-4} y={py(v)+4} textAnchor="end" fontSize="9" fill="#8a8a7a">
            {v>=1000?`${(v/1000).toFixed(1)}k`:Math.round(v)}
          </text>
        ))}
        {xIdxs.map((idx,i)=>{
          const d=new Date(points[idx].t);
          const label=days<=7
            ? d.toLocaleString("en-US",{month:"numeric",day:"numeric",hour:"numeric",hour12:true}).replace(":00","")
            : `${d.getMonth()+1}/${d.getDate()}`;
          return <text key={i} x={px(idx)} y={H-4} textAnchor="middle" fontSize="9" fill="#8a8a7a">{label}</text>;
        })}
        <polygon points={areaPts} fill={`url(#fg-${siteNo})`}/>
        <polyline points={linePts} fill="none" stroke="#b8d4dc" strokeWidth="1.5" strokeLinejoin="round"/>
        {tempLine&&<polyline points={tempLine} fill="none" stroke="rgba(255,100,100,0.7)" strokeWidth="1.5" strokeLinejoin="round"/>}
        {histAvg.length>1&&(()=>{
          const hvals=histAvg.map(p=>p.v);
          const hpx=i=>PL+(i/(histAvg.length-1))*iW;
          const hpy=v=>PT+iH-((v-minV)/range)*iH;
          const hpts=histAvg.map((p,i)=>`${hpx(i)},${hpy(p.v)}`).join(" ");
          return <polyline points={hpts} fill="none" stroke="rgba(200,168,75,0.45)" strokeWidth="1" strokeDasharray="3,3" strokeLinejoin="round"/>;
        })()}
        <circle cx={dotX} cy={dotY} r="3" fill="#c8a84b"/>
        <text x={dotX+4} y={dotY+4} fontSize="9" fill="#c8a84b">
          {lastPt.v>=1000?`${(lastPt.v/1000).toFixed(1)}k`:Math.round(lastPt.v)}
        </text>
      </svg>
    );
  }

  return(
    <div style={{marginTop:10,borderTop:"1px solid rgba(255,255,255,0.07)",paddingTop:10}}>
      {/* Timeframe selector */}
      <div style={{display:"flex",gap:6,marginBottom:8,alignItems:"center"}}>
        <span style={{fontSize:14,color:"var(--stone)",marginRight:2}}>Show:</span>
        {TIMEFRAMES.map(tf=>(
          <button key={tf.label} onClick={e=>{e.stopPropagation();setDays(tf.days);}}
            style={{
              background:days===tf.days?"var(--water)":"rgba(0,0,0,0.3)",
              border:"1px solid "+(days===tf.days?"var(--water)":"rgba(255,255,255,0.12)"),
              borderRadius:6, padding:"3px 10px", color:days===tf.days?"var(--foam)":"var(--stone)",
              fontSize:14, cursor:"pointer", fontFamily:"'Crimson Pro',serif",
              transition:"all .15s"
            }}>
            {tf.label}
          </button>
        ))}
      </div>
      <div style={{display:"flex",gap:12,marginBottom:6,fontSize:14,color:"var(--stone)",alignItems:"center",flexWrap:"wrap"}}>
        <span style={{display:"inline-block",width:16,height:2,background:"#b8d4dc",verticalAlign:"middle"}}></span>Flow (CFS)
        {histAvg.length>0&&<><span style={{display:"inline-block",width:16,height:2,background:"rgba(200,168,75,0.6)",borderTop:"1px dashed rgba(200,168,75,0.6)",verticalAlign:"middle",marginLeft:8}}></span>Prev avg</>}
        {tempPoints.length>0&&<><span style={{display:"inline-block",width:16,height:2,background:"rgba(255,100,100,0.7)",verticalAlign:"middle",marginLeft:8}}></span>Water Temp (°F)</>}
      </div>
      {loading&&<div style={{fontSize:15,color:"var(--stone)",fontStyle:"italic",padding:"8px 0",animation:"pulse 1.5s infinite"}}>Loading chart…</div>}
      {!loading&&points.length>0&&renderChart()}
      {!loading&&points.length===0&&<div style={{fontSize:15,color:"var(--stone)",fontStyle:"italic"}}>No chart data available</div>}
    </div>
  );
}

// ── Gauge List with expandable charts ────────────────────────────────────────
function GaugeList({gauges,isStarred,toggleStar,showStarredOnly}){
  const [expanded, setExpanded] = useState(null);
  return(
    <div>
      {(showStarredOnly&&isStarred?gauges.filter(g=>isStarred(g.siteNo)):gauges||[]).map((g,i)=>(
        <div className="gi" key={i} style={{cursor:"pointer"}} onClick={()=>setExpanded(expanded===i?null:i)}>
          <div className="grow">
            <div style={{flex:1}}>{g.lat&&g.lng?<a href={`https://maps.google.com/?q=${g.lat},${g.lng}`} target="_blank" rel="noopener noreferrer" className="gname" style={{color:"var(--sky)",textDecoration:"none"}} onClick={e=>e.stopPropagation()}>{g.name}</a>:<span className="gname">{g.name}</span>}{g.distMi!=null&&<div style={{fontSize:14,color:"var(--stone)",marginTop:2}}>{g.distMi} miles away</div>}</div>
            <span className={`gbadge ${g.cls}`}>{g.label}</span>
            {toggleStar&&<button onClick={e=>{e.stopPropagation();toggleStar(g);}} style={{background:"none",border:"none",cursor:"pointer",fontSize:14,padding:"0 4px",color:isStarred&&isStarred(g.siteNo)?"var(--gold)":"var(--stone)"}}>
              {isStarred&&isStarred(g.siteNo)?"⭐":"☆"}
            </button>}
          </div>
          <div className="grow">
            <span className="gval">{g.cfs!=null?`${Number(g.cfs).toLocaleString()} CFS`:"No reading"}</span>
            {g.waterTempF&&<span style={{fontSize:14,color:"#7ec8c8",marginLeft:8}}>💧 {g.waterTempF}°F</span>}
            {g.histMax&&<span style={{fontSize:14,color:"var(--stone)",marginLeft:6}}>{g.pct}%</span>}
            <span style={{fontSize:14,color:"var(--stone)",marginLeft:"auto",paddingLeft:8}}>{expanded===i?"▲ hide chart":"▼ view chart"}</span>
          </div>
          {expanded===i&&(
            <GaugeChart siteNo={g.siteNo} siteName={g.name} initialCFS={g.cfs}/>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Location Search ───────────────────────────────────────────────────────────
function LocationSearch({onSelect,initialValue="",placeholder="Search river, city, or state…"}){
  const [query,setQuery]=useState(initialValue);
  const [suggs,setSuggs]=useState([]);
  const [open,setOpen]=useState(false);
  const [loading,setLoading]=useState(false);
  const [gpsState,setGpsState]=useState("idle");
  const [gpsMsg,setGpsMsg]=useState("");
  const debounce=useRef(null);
  const wrap=useRef(null);

  useEffect(()=>{if(initialValue)setQuery(initialValue);},[initialValue]);
  useEffect(()=>{
    const fn=e=>{if(wrap.current&&!wrap.current.contains(e.target))setOpen(false);};
    document.addEventListener("mousedown",fn);
    return()=>document.removeEventListener("mousedown",fn);
  },[]);

  function onChange(val){
    setQuery(val);
    clearTimeout(debounce.current);
    if(val.trim().length<2){setSuggs([]);setOpen(false);return;}
    debounce.current=setTimeout(()=>fetchSuggs(val),350);
  }

  async function fetchSuggs(val){
    setLoading(true);
    try{
      const data=await geocode(val);
      if(data.length){setSuggs(data.slice(0,6));setOpen(true);}
    }catch{}
    finally{setLoading(false);}
  }

  function pick(item){
    const label=cleanLabel(item);
    setQuery(label);setSuggs([]);setOpen(false);
    onSelect({lat:parseFloat(item.lat),lng:parseFloat(item.lon),label});
  }

  function handleGPS(){
    setGpsMsg("");setGpsState("loading");
    if(!navigator.geolocation){setGpsState("error");setGpsMsg("GPS not supported. Search manually.");return;}
    navigator.geolocation.getCurrentPosition(
      async pos=>{
        const{latitude:lat,longitude:lng}=pos.coords;
        try{
          const data=await reverseGeocode(lat,lng);
          const a=data.address||{};
          const city=a.city||a.town||a.village||a.hamlet||a.county||"";
          const state=a.state_code||a.state||"";
          const label=city&&state?`${city}, ${state}`:city||(state||fmtCoord(lat,lng));
          setQuery(label);setGpsState("idle");
          onSelect({lat,lng,label});
        }catch{
          const label=fmtCoord(lat,lng);
          setQuery(label);setGpsState("idle");
          onSelect({lat,lng,label});
        }
      },
      err=>{
        setGpsState("error");
        setGpsMsg(err.code===1?"Location denied. Search manually.":"GPS unavailable. Search manually.");
      },
      {timeout:8000,enableHighAccuracy:true}
    );
  }

  return(
    <div ref={wrap} style={{position:"relative"}}>
      <div className="search-row">
        <div style={{position:"relative",flex:1}}>
          <input className="search-input" placeholder={placeholder} value={query}
            onChange={e=>onChange(e.target.value)}
            onFocus={()=>suggs.length&&setOpen(true)}
            autoComplete="off" spellCheck={false}/>
          {loading&&<span style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",color:"var(--sky)",fontSize:15,animation:"pulse 1s infinite"}}>✦</span>}
        </div>
        <button className="gps-btn" onClick={handleGPS} disabled={gpsState==="loading"} title="Use my location">
          {gpsState==="loading"?"…":"📍"}
        </button>
      </div>
      {gpsState==="error"&&<div style={{marginTop:6,padding:"8px 12px",background:"rgba(150,80,80,0.15)",border:"1px solid rgba(150,80,80,0.3)",borderRadius:10,fontSize:15,color:"var(--red)",lineHeight:1.5}}>{gpsMsg}</div>}
      {open&&suggs.length>0&&(
        <div className="sugg-list">
          {suggs.map((item,i)=>(
            <div key={i} className="sugg" onMouseDown={()=>pick(item)}>
              <span style={{fontSize:16}}>{locIcon(item)}</span>
              <span className="sugg-label">{cleanLabel(item)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}




// ── Trip Report PDF Generator ─────────────────────────────────────────────────
function generateTripReportPDF(guest, trip, reportText){
  const date = new Date(trip.date+"T12:00:00").toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});

  // Build photo grid HTML
  const photoGrid = (trip.photos||[]).length > 0 ? `
    <div class="photo-grid">
      ${(trip.photos||[]).map(p=>`<div class="photo-wrap"><img src="${p}" class="photo-img"/></div>`).join("")}
    </div>
  ` : `<div class="no-photos">No photos recorded for this trip</div>`;

  // Build conditions row
  const conditionItems = [];
  if(trip.weatherConditions) conditionItems.push(`<div class="cond-item"><span class="cond-icon">${trip.weatherConditions.split(" ")[0]}</span><span class="cond-val">${trip.weatherConditions.replace(/^[^\s]+\s/,"")}</span><span class="cond-lbl">Sky</span></div>`);
  if(trip.airTemp) conditionItems.push(`<div class="cond-item"><span class="cond-icon">🌡</span><span class="cond-val">${trip.airTemp}°F</span><span class="cond-lbl">Air Temp</span></div>`);
  if(trip.waterTemp) conditionItems.push(`<div class="cond-item"><span class="cond-icon">💧</span><span class="cond-val">${trip.waterTemp}°F</span><span class="cond-lbl">Water Temp</span></div>`);
  if(trip.windSpeed) conditionItems.push(`<div class="cond-item"><span class="cond-icon">💨</span><span class="cond-val">${trip.windSpeed} mph ${trip.windDir||""}</span><span class="cond-lbl">Wind</span></div>`);
  if(trip.pressure) conditionItems.push(`<div class="cond-item"><span class="cond-icon">📊</span><span class="cond-val">${trip.pressure}"</span><span class="cond-lbl">Pressure ${trip.pressureTrend||""}</span></div>`);
  if(trip.streamCFS) conditionItems.push(`<div class="cond-item"><span class="cond-icon">🌊</span><span class="cond-val">${Number(trip.streamCFS).toLocaleString()} CFS</span><span class="cond-lbl">${trip.streamCondition||"Flow"}</span></div>`);

  // Build flies list
  const fliesList = (trip.flies||[]).length > 0
    ? `<div class="flies-row">${(trip.flies||[]).map(f=>`<span class="fly-tag">🪶 ${f}</span>`).join("")}</div>`
    : "";

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<title>Trip Report — ${guest.name}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Crimson+Pro:ital,wght@0,300;0,400;0,600;1,400&display=swap');
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'Crimson Pro',serif;background:#fff;color:#1a2e35;width:210mm;margin:0 auto;}
  @media print{body{width:100%;}@page{margin:0;size:letter;}}

  /* Header band */
  .header{background:linear-gradient(135deg,#1a3a45,#2c5f6e);color:#e8dfc8;padding:32px 40px 24px;position:relative;}
  .brand{font-family:'Playfair Display',serif;font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#b8d4dc;margin-bottom:6px;}
  .report-title{font-family:'Playfair Display',serif;font-size:32px;font-weight:700;color:#e8dfc8;margin-bottom:4px;}
  .report-title span{color:#c8a84b;font-style:italic;}
  .report-meta{font-size:14px;color:#b8d4dc;margin-top:8px;line-height:1.8;}
  .header-accent{position:absolute;bottom:0;right:40px;font-size:64px;opacity:0.15;}
  .divider-gold{height:3px;background:linear-gradient(90deg,#c8a84b,transparent);margin:0;}

  /* Conditions section */
  .section{padding:24px 40px;}
  .section-title{font-family:'Playfair Display',serif;font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#2c5f6e;border-bottom:1px solid #d0dfe3;padding-bottom:8px;margin-bottom:16px;}
  .conditions-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:12px;}
  .cond-item{background:#f0f5f7;border-radius:10px;padding:12px 8px;text-align:center;border:1px solid #d0dfe3;}
  .cond-icon{display:block;font-size:20px;margin-bottom:4px;}
  .cond-val{display:block;font-family:'Playfair Display',serif;font-size:15px;color:#1a3a45;font-weight:700;}
  .cond-lbl{display:block;font-size:10px;color:#6a8a94;text-transform:uppercase;letter-spacing:1px;margin-top:2px;}
  .stream-bar{background:#e8f0f3;border-radius:10px;padding:12px 16px;margin-top:12px;display:flex;align-items:center;gap:12px;border-left:4px solid #2c5f6e;}
  .stream-name{font-family:'Playfair Display',serif;font-size:14px;color:#1a3a45;font-style:italic;}
  .stream-stats{font-size:13px;color:#2c5f6e;margin-left:auto;}

  /* Trip stats bar */
  .stats-bar{background:#1a3a45;padding:14px 40px;display:flex;gap:32px;align-items:center;}
  .stat{text-align:center;}
  .stat-val{font-family:'Playfair Display',serif;font-size:20px;color:#c8a84b;}
  .stat-lbl{font-size:10px;color:#b8d4dc;text-transform:uppercase;letter-spacing:1px;}
  .stat-div{width:1px;height:32px;background:rgba(255,255,255,0.15);}

  /* Photos section */
  .photo-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;}
  .photo-wrap{border-radius:10px;overflow:hidden;aspect-ratio:4/3;}
  .photo-img{width:100%;height:100%;object-fit:cover;display:block;}
  .no-photos{padding:32px;text-align:center;color:#8a9a9e;font-style:italic;background:#f5f8f9;border-radius:10px;border:1px dashed #c0cfd3;}

  /* Flies */
  .flies-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px;}
  .fly-tag{background:#e8f0f3;border:1px solid #b8d4dc;border-radius:20px;padding:4px 12px;font-size:12px;color:#2c5f6e;}

  /* Report text */
  .report-text{font-size:15px;line-height:1.9;color:#1a2e35;} .report-text h2{font-size:17px;font-weight:600;color:#1a2e35;margin:20px 0 8px;font-family:'Playfair Display',serif;} .report-text h3{font-size:15px;font-weight:600;color:#2c5f6e;margin:16px 0 6px;} .report-text p{margin:0 0 14px;} .report-text strong{color:#1a2e35;}

  /* Footer */
  .footer{background:#f0f5f7;border-top:1px solid #d0dfe3;padding:16px 40px;display:flex;justify-content:space-between;align-items:center;margin-top:auto;}
  .footer-brand{font-family:'Playfair Display',serif;font-size:14px;color:#2c5f6e;}
  .footer-brand span{color:#c8a84b;font-style:italic;}
  .footer-note{font-size:11px;color:#8a9a9e;font-style:italic;}

  .section-bg{background:#f8fbfc;}
</style>
</head>
<body>

<!-- HEADER -->
<div class="header">
  <div class="brand">Guide's Choice · Fly Fishing Journal</div>
  <div class="report-title">Trip Report · <span>${guest.name}</span></div>
  <div class="report-meta">
    📅 ${date}
    ${trip.location ? ` &nbsp;·&nbsp; 📍 ${trip.location}` : ""}
    ${trip.type ? ` &nbsp;·&nbsp; ${trip.type} Trip` : ""}
    ${guest.skillLevel ? ` &nbsp;·&nbsp; ${guest.skillLevel==="Beginner"?"🌱":guest.skillLevel==="Intermediate"?"🎣":"🏆"} ${guest.skillLevel}` : ""}
  </div>
  <div class="header-accent">🎣</div>
</div>
<div class="divider-gold"></div>

<!-- STATS BAR -->
<div class="stats-bar">
  <div class="stat"><div class="stat-val">~${trip.catches||0}</div><div class="stat-lbl">Fish Caught</div></div>
  ${(trip.styles||[]).length>0?`<div class="stat-div"></div><div class="stat"><div class="stat-val" style="font-size:14px">${(trip.styles||[]).join(", ")}</div><div class="stat-lbl">Techniques</div></div>`:""}
  ${(trip.gear)?`<div class="stat-div"></div><div class="stat"><div class="stat-val" style="font-size:14px">${trip.gear}</div><div class="stat-lbl">Gear</div></div>`:""}

</div>

<!-- CONDITIONS -->
${conditionItems.length>0?`
<div class="section">
  <div class="section-title">Conditions on the Water</div>
  <div class="conditions-grid">${conditionItems.join("")}</div>
  ${trip.streamGaugeName?`<div class="stream-bar"><div>🏞 <span class="stream-name">${trip.streamGaugeName}</span></div>${trip.streamCFS?`<div class="stream-stats">${Number(trip.streamCFS).toLocaleString()} CFS · ${trip.streamCondition||""}</div>`:""}</div>`:""}
</div>
<div style="height:1px;background:#e0ebee;margin:0 40px;"></div>
`:""}

<!-- FLIES -->
${(trip.flies||[]).length>0?`
<div class="section">
  <div class="section-title">Flies That Worked</div>
  ${fliesList}
</div>
<div style="height:1px;background:#e0ebee;margin:0 40px;"></div>
`:""}

<!-- PHOTOS -->
<div class="section section-bg">
  <div class="section-title">On the Water</div>
  ${photoGrid}
</div>
<div style="height:1px;background:#e0ebee;margin:0 40px;"></div>

<!-- REPORT -->
${reportText?`
<div class="section">
  <div class="section-title">Guide's Trip Report</div>
  <div class="report-text">${(()=>{let t=reportText.replace(/#+\s*/g,"").replace(/\*\*/g,"").replace(/\*/g,"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");t=t.replace(/\n\n/g,"</p><p>").replace(/\n/g,"<br/>");return"<p>"+t+"</p>";})()}</div>
</div>
`:""}

<!-- FOOTER -->
<div class="footer">
  <div class="footer-brand">Guide's <span>Choice</span> · Fly Fishing Journal</div>
  <div class="footer-note">Generated ${new Date().toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"})}</div>
</div>

</body>
</html>`;

  // Open in new window and trigger print to PDF
  const win = window.open("","_blank","width=900,height=700");
  // Add close button to PDF window
  const closeBtn=`<div style="position:fixed;top:12px;right:12px;z-index:9999;display:flex;gap:8px;"><button onclick="window.print()" style="background:#c8a84b;color:#1a2e35;border:none;border-radius:8px;padding:8px 16px;font-size:14px;cursor:pointer;font-family:serif;">🖨 Print / Save PDF</button><button onclick="window.close()" style="background:#1a3a45;color:#e8dfc8;border:none;border-radius:8px;padding:8px 16px;font-size:14px;cursor:pointer;font-family:serif;">✕ Close</button></div>`;
  win.document.write(html.replace("</body>","</body>"));
  win.document.body.insertAdjacentHTML("afterbegin",closeBtn);
  win.document.close();
  win.onload = () => {
    setTimeout(()=>{
      win.focus();
    }, 300);
  };
}

// ── Trip Location + Weather Auto-Fetch ───────────────────────────────────────
function TripLocationWeather({tripForm, setTripForm}){
  const [wxLoading, setWxLoading] = useState(false);
  const [wxFetched, setWxFetched] = useState(false);
  const [nearbyGauges, setNearbyGauges] = useState([]);

  async function fetchTripWeather(location){
    if(!location.trim()) return;
    setWxLoading(true);
    try{
      const geoData = await geocode(location);
      if(!geoData.length){ setWxLoading(false); return; }
      const lat=parseFloat(geoData[0].lat), lng=parseFloat(geoData[0].lon);
      const wx = await fetchWeather(lat, lng);
      const c = wx.current;
      const presInHg = (c.surface_pressure*0.02953).toFixed(2);
      const presNum = parseFloat(presInHg);
      // Determine sky condition from weather code
      const code = c.weather_code;
      let sky = "☀️ Sunny";
      if(code>=95) sky="⛈ Thunderstorm";
      else if(code>=80) sky="🌧 Rainy";
      else if(code>=71) sky="❄️ Snowing";
      else if(code>=61) sky="🌧 Rainy";
      else if(code>=51) sky="🌧 Rainy";
      else if(code>=45) sky="🌫 Foggy";
      else if(code>=3)  sky="☁️ Overcast";
      else if(code>=2)  sky="🌤 Partly Cloudy";
      else if(code>=1)  sky="🌤 Partly Cloudy";
      // Determine pressure trend
      let pTrend = "Steady";
      // Check daily pressure for trend
      const daily = wx.daily?.surface_pressure_mean;
      if(daily&&daily.length>=2){
        const diff = (daily[0]-daily[1])*0.02953;
        if(diff>1.5) pTrend="Rising Fast";
        else if(diff>0.3) pTrend="Rising";
        else if(diff<-1.5) pTrend="Falling Fast";
        else if(diff<-0.3) pTrend="Falling";
      }
      setTripForm(f=>({
        ...f,
        airTemp: String(Math.round(c.temperature_2m)),
        windSpeed: String(Math.round(c.wind_speed_10m)),
        windDir: windDir(c.wind_direction_10m),
        pressure: presInHg,
        pressureTrend: pTrend,
        weatherConditions: sky,
      }));
      // Also fetch stream gauges for the location
      try{
        const gaugeData = await fetchUSGSLive(lat, lng);
        const ts = gaugeData.value?.timeSeries||[];
        if(ts.length>0){
          // Sort by distance and take top 5
          const gauges = ts.map(t=>{
            const raw=t.values?.[0]?.value?.[0]?.value;
            const cfs=raw!=null?parseFloat(raw):null;
            const sLat=parseFloat(t.sourceInfo?.geoLocation?.geogLocation?.latitude||0);
            const sLng=parseFloat(t.sourceInfo?.geoLocation?.geogLocation?.longitude||0);
            const dist=Math.sqrt(Math.pow(sLat-lat,2)+Math.pow(sLng-lng,2));
            const {label}=cfsLabel(cfs);
            return{name:t.sourceInfo?.siteName||"Unknown",cfs,label,dist,siteNo:(t.sourceInfo?.siteCode?.[0]?.value)||"",lat:sLat,lng:sLng};
          }).filter(g=>g.cfs!=null&&g.cfs>=0&&g.cfs<500000).sort((a,b)=>a.dist-b.dist).slice(0,5);
          setNearbyGauges(gauges);
          // Auto-select closest gauge
          if(gauges.length>0){
            setTripForm(f=>({...f, streamCFS:String(Math.round(gauges[0].cfs)), streamCondition:gauges[0].label, streamGaugeName:gauges[0].name}));
          }
        }
      }catch(e2){ console.error("Stream fetch failed:", e2); }
      setWxFetched(true);
    }catch(e){ console.error("Weather fetch failed:", e); }
    finally{ setWxLoading(false); }
  }

  return(
    <div>
      <div style={{display:"flex",gap:8,marginBottom:12}}>
        <input className="inp" style={{marginBottom:0,flex:1}} placeholder="e.g. River name or gauge #"
          value={tripForm.location}
          onChange={e=>setTripForm(f=>({...f,location:e.target.value}))}/>
        <button className="btn" style={{whiteSpace:"nowrap",padding:"0 12px"}} disabled={wxLoading}
          onClick={()=>fetchTripWeather(tripForm.location)}>
          {wxLoading?"⏳ Fetching…":"🌤 Get Conditions"}
        </button>
      </div>
      {wxFetched&&<div style={{fontSize:14,color:"#9cd47a",marginBottom:8,fontStyle:"italic"}}>✓ Conditions auto-populated — adjust below if needed</div>}
      {nearbyGauges.length>0&&(
        <div style={{marginBottom:12}}>
          <div className="lbl" style={{marginBottom:6}}>Select Body of Water Being Fished</div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {nearbyGauges.map((g,i)=>(
              <button key={i} onClick={()=>setTripForm(f=>({...f,streamCFS:String(Math.round(g.cfs)),streamCondition:g.label,streamGaugeName:g.name}))}
                style={{padding:"10px 12px",borderRadius:10,border:"1px solid "+(tripForm.streamGaugeName===g.name?"var(--water)":"rgba(255,255,255,0.1)"),background:tripForm.streamGaugeName===g.name?"rgba(44,95,110,0.5)":"rgba(0,0,0,0.2)",color:"var(--foam)",fontFamily:"'Crimson Pro',serif",fontSize:15,cursor:"pointer",textAlign:"left",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span>{g.name}</span>
                <span style={{fontSize:14,color:"var(--sky)"}}>{Number(g.cfs).toLocaleString()} CFS · {g.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <label className="lbl">Weather Conditions</label>
      <div style={{background:"rgba(0,0,0,0.2)",borderRadius:12,padding:"12px 14px",marginBottom:12}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
          <div>
            <div className="lbl" style={{marginBottom:4}}>Air Temp (°F)</div>
            <input className="inp" style={{marginBottom:0}} type="number" placeholder="65"
              value={tripForm.airTemp||""}
              onChange={e=>setTripForm(f=>({...f,airTemp:e.target.value}))}/>
          </div>
          <div>
            <div className="lbl" style={{marginBottom:4}}>Water Temp (°F)</div>
            <input className="inp" style={{marginBottom:0}} type="number" placeholder="52"
              value={tripForm.waterTemp||""}
              onChange={e=>setTripForm(f=>({...f,waterTemp:e.target.value}))}/>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
          <div>
            <div className="lbl" style={{marginBottom:4}}>Wind (mph)</div>
            <input className="inp" style={{marginBottom:0}} type="number" placeholder="8"
              value={tripForm.windSpeed||""}
              onChange={e=>setTripForm(f=>({...f,windSpeed:e.target.value}))}/>
          </div>
          <div>
            <div className="lbl" style={{marginBottom:4}}>Wind Direction</div>
            <input className="inp" style={{marginBottom:0}} placeholder="SW"
              value={tripForm.windDir||""}
              onChange={e=>setTripForm(f=>({...f,windDir:e.target.value}))}/>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
          <div>
            <div className="lbl" style={{marginBottom:4}}>Pressure (inHg)</div>
            <input className="inp" style={{marginBottom:0}} placeholder="29.92"
              value={tripForm.pressure||""}
              onChange={e=>setTripForm(f=>({...f,pressure:e.target.value}))}/>
          </div>
          <div>
            <div className="lbl" style={{marginBottom:4}}>Pressure Trend</div>
            <select className="inp" style={{marginBottom:0}}
              value={tripForm.pressureTrend||""}
              onChange={e=>setTripForm(f=>({...f,pressureTrend:e.target.value}))}>
              <option value="">Select…</option>
              <option value="Rising Fast">↑↑ Rising Fast</option>
              <option value="Rising">↑ Rising</option>
              <option value="Steady">→ Steady</option>
              <option value="Falling">↓ Falling</option>
              <option value="Falling Fast">↓↓ Falling Fast</option>
            </select>
          </div>
        </div>
        <div className="lbl" style={{marginBottom:4}}>Sky / Conditions</div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {["☀️ Sunny","🌤 Partly Cloudy","☁️ Overcast","🌧 Rainy","🌫 Foggy","❄️ Snowing","🌬 Windy"].map(c=>(
            <button key={c} onClick={()=>setTripForm(f=>({...f,weatherConditions:c}))}
              style={{padding:"5px 10px",borderRadius:8,border:"1px solid "+(tripForm.weatherConditions===c?"var(--water)":"rgba(255,255,255,0.12)"),background:tripForm.weatherConditions===c?"var(--water)":"rgba(0,0,0,0.3)",color:tripForm.weatherConditions===c?"var(--foam)":"var(--stone)",fontSize:15,cursor:"pointer",fontFamily:"'Crimson Pro',serif"}}>
              {c}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Guide Book ────────────────────────────────────────────────────────────────
const FISHING_STYLES = ["Nymphing","Dry Fly","Streamer","Wet Fly","Euro Nymphing","Indicator","Sight Fishing"];
const TRIP_TYPES = ["Wade","Float","Boat","Stillwater"];

// ── Guide Stats ───────────────────────────────────────────────────────────────
function GuideStats({guests}){
  const trips=(guests||[]).flatMap(g=>(g.trips||[]).map(t=>({...t,guestName:g.name})));
  const totalTrips=trips.length;
  const totalCatches=trips.reduce((s,t)=>s+(t.catches||0),0);
  const totalRevenue=trips.reduce((s,t)=>s+(parseFloat(t.tripCost)||0),0);
  const totalTips=trips.reduce((s,t)=>s+(parseFloat(t.tipAmount)||0),0);
  const avgCatches=totalTrips>0?(totalCatches/totalTrips).toFixed(1):0;
  const thisYear=new Date().getFullYear();
  const yearTrips=trips.filter(t=>t.date&&t.date.startsWith(String(thisYear)));
  const speciesCounts={};
  trips.forEach(t=>(t.catchDetails||[]).forEach(cd=>{if(cd.species)speciesCounts[cd.species]=(speciesCounts[cd.species]||0)+1;}));
  const topSpecies=Object.entries(speciesCounts).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const flyCounts={};
  trips.forEach(t=>(t.flies||[]).forEach(f=>{if(f){const k=f.toLowerCase().trim();flyCounts[k]=(flyCounts[k]||0)+1;}}));
  const topFlies=Object.entries(flyCounts).sort((a,b)=>b[1]-a[1]).slice(0,6);
  if(!totalTrips) return <div className="empty"><div className="ei">📊</div><p>Stats will appear once you have logged trips.</p></div>;
  return(
    <div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
        {[{label:"Total Trips",val:totalTrips,icon:"🗓"},{label:"Total Catches",val:totalCatches,icon:"🐟"},{label:"Revenue",val:"$"+totalRevenue.toLocaleString(),icon:"💵"},{label:"Tips",val:"$"+totalTips.toLocaleString(),icon:"🤝"},{label:"Avg Catches/Trip",val:avgCatches,icon:"📊"},{label:thisYear+" Trips",val:yearTrips.length,icon:"📅"}].map(s=>(
          <div key={s.label} style={{background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:14,padding:"14px 12px",textAlign:"center"}}>
            <div style={{fontSize:22,marginBottom:4}}>{s.icon}</div>
            <div style={{fontFamily:"'Playfair Display',serif",fontSize:22,color:"var(--foam)"}}>{s.val}</div>
            <div style={{fontSize:14,color:"var(--stone)",letterSpacing:1,textTransform:"uppercase",marginTop:2}}>{s.label}</div>
          </div>
        ))}
      </div>
      {topSpecies.length>0&&(
        <div className="card" style={{marginBottom:12}}>
          <div className="ctitle">🐟 Top Species</div>
          {topSpecies.map(([sp,ct])=>(
            <div key={sp} style={{marginBottom:8}}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:15,color:"var(--foam)",marginBottom:3}}><span>{sp}</span><span style={{color:"var(--sky)"}}>{ct} caught</span></div>
              <div style={{background:"rgba(0,0,0,0.3)",borderRadius:6,height:8,overflow:"hidden"}}><div style={{height:"100%",background:"linear-gradient(90deg,var(--sky),var(--water))",borderRadius:6,width:Math.round((ct/topSpecies[0][1])*100)+"%"}}/></div>
            </div>
          ))}
        </div>
      )}
      {topFlies.length>0&&(
        <div className="card">
          <div className="ctitle">🪶 Top Flies</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
            {topFlies.map(([fly,ct])=>(<span key={fly} style={{background:"rgba(200,168,75,0.2)",border:"1px solid rgba(200,168,75,0.4)",borderRadius:20,padding:"4px 12px",fontSize:15,color:"var(--gold)"}}>🪶 {fly} <span style={{color:"var(--stone)",fontSize:14}}>×{ct}</span></span>))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Guide Season Log ──────────────────────────────────────────────────────────
function GuideSeasonLog({guests}){
  const allTrips=(guests||[]).flatMap(g=>(g.trips||[]).map(t=>({...t,guestName:g.name})));
  const sorted=[...allTrips].sort((a,b)=>(b.date||"").localeCompare(a.date||""));
  const thisYear=new Date().getFullYear();
  const display=sorted.filter(t=>t.date&&t.date.startsWith(String(thisYear)));
  const show=display.length?display:sorted.slice(0,20);
  if(!show.length) return <div className="empty"><div className="ei">📅</div><p>No trips logged yet.</p></div>;
  return(
    <div>
      <div style={{fontFamily:"'Playfair Display',serif",fontSize:15,color:"var(--stone)",letterSpacing:1,textTransform:"uppercase",marginBottom:10}}>
        {display.length?thisYear+" Season — "+display.length+" trips":"All Trips"} · {show.reduce((s,t)=>s+(t.catches||0),0)} fish
      </div>
      {show.map(t=>(
        <div key={t.id} className="card" style={{marginBottom:10,padding:"14px 16px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
            <div>
              <div style={{fontFamily:"'Playfair Display',serif",fontSize:15,color:"var(--foam)",fontStyle:"italic"}}>{t.location||"Unnamed Location"}</div>
              <div style={{fontSize:14,color:"var(--stone)",marginTop:2}}>{t.guestName} · {new Date(t.date+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}</div>
            </div>
            <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:3}}>
              {t.catches>0&&<span style={{fontSize:15,color:"var(--sky)"}}>🐟 {t.catches}</span>}
              {t.streamCFS&&<span style={{fontSize:14,color:"var(--stone)"}}>{Number(t.streamCFS).toLocaleString()} CFS</span>}
            </div>
          </div>
          {t.flies&&t.flies.length>0&&(
            <div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:4}}>
              {t.flies.slice(0,3).map((f,i)=><span key={i} style={{background:"rgba(74,122,58,0.25)",border:"1px solid rgba(74,122,58,0.4)",borderRadius:20,padding:"2px 10px",fontSize:14,color:"var(--sky)"}}>🪶 {f}</span>)}
              {t.flies.length>3&&<span style={{fontSize:14,color:"var(--stone)",padding:"2px 6px"}}>+{t.flies.length-3}</span>}
            </div>
          )}
          {(t.tripCost||t.tipAmount)&&(
            <div style={{display:"flex",gap:12,marginTop:6,fontSize:15}}>
              {t.tripCost&&<span style={{color:"var(--gold)"}}>💵 ${t.tripCost}</span>}
              {t.tipAmount&&<span style={{color:"#9cd47a"}}>🤝 ${t.tipAmount}</span>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Guide Saved Gauges ────────────────────────────────────────────────────────
function GuideSavedGauges({user}){
  const [gaugeInput,setGaugeInput]=useState("");
  const [savedGauges,setSavedGauges]=useState([]);
  const [showStarredOnly,setShowStarredOnly]=useState(false);
  const [gaugeAdding,setGaugeAdding]=useState(false);
  const [sgData,setSgData]=useState([]);
  const [expanded,setExpanded]=useState(null);
  const [loading,setLoading]=useState(true);
  useEffect(()=>{
    if(!sb||!user?.id){setLoading(false);return;}
    sb.from("saved_gauges").select("*").eq("user_id",user.id).then(({data})=>{setSavedGauges(data||[]);setLoading(false);}).catch(()=>setLoading(false));
  },[user?.id]);
  useEffect(()=>{
    if(!savedGauges.length){setSgData([]);return;}
    Promise.all(savedGauges.map(async g=>{
      try{const r=await fetch("https://waterservices.usgs.gov/nwis/iv/?format=json&sites="+g.site_no+"&parameterCd=00060&siteStatus=all");const d=await r.json();const ts=d.value?.timeSeries?.[0];const raw=ts?.values?.[0]?.value?.[0]?.value;const cfs=raw!=null?parseFloat(raw):null;const{label,cls}=cfsLabel(cfs);return{...g,cfs,label,cls};}
      catch{return{...g,cfs:null,label:"N/A",cls:""};}
    })).then(setSgData);
  },[savedGauges.length]);
  async function addGauge(){
    if(!gaugeInput.trim()||!sb)return;setGaugeAdding(true);
    let siteNo=gaugeInput.trim();const match=siteNo.match(/sites?=(\d+)/i)||siteNo.match(/(\d{8,})/);if(match)siteNo=match[1];
    try{const r=await fetch("https://waterservices.usgs.gov/nwis/iv/?format=json&sites="+siteNo+"&parameterCd=00060");const d=await r.json();const ts=d.value?.timeSeries?.[0];const name=ts?.sourceInfo?.siteName||"Site "+siteNo;const{data}=await sb.from("saved_gauges").insert({user_id:user.id,site_no:siteNo,name,url:"https://waterdata.usgs.gov/monitoring-location/"+siteNo+"/"}).select().single();if(data){setSavedGauges(g=>[...g,data]);setGaugeInput("");}}
    catch(e){alert("Could not add gauge: "+e.message);}setGaugeAdding(false);
  }
  return(
    <div>
      <div style={{display:"flex",gap:8,marginBottom:14}}>
        <input className="inp" value={gaugeInput} onChange={e=>setGaugeInput(e.target.value)} placeholder="USGS site # or waterdata.usgs.gov URL" onKeyDown={e=>e.key==="Enter"&&addGauge()} style={{flex:1,margin:0}}/>
        <button className="btn" onClick={addGauge} disabled={gaugeAdding} style={{flexShrink:0}}>{gaugeAdding?"…":"+ Add"}</button>
      </div>
      {loading&&<div className="loading">Loading gauges…</div>}
      {!loading&&!savedGauges.length&&<div className="empty"><div className="ei">⭐</div><p>Pin your favorite USGS gauges here.</p></div>}
      {sgData.map((g,i)=>(
        <div key={g.id||i} className="card" style={{marginBottom:10,padding:"14px 16px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",cursor:"pointer"}} onClick={()=>setExpanded(expanded===i?null:i)}>
            <div><div style={{fontFamily:"'Playfair Display',serif",fontSize:14,color:"var(--foam)",fontStyle:"italic"}}>{g.name}</div><div style={{fontSize:14,color:"var(--stone)",marginTop:3}}>Site {g.site_no}</div></div>
            <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4}}>
              {g.cfs!=null&&<span className={"gbadge "+(g.cls||"")}>{g.cfs>=1000?(g.cfs/1000).toFixed(1)+"k":g.cfs?.toFixed(0)} CFS</span>}
              <span className={"gbadge "+(g.cls||"")} style={{fontSize:14}}>{g.label}</span>
            </div>
          </div>
          <div style={{display:"flex",gap:10,marginTop:10}}>
            <a href={g.url||"https://waterdata.usgs.gov/monitoring-location/"+g.site_no+"/"} target="_blank" rel="noreferrer" style={{fontSize:15,color:"var(--sky)",textDecoration:"none"}}>📊 View Chart</a>
            <button onClick={async(e)=>{e.stopPropagation();await sb.from("saved_gauges").delete().eq("id",g.id);setSavedGauges(x=>x.filter(s=>s.id!==g.id));}} style={{background:"none",border:"none",color:"var(--stone)",fontSize:15,cursor:"pointer",padding:0,fontFamily:"'Crimson Pro',serif"}}>✕ Remove</button>
            <span style={{fontSize:14,color:"var(--stone)",marginLeft:8}}>{expanded===i?"▲ hide":"▼ chart"}</span>
          </div>
          {expanded===i&&g.site_no&&<GaugeChart siteNo={g.site_no} siteName={g.name} initialCFS={g.cfs}/>}
        </div>
      ))}
    </div>
  );
}


function GuideBook({user, loc}){
  const [guests, setGuests] = useState([]);
  const [guestsLoading, setGuestsLoading] = useState(true);
  const [migrationStatus, setMigrationStatus] = useState(null);
  const [editingTripCatchIdx, setEditingTripCatchIdx] = useState(null);
  // Ref so handleTripPhoto always gets current loc, not stale closure value
  const locRef = useRef(loc);
  useEffect(()=>{locRef.current=loc;},[loc]);

  async function runPhotoMigration(){
    if(!sb||!user?.id) return;
    setMigrationStatus("Starting migration...");
    try{
      const {data:tp}=await sb.from("trip_photos").select("id,trip_id").limit(100);
      let migrated=0;
      for(const row of (tp||[])){
        const {data:pd}=await sb.from("trip_photos").select("photo").eq("id",row.id).single();
        if(!pd?.photo||!pd.photo.startsWith("data:")) continue;
        const url=await uploadPhotoToStorage(pd.photo,`trips/${row.trip_id}`);
        if(url){
          await sb.from("trip_photos").update({photo:url}).eq("id",row.id);
          migrated++;
          setMigrationStatus(`Migrating... ${migrated} done`);
        }
      }
      const {data:cp}=await sb.from("catches").select("id,photo").eq("user_id",user.id).limit(100);
      for(const row of (cp||[])){
        if(!row.photo||!row.photo.startsWith("data:")) continue;
        const url=await uploadPhotoToStorage(row.photo,"catches");
        if(url){
          await sb.from("catches").update({photo:url}).eq("id",row.id);
          migrated++;
          setMigrationStatus(`Migrating... ${migrated} done`);
        }
      }
      setMigrationStatus(migrated>0?`✅ Migrated ${migrated} photos - reload to see them`:"✅ Already migrated");
      setTimeout(()=>setMigrationStatus(null),5000);
    }catch(e){
      setMigrationStatus("❌ "+e.message);
    }
  }
  // Clear any stale cache from previous sessions to force fresh Supabase load
  useEffect(()=>{
    if(user?.id){
      // Show cache while loading
      try{
        const cached=localStorage.getItem("tl_guests_"+user.id);
        if(cached){ setGuests(JSON.parse(cached)); }
      }catch{}
    }
  },[user?.id]);
  const [view, setView] = useState("list"); // list | guest | addGuest | editGuest | addTrip | editTrip | tripDetail
  const [guideSection, setGuideSection] = useState("clients");
  const [selectedGuest, setSelectedGuest] = useState(null);
  const [selectedTrip, setSelectedTrip] = useState(null);

  const guestForm0 = {name:"",birthday:"",address:"",address2:"",city:"",state:"",zip:"",email:"",phone:"",notes:"",dietary:"",skillLevel:""};

  // Load guests + trips from Supabase
  useEffect(()=>{
    if(!user) return;
    async function load(){
      const isLocalUser = !sb || String(user?.id).startsWith("local");

      if(isLocalUser){
        // No Supabase - use localStorage only
        const localGuests = JSON.parse(localStorage.getItem("tl_guests")||"[]");
        const localTrips = JSON.parse(localStorage.getItem("tl_trips")||"[]");
        const withTrips = localGuests.map(g=>({...g, trips:localTrips.filter(t=>t.guest_id===g.id)}));
        setGuests(withTrips);
        setGuestsLoading(false);
        return;
      }

      // Logged in via Supabase - load from cloud (works on any device)
      const {data:gData, error:gErr}=await sb.from("guests").select("*").eq("user_id",user.id).order("name",{ascending:true});
      if(gErr){
        console.error("Failed to load guests:", gErr.message);
        // Fall back to localStorage if Supabase fails
        const localGuests = JSON.parse(localStorage.getItem("tl_guests")||"[]");
        const localTrips = JSON.parse(localStorage.getItem("tl_trips")||"[]");
        setGuests(localGuests.map(g=>({...g,trips:localTrips.filter(t=>t.guest_id===g.id)})));
        setGuestsLoading(false);
        return;
      }
      if(!gData){ setGuestsLoading(false); return; }
      const {data:tData, error:tErr}=await sb.from("trips").select("id,guest_id,date,location,type,styles,catches,flies,gear,guide_notes,trip_cost,tip_amount,report_text,air_temp,water_temp,weather_conditions,wind_speed,wind_dir,pressure,pressure_trend,stream_cfs,stream_condition,stream_gauge_name,catch_details").eq("user_id",user.id).order("date",{ascending:false});
      if(tErr) console.error("Trip load error:",tErr.message);
      const trips=tData||[];
      const guestsWithTrips=gData.map(g=>({
        ...g,
        skillLevel:g.skill_level,
        trips:trips.filter(t=>t.guest_id===g.id).map(t=>({
          id:t.id,date:t.date,location:t.location,type:t.type,
          styles:t.styles||[],catches:t.catches||0,flies:t.flies||[],
          gear:t.gear,guideNotes:t.guide_notes,photos:[],
          tripCost:t.trip_cost,tipAmount:t.tip_amount,reportText:t.report_text,
          airTemp:t.air_temp,waterTemp:t.water_temp,weatherConditions:t.weather_conditions,
          windSpeed:t.wind_speed,windDir:t.wind_dir,pressure:t.pressure,pressureTrend:t.pressure_trend,
          streamCFS:t.stream_cfs,streamCondition:t.stream_condition,streamGaugeName:t.stream_gauge_name,
          catchDetails:t.catch_details||[]
        }))
      }));
      setGuests(guestsWithTrips);
      setGuestsLoading(false);
      // Update cache with fresh Supabase data (strip photos to save space)
      try{
        const cacheKey="tl_guests_"+user.id;
        const safe=guestsWithTrips.map(g=>({...g,trips:(g.trips||[]).map(t=>({...t,photos:[]}))}));
        localStorage.setItem(cacheKey, JSON.stringify(safe));
      }catch{}
    }
    load();
  },[user]);

  // Upload a base64 photo to Supabase Storage, return public URL
  async function uploadPhotoToStorage(base64DataUrl, folder){
    if(!sb) return null;
    try{
      // Convert base64 to blob
      const res=await fetch(base64DataUrl);
      const blob=await res.blob();
      const ext=blob.type.split("/")[1]||"jpg";
      const fileName=`${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      const {data,error}=await sb.storage.from("trip-photos").upload(fileName, blob, {contentType:blob.type,upsert:false});
      if(error){ void 0; return null; }
      const {data:{publicUrl}}=sb.storage.from("trip-photos").getPublicUrl(fileName);
      return publicUrl;
    }catch(e){ void 0; return null; }
  }

  // Upload all photos in array, return URLs (falls back to base64 if storage fails)
  async function uploadPhotosToStorage(photos, folder){
    const results=[];
    for(const photo of photos){
      if(photo.startsWith("http")){ results.push(photo); continue; } // already a URL
      const url=await uploadPhotoToStorage(photo, folder);
      results.push(url||photo); // fallback to base64 if upload fails
    }
    return results;
  }

  async function loadTripPhotos(tripId, tripObj){
    if(!sb) return;
    // Set trip immediately with loading state — synchronous, no race condition
    setSelectedTrip({...tripObj,photosLoading:true,photos:[]});
    try{
      // Fetch from trip_photos table AND trips.photos column as fallback
      const [{data:cdData,error:cdErr},{data:photoRows,error:photoErr},{data:tripData}]=await Promise.all([
        sb.from("trips").select("catch_details").eq("id",tripId).single(),
        sb.from("trip_photos").select("photo,sort_order").eq("trip_id",tripId).order("sort_order"),
        sb.from("trips").select("photos").eq("id",tripId).single()
      ]);
      if(photoErr) void 0;
      if(cdErr) void 0;
      const catchDetails=((cdData?.catch_details)||[]).map(d=>({...d,analyzing:false}));
      // Use trip_photos table first; fall back to trips.photos JSON column
      let photos=(photoRows||[]).map(r=>r.photo).filter(Boolean);
      if(photos.length===0 && tripData?.photos?.length>0){
        void 0;
        photos=tripData.photos.filter(Boolean);
      }
      // Fall back to photos embedded in catchDetails
      if(photos.length===0 && catchDetails.length>0){
        const cdPhotos=catchDetails.map(d=>d.photo).filter(Boolean);
        if(cdPhotos.length>0){
          void 0;
          photos=cdPhotos;
        }
      }
      void 0;
      setSelectedTrip(st=>({...st,photos,catchDetails,photosLoading:false}));
      setGuests(gs=>gs.map(g=>({...g,trips:(g.trips||[]).map(t=>t.id===tripId?{...t,photos,catchDetails}:t)})));
    }catch(e){
      void 0;
      setSelectedTrip(st=>({...st,photosLoading:false}));
    }
  }

  async function saveTripPhotos(tripId, photos){
    if(!sb) return;
    try{
      // Upload any base64 photos to Storage first, keep existing URLs as-is
      const urls=await uploadPhotosToStorage(photos||[], `trips/${tripId}`);
      void 0;
      // Always delete + reinsert so removals are persisted too
      await sb.from("trip_photos").delete().eq("trip_id",tripId);
      if(urls.length>0){
        const {error}=await sb.from("trip_photos").insert(
          urls.map((photo,sort_order)=>({trip_id:tripId,photo,sort_order}))
        );
        if(error) void 0;
        else void 0;
      }
    }catch(e){ void 0; }
  }

  async function saveGuestToDb(guestData){
    // Always try localStorage as immediate save
    const localId = "local-"+Date.now();
    const existing = JSON.parse(localStorage.getItem("tl_guests")||"[]");
    const localGuest = {id:localId,...guestData};
    localStorage.setItem("tl_guests", JSON.stringify([...existing, localGuest]));

    // Then try Supabase if logged in
    if(sb && user?.id && !String(user.id).startsWith("local")){
      try{
        const {data,error}=await sb.from("guests").insert({user_id:user.id,...guestData}).select().single();
        if(error){
          alert("Supabase error: "+error.message+"\nCode: "+error.code+"\nGuest saved locally only.");
          return localGuest;
        }
        if(data){
          // Update localStorage with real Supabase ID
          const updated = JSON.parse(localStorage.getItem("tl_guests")||"[]").map(g=>g.id===localId?{...g,id:data.id}:g);
          localStorage.setItem("tl_guests", JSON.stringify(updated));
          return data;
        }
      }catch(e){
        alert("Connection error: "+e.message);
        return localGuest;
      }
    }
    return localGuest;
  }

  async function updateGuestInDb(id, updates){
    if(sb && user?.id && !String(user.id).startsWith("local")){
      await sb.from("guests").update(updates).eq("id",id);
      return;
    }
    // localStorage fallback
    const guests = JSON.parse(localStorage.getItem("tl_guests")||"[]");
    const updated = guests.map(g => g.id===id ? {...g,...updates} : g);
    localStorage.setItem("tl_guests", JSON.stringify(updated));
  }

  async function deletGuestFromDb(id){
    if(sb && !String(id).startsWith("local")) await sb.from("guests").delete().eq("id",id);
  }

  async function saveTripToDb(guestId, tripData){
    if(sb && user?.id && !String(user.id).startsWith("local")){
      const {data,error}=await sb.from("trips").insert({
      user_id:user.id, guest_id:guestId,
      date:tripData.date, location:tripData.location, type:tripData.type,
      styles:tripData.styles, catches:tripData.catches, flies:tripData.flies,
      gear:tripData.gear, guide_notes:tripData.guideNotes,
      trip_cost:tripData.tripCost, tip_amount:tripData.tipAmount, report_text:tripData.reportText,
      air_temp:tripData.airTemp, water_temp:tripData.waterTemp,
      weather_conditions:tripData.weatherConditions, wind_speed:tripData.windSpeed,
      wind_dir:tripData.windDir, pressure:tripData.pressure, pressure_trend:tripData.pressureTrend,
      stream_cfs:tripData.streamCFS, stream_condition:tripData.streamCondition, stream_gauge_name:tripData.streamGaugeName,
      catch_details:(tripData.catchDetails||[]).map(d=>({...d,analyzing:false}))
    }).select().single();
      if(!error && data){
        if(tripData.photos?.length>0) saveTripPhotos(data.id, tripData.photos).catch(()=>{});
        return data;
      }
      // Show error to user so they know it didn't save to cloud
      alert("Trip save failed: "+(error?.message||"Unknown error")+". The trip was saved locally on this device only.");
      console.error("Supabase trip save failed:", error?.message, error?.code);
    }
    // Fallback: localStorage only
    const localId = "local-"+Date.now();
    const existing = JSON.parse(localStorage.getItem("tl_trips")||"[]");
    const trip = {id:localId, guest_id:guestId, ...tripData};
    localStorage.setItem("tl_trips", JSON.stringify([...existing, trip]));
    return {id:localId};
  }

  async function updateTripInDb(id, tripData){
    if(sb && user?.id && !String(user.id).startsWith("local")){
      // Save photos first (await so UI state reflects actual saved URLs)
      await saveTripPhotos(id, tripData.photos||[]);
      await sb.from("trips").update({
        date:tripData.date, location:tripData.location, type:tripData.type,
        styles:tripData.styles, catches:tripData.catches, flies:tripData.flies,
        gear:tripData.gear, guide_notes:tripData.guideNotes,
        trip_cost:tripData.tripCost, tip_amount:tripData.tipAmount, report_text:tripData.reportText,
        air_temp:tripData.airTemp, water_temp:tripData.waterTemp,
        weather_conditions:tripData.weatherConditions, wind_speed:tripData.windSpeed,
        wind_dir:tripData.windDir, pressure:tripData.pressure, pressure_trend:tripData.pressureTrend,
        stream_cfs:tripData.streamCFS, stream_condition:tripData.streamCondition, stream_gauge_name:tripData.streamGaugeName,
        catch_details:(tripData.catchDetails||[]).map(d=>({...d,analyzing:false}))
      }).eq("id",id);
      return;
    }
    // localStorage fallback
    const trips = JSON.parse(localStorage.getItem("tl_trips")||"[]");
    const updated = trips.map(t => t.id===id ? {...t,...tripData} : t);
    localStorage.setItem("tl_trips", JSON.stringify(updated));
  }

  async function deleteTripFromDb(id){
    if(sb && !String(id).startsWith("local")) await sb.from("trips").delete().eq("id",id);
  }
  const tripForm0 = {date:new Date().toISOString().split("T")[0],location:"",type:"Wade",styles:[],catches:0,flies:[],flyInput:"",gear:"",guideNotes:"",photos:[],catchDetails:[],tripCost:"",tipAmount:"",reportText:"",airTemp:"",waterTemp:"",weatherConditions:"",windSpeed:"",windDir:"",pressure:"",pressureTrend:"",streamCFS:"",streamCondition:"",streamGaugeName:""};
  const [guestForm, setGuestForm] = useState(guestForm0);
  const [tripForm, setTripForm] = useState(tripForm0);
  const [generating, setGenerating] = useState(false);
  const [report, setReport] = useState(null);
  const photoRef = useRef();

  async function saveGuest(){
    if(!guestForm.name.trim()) return;
    const {name,birthday,address,address2,city,state,zip,email,phone,notes,dietary,skillLevel}=guestForm;
    const data=await saveGuestToDb({name,birthday,address,address2,city,state,zip,email,phone,notes,dietary,skill_level:skillLevel});
    // Use returned DB data or create local record as fallback
    const guest = data || {id:"local-"+Date.now(),name,birthday,address,email,phone,notes,dietary};
    setGuests(gs=>[...gs,{...guest,trips:[]}]);
    setGuestForm(guestForm0);
    setView("list");
  }

  async function saveTrip(){
    const data=await saveTripToDb(selectedGuest.id, tripForm);
    if(data){
      const trip={id:data.id,...tripForm};
      setGuests(gs=>gs.map(g=>g.id===selectedGuest.id?{...g,trips:[...(g.trips||[]),trip]}:g));
      setSelectedGuest(g=>({...g,trips:[...(g.trips||[]),trip]}));
    }
    setTripForm(tripForm0);
    setView("guest");
  }

  async function handleTripPhoto(e){
    const files=Array.from(e.target.files);
    e.target.value="";
    const SPECIES_LIST=["Brown Trout","Rainbow Trout","Brook Trout","Cutthroat Trout","Lake Trout","Bull Trout","Steelhead","Largemouth Bass","Smallmouth Bass","Other"];
    for(const file of files){
      const rawUrl=await new Promise(res=>{const r=new FileReader();r.onload=ev=>res(ev.target.result);r.readAsDataURL(file);});
      const dataUrl=await new Promise(res=>{const img=new Image();img.onload=()=>{const MAX=1200;let w=img.naturalWidth,h=img.naturalHeight;if(w>MAX||h>MAX){const s=MAX/Math.max(w,h);w=Math.round(w*s);h=Math.round(h*s);}const cv=document.createElement("canvas");cv.width=w;cv.height=h;cv.getContext("2d").drawImage(img,0,0,w,h);res(cv.toDataURL("image/jpeg",0.82));};img.onerror=()=>res(rawUrl);img.src=rawUrl;});
      // Add photo immediately
      setTripForm(f=>({...f,photos:[...f.photos,dataUrl]}));
      // Parse EXIF
      let photoTime=null,photoGps="",photoLat=null,photoLng=null;
      try{
        const abuf=await file.arrayBuffer();
        const exif=parseExif(abuf);
        photoTime=exif.time;photoGps=exif.gps||"";photoLat=exif.lat??null;photoLng=exif.lng??null;
      }catch{}
      // Use EXIF time, fall back to trip date (not today's date)
      const tripDateFallback=tripForm.date?new Date(tripForm.date+"T12:00:00").toLocaleString("en-US",{month:"long",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit",hour12:true}):new Date().toLocaleString("en-US",{month:"long",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit",hour12:true});
      const t=photoTime||tripDateFallback;
      const detail={photo:dataUrl,time:t,gps:photoGps,species:"Unidentified",length:"",airTemp:"",weatherDesc:"",windSpeed:"",windDir:"",pressure:"",streamCFS:"",streamCondition:"",streamGaugeName:"",analyzing:true};
      setTripForm(f=>({...f,catchDetails:[...(f.catchDetails||[]),detail]}));
      // Get location: EXIF GPS → locRef (always current, no stale closure) → geolocation
      let fetchLat=photoLat,fetchLng=photoLng,fetchGps=photoGps;
      if(!fetchLat||!fetchLng){
        const currentLoc=locRef.current;
        if(currentLoc?.lat&&currentLoc?.lng){
          fetchLat=currentLoc.lat;fetchLng=currentLoc.lng;
          fetchGps=fetchLat.toFixed(4)+"°N, "+Math.abs(fetchLng).toFixed(4)+"°W";
        } else {
          try{
            const pos=await new Promise((res,rej)=>navigator.geolocation.getCurrentPosition(res,rej,{timeout:10000,maximumAge:60000,enableHighAccuracy:false}));
            fetchLat=pos.coords.latitude;fetchLng=pos.coords.longitude;
            fetchGps=fetchLat.toFixed(4)+"°N, "+Math.abs(fetchLng).toFixed(4)+"°W";
          }catch{}
        }
      }
      // Fetch conditions using EXIF or device location
      if(fetchLat&&fetchLng){
        // Update GPS on the detail we just added
        setTripForm(f=>({...f,catchDetails:(f.catchDetails||[]).map((d,idx)=>idx===(f.catchDetails.length-1)?{...d,gps:fetchGps||d.gps}:d)}));
        try{
          let dateStr=null,hourStr="12";
          const d2=new Date(t.replace(" at "," "));
          if(!isNaN(d2)){dateStr=d2.toISOString().split("T")[0];hourStr=String(d2.getHours()).padStart(2,"0");}
          const today=new Date().toISOString().split("T")[0];
          let conds=null;
          if(dateStr&&dateStr<today){
            conds=await fetchHistoricalConditions(fetchLat,fetchLng,dateStr,hourStr);
          } else {
            // Live conditions for today
            try{
              const[wx,usgs]=await Promise.all([fetchWeather(fetchLat,fetchLng),fetchUSGSLive(fetchLat,fetchLng)]);
              const wc=wx.current;
              const pressureInHg=(wc.surface_pressure*0.02953).toFixed(2);
              conds={airTemp:String(Math.round(wc.temperature_2m)),weatherDesc:WX_DESC[wc.weather_code]||"",windSpeed:String(Math.round(wc.wind_speed_10m)),windDir:windDir(wc.wind_direction_10m),pressure:pressureInHg,streamCFS:"",streamCondition:"",streamGaugeName:""};
              const ts2=(usgs.value?.timeSeries)??[];
              if(ts2.length){
                const parsed2=ts2.map(t2=>{const raw=t2.values?.[0]?.value?.[0]?.value;const cfs=raw!=null?parseFloat(raw):null;const sLat=parseFloat(t2.sourceInfo?.geoLocation?.geogLocation?.latitude||0);const sLng=parseFloat(t2.sourceInfo?.geoLocation?.geogLocation?.longitude||0);const dist=Math.sqrt(Math.pow(sLat-fetchLat,2)+Math.pow(sLng-fetchLng,2));return{name:t2.sourceInfo?.siteName??"",cfs,dist,label:cfsLabel(cfs,null).label};}).filter(x=>x.cfs!=null&&x.cfs>=0&&x.cfs<500000).sort((a,b)=>a.dist-b.dist);
                if(parsed2.length){conds.streamCFS=String(Math.round(parsed2[0].cfs));conds.streamCondition=parsed2[0].label;conds.streamGaugeName=parsed2[0].name;}
              }
            }catch{}
          }
          if(conds) setTripForm(f=>({...f,catchDetails:(f.catchDetails||[]).map((d,idx)=>idx===(f.catchDetails.length-1)?{...d,...conds}:d)}));
        }catch{}
      }
      // Claude vision — resize to 1024px max, 20s timeout
      try{
        const b64=await new Promise((res,rej)=>{
          const img=new Image();img.onload=()=>{
            const MAX=1024;let w=img.naturalWidth,h=img.naturalHeight;
            if(w>MAX||h>MAX){const s=MAX/Math.max(w,h);w=Math.round(w*s);h=Math.round(h*s);}
            const cv=document.createElement("canvas");cv.width=w;cv.height=h;
            cv.getContext("2d").drawImage(img,0,0,w,h);
            res(cv.toDataURL("image/jpeg",0.82).split(",")[1]);
          };img.onerror=rej;img.src=dataUrl;
        });
        const ctrl=new AbortController();
        const tid=setTimeout(()=>ctrl.abort(),20000);
        let res;
        try{res=await fetch("/api/claude",{method:"POST",signal:ctrl.signal,headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:150,messages:[{role:"user",content:[{type:"image",source:{type:"base64",media_type:"image/jpeg",data:b64}},{type:"text",text:`Identify this fish and estimate length. Species from: ${SPECIES_LIST.join(", ")}. Reply ONLY with JSON: {"species":"Rainbow Trout","length":14}. Use null if unknown.`}]}]})});}
        finally{clearTimeout(tid);}
        const rd=await res.json();
        const parsed=JSON.parse(((rd.content||[])[0]?.text||"{}").replace(/```json|```/g,"").trim());
        setTripForm(f=>({...f,catchDetails:(f.catchDetails||[]).map((d,i)=>i===(f.catchDetails.length-1)?{...d,species:parsed.species||"",length:parsed.length!=null?String(Math.round(parsed.length)):"",analyzing:false}:d)}));
      }catch{
        setTripForm(f=>({...f,catchDetails:(f.catchDetails||[]).map((d,i)=>i===(f.catchDetails.length-1)?{...d,analyzing:false}:d)}));
      }
    }
  }

  function toggleStyle(s){
    setTripForm(f => ({...f, styles: f.styles.includes(s) ? f.styles.filter(x=>x!==s) : [...f.styles, s]}));
  }

  function addFly(){ if(!tripForm.flyInput.trim()) return; setTripForm(f=>({...f, flies:[...f.flies, f.flyInput.trim()], flyInput:""})); }

  async function generateReport(guest, trip){
    setGenerating(true); setReport(null);
    // Save report to DB when generated
    async function saveReport(txt){
      if(sb && !String(trip.id).startsWith("local")) await sb.from("trips").update({report_text:txt}).eq("id",trip.id);
      setGuests(gs=>gs.map(g=>g.id===guest.id?{...g,trips:(g.trips||[]).map(t=>t.id===trip.id?{...t,reportText:txt}:t)}:g));
    }
    try{
      // Build catch details summary if available
      const catchSummary=(trip.catchDetails||[]).filter(c=>c.species).map(c=>{
        let s=c.species+(c.length?" ("+c.length+'"'+")":'');
        if(c.airTemp) s+=" | "+c.airTemp+"°F";
        if(c.streamCFS) s+=" | "+c.streamCFS+" CFS";
        if(c.time) s+=" | "+c.time;
        return s;
      }).join("; ");
      const conditionsSummary=[
        trip.weatherConditions&&("Weather: "+trip.weatherConditions),
        trip.airTemp&&("Air: "+trip.airTemp+"°F"),
        trip.waterTemp&&("Water: "+trip.waterTemp+"°F"),
        trip.streamCFS&&("Flow: "+trip.streamCFS+" CFS "+( trip.streamCondition||"")),
        trip.windSpeed&&("Wind: "+trip.windSpeed+"mph "+( trip.windDir||"")),
        trip.pressure&&("Pressure: "+trip.pressure+'"'),
      ].filter(Boolean).join(", ");

      const promptParts=[
        "You are a fly fishing guide writing a trip summary for a client.",
        "Only use the specific facts provided below.",
        "Do not invent, assume, or embellish any details not explicitly given.",
        "If information is not provided, do not mention it.",
        "FACTS:",
        "Client: "+guest.name,
        "Date: "+trip.date,
        "Location: "+(trip.location||"not specified"),
        "Trip type: "+trip.type,
        "Fishing styles: "+(trip.styles.join(", ")||"not specified"),
        "Estimated catches: "+trip.catches,
        "Flies that worked: "+(trip.flies.join(", ")||"not specified"),
        "Gear: "+(trip.gear||"not specified"),
        "Conditions: "+(conditionsSummary||"not recorded"),
        "Catch details: "+(catchSummary||"not recorded"),
        "Guide notes: "+(trip.guideNotes||"none"),
        "Write a warm 2-3 paragraph trip summary using ONLY the facts above.",
        "Paragraph 1: the day overall — mention the weather, stream conditions, and CFS if recorded, and explain how they impacted the fishing. Be specific: dropping pressure means aggressive feeders, high CFS pushes fish to edges, clear low water means technical fishing, warm afternoon means midday slowdown, etc. Only interpret conditions that were explicitly recorded.",
        "Paragraph 2: the fishing itself — catches, which flies worked and why, techniques used.",
        "Paragraph 3: a forward-looking note — one specific thing to work on or focus on next time based on what happened.",
        "Do not invent any conditions, flies, or details not listed in the facts above.",
        "Write in second person. Plain text only — no markdown, no headers, no # symbols."
      ];
      const rawTxt = await askClaude(promptParts.join(" "), false, 800);
      const txt = rawTxt.replace(/^#+\s*/gm,"").replace(/\*\*/g,"").replace(/\*/g,"").trim();
      setReport(txt);
      saveReport(txt);
    }catch(e){ setReport("Could not generate report. " + e.message); }
    finally{ setGenerating(false); }
  }

  async function deleteGuest(id){ await deletGuestFromDb(id); setGuests(gs=>gs.filter(g=>g.id!==id)); const stored=JSON.parse(localStorage.getItem("tl_guests")||"[]"); localStorage.setItem("tl_guests",JSON.stringify(stored.filter(g=>g.id!==id))); setView("list"); }
  async function deleteTrip(guestId, tripId){
    if(!window.confirm("Delete this trip and all its photos? This cannot be undone.")) return;
    try{
      // Delete photos from trip_photos table first
      if(sb && !String(tripId).startsWith("local")){
        await sb.from("trip_photos").delete().eq("trip_id",tripId);
      }
      await deleteTripFromDb(tripId);
    }catch(e){ void 0; }
    const stored=JSON.parse(localStorage.getItem("tl_trips")||"[]");
    localStorage.setItem("tl_trips",JSON.stringify(stored.filter(t=>t.id!==tripId)));
    setGuests(gs=>gs.map(g=>g.id===guestId?{...g,trips:(g.trips||[]).filter(t=>t.id!==tripId)}:g));
    setSelectedGuest(g=>({...g,trips:(g.trips||[]).filter(t=>t.id!==tripId)}));
    setView("guest");
  }

  // Guest list
  if(view==="list") return(
    <div>
      <div style={{display:"flex",background:"rgba(0,0,0,0.25)",borderRadius:12,padding:3,gap:2,marginBottom:14}}>
        {[{id:"clients",icon:"👥",label:"Clients"},{id:"gauges",icon:"⭐",label:"My Gauges"}].map(s=>(
          <button key={s.id} onClick={()=>setGuideSection(s.id)}
            style={{flex:1,padding:"7px 4px",border:"none",borderRadius:9,cursor:"pointer",
              background:guideSection===s.id?"var(--water)":"transparent",
              color:guideSection===s.id?"var(--foam)":"var(--sky)",
              fontFamily:"'Crimson Pro',serif",fontSize:14,
              display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
            <span style={{fontSize:15}}>{s.icon}</span>{s.label}
          </button>
        ))}
      </div>
      {guideSection==="stats"?<GuideStats guests={guests}/>:guideSection==="seasonlog"?<GuideSeasonLog guests={guests}/>:guideSection==="gauges"?<GuideSavedGauges user={user}/>:null}
      <div style={{display:guideSection==="clients"?"block":"none"}}>
      {String(user?.id).startsWith("local")&&(
        <div style={{background:"rgba(200,168,75,0.15)",border:"1px solid rgba(200,168,75,0.3)",borderRadius:14,padding:"14px 16px",marginBottom:14,fontSize:15,color:"var(--gold)",lineHeight:1.6}}>
          ⚠️ <strong>Not logged in</strong> — guest data is saved to this device only.
        </div>
      )}
      {!String(user?.id).startsWith("local")&&(()=>{
        const localGuests=JSON.parse(localStorage.getItem("tl_guests")||"[]");
        const localTrips=JSON.parse(localStorage.getItem("tl_trips")||"[]");
        if(!localGuests.length) return null;
        return(
          <div style={{background:"rgba(200,168,75,0.15)",border:"1px solid rgba(200,168,75,0.3)",borderRadius:14,padding:"14px 16px",marginBottom:14,fontSize:15,color:"var(--gold)",lineHeight:1.6}}>
            📦 You have <strong>{localGuests.length} guest{localGuests.length!==1?"s":""}</strong> saved locally from before you logged in.
            <button className="btn" style={{width:"100%",marginTop:10,background:"rgba(200,168,75,0.3)",color:"var(--gold)",border:"1px solid rgba(200,168,75,0.5)"}}
              onClick={async()=>{
                let migrated=0;
                for(const g of localGuests){
                  const {id:oldId,...gData}=g;
                  const {data:newG,error}=await sb.from("guests").insert({user_id:user.id,name:gData.name,birthday:gData.birthday,address:gData.address,email:gData.email,phone:gData.phone,notes:gData.notes,dietary:gData.dietary,skill_level:gData.skillLevel||gData.skill_level}).select().single();
                  if(!error&&newG){
                    migrated++;
                    const gTrips=localTrips.filter(t=>t.guest_id===oldId);
                    for(const t of gTrips){
                      await sb.from("trips").insert({user_id:user.id,guest_id:newG.id,date:t.date,location:t.location,type:t.type,styles:t.styles||[],catches:t.catches||0,flies:t.flies||[],gear:t.gear,guide_notes:t.guideNotes||t.guide_notes,photos:t.photos||[],trip_cost:t.tripCost||t.trip_cost,tip_amount:t.tipAmount||t.tip_amount,report_text:t.reportText||t.report_text,air_temp:t.airTemp||t.air_temp,water_temp:t.waterTemp||t.water_temp,weather_conditions:t.weatherConditions||t.weather_conditions,wind_speed:t.windSpeed||t.wind_speed,wind_dir:t.windDir||t.wind_dir,pressure:t.pressure,pressure_trend:t.pressureTrend||t.pressure_trend,stream_cfs:t.streamCFS||t.stream_cfs,stream_condition:t.streamCondition||t.stream_condition,stream_gauge_name:t.streamGaugeName||t.stream_gauge_name});
                    }
                  }
                }
                localStorage.removeItem("tl_guests");
                localStorage.removeItem("tl_trips");
                alert(`Migrated ${migrated} guest${migrated!==1?"s":""} to your account! Refreshing…`);
                window.location.reload();
              }}>
              ☁️ Migrate to My Account
            </button>
          </div>
        );
      })()}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <span style={{fontFamily:"'Playfair Display',serif",fontSize:15,letterSpacing:1.5,textTransform:"uppercase",color:"var(--stone)"}}>My Guests · {guests.length}</span>
        <button className="btn" onClick={()=>{setGuestForm(guestForm0);setView("addGuest");}}>+ Add Guest</button>
      </div>
      <div style={{display:"flex",justifyContent:"flex-end",marginBottom:8}}>
        <button onClick={runPhotoMigration} disabled={!!migrationStatus}
          style={{fontSize:14,padding:"4px 10px",background:"rgba(200,168,75,0.15)",border:"1px solid rgba(200,168,75,0.3)",borderRadius:8,color:"var(--gold)",cursor:"pointer",fontFamily:"'Crimson Pro',serif"}}>
          {migrationStatus||"🔄 Migrate Photos to Storage"}
        </button>
      </div>
      {guestsLoading&&<div className="loading">Loading guests…</div>}
      {!guestsLoading&&guests.length===0&&<div className="empty"><div className="ei">🎣</div><p>No guests yet.<br/>Add your first client to get started.</p></div>}
      {guests.map(g=>(
        <div className="cc" key={g.id} style={{cursor:"pointer"}} onClick={()=>{setSelectedGuest(g);setView("guest");}}>
          <div className="cb">
            <div className="csp">{g.name}</div>
            <div className="cm">
              {g.email&&<span className="cmi">✉️ {g.email}</span>}
              {g.phone&&<span className="cmi">📱 {g.phone}</span>}
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8,marginTop:4}}>
              <span style={{fontSize:15,color:"var(--stone)"}}>{(g.trips||[]).length} trip{(g.trips||[]).length!==1?"s":""} on record</span>
              {(g.skillLevel||g.skill_level)&&<span style={{fontSize:14,background:"rgba(44,95,110,0.3)",border:"1px solid rgba(44,95,110,0.5)",borderRadius:20,padding:"1px 8px",color:"var(--sky)"}}>
                {(g.skillLevel||g.skill_level)==="Beginner"?"🌱":( g.skillLevel||g.skill_level)==="Intermediate"?"🎣":"🏆"} {g.skillLevel||g.skill_level}
              </span>}
            </div>
          </div>
        </div>
      ))}
      </div>
    </div>
  );

  // Add guest form
  if(view==="addGuest") return(
    <div>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
        <button className="back" onClick={()=>setView("list")}>← Back</button>
        <span style={{fontFamily:"'Playfair Display',serif",fontSize:18,color:"var(--foam)",fontStyle:"italic"}}>New Guest</span>
      </div>
      <div className="card">
        <label className="lbl">Full Name *</label>
        <input className="inp" placeholder="John Smith" value={guestForm.name} onChange={e=>setGuestForm(f=>({...f,name:e.target.value}))}/>
        <label className="lbl">Birthday</label>
        <input className="inp" type="date" value={guestForm.birthday} onChange={e=>setGuestForm(f=>({...f,birthday:e.target.value}))}/>
        <label className="lbl">Address</label>
        <input className="inp" placeholder="Street Address" value={guestForm.address||""} onChange={e=>setGuestForm(f=>({...f,address:e.target.value}))}/>
        <input className="inp" placeholder="Apt, Suite, Unit (optional)" value={guestForm.address2||""} onChange={e=>setGuestForm(f=>({...f,address2:e.target.value}))}/>
        <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr",gap:8,marginBottom:12}}>
          <input className="inp" style={{marginBottom:0}} placeholder="City" value={guestForm.city||""} onChange={e=>setGuestForm(f=>({...f,city:e.target.value}))}/>
          <input className="inp" style={{marginBottom:0}} placeholder="State" maxLength={2} value={guestForm.state||""} onChange={e=>setGuestForm(f=>({...f,state:e.target.value.toUpperCase()}))}/>
          <input className="inp" style={{marginBottom:0}} placeholder="ZIP" maxLength={5} value={guestForm.zip||""} onChange={e=>setGuestForm(f=>({...f,zip:e.target.value.replace(/[^0-9]/g,"")}))}/>
        </div>
        <label className="lbl">Email</label>
        <input className="inp" type="email" placeholder="john@email.com" value={guestForm.email} onChange={e=>setGuestForm(f=>({...f,email:e.target.value}))}/>
        <label className="lbl">Phone</label>
        <input className="inp" type="tel" placeholder="(555) 555-5555" value={guestForm.phone} onChange={e=>{
          const digits=e.target.value.replace(/[^0-9]/g,"").slice(0,25);
          let fmt=digits;
          if(digits.length>=7) fmt="("+digits.slice(0,3)+") "+digits.slice(3,6)+"-"+digits.slice(6);
          else if(digits.length>=4) fmt="("+digits.slice(0,3)+") "+digits.slice(3);
          else if(digits.length>=1) fmt="("+digits;
          setGuestForm(f=>({...f,phone:fmt}));
        }}/>
        <label className="lbl">Dietary Restrictions</label>
        <input className="inp" placeholder="e.g. Gluten free, vegetarian, nut allergy…" value={guestForm.dietary||""} onChange={e=>setGuestForm(f=>({...f,dietary:e.target.value}))}/>
        <label className="lbl">Fishing Skill Level</label>
        <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
          {["Beginner","Intermediate","Expert"].map(lvl=>(
            <button key={lvl} onClick={()=>setGuestForm(f=>({...f,skillLevel:lvl}))}
              style={{flex:1,padding:"10px 8px",borderRadius:10,border:"1px solid "+(guestForm.skillLevel===lvl?"var(--water)":"rgba(255,255,255,0.12)"),background:guestForm.skillLevel===lvl?"var(--water)":"rgba(0,0,0,0.3)",color:guestForm.skillLevel===lvl?"var(--foam)":"var(--stone)",fontFamily:"'Crimson Pro',serif",fontSize:14,cursor:"pointer",textAlign:"center"}}>
              {lvl==="Beginner"?"🌱":lvl==="Intermediate"?"🎣":"🏆"} {lvl}
            </button>
          ))}
        </div>
        <label className="lbl">Notes</label>
        <textarea className="inp" rows={3} style={{resize:"none"}} placeholder="Fishing experience, preferences, anything to remember…" value={guestForm.notes} onChange={e=>setGuestForm(f=>({...f,notes:e.target.value}))}/>
        <button className="btn btnp" onClick={saveGuest}>Save Guest</button>
      </div>
    </div>
  );

  // Edit guest
  if(view==="editGuest"&&selectedGuest) return(
    <div>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
        <button className="back" onClick={()=>setView("guest")}>← Back</button>
        <span style={{fontFamily:"'Playfair Display',serif",fontSize:18,color:"var(--foam)",fontStyle:"italic"}}>Edit Guest</span>
      </div>
      <div className="card">
        <label className="lbl">Full Name *</label>
        <input className="inp" value={guestForm.name||""} onChange={e=>setGuestForm(f=>({...f,name:e.target.value}))}/>
        <label className="lbl">Birthday</label>
        <input className="inp" type="date" value={guestForm.birthday||""} onChange={e=>setGuestForm(f=>({...f,birthday:e.target.value}))}/>
        <label className="lbl">Address</label>
        <input className="inp" placeholder="Street Address" value={guestForm.address||""} onChange={e=>setGuestForm(f=>({...f,address:e.target.value}))}/>
        <input className="inp" placeholder="Apt, Suite, Unit (optional)" value={guestForm.address2||""} onChange={e=>setGuestForm(f=>({...f,address2:e.target.value}))}/>
        <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr",gap:8,marginBottom:12}}>
          <input className="inp" style={{marginBottom:0}} placeholder="City" value={guestForm.city||""} onChange={e=>setGuestForm(f=>({...f,city:e.target.value}))}/>
          <input className="inp" style={{marginBottom:0}} placeholder="State" maxLength={2} value={guestForm.state||""} onChange={e=>setGuestForm(f=>({...f,state:e.target.value.toUpperCase()}))}/>
          <input className="inp" style={{marginBottom:0}} placeholder="ZIP" maxLength={5} value={guestForm.zip||""} onChange={e=>setGuestForm(f=>({...f,zip:e.target.value.replace(/[^0-9]/g,"")}))}/>
        </div>
        <label className="lbl">Email</label>
        <input className="inp" type="email" value={guestForm.email||""} onChange={e=>setGuestForm(f=>({...f,email:e.target.value}))}/>
        <label className="lbl">Phone</label>
        <input className="inp" type="tel" placeholder="(555) 555-5555" value={guestForm.phone||""} onChange={e=>{
          const digits=e.target.value.replace(/[^0-9]/g,"").slice(0,10);
          let fmt=digits;
          if(digits.length>=7) fmt="("+digits.slice(0,3)+") "+digits.slice(3,6)+"-"+digits.slice(6);
          else if(digits.length>=4) fmt="("+digits.slice(0,3)+") "+digits.slice(3);
          else if(digits.length>=1) fmt="("+digits;
          setGuestForm(f=>({...f,phone:fmt}));
        }}/>
        <label className="lbl">Dietary Restrictions</label>
        <input className="inp" value={guestForm.dietary||""} onChange={e=>setGuestForm(f=>({...f,dietary:e.target.value}))}/>
        <label className="lbl">Fishing Skill Level</label>
        <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
          {["Beginner","Intermediate","Expert"].map(lvl=>(
            <button key={lvl} onClick={()=>setGuestForm(f=>({...f,skillLevel:lvl}))}
              style={{flex:1,padding:"10px 8px",borderRadius:10,border:"1px solid "+(guestForm.skillLevel===lvl?"var(--water)":"rgba(255,255,255,0.12)"),background:guestForm.skillLevel===lvl?"var(--water)":"rgba(0,0,0,0.3)",color:guestForm.skillLevel===lvl?"var(--foam)":"var(--stone)",fontFamily:"'Crimson Pro',serif",fontSize:14,cursor:"pointer",textAlign:"center"}}>
              {lvl==="Beginner"?"🌱":lvl==="Intermediate"?"🎣":"🏆"} {lvl}
            </button>
          ))}
        </div>
        <label className="lbl">Notes</label>
        <textarea className="inp" rows={3} style={{resize:"none"}} value={guestForm.notes||""} onChange={e=>setGuestForm(f=>({...f,notes:e.target.value}))}/>
        <button className="btn btnp" onClick={async()=>{
          const{name,birthday,address,address2,city,state,zip,email,phone,notes,dietary,skillLevel}=guestForm;
          await updateGuestInDb(selectedGuest.id,{name,birthday,address,address2,city,state,zip,email,phone,notes,dietary,skill_level:skillLevel});
          const updated={...selectedGuest,name,birthday,address,address2,city,state,zip,email,phone,notes,dietary,skillLevel};
          setGuests(gs=>gs.map(g=>g.id===selectedGuest.id?updated:g));
          setSelectedGuest(updated);
          setView("guest");
        }}>Save Changes</button>
      </div>
    </div>
  );

  // Guest detail
  if(view==="guest"&&selectedGuest) return(
    <div>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
        <button className="back" onClick={()=>setView("list")}>← Back</button>
        <span style={{fontFamily:"'Playfair Display',serif",fontSize:18,color:"var(--foam)",fontStyle:"italic"}}>{selectedGuest.name}</span>
      </div>
      <div className="card">
        <div className="ctitle">👤 Guest Info</div>
        {selectedGuest.birthday&&<div className="hr"><span className="hn">Birthday</span><span className="ha">{new Date(selectedGuest.birthday+"T12:00:00").toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"})}</span></div>}
        {(selectedGuest.address||selectedGuest.city)&&(
  <div className="hr">
    <span className="hn">Address</span>
    <span className="ha" style={{textAlign:"right",maxWidth:"60%",lineHeight:1.5}}>
      {selectedGuest.address}{selectedGuest.address2?" "+selectedGuest.address2:""}
      {(selectedGuest.city||selectedGuest.state||selectedGuest.zip)&&(
        <><br/>{[selectedGuest.city,selectedGuest.state,selectedGuest.zip].filter(Boolean).join(" ")}</>
      )}
    </span>
  </div>
)}
        {selectedGuest.email&&<div className="hr"><span className="hn">Email</span><span className="ha">{selectedGuest.email}</span></div>}
        {selectedGuest.phone&&<div className="hr"><span className="hn">Phone</span><span className="ha">{selectedGuest.phone}</span></div>}
        {(selectedGuest.skillLevel||selectedGuest.skill_level)&&(()=>{const sl=selectedGuest.skillLevel||selectedGuest.skill_level;return(<div className="hr"><span className="hn">Skill Level</span><span className="ha">{sl==="Beginner"?"🌱 Beginner":sl==="Intermediate"?"🎣 Intermediate":"🏆 Expert"}</span></div>);})()}
        {selectedGuest.dietary&&<div className="hr"><span className="hn">🥗 Dietary</span><span className="ha">{selectedGuest.dietary}</span></div>}
        {selectedGuest.notes&&<div style={{marginTop:10,fontSize:15,color:"var(--sky)",fontStyle:"italic",lineHeight:1.6}}>{selectedGuest.notes}</div>}
        <div style={{display:"flex",gap:8,marginTop:14}}>
          <button className="btn" style={{flex:2}} onClick={()=>{setTripForm({...tripForm0,date:new Date().toISOString().split("T")[0]});setView("addTrip");}}>+ Add Trip</button>
          <button className="btn" style={{flex:1,background:"rgba(44,95,110,0.5)"}} onClick={()=>{setGuestForm({...selectedGuest, skillLevel:selectedGuest.skillLevel||selectedGuest.skill_level||""});setView("editGuest");}}>✏️ Edit</button>
          <button className="btn" style={{background:"rgba(150,80,80,0.4)",border:"1px solid rgba(150,80,80,0.5)"}} onClick={()=>deleteGuest(selectedGuest.id)}>🗑</button>
        </div>
      </div>
      <div style={{fontFamily:"'Playfair Display',serif",fontSize:14,letterSpacing:1.5,textTransform:"uppercase",color:"var(--stone)",marginBottom:10}}>Trip History · {(selectedGuest.trips||[]).length}</div>
      {(selectedGuest.trips||[]).length===0&&<div className="info-box">No trips recorded yet. Tap "+ Add Trip" to log your first outing.</div>}
      {(selectedGuest.trips||[]).sort((a,b)=>b.date.localeCompare(a.date)).map(trip=>(
        <div className="card" key={trip.id} style={{cursor:"pointer"}} onClick={()=>{setView("tripDetail");loadTripPhotos(trip.id,trip);}}>
          <div className="ctitle" style={{marginBottom:6}}>{new Date(trip.date+"T12:00:00").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric",year:"numeric"})} <span style={{fontSize:15,color:"var(--stone)",fontFamily:"'Crimson Pro',serif",fontStyle:"normal"}}>·</span> {trip.type}</div>
          {trip.location&&<div style={{fontSize:15,color:"var(--sky)",marginBottom:6}}>📍 {trip.location}</div>}
          <div style={{display:"flex",gap:10,flexWrap:"wrap",fontSize:15,color:"var(--stone)"}}>
            <span>🐟 ~{trip.catches} catches</span>
            {trip.styles.length>0&&<span>🎣 {trip.styles.join(", ")}</span>}
            {trip.photos.length>0&&<span>📷 {trip.photos.length} photo{trip.photos.length!==1?"s":""}</span>}
          </div>
        </div>
      ))}
    </div>
  );

  // Add trip form
  if(view==="addTrip") return(
    <div>
      <input ref={photoRef} type="file" accept="image/*" multiple style={{display:"none"}} onChange={handleTripPhoto}/>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
        <button className="back" onClick={()=>setView("guest")}>← Back</button>
        <span style={{fontFamily:"'Playfair Display',serif",fontSize:18,color:"var(--foam)",fontStyle:"italic"}}>New Trip</span>
      </div>
      <div className="card">
        <label className="lbl">Date</label>
        <input className="inp" type="date" value={tripForm.date} onChange={e=>setTripForm(f=>({...f,date:e.target.value}))}/>
        <label className="lbl">Location / River</label>
        <TripLocationWeather tripForm={tripForm} setTripForm={setTripForm}/>
        <label className="lbl">Trip Type</label>
        <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
          {TRIP_TYPES.map(t=>(
            <button key={t} onClick={()=>setTripForm(f=>({...f,type:t}))}
              style={{padding:"8px 14px",borderRadius:10,border:"1px solid "+(tripForm.type===t?"var(--water)":"rgba(255,255,255,0.12)"),background:tripForm.type===t?"var(--water)":"rgba(0,0,0,0.3)",color:tripForm.type===t?"var(--foam)":"var(--stone)",fontFamily:"'Crimson Pro',serif",fontSize:14,cursor:"pointer"}}>
              {t}
            </button>
          ))}
        </div>
        <label className="lbl">Fishing Styles</label>
        <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
          {FISHING_STYLES.map(s=>(
            <button key={s} onClick={()=>toggleStyle(s)}
              style={{padding:"6px 12px",borderRadius:10,border:"1px solid "+(tripForm.styles.includes(s)?"var(--moss)":"rgba(255,255,255,0.12)"),background:tripForm.styles.includes(s)?"rgba(90,122,74,0.4)":"rgba(0,0,0,0.3)",color:tripForm.styles.includes(s)?"#9cd47a":"var(--stone)",fontFamily:"'Crimson Pro',serif",fontSize:15,cursor:"pointer"}}>
              {s}
            </button>
          ))}
        </div>
        <label className="lbl">Estimated Catches</label>
        <input className="inp" type="number" min="0" placeholder="0" value={tripForm.catches} onChange={e=>setTripForm(f=>({...f,catches:parseInt(e.target.value)||0}))}/>
        <label className="lbl">Flies That Worked</label>
        <div className="ftags">{tripForm.flies.map((fly,i)=><div className="ftag" key={i}>🪶 {fly}<button onClick={()=>setTripForm(f=>({...f,flies:f.flies.filter((_,j)=>j!==i)}))}>×</button></div>)}</div>
        <div className="frow">
          <input className="inp" placeholder="e.g. Elk Hair Caddis #14" value={tripForm.flyInput} onChange={e=>setTripForm(f=>({...f,flyInput:e.target.value}))} onKeyDown={e=>e.key==="Enter"&&addFly()}/>
          <button className="btn" onClick={addFly}>Add</button>
        </div>
        <label className="lbl">Gear Used</label>
        <input className="inp" placeholder="e.g. 9ft 5wt, floating line" value={tripForm.gear} onChange={e=>setTripForm(f=>({...f,gear:e.target.value}))}/>
        <label className="lbl">Guide Notes</label>
        <textarea className="inp" rows={4} style={{resize:"none"}} placeholder="How did they cast? What did they struggle with? What clicked? Anything to remember for next time…" value={tripForm.guideNotes} onChange={e=>setTripForm(f=>({...f,guideNotes:e.target.value}))}/>
        <label className="lbl">Trip Cost</label>
        <div className="frow" style={{marginBottom:12}}>
          <div style={{position:"relative",flex:1}}>
            <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",color:"var(--stone)",fontSize:15}}>$</span>
            <input className="inp" type="number" min="0" placeholder="0.00" style={{paddingLeft:24,marginBottom:0}} value={tripForm.tripCost||""} onChange={e=>setTripForm(f=>({...f,tripCost:e.target.value}))}/>
          </div>
          <div style={{position:"relative",flex:1}}>
            <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",color:"var(--stone)",fontSize:15}}>Tip $</span>
            <input className="inp" type="number" min="0" placeholder="0.00" style={{paddingLeft:40,marginBottom:0}} value={tripForm.tipAmount||""} onChange={e=>setTripForm(f=>({...f,tipAmount:e.target.value}))}/>
          </div>
        </div>
        <label className="lbl">Photos</label>
        <button className="pbtn" style={{width:"100%",marginBottom:10}} onClick={()=>photoRef.current.click()}>
          <span className="pi">📷</span>Add Photos
        </button>
        {tripForm.photos.length>0&&(
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}>
            {tripForm.photos.map((p,i)=>(
              <div key={i} style={{position:"relative"}}>
                <img src={p} style={{width:80,height:80,objectFit:"cover",borderRadius:8}} alt="catch" loading="lazy"/>
                <button onClick={()=>setTripForm(f=>({...f,photos:f.photos.filter((_,j)=>j!==i)}))}
                  style={{position:"absolute",top:2,right:2,background:"rgba(0,0,0,0.7)",border:"none",color:"white",borderRadius:"50%",width:20,height:20,fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
              </div>
            ))}
          </div>
        )}
        <button className="btn btnp" onClick={saveTrip}>Save Trip</button>
      </div>
    </div>
  );

  // Edit trip
  if(view==="editTrip"&&selectedTrip) return(
    <div>
      <input ref={photoRef} type="file" accept="image/*" multiple style={{display:"none"}} onChange={handleTripPhoto}/>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
        <button className="back" onClick={()=>setView("tripDetail")}>← Back</button>
        <span style={{fontFamily:"'Playfair Display',serif",fontSize:18,color:"var(--foam)",fontStyle:"italic"}}>Edit Trip</span>
      </div>
      <div className="card">
        <label className="lbl">Date</label>
        <input className="inp" type="date" value={tripForm.date||""} onChange={e=>setTripForm(f=>({...f,date:e.target.value}))}/>
        <label className="lbl">Location / River</label>
        <TripLocationWeather tripForm={tripForm} setTripForm={setTripForm}/>
        <label className="lbl">Trip Type</label>
        <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
          {TRIP_TYPES.map(t=>(
            <button key={t} onClick={()=>setTripForm(f=>({...f,type:t}))}
              style={{padding:"8px 14px",borderRadius:10,border:"1px solid "+(tripForm.type===t?"var(--water)":"rgba(255,255,255,0.12)"),background:tripForm.type===t?"var(--water)":"rgba(0,0,0,0.3)",color:tripForm.type===t?"var(--foam)":"var(--stone)",fontFamily:"'Crimson Pro',serif",fontSize:14,cursor:"pointer"}}>
              {t}
            </button>
          ))}
        </div>
        <label className="lbl">Fishing Styles</label>
        <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
          {FISHING_STYLES.map(s=>(
            <button key={s} onClick={()=>toggleStyle(s)}
              style={{padding:"6px 12px",borderRadius:10,border:"1px solid "+(tripForm.styles?.includes(s)?"var(--moss)":"rgba(255,255,255,0.12)"),background:tripForm.styles?.includes(s)?"rgba(90,122,74,0.4)":"rgba(0,0,0,0.3)",color:tripForm.styles?.includes(s)?"#9cd47a":"var(--stone)",fontFamily:"'Crimson Pro',serif",fontSize:15,cursor:"pointer"}}>
              {s}
            </button>
          ))}
        </div>
        <label className="lbl">Estimated Catches</label>
        <input className="inp" type="number" min="0" value={tripForm.catches||0} onChange={e=>setTripForm(f=>({...f,catches:parseInt(e.target.value)||0}))}/>
        <label className="lbl">Flies That Worked</label>
        <div className="ftags">{(tripForm.flies||[]).map((fly,i)=><div className="ftag" key={i}>🪶 {fly}<button onClick={()=>setTripForm(f=>({...f,flies:f.flies.filter((_,j)=>j!==i)}))}>×</button></div>)}</div>
        <div className="frow">
          <input className="inp" placeholder="Add a fly…" value={tripForm.flyInput||""} onChange={e=>setTripForm(f=>({...f,flyInput:e.target.value}))} onKeyDown={e=>e.key==="Enter"&&addFly()}/>
          <button className="btn" onClick={addFly}>Add</button>
        </div>
        <label className="lbl">Gear Used</label>
        <input className="inp" value={tripForm.gear||""} onChange={e=>setTripForm(f=>({...f,gear:e.target.value}))}/>
        <label className="lbl">Trip Cost / Tip</label>
        <div className="frow" style={{marginBottom:12}}>
          <div style={{position:"relative",flex:1}}>
            <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",color:"var(--stone)",fontSize:15}}>$</span>
            <input className="inp" type="number" min="0" style={{paddingLeft:24,marginBottom:0}} value={tripForm.tripCost||""} onChange={e=>setTripForm(f=>({...f,tripCost:e.target.value}))}/>
          </div>
          <div style={{position:"relative",flex:1}}>
            <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",color:"var(--stone)",fontSize:15}}>Tip $</span>
            <input className="inp" type="number" min="0" style={{paddingLeft:40,marginBottom:0}} value={tripForm.tipAmount||""} onChange={e=>setTripForm(f=>({...f,tipAmount:e.target.value}))}/>
          </div>
        </div>
        <label className="lbl">Guide Notes</label>
        <textarea className="inp" rows={4} style={{resize:"none"}} value={tripForm.guideNotes||""} onChange={e=>setTripForm(f=>({...f,guideNotes:e.target.value}))}/>
        <label className="lbl">Photos</label>
        <button className="pbtn" style={{width:"100%",marginBottom:10}} onClick={()=>photoRef.current.click()}>
          <span className="pi">📷</span>Add More Photos
        </button>
        {(tripForm.photos||[]).length>0&&(
          <div style={{marginBottom:12}}>
            {(tripForm.photos||[]).map((p,i)=>{
              const cd=(tripForm.catchDetails||[])[i]||{};
              return(
                <div key={i} style={{display:"flex",gap:10,background:"rgba(0,0,0,0.2)",borderRadius:12,padding:10,marginBottom:8,alignItems:"flex-start"}}>
                  <div style={{position:"relative",flexShrink:0}}>
                    <img src={p} style={{width:72,height:72,objectFit:"cover",borderRadius:8}} alt="catch" loading="lazy"/>
                    <button onClick={()=>setTripForm(f=>({...f,photos:f.photos.filter((_,j)=>j!==i),catchDetails:(f.catchDetails||[]).filter((_,j)=>j!==i)}))}
                      style={{position:"absolute",top:-4,right:-4,background:"rgba(150,80,80,0.9)",border:"none",color:"white",borderRadius:"50%",width:18,height:18,fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
                  </div>
                  <div style={{flex:1,fontSize:15}}>
                    {cd.analyzing&&<div style={{color:"var(--sky)",fontStyle:"italic"}}>🔍 Analyzing…</div>}
                    {!cd.analyzing&&<>
                      <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:3}}>
                        {cd.species&&<span style={{color:"var(--foam)",fontStyle:"italic"}}>{cd.species}</span>}
                        {cd.length&&<span style={{color:"var(--sky)"}}>📏 {cd.length}"</span>}
                      </div>
                      {cd.time&&<div style={{color:"var(--stone)",fontSize:14}}>{cd.time}</div>}
                      {(cd.airTemp||cd.streamCFS)&&<div style={{color:"var(--stone)",fontSize:14}}>{cd.airTemp&&`🌡 ${cd.airTemp}°F`}{cd.streamCFS&&` 💧 ${cd.streamCFS} CFS`}</div>}
                    </>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <button className="btn btnp" onClick={async(e)=>{
          e.currentTarget.textContent="Saving…";e.currentTarget.disabled=true;
          await updateTripInDb(selectedTrip.id, tripForm);
          const updated={...selectedTrip,...tripForm};
          setGuests(gs=>gs.map(g=>g.id===selectedGuest.id?{...g,trips:(g.trips||[]).map(t=>t.id===selectedTrip.id?updated:t)}:g));
          setSelectedTrip(updated);
          setView("tripDetail");
          // Reload photos from DB to confirm they persisted
          loadTripPhotos(selectedTrip.id, updated);
        }}>Save Changes</button>
      </div>
    </div>
  );

  // Trip detail + report
  if(view==="tripDetail"&&selectedTrip) return(
    <div>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
        <button className="back" onClick={()=>{setView("guest");setReport(null);}}>← Back</button>
        <span style={{fontFamily:"'Playfair Display',serif",fontSize:18,color:"var(--foam)",fontStyle:"italic"}}>
          {new Date(selectedTrip.date+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}
        </span>
      </div>
      <div className="card">
        <div className="ctitle">📋 Trip Summary</div>
        {selectedTrip.location&&<div className="hr"><span className="hn">Location</span><span className="ha">{selectedTrip.location}</span></div>}
        <div className="hr"><span className="hn">Type</span><span className="ha">{selectedTrip.type}</span></div>
        <div className="hr"><span className="hn">Catches</span><span className="ha">~{selectedTrip.catches} fish</span></div>
        {selectedTrip.styles.length>0&&<div className="hr"><span className="hn">Styles</span><span className="ha">{selectedTrip.styles.join(", ")}</span></div>}
        {selectedTrip.gear&&<div className="hr"><span className="hn">Gear</span><span className="ha">{selectedTrip.gear}</span></div>}
        {(selectedTrip.airTemp||selectedTrip.waterTemp||selectedTrip.weatherConditions||selectedTrip.streamCFS)&&(
          <div style={{marginTop:10,marginBottom:4}}>
            <div className="lbl" style={{marginBottom:6}}>Conditions on the Water</div>
            {selectedTrip.streamGaugeName&&<div style={{fontSize:15,color:"var(--gold)",marginBottom:6,fontStyle:"italic"}}>🏞 {selectedTrip.streamGaugeName}</div>}
            <div style={{display:"flex",gap:10,flexWrap:"wrap",fontSize:15,color:"var(--sky)"}}>
              {selectedTrip.streamCFS&&<span>💧 {Number(selectedTrip.streamCFS).toLocaleString()} CFS · {selectedTrip.streamCondition}</span>}
              {selectedTrip.waterTemp&&<span>🌡 Water: {selectedTrip.waterTemp}°F</span>}
              {selectedTrip.weatherConditions&&<span>{selectedTrip.weatherConditions}</span>}
              {selectedTrip.airTemp&&<span>🌡 Air: {selectedTrip.airTemp}°F</span>}
              {selectedTrip.windSpeed&&<span>💨 {selectedTrip.windSpeed} mph {selectedTrip.windDir}</span>}
              {selectedTrip.pressure&&<span>📊 {selectedTrip.pressure}" {selectedTrip.pressureTrend}</span>}
            </div>
          </div>
        )}
        {selectedTrip.tripCost&&<div className="hr"><span className="hn">Trip Cost</span><span className="ha" style={{color:"var(--gold)"}}>$ {selectedTrip.tripCost}</span></div>}
        {selectedTrip.tipAmount&&<div className="hr"><span className="hn">Tip</span><span className="ha" style={{color:"#9cd47a"}}>$ {selectedTrip.tipAmount}</span></div>}
        {selectedTrip.flies.length>0&&(
          <div style={{marginTop:10}}>
            <div className="lbl" style={{marginBottom:6}}>Flies That Worked</div>
            <div className="chips">{selectedTrip.flies.map((f,i)=><a key={i} className="chip" href={`https://www.google.com/search?q=${encodeURIComponent(f+" fly pattern")}&tbm=isch`} target="_blank" rel="noreferrer" style={{textDecoration:"none"}}>🪶 {f}</a>)}</div>
          </div>
        )}
        {selectedTrip.guideNotes&&(
          <div style={{marginTop:12,padding:"10px 12px",background:"rgba(0,0,0,0.2)",borderRadius:10,borderLeft:"3px solid var(--water)"}}>
            <div className="lbl" style={{marginBottom:4}}>Guide Notes</div>
            <p style={{fontSize:15,color:"var(--sky)",lineHeight:1.6,fontStyle:"italic"}}>{selectedTrip.guideNotes}</p>
          </div>
        )}
        <div style={{marginTop:12,marginBottom:8}}>
        <input type="file" accept="image/*" multiple id="tripDetailPhotoInput" style={{display:"none"}} onChange={async(e)=>{
          const files=Array.from(e.target.files||[]);
          e.target.value="";
          if(!files.length) return;
          const btn=document.getElementById("tripDetailAddBtn");
          if(btn){btn.textContent="⏳ "+files.length+" photos…";btn.disabled=true;}
          let accDetails=[...(selectedTrip.catchDetails||[])];
          let accPhotos=[...(selectedTrip.photos||[])];
          const tripId=selectedTrip.id;
          for(let fi=0;fi<files.length;fi++){
            const file=files[fi];
            if(btn)btn.textContent="⏳ "+(fi+1)+"/"+files.length+"…";
            try{
              // Read file
              const dataUrl=await new Promise(res=>{const r=new FileReader();r.onload=ev=>res(ev.target.result);r.readAsDataURL(file);});
              // Parse EXIF from original buffer
              let photoTime=null,photoLat=null,photoLng=null,photoGpsStr=null;
              try{const abuf=await file.arrayBuffer();const exif=parseExif(abuf);photoTime=exif.time;photoLat=exif.lat??null;photoLng=exif.lng??null;photoGpsStr=exif.gps||null;}catch{}
              const fetchLat=photoLat??locRef.current?.lat;
              const fetchLng=photoLng??locRef.current?.lng;
              const t=photoTime||new Date(selectedTrip.date+"T12:00:00").toLocaleString("en-US",{month:"long",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit",hour12:true});
              const coords=photoGpsStr||(photoLat&&photoLng?fmtCoord(photoLat,photoLng):"");
              // Resize for fish ID
              const img2=await new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=dataUrl;});
              const cv=document.createElement("canvas");const scale=Math.min(1,800/Math.max(img2.width,img2.height));cv.width=Math.round(img2.width*scale);cv.height=Math.round(img2.height*scale);cv.getContext("2d").drawImage(img2,0,0,cv.width,cv.height);
              const b64=cv.toDataURL("image/jpeg",0.7).split(",")[1];
              // Fish ID
              let species="Unidentified",length="";
              try{
                const res=await fetch("/api/claude",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:150,messages:[{role:"user",content:[{type:"image",source:{type:"base64",media_type:"image/jpeg",data:b64}},{type:"text",text:"Look carefully at this fish. Identify species based on coloring and spot patterns. Rainbow trout have pink lateral stripe. Brown trout have red spots on golden body. Choose from: "+SPECIES.join(", ")+". Estimate length if visible. Reply ONLY with JSON: {\"species\":\"Rainbow Trout\",\"length\":14}. Use null for length if unknown."}]}]})});
                const rd=await res.json();
                const parsed=JSON.parse(((rd.content||[])[0]?.text||"{}").replace(/```json|```/g,"").trim());
                if(parsed.species&&parsed.species!=="Unidentified"){species=parsed.species;if(parsed.length!=null)length=String(Math.round(parsed.length));}
              }catch(fishErr){void 0;}
              // Conditions
              let detail={photo:dataUrl,time:t,gps:coords,species,length,airTemp:"",weatherDesc:"",windSpeed:"",windDir:"",pressure:"",streamCFS:"",streamCondition:"",streamGaugeName:"",analyzing:false};
              if(fetchLat&&fetchLng){
                try{
                  const d2=new Date(t.replace(" at "," "));
                  const today=new Date().toISOString().split("T")[0];
                  const dateStr=!isNaN(d2)?d2.toISOString().split("T")[0]:null;
                  if(dateStr&&dateStr<today){
                    const conds=await fetchHistoricalConditions(fetchLat,fetchLng,dateStr,"12");
                    if(conds)detail={...detail,airTemp:conds.airTemp||"",weatherDesc:conds.weatherDesc||"",windSpeed:conds.windSpeed||"",windDir:conds.windDir||"",pressure:conds.pressure||"",streamCFS:conds.streamCFS||"",streamCondition:conds.streamCondition||"",streamGaugeName:conds.streamGaugeName||""};
                  } else {
                    const[wx,usgs]=await Promise.all([fetchWeather(fetchLat,fetchLng),fetchUSGSLive(fetchLat,fetchLng)]);
                    const wc=wx.current;const pressureInHg=(wc.surface_pressure*0.02953).toFixed(2);
                    detail={...detail,airTemp:String(Math.round(wc.temperature_2m)),weatherDesc:WX_DESC[wc.weather_code]||"",windSpeed:String(Math.round(wc.wind_speed_10m)),windDir:windDir(wc.wind_direction_10m),pressure:pressureInHg};
                    const ts2=(usgs.value?.timeSeries)??[];
                    if(ts2.length){const p2=ts2.map(t3=>{const raw=t3.values?.[0]?.value?.[0]?.value;const cfs=raw!=null?parseFloat(raw):null;const sLat=parseFloat(t3.sourceInfo?.geoLocation?.geogLocation?.latitude||0);const sLng=parseFloat(t3.sourceInfo?.geoLocation?.geogLocation?.longitude||0);const dist=Math.sqrt(Math.pow(sLat-fetchLat,2)+Math.pow(sLng-fetchLng,2));return{name:t3.sourceInfo?.siteName??"",cfs,dist,label:cfsLabel(cfs,null).label};}).filter(x=>x.cfs!=null&&x.cfs>=0&&x.cfs<500000).sort((a,b)=>a.dist-b.dist);if(p2.length){detail.streamCFS=String(Math.round(p2[0].cfs));detail.streamCondition=p2[0].label;detail.streamGaugeName=p2[0].name;}}
                  }
                }catch(condErr){void 0;}
              }
              // Upload photo to storage
              const url=await uploadPhotoToStorage(dataUrl,"trips/"+tripId);
              if(url)detail.photo=url;
              accDetails=[...accDetails,detail];
              accPhotos=[...accPhotos,url||dataUrl];
              setSelectedTrip(prev=>({...prev,photos:accPhotos,catchDetails:accDetails}));
              setGuests(gs=>gs.map(g=>({...g,trips:(g.trips||[]).map(t2=>t2.id===tripId?{...t2,photos:accPhotos,catchDetails:accDetails}:t2)})));
              if(sb){await sb.from("trips").update({catch_details:accDetails}).eq("id",tripId);if(url)await sb.from("trip_photos").insert({trip_id:tripId,photo:url,sort_order:accPhotos.length-1});}
            }catch(err){void 0;}
          }
          if(btn){btn.textContent="📷 Add Catch Photos";btn.disabled=false;}
        }}/>
        <button id="tripDetailAddBtn" className="pbtn" style={{width:"100%",transition:"opacity 0.2s"}} onClick={()=>document.getElementById("tripDetailPhotoInput").click()}>
          <span className="pi">📷</span>Add Catch Photos
        </button>
      </div>
      {(selectedTrip.photosLoading||selectedTrip.photos.length>0)&&(
          <div style={{marginTop:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div className="lbl" style={{marginBottom:0}}>Catches · {selectedTrip.photosLoading?"…":selectedTrip.photos.length}</div>
              <button onClick={async(e)=>{
                const btn=e.currentTarget;
                btn.textContent="⏳ Analyzing…";btn.disabled=true;
                const SPECIES_LIST=["Brown Trout","Rainbow Trout","Brook Trout","Cutthroat Trout","Lake Trout","Bull Trout","Steelhead","Largemouth Bass","Smallmouth Bass","Other"];
                const details=[...(selectedTrip.catchDetails||[])];
                while(details.length<selectedTrip.photos.length) details.push({});
                const reset=()=>{try{btn.textContent="✦ Identify Fish";btn.disabled=false;}catch{}};
                try{
                  for(let i=0;i<selectedTrip.photos.length;i++){
                    if(details[i]?.species) continue;
                    try{
                      const photoUrl=selectedTrip.photos[i];
                      let imageSource;
                      const resizeToB64=async(src)=>new Promise((res,rej)=>{
                        const img=new Image();
                        img.onload=()=>{
                          const MAX=1024;let w=img.naturalWidth,h=img.naturalHeight;
                          if(w>MAX||h>MAX){const s=MAX/Math.max(w,h);w=Math.round(w*s);h=Math.round(h*s);}
                          const cv=document.createElement("canvas");cv.width=w;cv.height=h;
                          cv.getContext("2d").drawImage(img,0,0,w,h);
                          res(cv.toDataURL("image/jpeg",0.82).split(",")[1]);
                        };
                        img.onerror=()=>rej(new Error("img load failed"));
                        img.src=src;
                      });
                      if(photoUrl.startsWith("data:")){
                        try{imageSource={type:"base64",media_type:"image/jpeg",data:await resizeToB64(photoUrl)};}
                        catch{imageSource={type:"base64",media_type:"image/jpeg",data:photoUrl.split(",")[1]};}
                      } else {
                        try{
                          const imgRes=await Promise.race([fetch(photoUrl),new Promise((_,r)=>setTimeout(()=>r(new Error("fetch timeout")),12000))]);
                          if(!imgRes.ok){continue;}
                          const blob=await imgRes.blob();
                          const blobUrl=URL.createObjectURL(blob);
                          try{imageSource={type:"base64",media_type:"image/jpeg",data:await resizeToB64(blobUrl)};}
                          finally{URL.revokeObjectURL(blobUrl);}
                        }catch(fe){void 0;continue;}
                      }
                      if(!imageSource){continue;}
                      const claudeRes=await Promise.race([
                        fetch("/api/claude",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:150,messages:[{role:"user",content:[{type:"image",source:imageSource},{type:"text",text:`Identify fish, estimate length. Species from: ${SPECIES_LIST.join(", ")}. JSON only: {"species":"Rainbow Trout","length":14}`}]}]})}),
                        new Promise((_,r)=>setTimeout(()=>r(new Error("claude timeout")),20000))
                      ]);
                      const rd=await claudeRes.json();
                      const parsed=JSON.parse(((rd.content||[])[0]?.text||"{}").replace(/```json|```/g,"").trim());
                      if(parsed.species){details[i]={...details[i],species:parsed.species,length:parsed.length!=null?String(Math.round(parsed.length)):""};}
                      setSelectedTrip(st=>({...st,catchDetails:[...details]}));
                    }catch(e2){void 0;}
                  }
                  const upd={...selectedTrip,catchDetails:details};
                  setSelectedTrip(upd);
                  setGuests(gs=>gs.map(g=>({...g,trips:(g.trips||[]).map(t=>t.id===selectedTrip.id?upd:t)})));
                  if(sb) sb.from("trips").update({catch_details:details.map(d=>({...d,analyzing:false}))}).eq("id",selectedTrip.id);
                }catch(outerErr){void 0;}
                finally{reset();}
              }} style={{fontSize:14,padding:"4px 10px",background:"rgba(200,168,75,0.2)",border:"1px solid rgba(200,168,75,0.4)",borderRadius:8,color:"var(--gold)",cursor:"pointer",fontFamily:"'Crimson Pro',serif"}}>
                ✦ Identify Fish
              </button>
            </div>
            {selectedTrip.photosLoading&&<div className="loading" style={{padding:20,fontSize:15}}>Loading catches…</div>}
            {selectedTrip.photos.map((p,i)=>{
              const cd=(selectedTrip.catchDetails||[])[i]||{};
              return(
                <div key={i} className="cc" style={{marginBottom:10}}>
                  <img src={p} className="c-img" alt="catch" loading="lazy" style={{cursor:"pointer"}}
                    onClick={()=>{if(window._setLightbox)window._setLightbox(p);}}/>
                  <div className="cb">
                    <div className="csp">{cd.species||"Unknown"}</div>
                    <div className="cm">
                      {cd.length&&<span className="cmi">📏 {cd.length}"</span>}
                      {cd.time&&<span className="cmi">🕐 {cd.time}</span>}
                    </div>
                    {(cd.airTemp||cd.weatherDesc||cd.streamCFS||cd.windSpeed)&&(
                      <div style={{background:"rgba(0,0,0,0.2)",borderRadius:8,padding:"6px 10px",marginTop:6,marginBottom:4}}>
                        <div style={{fontSize:15,color:"var(--gold)",letterSpacing:1,textTransform:"uppercase",marginBottom:3}}>Conditions</div>
                        <div style={{display:"flex",flexWrap:"wrap",gap:"2px 10px",fontSize:14,color:"var(--stone)"}}>
                          {cd.weatherDesc&&<span>{cd.weatherDesc}</span>}
                          {cd.airTemp&&<span>🌡 {cd.airTemp}°F</span>}
                          {cd.windSpeed&&<span>💨 {cd.windSpeed}mph {cd.windDir}</span>}
                          {cd.streamCFS&&<span>💧 {Number(cd.streamCFS).toLocaleString()} CFS</span>}
                        </div>
                      </div>
                    )}
                    {cd.gps&&<div className="cgps">📍 <GpsLocation gps={cd.gps}/></div>}
                    <div style={{display:"flex",gap:8,marginTop:8}}>
                      {(!cd.species||cd.species==="Unknown"||!cd.length)&&<button onClick={async e=>{
                        e.stopPropagation();
                        const btn=e.currentTarget;btn.textContent="🔍 Identifying…";btn.disabled=true;
                        try{
                          let base64=null;
                          if(p?.startsWith("data:")){base64=p.split(",")[1];}
                          else if(p?.startsWith("http")){
                            const imgRes=await fetch(p);const blob=await imgRes.blob();
                            const dataUrl=await new Promise(res=>{const r=new FileReader();r.onload=e=>res(e.target.result);r.readAsDataURL(blob);});
                            const img=await new Promise((res,rej)=>{const im=new Image();im.onload=()=>res(im);im.onerror=rej;im.src=dataUrl;});
                            const canvas=document.createElement("canvas");const max=800;
                            const scale=Math.min(1,max/Math.max(img.width,img.height));
                            canvas.width=Math.round(img.width*scale);canvas.height=Math.round(img.height*scale);
                            canvas.getContext("2d").drawImage(img,0,0,canvas.width,canvas.height);
                            base64=canvas.toDataURL("image/jpeg",0.7).split(",")[1];
                          }
                          if(!base64){btn.textContent="🔍 Identify";btn.disabled=false;return;}
                          const res=await fetch("/api/claude",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:150,messages:[{role:"user",content:[{type:"image",source:{type:"base64",media_type:"image/jpeg",data:base64}},{type:"text",text:"Look carefully at this fish. Identify species based on coloring and spot patterns. Rainbow trout have pink lateral stripe. Brown trout have red spots on golden body. Cutthroat have red slash under jaw. Choose from: "+SPECIES.join(", ")+". Estimate length in inches if visible. Reply ONLY with JSON: {\"species\":\"Rainbow Trout\",\"length\":14}. Use null for length if unknown."}]}]})});
                          const rd=await res.json();
                          const parsed=JSON.parse(((rd.content||[])[0]?.text||"{}").replace(/```json|```/g,"").trim());
                          if(parsed.species){
                            const d=[...(selectedTrip.catchDetails||[])];while(d.length<=i)d.push({});
                            d[i]={...d[i],species:parsed.species,length:parsed.length!=null?String(Math.round(parsed.length)):d[i].length};
                            const upd={...selectedTrip,catchDetails:d};
                            setSelectedTrip(upd);setGuests(gs=>gs.map(g=>({...g,trips:(g.trips||[]).map(t=>t.id===selectedTrip.id?upd:t)})));
                            if(sb)sb.from("trips").update({catch_details:d}).eq("id",selectedTrip.id);
                          }
                        }catch(err){void 0;}
                        btn.textContent="🔍 Identify";btn.disabled=false;
                      }} style={{flex:1,background:"rgba(44,95,110,0.2)",border:"1px solid rgba(44,95,110,0.4)",borderRadius:8,padding:"7px",color:"var(--sky)",fontSize:15,cursor:"pointer",fontFamily:"'Crimson Pro',serif"}}>🔍 Identify</button>}
                      <button onClick={e=>{e.stopPropagation();setEditingTripCatchIdx(editingTripCatchIdx===i?null:i);}}
                        style={{flex:1,background:"rgba(200,168,75,0.2)",border:"1px solid rgba(200,168,75,0.5)",borderRadius:8,padding:"7px",color:"var(--gold)",fontSize:15,cursor:"pointer",fontFamily:"'Crimson Pro',serif"}}>
                        ✏️ Edit
                      </button>
                      <button onClick={e=>{e.stopPropagation();if(window.confirm("Remove this photo and catch data?")){
                        const newPhotos=selectedTrip.photos.filter((_,j)=>j!==i);
                        const newDetails=(selectedTrip.catchDetails||[]).filter((_,j)=>j!==i);
                        const upd={...selectedTrip,photos:newPhotos,catchDetails:newDetails};
                        setSelectedTrip(upd);
                        setGuests(gs=>gs.map(g=>({...g,trips:(g.trips||[]).map(t=>t.id===selectedTrip.id?upd:t)})));
                        void 0;if(sb){sb.from("trips").update({catch_details:newDetails}).eq("id",selectedTrip.id).then(({error})=>{if(error)void 0;else void 0;});}
                      }}}
                        style={{flex:1,background:"rgba(150,80,80,0.3)",border:"1px solid rgba(150,80,80,0.4)",borderRadius:8,padding:"7px",color:"var(--red)",fontSize:15,cursor:"pointer",fontFamily:"'Crimson Pro',serif"}}>
                        🗑 Remove
                      </button>
                    </div>
                  </div>
                  {editingTripCatchIdx===i&&(
                    <div style={{background:"rgba(0,0,0,0.3)",padding:"14px",borderTop:"1px solid rgba(255,255,255,0.08)"}} onClick={e=>e.stopPropagation()}>
                      <div style={{fontSize:14,color:"var(--gold)",letterSpacing:1,textTransform:"uppercase",marginBottom:10}}>Edit Catch Details</div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                        <div>
                          <div style={{fontSize:14,color:"var(--stone)",marginBottom:3}}>Species</div>
                          <select className="inp" style={{marginBottom:0,fontSize:15}} value={cd.species||""}
                            onChange={e=>{const d=[...(selectedTrip.catchDetails||[])];while(d.length<=i)d.push({});d[i]={...d[i],species:e.target.value};const upd={...selectedTrip,catchDetails:d};setSelectedTrip(upd);setGuests(gs=>gs.map(g=>({...g,trips:(g.trips||[]).map(t=>t.id===selectedTrip.id?upd:t)})));if(sb)sb.from("trips").update({catch_details:d}).eq("id",selectedTrip.id);}}>
                            <option value="">Select…</option>
                            {["Brown Trout","Rainbow Trout","Brook Trout","Cutthroat Trout","Lake Trout","Bull Trout","Steelhead","Largemouth Bass","Smallmouth Bass","Other"].map(s=><option key={s}>{s}</option>)}
                          </select>
                        </div>
                        <div>
                          <div style={{fontSize:14,color:"var(--stone)",marginBottom:3}}>Length (in)</div>
                          <input className="inp" style={{marginBottom:0,fontSize:15}} type="number" value={cd.length||""}
                            onChange={e=>{const d=[...(selectedTrip.catchDetails||[])];while(d.length<=i)d.push({});d[i]={...d[i],length:e.target.value};const upd={...selectedTrip,catchDetails:d};setSelectedTrip(upd);setGuests(gs=>gs.map(g=>({...g,trips:(g.trips||[]).map(t=>t.id===selectedTrip.id?upd:t)})));if(sb)sb.from("trips").update({catch_details:d}).eq("id",selectedTrip.id);}}/>
                        </div>
                      </div>
                      <div style={{marginBottom:8}}>
                        <div style={{fontSize:14,color:"var(--stone)",marginBottom:3}}>Date & Time</div>
                        <input className="inp" style={{marginBottom:0,fontSize:15}} value={cd.time||""}
                          onChange={e=>{const d=[...(selectedTrip.catchDetails||[])];while(d.length<=i)d.push({});d[i]={...d[i],time:e.target.value};const upd={...selectedTrip,catchDetails:d};setSelectedTrip(upd);setGuests(gs=>gs.map(g=>({...g,trips:(g.trips||[]).map(t=>t.id===selectedTrip.id?upd:t)})));if(sb)sb.from("trips").update({catch_details:d}).eq("id",selectedTrip.id);}}/>
                      </div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                        <div>
                          <div style={{fontSize:14,color:"var(--stone)",marginBottom:3}}>Air Temp °F</div>
                          <input className="inp" style={{marginBottom:0,fontSize:15}} type="number" value={cd.airTemp||""}
                            onChange={e=>{const d=[...(selectedTrip.catchDetails||[])];while(d.length<=i)d.push({});d[i]={...d[i],airTemp:e.target.value};const upd={...selectedTrip,catchDetails:d};setSelectedTrip(upd);if(sb)sb.from("trips").update({catch_details:d}).eq("id",selectedTrip.id);}}/>
                        </div>
                        <div>
                          <div style={{fontSize:14,color:"var(--stone)",marginBottom:3}}>Water Temp °F</div>
                          <input className="inp" style={{marginBottom:0,fontSize:15}} type="number" value={cd.waterTemp||""} onChange={e=>{const d=[...(selectedTrip.catchDetails||[])];while(d.length<=i)d.push({});d[i]={...d[i],waterTemp:e.target.value};const upd={...selectedTrip,catchDetails:d};setSelectedTrip(upd);if(sb)sb.from("trips").update({catch_details:d}).eq("id",selectedTrip.id);}}/>
                        </div>
                        <div>
                          <div style={{fontSize:14,color:"var(--stone)",marginBottom:3}}>Stream CFS</div>
                          <input className="inp" style={{marginBottom:0,fontSize:15}} type="number" value={cd.streamCFS||""}
                            onChange={e=>{const d=[...(selectedTrip.catchDetails||[])];while(d.length<=i)d.push({});d[i]={...d[i],streamCFS:e.target.value};const upd={...selectedTrip,catchDetails:d};setSelectedTrip(upd);if(sb)sb.from("trips").update({catch_details:d}).eq("id",selectedTrip.id);}}/>
                        </div>
                      </div>
                      <div style={{marginBottom:8}}>
                        <div style={{fontSize:14,color:"var(--stone)",marginBottom:3}}>GPS (lat, lng) — e.g. 39.7392, -104.9903</div>
                        <div style={{display:"flex",gap:6}}>
                          <input className="inp" style={{marginBottom:0,fontSize:15,flex:1}} placeholder="39.7392, -104.9903" value={cd.gps||""}
                            onChange={e=>{const d=[...(selectedTrip.catchDetails||[])];while(d.length<=i)d.push({});d[i]={...d[i],gps:e.target.value};const upd={...selectedTrip,catchDetails:d};setSelectedTrip(upd);if(sb)sb.from("trips").update({catch_details:d}).eq("id",selectedTrip.id);}}/>
                          <button onClick={async(e)=>{
                            e.stopPropagation();
                            // Try to parse GPS from field
                            const gpsVal=cd.gps||"";
                            const nums=gpsVal.match(/-?\d+\.?\d*/g);
                            let lat=null,lng=null;
                            if(nums&&nums.length>=2){lat=parseFloat(nums[0]);lng=parseFloat(nums[1]);}
                            // Fall back to browser geolocation
                            if(!lat||!lng){
                              try{
                                const pos=await new Promise((res,rej)=>navigator.geolocation.getCurrentPosition(res,rej,{timeout:8000}));
                                lat=pos.coords.latitude;lng=pos.coords.longitude;
                                // Save GPS to field
                                const d=[...(selectedTrip.catchDetails||[])];while(d.length<=i)d.push({});
                                d[i]={...d[i],gps:`${lat.toFixed(4)}°N, ${Math.abs(lng).toFixed(4)}°W`};
                                const upd={...selectedTrip,catchDetails:d};setSelectedTrip(upd);
                              }catch{alert("Could not get location. Enter GPS manually.");return;}
                            }
                            // Parse date from catch time field
                            e.currentTarget.textContent="⏳";e.currentTarget.disabled=true;
                            try{
                              const timeStr=cd.time||selectedTrip.date;
                              const d2=new Date(timeStr.replace(" at "," "));
                              const dateStr=!isNaN(d2)?d2.toISOString().split("T")[0]:selectedTrip.date;
                              const hourStr=!isNaN(d2)?String(d2.getHours()).padStart(2,"0"):"12";
                              const today=new Date().toISOString().split("T")[0];
                              const conds=dateStr&&dateStr<today?await fetchHistoricalConditions(lat,lng,dateStr,hourStr):null;
                              if(conds){
                                const d=[...(selectedTrip.catchDetails||[])];while(d.length<=i)d.push({});
                                d[i]={...d[i],...conds};
                                const upd={...selectedTrip,catchDetails:d};
                                setSelectedTrip(upd);
                                setGuests(gs=>gs.map(g=>({...g,trips:(g.trips||[]).map(t=>t.id===selectedTrip.id?upd:t)})));
                                if(sb)sb.from("trips").update({catch_details:d}).eq("id",selectedTrip.id);
                              }else{alert("No historical conditions found for this date/location.");}
                            }catch(err){alert("Conditions fetch failed: "+err.message);}
                            finally{e.currentTarget.textContent="📍 Fetch";e.currentTarget.disabled=false;}
                          }} style={{background:"rgba(200,168,75,0.2)",border:"1px solid rgba(200,168,75,0.4)",borderRadius:8,padding:"0 10px",color:"var(--gold)",fontSize:15,cursor:"pointer",whiteSpace:"nowrap",fontFamily:"'Crimson Pro',serif"}}>
                            📍 Fetch
                          </button>
                        </div>
                        <div style={{fontSize:14,color:"var(--stone)",marginTop:4}}>Enter GPS then tap Fetch to auto-fill conditions, or tap Fetch to use current location</div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {migrationStatus&&(
          <div style={{padding:"8px 12px",background:"rgba(200,168,75,0.15)",border:"1px solid rgba(200,168,75,0.3)",borderRadius:10,fontSize:15,color:"var(--gold)",marginBottom:8}}>{migrationStatus}</div>
        )}
        {migrationStatus&&(
          <div style={{padding:"8px 12px",background:"rgba(200,168,75,0.15)",border:"1px solid rgba(200,168,75,0.3)",borderRadius:10,fontSize:15,color:"var(--gold)",marginBottom:8}}>{migrationStatus}</div>
        )}
        <div style={{marginTop:14,display:"flex",gap:8}}>
          <button className="gen" style={{flex:1}} disabled={generating} onClick={()=>generateReport(selectedGuest,selectedTrip)}>
            {generating?"Generating…":"✦ Generate Client Report"}
          </button>
          <button className="btn" style={{background:"rgba(44,95,110,0.5)",padding:"0 14px"}} onClick={()=>{
  setTripForm({
    ...tripForm0,
    ...selectedTrip,
    styles:selectedTrip.styles||[],
    flies:selectedTrip.flies||[],
    photos:selectedTrip.photos||[],
    flyInput:"",
    airTemp:selectedTrip.airTemp||selectedTrip.air_temp||"",
    waterTemp:selectedTrip.waterTemp||selectedTrip.water_temp||"",
    weatherConditions:selectedTrip.weatherConditions||selectedTrip.weather_conditions||"",
    windSpeed:selectedTrip.windSpeed||selectedTrip.wind_speed||"",
    windDir:selectedTrip.windDir||selectedTrip.wind_dir||"",
    pressure:selectedTrip.pressure||"",
    pressureTrend:selectedTrip.pressureTrend||selectedTrip.pressure_trend||"",
    streamCFS:selectedTrip.streamCFS||selectedTrip.stream_cfs||"",
    streamCondition:selectedTrip.streamCondition||selectedTrip.stream_condition||"",
    streamGaugeName:selectedTrip.streamGaugeName||selectedTrip.stream_gauge_name||"",
    tripCost:selectedTrip.tripCost||selectedTrip.trip_cost||"",
    tipAmount:selectedTrip.tipAmount||selectedTrip.tip_amount||"",
  });
  setView("editTrip");
}}>✏️</button>
          <button className="btn" style={{background:"rgba(150,80,80,0.4)",border:"1px solid rgba(150,80,80,0.5)",padding:"0 14px"}} onClick={()=>{deleteTrip(selectedGuest.id,selectedTrip.id);}}>🗑</button>
        </div>
        {(selectedTrip.photos?.length>0||report)&&(
          <button className="btn" style={{width:"100%",marginTop:8,padding:12,fontSize:15,background:"linear-gradient(135deg,#1a3a45,#2c5f6e)"}}
            onClick={()=>generateTripReportPDF(selectedGuest,selectedTrip,report||"")}>
            📄 Export PDF Report
          </button>
        )}
      </div>
      {report!==null&&(
        <div className="card">
          <div className="ctitle">📄 Client Report</div>
          <div className="csub">Tap to edit before sharing</div>
          {selectedTrip.photos&&selectedTrip.photos.length>0&&(
            <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:14}}>
              {selectedTrip.photos.map((p,i)=><img key={i} src={p} loading="lazy" style={{width:"calc(50% - 4px)",height:140,objectFit:"cover",borderRadius:10}} alt="trip"/>)}
            </div>
          )}
          <textarea
            className="inp"
            rows={12}
            style={{resize:"vertical",fontSize:15,lineHeight:1.7}}
            value={report}
            onChange={e=>setReport(e.target.value)}
          />
          <div style={{display:"flex",gap:8,marginTop:10}}>
            <button className="gen" style={{flex:1,padding:12,fontSize:15}} disabled={generating} onClick={()=>generateReport(selectedGuest,selectedTrip)}>
              {generating?"Regenerating…":"↺ Regenerate"}
            </button>
            <button className="btn" style={{flex:2,padding:12,fontSize:15,background:"linear-gradient(135deg,#2c5f6e,#5a7a4a)"}}
              onClick={()=>generateTripReportPDF(selectedGuest,selectedTrip,report)}>
              📄 Export PDF
            </button>
          </div>
          <button className="btn" style={{width:"100%",marginTop:8,padding:12,fontSize:14,background:"rgba(0,0,0,0.2)"}}
            onClick={()=>{
              const header=`Trip Report — ${selectedGuest.name}\n${new Date(selectedTrip.date+"T12:00:00").toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}\n\n`;
              const txt=header+report;
              if(navigator.share){navigator.share({title:"Your Fishing Report",text:txt});}
              else{navigator.clipboard.writeText(txt).then(()=>alert("Copied to clipboard!"));}
            }}>
            📤 Share as Text
          </button>
        </div>
      )}
    </div>
  );
}

// ── Upcoming Trips ────────────────────────────────────────────────────────────
function UpcomingTrips({user}){
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(true);
  const today = new Date().toISOString().split("T")[0];

  useEffect(()=>{
    if(!sb||!user?.email){ setLoading(false); return; }
    async function load(){
      const {data:guests}=await sb.from("guests").select("id,name").ilike("email",user.email);
      if(!guests?.length){ setLoading(false); return; }
      const guestIds=guests.map(g=>g.id);
      const {data:tripData}=await sb.from("trips")
        .select("id,date,location,type,styles,catches,guide_notes,report_text")
        .in("guest_id",guestIds)
        .gte("date",today)
        .order("date",{ascending:true});
      setTrips(tripData||[]);
      setLoading(false);
    }
    load().catch(()=>setLoading(false));
  },[user]);

  if(loading||!trips.length) return null;

  return(
    <div style={{marginBottom:16}}>
      <div style={{fontFamily:"'Playfair Display',serif",fontSize:16,color:"var(--gold)",marginBottom:10,letterSpacing:0.5}}>
        📅 Upcoming Trips
      </div>
      {trips.map(t=>(
        <div key={t.id} className="card" style={{marginBottom:10}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
            <div>
              <div style={{fontFamily:"'Playfair Display',serif",fontSize:14,color:"var(--foam)",fontStyle:"italic"}}>{t.location||"Location TBD"}</div>
              <div style={{fontSize:15,color:"var(--gold)",marginTop:2,fontWeight:"bold"}}>{new Date(t.date+"T12:00:00").toLocaleDateString("en-US",{weekday:"short",month:"long",day:"numeric",year:"numeric"})}</div>
              <div style={{fontSize:14,color:"var(--stone)",marginTop:2}}>{t.type}{t.styles?.length?" · "+t.styles.join(", "):""}</div>
            </div>
            <div style={{fontSize:22}}>🎣</div>
          </div>
          {t.guide_notes&&<div style={{fontSize:15,color:"var(--sky)",marginTop:8,fontStyle:"italic",lineHeight:1.5}}>{t.guide_notes}</div>}
          {t.report_text&&(
            <div style={{marginTop:8,borderTop:"1px solid rgba(255,255,255,0.08)",paddingTop:8}}>
              <div style={{fontSize:14,color:"var(--gold)",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Guide Notes</div>
              <div style={{fontSize:15,color:"var(--foam)",lineHeight:1.6,fontFamily:"'Crimson Pro',serif"}}>{t.report_text}</div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Trip Planner ──────────────────────────────────────────────────────────────
// ── Stream Gauge Chart — looks up USGS gauge by stream name ──────────────────
function StreamGaugeChart({streamName, localGauges, lat, lng}){
  const [siteNo, setSiteNo] = useState(null);
  const [siteName, setSiteName] = useState("");
  const [cfs, setCfs] = useState(null);
  const [tried, setTried] = useState(false);

  useEffect(()=>{
    if(!streamName||tried) return;
    setTried(true);

    // First check local gauges already fetched
    const words=(streamName||"").toLowerCase().split(/[\s,()]+/).filter(w=>w.length>3);
    const local=localGauges&&localGauges.find(g=>{
      const gn=(g.name||"").toLowerCase();
      return words.some(w=>gn.includes(w));
    });
    if(local&&local.siteNo){setSiteNo(local.siteNo);setSiteName(local.name);setCfs(local.cfs);return;}

    // Otherwise search USGS by stream name
    const query=streamName.split("(")[0].split(",")[0].trim();
    if(!lat||!lng) return;
    const _p=1.0,_mnLng=Math.round((lng-_p)*10000)/10000,_mxLng=Math.round((lng+_p)*10000)/10000,_mnLat=Math.round((lat-_p)*10000)/10000,_mxLat=Math.round((lat+_p)*10000)/10000;
    fetch(`https://waterservices.usgs.gov/nwis/iv/?format=json&bBox=${_mnLng},${_mnLat},${_mxLng},${_mxLat}&parameterCd=00060&siteType=ST`)
      .then(r=>r.json())
      .then(d=>{
        const ts=d.value?.timeSeries||[];
        if(!ts.length) return;
        // Pick the one whose name best matches
        const scored=ts.map(t=>{
          const n=(t.sourceInfo?.siteName||"").toLowerCase();
          const score=words.filter(w=>n.includes(w)).length;
          return{score,siteNo:t.sourceInfo?.siteCode?.[0]?.value,name:t.sourceInfo?.siteName,cfs:parseFloat(t.values?.[0]?.value?.[0]?.value)};
        }).filter(t=>t.score>0&&t.siteNo).sort((a,b)=>b.score-a.score);
        if(scored.length>0){setSiteNo(scored[0].siteNo);setSiteName(scored[0].name);setCfs(scored[0].cfs);}
      }).catch(()=>{});
  },[streamName]);

  if(!siteNo) return null;
  return <GaugeChart siteNo={siteNo} siteName={siteName||streamName} initialCFS={cfs}/>;
}



const FLY_FACTS=[
  "The longest recorded fly casting distance is over 200 feet.",
  "Trout can see colors — they're particularly sensitive to ultraviolet light.",
  "A well-presented dry fly will float in the surface film, not on top of it.",
  "The first known fly fishing reference dates to 2nd century Macedonia.",
  "Brown trout were introduced to North America from Europe in 1883.",
  "A mend is a repositioning of the fly line to control drift — the most important skill in fly fishing.",
  "Mayflies (Ephemeroptera) have been on Earth for over 300 million years.",
  "The emerger stage of an insect is often more effective than the dry fly.",
  "Polarized sunglasses let you see through the water's glare to spot fish.",
  "Catch and release fishing was popularized by Lee Wulff in the 1930s.",
  "A trout's feeding lane is typically no wider than its body.",
  "The drag-free drift is the holy grail of dry fly fishing.",
  "Brook trout are actually char, not true trout.",
  "Caddisflies build cases from sand, pebbles, and sticks on the stream bottom.",
  "The tippet should be invisible — fluorocarbon refracts light like water.",
  "Rising trout are sipping flies from just below the surface film, not on top.",
  "USGS measures streamflow at over 8,000 active gauges across the US.",
  "A pool, riffle, and run are the three basic stream habitat types.",
  "The hatch timing depends on water temperature, not calendar date.",
  "Cutthroat trout are named for the red slash marks under their jaw.",
];
function TripPlannerLoading({steps,onCancel}){
  const [factIdx,setFactIdx]=React.useState(Math.floor(Math.random()*FLY_FACTS.length));
  const [fade,setFade]=React.useState(true);
  React.useEffect(()=>{
    const t=setInterval(()=>{
      setFade(false);
      setTimeout(()=>{setFactIdx(i=>(i+1)%FLY_FACTS.length);setFade(true);},500);
    },10000);
    return()=>clearInterval(t);
  },[]);
  return(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(8,20,25,0.97)",zIndex:9000,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"32px 24px"}}>
      <button onClick={onCancel} style={{position:"absolute",top:20,right:20,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:10,padding:"8px 16px",color:"var(--stone)",fontSize:15,cursor:"pointer",fontFamily:"'Crimson Pro',serif"}}>✕ Cancel</button>
      <div style={{fontSize:56,marginBottom:20}}>🪶</div>
      <div style={{fontFamily:"'Playfair Display',serif",fontSize:26,color:"var(--gold)",marginBottom:6,textAlign:"center",letterSpacing:0.5}}>Hang tight, let it drift.</div>
      <div style={{fontSize:16,color:"var(--stone)",marginBottom:36,textAlign:"center",fontStyle:"italic",lineHeight:1.6}}>The AI overlords are out there<br/>checking fly shop reports for you…</div>
      <div style={{background:"rgba(0,0,0,0.35)",border:"1px solid rgba(200,168,75,0.2)",borderRadius:16,padding:"22px 28px",maxWidth:340,marginBottom:36,minHeight:90,display:"flex",alignItems:"center",justifyContent:"center"}}>
        <p style={{fontSize:16,color:"var(--sky)",lineHeight:1.75,textAlign:"center",transition:"opacity 0.5s",opacity:fade?1:0,margin:0,fontStyle:"italic"}}>"{FLY_FACTS[factIdx]}"</p>
      </div>
      <div style={{width:"100%",maxWidth:340}}>
        {steps.map((s,i)=><div key={i} className={"step "+s.state}><div className="dot"/>{s.text}</div>)}
      </div>
    </div>
  );
}

function TripPlanner({defaultLocation,parentGauges,savedGauges,parentLoc}){
  const [loc,setLoc]=useState({label:defaultLocation||"",lat:null,lng:null});
  const driveMinutes=120;
  const [date,setDate]=useState(()=>new Date().toISOString().split("T")[0]);
  const [steps,setSteps]=useState([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState(null);
  const [wxData,setWxData]=useState(null);
  const [flowPts,setFlowPts]=useState([]);
  const [flowLabel,setFlowLabel]=useState("");
  const [gauges,setGauges]=useState([]);

  const [shops,setShops]=useState([]);
  const [report,setReport]=useState(null);

  useEffect(()=>{if(defaultLocation)setLoc(l=>({...l,label:defaultLocation}));},[defaultLocation]);

  function addStep(text,state="done"){
    setSteps(prev=>{
      const n=[...prev];
      if(n.length&&n[n.length-1].state==="active")n[n.length-1].state="done";
      n.push({text,state});return n;
    });
  }

  async function generate(){
    if(!loc.label.trim()){setError("Please enter a destination.");return;}
    setBusy(true);setError(null);setSteps([]);
    setWxData(null);setFlowPts([]);setGauges([]);setShops([]);setReport(null);
    try{
      addStep("Finding location…","active");
      let lat=loc.lat,lng=loc.lng;
      if(!lat||!lng){
        const data=await geocode(loc.label);
        if(!data.length)throw new Error("Location not found.");
        lat=parseFloat(data[0].lat);lng=parseFloat(data[0].lon);
        setLoc(l=>({...l,lat,lng}));
      }
      addStep(`📍 ${loc.label}`);

      addStep("Fetching forecast…","active");
      const wx=await fetchWeather(lat,lng);
      setWxData(wx);
      addStep("Forecast loaded ✓");

      addStep("Loading stream data…","active");
      // Use Intel tab gauges — already fetched, filtered, and correct
      const pgScaled=(parentGauges||[]);
      setGauges(pgScaled);
      addStep(`${pgScaled.length} streams loaded from Intel tab`);

      {
        // Filter USGS gauges to fishable streams only
        const NON_FISHABLE2=["canal","ditch","drain","diversion","lateral","irrigation","pipeline","tunnel","aqueduct","municipal","effluent","waste","sewage","outfall","reservoir","lake","pond","inlet","outlet","tailrace","headgate","bypass","flume","return","delivery","main","supply","project","district","well","spring","seep","buffer zone","landfill","plant","facility","treatment"];
        const fishableGauges=pgScaled.filter(g=>{
          const n=g.name.toLowerCase();
          const waterWords=["creek","river","brook"," run"," fork","branch","stream","slough","gulch","canyon","bayou","kill"," rio "," cr"," ck"," fk"];
          const hasWater=waterWords.some(w=>n.includes(w));
          const hasNonFish=NON_FISHABLE2.some(w=>n.includes(w));
          return hasWater&&!hasNonFish;
        }).slice(0,25);
        addStep("Finding fly shops & fishing report…","active");
        const ds=new Date(date+"T12:00:00").toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});
        try{
          // Step 1: Run two parallel searches for broader coverage
          addStep("Searching fly shop reports…","active");
          const searchPrompt1="Search fly shop websites for current fishing reports for "+ds+" within "+(driveMinutes<60?driveMinutes+" minute":Math.round(driveMinutes/60*10)/10+" hour")+" drive of "+loc.label+" in ALL directions including east, west, north, and south. Find shops in every nearby town and city. List every stream mentioned with current conditions and flies working.";
          const searchPrompt2="Search for current trout fishing reports on major rivers and streams within "+(driveMinutes<60?driveMinutes+" minute":Math.round(driveMinutes/60*10)/10+" hour")+" drive of "+loc.label+" in all directions including over mountain passes. Note freestone vs tailwater, flows, and crowd levels for "+ds+".";
          const searchRace=await Promise.race([
            Promise.all([askClaude(searchPrompt1,true,3500),askClaude(searchPrompt2,true,3500)]),
            new Promise(r=>setTimeout(()=>r(null),25000))
          ]);
          const [searchTxt1,searchTxt2]=searchRace||["",""];
          const searchTxt=searchTxt1+" "+searchTxt2;
          void 0;

          // Step 2: Synthesize into JSON (no web search, just structure the prose)
          addStep("Building recommendations…","active");
          const savedInRadius=(savedGauges||[]).filter(sg=>{if(!sg.lat||!sg.lng)return false;const d=Math.sqrt(Math.pow((sg.lat||0)-lat,2)+Math.pow((sg.lng||0)-lng,2))*69;return d<=140;});
          const synthPrompt="You are a fly fishing guide for "+loc.label+". Date: "+ds+". Weather: "+(wx?Math.round((wx.current&&wx.current.temperature_2m)||0)+"F":"unknown")+". USGS live flow data for streams within 2hrs: "+(pgScaled.length?pgScaled.map(g=>g.name+" ("+Math.round(g.cfs||0)+" CFS - "+g.label+")").join("; "):"not available")+(savedInRadius.length?". User home waters: "+savedInRadius.map(s=>s.site_name||s.name||"").filter(Boolean).join(", "):"")+"."+" Fly shop reports: "+(searchTxt.slice(0,1500)||"none")+". TASK: Rank the 6 BEST trout fisheries within 2hrs of this location from best to worst for today (maximum 6 streams). Use USGS flow data if available, otherwise use your expert knowledge of this region. Exclude urban drainage and irrigation. For each stream use the actual CFS from the USGS data. Keep each field 1 sentence. Shops: ONLY include shops found verbatim in the fly shop reports. Return ONLY JSON no markdown: "+'{"overview":"","recommendation":"","bestFor":{"mostFish":"","bestScenery":"","mostSolitude":"","beginners":""},"rivers":[{"name":"","lat":0,"lng":0,"type":"","cfs":"","condition":"","crowdLevel":"","conditions":"","techniques":"","bestTime":"","accessPoints":[],"flies":[],"why":""}],"hatches":"","bestTimes":"","tips":"","flyBoxEssentials":[],"shops":[{"name":"","website":"","reportUrl":""}]}';
          const reportTxt=await askClaude(synthPrompt,false,6000);
          void 0;
          void 0;
          const clean=reportTxt.replace(/```json|```/g,"").trim();
          let rpt=null;
          try{rpt=JSON.parse(clean);}catch(pe){void 0;}
          if(!rpt){const s=clean.indexOf("{"),e=clean.lastIndexOf("}");if(s!==-1&&e>s)try{rpt=JSON.parse(clean.slice(s,e+1));}catch(pe2){void 0;}}
          if(!rpt) rpt=extractJSON(reportTxt);
          void 0;
          if(rpt&&(rpt.overview||rpt.rivers)){
            const toStr=v=>Array.isArray(v)?v.join(", "):typeof v==="object"&&v?JSON.stringify(v):v||"";
            const clean2=s=>(toStr(s)).replace(/<cite[^>]*>|<\/cite>/g,"");
            setReport({dataSource:searchTxt.length>200?"current":"estimated",overview:clean2(rpt.overview),recommendation:clean2(rpt.recommendation),bestFor:rpt.bestFor||null,rivers:(rpt.rivers||[]).map(r=>({...r,conditions:clean2(r.conditions),techniques:clean2(r.techniques),why:clean2(r.why),bestTime:clean2(r.bestTime),accessPoints:Array.isArray(r.accessPoints)?r.accessPoints:r.accessPoints?[String(r.accessPoints)]:[],flies:Array.isArray(r.flies)?r.flies:r.flies?[String(r.flies)]:[]})),hatches:clean2(rpt.hatches),bestTimes:clean2(rpt.bestTimes),tips:clean2(rpt.tips),flyBoxEssentials:Array.isArray(rpt.flyBoxEssentials)?rpt.flyBoxEssentials:[],shops:rpt.shops||[]});
          } else { setError("The research step returned no usable report"+(String(searchTxt||"").length<200?" — the web search came back empty":"")+". Try again, or tell Adam what this said."); }
        }catch(e2){setError("Report failed: "+((e2&&e2.message)||String(e2)));}
        addStep("Report complete ✓");
        // Fetch gauges AFTER report so we know which streams to prioritize
        addStep("Loading stream gauges…","active");
        try{
          const degRadius=Math.min((driveMinutes/60)*1.0,2.0);
          const liveD=await fetchUSGSLive(lat,lng,degRadius);
          const liveTS=liveD.value?.timeSeries??[];
          const pg=liveTS.map(t=>{
            const raw=t.values?.[0]?.value?.[0]?.value;
            const cfs=raw!=null?parseFloat(raw):null;
            const{label,cls}=cfsLabel(cfs);
            const siteNo=(t.sourceInfo?.siteCode?.[0]?.value)||"";
            const siteLat=parseFloat(t.sourceInfo?.geoLocation?.geogLocation?.latitude||0);
            const siteLng=parseFloat(t.sourceInfo?.geoLocation?.geogLocation?.longitude||0);
            const dist=Math.sqrt(Math.pow(siteLat-lat,2)+Math.pow(siteLng-lng,2));
            return{name:t.sourceInfo?.siteName??"Unknown",cfs,label,cls,siteNo,dist,lat:siteLat,lng:siteLng};
          }).filter(s=>{
            if(!s.cfs||s.cfs<0||s.cfs>=500000) return false;
            if(!isoPolygon) return true;
            let inside=false;const x=s.lng,y=s.lat;
            for(let i=0,j=isoPolygon.length-1;i<isoPolygon.length;j=i++){
              const xi=isoPolygon[i][0],yi=isoPolygon[i][1],xj=isoPolygon[j][0],yj=isoPolygon[j][1];
              if(((yi>y)!==(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi)+xi)) inside=!inside;
            }
            return inside;
          }).sort((a,b)=>a.dist-b.dist).slice(0,20);
          const maxCFS2=Math.max(...pg.map(g=>g.cfs||0),1);
          setGauges(pg.map(g=>({...g,pct:g.cfs?Math.min(Math.round((g.cfs/maxCFS2)*95),100):0})));
          const histD=await fetchUSGSHistory(lat,lng);
          const histTS=histD.value?.timeSeries??[];
          if(histTS.length){
            const best=histTS.sort((a,b)=>(b.values?.[0]?.value?.length||0)-(a.values?.[0]?.value?.length||0))[0];
            const pts=(best.values?.[0]?.value??[]).map(v=>({t:v.dateTime,v:parseFloat(v.value)})).filter(v=>!isNaN(v.v)&&v.v>=0&&v.v<500000);
            setFlowPts(pts);setFlowLabel(best.sourceInfo?.siteName??"");
          }
          addStep(`${pg.length} gauges loaded ✓`);
        }catch(ge){void 0;}
      }
    }catch(e){
      setError(e.message||"Something went wrong. Please try again.");
      void 0;
    }finally{setBusy(false);}
  }

  const tripDay=new Date(date+"T12:00:00");
  const daysOut=Math.round((tripDay-new Date())/86400000);

  return(
    <div>
      <div className="card">
        <div className="ctitle">🗓 Plan Your Trip</div>
        <label className="lbl">Destination</label>
        <div style={{marginBottom:12}}>
          <LocationSearch placeholder="River, city, or region…" initialValue={loc.label} onSelect={s=>setLoc(s)}/>
        </div>
        <label className="lbl">Trip Date</label>
        <input className="inp" type="date" value={date} min={new Date().toISOString().split("T")[0]} onChange={e=>setDate(e.target.value)}/>
        <div style={{fontSize:14,color:"var(--stone)",marginBottom:12}}>Shows all fishable streams within a <span style={{color:"var(--gold)"}}>2 hour drive</span></div>
        {error&&<div className="err">{error}</div>}
        <button className="gen" onClick={generate} disabled={busy}>{busy?"Generating…":"✦ Generate Fishing Report"}</button>
      </div>

      {error&&<div style={{background:"rgba(150,80,80,0.15)",border:"1px solid rgba(150,80,80,0.4)",borderRadius:10,padding:"10px 14px",fontSize:14,color:"var(--red)",marginBottom:10}}>{error}</div>}
      {busy&&<TripPlannerLoading steps={steps} onCancel={()=>{setBusy(false);setSteps([]);setError(null);}}/>}
      {!busy&&steps.length>0&&<div className="card">{steps.map((s,i)=><div key={i} className={`step ${s.state}`}><div className="dot"/>{s.text}</div>)}</div>}

      {wxData?.daily&&!busy&&(
        <div className="card">
          <div className="ctitle">🌤 7-Day Forecast</div>
          <WeekForecast data={wxData} highlightDay={daysOut}/>
        </div>
      )}





      {shops.length>0&&!busy&&(
        <div className="card">
          <div className="ctitle">🪝 Top Fly Shops</div>
          <div className="csub">Sourced from current web results · sorted by proximity</div>
          {shops.map((s,i)=>(
            <div className="scard" key={i}>
              <div className="sname">{i+1}. {s.name}</div>
              <div className="smeta">
                {s.rating&&<span className="srat">★ {s.rating}</span>}
                {s.reviews&&<span>({Number(s.reviews).toLocaleString()} reviews)</span>}
                {s.distanceMiles&&<span>~{s.distanceMiles} mi away</span>}
                {s.address&&<span>{s.address}</span>}
              </div>
              {s.specialty&&<div style={{fontSize:15,color:"var(--sky)",marginTop:4,fontStyle:"italic"}}>{s.specialty}</div>}
              <div style={{display:"flex",gap:10,marginTop:6,flexWrap:"wrap"}}>
                {s.website&&s.website!=="https://"&&<a href={s.website} target="_blank" rel="noreferrer" style={{fontSize:15,color:"var(--gold)",textDecoration:"none",display:"flex",alignItems:"center",gap:4}}>🌐 Visit Website</a>}
                <a href={`https://www.google.com/maps/search/${encodeURIComponent((s.name||"")+" "+(s.address||""))}`} target="_blank" rel="noreferrer" style={{fontSize:15,color:"var(--sky)",textDecoration:"none",display:"flex",alignItems:"center",gap:4}}>📍 Maps</a>
              </div>
            </div>
          ))}
        </div>
      )}

      {report&&(
        <div className="card">
          <div className="ctitle">🎣 Fishing Report</div>
          <div className="csub">{report.dataSource==="estimated"?"Based on typical seasonal conditions — no current reports found":"Synthesized from current fly shop reports"}</div>
          <p style={{fontSize:14,color:"var(--foam)",lineHeight:1.65,marginBottom:14}}>{(report.overview||"").replace(/<cite[^>]*>|<\/cite>/g,"")}</p>
          {report.recommendation&&(
            <div style={{background:"rgba(90,122,74,0.2)",border:"1px solid rgba(90,122,74,0.4)",borderRadius:12,padding:"12px 14px",marginBottom:14,display:"flex",gap:10,alignItems:"flex-start"}}>
              <span style={{fontSize:20,flexShrink:0}}>🏆</span>
              <div>
                <div style={{fontSize:14,color:"#9cd47a",letterSpacing:1,textTransform:"uppercase",marginBottom:4}}>Best Bet Today</div>
                <p style={{fontSize:14,color:"var(--foam)",lineHeight:1.6}}>{(report.recommendation||"").replace(/<cite[^>]*>|<\/cite>/g,"")}</p>
              </div>
            </div>
          )}
          {report.bestFor&&Object.values(report.bestFor).some(v=>v)&&(
            <div style={{marginTop:12}}>
              <div className="slbl">🎯 Best For</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:8}}>
                {[["mostFish","🐟 Most Fish"],["bestScenery","🏔 Best Scenery"],["mostSolitude","🧘 Most Solitude"],["beginners","🎣 Beginners"]].map(([k,label])=>report.bestFor[k]?(
                  <div key={k} style={{background:"rgba(0,0,0,0.2)",borderRadius:10,padding:"8px 10px"}}>
                    <div style={{fontSize:15,color:"var(--gold)",textTransform:"uppercase",letterSpacing:1,marginBottom:3}}>{label}</div>
                    <div style={{fontSize:15,color:"var(--foam)"}}>{report.bestFor[k]}</div>
                  </div>
                ):null)}
              </div>
            </div>
          )}
          {report.rivers?.length>0&&<><div className="divider"/>
            {report.rivers.map((r,i)=>{
              return(
              <div className="rb" key={i}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><div className="rriver">🏞 {r.name}</div><a href={r.lat&&r.lng?`https://maps.google.com/?q=${r.lat},${r.lng}`:`https://www.google.com/maps/search/${encodeURIComponent(r.name)}`} target="_blank" rel="noreferrer" style={{fontSize:14,color:"var(--sky)",textDecoration:"none",padding:"2px 8px",background:"rgba(44,95,110,0.2)",borderRadius:12,flexShrink:0}}>📍 Map</a></div>{(r.cfs||r.type||r.crowdLevel)&&<div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:4}}>{r.type&&<span style={{fontSize:14,background:"rgba(44,95,110,0.2)",borderRadius:12,padding:"2px 8px",color:"var(--sky)"}}>{r.type}</span>}{r.cfs&&r.cfs!=="unknown"&&<span style={{fontSize:14,background:"rgba(44,95,110,0.2)",borderRadius:12,padding:"2px 8px",color:"var(--gold)"}}>💧 {r.cfs} · {r.condition||""}</span>}{r.crowdLevel&&<span style={{fontSize:14,background:r.crowdLevel==="Light"?"rgba(90,122,74,0.2)":r.crowdLevel==="Heavy"?"rgba(150,80,80,0.2)":"rgba(200,168,75,0.15)",borderRadius:12,padding:"2px 8px",color:r.crowdLevel==="Light"?"#9cd47a":r.crowdLevel==="Heavy"?"var(--red)":"var(--gold)"}}>👥 {r.crowdLevel} crowds</span>}{r.bestTime&&<span style={{fontSize:14,background:"rgba(0,0,0,0.2)",borderRadius:12,padding:"2px 8px",color:"var(--stone)"}}>🕐 {r.bestTime}</span>}</div>}{r.why&&<div style={{fontSize:15,color:"#9cd47a",fontStyle:"italic",marginBottom:4}}>✓ {r.why}</div>}
                {r.accessPoints?.length>0&&<div style={{marginBottom:6}}><div style={{fontSize:14,color:"var(--stone)",textTransform:"uppercase",letterSpacing:1,marginBottom:3}}>Access Points</div>{r.accessPoints.map((ap,ai)=><a key={ai} href={"https://www.google.com/maps/search/"+encodeURIComponent(ap)} target="_blank" rel="noreferrer" style={{display:"block",fontSize:14,color:"var(--sky)",textDecoration:"none",marginBottom:2}}>📍 {ap}</a>)}</div>}
                <div className="rbody">{(r.conditions||"").replace(/<cite[^>]*>|<\/cite>/g,"")}</div>
                {r.techniques&&<div className="rtech">{(r.techniques||"").replace(/<cite[^>]*>|<\/cite>/g,"").replace(/\s*\(\d+-?\d*%\)/g,"").trim()}</div>}
                {r.flies?.length>0&&<div className="chips">{r.flies.map((f,j)=><a key={j} className="chip" href={`https://www.google.com/search?q=${encodeURIComponent(f+" fly pattern")}&tbm=isch`} target="_blank" rel="noreferrer" style={{textDecoration:"none",cursor:"pointer"}}>🪶 {f}</a>)}</div>}
                <StreamGaugeChart streamName={r.name} localGauges={gauges} lat={r.lat||loc?.lat} lng={r.lng||loc?.lng}/>
              </div>
              );
            })}
          </>}
          {report.hatches&&<><div className="slbl">Hatch Activity</div><p style={{fontSize:14,color:"var(--foam)",lineHeight:1.65,marginBottom:14}}>{report.hatches}</p></>}
          {report.bestTimes&&<><div className="slbl">Best Times</div><p style={{fontSize:14,color:"var(--foam)",lineHeight:1.65,marginBottom:14}}>{report.bestTimes}</p></>}
          {report.tips&&<><div className="slbl">Insider Tips</div><p style={{fontSize:14,color:"var(--foam)",lineHeight:1.65,marginBottom:14}}>{report.tips}</p></>}
          {report.flyBoxEssentials?.length>0&&<><div className="divider"/><div className="slbl">Fly Box Essentials</div><div className="chips">{report.flyBoxEssentials.map((f,i)=><a key={i} className="chip" href={`https://www.google.com/search?q=${encodeURIComponent(f+" fly pattern")}&tbm=isch`} target="_blank" rel="noreferrer" style={{textDecoration:"none",cursor:"pointer"}}>🪶 {f}</a>)}</div></> }
          {report.shops?.length>0&&<><div className="divider"/><div className="slbl">🪝 Sources</div><div style={{fontSize:14,color:"var(--stone)",fontStyle:"italic",marginBottom:8}}>Fly shop reports used to generate this report.</div>{report.shops.map((s,i)=><div key={i} style={{padding:"8px 0",borderBottom:i<report.shops.length-1?"1px solid rgba(255,255,255,0.06)":"none"}}><div style={{fontSize:15,color:"var(--foam)",fontFamily:"'Crimson Pro',serif",fontWeight:600}}>{s.name}</div>{s.location&&<div style={{fontSize:14,color:"var(--stone)",marginTop:2}}>{s.location}</div>}{s.website&&<a href={s.website.startsWith("http")?s.website:"https://"+s.website} target="_blank" rel="noreferrer" style={{fontSize:14,color:"var(--gold)",textDecoration:"none",display:"block",marginTop:2}}>{s.website.replace(/^https?:\/\//,"")}</a>}</div>)}</> }
        </div>
      )}
    </div>
  );
}


// ── Main App ──────────────────────────────────────────────────────────────────


function GaugeSearch({loc,onAdd,gaugeInput,setGaugeInput,gaugeAdding}){
  const q=(gaugeInput||"").toLowerCase().trim();
  const loadedGauges=window._loadedGauges||[];
  const [searchResults,setSearchResults]=React.useState([]);
  const [searching,setSearching]=React.useState(false);
  const localResults=q.length>=2&&!q.match(/^[0-9]+$/)
    ?loadedGauges.filter(g=>(g.name||"").toLowerCase().includes(q)).slice(0,6)
    :[];
  const results=[...localResults,...searchResults.filter(r=>!localResults.find(l=>l.siteNo===r.siteNo))].slice(0,8);
  React.useEffect(()=>{
    if(q.length<3||q.match(/^[0-9]+$/)){setSearchResults([]);return;}
    if(localResults.length>=4){setSearchResults([]);return;}
    const timer=setTimeout(async()=>{
      setSearching(true);
      try{
        const p=2.5;const bbox=`${((loc?.lng||0)-p).toFixed(2)},${((loc?.lat||0)-p).toFixed(2)},${((loc?.lng||0)+p).toFixed(2)},${((loc?.lat||0)+p).toFixed(2)}`;const url=`https://waterservices.usgs.gov/nwis/iv/?format=json&bBox=${bbox}&parameterCd=00060&siteType=ST`;
        const r=await fetch("/api/claude",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({proxy_url:url})});
        const d=await r.json();
        const ts=(d.value?.timeSeries||[]).map(t=>({
          name:t.sourceInfo?.siteName||"",
          siteNo:(t.sourceInfo?.siteCode?.[0]?.value)||"",
          lat:parseFloat(t.sourceInfo?.geoLocation?.geogLocation?.latitude||0),
          lng:parseFloat(t.sourceInfo?.geoLocation?.geogLocation?.longitude||0),
        })).filter(x=>x.siteNo&&x.name);
        setSearchResults(ts.filter(x=>x.name.toLowerCase().includes(q)).slice(0,6));
      }catch{}
      setSearching(false);
    },500);
    return()=>clearTimeout(timer);
  },[q]);
  return(
    <div>
      <div style={{display:"flex",gap:6}}>
        <input value={gaugeInput} onChange={e=>setGaugeInput(e.target.value)}
          placeholder="Search loaded streams or paste site #"
          style={{flex:1,background:"rgba(0,0,0,0.3)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:8,padding:"6px 10px",color:"var(--foam)",fontSize:15}}/>
        {gaugeInput.match(/^[0-9]{5,}$/)&&<button onClick={onAdd} disabled={gaugeAdding}
          style={{background:"var(--gold)",color:"#0d1f26",border:"none",borderRadius:8,padding:"6px 12px",fontSize:15,cursor:"pointer"}}>
          {gaugeAdding?"…":"Save"}
        </button>}
      </div>
      {results.length===0&&q.length>=2&&!q.match(/^[0-9]+$/)&&(
        <div style={{marginTop:8,background:"rgba(200,168,75,0.1)",border:"1px solid rgba(200,168,75,0.3)",borderRadius:10,padding:"10px 12px"}}>
          <div style={{fontSize:15,color:"var(--gold)",marginBottom:4,fontWeight:600}}>Stream not found in nearby gauges</div>
          <div style={{fontSize:14,color:"var(--stone)",lineHeight:1.6}}>
            To add any stream:<br/>
            1. Go to <a href="https://waterdata.usgs.gov/nwis/rt" target="_blank" rel="noreferrer" style={{color:"var(--sky)"}}>waterdata.usgs.gov</a><br/>
            2. Search for your stream<br/>
            3. Copy the 8-digit site number<br/>
            4. Paste it in the field above and tap Save
          </div>
        </div>
      )}
      {results.map((r,i)=>(
        <div key={i} onClick={()=>{setGaugeInput(r.siteNo);}}
          style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 10px",marginTop:4,background:"rgba(255,255,255,0.05)",borderRadius:8,cursor:"pointer"}}>
          <div>
            <div style={{fontSize:15,color:"var(--foam)"}}>{r.name}</div>
            <div style={{fontSize:14,color:"var(--stone)"}}>#{r.siteNo} · {r.distMi}mi away</div>
          </div>
          {r.lat&&r.lng&&<a href={`https://maps.google.com/?q=${r.lat},${r.lng}`} target="_blank" rel="noopener noreferrer"
            onClick={e=>e.stopPropagation()}
            style={{fontSize:14,color:"var(--sky)",textDecoration:"none"}}>📍 Map</a>}
        </div>
      ))}
    </div>
  );
}




function PhotoJournal({catches,onPhotoClick}){
  const [search,setSearch]=React.useState("");
  const withPhotos=catches.filter(c=>c.photo);
  if(withPhotos.length===0) return <div className="empty"><div className="ei">📷</div><p>No photos yet.<br/>Add a photo when logging a catch!</p></div>;
  const groups={};
  withPhotos.forEach(c=>{
    const key=c.streamGaugeName?c.streamGaugeName.split(" ").slice(0,4).join(" "):(c.gps&&c.gps!=="Location not recorded"?"Near "+c.gps.slice(0,12):"Unknown Location");
    if(!groups[key])groups[key]=[];
    groups[key].push(c);
  });
  const filtered=Object.entries(groups).filter(([k])=>!search||k.toLowerCase().includes(search.toLowerCase())||groups[k].some(c2=>(c2.species||"").toLowerCase().includes(search.toLowerCase())));
  return(
    <div>
      <div style={{marginBottom:12,display:"flex",gap:8,alignItems:"center"}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search by river or species…" style={{flex:1,background:"rgba(0,0,0,0.3)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:8,padding:"8px 12px",color:"var(--foam)",fontSize:15}}/>
        {search&&<button onClick={()=>setSearch("")} style={{background:"none",border:"none",color:"var(--stone)",cursor:"pointer",fontSize:16}}>✕</button>}
      </div>
      <div style={{fontSize:15,color:"var(--stone)",marginBottom:12}}>{withPhotos.length} photos · {Object.keys(groups).length} locations</div>
      {filtered.map(([loc,lc])=>(
        <div key={loc} style={{marginBottom:20}}>
          <div style={{fontFamily:"'Playfair Display',serif",fontSize:14,color:"var(--gold)",marginBottom:8,display:"flex",justifyContent:"space-between"}}>
            <span>🏞 {loc}</span>
            <span style={{fontSize:14,color:"var(--stone)",fontFamily:"sans-serif"}}>{lc.length} photo{lc.length>1?"s":""}</span>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:4}}>
            {lc.map((c2,i)=>(
              <div key={i} style={{position:"relative",aspectRatio:"1",overflow:"hidden",borderRadius:8,cursor:"pointer"}} onClick={()=>onPhotoClick&&onPhotoClick(c2.photo)}>
                <img src={c2.photo} alt={c2.species} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                <div style={{position:"absolute",bottom:0,left:0,right:0,background:"linear-gradient(transparent,rgba(0,0,0,0.7))",padding:"4px 6px"}}>
                  <div style={{fontSize:14,color:"white",fontFamily:"'Crimson Pro',serif"}}>{c2.species}{c2.length?" "+c2.length+'"':""}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      {filtered.length===0&&<div style={{fontSize:15,color:"var(--stone)",fontStyle:"italic",textAlign:"center",padding:20}}>No results for "{search}"</div>}
    </div>
  );
}

function CatchPatterns({catches}){
  const [view,setView]=React.useState("monthly");
  if(!catches||catches.length<3) return null;
  const MONTHS=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const monthly=Array(12).fill(0);
  catches.forEach(c=>{const d=new Date(c.time?.replace(" at "," ")||"");if(!isNaN(d))monthly[d.getMonth()]++;});
  const maxMonthly=Math.max(...monthly,1);
  const speciesCounts={};
  catches.forEach(c=>{if(c.species)speciesCounts[c.species]=(speciesCounts[c.species]||0)+1;});
  const topSpecies=Object.entries(speciesCounts).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const maxSp=topSpecies[0]?.[1]||1;
  const flyCounts={};
  catches.forEach(c=>(c.flies||[]).forEach(f=>{if(f)flyCounts[f]=(flyCounts[f]||0)+1;}));
  const topFlies=Object.entries(flyCounts).sort((a,b)=>b[1]-a[1]).slice(0,8);
  const lengthBySpecies={};
  catches.forEach(c=>{if(c.species&&c.length){const l=parseFloat(c.length);if(!isNaN(l)){if(!lengthBySpecies[c.species])lengthBySpecies[c.species]={sum:0,count:0};lengthBySpecies[c.species].sum+=l;lengthBySpecies[c.species].count++;}}});
  return(
    <div className="card">
      <div className="ctitle">📊 Catch Patterns</div>
      <div className="csub">{catches.length} catches analyzed</div>
      <div style={{display:"flex",gap:6,marginBottom:14,flexWrap:"wrap"}}>
        {[["monthly","By Month"],["species","By Species"],["flies","Top Flies"]].map(([v,l])=>(
          <button key={v} onClick={()=>setView(v)} style={{fontSize:14,padding:"4px 12px",borderRadius:20,border:"1px solid rgba(200,168,75,0.3)",background:view===v?"rgba(200,168,75,0.25)":"rgba(255,255,255,0.05)",color:view===v?"var(--gold)":"var(--stone)",cursor:"pointer"}}>{l}</button>
        ))}
      </div>
      {view==="monthly"&&(
        <div>
          <div style={{display:"flex",alignItems:"flex-end",gap:3,height:80,marginBottom:8}}>
            {monthly.map((n,i)=>(
              <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                <div style={{width:"100%",background:n>0?"linear-gradient(180deg,var(--sky),var(--water))":"rgba(255,255,255,0.06)",borderRadius:"3px 3px 0 0",height:Math.max(n/maxMonthly*70,n>0?4:2)+"px",transition:"height .4s"}}/>
                {n>0&&<span style={{fontSize:15,color:"var(--sky)"}}>{n}</span>}
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:3}}>{MONTHS.map((m,i)=><div key={i} style={{flex:1,fontSize:15,color:"var(--stone)",textAlign:"center"}}>{m}</div>)}</div>
          <div style={{marginTop:12,fontSize:15,color:"var(--stone)"}}>Best month: <span style={{color:"var(--gold)"}}>{MONTHS[monthly.indexOf(Math.max(...monthly))]}</span> · {Math.max(...monthly)} catches</div>
        </div>
      )}
      {view==="species"&&(
        <div>
          {topSpecies.map(([sp,n])=>(
            <div key={sp} style={{marginBottom:8}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                <span style={{fontSize:15,color:"var(--foam)"}}>{sp}</span>
                <span style={{fontSize:14,color:"var(--sky)"}}>{n} caught{lengthBySpecies[sp]?" · avg "+Math.round(lengthBySpecies[sp].sum/lengthBySpecies[sp].count)+'"':""}</span>
              </div>
              <div style={{height:6,background:"rgba(0,0,0,0.3)",borderRadius:3,overflow:"hidden"}}>
                <div style={{width:(n/maxSp*100)+"%",height:"100%",background:"linear-gradient(90deg,var(--sky),var(--water))",borderRadius:3,transition:"width .5s"}}/>
              </div>
            </div>
          ))}
        </div>
      )}
      {view==="flies"&&(
        <div>
          {topFlies.length===0&&<div style={{fontSize:15,color:"var(--stone)",fontStyle:"italic"}}>No fly data recorded yet.</div>}
          {topFlies.map(([fly,n],i)=>(
            <div key={fly} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 0",borderBottom:i<topFlies.length-1?"1px solid rgba(255,255,255,0.06)":"none"}}>
              <a href={"https://www.google.com/search?q="+encodeURIComponent(fly+" fly pattern")+"&tbm=isch"} target="_blank" rel="noreferrer" style={{fontSize:15,color:"var(--sky)",textDecoration:"none"}}>🪶 {fly}</a>
              <span style={{fontSize:14,color:"var(--stone)"}}>{n}x</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GaugeCard({gauges,gaugeLoading,gaugeError,lastUpd,onRefresh,isStarred,toggleStar,showStarredOnly,setShowStarredOnly}){
  const [open,setOpen]=useState(true);
  return(
    <div className="card">
      <div className="ctitle" style={{cursor:"pointer",userSelect:"none"}} onClick={()=>setOpen(o=>!o)}>
        💧 Stream Gauges
        <span style={{fontSize:15,color:"var(--stone)",marginLeft:8,fontFamily:"sans-serif"}}>{open?"▲ collapse":"▼ expand"}</span>
        <button className="rfsh" onClick={e=>{e.stopPropagation();onRefresh();}}>↻</button>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
        <div className="csub" style={{margin:0}}>Live USGS · {gauges.length} gauges{lastUpd&&" · "+lastUpd}</div>
        {gauges.length>0&&<button onClick={()=>setShowStarredOnly&&setShowStarredOnly(v=>!v)} style={{fontSize:14,background:showStarredOnly?"rgba(200,168,75,0.3)":"rgba(255,255,255,0.06)",border:"1px solid rgba(200,168,75,0.3)",borderRadius:20,padding:"3px 10px",color:showStarredOnly?"var(--gold)":"var(--stone)",cursor:"pointer"}}>
          {showStarredOnly?"⭐ Starred":"☆ All"}
        </button>}
      </div>
      {gaugeLoading&&<div className="loading">Loading gauges…</div>}
      {gaugeError&&!gaugeLoading&&<div className="err">{gaugeError}</div>}
      {open&&!gaugeLoading&&<GaugeList gauges={gauges} isStarred={isStarred||null} toggleStar={toggleStar||null} showStarredOnly={showStarredOnly||false}/>}
      {!open&&!gaugeLoading&&gauges.length>0&&(
        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:8}}>
          {gauges.slice(0,5).map((g,i)=>(
            <span key={i} style={{fontSize:14,background:"rgba(255,255,255,0.06)",borderRadius:20,padding:"3px 10px",color:"var(--stone)"}}>
              {(g.name||"").split(" ").slice(0,3).join(" ")} · {Math.round(g.cfs||0)} CFS
            </span>
          ))}
          {gauges.length>5&&<span style={{fontSize:14,color:"var(--stone)",padding:"3px 6px"}}>+{gauges.length-5} more</span>}
        </div>
      )}
    </div>
  );
}

function SavedGaugesList({savedGauges,showAddGauge,setShowAddGauge,gaugeInput,setGaugeInput,gaugeAdding,addSavedGauge,removeSavedGauge,fetchSavedGaugeData,cfsLabel}){
  const [sgData,setSgData]=useState([]);
  const [expanded,setExpanded]=useState(null);
  useEffect(()=>{
    if(!savedGauges.length) return;
    Promise.all(savedGauges.map(g=>fetchSavedGaugeData(g))).then(setSgData).catch(()=>{});
  },[savedGauges.length]);
  return(
    <div className="card" style={{marginBottom:12}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
        <span style={{fontSize:15,color:"var(--gold)",fontFamily:"'Playfair Display',serif"}}>⭐ My Gauges</span>
        <button onClick={()=>setShowAddGauge(v=>!v)} style={{fontSize:14,background:"rgba(200,168,75,0.2)",border:"1px solid rgba(200,168,75,0.4)",borderRadius:20,padding:"3px 10px",color:"var(--gold)",cursor:"pointer"}}>+ Add</button>
      </div>
      {showAddGauge&&(
        <div style={{display:"flex",gap:6,marginBottom:10}}>

        </div>
      )}
      {sgData.map((g,i)=>(
        <div key={i} style={{borderBottom:i<sgData.length-1?"1px solid rgba(255,255,255,0.06)":"none"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",cursor:"pointer"}} onClick={()=>setExpanded(expanded===i?null:i)}>
          <div>
            <div style={{fontSize:15,color:"var(--foam)"}}>{g.name||g.site_no}</div>
            <div style={{fontSize:15,color:"var(--stone)",marginTop:2}}>{g.cfs!=null?g.cfs.toLocaleString()+" CFS":"Loading…"}</div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            {g.cfs!=null&&<span className={"gbadge "+g.cls}>{g.label}</span>}
            <button onClick={e=>{e.stopPropagation();removeSavedGauge(g.id);}} style={{background:"none",border:"none",color:"var(--stone)",cursor:"pointer",fontSize:14,padding:4}}>✕</button>
            <span style={{fontSize:14,color:"var(--stone)",marginLeft:4}}>{expanded===i?"▲":"▼"}</span>
          </div>
        </div>
        {expanded===i&&g.site_no&&<GaugeChart siteNo={g.site_no} siteName={g.name} initialCFS={g.cfs}/>}
        </div>
      ))}
    </div>
  );
}

function App({user}){
  const [tab,setTab]=useState("conditions");
  const [addOpen,setAddOpen]=useState(false);
  const [editingCatchId,setEditingCatchId]=useState(null);
  const [editingTripCatchIdx,setEditingTripCatchIdx]=useState(null);
  const [lightboxPhoto,setLightboxPhoto]=useState(null);
  useEffect(()=>{
    window._setLightbox=setLightboxPhoto;
    return()=>{window._setLightbox=null;};
  },[setLightboxPhoto]);


  // Lightbox via DOM - avoids JSX nesting issues
  useEffect(()=>{
    if(!lightboxPhoto){
      const el=document.getElementById("gc-lightbox");
      if(el) el.remove();
      return;
    }
    let el=document.getElementById("gc-lightbox");
    if(!el){
      el=document.createElement("div");
      el.id="gc-lightbox";
      document.body.appendChild(el);
    }
    el.style.cssText="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.97);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:pointer;";
    el.innerHTML='<img src="'+lightboxPhoto+'" style="max-width:100vw;max-height:100vh;object-fit:contain;display:block;" alt="catch"/><button style="position:fixed;top:20px;right:20px;background:rgba(255,255,255,0.2);border:none;color:white;border-radius:50%;width:44px;height:44px;font-size:22px;cursor:pointer;display:flex;align-items:center;justify-content:center;">✕</button>';
    el.onclick=(e)=>{ setLightboxPhoto(null); };
    return()=>{ const el2=document.getElementById("gc-lightbox"); if(el2) el2.remove(); };
  },[lightboxPhoto]);
  // Init loc from localStorage so Guide tab has it immediately
  const [loc,setLoc]=useState(()=>{try{const s=localStorage.getItem("tl_loc");return s?JSON.parse(s):null;}catch{return null;}});
  const [weather,setWeather]=useState(null);
  const [wxLoading,setWxLoading]=useState(false);
  // Auto-detect user location on every load (cached loc shows immediately, then refreshes)
  useEffect(()=>{
    if(!navigator.geolocation) return;
    setLocating(true);
    setLocating(true);
    navigator.geolocation.getCurrentPosition(async pos=>{
      const{latitude:lat,longitude:lng}=pos.coords;
      try{
        const rr=await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`,{headers:{"Accept-Language":"en"}});
        const d=await rr.json();
        const a=d.address||{};
        const city=a.city||a.town||a.village||a.hamlet||a.suburb||a.county||"";
        const state=a.state_code||a.state||"";
        const label=city&&state?`${city}, ${state}`:city||(state||`${lat.toFixed(2)}, ${lng.toFixed(2)}`);
        loadConditions({lat,lng,label});setLocating(false);
      }catch{loadConditions({lat,lng,label:`${lat.toFixed(2)}, ${lng.toFixed(2)}`});setLocating(false);}
    },()=>{setLocating(false);},{timeout:8000});
  },[]);
  useEffect(()=>{
    const savedRaw=localStorage.getItem("tl_loc");
    if(!savedRaw) return;
    try{const s=JSON.parse(savedRaw);if(s?.lat&&s?.lng)loadConditions(s,true);}catch{}
  },[]);
  const [wxError,setWxError]=useState(null);
  const [wxForecast,setWxForecast]=useState(null);
  const [gauges,setGauges]=useState([]);
  const [gaugeLoading,setGaugeLoading]=useState(false);
  const [gaugeError,setGaugeError]=useState(null);
  const [lastUpd,setLastUpd]=useState(null);
  const [catches,setCatches]=useState([]);
  const [catchesLoading,setCatchesLoading]=useState(true);
  const [catchLogTab,setCatchLogTab]=useState("list");
  const [enriching,setEnriching]=useState(false);
  const [batchProgress,setBatchProgress]=useState(null);
  const encKeyRef=React.useRef(null);
  const lastCatchIdRef=React.useRef(null);
  React.useEffect(()=>{if(user?.id)getOrCreateKey(user.id).then(k=>encKeyRef.current=k);},[user?.id]);
  const [catchSummary,setCatchSummary]=useState(null);
  const [summaryLoading,setSummaryLoading]=useState(false);

  // Load catches from Supabase on mount
  useEffect(()=>{
    if(!user) return;
    if(!sb){ setCatchesLoading(false); return; }
    sb.from("catches").select("*").eq("user_id",user.id).order("created_at",{ascending:false})
      .then(async({data,error})=>{
        if(!error&&data){
          const key=await getOrCreateKey(user.id);
          const rows=await Promise.all(data.map(async r=>({
            id:r.id,species:r.species||"",length:r.length!=null?String(r.length):"",flies:r.flies||[],photo:r.photo,
            gps:r.gps?.startsWith("ENC:")?await Promise.race([decryptGPS(r.gps,key),new Promise(res=>setTimeout(()=>res(r.gps),3000))]):r.gps,
            time:r.time,notes:r.notes,airTemp:r.air_temp!=null?String(r.air_temp):"",
            weatherDesc:r.weather_desc||"",windSpeed:r.wind_speed!=null?String(r.wind_speed):"",
            windDir:r.wind_dir||"",pressure:r.pressure!=null?String(r.pressure):"",
            streamCFS:r.stream_cfs!=null?String(r.stream_cfs):"",
            streamCondition:r.stream_condition||"",streamGaugeName:r.stream_gauge_name||"",
            waterTemp:r.water_temp!=null?String(r.water_temp):""
          })));
          setCatches(rows);window._catches=rows;
        }
        setCatchesLoading(false);
      });
  },[user]);

  async function updateCatch(id, updates){
    setCatches(cs=>cs.map(c=>c.id===id?{...c,...updates}:c));
    if(!sb||String(id).startsWith("local")) return;
    try{
      await sb.from("catches").update({
        species:updates.species, length:updates.length, flies:updates.flies,
        notes:updates.notes, gps:updates.gps, time:updates.time,
        air_temp:updates.airTemp, weather_desc:updates.weatherDesc,
        wind_speed:updates.windSpeed, wind_dir:updates.windDir,
        pressure:updates.pressure, stream_cfs:updates.streamCFS,
        stream_condition:updates.streamCondition, stream_gauge_name:updates.streamGaugeName, water_temp:updates.waterTemp
      }).eq("id",id);
    }catch(e){ void 0; }
  }

  async function syncOfflineCatches(){
    if(!sb||!user) return;
    const queue=JSON.parse(localStorage.getItem('tl_sync_queue')||'[]');
    if(!queue.length) return;
    const remaining=[];
    for(const item of queue){
      try{
        // Auto-fill conditions from cached data at catch time if missing
        const cached=JSON.parse(localStorage.getItem('tl_cached_conditions')||'{}');
        if(cached.weather&&!item.air_temp) item.air_temp=String(cached.weather.temp);
        if(cached.weather&&!item.weather_desc) item.weather_desc=cached.weather.desc;
        if(cached.gauges?.length&&!item.stream_cfs){
          const g=cached.gauges[0];
          item.stream_cfs=String(Math.round(g.cfs||0));
          item.stream_condition=g.label||"";
          item.stream_gauge_name=g.name||"";
          if(g.waterTempF) item.water_temp=String(g.waterTempF);
        }
        const{data,error}=await sb.from('catches').insert({user_id:user.id,...item}).select().single();
        if(!error&&data){
          // Update local catch with real id and remove pending flag
          setCatches(cs=>cs.map(c2=>c2._offlineId===item._offlineId?{...c2,id:data.id,_pending:false,_offlineId:undefined}:c2));
        } else {
          remaining.push(item);
        }
      }catch{remaining.push(item);}
    }
    localStorage.setItem('tl_sync_queue',JSON.stringify(remaining));
    setSyncQueue(remaining);
  }

  async function enrichCatches(){
    if(!catches.length||enriching) return;
    setEnriching(true);
    let updated=0;
    // Fish ID for catches with photos but no length
    const toID=catches.filter(c2=>c2.photo&&!c2.length&&!c2._pending).slice(0,5);
    void 0;
    for(const catch2 of toID){
      try{
        let base64=null;
        const mediaType="image/jpeg";
        try{
          let dataUrl=null;
          if(catch2.photo?.startsWith("data:")){dataUrl=catch2.photo;}
          else if(catch2.photo?.startsWith("http")){
            const imgRes=await fetch(catch2.photo);
            const blob=await imgRes.blob();
            dataUrl=await new Promise(res=>{const r=new FileReader();r.onload=e=>res(e.target.result);r.readAsDataURL(blob);});
          }
          if(!dataUrl) continue;
          // Resize to max 800px
          const img=await new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=dataUrl;});
          const canvas=document.createElement("canvas");
          const max=800;
          const scale=Math.min(1,max/Math.max(img.width,img.height));
          canvas.width=Math.round(img.width*scale);
          canvas.height=Math.round(img.height*scale);
          canvas.getContext("2d").drawImage(img,0,0,canvas.width,canvas.height);
          base64=canvas.toDataURL("image/jpeg",0.7).split(",")[1];
        }catch(fetchErr){void 0;continue;}
        if(!base64) continue;
        const res=await fetch("/api/claude",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:150,messages:[{role:"user",content:[{type:"image",source:{type:"base64",media_type:mediaType,data:base64}},{type:"text",text:"Look carefully at this fish photo. Identify the exact species based on coloring, spot patterns, and body shape. Rainbow trout have pink/red lateral stripe and black spots. Brown trout have brown/golden coloring with red spots. Cutthroat trout have red slash marks under jaw. Choose from: "+SPECIES.join(", ")+". Estimate length in inches if a hand or scale is visible for reference. Reply ONLY with JSON: {\"species\":\"Rainbow Trout\",\"length\":14}. Use null for length if unknown."}]}]})});
        const rd=await res.json();
        const txt=((rd.content||[])[0]?.text||"{}").replace(/```json|```/g,"").trim();
        void 0;
        const parsed=JSON.parse(txt);
        void 0;
        if(parsed.species&&parsed.species!=="Unidentified"){
          await updateCatch(catch2.id,{species:parsed.species,length:parsed.length!=null?String(Math.round(parsed.length)):catch2.length});
          updated++;
        }
      }catch(idErr){void 0;}
    }
    const toEnrich=catches.filter(c2=>!c2.streamCFS&&c2.gps&&c2.gps!=="Location not recorded");
    void 0;
    for(const catch2 of toEnrich){
      if(catch2.streamCFS||!catch2.gps) continue;
      const gpsStr=catch2.gps||"";
      let lat=null,lng=null;
      // Try "39.9691°N, 106.3642°W" format
      const dmsMatch=gpsStr.match(/([\d.]+)[°\s]*([NS])[\s,]+([\d.]+)[°\s]*([EW])/i);
      if(dmsMatch){lat=parseFloat(dmsMatch[1])*(dmsMatch[2].toUpperCase()==="S"?-1:1);lng=parseFloat(dmsMatch[3])*(dmsMatch[4].toUpperCase()==="W"?-1:1);}
      else{const nums=gpsStr.match(/-?[\d.]+/g);if(nums&&nums.length>=2){lat=parseFloat(nums[0]);lng=parseFloat(nums[1]);}}
      if(!lat||!lng||isNaN(lat)||isNaN(lng)) continue;
      if(isNaN(lat)||isNaN(lng)) continue;
      try{
        const d=new Date((catch2.time||"").replace(" at "," "));
        const dateStr=!isNaN(d)?d.toISOString().split("T")[0]:null;
        if(!dateStr) continue;
        const conds=await fetchHistoricalConditions(lat,lng,dateStr,"12");
        if(conds.streamCFS){
          await updateCatch(catch2.id,{streamCFS:conds.streamCFS,streamCondition:conds.streamCondition,streamGaugeName:conds.streamGaugeName,airTemp:conds.airTemp||catch2.airTemp,weatherDesc:conds.weatherDesc||catch2.weatherDesc});
          updated++;
        }
      }catch{}
    }
    setEnriching(false);
    if(updated>0) alert(updated+" catches updated!");
    else alert("All catches are up to date.");
  }

  async function addCatch(catchData){
    // Upload photo to storage first, fall back to null if it fails
    if(catchData.photo&&catchData.photo.startsWith("data:")){
      const url=await uploadPhotoToStorage(catchData.photo,"catches");
      catchData={...catchData,photo:url||null}; // don't store huge base64 in DB
    }
    if(!sb||!isOnline){
      // Offline — save to queue and show immediately with pending badge
      const offlineId="offline-"+Date.now();
      const offlineItem={...catchData,_offlineId:offlineId,_pending:true,id:offlineId};
      setCatches(cs=>[offlineItem,...cs]);
      const queue=JSON.parse(localStorage.getItem('tl_sync_queue')||'[]');
      queue.push({...catchData,_offlineId:offlineId});
      localStorage.setItem('tl_sync_queue',JSON.stringify(queue));
      setSyncQueue(queue);
      return;
    }
    const{data,error}=await sb.from("catches").insert({user_id:user.id,...catchData}).select().single();
    if(error){
      alert("Catch save failed: "+error.message);
    } else if(data){
      setCatches(c=>[{...catchData,id:data.id},...c]);
      return data.id;
    }
  }

  async function deleteCatch(id){
    if(sb) await sb.from("catches").delete().eq("id",id);
    setCatches(cs=>cs.filter(x=>x.id!==id));
  }
  const blank={species:"Brown Trout",length:"",flies:[],flyInput:"",notes:"",photo:null,gps:null,time:null,waterTemp:""};
  const [form,setForm]=useState(blank);
  const camRef=useRef(),galRef=useRef();

  const [savedGauges,setSavedGauges]=useState([]);
  const [showStarredOnly,setShowStarredOnly]=useState(false);
  const [showAddGauge,setShowAddGauge]=useState(false);
  const [gaugeInput,setGaugeInput]=useState("");
  const [gaugeAdding,setGaugeAdding]=useState(false);
  const [condShops,setCondShops]=useState([]);
  const [condShopsLoading,setCondShopsLoading]=useState(false);
  const condShopsCacheRef=React.useRef({});
  const [condReport,setCondReport]=useState(null);
  const [intelTab,setIntelTab]=useState("weather");
  const [locating,setLocating]=useState(true);
  const [hatchAutoRun,setHatchAutoRun]=useState(false);
  const [hatchResult,setHatchResult]=useState(null);
  const [hatchLoading,setHatchLoading]=useState(false);
  const [condReportLoading,setCondReportLoading]=useState(false);
  const [isOnline,setIsOnline]=useState(navigator.onLine);
  const [syncQueue,setSyncQueue]=useState(()=>{try{return JSON.parse(localStorage.getItem('tl_sync_queue')||'[]');}catch{return[];}});

  // Listen for online/offline events
  useEffect(()=>{
    const goOnline=()=>{setIsOnline(true);syncOfflineCatches();enrichCatches&&enrichCatches();};
    const goOffline=()=>setIsOnline(false);
    window.addEventListener('online',goOnline);
    window.addEventListener('offline',goOffline);
    return()=>{window.removeEventListener('online',goOnline);window.removeEventListener('offline',goOffline);};
  },[]);

  // Cache conditions to localStorage when loaded
  useEffect(()=>{
    if(weather&&loc){
      try{localStorage.setItem('tl_cached_conditions',JSON.stringify({weather,gauges,loc,cachedAt:Date.now()}));}catch{}
    }
  },[weather,gauges]);

  // Load saved gauges from Supabase
  useEffect(()=>{
    if(!sb||!user||String(user.id).startsWith("local")) return;
    sb.from("saved_gauges").select("*").eq("user_id",user.id).then(({data,error})=>{
      if(data) setSavedGauges(data);
      if(error) void 0;
    }).catch(()=>{});
  },[user?.id]);

  async function fetchSavedGaugeData(gauge){
    try{
      var siteNo=gauge.site_no;
      if(!siteNo&&gauge.url){
        var m=gauge.url.match(/sites?[=\/]([0-9]{8,})/i);
        if(m) siteNo=m[1];
      }
      if(!siteNo) return {...gauge,cfs:null,label:"NO DATA",cls:"nodata"};
      // Add 8s timeout so it doesn't hang forever
      var controller=new AbortController();
      var timer=setTimeout(()=>controller.abort(),8000);
      var r=await fetch("https://waterservices.usgs.gov/nwis/iv/?format=json&sites="+siteNo+"&parameterCd=00060",{signal:controller.signal});
      clearTimeout(timer);
      if(!r.ok) return {...gauge,cfs:null,label:"NO DATA",cls:"nodata"};
      var d=await r.json();
      var ts=(d.value&&d.value.timeSeries)||[];
      if(!ts.length) return {...gauge,cfs:null,label:"NO DATA",cls:"nodata"};
      var raw=ts[0].values&&ts[0].values[0]&&ts[0].values[0].value&&ts[0].values[0].value[0]&&ts[0].values[0].value[0].value;
      var cfs=raw!=null?parseFloat(raw):null;
      var name=(ts[0].sourceInfo&&ts[0].sourceInfo.siteName)||gauge.name;
      var lbl=cfsLabel(cfs,null);
      return{...gauge,cfs,label:lbl.label,cls:lbl.cls,name};
    }catch(e){return {...gauge,cfs:null,label:"NO DATA",cls:"nodata"};}
  }

  async function addSavedGauge(){
    if(!gaugeInput.trim()) return;
    setGaugeAdding(true);
    // Extract site number from USGS URL or treat as site number directly
    var url=gaugeInput.trim();
    var siteNo=null;
    var m=url.match(/sites?[=\/]([0-9]{8,})/i)||url.match(/monitoring-location\/USGS-([0-9]+)/i)||url.match(/^([0-9]{8,15})$/);
    if(m) siteNo=m[1];
    if(!siteNo){setGaugeAdding(false);alert("Please enter a USGS site number or URL from waterdata.usgs.gov");return;}
    // Fetch name from USGS
    var name="Custom Gauge";
    try{
      var r=await fetch("https://waterservices.usgs.gov/nwis/iv/?format=json&sites="+siteNo+"&parameterCd=00060");
      if(r.ok){var d=await r.json();var ts=(d.value&&d.value.timeSeries)||[];if(ts.length) name=ts[0].sourceInfo&&ts[0].sourceInfo.siteName||name;}
    }catch(e){}
    var newGauge={user_id:user.id,site_no:siteNo,name:name,url:url};
    if(sb&&!String(user.id).startsWith("local")){
      var{data}=await sb.from("saved_gauges").insert(newGauge).select().single();
      if(data) setSavedGauges(gs=>[...gs,data]);
    } else {
      setSavedGauges(gs=>[...gs,{...newGauge,id:"local-"+Date.now()}]);
    }
    setGaugeInput("");setShowAddGauge(false);setGaugeAdding(false);
  }

  function isStarred(siteNo){return savedGauges.some(g=>g.site_no===siteNo);}
  async function toggleStar(gauge){
    if(isStarred(gauge.siteNo)){
      const g=savedGauges.find(s=>s.site_no===gauge.siteNo);
      if(g) removeSavedGauge(g.id);
    } else {
      const newG={user_id:user?.id,site_no:gauge.siteNo,name:gauge.name,url:"https://waterdata.usgs.gov/monitoring-location/"+gauge.siteNo+"/"};
      if(sb&&user&&!String(user.id).startsWith("local")){
        const{data}=await sb.from("saved_gauges").insert(newG).select().single();
        if(data) setSavedGauges(gs=>[...gs,data]);
      } else {
        setSavedGauges(gs=>[...gs,{...newG,id:"local-"+Date.now()}]);
      }
    }
  }

  async function removeSavedGauge(id){
    setSavedGauges(gs=>gs.filter(g=>g.id!==id));
    if(sb&&!String(user.id).startsWith("local")) await sb.from("saved_gauges").delete().eq("id",id);
  }

  async function generateCondReport(loc, weather, gauges){
    if(!loc||!weather) return;
    setCondReportLoading(true);
    try{
      const gaugeInfo=(gauges||[]).slice(0,5).map(g=>`${g.name}: ${Math.round(g.cfs||0)} CFS (${g.label||""})`).join(", ");
      const prompt=`You are a local fly fishing guide for ${loc.label}. Location: ${loc.label}. Weather: ${weather.temp}°F, ${weather.desc}, wind ${weather.wind}mph ${weather.windDir}, pressure ${weather.pressure}" (${weather.pressureTrend?.label}). Nearby streams with live flow data: ${gaugeInfo||"no gauge data"}. Month: ${new Date().toLocaleString("en-US",{month:"long"})}. Write a 2-3 paragraph fly fishing conditions report SPECIFIC to ${loc.label} - use only insects, hatches, and techniques known to this exact region. Do not generalize from other areas. Cover: how current flows and weather affect fishing today, which specific local waters are fishing best right now, and hyper-local fly recommendations based on what is actually hatching here this time of year. Plain text only.`;
      const res=await fetch("/api/claude",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
        model:"claude-sonnet-4-6",max_tokens:600,
        messages:[{role:"user",content:prompt}]
      })});
      const d=await res.json();
      const txt=(d.content||[]).map(b=>b.text||"").filter(Boolean).join("");
      if(txt) setCondReport(txt.replace(/<cite[^>]*>|<\/cite>/g,""));
    }catch(e){void 0;}
    setCondReportLoading(false);
  }

    async function fetchCondShops(label, lat, lng){
    if(!label) return;
    const cacheKey="tl_shops_p2_"+label.replace(/[^a-z0-9]/gi,"_").toLowerCase();
    try{const cached=localStorage.getItem(cacheKey);if(cached){const{data,ts}=JSON.parse(cached);if(Date.now()-ts<7*24*60*60*1000){condShopsCacheRef.current[label]=data;setCondShops(data);return;}}}catch{}
    if(condShopsCacheRef.current[label]){setCondShops(condShopsCacheRef.current[label]);return;}
    if(window._shopsInflight===label)return;
    window._shopsInflight=label;
    setCondShopsLoading(true);
    setCondShops([]);
    let diag="";
    // 1) Google Places: accurate, fast, deterministic. Failures report their reason.
    if(lat&&lng){
      try{
        const pr=await fetch('/api/claude',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({places:true,lat,lng})});
        const pd=await pr.json();
        if(pd.shops&&pd.shops.length){
          let shops=pd.shops.slice(0,10);
          // Curate to true retail fly shops; on any failure the full list shows (never blank)
          try{
            const ft=await askClaude("You are a fly fishing industry expert. From this JSON list of fly-fishing businesses near "+label+", return ONLY the true RETAIL fly shops where an angler can walk in and buy flies and tackle. EXCLUDE manufacturers, brand headquarters, wholesalers, and rafting/boating equipment stores (for example, Umpqua Feather Merchants is a manufacturer, not a retail shop). Keep each kept item's fields exactly as given, same order. Return ONLY a JSON array, no markdown: "+JSON.stringify(shops),false,1400);
            const fp=parseShopArray(ft);
            if(fp&&fp.length>=2)shops=fp.slice(0,8);
          }catch(e){}
          condShopsCacheRef.current[label]=shops;
          try{localStorage.setItem(cacheKey,JSON.stringify({data:shops,ts:Date.now()}));}catch{}
          setCondShops(shops);setCondShopsLoading(false);window._shopsInflight=null;return;
        }
        if(pd.placesError)diag=String(pd.placesError).slice(0,160);
      }catch(e){diag=e.message;}
    }
    // 2) OpenStreetMap fallback: the code that produced this morning's lists. Not cached, so Places takes over once healthy.
    if(lat&&lng){
      try{
        const q='[out:json][timeout:8];(node["shop"="fishing"](around:48000,'+lat+','+lng+');way["shop"="fishing"](around:48000,'+lat+','+lng+'););out center 12;';
        const or=await fetch("https://overpass-api.de/api/interpreter",{method:"POST",body:"data="+encodeURIComponent(q)});
        if(or.ok){
          const od=await or.json();
          const shops=(od.elements||[]).map(el=>{const t=el.tags||{};const elat=el.lat||(el.center&&el.center.lat),elng=el.lon||(el.center&&el.center.lon);const dist=(elat&&elng)?Math.round(Math.sqrt(Math.pow(elat-lat,2)+Math.pow(elng-lng,2))*69):0;return{name:t.name||"",address:[t["addr:housenumber"],t["addr:street"]].filter(Boolean).join(" "),city:t["addr:city"]||"",state:t["addr:state"]||"",phone:t.phone||t["contact:phone"]||"",website:t.website||t["contact:website"]||("https://www.google.com/maps/search/?api=1&query="+elat+","+elng),distanceMiles:dist};}).filter(s=>s.name).sort((a,b)=>a.distanceMiles-b.distanceMiles).slice(0,10);
          if(shops.length){
            if(diag)shops.push({name:"(Shop search diagnostic)",address:"",city:"",state:"",phone:"",website:"",specialty:diag,distanceMiles:0});
            setCondShops(shops);setCondShopsLoading(false);window._shopsInflight=null;return;
          }
        }
      }catch(e){}
    }
    window._shopsInflight=null;
    setCondShops([{name:'Search Google Maps',address:'',city:'',state:'',phone:'',website:'https://www.google.com/maps/search/fly+fishing+shop+near+'+encodeURIComponent(label),specialty:diag||('Tap to search near '+label),distanceMiles:0}]);
    setCondShopsLoading(false);
  }

  async function loadConditions(newLoc, preWarm=false){
    setLoc(newLoc);
    try{localStorage.setItem("tl_loc",JSON.stringify({lat:newLoc.lat,lng:newLoc.lng,label:newLoc.label}));}catch{}
    const{lat,lng}=newLoc;
    setWxLoading(true);setWxError(null);setCondReport(null);setGaugeLoading(true);setGaugeError(null);
    // Check localStorage for cached weather to show instantly
    try{const cachedWx=localStorage.getItem("tl_wx_"+lat.toFixed(2)+"_"+lng.toFixed(2));if(cachedWx){const{data,ts}=JSON.parse(cachedWx);if(Date.now()-ts<30*60*1000){const c2=data.current;const pressureInHg=(c2.surface_pressure*0.02953).toFixed(2);const trend=pressureTrend(parseFloat(pressureInHg),null);setWeather({temp:Math.round(c2.temperature_2m),humidity:c2.relative_humidity_2m,wind:Math.round(c2.wind_speed_10m),windDir:windDir(c2.wind_direction_10m),pressure:pressureInHg,pressureTrend:trend,pressureNote:fishingPressureNote(pressureInHg),uv:Math.round(c2.uv_index??0),desc:`${WX_EMOJI[c2.weather_code]||""} ${WX_DESC[c2.weather_code]||""}`.trim()});setWxForecast(data);setWxLoading(false);}}}catch{}
    // GAUGE CACHE — show instantly if fresh (<30 min), refresh silently in background
    const gaugeKey="tl_gauges_"+lat.toFixed(2)+"_"+lng.toFixed(2);
    let gaugeFromCache=false;
    try{const cg=localStorage.getItem(gaugeKey);if(cg){const{data:cgData,ts:cgTs}=JSON.parse(cg);if(Date.now()-cgTs<30*60*1000&&Array.isArray(cgData)&&cgData.length>0){setGauges(cgData);window._loadedGauges=cgData;setLastUpd(new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}));setGaugeLoading(false);gaugeFromCache=true;}}}catch{}
    // WEATHER — fires independently, paints immediately without waiting on USGS
    fetchWeather(lat,lng).then(d=>{
      try{
        const c=d.current;
        const pressureInHg=(c.surface_pressure*0.02953).toFixed(2);
        const prevPressure=wxForecast?.current?.surface_pressure?(wxForecast.current.surface_pressure*0.02953):null;
        const trend=pressureTrend(parseFloat(pressureInHg), prevPressure);
        setWeather({temp:Math.round(c.temperature_2m),humidity:c.relative_humidity_2m,wind:Math.round(c.wind_speed_10m),windDir:windDir(c.wind_direction_10m),pressure:pressureInHg,pressureTrend:trend,pressureNote:fishingPressureNote(pressureInHg),uv:Math.round(c.uv_index??0),desc:`${WX_EMOJI[c.weather_code]||""} ${WX_DESC[c.weather_code]||""}`.trim()});
        setWxForecast(d);try{localStorage.setItem("tl_wx_"+lat.toFixed(2)+"_"+lng.toFixed(2),JSON.stringify({data:d,ts:Date.now()}));}catch{}
      }catch{setWxError("Weather unavailable.");}finally{setWxLoading(false);}
    }).catch(()=>{setWxError("Weather unavailable.");setWxLoading(false);});
    // GAUGES — shared helper: parse USGS response, set state, cache, patch temps
    const applyGaugeData=async(usgsD,silent)=>{
      try{
        const ts=usgsD.value?.timeSeries??[];
        if(!ts.length){if(!silent)setGaugeError("No gauges found.");return;}
        const NON_FISHABLE=["canal","ditch","drain","diversion","lateral","irrigation","pipeline","tunnel","aqueduct","municipal","effluent","waste","sewage","outfall","reservoir","lake","pond","inlet","outlet","tailrace","headgate","bypass","flume","return","delivery","main","supply","project","district","gage","index","well","spring","seep","nuclear","superfund","buffer zone"," rfp","landfill"," plant","facility","treatment"];
        const isFishable=name=>{
          const n=name.toLowerCase();
          const splitWords=["near ","at ","below ","above "," nr "," abv "," ab "," bl "];
          var streamPart=n;for(var si=0;si<splitWords.length;si++){var si2=n.indexOf(splitWords[si]);if(si2>5){streamPart=n.substring(0,si2);break;}}
          const waterWords=["creek","river","brook"," run"," fork","branch","stream","slough","gulch","canyon","bayou","kill"," rio "," cr"," ck"," fk"];
          const hasWaterword=waterWords.some(function(w){return n.indexOf(w)!==-1;});
          const hasNonFishable=NON_FISHABLE.some(function(kw){return streamPart.indexOf(kw)!==-1;});
          return hasWaterword&&!hasNonFishable;
        };
        const rawParsed=ts.map(t=>{
          const raw=t.values?.[0]?.value?.[0]?.value;const cfs=raw!=null?parseFloat(raw):null;
          const{label,cls}=cfsLabel(cfs);
          const siteNo=(t.sourceInfo?.siteCode?.[0]?.value)||"";
          const siteLat=parseFloat(t.sourceInfo?.geoLocation?.geogLocation?.latitude||0);
          const siteLng=parseFloat(t.sourceInfo?.geoLocation?.geogLocation?.longitude||0);
          const dist=Math.sqrt(Math.pow(siteLat-lat,2)+Math.pow(siteLng-lng,2));
          const name=t.sourceInfo?.siteName??"Unknown";
          const distMi=Math.round(dist*69);
          return{name,cfs,label,cls,siteNo,dist,distMi,lat:siteLat,lng:siteLng,fishable:isFishable(name)};
        }).filter(s=>s.fishable&&s.cfs!==null&&s.cfs>=0&&s.cfs<500000&&s.distMi<=50)
          .sort((a,b)=>b.cfs-a.cfs).slice(0,25);
        const maxCFS=Math.max(...rawParsed.map(x=>x.cfs||0),1);
        const parsed=rawParsed.map(g=>{
          const pct=g.cfs!=null?Math.min(Math.round((g.cfs/maxCFS)*95),100):0;
          const{label,cls}=cfsLabel(g.cfs,null);
          return{...g,pct,histMax:null,waterTempF:null,label,cls};
        });
        setGauges(parsed);window._loadedGauges=parsed;if(window._recomputeHatches)window._recomputeHatches();
        setLastUpd(new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}));
        try{localStorage.setItem(gaugeKey,JSON.stringify({data:parsed,ts:Date.now()}));}catch{}
        fetchUSGSTempBatch(parsed.map(g=>g.siteNo)).then(tempMap=>{
          const withTemp=parsed.map(g=>({...g,waterTempF:(tempMap[g.siteNo]!=null?tempMap[g.siteNo]:null)}));
          setGauges(withTemp);window._loadedGauges=withTemp;if(window._recomputeHatches)window._recomputeHatches();
        }).catch(()=>{});
      }catch{if(!silent)setGaugeError("Could not load stream data.");}
      finally{if(!silent)setGaugeLoading(false);}
    };
    if(!gaugeFromCache){
      try{
        const usgsD=await Promise.race([fetchUSGSLive(lat,lng),new Promise(r=>setTimeout(()=>r(null),9000))]);
        if(usgsD===null){setGaugeError("Streams loading slowly \u2014 tap \u21bb to refresh");setGaugeLoading(false);}
        else await applyGaugeData(usgsD,false);
      }catch{setGaugeError("Could not load stream data.");setGaugeLoading(false);}
    } else {
      fetchUSGSLive(lat,lng).then(usgsD=>applyGaugeData(usgsD,true)).catch(()=>{});
    }
    // Hatches: deterministic prediction from live local conditions (instant, recomputes when water temps land)
    {
      if(newLoc.label) fetchCondShops(newLoc.label, newLoc.lat, newLoc.lng);
      setHatchAutoRun(true);
      window._recomputeHatches=()=>{
        const gl=window._loadedGauges||[];
        const nearTG=gl.filter(g=>g.waterTempF&&(g.dist==null||g.dist<=20)).find(g=>g.waterTempF)||null;
        const wTemp=nearTG?.waterTempF||null;
        const maxCfs=gl.reduce((m,g)=>Math.max(m,g.cfs||0),0);
        setHatchResult(predictHatches({month:new Date().getMonth()+1,waterTempF:wTemp,lng:newLoc.lng!=null?newLoc.lng:null,maxCfs,tempGaugeName:nearTG?.name||null}));
        setHatchLoading(false);
      };
      window._recomputeHatches();
    }
  }

  async function handlePhoto(e){
    const files=Array.from(e.target.files||[]);
    if(!files.length)return;
    e.target.value="";
    // Batch mode: multiple files selected
    if(files.length>1){
      setBatchProgress({total:files.length,done:0,current:""});
      for(let fi=0;fi<files.length;fi++){
        const file=files[fi];
        setBatchProgress({total:files.length,done:fi,current:file.name});
        try{
          const dataUrl=await new Promise(res=>{const r=new FileReader();r.onload=ev=>res(ev.target.result);r.readAsDataURL(file);});
          let photoTime=null,photoGps=null,photoLat=null,photoLng=null;
          try{const abuf=await file.arrayBuffer();const exif=parseExif(abuf);photoTime=exif.time;photoGps=exif.gps;photoLat=exif.lat??null;photoLng=exif.lng??null;}catch{}
          const fetchLat=photoLat??loc?.lat;
          const fetchLng=photoLng??loc?.lng;
          const now=new Date();
          const t=photoTime||now.toLocaleString("en-US",{month:"long",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit",hour12:true});
          const coords=photoLat&&photoLng?fmtCoord(photoLat,photoLng):"Location not recorded";
          // Fish ID - resize first to avoid 413
          let species="Unidentified",length="",idNote=null;
          try{
            const img2=await new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=dataUrl;});
            const canvas2=document.createElement("canvas");
            const scale2=Math.min(1,800/Math.max(img2.width,img2.height));
            canvas2.width=Math.round(img2.width*scale2);canvas2.height=Math.round(img2.height*scale2);
            canvas2.getContext("2d").drawImage(img2,0,0,canvas2.width,canvas2.height);
            const base64=canvas2.toDataURL("image/jpeg",0.7).split(",")[1];
            const res=await fetch("/api/claude",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:150,messages:[{role:"user",content:[{type:"image",source:{type:"base64",media_type:"image/jpeg",data:base64}},{type:"text",text:"Look carefully at this fish. Identify species based on coloring and spot patterns. Rainbow trout have pink lateral stripe. Brown trout have red spots on golden body. Choose from: "+SPECIES.join(", ")+". Estimate length if visible. Reply ONLY with JSON: {\"species\":\"Rainbow Trout\",\"length\":14}. Use null for length if unknown."}]}]})});
            const rd=await res.json();
            const parsed=JSON.parse(((rd.content||[])[0]?.text||"{}").replace(/```json|```/g,"").trim());
            if(parsed.species&&parsed.species!=="Unidentified"){species=parsed.species;if(parsed.length!=null)length=String(Math.round(parsed.length));}
            else idNote="Could not identify fish from photo.";
          }catch(fishErr){void 0;}
          // Conditions
          let catchData={species,length,flies:[],photo:dataUrl,gps:coords,time:t,notes:"",air_temp:null,weather_desc:null,wind_speed:null,wind_dir:null,pressure:null,stream_cfs:null,stream_condition:null,stream_gauge_name:null,water_temp:null};
          if(fetchLat&&fetchLng){
            try{
              const d2=new Date(t.replace(" at "," "));
              const today=new Date().toISOString().split("T")[0];
              const dateStr=!isNaN(d2)?d2.toISOString().split("T")[0]:null;
              if(dateStr&&dateStr<today){
                const conds=await fetchHistoricalConditions(fetchLat,fetchLng,dateStr,"12");
                if(conds){catchData={...catchData,air_temp:conds.airTemp||null,weather_desc:conds.weatherDesc||null,wind_speed:conds.windSpeed||null,wind_dir:conds.windDir||null,pressure:conds.pressure||null,stream_cfs:conds.streamCFS||null,stream_condition:conds.streamCondition||null,stream_gauge_name:conds.streamGaugeName||null};}
              } else {
                const[wx,usgs]=await Promise.all([fetchWeather(fetchLat,fetchLng),fetchUSGSLive(fetchLat,fetchLng)]);
                const wc=wx.current;
                const pressureInHg=(wc.surface_pressure*0.02953).toFixed(2);
                catchData={...catchData,air_temp:String(Math.round(wc.temperature_2m)),weather_desc:WX_DESC[wc.weather_code]||"",wind_speed:String(Math.round(wc.wind_speed_10m)),wind_dir:windDir(wc.wind_direction_10m),pressure:pressureInHg};
                const ts2=(usgs.value?.timeSeries)??[];
                if(ts2.length){
                  const parsed2=ts2.map(t2=>{const raw=t2.values?.[0]?.value?.[0]?.value;const cfs=raw!=null?parseFloat(raw):null;const sLat=parseFloat(t2.sourceInfo?.geoLocation?.geogLocation?.latitude||0);const sLng=parseFloat(t2.sourceInfo?.geoLocation?.geogLocation?.longitude||0);const dist=Math.sqrt(Math.pow(sLat-fetchLat,2)+Math.pow(sLng-fetchLng,2));return{name:t2.sourceInfo?.siteName??"",cfs,dist,label:cfsLabel(cfs,null).label};}).filter(x=>x.cfs!=null&&x.cfs>=0&&x.cfs<500000).sort((a,b)=>a.dist-b.dist);
                  if(parsed2.length)catchData={...catchData,stream_cfs:String(Math.round(parsed2[0].cfs)),stream_condition:parsed2[0].label,stream_gauge_name:parsed2[0].name};
                }
              }
            }catch(condErr){void 0;}
          }
          const savedId=await addCatch(catchData);
          if(savedId) lastCatchIdRef.current=savedId;
        }catch(batchErr){void 0;}
      }
      setBatchProgress({total:files.length,done:files.length,current:""});
      setTimeout(()=>setBatchProgress(null),2000);
      return;
    }
    // Single file mode — original flow
    const file=files[0];
    const dataUrl=await new Promise(res=>{const r=new FileReader();r.onload=ev=>res(ev.target.result);r.readAsDataURL(file);});
    // Set photo immediately
    setForm(f=>({...f,photo:dataUrl,sizeEstimating:true,idNote:null}));
    setAddOpen(true);
    // Parse EXIF for date/GPS
    let photoTime=null,photoGps=null,photoLat=null,photoLng=null;
    try{
      const abuf=await file.arrayBuffer();
      const exif=parseExif(abuf);
      photoTime=exif.time;photoGps=exif.gps;photoLat=exif.lat??null;photoLng=exif.lng??null;
    }catch{}
    const fetchLat=photoLat??loc?.lat;
    const fetchLng=photoLng??loc?.lng;
    const now=new Date();
    const t=photoTime||now.toLocaleString("en-US",{month:"long",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit",hour12:true});
    const coords=photoLat&&photoLng?fmtCoord(photoLat,photoLng):"Location not recorded";
    setForm(f=>({...f,time:t,gps:coords}));
    // Fetch conditions from photo date/location
    if(fetchLat&&fetchLng){
      try{
        let dateStr=null,hourStr="12";
        const d2=new Date(t.replace(" at "," "));
        if(!isNaN(d2)){dateStr=d2.toISOString().split("T")[0];hourStr=String(d2.getHours()).padStart(2,"0");}
        const today=new Date().toISOString().split("T")[0];
        if(dateStr&&dateStr<today){
          const conds=await fetchHistoricalConditions(fetchLat,fetchLng,dateStr,hourStr);
          if(conds){
            setForm(f=>({...f,...{airTemp:conds.airTemp,weatherDesc:conds.weatherDesc,windSpeed:conds.windSpeed,windDir:conds.windDir,pressure:conds.pressure,streamCFS:conds.streamCFS,streamCondition:conds.streamCondition,streamGaugeName:conds.streamGaugeName}}));
            if(lastCatchIdRef.current) updateCatch(lastCatchIdRef.current,{airTemp:conds.airTemp,weatherDesc:conds.weatherDesc,windSpeed:conds.windSpeed,windDir:conds.windDir,pressure:conds.pressure,streamCFS:conds.streamCFS,streamCondition:conds.streamCondition,streamGaugeName:conds.streamGaugeName});
          }
        } else {
          const[wx,usgs]=await Promise.all([fetchWeather(fetchLat,fetchLng),fetchUSGSLive(fetchLat,fetchLng)]);
          const c=wx.current;
          const pressureInHg=(c.surface_pressure*0.02953).toFixed(2);
          setForm(f=>({...f,airTemp:String(Math.round(c.temperature_2m)),weatherDesc:WX_DESC[c.weather_code]||"",windSpeed:String(Math.round(c.wind_speed_10m)),windDir:windDir(c.wind_direction_10m),pressure:pressureInHg}));
          const ts2=(usgs.value?.timeSeries)??[];
          if(ts2.length){
            const parsed=ts2.map(t2=>{const raw=t2.values?.[0]?.value?.[0]?.value;const cfs=raw!=null?parseFloat(raw):null;const sLat=parseFloat(t2.sourceInfo?.geoLocation?.geogLocation?.latitude||0);const sLng=parseFloat(t2.sourceInfo?.geoLocation?.geogLocation?.longitude||0);const dist=Math.sqrt(Math.pow(sLat-fetchLat,2)+Math.pow(sLng-fetchLng,2));return{name:t2.sourceInfo?.siteName??"",cfs,dist,label:cfsLabel(cfs,null).label};}).filter(x=>x.cfs!=null&&x.cfs>=0&&x.cfs<500000).sort((a,b)=>a.dist-b.dist);
            if(parsed.length){
              const streamData={streamCFS:String(Math.round(parsed[0].cfs)),streamCondition:parsed[0].label,streamGaugeName:parsed[0].name,waterTemp:parsed[0].waterTempF?String(parsed[0].waterTempF):""};
              setForm(f=>({...f,...streamData}));
              if(lastCatchIdRef.current) updateCatch(lastCatchIdRef.current,streamData);
            }
          }
        }
      }catch(e2){void 0;}
    }
    // AI fish ID
    try{
      const base64=dataUrl.split(",")[1];
      const res=await fetch("/api/claude",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:150,messages:[{role:"user",content:[{type:"image",source:{type:"base64",media_type:file.type||"image/jpeg",data:base64}},{type:"text",text:`Identify this fish and estimate its length. Choose species from: ${SPECIES.join(", ")}. Reply ONLY with JSON: {"species":"Rainbow Trout","length":14}. Use null for length if unknown.`}]}]})});
      const rd=await res.json();
      const parsed=JSON.parse(((rd.content||[])[0]?.text||"{}").replace(/```json|```/g,"").trim());
      if(parsed.species||parsed.length!=null){
        setForm(f=>({...f,species:parsed.species||f.species,length:parsed.length!=null?String(Math.round(parsed.length)):f.length,sizeEstimated:parsed.length!=null}));
      } else {
        setForm(f=>({...f,idNote:"Could not identify fish from this photo. Please select species manually."}));
      }
    }catch(e3){
      void 0;
      setForm(f=>({...f,idNote:"Photo analysis failed. Please select species manually."}));
    }
    setForm(f=>({...f,sizeEstimating:false}));
  }

  function addFly(){if(!form.flyInput.trim())return;setForm(f=>({...f,flies:[...f.flies,f.flyInput.trim()],flyInput:""}));}
  function removeFly(i){setForm(f=>({...f,flies:f.flies.filter((_,j)=>j!==i)}));}
  function submitCatch(){
    const now=new Date();
    const t=form.time||now.toLocaleString("en-US",{month:"long",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit",hour12:true});
    const catchData={species:form.species,length:form.length,flies:[...form.flies],photo:form.photo,gps:form.gps||"Location not recorded",time:t,notes:form.notes,air_temp:form.airTemp||null,weather_desc:form.weatherDesc||null,wind_speed:form.windSpeed||null,wind_dir:form.windDir||null,pressure:form.pressure||null,stream_cfs:form.streamCFS||null,stream_condition:form.streamCondition||null,stream_gauge_name:form.streamGaugeName||null,water_temp:form.waterTemp||null};
    addCatch(catchData).then(id=>{if(id)lastCatchIdRef.current=id;});
    setForm(blank);setAddOpen(false);
  }

  const hatches=HATCHES[new Date().getMonth()];

  return(
    <div className="app">
      <div className="bgbar"/>
      {!isOnline&&<div style={{position:"fixed",top:0,left:0,right:0,zIndex:1000,background:"rgba(200,100,50,0.95)",padding:"8px 16px",textAlign:"center",fontSize:15,color:"white",fontFamily:"'Crimson Pro',serif"}}>
        📵 Offline mode — catches will sync when you reconnect{syncQueue.length>0?" · "+syncQueue.length+" pending":""}
      </div>}
      <input ref={camRef} type="file" accept="image/*" capture="environment" style={{display:"none"}} onChange={handlePhoto}/>
      <input ref={galRef} type="file" accept="image/*" multiple style={{display:"none"}} onChange={handlePhoto}/>

      <div className={`main${addOpen?" off":""}`}>
        <div className="hdr">
          <div style={{position:"absolute",top:14,right:16,zIndex:10}}>
            <button onClick={()=>sb?sb.auth.signOut():null}
              style={{background:"rgba(0,0,0,0.3)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:10,padding:"6px 12px",color:"var(--stone)",fontSize:15,cursor:"pointer",fontFamily:"'Crimson Pro',serif"}}>
              Sign Out
            </button>
          </div>
          <Logo layout="horizontal" scale={0.95} />
          {user&&<div style={{fontSize:14,color:"var(--sky)",marginTop:4,fontStyle:"italic",letterSpacing:1}}>{user.email}</div>}
        </div>

        {tab==="conditions"&&<>
        <div className="search-wrap">
          <LocationSearch placeholder="Search river, city, or state…" initialValue={loc?.label||""} onSelect={loadConditions}/>
        </div>
        <div className="loc-hint">
          {loc?`📌 ${loc.label}`:"Type a location · suggestions appear as you type · 📍 for GPS"}
        </div>
        </>}

        <div className="nav">
          {[{id:"conditions",icon:"🎯",label:"Intel"},{id:"log",icon:"🐟",label:"Catch Log"},{id:"plan",icon:"🗓",label:"Plan"},{id:"guide",icon:"🧭",label:"Guide"}].map(t=>(
            <button key={t.id} className={`nb${tab===t.id?" on":""}`} onClick={()=>{setTab(t.id);if(t.id==="conditions"&&sb&&user?.id)sb.from("saved_gauges").select("*").eq("user_id",user.id).then(({data})=>{if(data)setSavedGauges(data);});}}>
              <span className="ic">{t.icon}</span>{t.label}
            </button>
          ))}
        </div>

        <div className="content">
          {tab==="conditions"&&<>
            {!loc&&locating&&<div className="info-box" style={{textAlign:"center"}}><div className="loading">📍 Detecting your location…</div></div>}
            {!loc&&!locating&&<div className="info-box">🔍 <strong>Type a location above</strong> to load live weather and stream conditions.<br/><br/>Try: <em>"Madison River, MT"</em> · <em>"Deschutes River, OR"</em> · <em>"Au Sable River, MI"</em></div>}
            {loc&&<>
              <div style={{display:"flex",gap:6,marginBottom:12,overflowX:"auto",paddingBottom:2}}>
                {[["weather","🌤 Weather"],["streams","💧 Streams"],["report","🐛 Bugs"],["shops","🪝 Shops"]].map(([id,label])=>(
                  <button key={id} onClick={()=>{setIntelTab(id);if(id==="report")setHatchAutoRun(true);}} style={{fontSize:15,padding:"6px 16px",borderRadius:20,border:"1px solid rgba(200,168,75,0.3)",background:intelTab===id?"rgba(200,168,75,0.25)":"rgba(255,255,255,0.05)",color:intelTab===id?"var(--gold)":"var(--stone)",cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>{label}</button>
                ))}
              </div>
              {intelTab==="weather"&&<>
              <div className="card">
                <div className="ctitle">🌡 Current Weather<button className="rfsh" onClick={()=>loadConditions(loc)}>↻ Refresh</button></div>
                {wxLoading&&<div className="loading">Fetching weather…</div>}
                {wxError&&<div className="err">{wxError}</div>}
                {weather&&!wxLoading&&<>
                  <div className="wx-main"><div><div className="wx-temp">{weather.temp}°F</div><div className="wx-desc">{weather.desc}</div></div></div>
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
                      <div className="wx-val">🌧 {wxForecast?.daily?.precipitation_probability_max?.[0]??0}%</div>
                      <div className="wx-lbl">Rain Chance</div>
                    </div>
                  </div>

                  {(()=>{const m=getMoonPhase();const p=weather.pressure;const pNote=p?(parseFloat(p)>30.2?"High pressure — dry fly conditions good":parseFloat(p)>29.9?"Normal pressure — all techniques productive":parseFloat(p)>29.5?"Low pressure — nymphs & streamers best":"Very low pressure — fish feeding aggressively"):"";return(<>
                  <div className="wx-grid" style={{marginTop:10}}>
                    <div className="wx-item">
                      <div className="wx-val">{m.emoji} {m.name}</div>
                      <div className="wx-lbl">Moon Phase</div>
                    </div>
                    <div className="wx-item">
                      <div className="wx-val" style={{color:weather.pressureTrend?.color}}>{weather.pressureTrend?.icon} {weather.pressure}&quot;</div>
                      <div className="wx-lbl">Pressure · {weather.pressureTrend?.label}</div>
                      {pNote&&<div style={{fontSize:14,color:"var(--sky)",fontStyle:"italic",marginTop:4}}>{pNote}</div>}
                    </div>
                  </div>
                </>);})()}
                  {wxForecast&&<>
                    <div style={{borderTop:"1px solid rgba(255,255,255,0.08)",marginTop:14,paddingTop:14}}>
                      <WeekForecast data={wxForecast}/>
                    </div>
                  </>}
                </>}
              </div>
              </>}
              {intelTab==="streams"&&<>
              {savedGauges.length>0&&<SavedGaugesList
                savedGauges={savedGauges}
                showAddGauge={showAddGauge}
                setShowAddGauge={setShowAddGauge}
                gaugeInput={gaugeInput}
                setGaugeInput={setGaugeInput}
                gaugeAdding={gaugeAdding}
                addSavedGauge={addSavedGauge}
                removeSavedGauge={removeSavedGauge}
                fetchSavedGaugeData={fetchSavedGaugeData}
                cfsLabel={cfsLabel}
              />}
              <div style={{marginBottom:12}}>
                {showAddGauge?(
                  <div className="card">
                    <div style={{fontSize:15,color:"var(--gold)",marginBottom:8,fontFamily:"'Playfair Display',serif"}}>⭐ Add a Gauge</div>
                    <div style={{fontSize:15,color:"var(--stone)",marginBottom:8}}>Search by river name or paste a USGS site number.</div>
                    <GaugeSearch loc={loc} onAdd={addSavedGauge} gaugeInput={gaugeInput} setGaugeInput={setGaugeInput} gaugeAdding={gaugeAdding}/>
                    <button onClick={()=>setShowAddGauge(false)} style={{marginTop:8,fontSize:14,color:"var(--stone)",background:"none",border:"none",cursor:"pointer"}}>Cancel</button>
                  </div>
                ):(
                  <button onClick={()=>setShowAddGauge(true)} style={{width:"100%",background:"rgba(255,255,255,0.05)",border:"1px dashed rgba(255,255,255,0.15)",borderRadius:14,padding:"10px",color:"var(--stone)",fontSize:15,cursor:"pointer"}}>
                    ⭐ Pin a gauge (e.g. your local river)
                  </button>
                )}
              </div>
              <GaugeCard gauges={gauges} gaugeLoading={gaugeLoading} gaugeError={gaugeError} lastUpd={lastUpd} onRefresh={()=>loadConditions(loc)} isStarred={isStarred} toggleStar={toggleStar} showStarredOnly={showStarredOnly} setShowStarredOnly={setShowStarredOnly}/>
              <div className="card" style={{padding:0,overflow:"hidden",marginBottom:12}}>
                <div style={{padding:"10px 14px 8px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontSize:15,color:"var(--gold)",fontFamily:"'Playfair Display',serif"}}>🗺 Nearby Waters{gauges.length>0&&" · "+gauges.length+" gauges"}</span>
                  <a href={"https://www.openstreetmap.org/?mlat="+loc.lat+"&mlon="+loc.lng+"#map=10/"+loc.lat+"/"+loc.lng} target="_blank" rel="noreferrer" style={{fontSize:14,color:"var(--sky)",textDecoration:"none"}}>open larger ↗</a>
                </div>
                {(()=>{
                  const gaugePins=gauges.filter(g=>g.lat&&g.lng).map(g=>{
                    const lat=g.lat,lng=g.lng,name=(g.name||"").replace(/"/g,""),cfs=g.cfs?g.cfs.toFixed(0):"",lbl=g.label||"";
                    return `L.marker([${lat},${lng}],{icon:L.divIcon({className:"",html:'<div style="background:#2dd4bf;border:2px solid #fff;border-radius:50%;width:10px;height:10px;"></div>',iconSize:[10,10],iconAnchor:[5,5]})}).addTo(map).bindPopup("<b>${name}</b><br/>${cfs} CFS ${lbl}");`;
                  }).join("\n");
                  const shopPins=condShops.filter(s=>s.lat&&s.lng).map(s=>{
                    const lat=s.lat,lng=s.lng,name=(s.name||"").replace(/"/g,""),addr=(s.address||"").replace(/"/g,"");
                    return `L.marker([${lat},${lng}],{icon:L.divIcon({className:"",html:'<div style="background:#f59e0b;border:2px solid #fff;border-radius:3px;width:10px;height:10px;"></div>',iconSize:[10,10],iconAnchor:[5,5]})}).addTo(map).bindPopup("<b>${name}</b><br/>${addr}");`;
                  }).join("\n");
                  const mapHtml=`<!DOCTYPE html><html><head><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script><style>body,html,#map{margin:0;padding:0;width:100%;height:100%;}</style></head><body><div id="map"></div><script>
var map=L.map('map',{zoomControl:true,attributionControl:false}).setView([${loc.lat},${loc.lng}],10);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
L.marker([${loc.lat},${loc.lng}],{icon:L.divIcon({className:"",html:'<div style="background:#ef4444;border:2px solid #fff;border-radius:50%;width:14px;height:14px;"></div>',iconSize:[14,14],iconAnchor:[7,7]})}).addTo(map).bindPopup("<b>Your Location</b>").openPopup();
${gaugePins}
${shopPins}
<\/script></body></html>`;
                  return <iframe title="map" srcDoc={mapHtml} style={{width:"100%",height:280,border:"none",display:"block"}} sandbox="allow-scripts allow-same-origin"/>;
                })()}
                {gauges.length>0&&<div style={{padding:"8px 14px 10px",display:"flex",flexWrap:"wrap",gap:8}}>
                  {gauges.slice(0,5).map((g,i)=>(
                    <span key={i} style={{fontSize:14,color:"var(--stone)"}}>📍 {(g.name||"").split(" ").slice(0,4).join(" ")} · {Math.round(g.cfs||0)} CFS</span>
                  ))}
                </div>}
              </div>
              </>}
              {intelTab==="shops"&&<>
              <div className="card">
                <div className="ctitle">🪝 Nearby Fly Shops</div>
                <div className="csub">Dedicated fly shops near {loc.label}</div>
                {condShopsLoading&&<div className="loading">Searching…</div>}
                {!condShopsLoading&&condShops.length===0&&<div style={{fontSize:15,color:"var(--stone)",fontStyle:"italic"}}>Loading nearby shops…</div>}
                {condShops.map((s,i)=>(
                  <div key={i} style={{padding:"10px 0",borderBottom:i<condShops.length-1?"1px solid rgba(255,255,255,0.06)":"none"}}>
                    <div style={{fontSize:14,color:"var(--foam)",fontFamily:"'Crimson Pro',serif",fontWeight:600}}>{s.name}</div>
                    {s.address&&<div style={{fontSize:15,color:"var(--stone)",marginTop:2}}>{s.address}</div>}
                    {s.specialty&&<div style={{fontSize:15,color:"var(--sky)",marginTop:2,fontStyle:"italic"}}>{s.specialty}</div>}
                    {s.website&&<a href={s.website.startsWith("http")?s.website:"https://"+s.website} target="_blank" rel="noreferrer" style={{fontSize:15,color:"var(--gold)",textDecoration:"none",marginTop:4,display:"block"}}>{s.website.replace(/^https?:\/\//,"")}</a>}
                    {s.phone&&<div style={{fontSize:15,color:"var(--stone)",marginTop:2}}>{s.phone}</div>}
                  </div>
                ))}
              </div>
              </>}
              {intelTab==="report"&&<>
              {hatchLoading&&!hatchResult&&<div className="card"><div className="ctitle">🪲 Predicted Hatches</div><div className="loading">Matching hatches…</div></div>}
              {(!hatchLoading||hatchResult)&&<HatchMatcher loc={loc} waterTemp={null} gauges={gauges} autoRun={hatchAutoRun} prefetchedResult={hatchResult} prefetchedLoading={hatchLoading}/>}
              </>}
            </>}
          </>}

          {tab==="log"&&<>
            <div className="lhdr" style={{flexDirection:"column",gap:8}}>
              <div style={{display:"flex",gap:6}}>
                <button onClick={()=>setCatchLogTab("list")} style={{fontSize:14,padding:"4px 12px",borderRadius:20,border:"1px solid rgba(200,168,75,0.3)",background:catchLogTab==="list"?"rgba(200,168,75,0.25)":"rgba(255,255,255,0.05)",color:catchLogTab==="list"?"var(--gold)":"var(--stone)",cursor:"pointer"}}>📋 Log</button>
                <button onClick={()=>setCatchLogTab("photos")} style={{fontSize:14,padding:"4px 12px",borderRadius:20,border:"1px solid rgba(200,168,75,0.3)",background:catchLogTab==="photos"?"rgba(200,168,75,0.25)":"rgba(255,255,255,0.05)",color:catchLogTab==="photos"?"var(--gold)":"var(--stone)",cursor:"pointer"}}>📷 Photos</button>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",width:"100%"}}>
                <span className="lttl">My Catches · {catches.length} fish</span>
                <button className="btn" style={{padding:"6px 12px",fontSize:15}} onClick={()=>{
                  const rows=[["Species","Length","Flies","GPS","Date","Notes"],...catches.map(c=>[c.species,c.length,c.flies.join("|"),c.gps,c.time,c.notes])];
                  const csv=rows.map(r=>r.map(v=>`"${(v||"").toString().replace(/"/g,'""')}"`).join(",")).join("\n");
                  const a=document.createElement("a");a.href="data:text/csv;charset=utf-8,"+encodeURIComponent(csv);a.download="tight-lines-catches.csv";a.click();
                }}>⬇ CSV</button>
              </div>
              <button onClick={enrichCatches} disabled={enriching} style={{width:"100%",marginTop:6,background:"rgba(44,95,110,0.2)",border:"1px solid rgba(44,95,110,0.4)",borderRadius:10,padding:"8px",color:"var(--sky)",fontSize:15,cursor:"pointer",fontFamily:"'Crimson Pro',serif"}}>{enriching?"⏳ Updating catch data…":"🔄 Update Catch Data"}</button>
              {catches.length>0&&(()=>{
                const counts={};catches.forEach(c=>{if(c.species)counts[c.species]=(counts[c.species]||0)+1;});
                const sorted=Object.entries(counts).sort((a,b)=>b[1]-a[1]);
                const max=sorted[0]?.[1]||1;
                return(<div style={{width:"100%",marginTop:4}}>
                  {sorted.map(([sp,n])=>(
                    <div key={sp} style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                      <span style={{fontSize:14,color:"var(--stone)",width:110,flexShrink:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{sp}</span>
                      <div style={{flex:1,height:7,background:"rgba(0,0,0,0.3)",borderRadius:4,overflow:"hidden"}}>
                        <div style={{width:`${(n/max)*100}%`,height:"100%",background:"linear-gradient(90deg,var(--sky),var(--water))",borderRadius:4,transition:"width .6s"}}/>
                      </div>
                      <span style={{fontSize:14,color:"var(--sky)",width:16,textAlign:"right"}}>{n}</span>
                    </div>
                  ))}
                </div>);
              })()}

            </div>
            {(()=>{
              const parseGpsCoord=gps=>{
                if(!gps||gps==="Location not recorded") return null;
                const nums=gps.match(/-?\d+\.\d+/g);
                if(!nums||nums.length<2) return null;
                let lat=parseFloat(nums[0]),lng=parseFloat(nums[1]);
                if((gps.includes("W"))&&lng>0) lng=-lng;
                if((gps.includes("S"))&&lat>0) lat=-lat;
                if(lat<-90||lat>90||lng<-180||lng>180) return null;
                return{lat,lng};
              };
              const wg=catches.filter(c=>c.gps&&parseGpsCoord(c.gps));
              if(wg.length<2) return null;
              const cr=wg.map(c=>parseGpsCoord(c.gps));
              const lats=cr.map(c=>c.lat),lngs=cr.map(c=>c.lng);
              const lat0=Math.min(...lats),lat1=Math.max(...lats);
              const lng0=Math.min(...lngs),lng1=Math.max(...lngs);
              const W=560,H=220,P=24;
              // Find median center, exclude points >2 degrees away for bounds only
              const med=arr=>{const s=[...arr].sort((a,b)=>a-b);const m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;};
              const latMed=med(lats),lngMed=med(lngs);
              const corePts=cr.filter(c=>Math.abs(c.lat-latMed)<2&&Math.abs(c.lng-lngMed)<2);
              const viewPts=corePts.length>=2?corePts:cr;
              const vLats=viewPts.map(c=>c.lat),vLngs=viewPts.map(c=>c.lng);
              const vLat0=Math.min(...vLats),vLat1=Math.max(...vLats);
              const vLng0=Math.min(...vLngs),vLng1=Math.max(...vLngs);
              const latSpread=Math.max(vLat1-vLat0,0.04),lngSpread=Math.max(vLng1-vLng0,0.04);
              const latMid=(vLat0+vLat1)/2,lngMid=(vLng0+vLng1)/2;
              const latMin=latMid-latSpread/2-latSpread*0.2,latMax=latMid+latSpread/2+latSpread*0.2;
              const lngMin=lngMid-lngSpread/2-lngSpread*0.2,lngMax=lngMid+lngSpread/2+lngSpread*0.2;
              // All pins render but outliers clamp to edge
              const projX=lng=>Math.max(P+6,Math.min(W-P-6,P+(lng-lngMin)/((lngMax-lngMin)||0.01)*(W-P*2)));
              const ty=lat=>Math.max(P+6,Math.min(H-P-6,H-P-(lat-latMin)/((latMax-latMin)||0.01)*(H-P*2)));
              // Build Leaflet map in iframe with real map tiles
              const markers=cr.map((co,i)=>{
                const c=wg[i];
                const tip=(c.species||"Catch")+(c.length?' '+c.length+'"':'')+(c.time?' | '+c.time:'');
                return `L.circleMarker([${co.lat},${co.lng}],{radius:8,fillColor:'#c8a84b',color:'#8a6a1a',weight:2,fillOpacity:0.85}).bindPopup('${tip.replace(/'/g,"\'")}').addTo(map);`;
              }).join('\n');
              const mapHtml=`<!DOCTYPE html><html><head>
                <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
                <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
                <style>html,body,#map{margin:0;padding:0;width:100%;height:100%;}
                .leaflet-popup-content{font-family:serif;font-size:13px;}</style>
              </head><body><div id="map"></div><script>
                var map=L.map('map',{zoomControl:true,attributionControl:false});
                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:16}).addTo(map);
                ${markers}
                var pts=[${cr.map(c=>`[${c.lat},${c.lng}]`).join(',')}];
                map.fitBounds(pts,{padding:[24,24]});
              <\/script></body></html>`;
              return(
                <div className="card" style={{marginBottom:12,padding:0,overflow:"hidden"}}>
                  <div style={{padding:"10px 14px 6px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <span style={{fontSize:15,color:"var(--gold)",fontFamily:"'Playfair Display',serif"}}>📍 Catch Locations · {wg.length} mapped</span>
                  </div>
                  <iframe title="Catch map" srcDoc={mapHtml} style={{width:"100%",height:280,border:"none",display:"block"}} sandbox="allow-scripts allow-same-origin allow-popups"/>
                  <div style={{display:"flex",flexWrap:"wrap",gap:6,padding:"6px 12px 10px"}}>
                    {wg.slice(0,10).map((c,i)=>(
                      <span key={i} style={{fontSize:14,background:"rgba(200,168,75,0.15)",border:"1px solid rgba(200,168,75,0.3)",borderRadius:20,padding:"2px 10px",color:"var(--gold)"}}>
                        📍 {c.species||"Catch"}{c.length?" "+c.length+'"':""} 
                      </span>
                    ))}
                  </div>
                </div>
              );
            })()}
            {catchLogTab==="photos"?<PhotoJournal catches={catches} onPhotoClick={setLightboxPhoto}/>:<CatchPatterns catches={catches}/>}
          {catchLogTab==="list"&&catches.length===0&&<div className="empty"><div className="ei">🎣</div><p>No catches yet.<br/>Tap + to record your first!</p></div>}
            {catchLogTab==="list"&&catches.map(c=>(
              <div className="cc" key={c.id}>
                {c.photo?<img src={c.photo} className="c-img" alt="catch" loading="lazy" style={{cursor:"pointer"}} onClick={e=>{e.stopPropagation();setLightboxPhoto(c.photo);}}/>:<div className="c-ph">🐟</div>}
                <div className="cb">
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <div className="csp">{c.species}</div>
                    {c._pending&&<span style={{fontSize:15,background:"rgba(200,100,50,0.3)",border:"1px solid rgba(200,100,50,0.5)",borderRadius:10,padding:"1px 6px",color:"#ff9966"}}>⏳ Syncing</span>}
                  </div>
                  <div className="cm">
                    {c.length&&<span className="cmi">📏 {c.length}"</span>}
                    <span className="cmi">🕐 {c.time}</span>
                  </div>
                  {c.flies.length>0&&<div className="cff">{c.flies.map((f,i)=><a key={i} className="cfly" href={`https://www.google.com/search?q=${encodeURIComponent(f+" fly pattern")}&tbm=isch`} target="_blank" rel="noreferrer" style={{textDecoration:"none",cursor:"pointer"}}>🪶 {f}</a>)}</div>}
                  {c.notes&&<p style={{fontSize:15,color:"var(--sky)",marginTop:8,fontStyle:"italic"}}>{c.notes}</p>}
                  {c.gps&&(()=>{
  const m=c.gps.match(/([\d.]+)[°]?\s*([NS])[\s,]+([\d.]+)[°]?\s*([EW])/);
  if(!m) return null;
  const lat=parseFloat(m[1])*(m[2]==="S"?-1:1);
  const lng=parseFloat(m[3])*(m[4]==="W"?-1:1);
  const coordStr=Math.abs(lat).toFixed(4)+"°"+(lat>=0?"N":"S")+", "+Math.abs(lng).toFixed(4)+"°"+(lng>=0?"E":"W");
  return <div className="cgps">
    <a href={`https://maps.google.com/?q=${lat},${lng}`} target="_blank" rel="noreferrer" style={{color:"var(--sky)",textDecoration:"none"}}>📍 {coordStr}</a>
  </div>;
})()}
                  {(c.streamGaugeName||c.streamCFS||c.airTemp||c.weatherDesc)&&(
                    <div style={{marginTop:6,display:"flex",flexWrap:"wrap",gap:4}}>
                      {c.waterTemp&&<span style={{fontSize:14,background:"rgba(44,95,110,0.3)",border:"1px solid rgba(44,95,110,0.5)",borderRadius:20,padding:"2px 8px",color:"#7ec8c8"}}>💧 {c.waterTemp}°F</span>}
                      {c.streamGaugeName&&<span style={{fontSize:14,background:"rgba(44,95,110,0.3)",border:"1px solid rgba(44,95,110,0.5)",borderRadius:20,padding:"2px 8px",color:"var(--sky)"}}>💧 {c.streamGaugeName.split(" ").slice(0,4).join(" ")}</span>}
                      {c.streamCFS&&<span style={{fontSize:14,background:"rgba(44,95,110,0.3)",border:"1px solid rgba(44,95,110,0.5)",borderRadius:20,padding:"2px 8px",color:"var(--sky)"}}>{c.streamCFS} CFS {c.streamCondition?("· "+c.streamCondition):""}</span>}
                      {c.airTemp&&<span style={{fontSize:14,background:"rgba(255,255,255,0.06)",borderRadius:20,padding:"2px 8px",color:"var(--stone)"}}>🌡 {c.airTemp}°F</span>}
                      {c.weatherDesc&&<span style={{fontSize:14,background:"rgba(255,255,255,0.06)",borderRadius:20,padding:"2px 8px",color:"var(--stone)"}}>{c.weatherDesc}</span>}
                      {c.windSpeed&&<span style={{fontSize:14,background:"rgba(255,255,255,0.06)",borderRadius:20,padding:"2px 8px",color:"var(--stone)"}}>💨 {c.windSpeed}mph {c.windDir||""}</span>}
                    </div>
                  )}

                  <div style={{display:"flex",gap:8,marginTop:8}}>
                    <button onClick={e=>{e.stopPropagation();setEditingCatchId(prev=>prev===c.id?null:c.id);}}
                      style={{flex:1,background:"rgba(200,168,75,0.2)",border:"1px solid rgba(200,168,75,0.5)",borderRadius:8,padding:"8px",color:"var(--gold)",fontSize:15,cursor:"pointer",fontFamily:"'Crimson Pro',serif"}}>
                      ✏️ Edit
                    </button>
                    <button onClick={e=>{e.stopPropagation();if(window.confirm(`Delete this ${c.species}? This cannot be undone.`)){deleteCatch(c.id);}}}
                      style={{flex:1,background:"rgba(150,80,80,0.3)",border:"1px solid rgba(150,80,80,0.4)",borderRadius:8,padding:"8px",color:"var(--red)",fontSize:15,cursor:"pointer",fontFamily:"'Crimson Pro',serif"}}>
                      🗑 Delete
                    </button>
                  </div>
                  {editingCatchId===c.id&&(
                <div style={{marginTop:8,background:"rgba(0,0,0,0.3)",borderRadius:12,padding:"14px"}} onClick={e=>e.stopPropagation()}>
                  <div style={{fontSize:14,color:"var(--gold)",letterSpacing:1,textTransform:"uppercase",marginBottom:10}}>Edit Catch Details</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                    <div>
                      <div style={{fontSize:14,color:"var(--stone)",marginBottom:3}}>Species</div>
                      <select className="inp" style={{marginBottom:0,fontSize:15}} value={c.species||""}
                        onChange={e=>updateCatch(c.id,{species:e.target.value})}>
                        <option value="">Select…</option>
                        {["Brown Trout","Rainbow Trout","Brook Trout","Cutthroat Trout","Lake Trout","Bull Trout","Steelhead","Largemouth Bass","Smallmouth Bass","Other"].map(s=><option key={s}>{s}</option>)}
                      </select>
                    </div>
                    <div>
                      <div style={{fontSize:14,color:"var(--stone)",marginBottom:3}}>Length (in)</div>
                      <input className="inp" style={{marginBottom:0,fontSize:15}} type="number"
                        value={c.length||""} onChange={e=>updateCatch(c.id,{length:e.target.value})}/>
                    </div>
                  </div>
                  <div style={{marginBottom:8}}>
                    <div style={{fontSize:14,color:"var(--stone)",marginBottom:3}}>Date & Time</div>
                    <input className="inp" style={{marginBottom:0,fontSize:15}}
                      value={c.time||""} onChange={e=>updateCatch(c.id,{time:e.target.value})}/>
                  </div>
                  <div style={{marginBottom:8}}>
                    <div style={{fontSize:14,color:"var(--stone)",marginBottom:3}}>GPS</div>
                    <input className="inp" style={{marginBottom:0,fontSize:15}}
                      value={c.gps||""} onChange={e=>updateCatch(c.id,{gps:e.target.value})}/>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                    <div>
                      <div style={{fontSize:14,color:"var(--stone)",marginBottom:3}}>Air Temp °F</div>
                      <input className="inp" style={{marginBottom:0,fontSize:15}} type="number"
                        value={c.airTemp||""} onChange={e=>updateCatch(c.id,{airTemp:e.target.value})}/>
                    </div>
                    <div>
                      <div style={{fontSize:14,color:"var(--stone)",marginBottom:3}}>Water Temp °F</div>
                      <input className="inp" style={{marginBottom:0,fontSize:15}} type="number"
                        value={c.waterTemp||""} onChange={e=>updateCatch(c.id,{waterTemp:e.target.value})}/>
                    </div>
                  </div>
                  <div>
                    <div style={{fontSize:14,color:"var(--stone)",marginBottom:3}}>Notes</div>
                    <textarea className="inp" rows={2} style={{resize:"none",marginBottom:0,fontSize:15}}
                      value={c.notes||""} onChange={e=>updateCatch(c.id,{notes:e.target.value})}/>
                  </div>
                  <div style={{marginBottom:8}}>
                    <div style={{fontSize:14,color:"var(--stone)",marginBottom:3}}>Stream Gauge</div>
                    <input className="inp" style={{marginBottom:0,fontSize:15}} value={c.streamGaugeName||""} onChange={e=>updateCatch(c.id,{streamGaugeName:e.target.value})}/>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                    <div>
                      <div style={{fontSize:14,color:"var(--stone)",marginBottom:3}}>Stream CFS</div>
                      <input className="inp" style={{marginBottom:0,fontSize:15}} type="number" value={c.streamCFS||""} onChange={e=>updateCatch(c.id,{streamCFS:e.target.value})}/>
                    </div>
                    <div>
                      <div style={{fontSize:14,color:"var(--stone)",marginBottom:3}}>Water Temp °F</div>
                      <input className="inp" style={{marginBottom:0,fontSize:15}} type="number" value={c.waterTemp||""} onChange={e=>updateCatch(c.id,{waterTemp:e.target.value})}/>
                    </div>
                  </div>
                </div>
              )}
              </div>
            </div>
          ))}
          </>}

          {tab==="plan"&&<TripPlanner defaultLocation={loc?.label||""} key="trip-planner" parentGauges={gauges} savedGauges={savedGauges} parentLoc={loc}/>}
          {tab==="guide"&&<GuideBook user={user} loc={loc}/>}
        </div>

        {batchProgress&&(
          <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.7)",zIndex:9000,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <div style={{background:"var(--water)",borderRadius:16,padding:"28px 32px",textAlign:"center",maxWidth:300}}>
              <div style={{fontSize:32,marginBottom:12}}>📷</div>
              <div style={{fontFamily:"'Playfair Display',serif",fontSize:18,color:"var(--foam)",marginBottom:8}}>Adding Catches</div>
              <div style={{fontSize:15,color:"var(--stone)",marginBottom:16}}>{batchProgress.done} of {batchProgress.total} photos processed</div>
              <div style={{background:"rgba(0,0,0,0.3)",borderRadius:8,height:8,overflow:"hidden"}}>
                <div style={{height:"100%",background:"var(--gold)",borderRadius:8,width:`${(batchProgress.done/batchProgress.total)*100}%`,transition:"width 0.3s"}}/>
              </div>
              {batchProgress.done===batchProgress.total&&<div style={{marginTop:12,fontSize:15,color:"#9cd47a"}}>✓ All done!</div>}
            </div>
          </div>
        )}
        {tab==="log"&&(
          <button className="fab" onClick={()=>{setForm(blank);setAddOpen(true);}}
            style={{position:"fixed",bottom:28,right:"max(20px, calc(50% - 195px))"}}>＋</button>
        )}
      </div>

      <div className={`slide${addOpen?" on":""}`}>
        <div className="slide-hdr">
          <button className="back" onClick={()=>setAddOpen(false)}>← Back</button>
          <span className="slide-title">Record a Catch</span>
        </div>
        <div style={{padding:"20px 16px 48px",background:"var(--deep)"}}>
          <label className="lbl">Photo</label>
          {form.photo?(
            <div className="pw">
              <img src={form.photo} className="p-img" alt="catch"/>
              <div className="pov">
                {form.gps&&<span className="ptag">📍 {form.gps}</span>}
                {form.time&&<span className="ttag">{form.time}</span>}
              </div>
              <button className="px" onClick={()=>setForm(f=>({...f,photo:null,gps:null,time:null}))}>✕</button>
            </div>
          ):(
            <div className="pbtns">
              <button className="pbtn" onClick={()=>camRef.current.click()}><span className="pi">📷</span>Take Photo</button>
              <button className="pbtn" onClick={()=>galRef.current.click()}><span className="pi">🖼️</span>Choose from Library</button>
            </div>
          )}
          <p className="hint">GPS & timestamp auto-recorded with your photo.</p>
          {form.sizeEstimating&&<div style={{fontSize:15,color:"var(--gold)",fontStyle:"italic",marginBottom:8,padding:"8px 12px",background:"rgba(200,168,75,0.1)",borderRadius:8}}>🤖 Identifying fish…</div>}
          {form.idNote&&!form.sizeEstimating&&<div style={{fontSize:15,color:"var(--red)",marginBottom:8,padding:"8px 12px",background:"rgba(150,80,80,0.15)",border:"1px solid rgba(150,80,80,0.3)",borderRadius:8}}>⚠️ {form.idNote}</div>}
          <label className="lbl">Species</label>
          <select className="inp" value={form.species} onChange={e=>setForm(f=>({...f,species:e.target.value}))}>
            {SPECIES.map(s=><option key={s} value={s}>{s}</option>)}
          </select>
          <label className="lbl">Length (inches)</label>
          <input className="inp" type="number" placeholder="e.g. 18" value={form.length} onChange={e=>setForm(f=>({...f,length:e.target.value}))}/>
          <label className="lbl">Flies Used</label>
          <div className="ftags">{form.flies.map((fly,i)=><div className="ftag" key={i}>🪶 {fly}<button onClick={()=>removeFly(i)}>×</button></div>)}</div>
          <div className="frow">
            <input className="inp" placeholder="e.g. Elk Hair Caddis #14" value={form.flyInput}
              onChange={e=>setForm(f=>({...f,flyInput:e.target.value}))}
              onKeyDown={e=>e.key==="Enter"&&addFly()}/>
            <button className="btn" onClick={addFly}>Add</button>
          </div>
          <label className="lbl">Notes</label>
          <textarea className="inp" rows={4} style={{resize:"none"}} placeholder="Where, how, conditions…"
            value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))}/>
          {(form.streamGaugeName||form.streamCFS||form.airTemp||form.waterTemp)&&(
            <div style={{background:"rgba(44,95,110,0.15)",border:"1px solid rgba(44,95,110,0.3)",borderRadius:10,padding:"10px 12px",marginBottom:8}}>
              <div style={{fontSize:14,color:"var(--gold)",marginBottom:6,letterSpacing:1,textTransform:"uppercase"}}>Auto-recorded Conditions</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                {form.streamGaugeName&&<span style={{fontSize:14,color:"var(--sky)"}}>📍 {form.streamGaugeName.split(" ").slice(0,4).join(" ")}</span>}
                {form.streamCFS&&<span style={{fontSize:14,color:"var(--foam)"}}>💧 {form.streamCFS} CFS {form.streamCondition?"· "+form.streamCondition:""}</span>}
                {form.waterTemp&&<span style={{fontSize:14,color:"#7ec8c8"}}>🌡 Water: {form.waterTemp}°F</span>}
                {form.airTemp&&<span style={{fontSize:14,color:"var(--stone)"}}>☀️ Air: {form.airTemp}°F</span>}
                {form.weatherDesc&&<span style={{fontSize:14,color:"var(--stone)"}}>{form.weatherDesc}</span>}
              </div>
            </div>
          )}
          <button className="btn btnp" onClick={submitCatch}>🐟 Save to Log</button>
        </div>
      </div>
  </div>
  );
}


function SplashScreen({onDone}){
  const [fade,setFade]=React.useState(false);
  const [screen,setScreen]=React.useState(0);
  const total=4;
  function dismiss(){setFade(true);setTimeout(()=>onDone(),700);}
  function next(){if(screen<total-1)setScreen(s=>s+1);else dismiss();}
  function skip(){dismiss();}
  const screens=[
    {
      icon:null,
      title:null,
      subtitle:null,
      isSplash:true,
    },
    {
      icon:"💧",
      title:"Live Conditions",
      subtitle:"Intel Tab",
      body:"Check real-time stream flows, water temp, and 7-day weather before every trip. Star your favorite gauges to track them daily.",
      tip:"Tap 💧 Streams to save your home river.",
    },
    {
      icon:"🗺",
      title:"Find the Best Water",
      subtitle:"Plan Tab",
      body:"Enter your location and how long you'll drive. Get every fishable stream ranked best to worst with crowd levels, access points, and fly recommendations.",
      tip:"Sourced from real fly shop reports updated daily.",
    },
    {
      icon:"📷",
      title:"Document Every Fish",
      subtitle:"Catch Log Tab",
      body:"Upload a photo and the app auto-identifies the species, records your GPS location, and pulls historical conditions for that exact day.",
      tip:"Your catch locations are encrypted and never shared.",
    },
  ];
  const s=screens[screen];
  return(
    <div style={{position:'fixed',top:0,left:0,right:0,bottom:0,background:'linear-gradient(170deg,#0d1f26 0%,#1a3a4a 50%,#0d2a1f 100%)',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',zIndex:9999,transition:'opacity 0.7s',opacity:fade?0:1,pointerEvents:fade?'none':'all',padding:'32px 24px'}}>
    {screen>0&&(
      <div style={{position:'absolute',top:0,left:0,right:0,display:'flex',gap:4,padding:'16px 24px'}}>
        {[0,1,2,3].map(i=><div key={i} style={{flex:1,height:3,borderRadius:2,background:i<=screen-1?"var(--gold)":"rgba(255,255,255,0.2)"}}/>)}
      </div>
    )}
      {s.isSplash?(
        <>
          <svg viewBox="0 0 340 180" width="300" height="160" style={{marginBottom:20}}>
            <defs>
              <linearGradient id="skg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#0a1a2e"/><stop offset="100%" stopColor="#1a3a4a"/></linearGradient>
              <linearGradient id="wtg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#1a4a5a"/><stop offset="100%" stopColor="#0d2a35"/></linearGradient>
            </defs>
            <rect width="340" height="180" fill="url(#skg)"/>
            {[[20,15],[60,8],[100,20],[140,10],[180,18],[220,8],[260,15],[300,10],[320,22],[40,30],[80,25],[160,28],[240,25],[310,30]].map(([x,y],i)=><circle key={i} cx={x} cy={y} r="1" fill="white" opacity="0.7"/>)}
            <circle cx="290" cy="25" r="14" fill="#c8a84b" opacity="0.9"/>
            <circle cx="296" cy="21" r="11" fill="#0a1a2e" opacity="0.85"/>
            <polygon points="0,100 60,40 120,100" fill="#1e3d2e" opacity="0.9"/>
            <polygon points="60,100 130,35 200,100" fill="#1a3a2a" opacity="0.95"/>
            <polygon points="140,100 220,45 300,100" fill="#1e3d2e" opacity="0.85"/>
            <polygon points="240,100 300,50 340,100" fill="#1a3a2a" opacity="0.9"/>
            <path d="M0,130 Q85,118 170,128 Q255,138 340,125 L340,180 L0,180 Z" fill="url(#wtg)"/>
            <g transform="translate(155,95)">
              <ellipse cx="0" cy="18" rx="6" ry="10" fill="#0d1f26"/>
              <circle cx="0" cy="5" r="6" fill="#0d1f26"/>
              <ellipse cx="0" cy="1" rx="9" ry="2.5" fill="#0d1f26"/>
              <rect x="-5" y="-6" width="10" height="8" rx="2" fill="#0d1f26"/>
              <line x1="6" y1="10" x2="50" y2="-15" stroke="#c8a84b" strokeWidth="1.5"/>
              <path d="M50,-15 Q80,-5 95,20" stroke="#c8a84b" strokeWidth="0.8" fill="none" opacity="0.8"/>
            </g>
          </svg>
          <div style={{marginBottom:8}}><Logo layout="stacked" mark={false} scale={1} /></div>
          <div style={{fontFamily:"'Crimson Pro',serif",fontSize:15,color:"var(--sky)",letterSpacing:3,textTransform:'uppercase',marginBottom:24}}>Fly Fishing Journal</div>
          <div style={{background:'rgba(0,0,0,0.35)',border:'1px solid rgba(200,168,75,0.25)',borderRadius:16,padding:'18px 22px',maxWidth:320,textAlign:'center',marginBottom:24}}>
            <div style={{fontSize:18,marginBottom:8}}>🔒</div>
            <p style={{fontFamily:"'Crimson Pro',serif",fontSize:15,color:"var(--foam)",lineHeight:1.65,margin:0}}>Your spots stay your spots. Catch locations are encrypted and never shared.</p>
          </div>
          <button onClick={next} style={{background:"var(--gold)",color:"#0d1f26",border:"none",borderRadius:24,padding:"12px 36px",fontSize:16,fontFamily:"'Playfair Display',serif",fontWeight:600,cursor:"pointer",letterSpacing:1}}>Get Started →</button>
          <button onClick={()=>{localStorage.setItem('gc_onboarded','1');dismiss();}} style={{marginTop:12,background:"none",border:"none",color:"var(--stone)",fontSize:15,cursor:"pointer",fontFamily:"'Crimson Pro',serif"}}>Skip intro</button>
        </>
      ):(
        <>
          <div style={{fontSize:64,marginBottom:16}}>{s.icon}</div>
          <div style={{fontFamily:"'Crimson Pro',serif",fontSize:15,color:"var(--gold)",letterSpacing:3,textTransform:"uppercase",marginBottom:6}}>{s.subtitle}</div>
          <div style={{fontFamily:"'Playfair Display',serif",fontSize:28,color:"var(--foam)",marginBottom:16,textAlign:"center"}}>{s.title}</div>
          <div style={{background:"rgba(0,0,0,0.35)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:16,padding:"20px 24px",maxWidth:320,textAlign:"center",marginBottom:24}}>
            <p style={{fontFamily:"'Crimson Pro',serif",fontSize:16,color:"var(--foam)",lineHeight:1.7,margin:0,marginBottom:12}}>{s.body}</p>
            <div style={{fontSize:15,color:"var(--sky)",fontStyle:"italic"}}>💡 {s.tip}</div>
          </div>
          <button onClick={next} style={{background:"var(--gold)",color:"#0d1f26",border:"none",borderRadius:24,padding:"12px 36px",fontSize:16,fontFamily:"'Playfair Display',serif",fontWeight:600,cursor:"pointer",letterSpacing:1}}>{screen===total-1?"Let's Fish →":"Next →"}</button>
          {screen===total-1&&<label style={{marginTop:14,display:"flex",alignItems:"center",gap:8,cursor:"pointer"}}><input type="checkbox" onChange={e=>e.target.checked&&localStorage.setItem("gc_onboarded","1")} style={{accentColor:"var(--gold)"}}/><span style={{fontSize:15,color:"var(--stone)",fontFamily:"'Crimson Pro',serif"}}>Don't show again</span></label>}
          <button onClick={skip} style={{marginTop:8,background:"none",border:"none",color:"var(--stone)",fontSize:15,cursor:"pointer",fontFamily:"'Crimson Pro',serif"}}>Skip</button>
        </>
      )}
    </div>
  );
}

function Root(){
  const [showSplash,setShowSplash]=React.useState(()=>!localStorage.getItem("gc_onboarded"));
  const {user, loading} = useAuth();
  if(showSplash) return <SplashScreen onDone={()=>{localStorage.setItem("gc_onboarded","1");setShowSplash(false);}}/>;
  if(loading) return(
    <div style={{minHeight:"100vh",background:"var(--deep)",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{textAlign:"center"}}>
        <div style={{fontSize:48,marginBottom:12}}>🎣</div>
        <div style={{fontFamily:"'Playfair Display',serif",fontSize:18,color:"var(--sky)",animation:"pulse 1.5s infinite"}}>Loading…</div>
      </div>
    </div>
  );
  // Only bypass auth if Supabase is genuinely not configured
  if(!SUPABASE_CONFIGURED) return <App user={{id:"local",email:"local user"}}/>;
  // Supabase IS configured - require login
  if(!user) return <AuthScreen/>;
  return <App user={user}/>;
}
export default Root;
