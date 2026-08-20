import React, { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { createClient } from "@supabase/supabase-js";
import "./App.css";
import { directionalSpread, filterFishableGauges, runTripPlannerPipeline } from "./lib/tripPlannerPipeline.js";
import { fetchCODWRGauges, fetchCODWRSingleValue, fetchNWPSGauges, attachNWPSForecasts, enrichWithNWPSForecasts, fetchNWMStreamflow, fetchNWMForecastOutlook } from "./lib/gaugeSources.js";

// iOS Safari's address bar can show/hide independently of any CSS reflow, which leaves
// height:100% (and vh units) resolving against a stale notion of the viewport — most
// visibly as a blank gap at the bottom right after returning from an external page like
// Stripe checkout. Measuring the real pixel height via JS and feeding it back in as a CSS
// variable is the standard, deterministic fix (vh/dvh alone don't reliably cover this).
function setAppHeight(){
  try{ document.documentElement.style.setProperty("--app-height", window.innerHeight+"px"); }catch(e){ void 0; }
}
if(typeof window!=="undefined"){
  setAppHeight();
  window.addEventListener("resize", setAppHeight);
  window.addEventListener("pageshow", setAppHeight);
}

// Brand Logo: icon mark + live-text wordmark, built for dark backgrounds.
function Logo({ layout = "horizontal", scale = 1, mark = true, tagline = true }) {
  const px = (n) => Math.round(n * scale);
  const stacked = layout === "stacked";
  const emblem = mark ? (
    <img src="/logo-mark.png" alt="Guide's Choice" aria-hidden="true"
      style={{ height: px(46), width: px(46), objectFit: "contain", display: "block" }} />
  ) : null;
  // Full badge (helmet + trout emblem with "GUIDE'S CHOICE" / "FIND THE PATTERN" baked
  // into the ring) — used for the stacked+mark layout (AuthScreen, main header, and the
  // cold-launch loading screen) so the wordmark/tagline aren't duplicated as separate
  // live text right next to it. Adam, App Dev 29: wants the text-ring version, not the
  // plain emblem, as the visible logo.
  const badge = mark ? (
    <img src="/logo-badge.png" alt="Guide's Choice Fishing — Find the Pattern"
      style={{ height: px(150), width: px(150), objectFit: "contain", display: "block" }} />
  ) : null;
  const title = (
    <div style={{ fontFamily: "var(--font-head)", fontWeight: 600, fontSize: px(stacked ? 32 : 23), lineHeight: 1.02, letterSpacing: px(1.5), color: "var(--foam)", whiteSpace: "nowrap" }}>
      {"GUIDE'S CHOICE FISHING"}
    </div>
  );
  const tag = tagline ? (
    <div style={{ fontFamily: "var(--font-body)", fontSize: px(stacked ? 13 : 10), letterSpacing: px(3), textTransform: "uppercase", color: "var(--gold)", marginTop: px(1), whiteSpace: "nowrap" }}>
      Find the Pattern
    </div>
  ) : null;
  if (stacked) {
    if (mark) {
      return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
          {badge}
        </div>
      );
    }
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
        <div style={{ marginBottom: px(14) }}>{title}</div>
        {tag}
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

// ── Nav icons (inline SVG, no icon-library dependency; inherit color via currentColor) ──
function IconTarget({size=20}){
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/></svg>;
}
function IconFish({size=20}){
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12c2.5-4 7-6.5 11.5-5.3C17 7.4 19 9.5 21 12c-2 2.5-4 4.6-6.5 5.3C10 18.5 5.5 16 3 12Z"/><path d="M21 12l2.2-3.3M21 12l2.2 3.3"/><circle cx="8.3" cy="10.6" r=".9" fill="currentColor" stroke="none"/></svg>;
}
function IconCalendar({size=20}){
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>;
}
function IconCompass({size=20}){
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M14.5 9.5 13 13l-3.5 1.5L11 11l3.5-1.5Z" fill="currentColor" stroke="none"/></svg>;
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
// Resizes a base64 data URL to fit within maxDim on its longest side, re-encoding as
// JPEG at the given quality. Resolves to the original string unchanged if decoding
// fails (e.g. already small enough, or an unexpected format) so callers never break.
function resizeDataUrl(base64DataUrl,maxDim,quality){
  return new Promise((res2)=>{
    const img=new Image();
    img.onload=()=>{
      const scale=Math.min(1,maxDim/Math.max(img.width,img.height));
      if(scale>=1)return res2(base64DataUrl);
      const cv=document.createElement("canvas");
      cv.width=Math.round(img.width*scale);cv.height=Math.round(img.height*scale);
      cv.getContext("2d").drawImage(img,0,0,cv.width,cv.height);
      res2(cv.toDataURL("image/jpeg",quality));
    };
    img.onerror=()=>res2(base64DataUrl);
    img.src=base64DataUrl;
  });
}
async function uploadPhotoToStorage(base64DataUrl, folder){
  if(!sb) return null;
  try{
    // Downscale before upload: full-res photos time out on cell connections. Also
    // generates a small companion thumbnail (same base filename + "_thumb") — catch
    // avatars and grid views load this instead of the full photo, which was the actual
    // cause of slow photo loading (a 44px thumbnail was fetching the same ~1600px file
    // as the full card view). Thumb upload is best-effort: if it fails, the main photo
    // still saves normally and toThumbUrl()'s onError fallback covers the gap.
    let uploadUrl=base64DataUrl,thumbDataUrl=base64DataUrl;
    try{
      [uploadUrl,thumbDataUrl]=await Promise.all([
        resizeDataUrl(base64DataUrl,1600,0.82),
        resizeDataUrl(base64DataUrl,240,0.75)
      ]);
    }catch{uploadUrl=base64DataUrl;thumbDataUrl=base64DataUrl;}
    const res=await fetch(uploadUrl);
    const blob=await res.blob();
    const ext=blob.type.split("/")[1]||"jpg";
    const id=`${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const fileName=`${folder}/${id}.${ext}`;
    const thumbName=`${folder}/${id}_thumb.${ext}`;
    const thumbBlob=await fetch(thumbDataUrl).then(r=>r.blob()).catch(()=>null);
    const [mainUpload]=await Promise.all([
      sb.storage.from("trip-photos").upload(fileName,blob,{contentType:blob.type,upsert:false}),
      thumbBlob?sb.storage.from("trip-photos").upload(thumbName,thumbBlob,{contentType:thumbBlob.type,upsert:false}).catch(e=>{console.error("uploadPhotoToStorage: thumb upload failed (non-fatal):",e.message||e);return null;}):Promise.resolve(null)
    ]);
    if(mainUpload.error){console.error("uploadPhotoToStorage: storage upload failed:",mainUpload.error.message||mainUpload.error);return null;}
    const {data:{publicUrl}}=sb.storage.from("trip-photos").getPublicUrl(fileName);
    return publicUrl;
  }catch(e){console.error("uploadPhotoToStorage: threw:",e.message||e);return null;}
}
// Derives a photo's small-thumbnail URL from its main storage URL (see uploadPhotoToStorage
// above). Photos uploaded before this shipped have no "_thumb" file — pair with
// onError={e=>{e.target.onerror=null;e.target.src=originalUrl;}} on the <img> to fall
// back to the full photo for those.
function toThumbUrl(url){
  if(!url) return url;
  return url.replace(/(\.[a-zA-Z0-9]+)(\?.*)?$/,"_thumb$1$2");
}



// ── Supabase Config ───────────────────────────────────────────────────────────
// Replace these with your actual Supabase project URL and anon key
const SUPABASE_URL = "https://geqcnlrwkwicavwixvdn.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdlcWNubHJ3a3dpY2F2d2l4dmRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwOTcyNjIsImV4cCI6MjA5MzY3MzI2Mn0.R2IKRDFT0P0vrXKEfcuSv54TDAiiBK0LbQPHiilanjM";
const SUPABASE_CONFIGURED = !SUPABASE_URL.includes("REPLACE_WITH");
// Supabase JS's default auth client coordinates token refresh across browser tabs using
// navigator.locks — with no timeout on lock acquisition. This is a real, currently-open
// upstream bug (github.com/supabase/supabase-js/issues/1594, #2111): a lock orphaned by
// one killed or backgrounded tab is held forever, and every auth call in every OTHER
// tab that opens afterward — getSession, sign-in, everything — queues behind it and
// hangs indefinitely. This is the confirmed root cause of the recurring stuck-loading
// screen that only resolves by forcing a sign-out (attemptAuthRecovery wiping the
// session is a detect-and-recover patch for this; it was never able to prevent it).
// Documented community workaround, used here: swap in a lock that never touches
// navigator.locks, so a lock stuck in one tab can no longer block any other. Trade-off:
// if the same account is open in two tabs at once, their token refreshes could in
// theory race — Supabase's server-side refresh token rotation is built to tolerate
// that, and it's a far smaller risk than the app hanging and forcing a sign-out, which
// is what was happening before this. Reasoned from the documented upstream fix, not
// something testable by execution outside a real browser — worth confirming this
// actually resolves it after it's live for a few days of normal use.
const noOpAuthLock = async (name, acquireTimeout, fn) => fn();
const sb = SUPABASE_CONFIGURED ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { lock: noOpAuthLock } }) : null;

const sleep = (ms) => new Promise(r=>setTimeout(r, ms));

// Tiered recovery for a stuck Supabase auth/session check: reloads the page, escalating
// across two attempts per tab session, then gives up automatically. This exists because
// of a documented supabase-js issue (the client can deadlock on an internal cross-tab
// browser lock used to coordinate sign-in — no error, no network activity, the request
// just never settles) — confirmed as the root cause of the original cold-launch version
// of this symptom (App Dev 33) via Adam's own observation that a manual sign-out/sign-in
// always fixed it.
// TWO TIERS, not one — learned live tonight (2026-07-26) the hard way:
//   Attempt 1 (soft): reload WITHOUT wiping the stored session. Handles the common case
//   — a stuck browser-level lock tied to the OLD page's JS context, nothing wrong with
//   the token itself. A plain reload destroys that context and releases the lock; the
//   still-valid session survives, so the person stays signed in with no forced re-login.
//   This was the ONLY tier for a while tonight, on the theory the token itself was never
//   actually the problem.
//   Attempt 2 (hard): if a soft reload didn't fix it and the SAME hang recurs again this
//   tab session, that's evidence the stored token itself may genuinely be bad, not just a
//   stuck lock — confirmed live tonight: two devices (phone + this PC) signed in
//   simultaneously, both refreshing around the same time, which Supabase's own concurrent-
//   refresh handling can invalidate outright. Multiple plain reloads and even a fully
//   closed-and-reopened tab did NOT fix it; only a manual "clear site data" did — proving
//   the token, not a lock, was the actual problem that time. So attempt 2 wipes the stored
//   session before reloading, same as a manual sign-out, to force a genuinely fresh
//   sign-in — the same recovery this whole mechanism was originally modeled on.
// After both tiers have been tried this tab session, automatic recovery stops — a third
// consecutive failure means something neither tier can fix on its own (e.g. a real
// backend issue), and the person is better served by the normal failure banner / manual
// retry / manual reload than by an endless, invisible reload loop.
// Guarded by a sessionStorage counter so a merely slow (not stuck) connection can never
// trigger a reload loop. Returns true if it fired (caller should stop — a reload is
// underway); false once both tiers are exhausted this session (caller should fall back
// to its own normal failure handling instead).
function attemptAuthRecovery(){
  // A report actively generating in the Trip Planner is real, unsaved, multi-minute
  // work — confirmed live (2026-07-27): a tab backgrounded mid-report and resumed while
  // still generating fires onVisible's resume tier-check, which now competes with the
  // report's own heavy concurrent network activity for the connection; if that tier
  // check then genuinely fails on all attempts, this function used to force a reload
  // regardless — destroying the in-progress report and dropping the person back to a
  // sign-in screen. Losing that is far more costly than leaving a tier check stale a
  // little longer, so skip the reload entirely while one is in flight. The caller falls
  // back to its own normal non-destructive handling (banner + manual retry) instead,
  // and the very next tier check after the report finishes gets a fresh, un-skipped
  // recovery attempt — nothing here is permanently lost, just deferred.
  if(window._reportGenerating) return false;
  let attempts=0;
  try{ attempts = parseInt(sessionStorage.getItem("gc_auth_recover_attempted")||"0",10)||0; }catch(e){}
  if(attempts>=2) return false;
  const next=attempts+1;
  try{ sessionStorage.setItem("gc_auth_recover_attempted",String(next)); }catch(e){}
  if(next===2){
    try{ Object.keys(localStorage).forEach(k=>{ if(k.startsWith("sb-")) localStorage.removeItem(k); }); }catch(e){}
  }
  window.location.reload();
  return true;
}

// ── Auth hook ─────────────────────────────────────────────────────────────────
function useAuth(){
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [demoError, setDemoError] = useState("");
  const [tier, setTier] = useState("free");
  // Populated only when a comped account's access has just been read as expired —
  // lets the UI show "your trial ended" instead of silently looking like plain free tier.
  const [trialExpired, setTrialExpired] = useState(null);
  // Populated after every signup-time auto-redeem attempt (success or failure) so the
  // outcome is visible on screen — this used to be console-only, which is useless on
  // browsers where DevTools is blocked by an org policy (confirmed case: Adam's work
  // Chrome profile). Cleared by the person dismissing the banner.
  const [autoRedeemNotice, setAutoRedeemNotice] = useState(null);
  // Set when every retry attempt in refreshTier below hit a genuine error (not just "no
  // row" / legitimately free) — surfaces a visible "couldn't verify your plan" banner with
  // a manual retry instead of silently looking like a downgrade. Cleared on next success.
  const [tierCheckFailed, setTierCheckFailed] = useState(false);
  // Raw snapshot of the last refreshTier attempt — shown as small debug text in Settings.
  // Added App Dev 29.5 after the retry fix alone didn't resolve Adam's "wrong account /
  // no full access" report, and it turned out to reproduce on wifi too (not just flaky
  // cellular) even after a full app close-and-reopen — meaning the failure mode isn't
  // necessarily the transient-network case the retry logic targets. Rather than guess a
  // third time, surface the actual query result so a screenshot gives real evidence:
  // which user id, what the subscriptions row actually contains (or that there's no row
  // at all), and any error — instead of theorizing further with no data.
  const [tierDebug, setTierDebug] = useState(null);
  // True only while a subscription check is actively in flight for a signed-in user.
  // Added after a live report: right after an interactive sign-in, `user` becomes
  // truthy immediately (synchronously, in the onAuthStateChange handler below) while
  // `tier` is still sitting at its untouched "free" default until refreshTier's async
  // check resolves — and PLAN_TIERS.has(tier)/GUIDE_TIERS.has(tier) can't tell "free"
  // apart from "not checked yet". That gap showed a paying customer the upgrade paywall
  // for however long the check actually took (a fraction of a second normally, several
  // seconds during exactly the slow/stuck-check scenarios fixed earlier this session) —
  // confirmed live: the paywall "corrected itself" once the check finished, meaning it
  // was never wrong data, just a premature verdict shown before the real answer arrived.
  // Cold-launch is unaffected (the outer `loading` gate already keeps the whole app
  // shell hidden until refreshTier resolves) — this specifically covers the interactive
  // sign-in path, where the app shell is already visible before the check finishes.
  // IMPORTANT refinement (same evening): the Plan/Guide tab gating only shows the
  // "Checking your plan…" placeholder when `tier` is ALSO still "free" — i.e. genuinely
  // unknown. A later, routine background re-check (e.g. on tab-focus resume) can start
  // and even get stuck AFTER an earlier check already succeeded — confirmed live via a
  // screenshot showing "Current: Guide Pro" correctly resolved while a fresh, separate
  // check sat stuck on "checking…" underneath it. Gating on tierChecking alone made an
  // already-confirmed paid account's real content vanish behind a spinner for a check
  // that was really just double-checking in the background. Once a real tier is known,
  // a subsequent check (successful, slow, or even stuck) should never hide it again.
  const [tierChecking, setTierChecking] = useState(false);
  // Reads the caller's subscription tier. Accepts an explicit uid (used right after
  // sign-in, before `user` state has committed) and falls back to current `user`.
  // Fails open to "free" on any error/missing row — a Supabase hiccup must never
  // read as a paywall lockout for someone who's actually paying.
  //
  // Retries up to 2 extra times (short backoff) on a genuine fetch error only — e.g. a
  // slow/flaky mobile connection right as the app opens — before falling back to "free".
  // This was previously a single attempt with no retry: a transient failure right at
  // cold-launch silently and permanently read as "free" for the rest of that session,
  // with no self-heal. The only way out was signing out and back in, which forces a
  // fresh attempt (usually on a by-then-stable connection) — that "fix" was really just
  // a lucky retry. Confirmed report (App Dev 28+): both Adam's and Evan's accounts.
  // A legitimate "no subscriptions row" (real free user) or status==="canceled" is NOT
  // an error and must never trigger a retry — only `error` truthy does.
  // Tracks a subscription check already in flight for a given uid. Without this,
  // every trigger that can call refreshTier (sign-in, tab regaining focus via
  // onVisible, etc.) starts a completely independent retry sequence — and since
  // onVisible fires on EVERY tab-switch with no throttle, frequent switching between
  // several open tabs (visible in every screenshot from this browser session) could
  // keep restarting tierChecking back to "just started" before any single attempt
  // ever reached one of its own terminal branches. That would make "Checking your
  // plan…" look like a permanent hang even though any one check, left alone, would
  // resolve fine. This is a strong inference from reading the code (onVisible has no
  // guard against an already-in-flight check) plus the circumstantial evidence of a
  // multi-tab browser session — not something directly confirmed via a debug capture
  // of the restart happening. Either way, sharing one in-flight check per uid instead
  // of letting overlapping triggers reset it is a strict improvement with no downside.
  const inFlightTierCheck = useRef(null);
  const refreshTier = useCallback(async (uid)=>{
    const id = uid || (user && user.id);
    if(!sb || !id){ setTier("free"); setTrialExpired(null); setTierCheckFailed(false); setTierChecking(false); setTierDebug({uid:id||null, note:"no sb client or no uid"}); return "free"; }
    if(inFlightTierCheck.current && inFlightTierCheck.current.id===id){
      return inFlightTierCheck.current.promise;
    }
    const runCheck = (async()=>{
    // Set immediately, before the retry loop starts: without this, a screenshot taken
    // right after opening the app (before any attempt finishes) shows the exact same
    // blank line as a genuinely stuck check — which is what caused confusion in App Dev
    // 31/32 (a "just opened it, checked right away" report looked identical to the
    // original hang bug). Now "checking…" vs. truly blank tells the two apart at a glance.
    // Clear any stale "couldn't verify your plan" banner the instant a NEW check
    // starts — previously this only cleared on a successful result, so a fresh
    // in-progress check (note:"checking…") could sit visually behind a leftover
    // failure banner from a prior attempt, making a check that's actually running
    // again look permanently stuck. Confirmed via a live screenshot (2026-07-26)
    // showing "checking…" in the debug line at the same moment the red banner
    // was still up — that combination should be impossible once this fires here.
    setTierCheckFailed(false);
    setTierChecking(true);
    setTierDebug({uid:id, note:"checking…"});
    const delays = [0, 700, 1600]; // first attempt, then two retries
    for(let attempt=0; attempt<delays.length; attempt++){
      if(delays[attempt]) await sleep(delays[attempt]);
      try{
        // Confirmed root cause (App Dev 31, via Adam's Settings screenshot showing
        // "Free" with NO tierDebug line at all — proof this call never reached ANY
        // branch below, success or error): the bare await here can hang indefinitely
        // with no rejection if the request was in flight when the app/tab got
        // backgrounded. That freezes tier/tierDebug at their untouched initial
        // defaults ("free"/null) — no retry ever fires because nothing ever errors.
        // Same hang class as the earlier signOut() and redeemInviteCode() bugs, both
        // already fixed with a timeout; reusing the same Promise.race pattern already
        // used elsewhere in this file (fetchUSGSLive, askClaude) rather than a new one.
        const {data, error} = await Promise.race([
          sb.from("subscriptions").select("tier,status,is_comped,current_period_end").eq("user_id", id).maybeSingle(),
          new Promise((_,rej)=>setTimeout(()=>rej(new Error("subscription check timed out")), 8000))
        ]);
        if(error){
          if(attempt<delays.length-1) continue; // genuine error — worth another try
          // Every attempt failed. Before giving up and showing the banner, try the same
          // one-shot recovery already used at cold-launch (see attemptAuthRecovery) — a
          // check that hangs on EVERY attempt rather than failing once and succeeding on
          // retry is the signature of the stuck-lock issue, not a transient network blip.
          if(attemptAuthRecovery())return "free"; // page is reloading — nothing else to do
          setTierCheckFailed(true); setTier("free"); setTrialExpired(null); setTierChecking(false);
          setTierDebug({uid:id, attempt:attempt+1, error:error.message||String(error), data:null});
          return "free";
        }
        // A successful response (row found, no row, canceled, whatever) proves the
        // auth/lock path is healthy again — clear the recovery counter so a LATER
        // genuinely stuck check still gets its own fresh tiers instead of silently
        // being skipped because an earlier, unrelated recovery already used them up.
        try{ sessionStorage.removeItem("gc_auth_recover_attempted"); }catch(e){}
        setTierChecking(false);
        if(!data || data.status==="canceled"){
          setTierCheckFailed(false); setTier("free"); setTrialExpired(null);
          setTierDebug({uid:id, attempt:attempt+1, error:null, data, note: !data?"no subscriptions row for this user_id":"status=canceled"});
          return "free";
        }
        // Time-limited comped access (e.g. a 30-day trial code) reuses current_period_end,
        // the same column real Stripe subscriptions use for their billing period end. Gated
        // strictly on is_comped so a webhook-lag false-positive can never lock out a real
        // paying subscriber — is_comped is only ever true for complimentary/trial accounts.
        if(data.is_comped && data.current_period_end && new Date(data.current_period_end) < new Date()){
          setTierCheckFailed(false); setTier("free"); setTrialExpired({tier:data.tier||"guide_pro", expiredAt:data.current_period_end});
          setTierDebug({uid:id, attempt:attempt+1, error:null, data, note:"comp expired"});
          return "free";
        }
        setTierCheckFailed(false); setTrialExpired(null);
        const t = data.tier || "free";
        setTier(t);
        setTierDebug({uid:id, attempt:attempt+1, error:null, data, note:"ok"});
        return t;
      }catch(e){
        if(attempt<delays.length-1) continue;
        if(attemptAuthRecovery())return "free"; // page is reloading — nothing else to do
        setTierCheckFailed(true); setTier("free"); setTierChecking(false);
        setTierDebug({uid:id, attempt:attempt+1, error:e.message||String(e), data:null, note:"threw"});
        return "free";
      }
    }
    })();
    inFlightTierCheck.current = {id, promise: runCheck};
    runCheck.finally(()=>{
      if(inFlightTierCheck.current && inFlightTierCheck.current.promise===runCheck) inFlightTierCheck.current = null;
    });
    return runCheck;
  }, [user]);
  // One-time complimentary-access redemption for a code stored on the auth user at
  // signup (see AuthScreen). Only fires while the caller is still on the free tier —
  // once comped/subscribed, refreshTier will no longer report "free" so this becomes
  // a permanent no-op. Best-effort: a failure here just leaves the user on free tier
  // (same as never having had a code), it never blocks sign-in.
  // Shared redemption path — used both for the automatic signup-time redemption below
  // and for a manual "Have a code?" entry from an already-signed-in user (Settings).
  // Server-side (redeem-invite.js) is the actual authority on validity/eligibility;
  // this is just the client plumbing, so it's safe to call from either caller.
  async function redeemInviteCode(code, sessionOverride){
    const trimmed = String(code||"").trim();
    if(!trimmed || !sb) return {ok:false, reason:"no_code"};
    try{
      // Prefer a session handed to us directly (e.g. from an onAuthStateChange event)
      // over calling sb.auth.getSession() again ourselves. Re-querying getSession()
      // immediately after an auth event is a known Supabase JS footgun — it can race
      // the library's internal session lock and resolve with no session at all, even
      // though the caller is clearly signed in. That silently killed signup-time invite
      // redemption (App Dev — TRIAL30 investigation): the code was correct, the user was
      // signed in, but this re-query returned null, so the redeem call never fired.
      let token = sessionOverride?.access_token;
      if(!token){
        const {data:{session:fresh}} = await sb.auth.getSession();
        token = fresh?.access_token;
      }
      if(!token) return {ok:false, reason:"not_signed_in"};
      const res = await fetch("/api/redeem-invite", {
        method:"POST",
        headers:{"Content-Type":"application/json", Authorization:"Bearer "+token},
        body: JSON.stringify({code:trimmed})
      });
      const d = await res.json().catch(()=>null);
      if(d && d.ok && d.tier){ setTier(d.tier); return {ok:true, tier:d.tier, expiresAt:d.expiresAt}; }
      if(!res.ok) return {ok:false, reason:"error", message:d?.error?.message};
      return {ok:false, reason:d?.reason||"unknown"};
    }catch(e){ return {ok:false, reason:"error", message:e.message}; }
  }
  async function maybeRedeemInvite(session, currentTier){
    const code = session?.user?.user_metadata?.invite_code;
    if(!code || currentTier!=="free") return;
    const r = await redeemInviteCode(code, session);
    // Log every failure reason, not just "error" — a silently-swallowed not_signed_in
    // or not_a_comp_code result is exactly what made this bug invisible the first time.
    if(!r.ok) console.error("Invite redemption failed:", r.reason, r.message||"");
    setAutoRedeemNotice(r.ok ? {ok:true, tier:r.tier} : {ok:false, reason:r.reason, message:r.message||""});
  }
  useEffect(()=>{
    if(!sb){ setLoading(false); return; }
    // A slow/stuck getSession() here — not just a slightly slow network, but the "shows
    // the wrong tier/paywall for a while, then corrects itself" pattern Adam reported — is
    // the same suspected root cause as the signOut() hang below: Supabase client internal
    // auth-lock contention (a stale lock left behind by a previous killed/backgrounded tab
    // blocking a fresh page's attempt to read/refresh the session). Adam found that
    // signing out and back in always fixes it; that works because sign-out wipes the
    // local session and reloads, which clears any stuck lock tied to the old page context.
    // Reusing attemptAuthRecovery() here — same tiered reload logic now shared with
    // refreshTier's own recovery path below — so a stuck cold launch recovers on its own
    // instead of requiring Adam to notice and do it by hand.
    const timeout = setTimeout(()=>{
      if(attemptAuthRecovery())return;
      setLoading(false);
    }, 8000);
    sb.auth.getSession().then(async ({data:{session}})=>{
      clearTimeout(timeout);
      try{ sessionStorage.removeItem("gc_auth_recover_attempted"); }catch(e){}
      if(session?.user){ setUser(session.user); const t0=await refreshTier(session.user.id); maybeRedeemInvite(session, t0); setLoading(false); return; }
      // Public demo link: ?demo=1 with no existing session logs into a single
      // shared demo account (cloned from the real account's data) rather than
      // provisioning a fresh anonymous account per visitor. Only fires once
      // per browser — a returning demo visitor reuses their existing session.
      const isDemo = new URLSearchParams(window.location.search).get("demo")==="1";
      if(isDemo){
        try{
          const {data,error} = await sb.auth.signInWithPassword({email:"demo@guideschoicefishing.com", password:"password1"});
          if(error) throw error;
          setUser(data?.user ?? null);
          if(data?.user){ const t0=await refreshTier(data.user.id); maybeRedeemInvite({user:data.user}, t0); }
        }catch(e){
          setDemoError(e.message||"Demo sign-in failed.");
        }
      }
      setLoading(false);
    }).catch(()=>{ clearTimeout(timeout); setLoading(false); });
    const {data:{subscription}} = sb.auth.onAuthStateChange(async (event,session)=>{
      setUser(session?.user ?? null);
      if(!session?.user){ setTier("free"); setTierChecking(false); return; }
      // INITIAL_SESSION fires once on every page load whenever a session already
      // exists — the mount effect just above (the direct sb.auth.getSession() call)
      // already runs its own refreshTier for that exact same session, so responding
      // here too used to fire two concurrent subscription checks racing each other
      // right at load/sign-in. TOKEN_REFRESHED fires periodically as the access
      // token silently auto-renews and doesn't mean the tier itself changed — no
      // reason to hit the DB again for it. Every other event (SIGNED_IN — an actual
      // interactive sign-in, USER_UPDATED, etc.) still gets a real check.
      if(event==="INITIAL_SESSION"||event==="TOKEN_REFRESHED")return;
      const t0=await refreshTier(session.user.id); maybeRedeemInvite(session, t0);
    });
    // Re-check the tier whenever the app/tab comes back to the foreground — covers a
    // PWA that was backgrounded (not freshly launched) whose last tier check happened
    // to fail. Cheap (one query) and only fires while someone's actually signed in.
    function onVisible(){
      if(document.visibilityState==="visible" && sb.auth.getSession){
        // This is the resume-triggered self-heal for exactly the "tier looks stale/wrong
        // after being backgrounded a while" scenario — so it needs the same hang
        // protection as refreshTier's query. getSession() can itself need a network round
        // trip (refreshing an expired access token) and can hang the same way if that
        // request was in flight when the app got backgrounded again or the connection
        // stalled. If this getSession() call hangs unprotected, refreshTier below never
        // even gets called on resume, leaving a full manual sign-out/sign-in as the only
        // way to force a truly fresh auth flow — which matches the reported symptom.
        Promise.race([
          sb.auth.getSession(),
          new Promise((_,rej)=>setTimeout(()=>rej(new Error("resume session check timed out")), 8000))
        ]).then(({data:{session}})=>{ if(session?.user) refreshTier(session.user.id); })
          .catch((e)=>{ console.error("Resume session check failed/timed out:", e?.message||e); });
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    return ()=>{ subscription.unsubscribe(); clearTimeout(timeout); document.removeEventListener("visibilitychange", onVisible); };
  },[]);
  return {user, loading, demoError, tier, trialExpired, refreshTier, redeemInviteCode, autoRedeemNotice, setAutoRedeemNotice, tierCheckFailed, tierDebug, tierChecking};
}

// ── Login / Signup Screen ─────────────────────────────────────────────────────
function AuthScreen({demoError, promptReason, compact}){
  const [returningUser, setReturningUser] = useLocalStorage("tl_returning_user", false);
  const [mode, setMode] = useState(returningUser ? "login" : "signup"); // defaults to signup for first-time visitors, login once this device has signed in before
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [tempPoints, setTempPoints] = useState([]);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function handleSubmit(){
    setError(""); setSuccess(""); setLoading(true);
    try{
      if(!sb){ setError("Supabase not configured. Add your project URL and anon key to the app."); setLoading(false); return; }
      if(mode==="signup"){
        const code = inviteCode.trim();
        if(!agreed){ setError("Please agree to the Terms and Privacy Policy to continue."); setLoading(false); return; }
        if(code){
          const {data:codeRow, error:codeErr} = await sb.from("invite_codes").select("active").eq("code", code).maybeSingle();
          if(codeErr){ setError("Couldn't verify invite code. Please try again."); setLoading(false); return; }
          if(!codeRow || codeRow.active===false){ setError("Invalid or inactive invite code."); setLoading(false); return; }
        }
        // Confirmed App Dev 30 (Adam tested live): this Supabase project has email
        // confirmation DISABLED, so signUp() returns a live session immediately and no
        // confirmation email is ever sent. useAuth's onAuthStateChange listener picks up
        // that session and swaps AuthScreen out for the main app automatically — usually
        // before this message is even visible. It's kept as a brief transition message
        // and a same-screen fallback (mode stays on login, fields still filled) for the
        // rare case that auto-transition is slow or doesn't fire.
        const{error:e} = await sb.auth.signUp({email, password, options:{data:{full_name:name, invite_code:code||null}}});
        if(e) throw e;
        // Meta Pixel: signup conversion. Guarded so a blocked/absent fbq never breaks signup.
        try{ if(typeof window!=="undefined" && typeof window.fbq==="function") window.fbq("track","CompleteRegistration"); }catch(_){}
        setReturningUser(true);
        setSuccess("Account created — signing you in…");
        setMode("login");
      } else if(mode==="login"){
        const{error:e} = await sb.auth.signInWithPassword({email, password});
        if(e) throw e;
        setReturningUser(true);
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
    <div style={compact
      // Overlay mode: the modal must never exceed the viewport, so it caps at 88vh and
      // scrolls internally instead of running off the bottom of the screen. Background
      // is transparent because Root's overlay already supplies the dimmed backdrop.
      ? {maxHeight:"88vh",overflowY:"auto",WebkitOverflowScrolling:"touch",background:"transparent",display:"flex",flexDirection:"column",alignItems:"center",padding:0,boxSizing:"border-box"}
      : {height:"100%",overflowY:"auto",WebkitOverflowScrolling:"touch",background:"var(--deep)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"safe center",padding:24,boxSizing:"border-box"}}>
      <div style={{width:"100%",maxWidth:380}}>
        <div style={{textAlign:"center",marginBottom:compact?14:40}}>
          <Logo layout="stacked" scale={compact?0.42:1} />
        </div>
        <div style={{background:compact?"rgba(16,32,38,0.97)":"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:18,padding:compact?20:24}}>
          {demoError&&<div style={{background:"rgba(150,80,80,0.2)",border:"1px solid rgba(150,80,80,0.4)",borderRadius:10,padding:"10px 14px",fontSize:14,color:"var(--red)",marginBottom:14}}>Demo link couldn't sign you in automatically ({demoError}). Please contact support.</div>}
          {!demoError&&promptReason&&<div style={{background:"rgba(209,154,74,0.12)",border:"1px solid rgba(209,154,74,0.3)",borderRadius:10,padding:"10px 14px",fontSize:14,color:"var(--gold)",marginBottom:14,textAlign:"center"}}>{promptReason}</div>}
          <div style={{fontFamily:"var(--font-head)",fontSize:18,color:"var(--gold)",marginBottom:20,textAlign:"center"}}>
            {mode==="login"?"Welcome Back":mode==="signup"?"Create Account":"Reset Password"}
          </div>
          {mode==="signup"&&<>
            <label style={{display:"block",fontSize:14,letterSpacing:1.5,textTransform:"uppercase",color:"var(--stone)",marginBottom:5}}>Full Name</label>
            <input className="inp" placeholder="John Smith" value={name} onChange={e=>setName(e.target.value)}/>
            <label style={{display:"block",fontSize:14,letterSpacing:1.5,textTransform:"uppercase",color:"var(--stone)",marginBottom:5}}>Invite Code (optional)</label>
            <input className="inp" placeholder="Have a code? Enter it here" value={inviteCode} onChange={e=>setInviteCode(e.target.value)}/>
            <label style={{display:"flex",alignItems:"flex-start",gap:8,fontSize:13,color:"var(--stone)",margin:"10px 0",cursor:"pointer",lineHeight:1.4}}>
              <input type="checkbox" checked={agreed} onChange={e=>setAgreed(e.target.checked)} style={{marginTop:2,width:16,height:16,accentColor:"#d09a4a",cursor:"pointer",flexShrink:0}}/>
              <span>I agree to the <a href="/terms.html" target="_blank" rel="noreferrer" style={{color:"var(--sky)"}}>Terms</a> and <a href="/privacy.html" target="_blank" rel="noreferrer" style={{color:"var(--sky)"}}>Privacy Policy</a></span>
            </label>
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
              <button onClick={()=>{setMode("signup");setError("");}} style={{background:"none",border:"none",color:"var(--sky)",fontSize:15,cursor:"pointer",fontFamily:"var(--font-body)"}}>Create account</button>
              <button onClick={()=>{setMode("reset");setError("");}} style={{background:"none",border:"none",color:"var(--stone)",fontSize:15,cursor:"pointer",fontFamily:"var(--font-body)"}}>Forgot password?</button>
            </>}
            {mode!=="login"&&<button onClick={()=>{setMode("login");setError("");}} style={{background:"none",border:"none",color:"var(--sky)",fontSize:15,cursor:"pointer",fontFamily:"var(--font-body)"}}>← Back to sign in</button>}
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
// Free-text-with-suggestions field (SpeciesInput) draws from this list, but any
// typed value is accepted and saved as-is — this is a starting point, not a
// closed set, so it stays scalable to river systems anywhere in the US.
const SPECIES=["Brown Trout","Rainbow Trout","Brook Trout","Cutthroat Trout","Cutbow","Tiger Trout","Golden Trout","Lake Trout","Bull Trout","Dolly Varden","Splake","Steelhead","Chinook Salmon","Coho Salmon","Sockeye Salmon","Pink Salmon","Chum Salmon","Kokanee Salmon","Arctic Grayling","Mountain Whitefish","Largemouth Bass","Smallmouth Bass","Rock Bass","Spotted Bass","Bluegill","Crappie","Northern Pike","Muskellunge (Muskie)","Walleye","Yellow Perch","Channel Catfish","Carp"];

// Day-of-year median flow (P50) from the legacy USGS stat service — there is
// no day-of-year-median equivalent on the new api.waterdata.usgs.gov
// collections yet, so this intentionally still depends on waterservices.usgs.gov
// until USGS publishes one elsewhere. ONE call per gauge (not five — we only
// need the median to say above/about/below average, not a full percentile
// band). Fails open to null on any error or missing data; callers must treat
// null as "no historical baseline for this gauge," never substitute a guess.
// In-memory cache (per page-load) so the same gauge isn't re-queried across
// Conditions tab / Saved Gauges / Trip Planner within one session.
function cfsLabel(cfs){
  if(!cfs||isNaN(cfs))return{label:"No Data",cls:"fair"};
  // Show the raw flow number only — no judgment label, no color tier. A fixed
  // cfs cutoff can't tell a big river's normal flow from a small creek's flood,
  // and a historical-average comparison was dropped as not worth the per-gauge
  // network cost. Just the number.
  return{label:Math.round(cfs).toLocaleString()+" CFS",cls:""};
}
// Deterministic flow-vs-average comparison for the planner synth prompt (added
// after the App Dev 23 St. Vrain incident: the AI had no grounded signal for
// whether a flow reading was normal or a drought low, and guessed "moderate"
// for a river running well below its typical level). "avgCfs" is a last-year-
// same-period baseline (see fetchFlowAvgBatch) — a proxy, not a true multi-year
// median, but a real number rather than a guess. Returns null (no claim) if
// either value is missing/invalid — never guesses a label with no baseline.
function flowVsAverage(cfs,avgCfs){
  if(cfs==null||isNaN(cfs)||avgCfs==null||isNaN(avgCfs)||avgCfs<=0)return null;
  const pct=(cfs-avgCfs)/avgCfs;
  let label;
  if(pct<=-0.6)label="well below average";
  else if(pct<=-0.3)label="below average";
  else if(pct<0.3)label="about average";
  else if(pct<0.6)label="above average";
  else label="well above average";
  return{label,pct:Math.round(pct*100),avgCfs:Math.round(avgCfs)};
}
function fmtCoord(lat,lng){return`${Math.abs(lat).toFixed(4)}°${lat>=0?"N":"S"}, ${Math.abs(lng).toFixed(4)}°${lng>=0?"E":"W"}`;}
// Inverse of fmtCoord — also handles a plain "lat, lng" fallback. Shared parser so
// GPS-string-to-coordinates logic isn't reimplemented at each call site.
function parseGpsCoords(gpsStr){
  if(!gpsStr) return null;
  const dmsMatch=gpsStr.match(/([\d.]+)[°\s]*([NS])[\s,]+([\d.]+)[°\s]*([EW])/i);
  let lat,lng;
  if(dmsMatch){
    lat=parseFloat(dmsMatch[1])*(dmsMatch[2].toUpperCase()==="S"?-1:1);
    lng=parseFloat(dmsMatch[3])*(dmsMatch[4].toUpperCase()==="W"?-1:1);
  } else {
    const nums=gpsStr.match(/-?[\d.]+/g);
    if(!nums||nums.length<2) return null;
    lat=parseFloat(nums[0]);lng=parseFloat(nums[1]);
  }
  if(lat==null||lng==null||isNaN(lat)||isNaN(lng)) return null;
  return{lat,lng};
}
function extractJSON(text){
  const c=text.replace(/```json|```/g,"").trim();
  try{const m=c.match(/\{[\s\S]*\}/);if(m)return JSON.parse(m[0]);}catch{}
  try{const m=c.match(/\[[\s\S]*\]/);if(m)return JSON.parse(m[0]);}catch{}
  return null;
}
// repairJSON — last-resort recovery for an otherwise-complete report whose JSON
// has a character the strict parsers choke on: a raw newline/tab/CR inside a
// string value, a stray inner double-quote (e.g. a 9" leader), or a trailing
// comma. Lab-only for now (the deep-read that produces these verbose fields is
// lab-only). Fires ONLY after JSON.parse, the brace-slice, and extractJSON have
// all failed, so it can only turn an error into a success — never a regression.
// Known limitation: an un-escaped inner quote immediately followed by a , } ]
// is ambiguous and may not recover (returns null, never throws).
function repairJSON(text){
  if(!text) return null;
  let c=String(text).replace(/```json|```/g,"").trim();
  const s=c.indexOf("{"), e=c.lastIndexOf("}");
  if(s===-1||e<=s) return null;
  c=c.slice(s,e+1);
  try{return JSON.parse(c);}catch{}
  let out="", inStr=false;
  for(let i=0;i<c.length;i++){
    const ch=c[i];
    if(inStr){
      if(ch==="\\"){ out+=ch+(c[i+1]??""); i++; continue; }
      if(ch==="\n"){ out+="\\n"; continue; }
      if(ch==="\r"){ out+="\\r"; continue; }
      if(ch==="\t"){ out+="\\t"; continue; }
      if(ch==="\""){
        let j=i+1; while(j<c.length&&/\s/.test(c[j]))j++;
        const nx=c[j];
        if(nx===undefined||nx===":"||nx===","||nx==="}"||nx==="]"){ out+="\""; inStr=false; }
        else { out+="\\\""; }
        continue;
      }
      out+=ch; continue;
    } else {
      if(ch==="\""){ out+=ch; inStr=true; continue; }
      if(ch===","){
        let j=i+1; while(j<c.length&&/\s/.test(c[j]))j++;
        if(c[j]==="}"||c[j]==="]"){ continue; }
        out+=ch; continue;
      }
      out+=ch; continue;
    }
  }
  try{return JSON.parse(out);}catch{}
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

// Single gateway for ALL Anthropic calls. Attaches the user's Supabase session token
// (the server rate-limits per user) and a usage_kind ("planner" counts against the
// 5/day planner limit; everything else is "cheap", 50/day). Surfaces daily-limit
// errors with the server's friendly message. Returns the parsed API response.
async function aiFetch(body, kind="cheap", opts={}){
  let auth={};
  try{
    if(sb){const {data}=await sb.auth.getSession();const t=data&&data.session&&data.session.access_token;if(t)auth={Authorization:"Bearer "+t};}
  }catch(e){void 0;}
  const res=await fetch("/api/claude",{method:"POST",signal:opts.signal,headers:{"Content-Type":"application/json",...auth},body:JSON.stringify({...body,usage_kind:kind})});
  if(res.status===429||res.status===401){
    let d=null;try{d=await res.json();}catch(e){void 0;}
    const msg=(d&&d.error&&(d.error.message||(typeof d.error==="string"?d.error:null)))||(res.status===429?"Daily AI limit reached — it resets daily.":"Please sign in to use AI features.");
    const err=new Error(msg);err.isLimit=res.status===429;throw err;
  }
  let d;try{d=await res.json();}catch(e){throw new Error("API request failed.");}
  if(d.error)throw new Error(d.error.message||(typeof d.error==="string"?d.error:"API error"));
  return d;
}
// ── Subscription tiers ───────────────────────────────────────────────────────
// Display info for paid tiers, and which tiers unlock which tabs. Guide Pro is a
// superset (includes AI trip planning + the CRM tools) — a guide paying more should
// never end up with less than a Consumer Pro angler.
const TIER_INFO = {
  consumer_pro: { name:"Consumer Pro", price:"$4.99/mo", priceAnnual:"$49.99/yr", blurb:"Full AI trip predictions — hatch windows, best times, fly recommendations, and more for any river." },
  guide_pro: { name:"Guide Pro", price:"$19.99/mo", priceAnnual:"$199.00/yr", blurb:"Everything in Consumer Pro, plus the full Guide CRM — client logs, trip history, and season trends." }
};
const PLAN_TIERS = new Set(["consumer_pro","guide_pro","fly_shop_basic","fly_shop_pro"]);
const GUIDE_TIERS = new Set(["guide_pro"]);

// Starts a Stripe Checkout session for the given tier and redirects to it.
// Same session-token gateway pattern as aiFetch, so auth handling stays in one place.
async function startCheckout(tier,billing="monthly"){
  let auth={};
  try{
    if(sb){const {data}=await sb.auth.getSession();const t=data&&data.session&&data.session.access_token;if(t)auth={Authorization:"Bearer "+t};}
  }catch(e){void 0;}
  const res=await fetch("/api/create-checkout-session",{method:"POST",headers:{"Content-Type":"application/json",...auth},body:JSON.stringify({tier,billing})});
  let d;try{d=await res.json();}catch(e){throw new Error("Could not start checkout.");}
  if(d.error) throw new Error(d.error.message||"Could not start checkout.");
  if(d.url) window.location.href=d.url; else throw new Error("Checkout session did not return a URL.");
}

// Opens Stripe's own hosted Customer Portal — cancel, swap payment method, view invoices.
// Deliberately not custom-built: Stripe's portal handles proration/cancellation edge cases
// correctly out of the box, which a hand-rolled version would risk getting wrong.
async function startPortal(){
  let auth={};
  try{
    if(sb){const {data}=await sb.auth.getSession();const t=data&&data.session&&data.session.access_token;if(t)auth={Authorization:"Bearer "+t};}
  }catch(e){void 0;}
  const res=await fetch("/api/create-portal-session",{method:"POST",headers:{"Content-Type":"application/json",...auth}});
  let d;try{d=await res.json();}catch(e){throw new Error("Could not open the billing portal.");}
  if(d.error) throw new Error(d.error.message||"Could not open the billing portal.");
  if(d.url) window.location.href=d.url; else throw new Error("Portal session did not return a URL.");
}

// Monthly/Annual switcher, shared by every upgrade entry point (paywall, trial-expired
// banner, Settings) so the toggle looks and behaves identically everywhere.
function BillingToggle({billing,onChange}){
  return(
    <div style={{display:"flex",gap:6,marginBottom:14}}>
      {[["monthly","Monthly"],["annual","Annual — save ~17%"]].map(([b,label])=>(
        <button key={b} onClick={()=>onChange(b)}
          style={{flex:1,padding:"8px 10px",borderRadius:8,fontSize:13,cursor:"pointer",fontFamily:"var(--font-body)",fontWeight:billing===b?600:400,
            background:billing===b?"var(--gold)":"rgba(255,255,255,0.08)",
            color:billing===b?"#0c1e25":"var(--foam)",
            border:billing===b?"1px solid var(--gold)":"1px solid rgba(255,255,255,0.15)"}}>
          {label}
        </button>
      ))}
    </div>
  );
}

// Locked-tab paywall — shown in place of a feature the user's current tier doesn't include.
function UpgradeLock({tierKey, featureLabel}){
  const info = TIER_INFO[tierKey];
  const [busy,setBusy]=useState(false);
  const [err,setErr]=useState("");
  const [billing,setBilling]=useState("monthly");
  // Returning from Stripe via the browser's back button often restores this page from
  // the back-forward cache rather than reloading it — React state (including "busy")
  // stays frozen exactly as it was when the redirect happened. Reset it on restore.
  useEffect(()=>{
    const onPageShow=(e)=>{ if(e.persisted) setBusy(false); };
    window.addEventListener("pageshow",onPageShow);
    return ()=>window.removeEventListener("pageshow",onPageShow);
  },[]);
  const priceLabel = billing==="annual"&&info.priceAnnual ? info.priceAnnual : info.price;
  return(
    <div style={{textAlign:"center",padding:"60px 24px",maxWidth:420,margin:"0 auto"}}>
      <div style={{fontSize:40,marginBottom:14}}>🔒</div>
      <div style={{fontFamily:"var(--font-head)",fontSize:20,color:"var(--gold)",marginBottom:10}}>{featureLabel} is a {info.name} feature</div>
      <div style={{fontSize:15,color:"var(--stone)",lineHeight:1.6,marginBottom:20}}>{info.blurb}</div>
      {info.priceAnnual&&<BillingToggle billing={billing} onChange={setBilling}/>}
      {err&&<div style={{background:"rgba(150,80,80,0.2)",border:"1px solid rgba(150,80,80,0.4)",borderRadius:10,padding:"10px 14px",fontSize:14,color:"var(--red)",marginBottom:14}}>{err}</div>}
      <button disabled={busy} onClick={async()=>{setBusy(true);setErr("");try{await startCheckout(tierKey,billing);}catch(e){setErr(e.message);setBusy(false);}}}
        style={{background:"var(--gold)",border:"none",borderRadius:10,padding:"12px 28px",color:"#0c1e25",fontSize:16,fontWeight:600,cursor:busy?"default":"pointer",opacity:busy?0.7:1,fontFamily:"var(--font-body)"}}>
        {busy?"Starting checkout…":`Upgrade to ${info.name} — ${priceLabel}`}
      </button>
    </div>
  );
}

// Neutral placeholder shown instead of UpgradeLock while a subscription check is still
// in flight (see tierChecking on the App component) — avoids flashing the "upgrade to
// unlock" paywall at a paying customer for however long the check legitimately takes,
// whether that's a fraction of a second (the normal case) or several seconds (the
// slow/stuck-check scenarios this session's other fixes address).
function CheckingPlan(){
  return(
    <div style={{textAlign:"center",padding:"60px 24px",maxWidth:420,margin:"0 auto"}}>
      <div style={{fontSize:15,color:"var(--stone)",fontStyle:"italic",animation:"pulse 1.5s infinite"}}>Checking your plan…</div>
    </div>
  );
}

async function askClaude(prompt, useSearch=false, maxTokens=1200, kind="cheap", useFetch=false){
  const body={model:useSearch?"claude-sonnet-4-6":"claude-haiku-4-5-20251001",max_tokens:maxTokens,messages:[{role:"user",content:prompt}]};
  if(useSearch){body.tools=[{type:"web_search_20250305",name:"web_search",max_uses:2}];if(useFetch)body.tools.push({type:"web_fetch_20250910",name:"web_fetch",max_uses:3});}
  const d=await aiFetch(body,kind);
  // Handle tool use responses - extract all text blocks including after tool results
  const texts=(d.content||[]).map(b=>b.type==="text"?b.text:b.type==="tool_result"?(Array.isArray(b.content)?b.content.map(x=>x.text||"").join(""):b.content||""):"").filter(Boolean);
  return texts.join(" ");
}
// Grounded, guide-voice "what's working" intel — shared by the angler's personal Log
// Trip detail and the Guide CRM's per-client trip detail. Same non-fabrication contract
// as GuideTrends' whole-book insight (below): every claim must trace back to actually-
// logged trips/catches, and thin history says so plainly instead of inventing a pattern.
// Haiku + no web search on purpose — this should be grounded ONLY in the angler's own
// data, not general fishing knowledge, and it's called on-demand so cost stays low.
async function generateTripIntel(subjectLabel, currentTrip, currentCatches, historyTrips){
  const hist=historyTrips.slice(0,40).map(t=>({
    date:t.date, location:t.location, skunked:!!t.skunked,
    catchCount:t.catches!=null?t.catches:0, species:t.species||[], flies:(t.flies||[]).slice(0,4),
    techniquesLogged:t.techniques||t.styles||[], cfs:t.streamCFS||null, condition:t.streamCondition||null,
    weather:t.weatherConditions||t.weatherDesc||null, airTemp:t.airTemp||null, anglerNotes:t.notes||t.guideNotes||null
  }));
  // Species/flies/time/length ARE genuinely linked per catch — pass the real per-catch
  // list instead of a flattened trip-wide dedup, so the model has actual joined facts to
  // reason from instead of two parallel lists it has to guess a correspondence between.
  const catchList=(currentCatches||[]).map(c=>({
    species:c.species||null, length:c.length||null, flies:c.flies||[], time:c.time||null,
    airTemp:c.airTemp||null, streamCFS:c.streamCFS||null, weather:c.weatherDesc||null
  }));
  const cur={
    date:currentTrip.date, location:currentTrip.location, skunked:!!currentTrip.skunked,
    techniquesLogged:currentTrip.techniques||currentTrip.styles||[], flies:currentTrip.flies||[],
    cfs:currentTrip.streamCFS||null, condition:currentTrip.streamCondition||null,
    weather:currentTrip.weatherConditions||currentTrip.weatherDesc||null, airTemp:currentTrip.airTemp||null,
    anglerNotes:currentTrip.notes||currentTrip.guideNotes||null,
    catches:catchList
  };
  const month=new Date((currentTrip.date||new Date().toISOString().split("T")[0])+"T12:00:00").toLocaleDateString("en-US",{month:"long"});
  const prompt=`You are an experienced fly fishing guide giving ${subjectLabel} honest, specific intel after a day on the water.

STRICT GROUNDING RULES:
- Every species, length, fly, and result you mention must come from the logged data below — never invent one.
- "techniquesLogged" and the top-level "flies" list are recorded for the WHOLE TRIP only — they are NOT linked to specific catches or to each other. The "catches" array is the only place flies are actually tied to a specific fish. NEVER state or imply a specific fly was fished "under" a specific technique (e.g. never say "X and Y under Euro nymphing") unless that link is explicit in the data.
- "anglerNotes" is free text the angler typed and often names flies, rigs, or a rough sequence of events in prose — it is real and you should draw on it for color and detail. But do NOT convert a fly mentioned only in anglerNotes into a specific timestamped claim (like "landed four on it between 7:55 and 9:44 AM") unless that catch's own "flies" field in the "catches" array actually contains that fly. If a catch's "flies" is empty, describe that catch by species/length/time only, and separately mention what anglerNotes says about flies/rigs as the angler's own account rather than as a verified per-fish fact.
- "weather" fields are auto-estimated from a public weather API for a rough time/location, not measured on the water — they can be wrong. anglerNotes is the more reliable source; if the two conflict, trust anglerNotes.
- NEVER state or imply a specific weather event (rain, drizzle, snow, storm) happened unless that word is literally present in anglerNotes or a weather field. Do not infer precipitation from a change in sky condition, temperature, or flow alone.
- You SHOULD use real fly-fishing expertise to explain WHY results happened, tied to the actual conditions and time of day in the data — but only reasoning FROM logged facts, never adding facts that aren't there.
- If there isn't enough trip history to see a real repeating pattern yet, say that plainly instead of guessing.

THIS TRIP (${month}):
${JSON.stringify(cur)}

FULL TRIP HISTORY (${hist.length} prior trips, most recent first):
${JSON.stringify(hist)}

Give intel in this exact shape:
1. WHAT WORKED TODAY: What actually happened, grounded in the real per-catch data (species, length, time, and any catch-linked flies) plus relevant color from anglerNotes, tied to time of day/conditions where the data supports it.
2. THE PATTERN: The single clearest repeating factor across ALL logged trips (fly, flow range, time of year, technique) tied to good days. Say "not enough history yet" if under ~3 trips.
3. NEXT TIME: One concrete, actionable suggestion for the next trip, tied directly to the data above.

Direct, guide-to-angler tone. Use the real detail that's actually in the data — a trip with rich notes and several catches earns a fuller writeup than a sparse one, but never pad with generic advice that isn't tied to this data, and never invent a fly-to-catch pairing that isn't in "catches".`;
  return await askClaude(prompt,false,900,"cheap");
}

// Deterministic aggregation across the angler's own logged catches — feeds the Trip
// Planner's light-touch "Based on your trips" note (buildPersonalAngle in
// tripPlannerPipeline.js). Pure aggregation only, no AI call — nothing here can
// hallucinate, it just tells the pipeline what's actually in the data.
function buildAnglerHistorySummary(personalTrips, catches){
  if(!catches||catches.length<3) return null;
  const flyCounts={};
  catches.forEach(c=>(c.flies||[]).forEach(f=>{flyCounts[f]=(flyCounts[f]||0)+1;}));
  const topFlies=Object.entries(flyCounts).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([f])=>f);
  const speciesCounts={};
  catches.forEach(c=>{if(c.species&&c.species!=="Unidentified") speciesCounts[c.species]=(speciesCounts[c.species]||0)+1;});
  const topSpecies=Object.entries(speciesCounts).sort((a,b)=>b[1]-a[1])[0]?.[0]||null;
  const cfsVals=catches.map(c=>parseFloat(c.streamCFS)).filter(v=>!isNaN(v)&&v>0);
  let cfsRange=null;
  if(cfsVals.length>=3){
    const sorted=[...cfsVals].sort((a,b)=>a-b);
    cfsRange={low:Math.round(sorted[0]),high:Math.round(sorted[sorted.length-1])};
  }
  return {topFlies,topSpecies,cfsRange,catchCount:catches.length,tripCount:(personalTrips||[]).length};
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
  // hourly= added 2026-08-16 for the Weather tab's hour-by-hour strip. Same call the
  // daily forecast already used — one extra query string, not a second fetch — so every
  // caller of this shared function (Weather tab, trip planner, background email path)
  // gets hourly data for free. Open-Meteo returns hourly out to the same forecast_days
  // window already requested below, so it's available for all 7 days shown, not just today.
  const url=`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,surface_pressure,uv_index&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,surface_pressure_mean,uv_index_max,relative_humidity_2m_mean&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=7`;
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

// Resolves "today" and "the current hour" IN THE FORECAST LOCATION'S OWN TIMEZONE, not
// the device's. Matters when checking weather for a trip somewhere other than where the
// person currently is — Open-Meteo's timezone=auto already resolves tz per-location
// (returned as data.timezone); this just reads the clock in that same zone so "today" and
// "now" in the hourly strip line up with the location's dates, not the phone's.
// Loads a user's saved gauges ordered by sort_order (manual "My Gauges" order, added
// 2026-08-16), lazily backfilling sort_order — once — for any rows saved before manual
// ordering existed. Shared by the consumer Streams tab's My Gauges AND the Guide CRM's
// My Gauges: both read/write the exact same saved_gauges rows (filtered only by
// user_id, no per-screen distinction), just rendered on two different screens. One
// shared loader means the backfill only ever needs to run once, whichever screen a
// person opens first, and a future fix to this logic only has one place to land.
async function loadSavedGaugesOrdered(userId){
  if(!sb||!userId) return [];
  const{data,error}=await sb.from("saved_gauges").select("*").eq("user_id",userId).order("sort_order",{ascending:true,nullsFirst:false});
  if(error||!data) return [];
  const needsBackfill=data.some(g=>g.sort_order==null);
  if(!needsBackfill) return data;
  const withOrder=data.map((g,i)=>g.sort_order==null?{...g,sort_order:i}:g);
  withOrder.forEach((g,i)=>{if(data[i]?.sort_order==null) sb.from("saved_gauges").update({sort_order:g.sort_order}).eq("id",g.id).then(()=>{});});
  return withOrder;
}
// Swaps two adjacent saved-gauge entries' sort_order, in local state (via the caller's
// own setter, functional-update form so a fast double-tap can't race stale state) and in
// Supabase. Shared for the same reason as loadSavedGaugesOrdered above. direction: -1 up,
// +1 down.
function moveSavedGaugeCore(setList,userId,id,direction){
  setList(gs=>{
    const idx=gs.findIndex(g=>g.id===id);
    if(idx<0) return gs;
    const swapIdx=idx+direction;
    if(swapIdx<0||swapIdx>=gs.length) return gs;
    const a=gs[idx],b=gs[swapIdx];
    const aOrder=a.sort_order??idx,bOrder=b.sort_order??swapIdx;
    const next=[...gs];
    next[idx]={...b,sort_order:aOrder};
    next[swapIdx]={...a,sort_order:bOrder};
    if(sb&&userId&&!String(userId).startsWith("local")){
      Promise.all([
        sb.from("saved_gauges").update({sort_order:aOrder}).eq("id",b.id).select(),
        sb.from("saved_gauges").update({sort_order:bOrder}).eq("id",a.id).select(),
      ]).then(([r1,r2])=>{
        if(!r1.data?.length||!r2.data?.length) console.warn("[Saved Gauges] reorder didn't persist — check the saved_gauges UPDATE RLS policy");
      });
    }
    return next;
  });
}

function localDateHourAt(tz){
  try{
    const parts=new Intl.DateTimeFormat("en-CA",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",hour12:false}).formatToParts(new Date());
    const get=t=>parts.find(p=>p.type===t)?.value;
    let hour=parseInt(get("hour"),10);
    if(hour===24)hour=0; // some ICU builds report midnight as "24" with hour12:false
    return {date:`${get("year")}-${get("month")}-${get("day")}`,hour};
  }catch{
    const n=new Date();
    return {date:`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-${String(n.getDate()).padStart(2,"0")}`,hour:n.getHours()};
  }
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

// Deterministic, plain-language fishing read for a selected forecast day.
// Uses ONLY the daily fields already fetched from Open-Meteo. States only
// well-established weather->trout effects; goes quiet on weak signals and
// returns a neutral baseline when nothing notable fires. No AI call, no
// fabricated precision (no barometric "bite windows," no bite score). This is
// the SINGLE place heat-as-a-factor is decided for the weather tab.
// d = data.daily object; sel = selected day index.
function weekWeatherRead(d, sel){
  if(!d || sel==null || !d.time || sel>=d.time.length) return null;
  const code = d.weather_code?.[sel];
  const hi = d.temperature_2m_max?.[sel];
  const lo = d.temperature_2m_min?.[sel];
  const rain = d.precipitation_probability_max?.[sel] ?? 0;
  const wind = d.wind_speed_10m_max?.[sel];
  const gust = d.wind_gusts_10m_max?.[sel];
  const prevHi = sel>0 ? d.temperature_2m_max?.[sel-1] : null;
  const prevCode = sel>0 ? d.weather_code?.[sel-1] : null;
  const pres = d.surface_pressure_mean?.[sel];
  const prevPres = sel>0 ? d.surface_pressure_mean?.[sel-1] : null;

  const clauses = [];
  let usedSafety=false;

  // 1. Thunderstorm / severe — safety first, always leads if present.
  if(code!=null && code>=95){
    clauses.push("Storms in the forecast — keep an eye on the radar and get off the water at the first sign of lightning.");
    usedSafety=true;
  }

  // 2. Blowout risk — heavy rain likely to bump flows and cloud the water.
  const heavyRainCode = code===65||code===81||code===82||code===63;
  if(!usedSafety && rain>=70 && heavyRainCode){
    clauses.push("Heavy rain is likely — flows may rise and the water could cloud up, so fish early or have a backup plan.");
  } else if(rain>=70 && heavyRainCode){
    clauses.push("Heavy rain may bump flows and reduce clarity.");
  }

  // 3. Heat — the single thermal-stress read for this tab (subsumes old advisory).
  if(hi!=null && hi>=85){
    clauses.push("Warm day ahead — fish early and check water temps by midday; trout get stressed in warm water, so consider resting the fishery in the afternoon heat.");
  }
  // 4. Cold / sharp cooldown — fish sluggish, slow the presentation.
  else if(hi!=null && hi<45){
    clauses.push("Cold day — expect a slower bite; fish deeper and slower, and look for midday warmth.");
  } else if(hi!=null && prevHi!=null && (prevHi-hi)>=18){
    clauses.push("Sharp cooldown from yesterday — fish may be off; slow your presentation and don't expect a fast bite.");
  }

  // 5. Wind — casting difficulty.
  if(gust!=null && gust>=25){
    clauses.push("Gusty winds will make casting tough — look for sheltered runs and bring heavier flies.");
  } else if(wind!=null && wind>=18){
    clauses.push("Breezy day — casting may be a challenge in open water; sheltered banks will fish easier.");
  }

  // 6. & 7. Bite-quality reads — only if no heavier factor already dominates.
  if(clauses.length===0){
    const overcast = code===3||code===45||code===48||code===2;
    const bluebird = code===0||code===1;
    const presRising = pres!=null && prevPres!=null && (pres-prevPres)>1.5;
    const cloudyPrior = prevCode!=null && (prevCode>=2);
    if(overcast && hi!=null && hi>=50 && hi<85 && rain<50){
      clauses.push("Overcast and mild — often good conditions for active fish; streamers and searching patterns are worth a try.");
    } else if(bluebird && presRising && cloudyPrior){
      clauses.push("Bright, high-pressure day following cloudier weather — fish can be spooky, so go lighter on tippet and smaller on flies.");
    }
  }

  // Neutral baseline — box always shows something rather than looking broken.
  if(clauses.length===0){
    return "No major weather factors standing out — fairly typical conditions for the day.";
  }
  // Cap at two clauses so it stays a high-level summary, safety always kept first.
  return clauses.slice(0,2).join(" ");
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


// ============ MODERNIZED USGS DATA LAYER (api.waterdata.usgs.gov) ============
// Legacy waterservices.usgs.gov degrades Aug 2026, dies Q1 2027.
// Strategy: new API first; if a gauge has no fresh data there (USGS backfill
// is incomplete — e.g. 07087200 live on legacy, dead on new), fall back to legacy.
// All helpers return LEGACY-SHAPED objects so existing consumers don't change.
var USGS_NW="https://api.waterdata.usgs.gov/ogcapi/v0/collections";
var NW_STALE_MS=24*60*60*1000; // ignore "latest" readings older than 24h (new API can return decades-old values)

async function nwGet(url){
  try{var r=await fetch(url);if(!r.ok)return null;return await r.json();}catch{return null;}
}

// Nationwide gauge lookup by name. The USGS OGC API supports server-side name filtering
// (CQL, filter-lang=cql-text — verified live 2026-07-28; note "cql2-text" is rejected),
// so this needs NO geographic box at all: every word in the query must appear somewhere
// in the site name, matched across the entire country. That's what lets the picker stop
// bounding results to a radius around wherever the person happens to be standing —
// searching for a gauge in another state now just works, same as one down the road.
// Single quotes are stripped from tokens since they'd terminate a CQL string literal.
// Fetch a USGS URL directly from the browser, falling back to this app's own server
// proxy if that fails. USGS rate-limits by client and returns 429 to the browser once
// the app's other gauge traffic (nwLocations/nwLatest, which fire on load and refresh)
// has used the budget — confirmed live 2026-07-28. Requests through /api/claude
// originate from the server instead, dodging that per-client ceiling; this is the same
// proxy pattern already used elsewhere in this file for external gauge endpoints.
// Throws on total failure rather than returning null, so callers can surface a real
// error instead of silently rendering an empty or partial list.
async function nwGetResilient(url){
  var lastErr="";
  try{
    var r=await fetch(url);
    if(r.ok) return await r.json();
    lastErr="USGS "+r.status;
  }catch(e){ lastErr=e?.message||"network error"; }
  try{
    var pr=await fetch("/api/claude",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({proxy_url:url})});
    if(pr.ok){
      var pd=await pr.json();
      if(pd&&!pd.error) return pd;
      lastErr=(pd&&pd.error)||lastErr;
    } else lastErr="proxy "+pr.status+(lastErr?" after "+lastErr:"");
  }catch(e){ lastErr=(e?.message||"proxy error")+(lastErr?" after "+lastErr:""); }
  throw new Error(lastErr||"search unavailable");
}

async function nwSearchByName(query,limit=300){
  var tokens=String(query||"").split(/\s+/).map(function(t){return t.replace(/'/g,"").trim();}).filter(Boolean).slice(0,6);
  if(!tokens.length) return [];
  var cql=tokens.map(function(t){return "monitoring_location_name LIKE '%"+t.toUpperCase()+"%'";}).join(" AND ");
  // properties= trims the response to just the fields used here: measured live
  // (2026-07-28) at 217KB -> 51KB for an 88-match query, with geometry still included.
  var url=USGS_NW+"/monitoring-locations/items?f=json&limit="+limit+"&site_type_code=ST"
    +"&properties=monitoring_location_number,monitoring_location_name,altitude,state_name"
    +"&filter-lang=cql-text&filter="+encodeURIComponent(cql);
  var d=await nwGetResilient(url);
  return (d?.features||[]).map(function(f){
    var p=f.properties||{},c=(f.geometry||{}).coordinates||[];
    var sn=p.monitoring_location_number||nwSiteNo(p.id);
    return sn?{name:p.monitoring_location_name||("Site "+sn),siteNo:sn,lat:c[1]||0,lng:c[0]||0,
      alt:typeof p.altitude==="number"?p.altitude:null,state:p.state_name||""}:null;
  }).filter(Boolean);
}

// Gauges nearest a lat/lng, used for colloquial place-name lookups (e.g. "Deckers",
// which appears in no South Platte gauge's official name). Same resilient path and the
// same trimmed field set as the name search, and a modest limit — the old version of
// this call reused nwLocations (limit=10000, all fields) on every keystroke-debounced
// search, which was itself feeding the rate-limiting that broke the search.
async function nwNearPoint(lat,lng,padDeg,count){
  var bbox=(lng-padDeg).toFixed(2)+","+(lat-padDeg).toFixed(2)+","+(lng+padDeg).toFixed(2)+","+(lat+padDeg).toFixed(2);
  var url=USGS_NW+"/monitoring-locations/items?f=json&limit=500&site_type_code=ST"
    +"&properties=monitoring_location_number,monitoring_location_name,altitude,state_name"
    +"&bbox="+bbox;
  var d=await nwGetResilient(url);
  return (d?.features||[]).map(function(f){
    var p=f.properties||{},c=(f.geometry||{}).coordinates||[];
    var sn=p.monitoring_location_number||nwSiteNo(p.id);
    return sn?{name:p.monitoring_location_name||("Site "+sn),siteNo:sn,lat:c[1]||0,lng:c[0]||0,
      alt:typeof p.altitude==="number"?p.altitude:null,state:p.state_name||""}:null;
  }).filter(Boolean)
   .sort(function(a,b){return (Math.pow(a.lat-lat,2)+Math.pow(a.lng-lng,2))-(Math.pow(b.lat-lat,2)+Math.pow(b.lng-lng,2));})
   .slice(0,count||5);
}
function nwSiteNo(id){return String(id||"").replace(/^USGS-/,"");}
function nwFresh(f,now){
  var t=Date.parse(f?.properties?.time||"");
  return !isNaN(t)&&(now-t)<=NW_STALE_MS;
}
// Same staleness rule as nwFresh above, adapted for the legacy waterservices.usgs.gov
// {value,dateTime} shape instead of the new API's GeoJSON feature shape. The new-API
// path already filters through nwFresh; the legacy fallback path never did, which is
// how a site offline since 1994 (Colorado River at Hot Sulphur Springs, confirmed
// directly 2026-08-19) was still being shown as a live "current" reading — the new-API
// lookup found no fresh feature for that site/bbox, fell through to the legacy
// endpoint, which returns whatever it has on file with no age check at all. Reuses the
// same NW_STALE_MS threshold rather than inventing a second one.
function legacyFresh(dateTimeStr){
  var t=Date.parse(dateTimeStr||"");
  return !isNaN(t)&&(Date.now()-t)<=NW_STALE_MS;
}
// Drops stale entries from a legacy {value:{timeSeries:[...]}} payload before it
// reaches any caller — every consumer of fetchUSGSLive's legacy-fallback branch gets
// this for free, no per-call-site changes needed.
function filterFreshTimeSeries(legacyPayload){
  var ts=(legacyPayload&&legacyPayload.value&&legacyPayload.value.timeSeries)||[];
  var fresh=ts.filter(function(t){
    var dt=t&&t.values&&t.values[0]&&t.values[0].value&&t.values[0].value[0]&&t.values[0].value[0].dateTime;
    return legacyFresh(dt);
  });
  return {value:{timeSeries:fresh}};
}
function chunkArr(a,n){var o=[];for(var i=0;i<a.length;i+=n)o.push(a.slice(i,i+n));return o;}

// Latest readings for many sites in few calls. Returns fresh features only.
async function nwLatest(siteNos,param){
  if(!siteNos||!siteNos.length)return[];
  var now=Date.now(),out=[];
  var chunks=chunkArr(siteNos.map(function(s){return "USGS-"+nwSiteNo(s);}),100);
  for(var i=0;i<chunks.length;i++){
    var d=await nwGet(USGS_NW+"/latest-continuous/items?f=json&limit=10000&monitoring_location_id="+chunks[i].join(",")+"&parameter_code="+param);
    (d?.features||[]).forEach(function(f){if(nwFresh(f,now))out.push(f);});
  }
  return out;
}

// Gauge names + coords inside a bbox (minLng,minLat,maxLng,maxLat string).
// Returns Map siteNo -> {name,lat,lng}
async function nwLocations(bbox){
  var d=await nwGet(USGS_NW+"/monitoring-locations/items?f=json&limit=10000&bbox="+bbox+"&site_type_code=ST");
  var m=new Map();
  (d?.features||[]).forEach(function(f){
    var p=f.properties||{},c=(f.geometry||{}).coordinates||[];
    var sn=p.monitoring_location_number||nwSiteNo(p.id);
    if(sn)m.set(sn,{name:p.monitoring_location_name||("Site "+sn),lat:c[1]||0,lng:c[0]||0,alt:typeof p.altitude==="number"?p.altitude:null});
  });
  return m;
}

// One monitoring location by site number -> {name,lat,lng} or null
async function nwLocation(siteNo){
  var d=await nwGet(USGS_NW+"/monitoring-locations/items/USGS-"+nwSiteNo(siteNo)+"?f=json");
  if(!d)return null;
  var p=d.properties||{},c=(d.geometry||{}).coordinates||[];
  return {name:p.monitoring_location_name||("Site "+nwSiteNo(siteNo)),lat:c[1]||0,lng:c[0]||0};
}

// Build a legacy {value:{timeSeries:[...]}} object from new-API features + name map
function nwToLegacy(features,nameMap){
  var bySite=new Map();
  (features||[]).forEach(function(f){
    var p=f.properties||{},sn=nwSiteNo(p.monitoring_location_id);
    if(!sn)return;
    if(!bySite.has(sn))bySite.set(sn,{geom:(f.geometry||{}).coordinates||[],vals:[]});
    var v=parseFloat(p.value);
    if(!isNaN(v))bySite.get(sn).vals.push({value:String(p.value),dateTime:p.time});
  });
  var ts=[];
  bySite.forEach(function(e,sn){
    var info=(nameMap&&nameMap.get&&nameMap.get(sn))||{};
    e.vals.sort(function(a,b){return Date.parse(a.dateTime)-Date.parse(b.dateTime);});
    ts.push({
      sourceInfo:{
        siteName:info.name||("Site "+sn),
        siteCode:[{value:sn}],
        geoLocation:{geogLocation:{latitude:info.lat!=null?info.lat:(e.geom[1]||0),longitude:info.lng!=null?info.lng:(e.geom[0]||0)}}
      },
      values:[{value:e.vals}]
    });
  });
  return {value:{timeSeries:ts}};
}

// Daily values [{t,v}] for one site over an explicit date range (00003 = daily mean)
async function nwDailyRange(siteNo,param,startStr,endStr){
  var d=await nwGet(USGS_NW+"/daily/items?f=json&limit=10000&monitoring_location_id=USGS-"+nwSiteNo(siteNo)+"&parameter_code="+param+"&statistic_id=00003&time="+startStr+"T00:00:00Z/"+endStr+"T00:00:00Z");
  return (d?.features||[]).map(function(f){var p=f.properties||{};return{t:p.time,v:parseFloat(p.value)};})
    .filter(function(x){return !isNaN(x.v);})
    .sort(function(a,b){return Date.parse(a.t)-Date.parse(b.t);});
}

// Daily values across a bbox for a date range, adapted to the legacy shape
async function nwDailyBboxLegacy(bbox,startStr,endStr){
  try{
    var pair=await Promise.all([
      nwGet(USGS_NW+"/daily/items?f=json&limit=10000&bbox="+bbox+"&parameter_code=00060&statistic_id=00003&time="+startStr+"T00:00:00Z/"+endStr+"T00:00:00Z"),
      nwLocations(bbox)
    ]);
    var feats=(pair[0]?.features)||[];
    if(!feats.length) return {value:{timeSeries:[]}};
    return nwToLegacy(feats,pair[1]);
  }catch{ return {value:{timeSeries:[]}}; }
}

// History points [{t,v}] for one site: /daily for long ranges, /continuous for short,
// each falling back to the other, then to legacy while it still exists.
async function nwHistory(siteNo,param,days,statClamp){
  var e=new Date(),s=new Date();s.setDate(e.getDate()-days);
  function iso(d){return d.toISOString().split("T")[0]+"T00:00:00Z";}
  function mapDaily(d){
    return (d?.features||[]).map(function(f){var p=f.properties||{};return{t:p.time,v:parseFloat(p.value)};})
      .filter(function(x){return !isNaN(x.v)&&x.v>=0&&x.v<500000;})
      .sort(function(a,b){return Date.parse(a.t)-Date.parse(b.t);});
  }
  var sn="USGS-"+nwSiteNo(siteNo),pts=[];
  if(days>7){
    pts=mapDaily(await nwGet(USGS_NW+"/daily/items?f=json&limit=10000&monitoring_location_id="+sn+"&parameter_code="+param+"&statistic_id=00003&time="+iso(s)+"/"+iso(e)));
  }
  if(!pts.length){
    var s2=new Date();s2.setDate(s2.getDate()-Math.min(days,90)); // /continuous capped to keep payloads sane
    pts=mapDaily(await nwGet(USGS_NW+"/continuous/items?f=json&limit=10000&monitoring_location_id="+sn+"&parameter_code="+param+"&time="+iso(s2)+"/"+iso(e)));
  }
  return pts;
}

// Recent-years peak (replaces legacy annual-stat service): max of 3y of daily values,
// preferring the daily-max statistic, falling back to daily-mean.
async function nwPeak(siteNo){
  var e=new Date(),s=new Date();s.setFullYear(e.getFullYear()-3);
  function iso(d){return d.toISOString().split("T")[0]+"T00:00:00Z";}
  var sn="USGS-"+nwSiteNo(siteNo),best=0;
  var stats=["00001","00003"];
  for(var i=0;i<stats.length&&!best;i++){
    var d=await nwGet(USGS_NW+"/daily/items?f=json&limit=10000&monitoring_location_id="+sn+"&parameter_code=00060&statistic_id="+stats[i]+"&time="+iso(s)+"/"+iso(e));
    (d?.features||[]).forEach(function(f){var v=parseFloat(f?.properties?.value);if(!isNaN(v)&&v>best)best=v;});
  }
  return best>0?best:null;
}


async function fetchUSGSStat(siteNo){
  // Recent-years peak for "% of max" display. New API first (3y of daily values);
  // legacy annual-stat service as fallback until it is decommissioned.
  var peak=await nwPeak(siteNo);
  if(peak) return peak;
  try{
    var url="https://waterservices.usgs.gov/nwis/stat/?format=json&sites="+siteNo+"&parameterCd=00060&statReportType=annual&statYearType=water";
    var r=await fetch(url);
    if(!r.ok) return null;
    var d=await r.json();
    var ts=(d.value&&d.value.timeSeries)||[];
    if(!ts.length) return null;
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
  async function grab(url){
    try{
      var r=await fetch(url);
      if(!r.ok) return [];
      var d=await r.json();
      var ts=(d.value&&d.value.timeSeries)||[];
      if(!ts.length) return [];
      var vals=(ts[0].values&&ts[0].values[0]&&ts[0].values[0].value)||[];
      return vals.map(function(v){return{t:v.dateTime,v:parseFloat(v.value)};}).filter(function(v){return !isNaN(v.v)&&v.v>=0&&v.v<500000;});
    }catch(err){ return []; }
  }
  function thin(pts){
    if(pts.length<=800) return pts;
    var step=Math.ceil(pts.length/800), out=[];
    for(var i=0;i<pts.length;i+=step) out.push(pts[i]);
    if(out[out.length-1]!==pts[pts.length-1]) out.push(pts[pts.length-1]);
    return out;
  }
  // New API first (handles daily-vs-continuous internally); legacy fallback for
  // gauges USGS hasn't backfilled yet (e.g. 07087200), until decommission.
  var pts=await nwHistory(siteNo,"00060",days);
  if(!pts.length){
    if(days<=7){
      pts=await grab("https://waterservices.usgs.gov/nwis/iv/?format=json&sites="+siteNo+"&parameterCd=00060&startDT="+fmt(s)+"&endDT="+fmt(e));
    }else{
      pts=await grab("https://waterservices.usgs.gov/nwis/dv/?format=json&sites="+siteNo+"&parameterCd=00060&startDT="+fmt(s)+"&endDT="+fmt(e));
      if(!pts.length){
        var s2=new Date(); s2.setDate(s2.getDate()-Math.min(days,120));
        pts=await grab("https://waterservices.usgs.gov/nwis/iv/?format=json&sites="+siteNo+"&parameterCd=00060&startDT="+fmt(s2)+"&endDT="+fmt(e));
      }
    }
  }
  return thin(pts);
}


async function fetchUSGSTemp(siteNo){
  // New API first; legacy fallback until decommission.
  try{
    const fs=await nwLatest([siteNo],"00010");
    if(fs.length){
      const c=parseFloat(fs[0].properties.value);
      if(!isNaN(c)) return Math.round(c*9/5+32);
    }
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

async function fetchUSGSLive(lat,lng,radiusDeg=2,fullSweep=false){
  // fullSweep: query the entire radius at once (trip planner needs ALL options,
  // not just the nearest cluster). Default ring behavior suits nearest-gauge lookups.
  var rings=fullSweep?[radiusDeg]:[Math.min(radiusDeg*0.4,0.5),Math.min(radiusDeg*0.7,1.0),radiusDeg];
  // Try smallest radius first and return as soon as one has gauges.
  for(var i=0;i<rings.length;i++){
    var p=rings[i];
    var minLng=Math.round((lng-p)*10000)/10000;
    var maxLng=Math.round((lng+p)*10000)/10000;
    var minLat=Math.round((lat-p)*10000)/10000;
    var maxLat=Math.round((lat+p)*10000)/10000;
    var bbox=minLng+","+minLat+","+maxLng+","+maxLat;
    // New API: locations (names) + batched latest flows, adapted to legacy shape
    try{
      var locs=await nwLocations(bbox);
      if(locs.size){
        var feats=await nwLatest(Array.from(locs.keys()),"00060");
        if(feats.length){var legacyShaped=nwToLegacy(feats,locs);if(legacyShaped.value.timeSeries.length>0) return legacyShaped;}
      }
    }catch{}
    // Legacy fallback (covers gauges not yet on the new API), until decommission.
    // Filtered through filterFreshTimeSeries — this endpoint returns whatever's on
    // file for a site with no age check, including sites offline for decades.
    try{
      var r=await fetch("https://waterservices.usgs.gov/nwis/iv/?format=json&bBox="+bbox+"&parameterCd=00060&siteType=ST");
      if(r.ok){var j0=await r.json();var j=filterFreshTimeSeries(j0);if(j.value.timeSeries.length>0) return j;}
    }catch{}
  }
  return {value:{timeSeries:[]}};
}

// directionalSpread moved to src/lib/tripPlannerPipeline.js (single source of truth,
// imported at the top of this file) — used by the Trip Planner's gauge-shaping step below.


async function fetchUSGSTempBatch(siteNos){
  if(!siteNos||!siteNos.length) return {};
  // New API first
  try{
    var fs=await nwLatest(siteNos,"00010");
    if(fs.length){
      var o={};
      fs.forEach(function(f){
        var sn=nwSiteNo(f.properties.monitoring_location_id);
        var c=parseFloat(f.properties.value);
        if(sn&&!isNaN(c)) o[sn]=Math.round(c*9/5+32);
      });
      if(Object.keys(o).length) return o;
    }
  }catch{}
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

// Batched last-year-same-period flow average, for the planner's flowVsAverage
// grounding (App Dev 23 follow-up — see SPEC_flow_average_grounding.md). One
// call for up to 100 sites via the OGC API's comma-joined monitoring_location_id
// (same pattern as fetchUSGSTempBatch/nwLatest), a 10-day window centered on
// today's date one year ago. This is a last-year-same-period proxy, NOT a true
// multi-year climatological median — good enough for a directional "below/about/
// above average" call at zero extra per-gauge cost beyond what's already paid
// for the temp batch. Fails open to {} on any error; callers must treat a
// missing siteNo as "no baseline," never substitute a guess.
async function fetchFlowAvgBatch(siteNos){
  if(!siteNos||!siteNos.length) return {};
  var e=new Date();e.setFullYear(e.getFullYear()-1);e.setDate(e.getDate()+5);
  var s=new Date(e);s.setDate(s.getDate()-10);
  function iso(d){return d.toISOString().split("T")[0]+"T00:00:00Z";}
  var out={};
  try{
    var chunks=chunkArr(siteNos.map(function(sn){return "USGS-"+nwSiteNo(sn);}),100);
    for(var i=0;i<chunks.length;i++){
      var d=await nwGet(USGS_NW+"/daily/items?f=json&limit=10000&monitoring_location_id="+chunks[i].join(",")+"&parameter_code=00060&statistic_id=00003&time="+iso(s)+"/"+iso(e));
      var sums={},counts={};
      (d?.features||[]).forEach(function(f){
        var p=f.properties||{};
        var sn=nwSiteNo(p.monitoring_location_id);
        var v=parseFloat(p.value);
        if(sn&&!isNaN(v)&&v>=0&&v<500000){sums[sn]=(sums[sn]||0)+v;counts[sn]=(counts[sn]||0)+1;}
      });
      Object.keys(sums).forEach(function(sn){out[sn]=sums[sn]/counts[sn];});
    }
  }catch{}
  return out;
}

// Finds the single closest USGS stream gauge to a point regardless of whether it's
// currently reporting data — used as a confidence check. If the truly nearest gauge
// has no live/historical reading, we know a "nearest gauge WITH data" match may
// actually be the wrong nearby water body (e.g. a tributary next to the real river).
// Used to identify which named stream a catch is actually on. Returns null if the
// lookup fails, which callers should treat as "can't identify the stream."
async function fetchNearestGaugeSiteAnyStatus(lat,lng,radiusDeg){
  try{
    const p=radiusDeg;
    const bbox=`${(lng-p).toFixed(4)},${(lat-p).toFixed(4)},${(lng+p).toFixed(4)},${(lat+p).toFixed(4)}`;
    const r=await fetch(`https://waterservices.usgs.gov/nwis/site/?format=mapper&bBox=${bbox}&siteType=ST&siteStatus=all`);
    if(!r.ok) return null;
    const xml=await r.text();
    const re=/<site\s+sno="([^"]+)"\s+sna="([^"]+)"\s+cat="[^"]*"\s+lat="([^"]+)"\s+lng="([^"]+)"/g;
    let m,best=null,bestDist=Infinity;
    while((m=re.exec(xml))){
      const siteLat=parseFloat(m[3]),siteLng=parseFloat(m[4]);
      const dist=Math.sqrt(Math.pow(siteLat-lat,2)+Math.pow(siteLng-lng,2));
      if(dist<bestDist){bestDist=dist;best={siteNo:m[1],name:m[2],dist};}
    }
    return best;
  }catch{return null;}
}
// Extracts the core water-body name from a USGS site name like "CLEAR CREEK AT
// GOLDEN, CO" -> "CLEAR CREEK", so two gauges can be recognized as being on the
// same named stream even when USGS abbreviates it differently ("CLEAR C") or
// gives it a different qualifier phrase. A tributary like "NORTH CLEAR CREEK"
// normalizes to a different, distinct name — it does NOT match "CLEAR CREEK".
function normalizeStreamName(rawName){
  if(!rawName) return "";
  const QUALIFIERS=/\b(AT|NEAR|NR|ABOVE|ABV|BELOW|BLW|BL|AB|MOUTH|CONFLUENCE)\b/;
  let core=rawName.split(QUALIFIERS)[0].trim();
  core=core.replace(/,.*$/,"").trim();
  core=core
    .replace(/\bCR\b/g,"CREEK")
    .replace(/\bC\b/g,"CREEK")
    .replace(/\bRV\b/g,"RIVER")
    .replace(/\bR\b/g,"RIVER")
    .replace(/\bFK\b/g,"FORK")
    .replace(/\bBR\b/g,"BRANCH")
    .replace(/\s+/g," ")
    .trim()
    .toUpperCase();
  return core;
}
// Given gauges that have valid current data, picks the nearest one that's on the
// SAME named stream as the catch (identified via the nearest gauge overall, active
// or not). This lets a real reading further downstream on the correct river win
// over a closer reading that's actually a different, unrelated tributary. If no
// gauge on the matched stream has data, returns null — callers show blank/N/A
// rather than attach a reading from an unrelated nearby water body.
async function pickSameStreamGauge(lat,lng,candidatesWithData){
  if(!candidatesWithData.length) return null;
  const trueNearest=await fetchNearestGaugeSiteAnyStatus(lat,lng,0.3);
  if(!trueNearest) return null;
  const targetStream=normalizeStreamName(trueNearest.name);
  const sameStream=candidatesWithData
    .filter(x=>normalizeStreamName(x.name)===targetStream)
    .sort((a,b)=>a.dist-b.dist);
  return sameStream[0]||null;
}

async function fetchHistoricalConditions(lat, lng, dateStr, hourStr){
  const results={airTemp:"",weatherDesc:"",windSpeed:"",windDir:"",pressure:"",streamCFS:"",streamCondition:"",streamGaugeName:""};
  const hr=parseInt(hourStr)||12;
  const idx=Math.min(hr,23);
  // Run weather and stream fetch in parallel with a single bbox
  const wxUrl=`https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}&start_date=${dateStr}&end_date=${dateStr}&hourly=temperature_2m,weathercode,windspeed_10m,winddirection_10m,surface_pressure&temperature_unit=fahrenheit&windspeed_unit=mph&timezone=auto`;
  const p=0.4;
  const histBbox=`${(lng-p).toFixed(2)},${(lat-p).toFixed(2)},${(lng+p).toFixed(2)},${(lat+p).toFixed(2)}`;
  const usgsPromise=(async()=>{
    var leg=await nwDailyBboxLegacy(histBbox,dateStr,dateStr);
    if(leg.value.timeSeries.length) return leg;
    // Legacy fallback until decommission
    try{
      var r=await fetch(`https://waterservices.usgs.gov/nwis/dv/?format=json&bBox=${histBbox}&parameterCd=00060&startDT=${dateStr}&endDT=${dateStr}&siteType=ST`);
      if(r.ok) return await r.json();
    }catch{}
    return {value:{timeSeries:[]}};
  })();
  const [wxRes,usgsRes]=await Promise.allSettled([fetch(wxUrl),usgsPromise]);
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
    if(usgsRes.status==="fulfilled"&&usgsRes.value){
      const d=usgsRes.value;
      const ts=(d.value?.timeSeries)??[];
      const parsed=ts.map(t=>{
        const raw=t.values?.[0]?.value?.[0]?.value;
        const cfs=raw!=null?parseFloat(raw):null;
        const sLat=parseFloat(t.sourceInfo?.geoLocation?.geogLocation?.latitude||0);
        const sLng=parseFloat(t.sourceInfo?.geoLocation?.geogLocation?.longitude||0);
        const dist=Math.sqrt(Math.pow(sLat-lat,2)+Math.pow(sLng-lng,2));
        const siteNo=(t.sourceInfo?.siteCode?.[0]?.value)||"";
        return{name:t.sourceInfo?.siteName??"",cfs,dist,siteNo};
      }).filter(x=>x.cfs!=null&&!isNaN(x.cfs)&&x.cfs>=0&&x.cfs<500000&&x.dist<=0.3).sort((a,b)=>a.dist-b.dist);
      const best=await pickSameStreamGauge(lat,lng,parsed);
      if(best){
        results.streamCFS=String(Math.round(best.cfs));
        results.streamCondition=cfsLabel(best.cfs).label;
        results.streamGaugeName=best.name;
      }
    }
  }catch{}
  return results;
}

// Live counterpart to fetchHistoricalConditions — same return shape, but for a
// catch from today, where the archive/daily-values endpoints don't have finalized
// data yet. Reuses the existing live weather + live USGS fetchers.
async function fetchLiveNearestConditions(lat,lng){
  const results={airTemp:"",weatherDesc:"",windSpeed:"",windDir:"",pressure:"",streamCFS:"",streamCondition:"",streamGaugeName:""};
  try{
    const[wx,usgs]=await Promise.all([fetchWeather(lat,lng),fetchUSGSLive(lat,lng)]);
    const c=wx.current;
    results.airTemp=String(Math.round(c.temperature_2m));
    results.weatherDesc=WX_DESC[c.weather_code]||"";
    results.windSpeed=String(Math.round(c.wind_speed_10m));
    results.windDir=windDir(c.wind_direction_10m);
    results.pressure=(c.surface_pressure*0.02953).toFixed(2);
    const now=Date.now();
    const ts=(usgs.value?.timeSeries)??[];
    const parsed=ts.map(t=>{
      const raw=t.values?.[0]?.value?.[0]?.value;
      const dateTime=t.values?.[0]?.value?.[0]?.dateTime;
      const cfs=raw!=null?parseFloat(raw):null;
      // A "latest" instantaneous-value query returns whatever the last recorded
      // reading was even if the site stopped reporting years ago — reject
      // anything older than 24h so an abandoned gauge can't pass as current data.
      const ageHours=dateTime?(now-new Date(dateTime).getTime())/3600000:Infinity;
      const sLat=parseFloat(t.sourceInfo?.geoLocation?.geogLocation?.latitude||0);
      const sLng=parseFloat(t.sourceInfo?.geoLocation?.geogLocation?.longitude||0);
      const dist=Math.sqrt(Math.pow(sLat-lat,2)+Math.pow(sLng-lng,2));
      return{name:t.sourceInfo?.siteName??"",cfs,dist,ageHours};
    }).filter(x=>x.cfs!=null&&!isNaN(x.cfs)&&x.cfs>=0&&x.cfs<500000&&x.dist<=0.3&&x.ageHours<=24).sort((a,b)=>a.dist-b.dist);
    const best=await pickSameStreamGauge(lat,lng,parsed);
    if(best){
      results.streamCFS=String(Math.round(best.cfs));
      results.streamCondition=cfsLabel(best.cfs).label;
      results.streamGaugeName=best.name;
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
  var p2=2.5;
  var bbox2=(lng-p2)+","+(lat-p2)+","+(lng+p2)+","+(lat+p2);
  // New API first at both ring sizes, then legacy fallback until decommission
  var leg=await nwDailyBboxLegacy(bbox,fmt(s),fmt(e));
  if(leg.value.timeSeries.length) return leg;
  leg=await nwDailyBboxLegacy(bbox2,fmt(s),fmt(e));
  if(leg.value.timeSeries.length) return leg;
  try{
    var url="https://waterservices.usgs.gov/nwis/dv/?format=json&bBox="+bbox+"&parameterCd=00060&siteType=ST&siteStatus=active&startDT="+fmt(s)+"&endDT="+fmt(e);
    var r=await fetch(url);
    if(r.ok){var d=await r.json();var ts=(d.value&&d.value.timeSeries)||[];if(ts.length>0) return d;}
  }catch(err){}
  try{
    var url2="https://waterservices.usgs.gov/nwis/dv/?format=json&bBox="+bbox2+"&parameterCd=00060&siteType=ST&siteStatus=active&startDT="+fmt(s)+"&endDT="+fmt(e);
    var r2=await fetch(url2);
    if(r2.ok) return r2.json();
  }catch(e2){}
  return{value:{timeSeries:[]}};
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
        <circle cx={px(points.length-1)} cy={py(points[points.length-1].v)} r="3" fill="#d09a4a"/>
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
          <div style={{fontFamily:"var(--font-head)",fontSize:18,color:"var(--foam)"}}>{m.name}</div>
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
// ---- Regional hatch resolution (App Dev 19, queue #9 Bozeman fix) ----
// Deterministic state lookup from lat/lng (no network call) -> 9 fishing regions.
// Replaces the old single west=lng<=-100 boolean that made every Western US
// location (Bozeman MT, Denver CO, Phoenix AZ) render byte-identical hatch charts.
const STATE_BBOX=[
  // [stateCode, minLat, maxLat, minLng, maxLng] - approximate rectangles, checked in order;
  // first match wins. Boxes are tightened at known overlap borders (ID/MT, MT/WY, NY/VT)
  // rather than relying on check-order alone, since real state shapes aren't rectangles.
  ["WA",45.5,49.1,-124.9,-116.9],
  ["OR",41.9,46.3,-124.7,-116.4],
  ["ID",41.9,49.1,-117.4,-114.0], // tightened east edge so MT doesn't get swallowed
  ["CA",32.4,42.1,-124.5,-114.1],
  ["MT",45.0,49.1,-116.1,-104.0], // south edge aligned to true MT/WY border (45.0°N)
  ["WY",40.9,45.0,-111.2,-104.0],
  ["CO",36.9,41.1,-109.2,-102.0],
  ["UT",36.9,42.1,-114.2,-109.0],
  ["AZ",31.3,37.1,-114.9,-109.0],
  ["NM",31.2,37.1,-109.2,-103.0],
  ["NV",35.0,42.1,-120.1,-114.0],
  ["MI",41.6,48.3,-90.5,-82.3],
  ["WI",42.4,47.2,-92.9,-86.6],
  ["MN",43.4,49.4,-97.3,-89.4],
  ["IA",40.3,43.6,-96.7,-90.1],
  ["IL",36.9,42.6,-91.6,-87.0],
  ["PA",39.7,42.3,-80.6,-74.6],
  ["WV",37.1,40.7,-82.7,-77.7],
  ["VA",36.5,39.5,-83.7,-75.1],
  ["NC",33.8,36.7,-84.4,-75.4],
  ["TN",34.9,36.7,-90.4,-81.6],
  ["GA",30.3,35.1,-85.7,-80.7],
  ["VT",42.6,45.1,-73.5,-71.4], // checked before NY so VT's strip isn't swallowed by NY's box
  ["NH",42.6,45.4,-72.6,-70.6],
  ["NY",40.4,45.1,-79.8,-73.5], // tightened east edge to stop short of VT
  ["ME",42.9,47.5,-71.2,-66.8],
  ["MA",41.1,43.0,-73.6,-69.8],
  ["CT",40.9,42.1,-73.8,-71.7],
  ["RI",41.1,42.1,-71.9,-71.1],
  ["NJ",38.9,41.4,-75.6,-73.9],
  ["SC",32.0,35.3,-83.4,-78.4],
  ["AL",30.1,35.1,-88.5,-84.8],
  ["FL",24.4,31.1,-87.7,-79.9]
];
function stateFromLatLng(lat,lng){
  if(lat==null||lng==null) return null;
  for(const s of STATE_BBOX){
    if(lat>=s[1]&&lat<=s[2]&&lng>=s[3]&&lng<=s[4]) return s[0];
  }
  return null;
}
const REGION_BY_STATE={
  WA:"pnw",OR:"pnw",ID:"pnw",
  CA:"california",
  MT:"n_rockies", // WY handled separately below (latitude split)
  CO:"s_rockies",UT:"s_rockies",
  AZ:"southwest",NM:"southwest",NV:"southwest",
  MI:"midwest",WI:"midwest",MN:"midwest",IA:"midwest",IL:"midwest",
  PA:"appalachia",WV:"appalachia",VA:"appalachia",
  NY:"northeast",VT:"northeast",NH:"northeast",ME:"northeast",MA:"northeast",CT:"northeast",RI:"northeast",NJ:"northeast",
  SC:"southeast",AL:"southeast",FL:"southeast"
  // NC, TN, GA intentionally omitted: mountain vs. lowland split handled in regionFromLatLng
};
// WY: split at 43°N (Continental Divide / watershed proxy) -- Yellowstone/Snake/Bighorn/
// Shoshone basins (Cody, Jackson, Cooke City) read north; North Platte/Green/Flaming Gorge
// basins (Saratoga, Casper, Rawlins) read south.
// NC/TN/GA: mountain counties (Appalachia) vs. lowland (Southeast) split by longitude --
// Appalachian ranges in these three states sit west of roughly -82° to -83.5°.
function regionFromLatLng(lat,lng){
  const st=stateFromLatLng(lat,lng);
  if(!st) return "s_rockies"; // fail-open default: closest to current CO-centric behavior
  if(st==="WY") return lat>=43?"n_rockies":"s_rockies";
  if(st==="NC") return lng<=-82.3?"appalachia":"southeast";
  if(st==="TN") return lng<=-83.0?"appalachia":"southeast";
  if(st==="GA") return lng<=-83.5?"appalachia":"southeast";
  return REGION_BY_STATE[st]||"s_rockies";
}
// Region-aware "where" text for hatches whose example rivers vary meaningfully by region.
// Falls back to a generic phrase for regions not explicitly listed (never throws, never blank).
const REGION_WHERE={
  salmonfly:{
    pnw:"large freestone rivers (Deschutes, Yakima, Clackamas) \u2014 not small creeks or most tailwaters",
    n_rockies:"large freestone rivers (Madison, Big Hole, Yellowstone, Rock Creek) \u2014 not small creeks or most tailwaters",
    s_rockies:"large freestone rivers (Colorado, Gunnison, Arkansas) \u2014 not small creeks or most tailwaters",
    california:"large freestone rivers (Trinity, McCloud) \u2014 not small creeks or most tailwaters",
    _default:"large, fast freestone rivers \u2014 not small creeks or most tailwaters"
  },
  greendrake:{
    n_rockies:"specific famous rivers (Henry's Fork, Madison) \u2014 sporadic or absent elsewhere",
    s_rockies:"specific famous rivers (Frying Pan, Roaring Fork) \u2014 sporadic or absent elsewhere",
    appalachia:"specific famous rivers (Penns Creek, Beaverkill) \u2014 sporadic or absent elsewhere",
    northeast:"specific famous rivers (Penns Creek, Beaverkill) \u2014 sporadic or absent elsewhere",
    _default:"sporadic and famous-water-specific where it occurs"
  },
  hex:{
    midwest:"silty-bottomed rivers and stillwaters \u2014 famous on Michigan's Au Sable and Wisconsin waters, absent from rocky freestone streams",
    pnw:"silty-bottomed rivers and stillwaters \u2014 known on select Oregon waters, absent from rocky freestone streams",
    california:"silty-bottomed rivers and stillwaters \u2014 locally famous on Fall River and Lake Almanor, absent from rocky freestone streams",
    northeast:"silty-bottomed rivers and stillwaters \u2014 present on a handful of waters, far less prolific than Midwest, absent from rocky freestone streams",
    _default:"silty-bottomed rivers and stillwaters, absent from rocky freestone streams"
  }
};
function regionWhere(key,region){
  const m=REGION_WHERE[key];
  if(!m) return null;
  return m[region]||m._default;
}
function predictHatches(opts){
  const month=opts.month,t=opts.waterTempF!=null?opts.waterTempF:null;
  const lng=opts.lng!=null?opts.lng:-100,bigWater=(opts.maxCfs||0)>400;
  const src=opts.tempGaugeName?" ("+opts.tempGaugeName+")":"";
  const userRegion=regionFromLatLng(opts.lat!=null?opts.lat:null,lng);
  const R=[
    {name:"Midges",months:[1,2,3,4,5,6,7,8,9,10,11,12],lo:33,hi:70,flies:["Zebra Midge #18-22","Griffith's Gnat #18-22","RS2 #20-22"],timing:"Midday in cold months, mornings and evenings in summer",base:0.55,note:"Year-round staple; often the only game in cold water"},
    {name:"Blue-Winged Olive (Baetis)",months:[3,4,5,9,10,11],lo:40,hi:58,flies:["Pheasant Tail #16-20","BWO Comparadun #16-20","RS2 #18-20"],timing:"Afternoons; best on overcast days",base:0.7,note:"Cloudy, drizzly days bring the heaviest emergences"},
    {name:"Skwala Stonefly",months:[2,3,4],lo:40,hi:50,regions:["pnw","n_rockies","california"],where:"select western freestones (Bitterroot, Yakima, Clark Fork)",flies:["Pat's Rubber Legs #8-10","Skwala Dry #10"],timing:"Warmest part of the day",base:0.5,note:"Early-season western stonefly"},
    {name:"Mother's Day Caddis",months:[4,5],lo:48,hi:56,regions:["pnw","n_rockies","s_rockies"],flies:["Elk Hair Caddis #14-16","Sparkle Pupa #14-16"],timing:"Afternoons",base:0.6,note:"Can blanket western rivers when temps hit the low 50s"},
    {name:"Salmonfly",months:[5,6,7],lo:50,hi:58,regions:["pnw","n_rockies","s_rockies","california"],regionWhereKey:"salmonfly",big:true,flies:["Chubby Chernobyl #6-8","Pat's Rubber Legs #4-8"],timing:"Midday; the hatch moves upstream day by day",base:0.6,note:"Trout key on them hard where they occur"},
    {name:"Golden Stonefly",months:[6,7],lo:52,hi:62,regions:["pnw","n_rockies","s_rockies","california"],flies:["Yellow Stimulator #8-10","Golden Stone Nymph #8-10"],timing:"Mornings and evenings",base:0.55,note:"Follows the salmonfly hatch on many western rivers"},
    {name:"Pale Morning Dun",months:[6,7,8],lo:54,hi:66,regions:["pnw","n_rockies","s_rockies","california","southwest"],flies:["PMD Comparadun #16-18","Split Case PMD #16-18"],timing:"Late morning into early afternoon",base:0.7,note:"The premier summer mayfly across the West"},
    {name:"October Caddis",months:[9,10],lo:45,hi:55,regions:["pnw","n_rockies","s_rockies","california"],flies:["Orange Stimulator #8-10","October Caddis Pupa #8-10"],timing:"Afternoons",base:0.5,note:"Big orange caddis of western fall"},
    {name:"Quill Gordon",months:[3,4],lo:45,hi:52,regions:["appalachia","northeast"],flies:["Quill Gordon #12-14","Pheasant Tail #14"],timing:"Early afternoon on the first warm days",base:0.5,note:"The earliest major eastern mayfly"},
    {name:"Hendrickson",months:[4,5],lo:50,hi:56,regions:["appalachia","northeast","midwest"],flies:["Hendrickson #12-14","Red Quill #12-14","Pheasant Tail #14"],timing:"Early to mid afternoon",base:0.7,note:"The classic eastern spring hatch"},
    {name:"March Brown",months:[5,6],lo:50,hi:58,regions:["appalachia","northeast","midwest","california"],flies:["March Brown #10-12","Hare's Ear Nymph #12"],timing:"Sporadic through the afternoon",base:0.5,note:"Large eastern mayfly, never blanket but reliable"},
    {name:"Sulphur",months:[5,6,7],lo:55,hi:65,regions:["appalachia","northeast"],flies:["Sulphur Comparadun #16-18","Sulphur Spinner #16-18"],timing:"Evenings; spinner falls at dusk",base:0.7,note:"The East's premier early-summer mayfly"},
    {name:"Light Cahill",months:[6,7],lo:58,hi:66,regions:["appalachia","northeast","midwest"],flies:["Light Cahill #14-16","Cahill Spinner #14-16"],timing:"Evenings",base:0.55,note:"Reliable eastern summer evening mayfly"},
    {name:"Hexagenia (Hex)",months:[6,7],lo:60,hi:70,regions:["midwest","pnw","california","northeast"],regionWhereKey:"hex",flies:["Hex Dun #4-6","Hex Nymph #6"],timing:"At dusk and after dark",base:0.55,note:"The giant night hatch"},
    {name:"Slate Drake (Isonychia)",months:[5,6,9,10],lo:52,hi:64,regions:["appalachia","northeast","midwest"],flies:["Isonychia #10-12","Mahogany Dun #12"],timing:"Afternoons and evenings",base:0.5,note:"Eastern swimmer mayfly, both early summer and fall"},
    {name:"Caddis (evening)",months:[5,6,7,8,9],lo:52,hi:68,flies:["Elk Hair Caddis #14-18","X-Caddis #14-16","Soft Hackle #14-16"],timing:"Last two hours before dark",base:0.7,note:"Reliable summer evening activity on most trout water"},
    {name:"Green Drake",months:[6,7],lo:54,hi:62,regionWhereKey:"greendrake",flies:["Green Drake #10-12","Hare's Ear Nymph #10-12"],timing:"Afternoons, often during unsettled weather",base:0.5,note:"Short but famous; trout abandon caution for them"},
    {name:"Yellow Sally",months:[6,7,8],lo:55,hi:65,flies:["Yellow Sally #14-16","Yellow Stimulator #14"],timing:"Afternoons and evenings",base:0.5,note:"Small summer stonefly, easy to overlook"},
    {name:"Trico",months:[7,8,9],lo:58,hi:70,flies:["Trico Spinner #20-24","Trico Dun #20-22"],timing:"Early mornings; spinner fall around 8-10am",base:0.55,note:"Tiny flies, picky fish, great dry-fly fishing"},
    {name:"Terrestrials (hoppers, ants, beetles)",months:[7,8,9],lo:58,hi:74,flies:["Hopper #8-12","Ant #14-18","Beetle #14-16"],timing:"Warm, breezy afternoons near grassy banks",base:0.6,note:"Not a hatch but a major summer food source"},
    {name:"Mahogany Dun",months:[9,10],lo:45,hi:55,flies:["Mahogany Dun #16-18","Pheasant Tail #16-18"],timing:"Afternoons",base:0.5,note:"Dependable fall mayfly as BWOs taper"}
  ];
  const out=[];
  for(const r of R){
    if(!r.months.includes(month))continue;
    if(r.regions&&!r.regions.includes(userRegion))continue;
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
    const whereText=r.regionWhereKey?regionWhere(r.regionWhereKey,userRegion):r.where;
    const whereNote=whereText?". Found only on "+whereText+" \u2014 check whether your water holds this hatch":"";
    const lk=whereText?"Moderate":(r.base>=0.65?"High":"Moderate");
    out.push({name:r.name,likelihood:lk,waterTempRange:r.lo+"-"+r.hi+"\u00b0F",flies:r.flies,timing:r.timing,notes:r.note+whereNote+timingNote+" Typically active when water reaches "+r.lo+"\u2013"+r.hi+"\u00b0F."+tempCtx+gaugeNote,_s:r.base});
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
    const maxCfs=gl.reduce((m,g)=>Math.max(m,g.cfs||0),0);
    setResult(predictHatches({month:new Date().getMonth()+1,waterTempF:waterTemp||null,lat:(loc&&loc.lat!=null)?loc.lat:null,lng:(loc&&loc.lng!=null)?loc.lng:null,maxCfs,tempGaugeName:null}));
    setOpen(true);setLoading(false);
  }
  return(
    React.createElement('div',{className:"card"},
      React.createElement('div',{className:"ctitle",style:{cursor:"pointer",userSelect:"none"},onClick:()=>open?setOpen(false):runMatcher()},
        "🪲 Predicted Hatches",
        React.createElement('span',{style:{fontSize:15,color:"var(--stone)",marginLeft:8,fontFamily:"sans-serif"}},open?"▲ collapse":"▼ show prediction"),
        loc&&React.createElement('button',{className:"rfsh",onClick:e=>{e.stopPropagation();runMatcher();}},"↻")
      ),
      React.createElement('div',{className:"csub"},"Prediction from live flows, season & region — not a real-time hatch report"),
      loading&&React.createElement('div',{className:"loading"},"Matching hatches…"),
      open&&!loading&&result&&result.map((h,i)=>
        React.createElement('div',{key:i,style:{padding:"10px 0",borderBottom:i<result.length-1?"1px solid rgba(255,255,255,0.06)":"none"}},
          React.createElement('div',{style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}},
            React.createElement('span',{style:{fontSize:14,color:"var(--foam)",fontFamily:"var(--font-body)",fontWeight:600}},h.name),
            React.createElement('span',{style:{fontSize:14,padding:"2px 8px",borderRadius:20,background:h.likelihood==="High"?"rgba(90,122,74,0.3)":h.likelihood==="Moderate"?"rgba(209,154,74,0.2)":"rgba(255,255,255,0.06)",color:h.likelihood==="High"?"#9cd47a":h.likelihood==="Moderate"?"var(--gold)":"var(--stone)"}},h.likelihood)
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
        <div style={{fontFamily:"var(--font-head)",fontSize:22,color:"var(--gold)",marginBottom:4}}>{hatch.name}</div>
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
  const selHumidity = d.relative_humidity_2m_mean?.[sel];
  const selUV = d.uv_index_max?.[sel];
  const selMoon = getMoonPhase(selDate);

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
              style={{flex:"0 0 auto",width:54,background:isSel?"var(--water)":isHi?"rgba(209,154,74,0.15)":"rgba(0,0,0,0.2)",
                border:`1px solid ${isSel?"var(--water)":isHi?"var(--gold)":"rgba(255,255,255,0.08)"}`,
                borderRadius:10,padding:"8px 4px",textAlign:"center",cursor:"pointer",transition:"all .15s"}}>
              <div style={{fontSize:13,color:isSel?"var(--foam)":"var(--stone)",textTransform:"uppercase",letterSpacing:.5}}>{DAYS[dt.getDay()]}</div>
              <div style={{fontSize:22,margin:"4px 0"}}>{WX_EMOJI[d.weather_code?.[i]]||"🌡"}</div>
              <div style={{fontFamily:"var(--font-head)",fontSize:16,color:isSel?"var(--foam)":"var(--foam)"}}>{Math.round(d.temperature_2m_max?.[i])}°</div>
              <div style={{fontSize:14,color:"var(--stone)"}}>{Math.round(d.temperature_2m_min?.[i])}°</div>
              {(d.precipitation_probability_max?.[i]??0)>0&&<div style={{fontSize:15,color:"#7ec8c8"}}>💧{d.precipitation_probability_max[i]}%</div>}
            </div>
          );
        })}
      </div>
      {/* Selected day detail */}
      <div style={{background:"rgba(0,0,0,0.2)",borderRadius:12,padding:"12px 14px"}}>
        <div style={{fontSize:17,color:"var(--gold)",fontFamily:"var(--font-head)",marginBottom:10}}>
          {selDate.toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})}
          {" — "}{WX_DESC[d.weather_code?.[sel]]||""}
        </div>
        {/* Hour-by-hour strip for the selected day — same data pull as everything else on
            this screen, no extra fetch. "Where available" just means: Open-Meteo's hourly
            block covers the same 7-day window as the daily strip, so this renders for every
            selectable day; if the block is ever missing (network hiccup, etc.) this quietly
            shows nothing rather than an error, consistent with the rest of the tab. */}
        {(()=>{
          const h=data?.hourly;
          if(!h?.time?.length) return null;
          const{date:todayStr,hour:curHour}=localDateHourAt(data?.timezone);
          const isToday=d.time[sel]===todayStr;
          const rows=h.time.map((t,i)=>({t,i})).filter(({t})=>t.slice(0,10)===d.time[sel])
            .filter(({t})=>!isToday||parseInt(t.slice(11,13),10)>=curHour);
          if(!rows.length) return null;
          return(
            <div style={{display:"flex",gap:4,overflowX:"auto",paddingBottom:4,marginBottom:10}}>
              {rows.map(({t,i})=>{
                const hr=parseInt(t.slice(11,13),10);
                const hLabel=hr===0?"12a":hr<12?hr+"a":hr===12?"12p":(hr-12)+"p";
                const isNow=isToday&&hr===curHour;
                const precip=h.precipitation_probability?.[i];
                return(
                  <div key={i} style={{flex:"0 0 auto",width:44,background:isNow?"rgba(209,154,74,0.15)":"rgba(0,0,0,0.15)",
                    border:`1px solid ${isNow?"var(--gold)":"rgba(255,255,255,0.06)"}`,
                    borderRadius:8,padding:"6px 2px",textAlign:"center"}}>
                    <div style={{fontSize:12,color:isNow?"var(--gold)":"var(--stone)",textTransform:"uppercase"}}>{isNow?"Now":hLabel}</div>
                    <div style={{fontSize:18,margin:"2px 0"}}>{WX_EMOJI[h.weather_code?.[i]]||"🌡"}</div>
                    <div style={{fontFamily:"var(--font-head)",fontSize:14,color:"var(--foam)"}}>{h.temperature_2m?.[i]!=null?Math.round(h.temperature_2m[i])+"°":"—"}</div>
                    {precip>0&&<div style={{fontSize:11,color:"#7ec8c8"}}>💧{precip}%</div>}
                  </div>
                );
              })}
            </div>
          );
        })()}
        {/* Plain-language fishing read for the selected day — deterministic, no AI. Shown first. */}
        {(()=>{const read=weekWeatherRead(d,sel);return read?(
          <div style={{background:"rgba(209,154,74,0.08)",border:"1px solid rgba(209,154,74,0.2)",borderRadius:10,padding:"10px 12px",marginBottom:10}}>
            <div style={{fontSize:13,color:"var(--gold)",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>Fishing Read</div>
            <div style={{fontSize:14,color:"var(--foam)",lineHeight:1.55}}>{read}</div>
          </div>
        ):null;})()}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          <div style={{background:"rgba(0,0,0,0.2)",borderRadius:10,padding:"10px 8px",textAlign:"center"}}>
            <div style={{fontSize:13,color:"var(--stone)",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>High / Low</div>
            <div style={{fontFamily:"var(--font-head)",fontSize:22,color:"var(--foam)"}}>{Math.round(d.temperature_2m_max?.[sel])}°</div>
            <div style={{fontSize:16,color:"var(--stone)"}}>{Math.round(d.temperature_2m_min?.[sel])}°</div>
          </div>
          <div style={{background:"rgba(0,0,0,0.2)",borderRadius:10,padding:"10px 8px",textAlign:"center"}}>
            <div style={{fontSize:15,color:"var(--stone)",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>Wind</div>
            <div style={{fontSize:17,color:"var(--foam)"}}>💨 {selWind?Math.round(selWind):"—"} mph</div>
            {selGust&&<div style={{fontSize:15,color:"var(--stone)"}}>Gusts {Math.round(selGust)}</div>}
            {selWindDir!=null&&<div style={{fontSize:15,color:"var(--sky)"}}>{windDir(selWindDir)}</div>}
          </div>
          <div style={{background:"rgba(0,0,0,0.2)",borderRadius:10,padding:"10px 8px",textAlign:"center"}}>
            <div style={{fontSize:15,color:"var(--stone)",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>Humidity</div>
            <div style={{fontSize:18,color:"var(--foam)"}}>💧 {selHumidity!=null?Math.round(selHumidity):"—"}%</div>
          </div>
          <div style={{background:"rgba(0,0,0,0.2)",borderRadius:10,padding:"10px 8px",textAlign:"center"}}>
            <div style={{fontSize:15,color:"var(--stone)",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>UV Index</div>
            <div style={{fontSize:18,color:"var(--foam)"}}>☀️ {selUV!=null?Math.round(selUV):"—"}</div>
          </div>
          <div style={{background:"rgba(0,0,0,0.2)",borderRadius:10,padding:"10px 8px",textAlign:"center"}}>
            <div style={{fontSize:15,color:"var(--stone)",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>Pressure</div>
            <div style={{fontSize:18,color:trend?.color||"var(--foam)",fontWeight:"bold"}}>{selPresInHg||"—"}"</div>
            {trend&&<div style={{fontSize:15,color:trend.color}}>{trend.icon} {trend.label}</div>}
          </div>
          <div style={{background:"rgba(0,0,0,0.2)",borderRadius:10,padding:"10px 8px",textAlign:"center"}}>
            <div style={{fontSize:15,color:"var(--stone)",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>Rain Chance</div>
            <div style={{fontSize:18,color:"var(--foam)"}}>🌧 {d.precipitation_probability_max?.[sel]??0}%</div>
            {d.weather_code?.[sel]!=null && d.weather_code[sel]>=95 && <div style={{fontSize:14,color:"#e8a13a",fontWeight:"bold",marginTop:4}}>⛈ Thunderstorms</div>}
          </div>
          <div style={{background:"rgba(0,0,0,0.2)",borderRadius:10,padding:"10px 8px",textAlign:"center"}}>
            <div style={{fontSize:15,color:"var(--stone)",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>Moon Phase</div>
            <div style={{fontSize:18,color:"var(--foam)"}}>{selMoon.emoji} {selMoon.name}</div>
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
  // DWR-sourced gauges (2026-08-15, see gaugeSources.js) store a letters abbrev as
  // siteNo, not a USGS site number — none of this component's fetches (all USGS-only)
  // can resolve one. Rather than silently render an empty chart, say so plainly.
  // Historical charting from DWR's own surfacewatertsday endpoint is a real follow-up,
  // just out of scope for tonight's fix (only the current CFS value was fixed above).
  const isDWRAbbrev=siteNo&&!/^\d+$/.test(String(siteNo));

  useEffect(()=>{
    if(!siteNo||isDWRAbbrev) return;
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
        // New API first; legacy fallback until decommission
        let [avg0,temps0]=await Promise.all([
          nwDailyRange(siteNo,"00060",fmt(s),fmt(e)),
          nwDailyRange(siteNo,"00010",fmt(s),fmt(e))
        ]);
        if(!avg0.length){
          try{
            const flowRes=await fetch("https://waterservices.usgs.gov/nwis/dv/?format=json&sites="+siteNo+"&parameterCd=00060&startDT="+fmt(s)+"&endDT="+fmt(e)+"&statCd=00003");
            const flowD=await flowRes.json();
            const ts=flowD.value?.timeSeries?.[0]?.values?.[0]?.value||[];
            avg0=ts.map(v=>({t:v.dateTime,v:parseFloat(v.value)}));
          }catch{}
        }
        if(!temps0.length){
          try{
            const tempRes=await fetch("https://waterservices.usgs.gov/nwis/dv/?format=json&sites="+siteNo+"&parameterCd=00010&startDT="+fmt(s)+"&endDT="+fmt(e)+"&statCd=00003");
            const tempD=await tempRes.json();
            const tts=tempD.value?.timeSeries?.[0]?.values?.[0]?.value||[];
            temps0=tts.map(v=>({t:v.dateTime,v:parseFloat(v.value)}));
          }catch{}
        }
        setHistAvg(avg0.filter(v=>!isNaN(v.v)&&v.v>0&&v.v<500000));
        setTempPoints(temps0.map(v=>({t:v.t,v:v.v*9/5+32})).filter(v=>!isNaN(v.v)&&v.v>0&&v.v<100));
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
          return <polyline points={hpts} fill="none" stroke="rgba(209,154,74,0.45)" strokeWidth="1" strokeDasharray="3,3" strokeLinejoin="round"/>;
        })()}
        <circle cx={dotX} cy={dotY} r="3" fill="#d09a4a"/>
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
              fontSize:14, cursor:"pointer", fontFamily:"var(--font-body)",
              transition:"all .15s"
            }}>
            {tf.label}
          </button>
        ))}
      </div>
      <div style={{display:"flex",gap:12,marginBottom:6,fontSize:14,color:"var(--stone)",alignItems:"center",flexWrap:"wrap"}}>
        <span style={{display:"inline-block",width:16,height:2,background:"#b8d4dc",verticalAlign:"middle"}}></span>Flow (CFS)
        {histAvg.length>0&&<><span style={{display:"inline-block",width:16,height:2,background:"rgba(209,154,74,0.6)",borderTop:"1px dashed rgba(209,154,74,0.6)",verticalAlign:"middle",marginLeft:8}}></span>Prev avg</>}
        {tempPoints.length>0&&<><span style={{display:"inline-block",width:16,height:2,background:"rgba(255,100,100,0.7)",verticalAlign:"middle",marginLeft:8}}></span>Water Temp (°F)</>}
      </div>
      {isDWRAbbrev&&<div style={{fontSize:15,color:"var(--stone)",fontStyle:"italic",padding:"8px 0"}}>History chart isn't available yet for Colorado DWR gauges (this one's a DWR station, not USGS) — the current flow shown above is still live and accurate.</div>}
      {!isDWRAbbrev&&loading&&<div style={{fontSize:15,color:"var(--stone)",fontStyle:"italic",padding:"8px 0",animation:"pulse 1.5s infinite"}}>Loading chart…</div>}
      {!isDWRAbbrev&&!loading&&points.length>0&&points.some(p=>p.v>0)&&renderChart()}
      {!isDWRAbbrev&&!loading&&(points.length===0||!points.some(p=>p.v>0))&&<div style={{fontSize:15,color:"var(--stone)",fontStyle:"italic"}}>USGS history unavailable for this gauge{siteNo?` (site ${siteNo})`:""} — live flow shown above is current</div>}
    </div>
  );
}

// ── Gauge List with expandable charts ────────────────────────────────────────
// Single shared forecast badge — used by ALL THREE gauge surfaces (the Intel tab's
// discovered list, the Intel tab's "My Gauges", and the Guide CRM gauge list). Those
// three each render gauges independently, which is why the forecast badge originally
// appeared on only one of them. Keeping the markup in one component means wording,
// color, and threshold changes land everywhere at once instead of drifting apart.
// Renders nothing at all when there's no forecast — a missing forecast is the common
// case (most gauges don't have one active), not an error state to announce.
function ForecastBadge({cfs,forecastCfs,style}){
  if(forecastCfs==null) return null;
  // Arrow needs a current reading to compare against; a forecast-only gauge gets the
  // neutral marker rather than a fabricated trend direction.
  const arrow = cfs!=null ? (forecastCfs>cfs*1.05?"↗":forecastCfs<cfs*0.95?"↘":"→") : "→";
  return <span style={{fontSize:14,color:"#8ea9c9",...(style||{})}}>{arrow} {Math.round(forecastCfs).toLocaleString()} CFS in 4 days</span>;
}

function GaugeList({gauges,isStarred,toggleStar,showStarredOnly}){
  const [expanded, setExpanded] = useState(null);
  return(
    <div>
      {(showStarredOnly&&isStarred?gauges.filter(g=>isStarred(g.siteNo)):gauges||[]).map((g,i)=>(
        <div className="gi" key={i} style={{cursor:"pointer"}} onClick={()=>setExpanded(expanded===i?null:i)}>
          <div className="grow">
            <div style={{flex:1}}>{g.lat&&g.lng?<a href={`https://maps.google.com/?q=${g.lat},${g.lng}`} target="_blank" rel="noopener noreferrer" className="gname" style={{color:"var(--sky)",textDecoration:"none"}} onClick={e=>e.stopPropagation()}>{g.name}</a>:<span className="gname">{g.name}</span>}{g.distMi!=null&&<div style={{fontSize:14,color:"var(--stone)",marginTop:2}}>{g.distMi} miles away</div>}</div>
            {toggleStar&&<button onClick={e=>{e.stopPropagation();toggleStar(g);}} style={{background:"none",border:"none",cursor:"pointer",fontSize:14,padding:"0 4px",color:isStarred&&isStarred(g.siteNo)?"var(--gold)":"var(--stone)"}}>
              {isStarred&&isStarred(g.siteNo)?"⭐":"☆"}
            </button>}
          </div>
          <div className="grow">
            <span className="gval">{g.cfs!=null?`${Math.round(g.cfs).toLocaleString()} CFS`:"No reading"}</span>
            {g.waterTempF&&<span style={{fontSize:14,color:"#7ec8c8",marginLeft:8}}>💧 {g.waterTempF}°F</span>}
            <ForecastBadge cfs={g.cfs} forecastCfs={g.forecastCfs} style={{marginLeft:8}}/>
            {g.nwmOutlook&&g.nwmOutlook.length>0&&(()=>{const vals=g.nwmOutlook.map(d=>d.cfs).filter(v=>v!=null);if(!vals.length)return null;const lo=Math.round(Math.min(...vals)),hi=Math.round(Math.max(...vals));return<span style={{fontSize:14,background:"rgba(150,130,180,0.15)",border:"1px dashed rgba(150,130,180,0.4)",borderRadius:12,padding:"2px 8px",marginLeft:8,color:"#b8a8d0"}} title="NOAA National Water Model — not an official NWS forecast, and not calibrated to a local gauge">📅 5-day: {lo===hi?`${lo}`:`${lo}–${hi}`} cfs (modeled)</span>})()}
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
function LocationSearch({onSelect,onTextChange,initialValue="",placeholder="Search river, city, or state…"}){
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
    if(onTextChange)onTextChange(val);
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

// Free-text species field with tap-to-fill suggestions from SPECIES. Mirrors
// LocationSearch's input+suggestion-list pattern (same sugg-list/sugg CSS,
// same click-outside-to-close behavior) so any species can be typed — not
// locked to a fixed list, and not region-specific.
function SpeciesInput({value,onChange,placeholder="Species — type or pick a suggestion",style,inputStyle}){
  const [query,setQuery]=useState(value||"");
  const [open,setOpen]=useState(false);
  const wrap=useRef(null);

  useEffect(()=>{setQuery(value||"");},[value]);
  useEffect(()=>{
    const fn=e=>{if(wrap.current&&!wrap.current.contains(e.target))setOpen(false);};
    document.addEventListener("mousedown",fn);
    return()=>document.removeEventListener("mousedown",fn);
  },[]);

  const q=query.trim().toLowerCase();
  const matches=(q?SPECIES.filter(s=>s.toLowerCase().includes(q)):SPECIES).slice(0,6);

  function handleChange(val){
    setQuery(val);
    onChange(val);
    setOpen(true);
  }

  function pick(s){
    setQuery(s);
    onChange(s);
    setOpen(false);
  }

  return(
    <div ref={wrap} style={{position:"relative",...style}}>
      <input className="inp" style={{fontSize:15,...inputStyle}} value={query} placeholder={placeholder}
        onChange={e=>handleChange(e.target.value)}
        onFocus={()=>setOpen(true)}
        autoComplete="off" spellCheck={false}/>
      {open&&matches.length>0&&(
        <div className="sugg-list" style={{right:0}}>
          {matches.map(s=>(
            <div key={s} className="sugg" onMouseDown={()=>pick(s)}>
              <span className="sugg-label">{s}</span>
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
  if(trip.streamCFS) conditionItems.push(`<div class="cond-item"><span class="cond-icon">🌊</span><span class="cond-val">${Number(trip.streamCFS).toLocaleString()} CFS</span><span class="cond-lbl">Flow</span></div>`);

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
  @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Montserrat:ital,wght@0,300;0,400;0,600;1,400&display=swap');
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'Montserrat',sans-serif;background:#fff;color:#1a2e35;width:210mm;margin:0 auto;}
  @media print{body{width:100%;}@page{margin:0;size:letter;}}

  /* Header band */
  .header{background:linear-gradient(135deg,#1a3a45,#2c5f6e);color:#f2efe6;padding:32px 40px 24px;position:relative;}
  .brand{font-family:'Oswald',sans-serif;font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#b8d4dc;margin-bottom:6px;}
  .report-title{font-family:'Oswald',sans-serif;font-size:32px;font-weight:700;color:#f2efe6;margin-bottom:4px;}
  .report-title span{color:#d09a4a;font-style:italic;}
  .report-meta{font-size:14px;color:#b8d4dc;margin-top:8px;line-height:1.8;}
  .header-accent{position:absolute;bottom:0;right:40px;font-size:64px;opacity:0.15;}
  .divider-gold{height:3px;background:linear-gradient(90deg,#d09a4a,transparent);margin:0;}

  /* Conditions section */
  .section{padding:24px 40px;}
  .section-title{font-family:'Oswald',sans-serif;font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#2c5f6e;border-bottom:1px solid #d0dfe3;padding-bottom:8px;margin-bottom:16px;}
  .conditions-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:12px;}
  .cond-item{background:#f0f5f7;border-radius:10px;padding:12px 8px;text-align:center;border:1px solid #d0dfe3;}
  .cond-icon{display:block;font-size:20px;margin-bottom:4px;}
  .cond-val{display:block;font-family:'Oswald',sans-serif;font-size:15px;color:#1a3a45;font-weight:700;}
  .cond-lbl{display:block;font-size:10px;color:#6a8a94;text-transform:uppercase;letter-spacing:1px;margin-top:2px;}
  .stream-bar{background:#e8f0f3;border-radius:10px;padding:12px 16px;margin-top:12px;display:flex;align-items:center;gap:12px;border-left:4px solid #2c5f6e;}
  .stream-name{font-family:'Oswald',sans-serif;font-size:14px;color:#1a3a45;font-style:italic;}
  .stream-stats{font-size:13px;color:#2c5f6e;margin-left:auto;}

  /* Trip stats bar */
  .stats-bar{background:#1a3a45;padding:14px 40px;display:flex;gap:32px;align-items:center;}
  .stat{text-align:center;}
  .stat-val{font-family:'Oswald',sans-serif;font-size:20px;color:#d09a4a;}
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
  .report-text{font-size:15px;line-height:1.9;color:#1a2e35;} .report-text h2{font-size:17px;font-weight:600;color:#1a2e35;margin:20px 0 8px;font-family:'Oswald',sans-serif;} .report-text h3{font-size:15px;font-weight:600;color:#2c5f6e;margin:16px 0 6px;} .report-text p{margin:0 0 14px;} .report-text strong{color:#1a2e35;}

  /* Footer */
  .footer{background:#f0f5f7;border-top:1px solid #d0dfe3;padding:16px 40px;display:flex;justify-content:space-between;align-items:center;margin-top:auto;}
  .footer-brand{font-family:'Oswald',sans-serif;font-size:14px;color:#2c5f6e;}
  .footer-brand span{color:#d09a4a;font-style:italic;}
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
  ${trip.streamGaugeName?`<div class="stream-bar"><div>🏞 <span class="stream-name">${trip.streamGaugeName}</span></div>${trip.streamCFS?`<div class="stream-stats">${Number(trip.streamCFS).toLocaleString()} CFS</div>`:""}</div>`:""}
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
  const closeBtn=`<div style="position:fixed;top:12px;right:12px;z-index:9999;display:flex;gap:8px;"><button onclick="window.print()" style="background:#d09a4a;color:#1a2e35;border:none;border-radius:8px;padding:8px 16px;font-size:14px;cursor:pointer;font-family:serif;">🖨 Print / Save PDF</button><button onclick="window.close()" style="background:#1a3a45;color:#f2efe6;border:none;border-radius:8px;padding:8px 16px;font-size:14px;cursor:pointer;font-family:serif;">✕ Close</button></div>`;
  win.document.write(html.replace("</body>","</body>"));
  win.document.body.insertAdjacentHTML("afterbegin",closeBtn);
  win.document.close();
  win.onload = () => {
    setTimeout(()=>{
      win.focus();
    }, 300);
  };
}

// Plain-text serializer for a Trip Planner report — covers every field shown on screen
// (overview, hatches, bestTimes, tips, flyBoxEssentials, recommendation, bestFor, and the
// full per-river breakdown), used by the Share/Copy button. Strips citation tags and
// percentage annotations the same way the on-screen render does.
function plannerReportToText(loc, date, report){
  const dateStr = new Date(date+"T12:00:00").toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});
  const strip = s => (s||"").replace(/<cite[^>]*>|<\/cite>/g,"");
  const lines = [];
  lines.push(`Fishing Report — ${loc?.label||"Unknown location"}`);
  lines.push(dateStr);
  lines.push("");
  if(report.overview) lines.push(strip(report.overview));
  if(report.hatches){ lines.push(""); lines.push("HATCH ACTIVITY"); lines.push(strip(report.hatches)); }
  if(report.bestTimes){ lines.push(""); lines.push("BEST TIMES"); lines.push(strip(report.bestTimes)); }
  if(report.tips){ lines.push(""); lines.push("INSIDER TIPS"); lines.push(strip(report.tips)); }
  if(report.personalAngle){ lines.push(""); lines.push("YOUR TRIP HISTORY"); lines.push(strip(report.personalAngle)); }
  if(report.flyBoxEssentials?.length){ lines.push(""); lines.push("FLY BOX ESSENTIALS"); lines.push(report.flyBoxEssentials.join(", ")); }
  if(report.recommendation){ lines.push(""); lines.push("BEST BET TODAY"); lines.push(strip(report.recommendation)); }
  if(report.bestFor && Object.values(report.bestFor).some(v=>v)){
    lines.push(""); lines.push("BEST FOR");
    const labels={mostFish:"Most Fish",bestScenery:"Best Scenery",mostSolitude:"Most Solitude",beginners:"Beginners"};
    Object.entries(labels).forEach(([k,label])=>{ if(report.bestFor[k]) lines.push(`${label}: ${report.bestFor[k]}`); });
  }
  if(report.rivers?.length){
    report.rivers.forEach(r=>{
      lines.push(""); lines.push(`— ${r.name} —`);
      const meta=[];
      if(r.type) meta.push(r.type);
      if(r.cfs&&r.cfs!=="unknown") meta.push(`${r.cfs} CFS${r.condition?" · "+r.condition:""}`);
      if(r.crowdLevel) meta.push(`${r.crowdLevel} crowds`);
      if(r.driveMin!=null) meta.push(`~${r.driveMin} min drive`);
      if(meta.length) lines.push(meta.join(" · "));
      if(r.restriction) lines.push(`⚠️ ${r.restriction.status==="closure"?"CLOSED TO FISHING":"HOOT OWL RESTRICTION"}${r.restriction.hours?" — "+r.restriction.hours:""}${r.restriction.reach?" ("+r.restriction.reach+")":""}`);
      if(r.why) lines.push(`✓ ${strip(r.why)}`);
      if(r.accessPoints?.length) lines.push("Access Points: "+r.accessPoints.join(", "));
      if(r.conditions) lines.push(strip(r.conditions));
      if(r.techniques) lines.push(strip(r.techniques).replace(/\s*\(\d+-?\d*%\)/g,"").trim());
      if(r.flies?.length) lines.push("Flies: "+r.flies.join(", "));
    });
  }
  return lines.join("\n");
}

// PDF export for a Trip Planner report. Deliberately NOT sharing code with
// generateTripReportPDF (the Guide tab's export) — the two report shapes differ
// enough (guest/trip/catches/photos vs. hatch/best-times/per-river) that a shared
// refactor would risk the already-working Guide-tab export. The print-window
// mechanism and CSS look are duplicated instead, for visual consistency without
// regression risk.
function generatePlannerReportPDF(loc, date, report){
  const dateStr = new Date(date+"T12:00:00").toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});
  const strip = s => (s||"").replace(/<cite[^>]*>|<\/cite>/g,"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const paragraph = s => strip(s).replace(/\n\n/g,"</p><p>").replace(/\n/g,"<br/>");

  const bestForLabels={mostFish:["🐟","Most Fish"],bestScenery:["🏔","Best Scenery"],mostSolitude:["🧘","Most Solitude"],beginners:["🎣","Beginners"]};
  const bestForHtml=(report.bestFor&&Object.values(report.bestFor).some(v=>v))
    ? `<div class="section"><div class="section-title">Best For</div><div class="conditions-grid">${
        Object.entries(bestForLabels).map(([k,pair])=>report.bestFor[k]?`<div class="cond-item"><span class="cond-icon">${pair[0]}</span><span class="cond-val" style="font-size:12px">${strip(report.bestFor[k])}</span><span class="cond-lbl">${pair[1]}</span></div>`:"").join("")
      }</div></div><div style="height:1px;background:#e0ebee;margin:0 40px;"></div>`
    : "";

  const flyBoxHtml=report.flyBoxEssentials?.length
    ? `<div class="section"><div class="section-title">Fly Box Essentials</div><div class="flies-row">${report.flyBoxEssentials.map(f=>`<span class="fly-tag">🪶 ${f}</span>`).join("")}</div></div><div style="height:1px;background:#e0ebee;margin:0 40px;"></div>`
    : "";

  const riversHtml=(report.rivers||[]).map(r=>{
    const meta=[];
    if(r.type) meta.push(r.type);
    if(r.cfs&&r.cfs!=="unknown") meta.push(`${r.cfs} CFS${r.condition?" · "+r.condition:""}`);
    if(r.crowdLevel) meta.push(`${r.crowdLevel} crowds`);
    if(r.driveMin!=null) meta.push(`~${r.driveMin} min drive`);
    return `
    <div class="section">
      <div class="section-title">${strip(r.name)}</div>
      ${meta.length?`<div style="font-size:13px;color:#2c5f6e;margin-bottom:8px;">${meta.join(" &nbsp;·&nbsp; ")}</div>`:""}
      ${r.restriction?`<div style="font-size:13px;color:#8c4936;font-weight:600;margin-bottom:8px;">⚠️ ${r.restriction.status==="closure"?"Closed to fishing":"Hoot Owl restriction"}${r.restriction.hours?" — "+strip(r.restriction.hours):""}${r.restriction.reach?" ("+strip(r.restriction.reach)+")":""}</div>`:""}
      ${r.why?`<div style="font-size:14px;color:#4a5a3f;font-style:italic;margin-bottom:8px;">✓ ${strip(r.why)}</div>`:""}
      ${r.conditions?`<div class="report-text" style="margin-bottom:8px;"><p>${paragraph(r.conditions)}</p></div>`:""}
      ${r.techniques?`<div style="font-size:13px;color:#555;margin-bottom:8px;">${strip(r.techniques).replace(/\s*\(\d+-?\d*%\)/g,"").trim()}</div>`:""}
      ${r.accessPoints?.length?`<div style="font-size:12px;color:#6a8a94;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Access Points</div><div style="font-size:13px;color:#2c5f6e;margin-bottom:8px;">${r.accessPoints.map(strip).join(" · ")}</div>`:""}
      ${r.flies?.length?`<div class="flies-row">${r.flies.map(f=>`<span class="fly-tag">🪶 ${strip(f)}</span>`).join("")}</div>`:""}
    </div>
    <div style="height:1px;background:#e0ebee;margin:0 40px;"></div>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<title>Fishing Report — ${strip(loc?.label||"Trip Report")}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Montserrat:ital,wght@0,300;0,400;0,600;1,400&display=swap');
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'Montserrat',sans-serif;background:#fff;color:#1a2e35;width:210mm;margin:0 auto;}
  @media print{body{width:100%;}@page{margin:0;size:letter;}}
  .header{background:linear-gradient(135deg,#1a3a45,#2c5f6e);color:#f2efe6;padding:32px 40px 24px;position:relative;}
  .brand{font-family:'Oswald',sans-serif;font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#b8d4dc;margin-bottom:6px;}
  .report-title{font-family:'Oswald',sans-serif;font-size:32px;font-weight:700;color:#f2efe6;margin-bottom:4px;}
  .report-meta{font-size:14px;color:#b8d4dc;margin-top:8px;line-height:1.8;}
  .header-accent{position:absolute;bottom:0;right:40px;font-size:64px;opacity:0.15;}
  .divider-gold{height:3px;background:linear-gradient(90deg,#d09a4a,transparent);margin:0;}
  .section{padding:24px 40px;}
  .section-title{font-family:'Oswald',sans-serif;font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#2c5f6e;border-bottom:1px solid #d0dfe3;padding-bottom:8px;margin-bottom:16px;}
  .conditions-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:12px;}
  .cond-item{background:#f0f5f7;border-radius:10px;padding:12px 8px;text-align:center;border:1px solid #d0dfe3;}
  .cond-icon{display:block;font-size:20px;margin-bottom:4px;}
  .cond-val{display:block;font-family:'Oswald',sans-serif;font-size:15px;color:#1a3a45;font-weight:700;}
  .cond-lbl{display:block;font-size:10px;color:#6a8a94;text-transform:uppercase;letter-spacing:1px;margin-top:2px;}
  .flies-row{display:flex;flex-wrap:wrap;gap:8px;}
  .fly-tag{background:#f0f5f7;border:1px solid #d0dfe3;border-radius:14px;padding:4px 12px;font-size:13px;color:#2c5f6e;}
  .report-text{font-size:14px;line-height:1.7;color:#333;}
  .footer{padding:20px 40px;text-align:center;border-top:1px solid #e0ebee;}
  .footer-brand{font-family:'Oswald',sans-serif;font-size:13px;color:#2c5f6e;letter-spacing:1px;}
  .footer-brand span{color:#d09a4a;font-style:italic;}
  .footer-note{font-size:11px;color:#8a9ea4;margin-top:4px;}
</style>
</head>
<body>
<div class="header">
  <div class="brand">Guide's Choice</div>
  <div class="report-title">${strip(loc?.label||"Fishing Report")}</div>
  <div class="report-meta">${dateStr}</div>
  <div class="header-accent">🎣</div>
</div>
<div class="divider-gold"></div>

${report.overview?`<div class="section"><div class="section-title">Overview</div><div class="report-text"><p>${paragraph(report.overview)}</p></div></div><div style="height:1px;background:#e0ebee;margin:0 40px;"></div>`:""}
${report.hatches?`<div class="section"><div class="section-title">Hatch Activity</div><div class="report-text"><p>${paragraph(report.hatches)}</p></div></div><div style="height:1px;background:#e0ebee;margin:0 40px;"></div>`:""}
${report.bestTimes?`<div class="section"><div class="section-title">Best Times</div><div class="report-text"><p>${paragraph(report.bestTimes)}</p></div></div><div style="height:1px;background:#e0ebee;margin:0 40px;"></div>`:""}
${report.tips?`<div class="section"><div class="section-title">Insider Tips</div><div class="report-text"><p>${paragraph(report.tips)}</p></div></div><div style="height:1px;background:#e0ebee;margin:0 40px;"></div>`:""}
${report.personalAngle?`<div class="section"><div class="section-title">Your Trip History</div><div class="report-text"><p>${paragraph(report.personalAngle)}</p></div></div><div style="height:1px;background:#e0ebee;margin:0 40px;"></div>`:""}
${flyBoxHtml}
${report.recommendation?`<div class="section"><div class="section-title">Best Bet Today</div><div class="report-text"><p>${paragraph(report.recommendation)}</p></div></div><div style="height:1px;background:#e0ebee;margin:0 40px;"></div>`:""}
${bestForHtml}
${riversHtml}

<div class="footer">
  <div class="footer-brand">Guide's <span>Choice</span> · Find the Pattern</div>
  <div class="footer-note">Generated ${new Date().toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"})}</div>
</div>

</body>
</html>`;

  const win = window.open("","_blank","width=900,height=700");
  const closeBtn=`<div style="position:fixed;top:12px;right:12px;z-index:9999;display:flex;gap:8px;"><button onclick="window.print()" style="background:#d09a4a;color:#1a2e35;border:none;border-radius:8px;padding:8px 16px;font-size:14px;cursor:pointer;font-family:serif;">🖨 Print / Save PDF</button><button onclick="window.close()" style="background:#1a3a45;color:#f2efe6;border:none;border-radius:8px;padding:8px 16px;font-size:14px;cursor:pointer;font-family:serif;">✕ Close</button></div>`;
  win.document.write(html);
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
      const today=new Date().toISOString().split("T")[0];
      const tripDate=tripForm.date||today;
      if(tripDate<today){
        // Past-dated trip: pull conditions for that specific day, not "right now".
        // Reuses fetchHistoricalConditions — the same date-aware fetcher the per-catch
        // photo pipeline already uses — so its gauge-matching safety (uncertain matches,
        // inactive-gauge guards) applies here too, and there's no separate code path to
        // regress. Single best-match gauge only (no multi-gauge picker) since the
        // archive endpoint doesn't give us the same candidate list live gauges do.
        const h=await fetchHistoricalConditions(lat,lng,tripDate,"12");
        setTripForm(f=>({
          ...f,
          airTemp:h.airTemp||"", windSpeed:h.windSpeed||"", windDir:h.windDir||"",
          pressure:h.pressure||"", pressureTrend:"", weatherConditions:h.weatherDesc||"",
          streamCFS:h.streamCFS||f.streamCFS, streamCondition:h.streamCondition||f.streamCondition,
          streamGaugeName:h.streamGaugeName||f.streamGaugeName
        }));
        setNearbyGauges([]);
        setWxFetched(true);
        setWxLoading(false);
        return;
      }
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
          // Sort by distance and take top 5 — fetch real percentile baselines
          // only for the 5 we'll actually show (not every candidate in range).
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
      {wxFetched&&<div style={{fontSize:14,color:"#9cd47a",marginBottom:8,fontStyle:"italic"}}>✓ {(tripForm.date&&tripForm.date<new Date().toISOString().split("T")[0])?`Historical conditions for ${new Date(tripForm.date+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric"})} — adjust below if needed`:"Conditions auto-populated — adjust below if needed"}</div>}
      {nearbyGauges.length>0&&(
        <div style={{marginBottom:12}}>
          <div className="lbl" style={{marginBottom:6}}>Select Body of Water Being Fished</div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {nearbyGauges.map((g,i)=>(
              <button key={i} onClick={()=>setTripForm(f=>({...f,streamCFS:String(Math.round(g.cfs)),streamCondition:g.label,streamGaugeName:g.name}))}
                style={{padding:"10px 12px",borderRadius:10,border:"1px solid "+(tripForm.streamGaugeName===g.name?"var(--water)":"rgba(255,255,255,0.1)"),background:tripForm.streamGaugeName===g.name?"rgba(44,95,110,0.5)":"rgba(0,0,0,0.2)",color:"var(--foam)",fontFamily:"var(--font-body)",fontSize:15,cursor:"pointer",textAlign:"left",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
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
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
          <div>
            <div className="lbl" style={{marginBottom:4}}>Stream Gauge Name</div>
            <input className="inp" style={{marginBottom:0}} placeholder="e.g. Clear Creek at Golden, CO"
              value={tripForm.streamGaugeName||""}
              onChange={e=>setTripForm(f=>({...f,streamGaugeName:e.target.value}))}/>
          </div>
          <div>
            <div className="lbl" style={{marginBottom:4}}>Stream Flow (CFS)</div>
            <input className="inp" style={{marginBottom:0}} type="number" placeholder="150"
              value={tripForm.streamCFS||""}
              onChange={e=>{const v=e.target.value;const{label}=cfsLabel(v?parseFloat(v):null);setTripForm(f=>({...f,streamCFS:v,streamCondition:v?label:f.streamCondition}));}}/>
          </div>
        </div>
        <div className="lbl" style={{marginBottom:4}}>Sky / Conditions</div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {["☀️ Sunny","🌤 Partly Cloudy","☁️ Overcast","🌧 Rainy","🌫 Foggy","❄️ Snowing","🌬 Windy"].map(c=>(
            <button key={c} onClick={()=>setTripForm(f=>({...f,weatherConditions:c}))}
              style={{padding:"5px 10px",borderRadius:8,border:"1px solid "+(tripForm.weatherConditions===c?"var(--water)":"rgba(255,255,255,0.12)"),background:tripForm.weatherConditions===c?"var(--water)":"rgba(0,0,0,0.3)",color:tripForm.weatherConditions===c?"var(--foam)":"var(--stone)",fontSize:15,cursor:"pointer",fontFamily:"var(--font-body)"}}>
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
            <div style={{fontFamily:"var(--font-head)",fontSize:22,color:"var(--foam)"}}>{s.val}</div>
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
            {topFlies.map(([fly,ct])=>(<span key={fly} style={{background:"rgba(209,154,74,0.2)",border:"1px solid rgba(209,154,74,0.4)",borderRadius:20,padding:"4px 12px",fontSize:15,color:"var(--gold)"}}>🪶 {fly} <span style={{color:"var(--stone)",fontSize:14}}>×{ct}</span></span>))}
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
      <div style={{fontFamily:"var(--font-head)",fontSize:15,color:"var(--stone)",letterSpacing:1,textTransform:"uppercase",marginBottom:10}}>
        {display.length?thisYear+" Season — "+display.length+" trips":"All Trips"} · {show.reduce((s,t)=>s+(t.catches||0),0)} fish
      </div>
      {show.map(t=>(
        <div key={t.id} className="card" style={{marginBottom:10,padding:"14px 16px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
            <div>
              <div style={{fontFamily:"var(--font-head)",fontSize:15,color:"var(--foam)",fontStyle:"italic"}}>{t.location||"Unnamed Location"}</div>
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

// ── Guide Trends ────────────────────────────────────────────────────────────
// ── Guide Trends ──────────────────────────────────────────────────────────────

function GuideTrends({guests, loc, setView, setSelectedGuest, setSelectedTrip, loadTripPhotos}){
  const [sortBy, setSortBy] = React.useState("catches");
  const [filterSkill, setFilterSkill] = React.useState("All");
  const [filterMonth, setFilterMonth] = React.useState("All");
  const [filterStyle, setFilterStyle] = React.useState("All");
  const [trendsView, setTrendsView] = React.useState("rivers");
  const [aiInsight, setAiInsight] = React.useState(null);
  const [aiLoading, setAiLoading] = React.useState(false);
  const [aiError, setAiError] = React.useState(null);
  const [expandedRiver, setExpandedRiver] = React.useState(null);

  const months = ["All","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const skills = ["All","Beginner","Intermediate","Expert"];
  const styles = ["All",...FISHING_STYLES];

  const allTrips = React.useMemo(()=>
    (guests||[]).flatMap(g=>(g.trips||[]).map(t=>({
      ...t,
      guestName:g.name,
      guestSkill:g.skillLevel||g.skill_level||"",
      guestObj:g
    }))),
  [guests]);

  const filtered = React.useMemo(()=>allTrips.filter(t=>{
    if(filterSkill!=="All" && t.guestSkill!==filterSkill) return false;
    if(filterMonth!=="All"){
      const m=t.date?new Date(t.date+"T12:00:00").getMonth():-1;
      if(months[m+1]!==filterMonth) return false;
    }
    if(filterStyle!=="All" && !(t.styles||[]).includes(filterStyle)) return false;
    return true;
  }),[allTrips,filterSkill,filterMonth,filterStyle]);

  // ── River stats ──────────────────────────────────────────────
  const riverStats = React.useMemo(()=>{
    const map={};
    filtered.forEach(t=>{
      const key=t.location||"Unknown";
      if(!map[key]) map[key]={river:key,trips:[],totalCatches:0,cfsSamples:[],flies:{},months:[],skillBreakdown:{},styles:[],yearBreakdown:{}};
      const r=map[key];
      r.trips.push(t);
      r.totalCatches+=(t.catches||0);
      if(t.streamCFS) r.cfsSamples.push(parseFloat(t.streamCFS));
      (t.flies||[]).forEach(f=>{const k=f.trim();r.flies[k]=(r.flies[k]||0)+1;});
      if(t.date){
        const mo=new Date(t.date+"T12:00:00").getMonth();
        const yr=new Date(t.date+"T12:00:00").getFullYear();
        r.months.push(mo);
        r.yearBreakdown[yr]=(r.yearBreakdown[yr]||{trips:0,catches:0});
        r.yearBreakdown[yr].trips++;
        r.yearBreakdown[yr].catches+=(t.catches||0);
      }
      if(t.guestSkill) r.skillBreakdown[t.guestSkill]=(r.skillBreakdown[t.guestSkill]||0)+1;
      (t.styles||[]).forEach(s=>r.styles.push(s));
    });
    return Object.values(map).map(r=>({
      ...r,
      tripCount:r.trips.length,
      avgCatches:r.trips.length>0?(r.totalCatches/r.trips.length):0,
      avgCFS:r.cfsSamples.length>0?(r.cfsSamples.reduce((a,b)=>a+b,0)/r.cfsSamples.length):null,
      topFly:Object.entries(r.flies).sort((a,b)=>b[1]-a[1])[0]?.[0]||null,
      peakMonth:(()=>{const mc={};r.months.forEach(m=>{mc[m]=(mc[m]||0)+1;});const b=Object.entries(mc).sort((a,b)=>b[1]-a[1])[0];return b?months[parseInt(b[0])+1]:null;})(),
      topStyle:(()=>{const sc={};r.styles.forEach(s=>{sc[s]=(sc[s]||0)+1;});return Object.entries(sc).sort((a,b)=>b[1]-a[1])[0]?.[0]||null;})(),
      topSkill:Object.entries(r.skillBreakdown).sort((a,b)=>b[1]-a[1])[0]?.[0]||null
    })).sort((a,b)=>{
      if(sortBy==="catches") return b.avgCatches-a.avgCatches;
      if(sortBy==="trips") return b.tripCount-a.tripCount;
      if(sortBy==="totalCatches") return b.totalCatches-a.totalCatches;
      if(sortBy==="cfs") return (b.avgCFS||0)-(a.avgCFS||0);
      return b.avgCatches-a.avgCatches;
    });
  },[filtered,sortBy]);

  // ── Conditions stats ─────────────────────────────────────────
  const conditionStats = React.useMemo(()=>{
    const cfsBuckets={Low:{trips:0,catches:0},Medium:{trips:0,catches:0},High:{trips:0,catches:0}};
    const wxBuckets={};
    const monthPerf=Array(12).fill(null).map(()=>({trips:0,catches:0}));
    const skillPerf={Beginner:{trips:0,catches:0},Intermediate:{trips:0,catches:0},Expert:{trips:0,catches:0}};
    const yearPerf={};
    filtered.forEach(t=>{
      const c=t.catches||0;
      if(t.streamCFS){const cfs=parseFloat(t.streamCFS);const b=cfs<200?"Low":cfs<1000?"Medium":"High";cfsBuckets[b].trips++;cfsBuckets[b].catches+=c;}
      if(t.weatherConditions){const w=t.weatherConditions.trim();if(!wxBuckets[w])wxBuckets[w]={trips:0,catches:0};wxBuckets[w].trips++;wxBuckets[w].catches+=c;}
      if(t.date){
        const mo=new Date(t.date+"T12:00:00").getMonth();
        const yr=new Date(t.date+"T12:00:00").getFullYear();
        monthPerf[mo].trips++;monthPerf[mo].catches+=c;
        if(!yearPerf[yr])yearPerf[yr]={trips:0,catches:0};
        yearPerf[yr].trips++;yearPerf[yr].catches+=c;
      }
      if(t.guestSkill&&skillPerf[t.guestSkill]){skillPerf[t.guestSkill].trips++;skillPerf[t.guestSkill].catches+=c;}
    });
    return {cfsBuckets,wxBuckets,monthPerf,skillPerf,yearPerf};
  },[filtered]);

  // ── Fly stats ────────────────────────────────────────────────
  const flyStats = React.useMemo(()=>{
    const fc={};
    filtered.forEach(t=>(t.flies||[]).forEach(f=>{
      const k=f.trim();
      if(!fc[k])fc[k]={fly:k,trips:0,totalCatches:0};
      fc[k].trips++;fc[k].totalCatches+=(t.catches||0);
    }));
    return Object.values(fc).sort((a,b)=>b.trips-a.trips).slice(0,15);
  },[filtered]);

  function openTrip(trip){
    if(!setView||!setSelectedGuest||!setSelectedTrip) return;
    const guest=trip.guestObj;
    if(!guest) return;
    setSelectedGuest(guest);
    setSelectedTrip({...trip,photosLoading:true,photos:[],catchDetails:trip.catchDetails||trip.catch_details||[]});
    if(loadTripPhotos) loadTripPhotos(trip.id, trip);
    setView("tripDetail");
  }

  async function runAiInsight(){
    if(aiLoading) return;
    setAiLoading(true);setAiError(null);setAiInsight(null);
    const tripSummary=filtered.slice(0,60).map(t=>({date:t.date,location:t.location,catches:t.catches,cfs:t.streamCFS,weather:t.weatherConditions,airTemp:t.airTemp,flies:(t.flies||[]).slice(0,3),styles:(t.styles||[]),guestSkill:t.guestSkill}));
    const riverSummary=riverStats.slice(0,8).map(r=>`${r.river}: ${r.tripCount} trips, avg ${r.avgCatches.toFixed(1)} fish/trip, peak: ${r.peakMonth||"?"}, top fly: ${r.topFly||"?"}`).join("\n");
    const prompt=`You are a fishing intelligence assistant for a professional fly fishing guide. Analyze this guide's trip history and provide HONEST, SPECIFIC recommendations.\n\nRIVER PERFORMANCE SUMMARY:\n${riverSummary}\n\nTRIP DATA (${filtered.length} trips):\n${JSON.stringify(tripSummary)}\n\nCURRENT DATE: ${new Date().toLocaleDateString("en-US",{month:"long",day:"numeric"})}\nSEASON: ${["Winter","Winter","Spring","Spring","Spring","Summer","Summer","Summer","Fall","Fall","Fall","Winter"][new Date().getMonth()]}\n\nBased ONLY on this guide's actual logged data, provide:\n\n1. TOP WATER RIGHT NOW: Which 2-3 locations from their history would you put clients on TODAY? Why, based on actual data?\n\n2. CONDITIONS INSIGHT: What flow/weather conditions have produced the best catches? Cite actual data points.\n\n3. CLIENT MATCHING: Where should they put beginners vs expert clients based on their data?\n\n4. TREND ALERT: One non-obvious pattern in their data.\n\nGuide-to-guide tone. No hedging. 3-4 sentences per section max.`;
    try{const result=await askClaude(prompt,false,1400,"search");setAiInsight(result);}
    catch(e){setAiError("Could not load AI insights. Try again.");}
    setAiLoading(false);
  }

  if(!allTrips.length) return(
    <div className="empty"><div className="ei">📈</div><p>Trends will appear once you've logged trips with your clients.</p></div>
  );

  const CS=(active)=>({padding:"5px 11px",borderRadius:20,border:"1px solid "+(active?"var(--water)":"rgba(255,255,255,0.12)"),background:active?"var(--water)":"rgba(0,0,0,0.25)",color:active?"var(--foam)":"var(--stone)",fontFamily:"var(--font-body)",fontSize:14,cursor:"pointer",whiteSpace:"nowrap"});
  const BAR_MAX=Math.max(...riverStats.map(r=>r.avgCatches),0.1);
  const FLY_MAX=Math.max(...flyStats.map(f=>f.trips),1);
  const years=Object.keys(conditionStats.yearPerf).sort();

  // Horizontal bar chart helper
  function HBar({value, max, color="var(--water)", height=8}){
    return <div style={{height,background:"rgba(255,255,255,0.07)",borderRadius:4,overflow:"hidden",flex:1}}>
      <div style={{height:"100%",width:`${Math.min(100,(value/max)*100)}%`,background:color,borderRadius:4,transition:"width 0.4s"}}/>
    </div>;
  }

  return(
    <div>
      {/* Sub-nav */}
      <div style={{display:"flex",background:"rgba(0,0,0,0.25)",borderRadius:12,padding:3,gap:2,marginBottom:14}}>
        {[{id:"rivers",icon:"🏞",label:"Rivers"},{id:"conditions",icon:"☀️",label:"Conditions"},{id:"flies",icon:"🪶",label:"Flies"},{id:"ai",icon:"✨",label:"AI Insights"}].map(s=>(
          <button key={s.id} onClick={()=>setTrendsView(s.id)}
            style={{flex:1,padding:"7px 4px",border:"none",borderRadius:9,cursor:"pointer",
              background:trendsView===s.id?"rgba(44,95,110,0.6)":"transparent",
              color:trendsView===s.id?"var(--foam)":"var(--sky)",
              fontFamily:"var(--font-body)",fontSize:13,
              display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
            <span style={{fontSize:14}}>{s.icon}</span>{s.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div style={{marginBottom:12}}>
        <div style={{fontSize:13,color:"var(--stone)",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Filter · {filtered.length} trips</div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:6}}>
          {months.map(m=><button key={m} style={CS(filterMonth===m)} onClick={()=>setFilterMonth(m)}>{m}</button>)}
        </div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:6}}>
          {skills.map(s=><button key={s} style={CS(filterSkill===s)} onClick={()=>setFilterSkill(s)}>{s==="All"?"All Clients":s}</button>)}
        </div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {styles.slice(0,6).map(s=><button key={s} style={CS(filterStyle===s)} onClick={()=>setFilterStyle(s)}>{s}</button>)}
        </div>
      </div>

      {/* ══ RIVERS ══════════════════════════════════════════════ */}
      {trendsView==="rivers"&&(
        <div>
          <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap",alignItems:"center"}}>
            <div style={{fontSize:13,color:"var(--stone)"}}>Sort:</div>
            {[{k:"catches",label:"Avg Fish"},{k:"totalCatches",label:"Total Fish"},{k:"trips",label:"Trip Count"},{k:"cfs",label:"Avg Flow"}].map(s=>(
              <button key={s.k} style={CS(sortBy===s.k)} onClick={()=>setSortBy(s.k)}>{s.label}</button>
            ))}
          </div>

          {/* Avg catches horizontal bar chart */}
          <div className="card" style={{marginBottom:14,padding:"14px 16px"}}>
            <div style={{fontSize:13,color:"var(--stone)",letterSpacing:1,textTransform:"uppercase",marginBottom:12}}>Avg Fish Per Trip by Location</div>
            {riverStats.map((r,i)=>(
              <div key={r.river} style={{marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                  <div style={{fontSize:13,color:i<3?"var(--foam)":"var(--stone)",fontStyle:"italic"}}>{i<3?["🥇","🥈","🥉"][i]+" ":""}{r.river.replace("South Platte River — ","SP ").replace("Cache la Poudre River — ","Poudre ").replace("Big Thompson River — ","Big T ").replace("Boulder Creek — ","Boulder ")}</div>
                  <div style={{fontSize:13,color:"var(--sky)",fontFamily:"var(--font-head)"}}>{r.avgCatches.toFixed(1)}</div>
                </div>
                <HBar value={r.avgCatches} max={BAR_MAX} color={i===0?"var(--gold)":i===1?"var(--water)":i===2?"rgba(44,95,110,0.7)":"rgba(255,255,255,0.2)"}/>
              </div>
            ))}
          </div>

          {/* Year-over-year by river */}
          {years.length>1&&(
            <div className="card" style={{marginBottom:14,padding:"14px 16px"}}>
              <div style={{fontSize:13,color:"var(--stone)",letterSpacing:1,textTransform:"uppercase",marginBottom:12}}>Year-Over-Year Avg Catches</div>
              {riverStats.filter(r=>Object.keys(r.yearBreakdown).length>1).slice(0,4).map(r=>(
                <div key={r.river} style={{marginBottom:14}}>
                  <div style={{fontSize:13,color:"var(--foam)",marginBottom:6,fontStyle:"italic"}}>{r.river.replace("South Platte River — ","SP ").replace("Cache la Poudre River — ","Poudre ").replace("Big Thompson River — ","Big T ").replace("Boulder Creek — ","Boulder ")}</div>
                  {Object.entries(r.yearBreakdown).sort((a,b)=>a[0]-b[0]).map(([yr,data])=>{
                    const avg=data.trips>0?data.catches/data.trips:0;
                    const ymax=Math.max(...Object.values(r.yearBreakdown).map(d=>d.trips>0?d.catches/d.trips:0),0.1);
                    return(
                      <div key={yr} style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                        <div style={{fontSize:12,color:"var(--stone)",width:34}}>{yr}</div>
                        <HBar value={avg} max={ymax} color="var(--water)" height={6}/>
                        <div style={{fontSize:12,color:"var(--sky)",width:28,textAlign:"right"}}>{avg.toFixed(1)}</div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          {/* Individual river cards with tappable trips */}
          {riverStats.map((r,i)=>(
            <div key={r.river} className="card" style={{marginBottom:10,padding:"14px 16px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8,cursor:"pointer"}}
                onClick={()=>setExpandedRiver(expandedRiver===r.river?null:r.river)}>
                <div style={{flex:1,marginRight:8}}>
                  <div style={{fontFamily:"var(--font-head)",fontSize:15,color:"var(--foam)",fontStyle:"italic",marginBottom:2}}>
                    {i<3?["🥇","🥈","🥉"][i]+" ":""}{r.river}
                  </div>
                  <div style={{fontSize:13,color:"var(--stone)"}}>{r.tripCount} trip{r.tripCount!==1?"s":""} · {r.totalCatches} fish total</div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontFamily:"var(--font-head)",fontSize:22,color:"var(--sky)"}}>{r.avgCatches.toFixed(1)}</div>
                    <div style={{fontSize:12,color:"var(--stone)"}}>avg/trip</div>
                  </div>
                  <div style={{color:"var(--stone)",fontSize:14}}>{expandedRiver===r.river?"▲":"▼"}</div>
                </div>
              </div>
              <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:8}}>
                {r.avgCFS&&<span style={{fontSize:13,background:"rgba(44,95,110,0.3)",borderRadius:20,padding:"2px 9px",color:"var(--sky)"}}>💧 {Math.round(r.avgCFS)} CFS avg</span>}
                {r.peakMonth&&<span style={{fontSize:13,background:"rgba(74,122,58,0.25)",borderRadius:20,padding:"2px 9px",color:"#9cd47a"}}>📅 Peak: {r.peakMonth}</span>}
                {r.topFly&&<span style={{fontSize:13,background:"rgba(209,154,74,0.2)",borderRadius:20,padding:"2px 9px",color:"var(--gold)"}}>🪶 {r.topFly}</span>}
                {r.topSkill&&<span style={{fontSize:13,background:"rgba(255,255,255,0.07)",borderRadius:20,padding:"2px 9px",color:"var(--stone)"}}>👤 {r.topSkill}</span>}
                {r.topStyle&&<span style={{fontSize:13,background:"rgba(255,255,255,0.07)",borderRadius:20,padding:"2px 9px",color:"var(--stone)"}}>🎣 {r.topStyle}</span>}
              </div>
              {/* Expanded trip list */}
              {expandedRiver===r.river&&(
                <div style={{borderTop:"1px solid rgba(255,255,255,0.08)",paddingTop:10,marginTop:4}}>
                  <div style={{fontSize:12,color:"var(--stone)",letterSpacing:1,textTransform:"uppercase",marginBottom:8}}>Trips — tap to view details</div>
                  {r.trips.sort((a,b)=>new Date(b.date)-new Date(a.date)).map(t=>(
                    <div key={t.id||t.date} onClick={()=>openTrip(t)}
                      style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 10px",marginBottom:4,background:"rgba(255,255,255,0.04)",borderRadius:8,cursor:"pointer",borderLeft:"2px solid var(--water)"}}>
                      <div>
                        <div style={{fontSize:14,color:"var(--foam)"}}>{t.guestName}</div>
                        <div style={{fontSize:12,color:"var(--stone)"}}>{t.date?new Date(t.date+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}):""} · {(t.styles||[]).join(", ")||t.type}</div>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontFamily:"var(--font-head)",fontSize:18,color:"var(--sky)"}}>{t.catches||0}</div>
                        <div style={{fontSize:11,color:"var(--stone)"}}>fish</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ══ CONDITIONS ══════════════════════════════════════════ */}
      {trendsView==="conditions"&&(
        <div>
          {/* Monthly bar chart — improved */}
          <div className="card" style={{marginBottom:12,padding:"14px 16px"}}>
            <div style={{fontSize:13,color:"var(--stone)",letterSpacing:1,textTransform:"uppercase",marginBottom:4}}>Avg Catches by Month</div>
            <div style={{fontSize:12,color:"var(--stone)",marginBottom:12}}>All years combined</div>
            {(()=>{
              const maxAvg=Math.max(...conditionStats.monthPerf.map(m=>m.trips>0?m.catches/m.trips:0),0.1);
              return conditionStats.monthPerf.map((m,i)=>{
                const avg=m.trips>0?m.catches/m.trips:0;
                const isPeak=avg===maxAvg&&m.trips>0;
                return(
                  <div key={i} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                    <div style={{fontSize:13,color:isPeak?"var(--gold)":"var(--stone)",width:28,fontWeight:isPeak?"bold":"normal"}}>{months[i+1]}</div>
                    <HBar value={avg} max={maxAvg} color={isPeak?"var(--gold)":"var(--water)"} height={10}/>
                    <div style={{fontSize:13,color:isPeak?"var(--gold)":"var(--sky)",width:34,textAlign:"right"}}>{m.trips>0?avg.toFixed(1):"—"}</div>
                    <div style={{fontSize:11,color:"var(--stone)",width:24}}>{m.trips>0?`${m.trips}t`:""}</div>
                  </div>
                );
              });
            })()}
          </div>

          {/* Year-over-year total trips & catches */}
          {years.length>1&&(
            <div className="card" style={{marginBottom:12,padding:"14px 16px"}}>
              <div style={{fontSize:13,color:"var(--stone)",letterSpacing:1,textTransform:"uppercase",marginBottom:12}}>Year-Over-Year Performance</div>
              {(()=>{
                const maxTrips=Math.max(...years.map(yr=>conditionStats.yearPerf[yr].trips),1);
                const maxCatches=Math.max(...years.map(yr=>conditionStats.yearPerf[yr].catches),1);
                return years.map(yr=>{
                  const d=conditionStats.yearPerf[yr];
                  const avg=d.trips>0?d.catches/d.trips:0;
                  return(
                    <div key={yr} style={{marginBottom:12}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                        <div style={{fontSize:14,color:"var(--foam)",fontFamily:"var(--font-head)"}}>{yr}</div>
                        <div style={{fontSize:13,color:"var(--stone)"}}>{d.trips} trips · {d.catches} fish · {avg.toFixed(1)} avg</div>
                      </div>
                      <div style={{display:"flex",gap:4,alignItems:"center"}}>
                        <div style={{fontSize:11,color:"var(--stone)",width:40}}>trips</div>
                        <HBar value={d.trips} max={maxTrips} color="var(--water)" height={6}/>
                      </div>
                      <div style={{display:"flex",gap:4,alignItems:"center",marginTop:3}}>
                        <div style={{fontSize:11,color:"var(--stone)",width:40}}>fish</div>
                        <HBar value={d.catches} max={maxCatches} color="var(--gold)" height={6}/>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          )}

          {/* Flow buckets with bar chart */}
          <div className="card" style={{marginBottom:12,padding:"14px 16px"}}>
            <div style={{fontSize:13,color:"var(--stone)",letterSpacing:1,textTransform:"uppercase",marginBottom:12}}>Avg Fish by Flow Level</div>
            {(()=>{
              const buckets=[["Low","🟢 Low (<200 CFS)"],["Medium","🟡 Med (200–1000)"],["High","🔴 High (>1000)"]];
              const maxAvg=Math.max(...buckets.map(([k])=>conditionStats.cfsBuckets[k].trips>0?conditionStats.cfsBuckets[k].catches/conditionStats.cfsBuckets[k].trips:0),0.1);
              return buckets.map(([k,label])=>{
                const d=conditionStats.cfsBuckets[k];
                const avg=d.trips>0?d.catches/d.trips:0;
                return d.trips>0&&(
                  <div key={k} style={{marginBottom:10}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                      <div style={{fontSize:13,color:"var(--foam)"}}>{label}</div>
                      <div style={{fontSize:13,color:"var(--sky)"}}>{avg.toFixed(1)} avg · {d.trips} trips</div>
                    </div>
                    <HBar value={avg} max={maxAvg} color="var(--water)" height={8}/>
                  </div>
                );
              });
            })()}
          </div>

          {/* Weather performance */}
          {Object.keys(conditionStats.wxBuckets).length>0&&(
            <div className="card" style={{marginBottom:12,padding:"14px 16px"}}>
              <div style={{fontSize:13,color:"var(--stone)",letterSpacing:1,textTransform:"uppercase",marginBottom:12}}>Avg Fish by Weather</div>
              {(()=>{
                const sorted=Object.entries(conditionStats.wxBuckets).filter(([,d])=>d.trips>=2).sort((a,b)=>b[1].catches/b[1].trips-a[1].catches/a[1].trips);
                const maxAvg=Math.max(...sorted.map(([,d])=>d.catches/d.trips),0.1);
                return sorted.slice(0,6).map(([wx,d])=>{
                  const avg=d.catches/d.trips;
                  return(
                    <div key={wx} style={{marginBottom:10}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                        <div style={{fontSize:13,color:"var(--foam)"}}>{wx}</div>
                        <div style={{fontSize:13,color:"var(--sky)"}}>{avg.toFixed(1)} · {d.trips} trips</div>
                      </div>
                      <HBar value={avg} max={maxAvg} color="var(--water)" height={8}/>
                    </div>
                  );
                });
              })()}
            </div>
          )}

          {/* Client skill performance */}
          <div className="card" style={{padding:"14px 16px"}}>
            <div style={{fontSize:13,color:"var(--stone)",letterSpacing:1,textTransform:"uppercase",marginBottom:12}}>Avg Fish by Client Level</div>
            {(()=>{
              const entries=Object.entries(conditionStats.skillPerf).filter(([,d])=>d.trips>0);
              const maxAvg=Math.max(...entries.map(([,d])=>d.catches/d.trips),0.1);
              return entries.map(([skill,d])=>{
                const avg=d.catches/d.trips;
                return(
                  <div key={skill} style={{marginBottom:10}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                      <div style={{fontSize:13,color:"var(--foam)"}}>{skill==="Beginner"?"🌱":skill==="Intermediate"?"🎣":"🏆"} {skill}</div>
                      <div style={{fontSize:13,color:"var(--sky)"}}>{avg.toFixed(1)} avg · {d.trips} trips</div>
                    </div>
                    <HBar value={avg} max={maxAvg} color={skill==="Expert"?"var(--gold)":skill==="Intermediate"?"var(--water)":"rgba(255,255,255,0.25)"} height={8}/>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      )}

      {/* ══ FLIES ═══════════════════════════════════════════════ */}
      {trendsView==="flies"&&(
        <div>
          {flyStats.length===0&&<div style={{color:"var(--stone)",fontSize:15,textAlign:"center",padding:24}}>No fly data in filtered trips.</div>}

          {/* Horizontal bar chart */}
          <div className="card" style={{marginBottom:14,padding:"14px 16px"}}>
            <div style={{fontSize:13,color:"var(--stone)",letterSpacing:1,textTransform:"uppercase",marginBottom:12}}>Trips Used (Top {flyStats.length})</div>
            {flyStats.map((f,i)=>(
              <div key={f.fly} style={{marginBottom:8}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                  <div style={{fontSize:13,color:i<3?"var(--foam)":"var(--stone)"}}>{i<3?["🥇","🥈","🥉"][i]+" ":"🪶 "}{f.fly}</div>
                  <div style={{fontSize:13,color:"var(--gold)"}}>{f.trips}t · {f.totalCatches}f</div>
                </div>
                <HBar value={f.trips} max={FLY_MAX} color={i===0?"var(--gold)":i<3?"var(--water)":"rgba(255,255,255,0.2)"} height={7}/>
              </div>
            ))}
          </div>

          {/* Card list with tappable trips */}
          <div style={{fontSize:13,color:"var(--stone)",letterSpacing:1,textTransform:"uppercase",marginBottom:8}}>All Flies · tap to see which trips</div>
          {flyStats.map((f,i)=>{
            const flyTrips=filtered.filter(t=>(t.flies||[]).map(x=>x.trim()).includes(f.fly)).sort((a,b)=>new Date(b.date)-new Date(a.date));
            return(
              <div key={f.fly} className="card" style={{marginBottom:8,padding:"12px 16px"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6,cursor:"pointer"}} onClick={()=>setExpandedRiver(expandedRiver===f.fly?null:f.fly)}>
                  <div>
                    <div style={{fontFamily:"var(--font-body)",fontSize:16,color:"var(--foam)"}}>{i<3?["🥇","🥈","🥉"][i]+" ":"🪶 "}{f.fly}</div>
                    <div style={{fontSize:13,color:"var(--stone)",marginTop:2}}>{f.trips} trip{f.trips!==1?"s":""} · {f.totalCatches} total catches</div>
                  </div>
                  <div style={{color:"var(--stone)",fontSize:14}}>{expandedRiver===f.fly?"▲":"▼"}</div>
                </div>
                {expandedRiver===f.fly&&(
                  <div style={{borderTop:"1px solid rgba(255,255,255,0.08)",paddingTop:8}}>
                    {flyTrips.slice(0,8).map(t=>(
                      <div key={t.id||t.date} onClick={()=>openTrip(t)}
                        style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 8px",marginBottom:3,background:"rgba(255,255,255,0.04)",borderRadius:7,cursor:"pointer",borderLeft:"2px solid var(--gold)"}}>
                        <div>
                          <div style={{fontSize:13,color:"var(--foam)"}}>{t.guestName}</div>
                          <div style={{fontSize:11,color:"var(--stone)"}}>{t.date?new Date(t.date+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}):""} · {(t.location||"").replace("South Platte River — ","SP ").replace("Cache la Poudre River — ","Poudre ").replace("Big Thompson River — ","Big T ")}</div>
                        </div>
                        <div style={{fontFamily:"var(--font-head)",fontSize:16,color:"var(--sky)"}}>{t.catches||0}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ══ AI INSIGHTS ═════════════════════════════════════════ */}
      {trendsView==="ai"&&(
        <div>
          <div style={{background:"rgba(44,95,110,0.15)",border:"1px solid rgba(44,95,110,0.3)",borderRadius:14,padding:"14px 16px",marginBottom:14}}>
            <div style={{fontSize:15,color:"var(--sky)",lineHeight:1.6,marginBottom:10}}>
              AI analyzes your <strong style={{color:"var(--foam)"}}>{filtered.length} logged trips</strong> and gives guide-to-guide recommendations based on your actual data.
            </div>
            {(filterMonth!=="All"||filterSkill!=="All"||filterStyle!=="All")&&(
              <div style={{fontSize:13,color:"var(--stone)"}}>
                Active filters: {[filterMonth!=="All"&&filterMonth,filterSkill!=="All"&&filterSkill,filterStyle!=="All"&&filterStyle].filter(Boolean).join(" · ")}
              </div>
            )}
          </div>
          <button className="btn btnp" onClick={runAiInsight} disabled={aiLoading} style={{width:"100%",marginBottom:16,fontSize:16}}>
            {aiLoading?"⏳ Analyzing your trips…":"✨ Get AI Recommendations"}
          </button>
          {aiError&&<div style={{color:"var(--red)",fontSize:15,marginBottom:12,padding:"10px 14px",background:"rgba(150,80,80,0.2)",borderRadius:10}}>{aiError}</div>}
          {aiInsight&&(
            <div style={{background:"rgba(0,0,0,0.3)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:14,padding:"16px"}}>
              <div style={{fontSize:13,color:"var(--gold)",letterSpacing:1,textTransform:"uppercase",marginBottom:12}}>Guide Intelligence · {new Date().toLocaleDateString("en-US",{month:"short",day:"numeric"})}</div>
              <div style={{fontSize:16,color:"var(--foam)",lineHeight:1.75,whiteSpace:"pre-wrap"}}>{aiInsight}</div>
              <div style={{marginTop:12,fontSize:13,color:"var(--stone)",fontStyle:"italic"}}>Based on your {filtered.length} logged trips. Adjust filters above to refine.</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// ── Guide Saved Gauges ────────────────────────────────────────────────────────
function GuideSavedGauges({user}){
  const [gaugeInput,setGaugeInput]=useState("");
  const [savedGauges,setSavedGauges]=useState([]);
  const [showStarredOnly,setShowStarredOnly]=useState(false);
  const [gaugeAdding,setGaugeAdding]=useState(false);
  const [sgMap,setSgMap]=useState({});
  const [expanded,setExpanded]=useState(null);
  const [loading,setLoading]=useState(true);
  useEffect(()=>{
    if(!sb||!user?.id){setLoading(false);return;}
    loadSavedGaugesOrdered(user.id).then(d=>{setSavedGauges(d);setLoading(false);});
  },[user?.id]);
  const idSetKey=[...savedGauges.map(g=>g.id)].sort().join(",");
  useEffect(()=>{
    if(!savedGauges.length){setSgMap({});return;}
    (async()=>{
      // One batched new-API call for all gauges; legacy per-site fallback for any it misses
      var nwMap={};
      try{
        var feats=await nwLatest(savedGauges.map(g=>g.site_no),"00060");
        feats.forEach(f=>{var sn=nwSiteNo(f.properties.monitoring_location_id);var v=parseFloat(f.properties.value);if(sn&&!isNaN(v))nwMap[sn]=v;});
      }catch{}
      var rows=await Promise.all(savedGauges.map(async g=>{
        if(nwMap[g.site_no]!=null){const cfs=nwMap[g.site_no];const{label,cls}=cfsLabel(cfs);return{...g,cfs,label,cls};}
        try{const r=await fetch("https://waterservices.usgs.gov/nwis/iv/?format=json&sites="+g.site_no+"&parameterCd=00060&siteStatus=all");const d=await r.json();const ts=d.value?.timeSeries?.[0];const raw=ts?.values?.[0]?.value?.[0]?.value;const rawDt=ts?.values?.[0]?.value?.[0]?.dateTime;const cfs=(raw!=null&&legacyFresh(rawDt))?parseFloat(raw):null;const{label,cls}=cfsLabel(cfs);return{...g,cfs,label,cls};}
        catch{return{...g,cfs:null,label:"N/A",cls:""};}
      }));
      setSgMap(m=>{const next={...m};rows.forEach(r=>{next[r.id]=r;});return next;});
      // Forecast enrichment via the same shared enrichWithNWPSForecasts the Intel tab's
      // two gauge lists use. This list never resolved coordinates before (it only ever
      // needed CFS), so lat/lng is fetched here first — matching NWPS points is done by
      // proximity, and without coords nothing can match. Second pass, so CFS still
      // renders immediately and a slow NOAA never delays the list.
      try{
        const withCoords=await Promise.all(rows.map(async r=>{
          if(r.lat!=null&&r.lng!=null) return r;
          try{const loc=await nwLocation(r.site_no);return loc?{...r,lat:loc.lat,lng:loc.lng}:r;}catch{return r;}
        }));
        const enriched=await enrichWithNWPSForecasts(withCoords);
        setSgMap(m=>{const next={...m};enriched.forEach(r=>{next[r.id]=r;});return next;});
        // NWM fallback (SPEC_streamflow_forecast.md) — for gauges with a dead or
        // never-reporting sensor (real confirmed cases tonight: Hot Sulphur Springs
        // offline since 1994, Boulder Creek near Orodell offline since 1993), show a
        // modeled current reading instead of blank, plus a 5-day outlook for whichever
        // reaches happen to be in nwm_tracked_reaches. Purely additive — never touches a
        // gauge that already has a real cfs. Label always says "(modeled)" — this must
        // never look identical to a real gauge reading, same trust rule as everywhere
        // else this fallback appears.
        try{
          await Promise.all(enriched.map(async(r)=>{
            if(r.cfs!=null||r.lat==null||r.lng==null) return;
            try{
              const nwm=await fetchNWMStreamflow(r.lat,r.lng);
              if(nwm&&nwm.cfs!=null){
                const rounded=Math.round(nwm.cfs);
                const{label,cls}=cfsLabel(rounded);
                r.cfs=rounded;r.label=label+" (modeled)";r.cls=cls;
                if(nwm.reachId!=null){
                  try{const outlook=await fetchNWMForecastOutlook(sb,nwm.reachId);if(outlook&&outlook.length)r.nwmOutlook=outlook;}catch{}
                }
              }
            }catch{}
          }));
          setSgMap(m=>{const next={...m};enriched.forEach(r=>{next[r.id]=r;});return next;});
        }catch{}
      }catch{}
    })();
  },[idSetKey]);
  // Render order always follows savedGauges (the manually-orderable source of truth) —
  // reordering just re-maps already-fetched data, it never re-fetches or re-orders on its own.
  const sgData=savedGauges.map(g=>sgMap[g.id]||g);
  function moveGauge(id,direction){
    moveSavedGaugeCore(setSavedGauges,user?.id,id,direction);
  }
  async function addGauge(){
    if(!gaugeInput.trim()||!sb)return;setGaugeAdding(true);
    let siteNo=gaugeInput.trim();const match=siteNo.match(/sites?=(\d+)/i)||siteNo.match(/(\d{8,})/);if(match)siteNo=match[1];
    try{let name=null;
      try{const loc=await nwLocation(siteNo);if(loc&&loc.name&&!loc.name.startsWith("Site "))name=loc.name;}catch{}
      if(!name){try{const r=await fetch("https://waterservices.usgs.gov/nwis/iv/?format=json&sites="+siteNo+"&parameterCd=00060");const d=await r.json();const ts=d.value?.timeSeries?.[0];name=ts?.sourceInfo?.siteName||null;}catch{}}
      name=name||"Site "+siteNo;const{data}=await sb.from("saved_gauges").insert({user_id:user.id,site_no:siteNo,name,url:"https://waterdata.usgs.gov/monitoring-location/"+siteNo+"/",sort_order:savedGauges.length}).select().single();if(data){setSavedGauges(g=>[...g,data]);setGaugeInput("");}}
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
            <div><div style={{fontFamily:"var(--font-head)",fontSize:14,color:"var(--foam)",fontStyle:"italic"}}>{g.name}</div><div style={{fontSize:14,color:"var(--stone)",marginTop:3}}>Site {g.site_no}</div></div>
            <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4}}>
              {g.cfs!=null&&<span className={"gbadge "+(g.cls||"")}>{g.label}</span>}
              <ForecastBadge cfs={g.cfs} forecastCfs={g.forecastCfs}/>
              {g.nwmOutlook&&g.nwmOutlook.length>0&&(()=>{const vals=g.nwmOutlook.map(d=>d.cfs).filter(v=>v!=null);if(!vals.length)return null;const lo=Math.round(Math.min(...vals)),hi=Math.round(Math.max(...vals));return<span style={{fontSize:14,background:"rgba(150,130,180,0.15)",border:"1px dashed rgba(150,130,180,0.4)",borderRadius:12,padding:"2px 8px",color:"#b8a8d0"}} title="NOAA National Water Model — not an official NWS forecast, and not calibrated to a local gauge">📅 5-day: {lo===hi?`${lo}`:`${lo}–${hi}`} cfs (modeled)</span>})()}
            </div>
          </div>
          <div style={{display:"flex",gap:10,marginTop:10,alignItems:"center"}}>
            <a href={g.url||"https://waterdata.usgs.gov/monitoring-location/"+g.site_no+"/"} target="_blank" rel="noreferrer" style={{fontSize:15,color:"var(--sky)",textDecoration:"none"}}>📊 View Chart</a>
            <button onClick={async(e)=>{e.stopPropagation();await sb.from("saved_gauges").delete().eq("id",g.id);setSavedGauges(x=>x.filter(s=>s.id!==g.id));}} style={{background:"none",border:"none",color:"var(--stone)",fontSize:15,cursor:"pointer",padding:0,fontFamily:"var(--font-body)"}}>✕ Remove</button>
            <span style={{fontSize:14,color:"var(--stone)",marginLeft:8}}>{expanded===i?"▲ hide":"▼ chart"}</span>
            <span style={{display:"flex",alignItems:"center",marginLeft:"auto",gap:2}}>
              <button onClick={e=>{e.stopPropagation();moveGauge(g.id,-1);}} disabled={i===0}
                style={{background:"none",border:"none",color:i===0?"rgba(255,255,255,0.15)":"var(--stone)",cursor:i===0?"default":"pointer",fontSize:16,padding:4,lineHeight:1}}>↑</button>
              <button onClick={e=>{e.stopPropagation();moveGauge(g.id,1);}} disabled={i===sgData.length-1}
                style={{background:"none",border:"none",color:i===sgData.length-1?"rgba(255,255,255,0.15)":"var(--stone)",cursor:i===sgData.length-1?"default":"pointer",fontSize:16,padding:4,lineHeight:1}}>↓</button>
            </span>
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
  const [cropTripPhotoIdx, setCropTripPhotoIdx] = useState(null);
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
      // Show cache instantly while fresh data loads in the background
      try{
        const cached=localStorage.getItem("tl_guests_"+user.id);
        if(cached){
          const parsed=JSON.parse(cached);
          if(Array.isArray(parsed)&&parsed.length){setGuests(parsed);setGuestsLoading(false);}
        }
      }catch(he){void 0;}
    }
  },[user?.id]);
  const [view, setView] = useState("list"); // list | guest | addGuest | editGuest | addTrip | editTrip | tripDetail
  const [guideSection, setGuideSection] = useState("clients");
  const [selectedGuest, setSelectedGuest] = useState(null);
  const [selectedTrip, setSelectedTrip] = useState(null);
  const [guideIntelLoading, setGuideIntelLoading] = useState(false);
  const [guideIntelError, setGuideIntelError] = useState(null);
  // Persist which trip is open so an iOS reload (e.g. after closing the PDF tab) lands back on it
  useEffect(()=>{
    try{
      if(view==="tripDetail"&&selectedGuest?.id&&selectedTrip?.id) sessionStorage.setItem("tl_guide_open",JSON.stringify({g:selectedGuest.id,t:selectedTrip.id}));
      else if(view==="list") sessionStorage.removeItem("tl_guide_open");
    }catch{}
  },[view,selectedGuest?.id,selectedTrip?.id]);

  const guestForm0 = {name:"",birthday:"",address:"",address2:"",city:"",state:"",zip:"",email:"",phone:"",notes:"",dietary:"",skillLevel:"",handedness:""};

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

      // Auto-migrate any pre-login local guests/trips to this account (was a manual button)
      try{
        const localGuests=JSON.parse(localStorage.getItem("tl_guests")||"[]");
        const localTrips=JSON.parse(localStorage.getItem("tl_trips")||"[]");
        if(localGuests.length){
          for(const g of localGuests){
            const {id:oldId,...gData}=g;
            const {data:newG,error}=await sb.from("guests").insert({user_id:user.id,name:gData.name,birthday:gData.birthday,address:gData.address,email:gData.email,phone:gData.phone,notes:gData.notes,dietary:gData.dietary,skill_level:gData.skillLevel||gData.skill_level}).select().single();
            if(!error&&newG){
              const gTrips=localTrips.filter(t=>t.guest_id===oldId);
              for(const t of gTrips){
                await sb.from("trips").insert({user_id:user.id,guest_id:newG.id,date:t.date,location:t.location,type:t.type,styles:t.styles||[],catches:t.catches||0,flies:t.flies||[],gear:t.gear,guide_notes:t.guideNotes||t.guide_notes,photos:t.photos||[],trip_cost:t.tripCost||t.trip_cost,tip_amount:t.tipAmount||t.tip_amount,report_text:t.reportText||t.report_text,air_temp:t.airTemp||t.air_temp,water_temp:t.waterTemp||t.water_temp,weather_conditions:t.weatherConditions||t.weather_conditions,wind_speed:t.windSpeed||t.wind_speed,wind_dir:t.windDir||t.wind_dir,pressure:t.pressure,pressure_trend:t.pressureTrend||t.pressure_trend,stream_cfs:t.streamCFS||t.stream_cfs,stream_condition:t.streamCondition||t.stream_condition,stream_gauge_name:t.streamGaugeName||t.stream_gauge_name});
              }
            }
          }
          localStorage.removeItem("tl_guests");
          localStorage.removeItem("tl_trips");
        }
      }catch(migErr){void 0;}

      // Logged in via Supabase - load from cloud (guests + trips fetched in PARALLEL)
      const [gRes,tRes]=await Promise.all([
        sb.from("guests").select("*").eq("user_id",user.id).order("name",{ascending:true}),
        sb.from("trips").select("id,guest_id,date,location,type,styles,catches,flies,gear,guide_notes,trip_cost,tip_amount,report_text,air_temp,water_temp,weather_conditions,wind_speed,wind_dir,pressure,pressure_trend,stream_cfs,stream_condition,stream_gauge_name,catch_details").eq("user_id",user.id).order("date",{ascending:false})
      ]);
      const {data:gData, error:gErr}=gRes;
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
      const {data:tData, error:tErr}=tRes;
      if(tErr) console.error("Trip load error:",tErr.message);
      const trips=tData||[];
      const guestsWithTrips=gData.map(g=>({
        ...g,
        skillLevel:g.skill_level,
        handedness:g.handedness,
        trips:trips.filter(t=>t.guest_id===g.id).map(t=>({
          id:t.id,date:t.date,location:t.location,type:t.type,
          styles:t.styles||[],catches:t.catches||0,flies:t.flies||[],
          gear:t.gear,guideNotes:t.guide_notes,photos:[],
          tripCost:t.trip_cost,tipAmount:t.tip_amount,reportText:t.report_text,
          airTemp:t.air_temp,waterTemp:t.water_temp,weatherConditions:t.weather_conditions,
          windSpeed:t.wind_speed,windDir:t.wind_dir,pressure:t.pressure,pressureTrend:t.pressure_trend,
          streamCFS:t.stream_cfs,streamCondition:t.stream_condition,streamGaugeName:t.stream_gauge_name,
          catchDetails:t.catch_details||[],
          aiIntel:t.ai_intel||"",aiIntelGeneratedAt:t.ai_intel_generated_at||null
        }))
      }));
      setGuests(guestsWithTrips);
      setGuestsLoading(false);
      // Deep-restore: reopen the trip that was open before a reload
      try{
        const saved=JSON.parse(sessionStorage.getItem("tl_guide_open")||"null");
        if(saved){
          const g=guestsWithTrips.find(x=>x.id===saved.g);
          const t=g&&(g.trips||[]).find(x=>x.id===saved.t);
          if(g&&t){setSelectedGuest(g);setSelectedTrip(t);setView("tripDetail");}
          sessionStorage.removeItem("tl_guide_open");
        }
      }catch{}
      // Update cache with fresh Supabase data (strip ALL photos incl. catch detail photos — base64 blows the localStorage quota and silently kills the cache)
      try{
        const cacheKey="tl_guests_"+user.id;
        const safe=guestsWithTrips.map(g=>({...g,trips:(g.trips||[]).map(t=>({...t,photos:[],catchDetails:(t.catchDetails||[]).map(d=>({...d,photo:null}))}))}));
        localStorage.setItem(cacheKey, JSON.stringify(safe));
      }catch(ce){void 0;}
    }
    load();
  },[user]);

  // Upload a base64 photo to Supabase Storage, return public URL
  // (duplicate uploadPhotoToStorage removed — global single source of truth handles downscale + upload)

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

  // Per-client trip intel: grounded in this client's OTHER logged trips (not the
  // whole book — that's GuideTrends' job). Species come from catchDetails since
  // guide trips don't have a separate catches-table link the way personal trips do.
  async function handleGenerateGuideIntel(trip, guest){
    if(guideIntelLoading) return;
    setGuideIntelLoading(true); setGuideIntelError(null);
    try{
      const deriveSpecies=t=>[...new Set((t.catchDetails||[]).map(cd=>cd.species).filter(s=>s&&s!=="Unidentified"&&s!=="Unknown"))];
      // catchDetails don't track a per-catch fly (only the trip-level "Flies That
      // Worked" list), so pass an empty flies array per catch — generateTripIntel's
      // grounding rules already forbid inferring a fly-to-catch link that isn't there.
      const curCatches=(trip.catchDetails||[]).filter(cd=>cd.species&&cd.species!=="Unidentified"&&cd.species!=="Unknown").map(cd=>({
        species:cd.species, flies:[], time:cd.time||null,
        airTemp:cd.airTemp||null, streamCFS:cd.streamCFS||null, weather:cd.weatherDesc||null
      }));
      const hist=(guest?.trips||[]).filter(t=>t.id!==trip.id).map(t=>({...t, species:deriveSpecies(t)}));
      const text=await generateTripIntel(guest?.name?`${guest.name}`:"this client", trip, curCatches, hist);
      const now=new Date().toISOString();
      if(sb) await sb.from("trips").update({ai_intel:text, ai_intel_generated_at:now}).eq("id",trip.id);
      const upd={...trip, aiIntel:text, aiIntelGeneratedAt:now};
      setSelectedTrip(upd);
      setGuests(gs=>gs.map(g=>({...g,trips:(g.trips||[]).map(t=>t.id===trip.id?upd:t)})));
    }catch(e){
      setGuideIntelError("Could not generate intel. Try again.");
    }
    setGuideIntelLoading(false);
  }

  // Called by PhotoCropModal for a trip catch photo. Trip photos are a different data
  // model from the standalone Catch Log (a trip_photos table row per photo, ordered by
  // sort_order and index-aligned with trips.catch_details — see loadTripPhotos above),
  // so this mirrors the Remove-photo handler's persist-then-update-state pattern instead
  // of reusing handleCropSave from the standalone catches flow.
  async function handleTripCropSave(idx,dataUrl){
    const oldUrl=selectedTrip.photos[idx];
    const uploaded=sb?await uploadPhotoToStorage(dataUrl,`trips/${selectedTrip.id}`):null;
    if(sb&&!uploaded){
      window.alert("Couldn't save that crop — check your connection and try again.");
      return;
    }
    const newUrl=uploaded||dataUrl;
    const newPhotos=[...selectedTrip.photos];
    newPhotos[idx]=newUrl;
    if(sb){
      // Persist FIRST, then update the screen — never the other way around
      const{error:e1}=await sb.from("trip_photos").update({photo:newUrl}).eq("trip_id",selectedTrip.id).eq("photo",oldUrl);
      if(e1){ window.alert("Could not save the crop — please try again. ("+e1.message+")"); return; }
    }
    const upd={...selectedTrip,photos:newPhotos};
    setSelectedTrip(upd);
    setGuests(gs=>{
      const next=gs.map(g=>({...g,trips:(g.trips||[]).map(t=>t.id===selectedTrip.id?upd:t)}));
      try{
        const safe=next.map(g=>({...g,trips:(g.trips||[]).map(t=>({...t,photos:[],catchDetails:(t.catchDetails||[]).map(d2=>({...d2,photo:null}))}))}));
        localStorage.setItem("tl_guests_"+user.id,JSON.stringify(safe));
      }catch(ce){void 0;}
      return next;
    });
    setCropTripPhotoIdx(null);
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
      catch_details:(tripData.catchDetails||[]).map(d=>{const{_id,...rest}=d;return{...rest,analyzing:false};})
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
        catch_details:(tripData.catchDetails||[]).map(d=>{const{_id,...rest}=d;return{...rest,analyzing:false};})
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
  const [savingTrip, setSavingTrip] = useState(false);
  const [savingGuest, setSavingGuest] = useState(false);
  const [report, setReport] = useState(null);
  const photoRef = useRef();

  async function saveGuest(){
    if(!guestForm.name.trim()||savingGuest) return;
    setSavingGuest(true);
    try{
      const {name,birthday,address,address2,city,state,zip,email,phone,notes,dietary,skillLevel,handedness}=guestForm;
      const data=await saveGuestToDb({name,birthday,address,address2,city,state,zip,email,phone,notes,dietary,skill_level:skillLevel,handedness});
      // Use returned DB data or create local record as fallback
      const guest = data || {id:"local-"+Date.now(),name,birthday,address,email,phone,notes,dietary};
      setGuests(gs=>[...gs,{...guest,trips:[]}]);
      setGuestForm(guestForm0);
      setView("list");
    } finally {
      setSavingGuest(false);
    }
  }

  async function saveTrip(){
    if(savingTrip) return; // Prevents a fast double-tap (or slow network + impatient
    // second tap) from firing two inserts and creating a duplicate trip.
    setSavingTrip(true);
    try{
      const data=await saveTripToDb(selectedGuest.id, tripForm);
      if(data){
        const trip={id:data.id,...tripForm};
        setGuests(gs=>gs.map(g=>g.id===selectedGuest.id?{...g,trips:[...(g.trips||[]),trip]}:g));
        setSelectedGuest(g=>({...g,trips:[...(g.trips||[]),trip]}));
      }
      setTripForm(tripForm0);
      setView("guest");
    } finally {
      setSavingTrip(false);
    }
  }

  async function handleTripPhoto(e){
    const files=Array.from(e.target.files);
    e.target.value="";
    if(!files.length)return;
    // Resolve device location at most once per upload (only needed when a photo lacks EXIF GPS)
    let devLocPromise=null;
    const getDeviceLoc=()=>{
      if(!devLocPromise){
        devLocPromise=(async()=>{
          const currentLoc=locRef.current;
          if(currentLoc?.lat&&currentLoc?.lng)return{lat:currentLoc.lat,lng:currentLoc.lng};
          try{
            const pos=await new Promise((res,rej)=>navigator.geolocation.getCurrentPosition(res,rej,{timeout:10000,maximumAge:60000,enableHighAccuracy:false}));
            return{lat:pos.coords.latitude,lng:pos.coords.longitude};
          }catch(ge){return null;}
        })();
      }
      return devLocPromise;
    };
    // Phase 1 — read, downscale, parse EXIF; show every photo immediately, in selection order
    const items=[];
    for(const file of files){
      const rawUrl=await new Promise(res=>{const r=new FileReader();r.onload=ev=>res(ev.target.result);r.readAsDataURL(file);});
      const dataUrl=await new Promise(res=>{const img=new Image();img.onload=()=>{const MAX=1200;let w=img.naturalWidth,h=img.naturalHeight;if(w>MAX||h>MAX){const s=MAX/Math.max(w,h);w=Math.round(w*s);h=Math.round(h*s);}const cv=document.createElement("canvas");cv.width=w;cv.height=h;cv.getContext("2d").drawImage(img,0,0,w,h);res(cv.toDataURL("image/jpeg",0.82));};img.onerror=()=>res(rawUrl);img.src=rawUrl;});
      let photoTime=null,photoGps="",photoLat=null,photoLng=null;
      try{
        const abuf=await file.arrayBuffer();
        const exif=parseExif(abuf);
        photoTime=exif.time;photoGps=exif.gps||"";photoLat=exif.lat??null;photoLng=exif.lng??null;
      }catch(xe){void 0;}
      // Use EXIF time, fall back to trip date (not today's date)
      const tripDateFallback=tripForm.date?new Date(tripForm.date+"T12:00:00").toLocaleString("en-US",{month:"long",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit",hour12:true}):new Date().toLocaleString("en-US",{month:"long",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit",hour12:true});
      const t=photoTime||tripDateFallback;
      const _id="cd"+Date.now().toString(36)+Math.random().toString(36).slice(2,8);
      items.push({_id,dataUrl,t,photoGps,photoLat,photoLng});
      setTripForm(f=>({...f,photos:[...f.photos,dataUrl],catchDetails:[...(f.catchDetails||[]),{_id,photo:dataUrl,time:t,gps:photoGps,species:"Unidentified",length:"",airTemp:"",weatherDesc:"",windSpeed:"",windDir:"",pressure:"",streamCFS:"",streamCondition:"",streamGaugeName:"",analyzing:true}]}));
    }
    const updDetail=(id,patch)=>setTripForm(f=>({...f,catchDetails:(f.catchDetails||[]).map(d=>d._id===id?{...d,...patch}:d)}));
    // Phase 2 — fish ID and conditions run in PARALLEL for each photo, 3 photos at a time
    await mapLimit(items,3,async(it)=>{
      const idPromise=(async()=>{
        try{
          const b64=await resizeForID(it.dataUrl,800,0.7);
          const r=await identifyFish(b64,"Look carefully at this fish. Identify species based on coloring and spot patterns. Rainbow trout have pink lateral stripe. Brown trout have red spots on golden body. Choose from: "+SPECIES.join(", ")+". Estimate length if visible. Reply ONLY with JSON: {\"species\":\"Rainbow Trout\",\"length\":14}. Use null for length if unknown.");
          if(r&&r.species&&r.species!=="Unidentified")return r;
          return{species:"Unidentified",length:""};
        }catch(ie){return{species:"Unidentified",length:""};}
      })();
      const condPromise=(async()=>{
        try{
          let fetchLat=it.photoLat,fetchLng=it.photoLng,fetchGps=it.photoGps;
          if(!fetchLat||!fetchLng){
            const dl=await getDeviceLoc();
            if(dl){fetchLat=dl.lat;fetchLng=dl.lng;fetchGps=fetchLat.toFixed(4)+"\u00b0N, "+Math.abs(fetchLng).toFixed(4)+"\u00b0W";}
          }
          if(!fetchLat||!fetchLng)return null;
          let dateStr=null,hourStr="12";
          const d2=new Date(it.t.replace(" at "," "));
          if(!isNaN(d2)){dateStr=d2.toISOString().split("T")[0];hourStr=String(d2.getHours()).padStart(2,"0");}
          const today=new Date().toISOString().split("T")[0];
          let conds=null;
          if(dateStr&&dateStr<today){
            conds=await fetchHistoricalConditions(fetchLat,fetchLng,dateStr,hourStr);
          } else {
            try{
              const[wx,usgs]=await Promise.all([fetchWeather(fetchLat,fetchLng),fetchUSGSLive(fetchLat,fetchLng)]);
              const wc=wx.current;
              const pressureInHg=(wc.surface_pressure*0.02953).toFixed(2);
              conds={airTemp:String(Math.round(wc.temperature_2m)),weatherDesc:WX_DESC[wc.weather_code]||"",windSpeed:String(Math.round(wc.wind_speed_10m)),windDir:windDir(wc.wind_direction_10m),pressure:pressureInHg,streamCFS:"",streamCondition:"",streamGaugeName:""};
              const ts2=(usgs.value?.timeSeries)??[];
              if(ts2.length){
                const parsed2=ts2.map(t2=>{const raw=t2.values?.[0]?.value?.[0]?.value;const cfs=raw!=null?parseFloat(raw):null;const sLat=parseFloat(t2.sourceInfo?.geoLocation?.geogLocation?.latitude||0);const sLng=parseFloat(t2.sourceInfo?.geoLocation?.geogLocation?.longitude||0);const dist=Math.sqrt(Math.pow(sLat-fetchLat,2)+Math.pow(sLng-fetchLng,2));const siteNo=(t2.sourceInfo?.siteCode?.[0]?.value)||"";return{name:t2.sourceInfo?.siteName??"",cfs,dist,siteNo};}).filter(x=>x.cfs!=null&&x.cfs>=0&&x.cfs<500000&&x.dist<=0.3).sort((a,b)=>a.dist-b.dist);
                if(parsed2.length){
                  const _nd2=parsed2[0].dist;const _cb2=parsed2.filter(x=>x.dist-_nd2<=0.05).reduce((a,b)=>b.cfs>a.cfs?b:a,parsed2[0]);
                  conds.streamCFS=String(Math.round(_cb2.cfs));conds.streamCondition=cfsLabel(_cb2.cfs).label;conds.streamGaugeName=_cb2.name;
                }
              }
            }catch(le){void 0;}
          }
          return{gps:fetchGps||"",conds};
        }catch(ce){return null;}
      })();
      const[idRes,condRes]=await Promise.all([idPromise,condPromise]);
      const patch={analyzing:false};
      if(idRes){patch.species=idRes.species;patch.length=idRes.length;}
      if(condRes){if(condRes.gps)patch.gps=condRes.gps;if(condRes.conds)Object.assign(patch,condRes.conds);}
      updDetail(it._id,patch);
    });
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
        trip.streamCFS&&("Flow: "+trip.streamCFS+" CFS"),
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
        {[{id:"clients",icon:"👥",label:"Clients"},{id:"trends",icon:"📈",label:"Trends"},{id:"gauges",icon:"⭐",label:"My Gauges"}].map(s=>(
          <button key={s.id} onClick={()=>setGuideSection(s.id)}
            style={{flex:1,padding:"7px 4px",border:"none",borderRadius:9,cursor:"pointer",
              background:guideSection===s.id?"var(--water)":"transparent",
              color:guideSection===s.id?"var(--foam)":"var(--sky)",
              fontFamily:"var(--font-body)",fontSize:14,
              display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
            <span style={{fontSize:15}}>{s.icon}</span>{s.label}
          </button>
        ))}
      </div>
      {guideSection==="stats"?<GuideStats guests={guests}/>:guideSection==="seasonlog"?<GuideSeasonLog guests={guests}/>:guideSection==="gauges"?<GuideSavedGauges user={user}/>:guideSection==="trends"?<GuideTrends guests={guests} loc={loc} setView={setView} setSelectedGuest={setSelectedGuest} setSelectedTrip={setSelectedTrip} loadTripPhotos={loadTripPhotos}/>:null}
      <div style={{display:guideSection==="clients"?"block":"none"}}>
      {String(user?.id).startsWith("local")&&(
        <div style={{background:"rgba(209,154,74,0.15)",border:"1px solid rgba(209,154,74,0.3)",borderRadius:14,padding:"14px 16px",marginBottom:14,fontSize:15,color:"var(--gold)",lineHeight:1.6}}>
          ⚠️ <strong>Not logged in</strong> — guest data is saved to this device only.
        </div>
      )}
      
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <span style={{fontFamily:"var(--font-head)",fontSize:15,letterSpacing:1.5,textTransform:"uppercase",color:"var(--stone)"}}>My Guests · {guests.length}</span>
        <button className="btn" onClick={()=>{setGuestForm(guestForm0);setView("addGuest");}}>+ Add Guest</button>
      </div>
      <div style={{display:"flex",justifyContent:"flex-end",marginBottom:8}}>
        <button onClick={runPhotoMigration} disabled={!!migrationStatus}
          style={{fontSize:14,padding:"4px 10px",background:"rgba(209,154,74,0.15)",border:"1px solid rgba(209,154,74,0.3)",borderRadius:8,color:"var(--gold)",cursor:"pointer",fontFamily:"var(--font-body)"}}>
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
        <span style={{fontFamily:"var(--font-head)",fontSize:18,color:"var(--foam)",fontStyle:"italic"}}>New Guest</span>
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
              style={{flex:1,padding:"10px 8px",borderRadius:10,border:"1px solid "+(guestForm.skillLevel===lvl?"var(--water)":"rgba(255,255,255,0.12)"),background:guestForm.skillLevel===lvl?"var(--water)":"rgba(0,0,0,0.3)",color:guestForm.skillLevel===lvl?"var(--foam)":"var(--stone)",fontFamily:"var(--font-body)",fontSize:14,cursor:"pointer",textAlign:"center"}}>
              {lvl==="Beginner"?"🌱":lvl==="Intermediate"?"🎣":"🏆"} {lvl}
            </button>
          ))}
        </div>

        <label className="lbl">Handedness</label>
        <div style={{display:"flex",gap:8,marginBottom:8}}>
          {["Left","Right"].map(h=>(
            <button key={h} onClick={()=>setGuestForm(f=>({...f,handedness:h}))}
              style={{flex:1,padding:"10px 8px",borderRadius:10,border:"1px solid "+(guestForm.handedness===h?"var(--water)":"rgba(255,255,255,0.12)"),background:guestForm.handedness===h?"var(--water)":"rgba(0,0,0,0.3)",color:guestForm.handedness===h?"var(--foam)":"var(--stone)",fontFamily:"var(--font-body)",fontSize:14,cursor:"pointer",textAlign:"center"}}>
              {h==="Left"?"🤚 Left-Handed":"✋ Right-Handed"}
            </button>
          ))}
        </div>
        <label className="lbl">Notes</label>
        <textarea className="inp" rows={3} style={{resize:"none"}} placeholder="Fishing experience, preferences, anything to remember…" value={guestForm.notes} onChange={e=>setGuestForm(f=>({...f,notes:e.target.value}))}/>
        <button className="btn btnp" disabled={savingGuest} onClick={saveGuest} style={{opacity:savingGuest?0.6:1,cursor:savingGuest?"default":"pointer"}}>{savingGuest?"⏳ Saving…":"Save Guest"}</button>
      </div>
    </div>
  );

  // Edit guest
  if(view==="editGuest"&&selectedGuest) return(
    <div>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
        <button className="back" onClick={()=>setView("guest")}>← Back</button>
        <span style={{fontFamily:"var(--font-head)",fontSize:18,color:"var(--foam)",fontStyle:"italic"}}>Edit Guest</span>
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
              style={{flex:1,padding:"10px 8px",borderRadius:10,border:"1px solid "+(guestForm.skillLevel===lvl?"var(--water)":"rgba(255,255,255,0.12)"),background:guestForm.skillLevel===lvl?"var(--water)":"rgba(0,0,0,0.3)",color:guestForm.skillLevel===lvl?"var(--foam)":"var(--stone)",fontFamily:"var(--font-body)",fontSize:14,cursor:"pointer",textAlign:"center"}}>
              {lvl==="Beginner"?"🌱":lvl==="Intermediate"?"🎣":"🏆"} {lvl}
            </button>
          ))}
        </div>

        <label className="lbl">Handedness</label>
        <div style={{display:"flex",gap:8,marginBottom:8}}>
          {["Left","Right"].map(h=>(
            <button key={h} onClick={()=>setGuestForm(f=>({...f,handedness:h}))}
              style={{flex:1,padding:"10px 8px",borderRadius:10,border:"1px solid "+(guestForm.handedness===h?"var(--water)":"rgba(255,255,255,0.12)"),background:guestForm.handedness===h?"var(--water)":"rgba(0,0,0,0.3)",color:guestForm.handedness===h?"var(--foam)":"var(--stone)",fontFamily:"var(--font-body)",fontSize:14,cursor:"pointer",textAlign:"center"}}>
              {h==="Left"?"🤚 Left-Handed":"✋ Right-Handed"}
            </button>
          ))}
        </div>
        <label className="lbl">Notes</label>
        <textarea className="inp" rows={3} style={{resize:"none"}} value={guestForm.notes||""} onChange={e=>setGuestForm(f=>({...f,notes:e.target.value}))}/>
        <button className="btn btnp" onClick={async()=>{
          const{name,birthday,address,address2,city,state,zip,email,phone,notes,dietary,skillLevel,handedness}=guestForm;
          await updateGuestInDb(selectedGuest.id,{name,birthday,address,address2,city,state,zip,email,phone,notes,dietary,skill_level:skillLevel,handedness});
          const updated={...selectedGuest,name,birthday,address,address2,city,state,zip,email,phone,notes,dietary,skillLevel,handedness};
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
        <span style={{fontFamily:"var(--font-head)",fontSize:18,color:"var(--foam)",fontStyle:"italic"}}>{selectedGuest.name}</span>
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
        {selectedGuest.handedness&&<div className="hr"><span className="hn">Handedness</span><span className="ha">{selectedGuest.handedness==="Left"?"🤚 Left-Handed":"✋ Right-Handed"}</span></div>}
        {selectedGuest.dietary&&<div className="hr"><span className="hn">🥗 Dietary</span><span className="ha">{selectedGuest.dietary}</span></div>}
        {selectedGuest.notes&&<div style={{marginTop:10,fontSize:15,color:"var(--sky)",fontStyle:"italic",lineHeight:1.6}}>{selectedGuest.notes}</div>}
        <div style={{display:"flex",gap:8,marginTop:14}}>
          <button className="btn" style={{flex:2}} onClick={()=>{setTripForm({...tripForm0,date:new Date().toISOString().split("T")[0]});setView("addTrip");}}>+ Add Trip</button>
          <button className="btn" style={{flex:1,background:"rgba(44,95,110,0.5)"}} onClick={()=>{setGuestForm({...selectedGuest, skillLevel:selectedGuest.skillLevel||selectedGuest.skill_level||"",handedness:selectedGuest.handedness||""});setView("editGuest");}}>✏️ Edit</button>
          <button className="btn" style={{background:"rgba(150,80,80,0.4)",border:"1px solid rgba(150,80,80,0.5)"}} onClick={()=>deleteGuest(selectedGuest.id)}>🗑</button>
        </div>
      </div>
      <div style={{fontFamily:"var(--font-head)",fontSize:14,letterSpacing:1.5,textTransform:"uppercase",color:"var(--stone)",marginBottom:10}}>Trip History · {(selectedGuest.trips||[]).length}</div>
      {(selectedGuest.trips||[]).length===0&&<div className="info-box">No trips recorded yet. Tap "+ Add Trip" to log your first outing.</div>}
      {(selectedGuest.trips||[]).sort((a,b)=>b.date.localeCompare(a.date)).map(trip=>(
        <div className="card" key={trip.id} style={{cursor:"pointer"}} onClick={()=>{setView("tripDetail");loadTripPhotos(trip.id,trip);}}>
          <div className="ctitle" style={{marginBottom:6}}>{new Date(trip.date+"T12:00:00").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric",year:"numeric"})} <span style={{fontSize:15,color:"var(--stone)",fontFamily:"var(--font-body)",fontStyle:"normal"}}>·</span> {trip.type}</div>
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
        <span style={{fontFamily:"var(--font-head)",fontSize:18,color:"var(--foam)",fontStyle:"italic"}}>New Trip</span>
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
              style={{padding:"8px 14px",borderRadius:10,border:"1px solid "+(tripForm.type===t?"var(--water)":"rgba(255,255,255,0.12)"),background:tripForm.type===t?"var(--water)":"rgba(0,0,0,0.3)",color:tripForm.type===t?"var(--foam)":"var(--stone)",fontFamily:"var(--font-body)",fontSize:14,cursor:"pointer"}}>
              {t}
            </button>
          ))}
        </div>
        <label className="lbl">Fishing Styles</label>
        <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
          {FISHING_STYLES.map(s=>(
            <button key={s} onClick={()=>toggleStyle(s)}
              style={{padding:"6px 12px",borderRadius:10,border:"1px solid "+(tripForm.styles.includes(s)?"var(--moss)":"rgba(255,255,255,0.12)"),background:tripForm.styles.includes(s)?"rgba(90,122,74,0.4)":"rgba(0,0,0,0.3)",color:tripForm.styles.includes(s)?"#9cd47a":"var(--stone)",fontFamily:"var(--font-body)",fontSize:15,cursor:"pointer"}}>
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
        <button className="btn btnp" disabled={savingTrip} onClick={saveTrip} style={{opacity:savingTrip?0.6:1,cursor:savingTrip?"default":"pointer"}}>{savingTrip?"⏳ Saving…":"Save Trip"}</button>
      </div>
    </div>
  );

  // Edit trip
  if(view==="editTrip"&&selectedTrip) return(
    <div>
      <input ref={photoRef} type="file" accept="image/*" multiple style={{display:"none"}} onChange={handleTripPhoto}/>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
        <button className="back" onClick={()=>setView("tripDetail")}>← Back</button>
        <span style={{fontFamily:"var(--font-head)",fontSize:18,color:"var(--foam)",fontStyle:"italic"}}>Edit Trip</span>
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
              style={{padding:"8px 14px",borderRadius:10,border:"1px solid "+(tripForm.type===t?"var(--water)":"rgba(255,255,255,0.12)"),background:tripForm.type===t?"var(--water)":"rgba(0,0,0,0.3)",color:tripForm.type===t?"var(--foam)":"var(--stone)",fontFamily:"var(--font-body)",fontSize:14,cursor:"pointer"}}>
              {t}
            </button>
          ))}
        </div>
        <label className="lbl">Fishing Styles</label>
        <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
          {FISHING_STYLES.map(s=>(
            <button key={s} onClick={()=>toggleStyle(s)}
              style={{padding:"6px 12px",borderRadius:10,border:"1px solid "+(tripForm.styles?.includes(s)?"var(--moss)":"rgba(255,255,255,0.12)"),background:tripForm.styles?.includes(s)?"rgba(90,122,74,0.4)":"rgba(0,0,0,0.3)",color:tripForm.styles?.includes(s)?"#9cd47a":"var(--stone)",fontFamily:"var(--font-body)",fontSize:15,cursor:"pointer"}}>
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
        <span style={{fontFamily:"var(--font-head)",fontSize:18,color:"var(--foam)",fontStyle:"italic"}}>
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
              {selectedTrip.streamCFS&&<span>💧 {Number(selectedTrip.streamCFS).toLocaleString()} CFS</span>}
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
        <div style={{marginTop:12,padding:"10px 12px",background:"rgba(209,154,74,0.08)",borderRadius:10,borderLeft:"3px solid var(--gold)"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:selectedTrip.aiIntel?6:0}}>
            <div className="lbl" style={{marginBottom:0}}>🎣 AI Intel for {selectedGuest?.name||"this client"}</div>
            <button disabled={guideIntelLoading} onClick={()=>handleGenerateGuideIntel(selectedTrip,selectedGuest)}
              style={{background:"none",border:"1px solid rgba(209,154,74,0.4)",borderRadius:20,padding:"4px 12px",color:"var(--gold)",fontSize:13,cursor:guideIntelLoading?"default":"pointer",opacity:guideIntelLoading?0.6:1,fontFamily:"var(--font-body)",whiteSpace:"nowrap"}}>
              {guideIntelLoading?"Reading trips…":selectedTrip.aiIntel?"↻ Regenerate":"Get Intel"}
            </button>
          </div>
          {guideIntelError&&<div style={{fontSize:14,color:"var(--red)",marginTop:6}}>{guideIntelError}</div>}
          {selectedTrip.aiIntel?(
            <>
              <p style={{fontSize:15,color:"var(--sky)",lineHeight:1.6,whiteSpace:"pre-wrap"}}>{selectedTrip.aiIntel}</p>
              {selectedTrip.aiIntelGeneratedAt&&<div style={{fontSize:13,color:"var(--stone)",marginTop:4}}>Generated {new Date(selectedTrip.aiIntelGeneratedAt).toLocaleDateString("en-US",{month:"short",day:"numeric"})}</div>}
            </>
          ):(!guideIntelLoading&&<p style={{fontSize:14,color:"var(--stone)",fontStyle:"italic",marginTop:6}}>Tap "Get Intel" for a read on what's working across {selectedGuest?.name?`${selectedGuest.name}'s`:"this client's"} logged trips.</p>)}
        </div>
        <div style={{marginTop:12,marginBottom:8}}>
        <input type="file" accept="image/*" multiple id="tripDetailPhotoInput" style={{display:"none"}} onChange={async(e)=>{
          const files=Array.from(e.target.files||[]);
          e.target.value="";
          if(!files.length) return;
          const btn=document.getElementById("tripDetailAddBtn");
          if(btn){btn.textContent="⏳ "+files.length+" photos…";btn.disabled=true;}
          // Re-read the trip FRESH from the DB before appending — never write back stale arrays
          let accDetails=[...(selectedTrip.catchDetails||[])];
          let accPhotos=[...(selectedTrip.photos||[])];
          if(sb){
            try{
              const[{data:cdF},{data:prF},{data:tpF}]=await Promise.all([
                sb.from("trips").select("catch_details").eq("id",tripId).single(),
                sb.from("trip_photos").select("photo,sort_order").eq("trip_id",tripId).order("sort_order"),
                sb.from("trips").select("photos").eq("id",tripId).single()
              ]);
              accDetails=((cdF?.catch_details)||[]).map(d=>({...d,analyzing:false}));
              let fp=(prF||[]).map(r=>r.photo).filter(Boolean);
              if(fp.length===0&&tpF?.photos?.length>0)fp=tpF.photos.filter(Boolean);
              if(fp.length===0&&accDetails.length>0)fp=accDetails.map(d=>d.photo).filter(Boolean);
              accPhotos=fp;
              setSelectedTrip(prev=>({...prev,photos:accPhotos,catchDetails:accDetails}));
            }catch(fe){void 0;}
          }
          const tripId=selectedTrip.id;
          for(let fi=0;fi<files.length;fi++){
            const file=files[fi];
            if(btn)btn.textContent="⏳ "+(fi+1)+"/"+files.length+"…";
            try{
              // Read file
              const dataUrl=await new Promise(res=>{const r=new FileReader();r.onload=ev=>res(ev.target.result);r.readAsDataURL(file);});
              // Parse EXIF from original buffer
              let photoTime=null,photoLat=null,photoLng=null,photoGpsStr=null;
              try{const abuf=await file.arrayBuffer();const exif=parseExif(abuf);photoTime=exif.time;photoLat=exif.lat??null;photoLng=exif.lng??null;photoGpsStr=exif.gps||null;}catch(xe){void 0;}
              const fetchLat=photoLat??locRef.current?.lat;
              const fetchLng=photoLng??locRef.current?.lng;
              const t=photoTime||new Date(selectedTrip.date+"T12:00:00").toLocaleString("en-US",{month:"long",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit",hour12:true});
              const coords=photoGpsStr||(photoLat&&photoLng?fmtCoord(photoLat,photoLng):"");
              // Fish ID, conditions, and storage upload all run in PARALLEL per photo
              const idP=(async()=>{
                try{
                  const b64=await resizeForID(dataUrl,800,0.7);
                  const r=await identifyFish(b64,"Look carefully at this fish. Identify species based on coloring and spot patterns. Rainbow trout have pink lateral stripe. Brown trout have red spots on golden body. Choose from: "+SPECIES.join(", ")+". Estimate length if visible. Reply ONLY with JSON: {\"species\":\"Rainbow Trout\",\"length\":14}. Use null for length if unknown.");
                  if(r&&r.species&&r.species!=="Unidentified")return r;
                  return{species:"Unidentified",length:""};
                }catch(fishErr){return{species:"Unidentified",length:""};}
              })();
              const condP=(async()=>{
                if(!fetchLat||!fetchLng)return null;
                try{
                  const d2=new Date(t.replace(" at "," "));
                  const today=new Date().toISOString().split("T")[0];
                  const dateStr=!isNaN(d2)?d2.toISOString().split("T")[0]:null;
                  if(dateStr&&dateStr<today){
                    const conds=await fetchHistoricalConditions(fetchLat,fetchLng,dateStr,"12");
                    if(conds)return{airTemp:conds.airTemp||"",weatherDesc:conds.weatherDesc||"",windSpeed:conds.windSpeed||"",windDir:conds.windDir||"",pressure:conds.pressure||"",streamCFS:conds.streamCFS||"",streamCondition:conds.streamCondition||"",streamGaugeName:conds.streamGaugeName||""};
                    return null;
                  }
                  const[wx,usgs]=await Promise.all([fetchWeather(fetchLat,fetchLng),fetchUSGSLive(fetchLat,fetchLng)]);
                  const wc=wx.current;const pressureInHg=(wc.surface_pressure*0.02953).toFixed(2);
                  let cp={airTemp:String(Math.round(wc.temperature_2m)),weatherDesc:WX_DESC[wc.weather_code]||"",windSpeed:String(Math.round(wc.wind_speed_10m)),windDir:windDir(wc.wind_direction_10m),pressure:pressureInHg};
                  const ts2=(usgs.value?.timeSeries)??[];
                  if(ts2.length){const p2=ts2.map(t3=>{const raw=t3.values?.[0]?.value?.[0]?.value;const cfs=raw!=null?parseFloat(raw):null;const sLat=parseFloat(t3.sourceInfo?.geoLocation?.geogLocation?.latitude||0);const sLng=parseFloat(t3.sourceInfo?.geoLocation?.geogLocation?.longitude||0);const dist=Math.sqrt(Math.pow(sLat-fetchLat,2)+Math.pow(sLng-fetchLng,2));return{name:t3.sourceInfo?.siteName??"",cfs,dist,label:cfsLabel(cfs).label};}).filter(x=>x.cfs!=null&&x.cfs>=0&&x.cfs<500000&&x.dist<=0.3).sort((a,b)=>a.dist-b.dist);if(p2.length){const _ndp=p2[0].dist;const _cbp=p2.filter(x=>x.dist-_ndp<=0.05).reduce((a,b)=>b.cfs>a.cfs?b:a,p2[0]);cp.streamCFS=String(Math.round(_cbp.cfs));cp.streamCondition=_cbp.label;cp.streamGaugeName=_cbp.name;}}
                  return cp;
                }catch(condErr){return null;}
              })();
              const upP=uploadPhotoToStorage(dataUrl,"trips/"+tripId).catch(ue=>null);
              const[idRes,condRes,url]=await Promise.all([idP,condP,upP]);
              let detail={photo:dataUrl,time:t,gps:coords,species:idRes.species,length:idRes.length,airTemp:"",weatherDesc:"",windSpeed:"",windDir:"",pressure:"",streamCFS:"",streamCondition:"",streamGaugeName:"",analyzing:false};
              if(condRes)detail={...detail,...condRes};
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
                const SPECIES_LIST=SPECIES;
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
                      const rd=await Promise.race([
                        aiFetch({model:"claude-haiku-4-5-20251001",max_tokens:150,messages:[{role:"user",content:[{type:"image",source:imageSource},{type:"text",text:`Identify fish, estimate length. Species from: ${SPECIES_LIST.join(", ")}. JSON only: {"species":"Rainbow Trout","length":14}`}]}]},"cheap"),
                        new Promise((_,r)=>setTimeout(()=>r(new Error("claude timeout")),20000))
                      ]);
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
              }} style={{fontSize:14,padding:"4px 10px",background:"rgba(209,154,74,0.2)",border:"1px solid rgba(209,154,74,0.4)",borderRadius:8,color:"var(--gold)",cursor:"pointer",fontFamily:"var(--font-body)"}}>
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
                      {(!cd.species||cd.species==="Unknown"||cd.species==="Unidentified"||!cd.length)&&<button onClick={async e=>{
                        e.stopPropagation();
                        const btn=e.currentTarget;btn.textContent="🔍 Identifying…";btn.disabled=true;
                        try{
                          let base64=null;
                          if(p?.startsWith("data:")){base64=await resizeForID(p,800,0.7);}
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
                          const r=await identifyFish(base64,"Look carefully at this fish. Identify species based on coloring and spot patterns. Rainbow trout have pink lateral stripe. Brown trout have red spots on golden body. Cutthroat have red slash under jaw. Choose from: "+SPECIES.join(", ")+". Estimate length in inches if visible. Reply ONLY with JSON: {\"species\":\"Rainbow Trout\",\"length\":14}. Use null for length if unknown.");
                          if(r&&r.species){
                            const d=[...(selectedTrip.catchDetails||[])];while(d.length<=i)d.push({});
                            d[i]={...d[i],species:r.species,length:r.length||d[i].length};
                            const upd={...selectedTrip,catchDetails:d};
                            setSelectedTrip(upd);
                            setGuests(gs=>{
                              const next=gs.map(g=>({...g,trips:(g.trips||[]).map(t=>t.id===selectedTrip.id?upd:t)}));
                              try{
                                const safe=next.map(g=>({...g,trips:(g.trips||[]).map(t=>({...t,photos:[],catchDetails:(t.catchDetails||[]).map(d2=>({...d2,photo:null}))}))}));
                                localStorage.setItem("tl_guests_"+user.id,JSON.stringify(safe));
                              }catch(ce){void 0;}
                              return next;
                            });
                            if(sb){
                              const{error:upErr}=await sb.from("trips").update({catch_details:d}).eq("id",selectedTrip.id);
                              if(upErr){btn.textContent="⚠ Save failed — retry";btn.disabled=false;return;}
                            }
                          } else {
                            btn.textContent="Could not identify — retry";btn.disabled=false;return;
                          }
                        }catch(err){void 0;}
                        btn.textContent="🔍 Identify";btn.disabled=false;
                      }} style={{flex:1,background:"rgba(44,95,110,0.2)",border:"1px solid rgba(44,95,110,0.4)",borderRadius:8,padding:"7px",color:"var(--sky)",fontSize:15,cursor:"pointer",fontFamily:"var(--font-body)"}}>🔍 Identify</button>}
                      <button onClick={e=>{e.stopPropagation();setEditingTripCatchIdx(editingTripCatchIdx===i?null:i);}}
                        style={{flex:1,background:"rgba(209,154,74,0.2)",border:"1px solid rgba(209,154,74,0.5)",borderRadius:8,padding:"7px",color:"var(--gold)",fontSize:15,cursor:"pointer",fontFamily:"var(--font-body)"}}>
                        ✏️ Edit
                      </button>
                      <button onClick={e=>{e.stopPropagation();setCropTripPhotoIdx(i);}}
                        style={{flex:1,background:"rgba(44,95,110,0.2)",border:"1px solid rgba(44,95,110,0.4)",borderRadius:8,padding:"7px",color:"var(--sky)",fontSize:15,cursor:"pointer",fontFamily:"var(--font-body)"}}>
                        ✂️ Crop
                      </button>
                      <button onClick={async e=>{e.stopPropagation();if(!window.confirm("Remove this photo and catch data?"))return;
                        const delPhoto=p;
                        const newPhotos=selectedTrip.photos.filter((_,j)=>j!==i);
                        const newDetails=(selectedTrip.catchDetails||[]).filter((_,j)=>j!==i);
                        if(sb){
                          // Persist FIRST, then update the screen — never the other way around
                          const{error:e1}=await sb.from("trips").update({catch_details:newDetails,photos:newPhotos}).eq("id",selectedTrip.id);
                          if(e1){window.alert("Could not remove — please try again. ("+e1.message+")");return;}
                          if(typeof delPhoto==="string"&&delPhoto.startsWith("http")){
                            const{error:e2}=await sb.from("trip_photos").delete().eq("trip_id",selectedTrip.id).eq("photo",delPhoto);
                            if(e2){window.alert("Removed from trip, but the stored photo record could not be deleted: "+e2.message);}
                          }
                        }
                        const upd={...selectedTrip,photos:newPhotos,catchDetails:newDetails};
                        setSelectedTrip(upd);
                        setGuests(gs=>{
                          const next=gs.map(g=>({...g,trips:(g.trips||[]).map(t=>t.id===selectedTrip.id?upd:t)}));
                          try{
                            const safe=next.map(g=>({...g,trips:(g.trips||[]).map(t=>({...t,photos:[],catchDetails:(t.catchDetails||[]).map(d2=>({...d2,photo:null}))}))}));
                            localStorage.setItem("tl_guests_"+user.id,JSON.stringify(safe));
                          }catch(ce){void 0;}
                          return next;
                        });
                      }}
                        style={{flex:1,background:"rgba(150,80,80,0.3)",border:"1px solid rgba(150,80,80,0.4)",borderRadius:8,padding:"7px",color:"var(--red)",fontSize:15,cursor:"pointer",fontFamily:"var(--font-body)"}}>
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
                          <SpeciesInput value={cd.species||""} inputStyle={{marginBottom:0}}
                            onChange={val=>{const d=[...(selectedTrip.catchDetails||[])];while(d.length<=i)d.push({});d[i]={...d[i],species:val};const upd={...selectedTrip,catchDetails:d};setSelectedTrip(upd);setGuests(gs=>gs.map(g=>({...g,trips:(g.trips||[]).map(t=>t.id===selectedTrip.id?upd:t)})));if(sb)sb.from("trips").update({catch_details:d}).eq("id",selectedTrip.id);}}/>
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
                          }} style={{background:"rgba(209,154,74,0.2)",border:"1px solid rgba(209,154,74,0.4)",borderRadius:8,padding:"0 10px",color:"var(--gold)",fontSize:15,cursor:"pointer",whiteSpace:"nowrap",fontFamily:"var(--font-body)"}}>
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
          <div style={{padding:"8px 12px",background:"rgba(209,154,74,0.15)",border:"1px solid rgba(209,154,74,0.3)",borderRadius:10,fontSize:15,color:"var(--gold)",marginBottom:8}}>{migrationStatus}</div>
        )}
        {migrationStatus&&(
          <div style={{padding:"8px 12px",background:"rgba(209,154,74,0.15)",border:"1px solid rgba(209,154,74,0.3)",borderRadius:10,fontSize:15,color:"var(--gold)",marginBottom:8}}>{migrationStatus}</div>
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
        {!!report&&(
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
      {cropTripPhotoIdx!==null&&selectedTrip.photos[cropTripPhotoIdx]&&(
        <PhotoCropModal key={cropTripPhotoIdx} photoUrl={selectedTrip.photos[cropTripPhotoIdx]}
          onSave={dataUrl=>handleTripCropSave(cropTripPhotoIdx,dataUrl)}
          onCancel={()=>setCropTripPhotoIdx(null)}/>
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
      <div style={{fontFamily:"var(--font-head)",fontSize:16,color:"var(--gold)",marginBottom:10,letterSpacing:0.5}}>
        📅 Upcoming Trips
      </div>
      {trips.map(t=>(
        <div key={t.id} className="card" style={{marginBottom:10}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
            <div>
              <div style={{fontFamily:"var(--font-head)",fontSize:14,color:"var(--foam)",fontStyle:"italic"}}>{t.location||"Location TBD"}</div>
              <div style={{fontSize:15,color:"var(--gold)",marginTop:2,fontWeight:"bold"}}>{new Date(t.date+"T12:00:00").toLocaleDateString("en-US",{weekday:"short",month:"long",day:"numeric",year:"numeric"})}</div>
              <div style={{fontSize:14,color:"var(--stone)",marginTop:2}}>{t.type}{t.styles?.length?" · "+t.styles.join(", "):""}</div>
            </div>
            <div style={{fontSize:22}}>🎣</div>
          </div>
          {t.guide_notes&&<div style={{fontSize:15,color:"var(--sky)",marginTop:8,fontStyle:"italic",lineHeight:1.5}}>{t.guide_notes}</div>}
          {t.report_text&&(
            <div style={{marginTop:8,borderTop:"1px solid rgba(255,255,255,0.08)",paddingTop:8}}>
              <div style={{fontSize:14,color:"var(--gold)",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Guide Notes</div>
              <div style={{fontSize:15,color:"var(--foam)",lineHeight:1.6,fontFamily:"var(--font-body)"}}>{t.report_text}</div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Trip Planner ──────────────────────────────────────────────────────────────
// ── Stream Gauge Chart — looks up USGS gauge by stream name ──────────────────
function StreamGaugeChart({streamName, localGauges, lat, lng, knownSiteNo}){
  const [siteNo, setSiteNo] = useState(knownSiteNo||null);
  const [siteName, setSiteName] = useState("");
  const [cfs, setCfs] = useState(null);
  const [tried, setTried] = useState(false);

  useEffect(()=>{
    if(!streamName||tried||siteNo) return;
    setTried(true);

    // First check local gauges already fetched
    const words=(streamName||"").toLowerCase().split(/[\s,()]+/).filter(w=>w.length>3);
    let local=null,localBest=0;
    (localGauges||[]).forEach(g=>{
      if(String(g.siteNo||"").length>10)return;
      const gn=(g.name||"").toLowerCase();
      const hits=words.filter(w=>gn.includes(w)).length;
      if(hits>=2&&hits>localBest){localBest=hits;local=g;}
    });
    if(local&&local.siteNo){setSiteNo(local.siteNo);setSiteName(local.name);setCfs(local.cfs);return;}

    // Otherwise search USGS by stream name
    const query=streamName.split("(")[0].split(",")[0].trim();
    if(!lat||!lng) return;
    const _p=1.0,_mnLng=Math.round((lng-_p)*10000)/10000,_mxLng=Math.round((lng+_p)*10000)/10000,_mnLat=Math.round((lat-_p)*10000)/10000,_mxLat=Math.round((lat+_p)*10000)/10000;
    (async()=>{
      const bbox=`${_mnLng},${_mnLat},${_mxLng},${_mxLat}`;
      try{
        const locs=await nwLocations(bbox);
        if(locs.size){
          const feats=await nwLatest(Array.from(locs.keys()),"00060");
          const leg=nwToLegacy(feats,locs);
          if(leg.value.timeSeries.length) return leg;
        }
      }catch{}
      // Legacy fallback until decommission — filtered through filterFreshTimeSeries,
      // same as fetchUSGSLive above, so a name-search match can't silently resolve to
      // a decades-stale reading.
      try{const r=await fetch(`https://waterservices.usgs.gov/nwis/iv/?format=json&bBox=${bbox}&parameterCd=00060&siteType=ST`);return filterFreshTimeSeries(await r.json());}catch{return{value:{timeSeries:[]}};}
    })()
      .then(d=>{
        const ts=d.value?.timeSeries||[];
        if(!ts.length) return;
        // Pick the one whose name best matches
        const scored=ts.map(t=>{
          const n=(t.sourceInfo?.siteName||"").toLowerCase();
          const score=words.filter(w=>n.includes(w)).length;
          return{score,siteNo:t.sourceInfo?.siteCode?.[0]?.value,name:t.sourceInfo?.siteName,cfs:parseFloat(t.values?.[0]?.value?.[0]?.value)};
        }).filter(t=>t.score>=2&&t.siteNo&&String(t.siteNo).length<=10).sort((a,b)=>b.score-a.score||String(a.siteNo).length-String(b.siteNo).length);
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
// Identify a fish photo via the AI proxy — HTTP check, tolerant JSON extraction, one automatic retry
async function identifyFish(b64,promptText){
  for(let attempt=0;attempt<2;attempt++){
    try{
      const ctrl=new AbortController();
      const tid=setTimeout(()=>ctrl.abort(),25000);
      let rd;
      try{
        rd=await aiFetch({model:"claude-haiku-4-5-20251001",max_tokens:150,messages:[{role:"user",content:[{type:"image",source:{type:"base64",media_type:"image/jpeg",data:b64}},{type:"text",text:promptText}]}]},"cheap",{signal:ctrl.signal});
      }finally{clearTimeout(tid);}
      const txt=(rd.content||[]).map(c=>c.text||"").join(" ");
      const m=txt.match(/\{[\s\S]*?\}/);
      if(!m)throw new Error("no JSON in response");
      const parsed=JSON.parse(m[0]);
      let sp=typeof parsed.species==="string"?parsed.species.trim():"";
      if(/^(unknown|unidentified|null|none|n\/a|not sure|unclear)$/i.test(sp))sp="";
      return{species:sp,length:parsed.length!=null&&!isNaN(parsed.length)?String(Math.round(parsed.length)):""};
    }catch(err){
      if(attempt===0){await new Promise(r=>setTimeout(r,1500));}
      else{return null;}
    }
  }
  return null;
}

// ── Trip Planner search/synth/verify/review logic moved to src/lib/tripPlannerPipeline.js ──
// (single source of truth, shared with the background/email endpoint — see that file's
// header comment for why. Imported below.)

// Process items with limited concurrency (order of results preserved)
async function mapLimit(items,limit,fn){
  const out=new Array(items.length);let next=0;
  const workers=Array.from({length:Math.min(limit,Math.max(items.length,1))},async()=>{
    while(next<items.length){const idx=next++;try{out[idx]=await fn(items[idx],idx);}catch(e){out[idx]=null;}}
  });
  await Promise.all(workers);
  return out;
}
// Downscale an image dataUrl to a small base64 JPEG for fast AI vision calls
function resizeForID(dataUrl,max=800,quality=0.7){
  return new Promise((res,rej)=>{
    const img=new Image();
    img.onload=()=>{
      try{
        const s=Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight));
        const cv=document.createElement("canvas");
        cv.width=Math.round(img.naturalWidth*s);cv.height=Math.round(img.naturalHeight*s);
        cv.getContext("2d").drawImage(img,0,0,cv.width,cv.height);
        res(cv.toDataURL("image/jpeg",quality).split(",")[1]);
      }catch(err){rej(err);}
    };
    img.onerror=rej;img.src=dataUrl;
  });
}

// ── Sample trip report (signed-out visitors only) ──────────────────────────────
// Guests opening the Plan tab previously hit a dead end: the prompt said "create a free
// account to use Plan," which was wrong twice over — Plan is Consumer Pro, not free, and
// there was nothing behind it to see. This shows a real, complete report instead.
//
// Shape matches the planner pipeline's output exactly, and it renders through the SAME
// path a paid report does (applySavedReport -> the normal report renderer), so it can't
// drift out of sync with the real thing and it's an honest preview of what's bought.
//
// FISHING ACCURACY: this content is Claude's, written to be plausible for a Front Range
// late-summer day. Flows, hatches, access points, and fly choices are NOT verified by
// Adam and are the most publicly-visible fishing claims in the app — worth a careful
// read before leaning on this for conversion.
const SAMPLE_TRIP_REPORT = {
  date: "2026-08-13",
  loc: { label: "Lafayette, CO", lat: 39.9936, lng: -105.0897 },
  report: {
    overview: "A warm, stable mid-August day across the northern Front Range. Freestone flows have dropped into late-summer shape — low, clear, and wading-friendly — which means fish are spooky in flat water and stacked in oxygenated riffles and pocket water. The tailwaters are holding cold and steady and are the safest bet if the afternoon heats up as forecast. Expect the best windows early and late, with a midday lull in the bright, direct sun.",
    recommendation: "South Boulder Creek below Gross Reservoir",
    bestFor: {
      mostFish: "South Boulder Creek below Gross Reservoir",
      bestScenery: "Cache la Poudre River — upper canyon",
      mostSolitude: "North St. Vrain Creek near Allenspark",
      beginners: "Clear Creek at Golden",
    },
    rivers: [
      {
        name: "South Boulder Creek below Gross Reservoir",
        lat: 39.9472, lng: -105.3597, type: "Tailwater", source: "USGS 06729500",
        verified: "gauge", cfs: "58", condition: "Good", crowdLevel: "Moderate",
        conditions: "Cold, clear bottom-release water holding steady in the mid-50s regardless of air temperature. Low flow means technical presentations and light tippet, but the fish are concentrated and feeding.",
        techniques: "Small nymphs under a light indicator through the deeper slots. Drop to 6X in the flat water. A dry-dropper works well in the faster pocket water up near the dam.",
        bestTime: "Early morning through late morning, then again in the last two hours of light.",
        accessPoints: ["Walker Ranch Loop trailhead", "Gross Dam Road pullouts"],
        flies: ["Zebra Midge #20", "Pheasant Tail Nymph #18", "RS2 #20", "Parachute Adams #18"],
        why: "The steadiest cold water within 40 minutes. On a day this warm, a bottom-release tailwater removes thermal risk entirely, and the low flow makes the fish easy to locate.",
      },
      {
        name: "Clear Creek at Golden",
        lat: 39.7555, lng: -105.2211, type: "Freestone", source: "USGS 06719505",
        verified: "gauge", cfs: "112", condition: "Fair", crowdLevel: "Busy",
        conditions: "Dropped into classic late-summer freestone shape — clear and very wadeable. Warms through the afternoon, so fish it early. Heavier foot traffic through the canyon on a weekday evening.",
        techniques: "Short-line nymphing the pocket water and plunge pools. Attractor dries move fish in the broken water. Keep moving — one or two drifts per pocket.",
        bestTime: "First light to about 10 AM.",
        accessPoints: ["Clear Creek Canyon Park", "Tunnel 1 pullout", "Golden Canyon access"],
        flies: ["Elk Hair Caddis #14", "Copper John #16", "Prince Nymph #16", "Stimulator #12"],
        why: "The most forgiving water on this list — easy wading, willing fish, and short drifts. Best choice for anyone still learning to read water.",
      },
      {
        name: "North St. Vrain Creek near Allenspark",
        lat: 40.2003, lng: -105.5147, type: "Freestone", source: "USGS 06721000",
        verified: "gauge", cfs: "38", condition: "Fair", crowdLevel: "Light",
        conditions: "Small, low, and gin-clear. Skinny water fishing at its most technical — a heavy footfall or a sloppy cast puts a whole pool down. Cooler at elevation, so it fishes later into the day than the lower freestones.",
        techniques: "One shot per pocket with a long leader and a soft landing. Small attractor dries. Approach from downstream and stay low.",
        bestTime: "Mid-morning through early afternoon; elevation keeps it cool.",
        accessPoints: ["Button Rock Preserve", "Allenspark trailheads"],
        flies: ["Parachute Adams #16", "Royal Wulff #14", "Elk Hair Caddis #16"],
        why: "Least pressure of anything in range. Small wild fish in a tight canyon — go here if solitude matters more than fish size.",
      },
      {
        name: "Cache la Poudre River — upper canyon",
        lat: 40.6869, lng: -105.5222, type: "Freestone", source: "USGS 06752260",
        verified: "gauge", cfs: "96", condition: "Good", crowdLevel: "Moderate",
        conditions: "Holding decent late-summer flow with good color. The upper canyon stays cooler than the lower river and fishes well through more of the day. Long drive, but the most water to spread out on.",
        techniques: "Dry-dropper through the riffles and seams. Hoppers along the grassy banks in the afternoon wind.",
        bestTime: "Mid-morning, and again from about 6 PM to dark.",
        accessPoints: ["Poudre Canyon Highway pullouts", "Indian Meadows", "Big Bend"],
        flies: ["Hopper #10", "Pheasant Tail Nymph #16", "Elk Hair Caddis #14", "Prince Nymph #14"],
        why: "The best combination of scenery and elbow room in range. Worth the drive if you want a full day rather than a morning session.",
      },
    ],
    hatches: "Pale Morning Duns tapering off through the morning on the tailwater. Caddis are the main event on the freestones, with the heaviest activity in the last two hours of light. Terrestrials — hoppers, ants, and beetles — matter more than anything hatching once the sun is high and the wind picks up. Midges hold steady all day on South Boulder Creek.",
    bestTimes: "First light to roughly 10 AM, then again from about 6 PM until dark. Midday will be bright and slow on the freestones; that's the window to move to the tailwater or take a break.",
    tips: "Water temperature is the day's real variable. Carry a thermometer and stop fishing any freestone that climbs past 67°F — fighting fish in warm water kills them even on a clean release. Flows this low mean the fish see you before you see them: stay off the skyline, wade less, and lengthen your leader. If the freestones feel dead by noon, that's your cue to go tailwater rather than push through it.",
    flyBoxEssentials: ["Parachute Adams #14-18", "Elk Hair Caddis #14-16", "Pheasant Tail Nymph #16-18", "Zebra Midge #20", "Hopper #10-12", "RS2 #20", "Copper John #16", "5X and 6X tippet"],
  },
};
function TripPlannerLoading({steps,onCancel,destination}){
  const [factIdx,setFactIdx]=React.useState(Math.floor(Math.random()*FLY_FACTS.length));
  const [fade,setFade]=React.useState(true);
  const [prog,setProg]=React.useState(3);
  const stepsRef=React.useRef(0);
  React.useEffect(()=>{stepsRef.current=(steps||[]).length;},[steps]);
  React.useEffect(()=>{
    const t=setInterval(()=>{
      setProg(p=>{
        const target=Math.min(8+stepsRef.current*7,88);
        return Math.min(p+Math.max(target-p,0)*0.03+0.05,90);
      });
    },400);
    return()=>clearInterval(t);
  },[]);
  React.useEffect(()=>{
    const t=setInterval(()=>{
      setFade(false);
      setTimeout(()=>{setFactIdx(i=>(i+1)%FLY_FACTS.length);setFade(true);},500);
    },10000);
    return()=>clearInterval(t);
  },[]);
  // Portaled straight to document.body (same fix already applied to the header's Sign
  // Out/gear buttons): rendering this inline left it nested inside .content's own
  // stacking context (position:relative;z-index:1), which caps its z-index:9000 at that
  // local value no matter what — so .hdr (z-index:5, a sibling with a HIGHER local value)
  // visually bled through the top of this "full-screen" takeover, and the portaled Sign
  // Out/gear buttons (z-index:2001, already living on document.body) rendered on top of
  // this overlay's own Cancel button instead of being safely covered by it. z-index:5000
  // here clears both of those (and the Settings dropdown's 2000/2001) with room to spare
  // below the video modal's 10000/10001.
  return createPortal(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(8,20,25,0.97)",zIndex:5000,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"32px 24px"}}>
      <button onClick={onCancel} style={{position:"absolute",top:20,right:20,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:10,padding:"8px 16px",color:"var(--stone)",fontSize:15,cursor:"pointer",fontFamily:"var(--font-body)"}}>✕ Cancel</button>
      <div style={{fontFamily:"var(--font-head)",fontSize:26,color:"var(--gold)",marginBottom:6,textAlign:"center",letterSpacing:0.5}}>Hang tight, let it drift.</div>
      <div style={{fontSize:16,color:"var(--stone)",marginBottom:36,textAlign:"center",fontStyle:"italic",lineHeight:1.6}}>Reading the water near {destination||"you"}<br/>and finding where they're moving…</div>
      <div style={{background:"rgba(0,0,0,0.35)",border:"1px solid rgba(209,154,74,0.2)",borderRadius:16,padding:"22px 28px",maxWidth:340,marginBottom:36,minHeight:90,display:"flex",alignItems:"center",justifyContent:"center"}}>
        <p style={{fontSize:16,color:"var(--sky)",lineHeight:1.75,textAlign:"center",transition:"opacity 0.5s",opacity:fade?1:0,margin:0,fontStyle:"italic"}}>"{FLY_FACTS[factIdx]}"</p>
      </div>
      <div style={{width:"100%",maxWidth:340}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <span style={{fontSize:14,color:"var(--stone)",fontStyle:"italic"}}>Generating your report…</span>
          <span style={{fontSize:14,color:"var(--gold)",fontVariantNumeric:"tabular-nums"}}>{Math.round(prog)}%</span>
        </div>
        <div style={{height:6,background:"rgba(255,255,255,0.1)",borderRadius:3,overflow:"hidden"}}>
          <div style={{height:"100%",width:prog+"%",background:"linear-gradient(90deg,var(--gold),#e3c873)",borderRadius:3,transition:"width 0.4s ease"}}/>
        </div>
      </div>
    </div>,
    document.body
  );
}

function TripPlanner({defaultLocation,parentGauges,savedGauges,parentLoc,openReportId,onOpenedReportId,user,anglerHistory,sampleMode,onSignUp}){
  const [loc,setLoc]=useState({label:defaultLocation||"",lat:null,lng:null});
  const driveMinutes=120;
  const [date,setDate]=useState(()=>new Date().toISOString().split("T")[0]);
  const [steps,setSteps]=useState([]);
  const [busy,setBusy]=useState(false);
  // Mirrors `busy` to a window-scoped flag (same cross-tree pattern already used for
  // window._loadedGauges) so attemptAuthRecovery() — a top-level function outside any
  // component, shared with refreshTier's own recovery path — can tell whether a report
  // is actively generating before deciding it's safe to force a reload. The cleanup
  // resets the flag to false on every change AND on unmount (e.g. navigating off the
  // Plan tab mid-generation), so a stuck flag can never permanently block a real,
  // later, unrelated recovery from firing. See attemptAuthRecovery for why this matters.
  useEffect(()=>{
    window._reportGenerating=busy;
    return ()=>{ window._reportGenerating=false; };
  },[busy]);
  const [error,setError]=useState(null);
  const [wxData,setWxData]=useState(null);
  const [flowPts,setFlowPts]=useState([]);
  const [flowLabel,setFlowLabel]=useState("");
  const [gauges,setGauges]=useState([]);

  const [shops,setShops]=useState([]);
  const [report,setReport]=useState(null);
  const [savedReports,setSavedReports]=useState([]); // today's reports saved in Supabase — reopening is free
  const [openingReportId,setOpeningReportId]=useState(null); // which saved-report row is currently loading (per-row spinner state)
  const [saveNote,setSaveNote]=useState(null);
  const pendingSaveRef=useRef(null); // holds the last failed save payload so Retry/auto-retry can resend it
  const [retrying,setRetrying]=useState(false);

  // ── Background/email report state ──────────────────────────────────────────
  // genPopupStep: null (closed) | "choice" (wait vs. email) | "email" (address entry) | "success"
  const [genPopupStep,setGenPopupStep]=useState(null);
  const [emailInput,setEmailInput]=useState(user?.email||"");
  const [emailSubmitting,setEmailSubmitting]=useState(false);
  const [emailSubmitError,setEmailSubmitError]=useState("");

  // Shared by the initial save and by manual/auto retry — keeps the exact payload
  // around on failure instead of discarding it, so a retry resends the same report.
  async function saveReportRow(payload){
    if(!sb) return;
    try{
      setSaveNote(null);
      // Same hang-timeout guard as refreshTier/signOut: a bare await here could hang
      // indefinitely with no rejection (same root class as those two bugs), which would
      // silently skip the "couldn't save" retry path below since saveErr never fires.
      const {data:savedRow,error:saveErr}=await Promise.race([
        sb.from("planner_reports").insert({report_date:new Date().toISOString().split("T")[0],loc_label:payload.loc.label,lat:payload.loc.lat,lng:payload.loc.lng,payload}).select("id,created_at,loc_label").single(),
        new Promise((_,rej)=>setTimeout(()=>rej(new Error("save timed out")), 8000))
      ]);
      if(saveErr){
        pendingSaveRef.current=payload;
        setSaveNote("This report is shown but couldn't be saved for later: "+saveErr.message);
      }else if(savedRow){
        pendingSaveRef.current=null;
        setSavedReports(prev=>[savedRow,...prev].slice(0,10));
      }
    }catch(sve){
      pendingSaveRef.current=payload;
      setSaveNote("This report is shown but couldn't be saved for later: "+(sve.message||"unknown error"));
    }
  }

  // Auto-retry the moment the tab regains foreground — covers iOS suspending the
  // save fetch when the screen locks or the app is backgrounded mid-generation.
  useEffect(()=>{
    function onVis(){
      if(document.visibilityState==="visible"&&pendingSaveRef.current){
        const p=pendingSaveRef.current;
        setRetrying(true);
        saveReportRow(p).finally(()=>setRetrying(false));
      }
    }
    document.addEventListener("visibilitychange",onVis);
    return ()=>document.removeEventListener("visibilitychange",onVis);
  },[]);

  useEffect(()=>{if(defaultLocation)setLoc(l=>({...l,label:defaultLocation}));},[defaultLocation]);

  // Apply a saved report payload to the planner (shared by sessionStorage restore and Earlier Today)
  function applySavedReport(s){
    try{
      if(!s||!s.report)return;
      setReport(s.report);
      if(s.wxData)setWxData(s.wxData);
      if(Array.isArray(s.gauges)&&s.gauges.length)setGauges(s.gauges);
      if(s.loc&&s.loc.label)setLoc(s.loc);
      if(s.date)setDate(s.date);
      setError(null);
      try{sessionStorage.setItem("tl_tripreport_v1",JSON.stringify({...s,v:1,ts:Date.now()}));}catch(se){void 0;}
    }catch(e){void 0;}
  }
  // Open one of today's saved reports: list rows are lightweight, the payload loads on tap.
  // Guarded the same way as refreshTier/signOut: without the timeout, a stuck/in-flight
  // request just hangs forever with no rejection — no error, no report, tap looks like it
  // did nothing at all (the exact symptom reported: button tapped, nothing happened).
  async function openSavedReport(r){
    if(!sb)return;
    setOpeningReportId(r.id);
    try{
      const {data,error:perr}=await Promise.race([
        sb.from("planner_reports").select("payload").eq("id",r.id).single(),
        new Promise((_,rej)=>setTimeout(()=>rej(new Error("Loading that report timed out — check your connection and try again.")), 8000))
      ]);
      if(perr||!data||!data.payload){setError("Couldn't load that report: "+(perr?perr.message:"not found"));return;}
      applySavedReport(data.payload);
    }catch(e){setError("Couldn't load that report: "+(e.message||"unknown error"));}
    finally{setOpeningReportId(null);}
  }

  // Sample mode (guests): load the static sample through the SAME applySavedReport path
  // a real saved report uses, so what a visitor previews is rendered by the real
  // renderer rather than a mockup that could drift.
  useEffect(()=>{
    if(!sampleMode)return;
    applySavedReport(SAMPLE_TRIP_REPORT);
  },[sampleMode]);

  // Deep link from a background-report email: open it once sb is ready, then tell the
  // parent to clear the id so this doesn't refire on unrelated re-renders.
  useEffect(()=>{
    if(!openReportId||!sb)return;
    (async()=>{
      await openSavedReport({id:openReportId});
      if(onOpenedReportId)onOpenedReportId();
    })();
  },[openReportId,sb]);

  // Kicks off a background report: same rate-limited planner_reports ledger as the
  // on-screen path, but the actual generation runs server-side (survives closing the
  // app) and the finished report arrives by email instead of on screen.
  async function emailReportInBackground(){
    if(!loc.label.trim()){setEmailSubmitError("Please enter a destination.");return;}
    setEmailSubmitting(true);setEmailSubmitError("");
    try{
      let lat=loc.lat,lng=loc.lng;
      if(lat==null||lng==null){
        const results=await geocode(loc.label);
        if(!results.length){setEmailSubmitError("Couldn't find that location.");setEmailSubmitting(false);return;}
        lat=parseFloat(results[0].lat);lng=parseFloat(results[0].lon);
      }
      let auth={};
      try{if(sb){const {data}=await sb.auth.getSession();const t=data&&data.session&&data.session.access_token;if(t)auth={Authorization:"Bearer "+t};}}catch{}
      const r=await fetch("/api/plan-trip-background",{method:"POST",headers:{"Content-Type":"application/json",...auth},body:JSON.stringify({label:loc.label,lat,lng,date,driveMinutes,notifyEmail:emailInput})});
      let d;try{d=await r.json();}catch{throw new Error("The server didn't respond as expected — please try again.");}
      if(!r.ok||d.error){throw new Error((d&&d.error&&d.error.message)||"Couldn't start the report — please try again.");}
      setGenPopupStep("success");
    }catch(e){
      setEmailSubmitError(e.message||"Something went wrong — please try again.");
    }finally{
      setEmailSubmitting(false);
    }
  }

  // Load today's saved reports (specific columns only — payload is fetched on tap)
  useEffect(()=>{(async()=>{
    if(!sb)return;
    try{
      const today=new Date().toISOString().split("T")[0];
      const {data,error:lerr}=await sb.from("planner_reports").select("id,created_at,loc_label").eq("report_date",today).order("created_at",{ascending:false}).limit(10);
      if(!lerr&&Array.isArray(data))setSavedReports(data);
    }catch(e){void 0;}
  })();},[]);

  // Restore last generated report so tab switches don't lose it — session-scoped:
  // closing the app clears it, and the location field falls back to the Intel tab location
  useEffect(()=>{
    try{localStorage.removeItem("tl_tripreport_v1");}catch(lre){void 0;} // one-time cleanup of old persistent key
    try{
      const raw=sessionStorage.getItem("tl_tripreport_v1");
      if(!raw)return;
      const s=JSON.parse(raw);
      if(!s||s.v!==1||!s.report)return;
      const today=new Date().toISOString().split("T")[0];
      if(Date.now()-(s.ts||0)>12*60*60*1000||(s.date||"")<today){try{sessionStorage.removeItem("tl_tripreport_v1");}catch(re){void 0;}return;}
      setReport(s.report);
      if(s.wxData)setWxData(s.wxData);
      if(Array.isArray(s.gauges)&&s.gauges.length)setGauges(s.gauges);
      if(s.loc&&s.loc.label)setLoc(s.loc);
      if(s.date)setDate(s.date);
    }catch(e){void 0;}
  },[]);

  function addStep(text,state="done"){
    setSteps(prev=>{
      const n=[...prev];
      if(n.length&&n[n.length-1].state==="active")n[n.length-1].state="done";
      n.push({text,state});return n;
    });
  }

  async function generate(){
    if(!loc.label.trim()){setError("Please enter a destination.");return;}
    // Daily-limit pre-check — instant feedback instead of failing after a 90-second search.
    // The server enforces the same limit regardless; this is purely UX.
    if(sb){
      try{
        const devIds=String(import.meta.env.VITE_DEV_UNLIMITED_IDS||"").split(",").map(s=>s.trim()).filter(Boolean);
        let uid=null; try{uid=(await sb.auth.getUser()).data.user?.id||null;}catch(e){void 0;}
        const devExempt=uid&&devIds.includes(uid);
        if(!devExempt){
          const since=new Date();since.setUTCHours(0,0,0,0);
          const {count,error:cntErr}=await sb.from("planner_reports").select("id",{count:"exact",head:true}).gte("created_at",since.toISOString());
          if(!cntErr&&count!=null&&count>=5){setError("You've reached today's limit of 5 trip reports. Reports you already ran today are listed below — tap one to reopen it. The limit resets daily.");return;}
        }
      }catch(pe){void 0;}
    }
    setBusy(true);setError(null);setSteps([]);
    setWxData(null);setFlowPts([]);setGauges([]);setShops([]);setReport(null);
    let builtReport=null,finalGauges=null;
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
      // Always fetch gauges centered on the trip destination — never reuse Intel tab gauges,
      // which are centered on the user's current location and caused wrong-water reports.
      let pgScaled=[];
      if(!pgScaled.length){
        try{
          const usgs0=await fetchUSGSLive(lat,lng,2,true);
          const liveTS0=(usgs0?.value?.timeSeries)??[];
          pgScaled=liveTS0.map(t=>{
            const raw=t.values?.[0]?.value?.[0]?.value;
            const cfs=raw!=null?parseFloat(raw):null;
            const{label,cls}=cfsLabel(cfs);
            const siteNo=(t.sourceInfo?.siteCode?.[0]?.value)||"";
            const siteLat=parseFloat(t.sourceInfo?.geoLocation?.geogLocation?.latitude||0);
            const siteLng=parseFloat(t.sourceInfo?.geoLocation?.geogLocation?.longitude||0);
            const dist=Math.sqrt(Math.pow(siteLat-lat,2)+Math.pow(siteLng-lng,2));
            return{name:t.sourceInfo?.siteName??"Unknown",cfs,label,cls,siteNo,dist,lat:siteLat,lng:siteLng};
          }).filter(s=>s.cfs!=null&&s.cfs>=0&&s.cfs<500000).sort((a,b)=>a.dist-b.dist);
          // Meaningful-flow gauges get the candidate slots; near-dry trickles only pad if there's room left.
          // Spread across compass directions so a dense cluster close to the origin can't crowd
          // out a real drainage farther out in a different direction (same radius, just not "nearest").
          pgScaled=directionalSpread([...pgScaled.filter(s=>s.cfs>=15),...pgScaled.filter(s=>s.cfs<15)],40,lat,lng);
          // Supplemental sources beyond USGS (SPEC_gauge_sources.md) — Colorado DWR today,
          // more states/agencies later. Added AFTER the cap above, not before it: DWR only
          // survives dedup when it's covering something USGS isn't (see fetchCODWRGauges's
          // own comment), so by definition it's never redundant with what's already in
          // pgScaled — but a dense-USGS area can still fill all 40 directional-spread slots
          // on USGS alone, crowding DWR's gap-filling gauges out of a competition they never
          // needed to be in. Confirmed by direct reproduction against a real Lafayette, CO
          // search: 432 live USGS candidates + 128 qualifying DWR candidates in one search:
          // BOCBGRCO (South Boulder Creek below Gross Reservoir) lost the 40-slot competition
          // even with its own internal cap removed entirely. Capped internally at 25 inside
          // fetchCODWRGauges already, so this can't grow unbounded.
          try{
            const dwrGauges=await fetchCODWRGauges(lat,lng,100,new Set(pgScaled.map(s=>s.siteNo)));
            pgScaled=[...pgScaled,...dwrGauges];
          }catch{}
          // NOAA NWPS forecast enrichment (SPEC_nwps_forecast_integration.md) — attaches
          // a forecast onto gauges already built above; never adds new cards (see
          // attachNWPSForecasts's own comment for why). Independent try/catch: a slow or
          // down NWPS must never block or blank the stream list USGS/DWR already built.
          try{
            const nwpsGauges=await fetchNWPSGauges(lat,lng,30);
            pgScaled=attachNWPSForecasts(pgScaled,nwpsGauges);
          }catch{}
        }catch(ge2){void 0;}
      }
      setGauges(pgScaled);
      addStep(`${pgScaled.length} streams loaded`);

      {
        addStep("Analyzing area conditions…","active");
        const ds=new Date(date+"T12:00:00").toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});
        // Thermal/flow enrichment stays a client-side concern (same USGS batch helpers used
        // elsewhere in the app) — the pipeline degrades gracefully to raw CFS if these are {}.
        let pTempMap={},flowAvgMap={};
        try{
          // USGS-only, on purpose: fetchUSGSTempBatch/fetchFlowAvgBatch are USGS-specific
          // endpoints. A CO DWR gauge's siteNo is either a non-numeric DWR abbrev (would 400
          // the whole batch — tested directly) or a numeric USGS cross-reference that's
          // usually the dead gauge DWR is filling in for in the first place (a real query for
          // it, tested directly, just returns no data — harmless, but a wasted call). Filtering
          // to USGS-sourced entries here avoids both.
          const gSiteNos=filterFishableGauges(pgScaled.filter(g=>!g.sourceAgency),lat,lng).map(g=>g.siteNo).filter(sn=>/^\d+$/.test(sn));
          const [ptm,fam]=await Promise.all([
            fetchUSGSTempBatch(gSiteNos).catch(()=>({})),
            fetchFlowAvgBatch(gSiteNos).catch(()=>({}))
          ]);
          pTempMap=ptm;flowAvgMap=fam;
        }catch{pTempMap={};flowAvgMap={};}
        // Places-geocoding adapter for the pipeline's geocodeRiver fallback — same
        // /api/claude proxy call the browser has always used (no auth needed, no AI cost).
        const geocodePlacesBrowser=async(query)=>{
          try{
            const r=await fetch('/api/claude',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({geocode:true,query})});
            const d=await r.json();
            if(d.geocodeError||d.lat==null)return null;
            return{lat:d.lat,lng:d.lng};
          }catch{return null;}
        };
        try{
          builtReport=await runTripPlannerPipeline(
            {loc:{label:loc.label,lat,lng},ds,driveMinutes,wx,pgScaled,savedGauges,pTempMap,flowAvgMap,anglerHistory},
            {askAI:askClaude,geocodePlaces:geocodePlacesBrowser},
            (text,state)=>addStep(text,state)
          );
          // NOAA National Water Model fallback (SPEC_streamflow_forecast.md) — fills in a
          // flow number for picks that came back with NO gauge match at all (r.cfs null).
          // Purely additive: only touches picks that would otherwise show no flow, never
          // overwrites a real USGS/DWR/NWPS-matched reading. Independent try/catch per
          // pick AND around the whole block — a slow or down NWM must never block or
          // blank a report that's otherwise ready. r.condition is only filled in when
          // empty, so a real AI-written condition note is never overwritten.
          //
          // Multi-day outlook (added 2026-08-19/20): only has data for reaches the daily
          // sync job tracks (see nwm_tracked_reaches, currently 2 seeded reaches — this
          // will show for very few picks until that list grows to cover real usage,
          // which is a known, deliberate next step, not a bug). r.nwmOutlook stays
          // undefined for everyone else, and the render side must treat it as fully
          // optional — most reports will never have it.
          if(builtReport?.rivers?.length){
            try{
              await Promise.all(builtReport.rivers.map(async(r)=>{
                if(r.cfs!=null||r.lat==null||r.lng==null) return;
                try{
                  const nwm=await fetchNWMStreamflow(r.lat,r.lng);
                  if(nwm&&nwm.cfs!=null){
                    r.cfs=Math.round(nwm.cfs);
                    if(!r.condition) r.condition="modeled, no gauge nearby";
                    if(nwm.reachId!=null){
                      try{
                        const outlook=await fetchNWMForecastOutlook(sb,nwm.reachId);
                        if(outlook&&outlook.length) r.nwmOutlook=outlook;
                      }catch{}
                    }
                  }
                }catch{}
              }));
            }catch{}
          }
          setReport(builtReport);
        }catch(e2){
          const msg=(e2&&e2.message)||String(e2);
          if(e2&&e2.isLimit){setError(msg);}
          else{
            const transient=/internal server error|overloaded|api error|api request failed/i.test(msg);
            setError("Report failed: "+msg+(transient?" — this is a temporary issue with the AI service, not your location. Wait a minute and tap Generate again.":""));
          }
        }
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
          finalGauges=pg.map(g=>({...g,pct:g.cfs?Math.min(Math.round((g.cfs/maxCFS2)*95),100):0}));
          setGauges(finalGauges);
          const histD=await fetchUSGSHistory(lat,lng);
          const histTS=histD.value?.timeSeries??[];
          if(histTS.length){
            const best=histTS.sort((a,b)=>(b.values?.[0]?.value?.length||0)-(a.values?.[0]?.value?.length||0))[0];
            const pts=(best.values?.[0]?.value??[]).map(v=>({t:v.dateTime,v:parseFloat(v.value)})).filter(v=>!isNaN(v.v)&&v.v>=0&&v.v<500000);
            setFlowPts(pts);setFlowLabel(best.sourceInfo?.siteName??"");
          }
          addStep(`${pg.length} gauges loaded ✓`);
        }catch(ge){void 0;}
        // Persist the finished report so navigating away doesn't lose it
        if(builtReport){
          const payload={v:1,ts:Date.now(),loc:{label:loc.label,lat,lng},date,wxData:wx,gauges:finalGauges||pgScaled,report:builtReport};
          try{sessionStorage.setItem("tl_tripreport_v1",JSON.stringify(payload));}catch(se){void 0;}
          // Save to Supabase: lets the user reopen today's reports for free, and the row
          // is the planner usage-ledger entry the server counts against the daily limit.
          // Routed through saveReportRow so a failure (e.g. iOS suspending the fetch on
          // backgrounding) can be retried manually or automatically on regained focus.
          if(sb) await saveReportRow(payload);
        }
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
      {sampleMode&&(
        <div className="card" style={{border:"1px solid rgba(209,154,74,0.35)",background:"rgba(209,154,74,0.07)"}}>
          <div className="ctitle">👀 Sample Report — Not Live Data</div>
          <div className="csub">
            This is a real report from a Front Range day, shown so you can see exactly what
            the planner produces. Your own forecast is built live for your location and date,
            off current flows and weather. Trip Planner is part of Consumer Pro.
          </div>
        </div>
      )}
      <div className="card">
        <div className="ctitle">🗓 Plan Your Trip</div>
        <label className="lbl">Destination</label>
        <div style={{marginBottom:12}}>
          <LocationSearch placeholder="River, city, or region…" initialValue={loc.label} onSelect={s=>setLoc(s)} onTextChange={val=>setLoc({label:val,lat:null,lng:null})}/>
        </div>
        <label className="lbl">Trip Date</label>
        <input className="inp" type="date" value={date} min={new Date().toISOString().split("T")[0]} onChange={e=>setDate(e.target.value)}/>
        <div style={{fontSize:14,color:"var(--stone)",marginBottom:12}}>Shows all fishable streams within a <span style={{color:"var(--gold)"}}>2 hour drive</span></div>
        {error&&<div className="err">{error}</div>}
        {sampleMode
          ? <button className="gen" onClick={()=>onSignUp&&onSignUp("")}>✦ Get My Own Forecast</button>
          : <button className="gen" onClick={()=>{setEmailInput(user?.email||"");setEmailSubmitError("");setGenPopupStep("choice");}} disabled={busy}>{busy?"Generating…":"✦ Generate Fishing Forecast"}</button>}
      </div>

      {genPopupStep&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}
          onClick={()=>{if(!emailSubmitting){setGenPopupStep(null);}}}>
          <div className="card" style={{maxWidth:400,width:"100%",margin:0}} onClick={e=>e.stopPropagation()}>
            {genPopupStep==="choice"&&(
              <>
                <div className="ctitle">🗓 Get Your Forecast</div>
                <div style={{fontSize:14,color:"var(--stone)",marginBottom:16,lineHeight:1.5}}>Waiting here usually takes 2–5 minutes. Or we can build it in the background and email you when it's ready — no need to keep the app open.</div>
                <button className="gen" onClick={()=>{setGenPopupStep(null);generate();}} style={{marginBottom:10}}>Wait Here (2–5 min)</button>
                <button className="gen" onClick={()=>setGenPopupStep("email")}>Email It To Me Instead</button>
                <button onClick={()=>setGenPopupStep(null)}
                  style={{display:"block",width:"100%",textAlign:"center",background:"none",border:"none",color:"var(--stone)",marginTop:10,cursor:"pointer",fontSize:14,fontFamily:"var(--font-body)"}}>
                  Cancel
                </button>
              </>
            )}
            {genPopupStep==="email"&&(
              <>
                <div className="ctitle">📧 Email Me This Forecast</div>
                <div style={{fontSize:14,color:"var(--stone)",marginBottom:12,lineHeight:1.5}}>We'll build your {loc.label||"trip"} forecast in the background and email it to you — no need to keep the app open while it runs.</div>
                <label className="lbl">Email address</label>
                <input className="inp" type="email" value={emailInput} onChange={e=>setEmailInput(e.target.value)} style={{marginBottom:12}}/>
                {emailSubmitError&&<div className="err" style={{marginBottom:12}}>{emailSubmitError}</div>}
                <button className="gen" onClick={emailReportInBackground} disabled={emailSubmitting||!emailInput}>{emailSubmitting?"Starting…":"Send Me This Forecast"}</button>
                <button onClick={()=>setGenPopupStep("choice")} disabled={emailSubmitting}
                  style={{display:"block",width:"100%",textAlign:"center",background:"none",border:"none",color:"var(--stone)",marginTop:10,cursor:emailSubmitting?"default":"pointer",fontSize:14,fontFamily:"var(--font-body)"}}>
                  ← Back
                </button>
              </>
            )}
            {genPopupStep==="success"&&(
              <>
                <div className="ctitle">✓ On its way</div>
                <div style={{fontSize:14,color:"var(--stone)",marginBottom:16,lineHeight:1.5}}>We'll email your {loc.label} forecast to {emailInput} — usually within a few minutes. Feel free to close the app.</div>
                <button className="gen" onClick={()=>setGenPopupStep(null)}>Done</button>
              </>
            )}
          </div>
        </div>
      )}

      {error&&<div style={{background:"rgba(150,80,80,0.15)",border:"1px solid rgba(150,80,80,0.4)",borderRadius:10,padding:"10px 14px",fontSize:14,color:"var(--red)",marginBottom:10}}>{error}</div>}

      {(savedReports.length>0||saveNote)&&!busy&&(
        <div className="card">
          <div className="ctitle">🕐 Earlier Today</div>
          <div className="csub">Reports you already ran today — reopening one is free and instant</div>
          {saveNote&&<div style={{fontSize:14,color:"var(--red)",marginBottom:8}}>{saveNote}{" "}
            {pendingSaveRef.current&&<button onClick={()=>{setRetrying(true);saveReportRow(pendingSaveRef.current).finally(()=>setRetrying(false));}} disabled={retrying}
              style={{background:"none",border:"none",color:"var(--sky)",textDecoration:"underline",cursor:"pointer",fontSize:14,fontFamily:"inherit",padding:0}}>
              {retrying?"Retrying…":"Retry"}
            </button>}
          </div>}
          {savedReports.map(r=>(
            <button key={r.id} disabled={openingReportId===r.id} onClick={()=>openSavedReport(r)} style={{display:"block",width:"100%",textAlign:"left",background:"rgba(255,255,255,0.05)",border:"1px solid rgba(209,154,74,0.25)",borderRadius:10,padding:"10px 14px",marginBottom:8,cursor:openingReportId===r.id?"default":"pointer",color:"var(--foam)",fontSize:15,fontFamily:"var(--font-body)",opacity:openingReportId===r.id?0.6:1}}>
              <span style={{color:"var(--gold)"}}>{r.loc_label||"Saved report"}</span>
              <span style={{color:"var(--stone)",marginLeft:8,fontSize:13}}>{openingReportId===r.id?"Loading…":new Date(r.created_at).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"})}</span>
            </button>
          ))}
        </div>
      )}

      {busy&&<TripPlannerLoading steps={steps} destination={loc.label} onCancel={()=>{setBusy(false);setSteps([]);setError(null);}}/>}

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
          <div className="csub">{report.dataSource==="estimated"?"Based on typical seasonal conditions — no live data found":report.dataSource==="flows-live"?"Based on live USGS flows & weather — "+(report.searchNote||"no current local reports found"):"Synthesized from live USGS flows, weather & current conditions"}</div>
          {report.restrictionDebug&&<div style={{fontSize:11,color:"var(--stone)",fontFamily:"monospace",marginBottom:6,padding:"4px 8px",background:"rgba(0,0,0,0.2)",borderRadius:6,wordBreak:"break-all"}}>restriction check: {report.restrictionDebug.outcome}{report.restrictionDebug.checked?` · checked ${report.restrictionDebug.checked}`:""}{report.restrictionDebug.found?` · found ${report.restrictionDebug.found}`:""}{report.restrictionDebug.found?` · matched ${report.restrictionDebug.matched||0}`:""}{report.restrictionDebug.error?` · ${report.restrictionDebug.error}`:""}{report.restrictionDebug.raw?` · raw: ${report.restrictionDebug.raw}`:""}</div>}
          <div style={{display:"flex",gap:8,marginBottom:14}}>
            <button className="btn" style={{flex:1,padding:"8px 10px",fontSize:14,background:"rgba(0,0,0,0.2)"}}
              onClick={()=>{
                const txt=plannerReportToText(loc,date,report);
                if(navigator.share){navigator.share({title:"Fishing Report",text:txt});}
                else{navigator.clipboard.writeText(txt).then(()=>alert("Copied to clipboard!"));}
              }}>
              📤 Share / Copy
            </button>
            <button className="btn" style={{flex:1,padding:"8px 10px",fontSize:14,background:"linear-gradient(135deg,#2c5f6e,#5a7a4a)"}}
              onClick={()=>generatePlannerReportPDF(loc,date,report)}>
              📄 Save PDF
            </button>
          </div>
          <p style={{fontSize:14,color:"var(--foam)",lineHeight:1.65,marginBottom:14}}>{(report.overview||"").replace(/<cite[^>]*>|<\/cite>/g,"")}</p>
          {report.hatches&&<><div className="slbl">Hatch Activity</div><p style={{fontSize:14,color:"var(--foam)",lineHeight:1.65,marginBottom:14}}>{report.hatches}</p></>}
          {report.bestTimes&&<><div className="slbl">Best Times</div><p style={{fontSize:14,color:"var(--foam)",lineHeight:1.65,marginBottom:14}}>{report.bestTimes}</p></>}
          {report.tips&&<><div className="slbl">Insider Tips</div><p style={{fontSize:14,color:"var(--foam)",lineHeight:1.65,marginBottom:14}}>{report.tips}</p></>}
          {report.personalAngle&&(
            <div style={{marginTop:2,marginBottom:14,padding:"10px 12px",background:"rgba(209,154,74,0.08)",borderRadius:10,borderLeft:"3px solid var(--gold)"}}>
              <div className="lbl" style={{marginBottom:4}}>🎣 Your Trip History</div>
              <p style={{fontSize:14,color:"var(--sky)",lineHeight:1.6}}>{report.personalAngle}</p>
            </div>
          )}
          {report.flyBoxEssentials?.length>0&&<><div className="divider"/><div className="slbl">Fly Box Essentials</div><div className="chips">{report.flyBoxEssentials.map((f,i)=><a key={i} className="chip" href={`https://www.google.com/search?q=${encodeURIComponent(f+" fly pattern")}&tbm=isch`} target="_blank" rel="noreferrer" style={{textDecoration:"none",cursor:"pointer"}}>🪶 {f}</a>)}</div><div className="divider"/></> }
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
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><div className="rriver">🏞 {r.name}</div><a href={r.lat&&r.lng?`https://maps.google.com/?q=${r.lat},${r.lng}`:`https://www.google.com/maps/search/${encodeURIComponent(r.name)}`} target="_blank" rel="noreferrer" style={{fontSize:14,color:"var(--sky)",textDecoration:"none",padding:"2px 8px",background:"rgba(44,95,110,0.2)",borderRadius:12,flexShrink:0}}>📍 Map</a></div>{r.restriction&&<div style={{fontSize:14,color:"#ffb4a3",background:"rgba(140,73,54,0.25)",border:"1px solid rgba(140,73,54,0.5)",borderRadius:8,padding:"6px 10px",marginBottom:6,fontWeight:600}}>⚠️ {r.restriction.status==="closure"?"Closed to fishing":"Hoot Owl restriction"}{r.restriction.hours?" — "+r.restriction.hours:""}{r.restriction.reach?" ("+r.restriction.reach+")":""}</div>}{(r.cfs||r.type||r.crowdLevel||r.driveMin!=null)&&<div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:4}}>{r.type&&<span style={{fontSize:14,background:"rgba(44,95,110,0.2)",borderRadius:12,padding:"2px 8px",color:"var(--sky)"}}>{r.type}</span>}{r.cfs&&r.cfs!=="unknown"&&<span style={{fontSize:14,background:"rgba(44,95,110,0.2)",borderRadius:12,padding:"2px 8px",color:"var(--gold)"}}>💧 {r.cfs} · {r.condition||""}</span>}{r.nwmOutlook&&r.nwmOutlook.length>0&&(()=>{const vals=r.nwmOutlook.map(d=>d.cfs).filter(v=>v!=null);if(!vals.length)return null;const lo=Math.round(Math.min(...vals)),hi=Math.round(Math.max(...vals));return<span style={{fontSize:14,background:"rgba(150,130,180,0.15)",border:"1px dashed rgba(150,130,180,0.4)",borderRadius:12,padding:"2px 8px",color:"#b8a8d0"}} title="NOAA National Water Model — not an official NWS forecast, and not calibrated to a local gauge">📅 5-day: {lo===hi?`${lo}`:`${lo}–${hi}`} cfs (modeled)</span>})()}{r.crowdLevel&&<span style={{fontSize:14,background:r.crowdLevel==="Light"?"rgba(90,122,74,0.2)":r.crowdLevel==="Heavy"?"rgba(150,80,80,0.2)":"rgba(209,154,74,0.15)",borderRadius:12,padding:"2px 8px",color:r.crowdLevel==="Light"?"#9cd47a":r.crowdLevel==="Heavy"?"var(--red)":"var(--gold)"}}>👥 {r.crowdLevel} crowds</span>}{r.driveMin!=null&&<span style={{fontSize:14,background:"rgba(255,255,255,0.07)",borderRadius:12,padding:"2px 8px",color:"var(--stone)"}}>🚗 ~{r.driveMin} min</span>}{r.bestTime&&<span style={{fontSize:14,background:"rgba(0,0,0,0.2)",borderRadius:12,padding:"2px 8px",color:"var(--stone)"}}>🕐 {r.bestTime}</span>}</div>}{r.why&&<div style={{fontSize:15,color:"#9cd47a",fontStyle:"italic",marginBottom:4}}>✓ {r.why}</div>}
                {r.accessPoints?.length>0&&<div style={{marginBottom:6}}><div style={{fontSize:14,color:"var(--stone)",textTransform:"uppercase",letterSpacing:1,marginBottom:3}}>Access Points</div>{r.accessPoints.map((ap,ai)=><a key={ai} href={"https://www.google.com/maps/search/"+encodeURIComponent(ap)} target="_blank" rel="noreferrer" style={{display:"block",fontSize:14,color:"var(--sky)",textDecoration:"none",marginBottom:2}}>📍 {ap}</a>)}</div>}
                <div className="rbody">{(r.conditions||"").replace(/<cite[^>]*>|<\/cite>/g,"")}</div>
                {r.techniques&&<div className="rtech">{(r.techniques||"").replace(/<cite[^>]*>|<\/cite>/g,"").replace(/\s*\(\d+-?\d*%\)/g,"").trim()}</div>}
                {r.flies?.length>0&&<div className="chips">{r.flies.map((f,j)=><a key={j} className="chip" href={`https://www.google.com/search?q=${encodeURIComponent(f+" fly pattern")}&tbm=isch`} target="_blank" rel="noreferrer" style={{textDecoration:"none",cursor:"pointer"}}>🪶 {f}</a>)}</div>}
                <StreamGaugeChart streamName={r.name} knownSiteNo={r.siteNo} localGauges={gauges} lat={r.lat||loc?.lat} lng={r.lng||loc?.lng}/>
              </div>
              );
            })}
          </>}
        </div>
      )}
    </div>
  );
}


// ── Main App ──────────────────────────────────────────────────────────────────


// Requires every word in the query to appear somewhere in the name — not one exact
// contiguous phrase. Previously "south platte" alone could match 80+ sites (the name
// spans a whole river system from Denver-metro plains water up into the mountains), and
// the only way to see past the first handful was... there wasn't one, since a natural
// follow-up like "south platte cheesman" failed too: "cheesman" doesn't sit adjacent to
// "south platte" in the literal site name, so the old contiguous-substring check missed
// it even though the person typed the exact right words. Confirmed live (2026-07-28) and
// verified against real USGS data: token matching correctly narrows "south platte
// cheesman" to just the 2 real Cheesman-area sites, "platte trumbull" to the Deckers-area
// gauge, etc. — for any river system anywhere, no curated list, just "did they type the
// words that are actually in the name."
function tokenMatch(name,query){
  const n=(name||"").toLowerCase();
  const tokens=(query||"").toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.length>0&&tokens.every(t=>n.includes(t));
}

function GaugeSearch({loc,onAdd,gaugeInput,setGaugeInput,gaugeAdding}){
  const q=(gaugeInput||"").toLowerCase().trim();
  const loadedGauges=window._loadedGauges||[];
  const [searchResults,setSearchResults]=React.useState([]);
  const [searching,setSearching]=React.useState(false);
  const [totalMatches,setTotalMatches]=React.useState(0);
  const [searchErr,setSearchErr]=React.useState("");
  const distFrom=x=>x.distMi!=null?x.distMi:(loc?.lat!=null?Math.sqrt(Math.pow(x.lat-loc.lat,2)+Math.pow(x.lng-loc.lng,2))*69:9999);
  // No cap: this is the instant local placeholder shown while the nationwide search runs.
  // It was capped at 6, which was itself a limit on a pick-your-own list — removed.
  const localResults=q.length>=2&&!q.match(/^[0-9]+$/)
    ?loadedGauges.filter(g=>tokenMatch(g.name,q)).sort((a,b)=>distFrom(a)-distFrom(b))
    :[];
  const results=searchResults.length?searchResults:localResults;
  React.useEffect(()=>{
    if(q.length<3||q.match(/^[0-9]+$/)){setSearchResults([]);setTotalMatches(0);return;}
    const timer=setTimeout(async()=>{
      setSearching(true);setSearchErr("");
      try{
        // Nationwide name search — no bounding box. This is a deliberate pick-your-own
        // list: the person typed the name, so every real match is shown, sorted
        // nearest-first purely as a convenience. Nothing is filtered out by distance or
        // by terrain (an earlier elevation-based ranking here was removed — it hid
        // legitimate water like the Denver-metro South Platte, which is its own fishery
        // and not the app's call to exclude from someone's own favorites).
        let matched=await nwSearchByName(q);
        // Colloquial place names (e.g. "Deckers") often never appear in a gauge's
        // official USGS name — those are usually named for a dam, a different nearby
        // town, or a tributary junction. Geocode the query text and pull in the closest
        // gauges to that point as ADDITIONAL results, so this works for any place name
        // in the country without a curated stream list.
        try{
          const geo=await geocode(q);
          if(geo&&geo.length){
            const hit=[...geo].sort((a,b)=>
              (Math.pow(parseFloat(a.lat)-(loc?.lat||0),2)+Math.pow(parseFloat(a.lon)-(loc?.lng||0),2))
              -(Math.pow(parseFloat(b.lat)-(loc?.lat||0),2)+Math.pow(parseFloat(b.lon)-(loc?.lng||0),2))
            )[0];
            const glat=parseFloat(hit.lat),glng=parseFloat(hit.lon);
            const nearGeo=await nwNearPoint(glat,glng,0.35,5);
            matched=[...matched,...nearGeo.filter(g=>!matched.find(m=>m.siteNo===g.siteNo))];
          }
        }catch{}
        const withDist=matched.map(x=>({...x,distMi:loc?.lat!=null?Math.round(Math.sqrt(Math.pow(x.lat-loc.lat,2)+Math.pow(x.lng-loc.lng,2))*69):null}));
        withDist.sort((a,b)=>(a.distMi??9999)-(b.distMi??9999));
        setTotalMatches(withDist.length);
        setSearchResults(withDist);
      }catch(e){
        setSearchErr(e?.message||"Search failed");
        setSearchResults([]);setTotalMatches(0);
      }
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
        <div style={{marginTop:8,background:"rgba(209,154,74,0.1)",border:"1px solid rgba(209,154,74,0.3)",borderRadius:10,padding:"10px 12px"}}>
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
      {searching&&(
        <div style={{marginTop:6,fontSize:13,color:"var(--sky)",fontStyle:"italic"}}>
          Searching all USGS gauges nationwide…{localResults.length?" showing nearby matches so far.":""}
        </div>
      )}
      {!!searchErr&&!searching&&(
        <div style={{marginTop:6,fontSize:13,color:"#e8a0a0"}}>
          Nationwide search unavailable ({searchErr}). Showing nearby gauges only — you can still paste a USGS site number above.
        </div>
      )}
      {!searching&&!searchErr&&totalMatches>0&&(
        <div style={{marginTop:6,fontSize:13,color:"var(--stone)",fontStyle:"italic"}}>
          {totalMatches} match{totalMatches===1?"":"es"} nationwide, nearest first{totalMatches>6?" — scroll for more":""}. Add a town, dam, or landmark to narrow (e.g. "South Platte Cheesman").
        </div>
      )}
      <div style={{maxHeight:results.length>6?320:undefined,overflowY:results.length>6?"auto":undefined}}>
      {results.map((r,i)=>(
        <div key={i} onClick={()=>{setGaugeInput(r.siteNo);}}
          style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 10px",marginTop:4,background:"rgba(255,255,255,0.05)",borderRadius:8,cursor:"pointer"}}>
          <div>
            <div style={{fontSize:15,color:"var(--foam)"}}>{r.name}</div>
            <div style={{fontSize:14,color:"var(--stone)"}}>#{r.siteNo}{r.distMi!=null?" · "+r.distMi+"mi away":""}</div>
          </div>
          {r.lat&&r.lng&&<a href={`https://maps.google.com/?q=${r.lat},${r.lng}`} target="_blank" rel="noopener noreferrer"
            onClick={e=>e.stopPropagation()}
            style={{fontSize:14,color:"var(--sky)",textDecoration:"none"}}>📍 Map</a>}
        </div>
      ))}
      </div>
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
          <div style={{fontFamily:"var(--font-head)",fontSize:14,color:"var(--gold)",marginBottom:8,display:"flex",justifyContent:"space-between"}}>
            <span>🏞 {loc}</span>
            <span style={{fontSize:14,color:"var(--stone)",fontFamily:"sans-serif"}}>{lc.length} photo{lc.length>1?"s":""}</span>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:4}}>
            {lc.map((c2,i)=>(
              <div key={i} style={{position:"relative",aspectRatio:"1",overflow:"hidden",borderRadius:8,cursor:"pointer"}} onClick={()=>onPhotoClick&&onPhotoClick(c2.photo,c2.id)}>
                <img src={toThumbUrl(c2.photo)} alt={c2.species} loading="lazy" style={{width:"100%",height:"100%",objectFit:"cover"}} onError={e=>{e.target.onerror=null;e.target.src=c2.photo;}}/>
                <div style={{position:"absolute",bottom:0,left:0,right:0,background:"linear-gradient(transparent,rgba(0,0,0,0.7))",padding:"4px 6px"}}>
                  <div style={{fontSize:14,color:"white",fontFamily:"var(--font-body)"}}>{c2.species}{c2.length?" "+c2.length+'"':""}</div>
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
          <button key={v} onClick={()=>setView(v)} style={{fontSize:14,padding:"4px 12px",borderRadius:20,border:"1px solid rgba(209,154,74,0.3)",background:view===v?"rgba(209,154,74,0.25)":"rgba(255,255,255,0.05)",color:view===v?"var(--gold)":"var(--stone)",cursor:"pointer"}}>{l}</button>
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
        {gauges.length>0&&<button onClick={()=>setShowStarredOnly&&setShowStarredOnly(v=>!v)} style={{fontSize:14,background:showStarredOnly?"rgba(209,154,74,0.3)":"rgba(255,255,255,0.06)",border:"1px solid rgba(209,154,74,0.3)",borderRadius:20,padding:"3px 10px",color:showStarredOnly?"var(--gold)":"var(--stone)",cursor:"pointer"}}>
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

function SavedGaugesList({savedGauges,showAddGauge,setShowAddGauge,gaugeInput,setGaugeInput,gaugeAdding,addSavedGauge,removeSavedGauge,moveSavedGauge,fetchSavedGaugeData,cfsLabel}){
  const [sgMap,setSgMap]=useState({});
  const [expanded,setExpanded]=useState(null);
  const idSetKey=[...savedGauges.map(g=>g.id)].sort().join(",");
  useEffect(()=>{
    if(!savedGauges.length) return;
    Promise.all(savedGauges.map(g=>fetchSavedGaugeData(g))).then(async results=>{
      setSgMap(m=>{const next={...m};results.forEach(r=>{next[r.id]=r;});return next;});
      // Forecast enrichment via the SAME shared function the discovered-gauge list uses
      // (see enrichWithNWPSForecasts in gaugeSources.js). Runs as a second pass rather
      // than blocking the first: CFS values render immediately, forecasts fill in when
      // NOAA answers. Only gauges fetchSavedGaugeData resolved coordinates for can
      // match — DWR-sourced saved gauges return without lat/lng and pass through
      // unenriched, which is a known gap, not a silent failure.
      try{
        const enriched=await enrichWithNWPSForecasts(results);
        setSgMap(m=>{const next={...m};enriched.forEach(r=>{next[r.id]=r;});return next;});
      }catch{}
    }).catch(()=>{});
  },[idSetKey]);
  // Render order always follows savedGauges (the manually-orderable source of truth) —
  // reordering just re-maps existing fetched data, it never re-fetches.
  const sgData=savedGauges.map(g=>sgMap[g.id]||g);
  return(
    <div className="card" style={{marginBottom:12}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
        <span style={{fontSize:15,color:"var(--gold)",fontFamily:"var(--font-head)"}}>⭐ My Gauges</span>
        <button onClick={()=>setShowAddGauge(v=>!v)} style={{fontSize:14,background:"rgba(209,154,74,0.2)",border:"1px solid rgba(209,154,74,0.4)",borderRadius:20,padding:"3px 10px",color:"var(--gold)",cursor:"pointer"}}>+ Add</button>
      </div>
      {showAddGauge&&(
        <div style={{display:"flex",gap:6,marginBottom:10}}>

        </div>
      )}
      {sgData.map((g,i)=>(
        <div key={i} style={{borderBottom:i<sgData.length-1?"1px solid rgba(255,255,255,0.06)":"none"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",cursor:"pointer"}} onClick={()=>setExpanded(expanded===i?null:i)}>
          <div>
            <div style={{fontSize:15,color:"var(--foam)"}}>
              {g.lat&&g.lng
                ?<a href={`https://maps.google.com/?q=${g.lat},${g.lng}`} target="_blank" rel="noopener noreferrer" style={{color:"var(--sky)",textDecoration:"none"}} onClick={e=>e.stopPropagation()}>{g.name||g.site_no}</a>
                :(g.name||g.site_no)}
            </div>
            <div style={{fontSize:15,color:"var(--stone)",marginTop:2}}>
              {g.cfs!=null?Math.round(g.cfs).toLocaleString()+" CFS"+(g.nwmModeled?" (modeled)":""):(g.label||"Loading…")}
              <ForecastBadge cfs={g.cfs} forecastCfs={g.forecastCfs} style={{marginLeft:8}}/>
              {g.nwmOutlook&&g.nwmOutlook.length>0&&(()=>{const vals=g.nwmOutlook.map(d=>d.cfs).filter(v=>v!=null);if(!vals.length)return null;const lo=Math.round(Math.min(...vals)),hi=Math.round(Math.max(...vals));return<span style={{fontSize:14,background:"rgba(150,130,180,0.15)",border:"1px dashed rgba(150,130,180,0.4)",borderRadius:12,padding:"2px 8px",marginLeft:8,color:"#b8a8d0"}} title="NOAA National Water Model — not an official NWS forecast, and not calibrated to a local gauge">📅 5-day: {lo===hi?`${lo}`:`${lo}–${hi}`} cfs (modeled)</span>})()}
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:2}}>
            {moveSavedGauge&&<>
              <button onClick={e=>{e.stopPropagation();moveSavedGauge(g.id,-1);}} disabled={i===0}
                style={{background:"none",border:"none",color:i===0?"rgba(255,255,255,0.15)":"var(--stone)",cursor:i===0?"default":"pointer",fontSize:16,padding:4,lineHeight:1}}>↑</button>
              <button onClick={e=>{e.stopPropagation();moveSavedGauge(g.id,1);}} disabled={i===sgData.length-1}
                style={{background:"none",border:"none",color:i===sgData.length-1?"rgba(255,255,255,0.15)":"var(--stone)",cursor:i===sgData.length-1?"default":"pointer",fontSize:16,padding:4,lineHeight:1,marginRight:4}}>↓</button>
            </>}
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

// Loads an image via fetch()+createImageBitmap (falls back to a data-URL <img> on
// older browsers) instead of an <img crossOrigin> tag. Drawing a blob: URL source is
// always same-origin, so the canvas never taints even if the photo's storage host
// doesn't send CORS headers for direct <img> loads. Module-level (not just inside App)
// so both the share-card builder and the photo crop tool can reuse it.
async function loadImageSource(url){
  const resp=await fetch(url);
  if(!resp.ok) throw new Error("image fetch failed");
  const blob=await resp.blob();
  if(window.createImageBitmap){
    try{ return await createImageBitmap(blob); }catch(e){ void 0; }
  }
  const dataUrl=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(blob);});
  return await new Promise((res,rej)=>{const im=new Image();im.onload=()=>res(im);im.onerror=rej;im.src=dataUrl;});
}

// ── Photo Crop Modal ────────────────────────────────────────────────────────
// iPhone-style pinch/pan crop: a fixed-aspect-ratio viewport the photo is zoomed and
// repositioned within (not a free-form resizable crop box — that's a bigger feature;
// this covers "reframe so the fish shows up better", which is what was reported).
// Portal-rendered straight to document.body (same stacking-context fix as the Settings
// dropdown / TripPlannerLoading) so it always renders above any card/lightbox it was
// opened from, regardless of that ancestor's own z-index. zIndex:10050 clears the video
// modal's 10000/10001 and the lightbox's 9999, since crop can be opened from either.
const CROP_RATIOS=[
  {key:"3:2",label:"Card",w:3,h:2},
  {key:"1:1",label:"Square",w:1,h:1},
  {key:"orig",label:"Original",w:null,h:null},
];
// The full catch card — photo, species/length/time header, condition chips, and
// Edit/Share/Delete actions with inline edit fields covering every field on a catch.
// Extracted from the standalone Catch Log list (was inline there) so the trip detail
// modal's "tap a photo" flow can show the exact same, already-proven card instead of
// duplicating it — one place to fix if the card ever needs to change.
// ── Sample catch log (signed-out visitors only) ────────────────────────────────
// Guests can open the Catch Log tab and see what a populated log actually looks like,
// rather than hitting a signup wall with nothing behind it. Real logging genuinely
// requires an account — every catch row is keyed to user_id and photos live in
// Supabase Storage behind auth — so this is a read-only demo, never a writable
// local log that could silently lose someone's real data.
//
// Deliberately reuses the real <CatchCard> rather than a mock: what a visitor sees here
// is pixel-identical to what they get after signing up, and it can't drift out of sync
// when CatchCard changes. Every interactive control (edit/share/delete/photo) routes to
// the signup prompt through gate().
//
// Photos are Adam's own catches, served from public/. They were re-encoded with ALL
// EXIF stripped before being committed — the originals carried GPS coordinates for
// every fish, and public/ is served openly, so shipping them as-is would have published
// his actual spots and contradicted the app's own "spots stay private" promise. Any
// future photo added here must be stripped the same way.
//
// FISHING ACCURACY: species are read from the photos (2 rainbow, 2 brown) but the fly,
// flow, and stream pairings are Claude's plausible fill-ins, NOT verified by Adam.
// Worth a read-through — this is public-facing credibility content.
const SAMPLE_CATCHES = [
  {
    id:"sample-1", species:"Rainbow Trout", length:"18", time:"Jun 27, 2026 · 12:54 PM",
    flies:["Pat's Rubber Legs #8","Pheasant Tail Nymph #16"],
    photo:"/sample-rainbow-1.jpg", gps:null,
    notes:"Held in the soft water behind a mid-river boulder. Ate the dropper on the second drift.",
    streamGaugeName:"Arkansas River Nathrop", streamCFS:"720", waterTemp:"54",
    airTemp:"68", weatherDesc:"Partly cloudy", windSpeed:"7", windDir:"W",
  },
  {
    id:"sample-2", species:"Brown Trout", length:"16", time:"Aug 1, 2026 · 10:02 AM",
    flies:["Elk Hair Caddis #14","Copper John #16"],
    photo:"/sample-brown-1.jpg", gps:null,
    notes:"Sipping in the tailout. Switched to a dry-dropper and it ate the caddis outright.",
    streamGaugeName:"South Boulder Creek Below Gross", streamCFS:"64", waterTemp:"52",
    airTemp:"73", weatherDesc:"Clear", windSpeed:"4", windDir:"SW",
  },
  {
    id:"sample-3", species:"Rainbow Trout", length:"15", time:"Apr 28, 2026 · 3:31 PM",
    flies:["San Juan Worm #14","Zebra Midge #20"],
    photo:"/sample-rainbow-2.jpg", gps:null,
    notes:"Cold, off-color water. Slowed everything down and got it deep along the bank seam.",
    streamGaugeName:"Big Thompson River Estes", streamCFS:"118", waterTemp:"44",
    airTemp:"49", weatherDesc:"Partly cloudy", windSpeed:"12", windDir:"NW",
  },
  {
    id:"sample-4", species:"Brown Trout", length:"11", time:"Aug 1, 2026 · 11:30 AM",
    flies:["Parachute Adams #16"],
    photo:"/sample-brown-2.jpg", gps:null,
    notes:"Skinny clear water — one shot per pocket. Long leader and a soft landing did it.",
    streamGaugeName:"North St. Vrain Creek", streamCFS:"38", waterTemp:"51",
    airTemp:"75", weatherDesc:"Clear", windSpeed:"3", windDir:"S",
  },
];
function SampleCatchLog({onSignUp}){
  // Swallows whatever args a CatchCard setter would normally pass (including updater
  // functions) so the prompt is never called with a React state updater as its reason.
  const gate=()=>{ onSignUp&&onSignUp("Create a free account to start your own catch log."); };
  return (
    <>
      <div className="card" style={{border:"1px solid rgba(209,154,74,0.35)",background:"rgba(209,154,74,0.07)"}}>
        <div className="ctitle">👀 Sample Log — Not Your Data</div>
        <div className="csub" style={{marginBottom:12}}>
          This is what your catch log looks like once you start logging. Every catch
          automatically captures flow, water temp, weather, and wind at the moment you
          record it — so patterns show up over a season.
        </div>
        <button onClick={gate}
          style={{width:"100%",background:"var(--gold)",color:"#0d1f26",border:"none",borderRadius:24,padding:"12px 20px",fontSize:15.5,fontFamily:"var(--font-head)",fontWeight:600,letterSpacing:0.5,cursor:"pointer"}}>
          Start My Own Log — Free
        </button>
      </div>
      {SAMPLE_CATCHES.map(c=>(
        <CatchCard key={c.id} c={c}
          editingCatchId={null} setEditingCatchId={gate}
          sharingCatchId={null} setSharingCatchId={gate}
          sharingBusy={false} shareCatch={gate} deleteCatch={gate} updateCatch={gate}
          editCatchFlyInput="" setEditCatchFlyInput={gate}
          setLightboxPhoto={gate} setLightboxCatchId={gate} setCropCatchId={gate}/>
      ))}
      <div className="card" style={{textAlign:"center"}}>
        <div style={{fontSize:15,color:"var(--foam)",marginBottom:6}}>🎣 Your log, your patterns</div>
        <div style={{fontSize:14,color:"var(--stone)",lineHeight:1.5,marginBottom:14}}>
          A free account saves your catches, photos, and trips — and the conditions
          behind each one.
        </div>
        <button onClick={gate}
          style={{width:"100%",background:"var(--gold)",color:"#0d1f26",border:"none",borderRadius:24,padding:"12px 20px",fontSize:15.5,fontFamily:"var(--font-head)",fontWeight:600,letterSpacing:0.5,cursor:"pointer"}}>
          Create Free Account
        </button>
      </div>
    </>
  );
}
function CatchCard({c,editingCatchId,setEditingCatchId,sharingCatchId,setSharingCatchId,sharingBusy,shareCatch,deleteCatch,updateCatch,editCatchFlyInput,setEditCatchFlyInput,setLightboxPhoto,setLightboxCatchId,setCropCatchId}){
  return (
    <div className="cc">
      {c.photo?(
        <div style={{position:"relative"}}>
          <img src={c.photo} className="c-img" alt="catch" loading="lazy" style={{cursor:"pointer"}} onClick={e=>{e.stopPropagation();setLightboxPhoto(c.photo);setLightboxCatchId(c.id);}}/>
          <button onClick={e=>{e.stopPropagation();setCropCatchId(c.id);}}
            style={{position:"absolute",top:8,right:8,width:32,height:32,borderRadius:"50%",background:"rgba(13,31,38,0.75)",border:"1px solid rgba(255,255,255,0.3)",color:"var(--foam)",fontSize:15,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}
            aria-label="Crop photo" title="Crop photo">✂️</button>
        </div>
      ):<div className="c-ph">🐟</div>}
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
            {c.streamCFS&&<span style={{fontSize:14,background:"rgba(44,95,110,0.3)",border:"1px solid rgba(44,95,110,0.5)",borderRadius:20,padding:"2px 8px",color:"var(--sky)"}}>{c.streamCFS} CFS</span>}
            {c.airTemp&&<span style={{fontSize:14,background:"rgba(255,255,255,0.06)",borderRadius:20,padding:"2px 8px",color:"var(--stone)"}}>🌡 {c.airTemp}°F</span>}
            {c.weatherDesc&&<span style={{fontSize:14,background:"rgba(255,255,255,0.06)",borderRadius:20,padding:"2px 8px",color:"var(--stone)"}}>{c.weatherDesc}</span>}
            {c.windSpeed&&<span style={{fontSize:14,background:"rgba(255,255,255,0.06)",borderRadius:20,padding:"2px 8px",color:"var(--stone)"}}>💨 {c.windSpeed}mph {c.windDir||""}</span>}
          </div>
        )}
        <div style={{display:"flex",gap:8,marginTop:8}}>
          <button onClick={e=>{e.stopPropagation();setEditingCatchId(prev=>prev===c.id?null:c.id);}}
            style={{flex:1,background:"rgba(209,154,74,0.2)",border:"1px solid rgba(209,154,74,0.5)",borderRadius:8,padding:"8px",color:"var(--gold)",fontSize:15,cursor:"pointer",fontFamily:"var(--font-body)"}}>
            ✏️ Edit
          </button>
          <button onClick={e=>{e.stopPropagation();setSharingCatchId(prev=>prev===c.id?null:c.id);}}
            style={{flex:1,background:"rgba(44,95,110,0.3)",border:"1px solid rgba(44,95,110,0.5)",borderRadius:8,padding:"8px",color:"var(--sky)",fontSize:15,cursor:"pointer",fontFamily:"var(--font-body)"}}>
            📤 Share
          </button>
          <button onClick={e=>{e.stopPropagation();if(window.confirm(`Delete this ${c.species}? This cannot be undone.`)){deleteCatch(c.id);}}}
            style={{flex:1,background:"rgba(150,80,80,0.3)",border:"1px solid rgba(150,80,80,0.4)",borderRadius:8,padding:"8px",color:"var(--red)",fontSize:15,cursor:"pointer",fontFamily:"var(--font-body)"}}>
            🗑 Delete
          </button>
        </div>
        {sharingCatchId===c.id&&(
          <div style={{marginTop:8,background:"rgba(0,0,0,0.3)",borderRadius:12,padding:"14px"}} onClick={e=>e.stopPropagation()}>
            <div style={{fontSize:14,color:"var(--gold)",letterSpacing:1,textTransform:"uppercase",marginBottom:10}}>Share to social</div>
            <div style={{display:"flex",gap:8}}>
              <button disabled={sharingBusy} onClick={()=>shareCatch(c,"minimal")}
                style={{flex:1,background:"rgba(209,154,74,0.15)",border:"1px solid rgba(209,154,74,0.4)",borderRadius:8,padding:"10px 6px",color:"var(--gold)",fontSize:14,cursor:sharingBusy?"default":"pointer",fontFamily:"var(--font-body)",opacity:sharingBusy?0.6:1}}>
                🖼 Minimal
              </button>
              <button disabled={sharingBusy} onClick={()=>shareCatch(c,"stat")}
                style={{flex:1,background:"rgba(209,154,74,0.15)",border:"1px solid rgba(209,154,74,0.4)",borderRadius:8,padding:"10px 6px",color:"var(--gold)",fontSize:14,cursor:sharingBusy?"default":"pointer",fontFamily:"var(--font-body)",opacity:sharingBusy?0.6:1}}>
                📋 Stat Card
              </button>
            </div>
            {sharingBusy&&<div style={{fontSize:13,color:"var(--stone)",marginTop:8,textAlign:"center"}}>Building image…</div>}
          </div>
        )}
        {editingCatchId===c.id&&(
          <div style={{marginTop:8,background:"rgba(0,0,0,0.3)",borderRadius:12,padding:"14px"}} onClick={e=>e.stopPropagation()}>
            <div style={{fontSize:14,color:"var(--gold)",letterSpacing:1,textTransform:"uppercase",marginBottom:10}}>Edit Catch Details</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
              <div>
                <div style={{fontSize:14,color:"var(--stone)",marginBottom:3}}>Species</div>
                <SpeciesInput value={c.species||""} inputStyle={{marginBottom:0}}
                  onChange={val=>updateCatch(c.id,{species:val})}/>
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
              <div style={{fontSize:14,color:"var(--stone)",marginBottom:3}}>Flies Used</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:4}}>
                {(c.flies||[]).map((f,i)=>(
                  <span key={i} style={{fontSize:14,background:"rgba(209,154,74,0.15)",border:"1px solid rgba(209,154,74,0.4)",borderRadius:20,padding:"2px 8px",color:"var(--gold)",display:"flex",alignItems:"center",gap:4}}>
                    🪶 {f}
                    <button onClick={e=>{e.stopPropagation();const next=(c.flies||[]).filter((_,j)=>j!==i);updateCatch(c.id,{flies:next});}} style={{background:"none",border:"none",color:"var(--stone)",cursor:"pointer",padding:"0 2px",fontSize:13,lineHeight:1}}>×</button>
                  </span>
                ))}
              </div>
              <div style={{display:"flex",gap:6}}>
                <input className="inp" style={{marginBottom:0,fontSize:15,flex:1}} placeholder="e.g. Elk Hair Caddis #14"
                  value={editCatchFlyInput}
                  onChange={e=>setEditCatchFlyInput(e.target.value)}
                  onKeyDown={e=>{if(e.key==="Enter"&&editCatchFlyInput.trim()){updateCatch(c.id,{flies:[...(c.flies||[]),editCatchFlyInput.trim()]});setEditCatchFlyInput("");}}}/>  
                <button className="btn" style={{marginBottom:0,padding:"0 14px",fontSize:14}} onClick={e=>{e.stopPropagation();if(editCatchFlyInput.trim()){updateCatch(c.id,{flies:[...(c.flies||[]),editCatchFlyInput.trim()]});setEditCatchFlyInput("");}}}>Add</button>
              </div>
            </div>
            <div style={{marginBottom:8}}>
              <div style={{fontSize:14,color:"var(--stone)",marginBottom:3}}>Stream Gauge</div>
              <input className="inp" style={{marginBottom:0,fontSize:15}} value={c.streamGaugeName||""} onChange={e=>updateCatch(c.id,{streamGaugeName:e.target.value})}/>
            </div>
            <div style={{marginBottom:8}}>
              <div style={{fontSize:14,color:"var(--stone)",marginBottom:3}}>Stream CFS</div>
              <input className="inp" style={{marginBottom:0,fontSize:15}} type="number" value={c.streamCFS||""} onChange={e=>updateCatch(c.id,{streamCFS:e.target.value})}/>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Full trip detail for a personal "Log a Trip" entry — the Guide CRM has had this
// (conditions summary + linked catch photos) since GuideBook's tripDetail view; personal
// trips never got the equivalent, so trip cards were summary-only with no way back in
// to see photos. Portaled to document.body like PhotoCropModal below, at a z-index that
// sits below the planner takeover (5000) and photo lightbox (9999) since a photo tapped
// in here opens on top of this via the existing window._setLightbox lightbox.
function PersonalTripDetailModal({trip,catches,tier,onClose,onGenerateIntel,intelLoading,intelError,catchCardProps,onSaveTrip,tripSaving,tripSaveError,onAdjustExtraCatches}){
  const tripCatches=catches.filter(c=>c.tripId===trip.id);
  const extraCatches=trip.extraCatches||0;
  const totalCatches=tripCatches.length+extraCatches;
  const isPro=PLAN_TIERS.has(tier);
  const [expandedCatchId,setExpandedCatchId]=useState(null);
  const [tripEditOpen,setTripEditOpen]=useState(false);
  const [editForm,setEditForm]=useState(null);
  return createPortal(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(8,20,25,0.97)",zIndex:4200,overflowY:"auto",padding:"20px 16px 48px"}}>
      <div style={{maxWidth:520,margin:"0 auto"}}>
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
          <button className="back" onClick={onClose}>← Back</button>
          <span style={{fontFamily:"var(--font-head)",fontSize:18,color:"var(--foam)",fontStyle:"italic"}}>
            {new Date((trip.date||new Date().toISOString().split("T")[0])+"T12:00:00").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric",year:"numeric"})}
          </span>
        </div>
        <div className="card">
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div className="ctitle" style={{marginBottom:0}}>📋 Trip Summary</div>
            {!tripEditOpen&&<button onClick={()=>{setEditForm({location:trip.location||"",techniques:trip.techniques||[],notes:trip.notes||"",airTemp:trip.airTemp||"",waterTemp:trip.waterTemp||"",weatherConditions:trip.weatherDesc||"",windSpeed:trip.windSpeed||"",windDir:trip.windDir||"",pressure:trip.pressure||"",pressureTrend:trip.pressureTrend||"",streamCFS:trip.streamCFS||"",streamCondition:trip.streamCondition||"",streamGaugeName:trip.streamGaugeName||"",date:trip.date});setTripEditOpen(true);}}
              style={{background:"none",border:"1px solid rgba(209,154,74,0.4)",borderRadius:20,padding:"4px 12px",color:"var(--gold)",fontSize:13,cursor:"pointer",fontFamily:"var(--font-body)"}}>✏️ Edit</button>}
          </div>
          {tripEditOpen?(
            <div style={{marginTop:12}}>
              <div style={{fontSize:14,color:"var(--stone)",marginBottom:3}}>Location</div>
              <TripLocationWeather tripForm={editForm} setTripForm={setEditForm}/>
              <div style={{fontSize:14,color:"var(--stone)",marginTop:2,marginBottom:6}}>Technique(s)</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:12}}>
                {FISHING_STYLES.map(s=>(
                  <button key={s} onClick={()=>setEditForm(f=>({...f,techniques:f.techniques.includes(s)?f.techniques.filter(x=>x!==s):[...f.techniques,s]}))}
                    style={{fontSize:14,padding:"5px 12px",borderRadius:20,border:"1px solid rgba(209,154,74,0.3)",background:editForm.techniques.includes(s)?"rgba(209,154,74,0.25)":"rgba(255,255,255,0.05)",color:editForm.techniques.includes(s)?"var(--gold)":"var(--stone)",cursor:"pointer"}}>{s}</button>
                ))}
              </div>
              <div style={{fontSize:14,color:"var(--stone)",marginBottom:3}}>Notes</div>
              <textarea className="inp" rows={3} style={{resize:"none",marginBottom:14}}
                value={editForm.notes} onChange={e=>setEditForm(f=>({...f,notes:e.target.value}))}/>
              {tripSaveError&&<div style={{fontSize:14,color:"var(--red)",marginBottom:10}}>{tripSaveError}</div>}
              <div style={{display:"flex",gap:8}}>
                <button disabled={tripSaving} onClick={async()=>{const ok=await onSaveTrip(trip.id,editForm);if(ok)setTripEditOpen(false);}}
                  className="btn btnp" style={{flex:1,marginBottom:0,opacity:tripSaving?0.6:1}}>{tripSaving?"Saving…":"Save Changes"}</button>
                <button disabled={tripSaving} onClick={()=>{setTripEditOpen(false);setTripSaveError(null);}}
                  style={{flex:1,background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:10,color:"var(--stone)",fontSize:15,cursor:"pointer",fontFamily:"var(--font-body)"}}>Cancel</button>
              </div>
            </div>
          ):(
            <>
          {trip.location&&<div className="hr"><span className="hn">Location</span><span className="ha">{trip.location}</span></div>}
          <div className="hr" style={{alignItems:"center"}}>
            <span className="hn">Catches</span>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <span className="ha">
                {trip.skunked&&totalCatches===0?"Skunked":`${totalCatches} fish${extraCatches>0?` (${tripCatches.length} w/ photo)`:""}`}
              </span>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <button onClick={()=>onAdjustExtraCatches(trip.id,-1)} disabled={extraCatches===0}
                  style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:"50%",width:24,height:24,color:"var(--foam)",fontSize:15,cursor:extraCatches===0?"default":"pointer",opacity:extraCatches===0?0.4:1,lineHeight:1,padding:0}}
                  title="Remove one manually-added fish">−</button>
                <button onClick={()=>onAdjustExtraCatches(trip.id,1)}
                  style={{background:"rgba(209,154,74,0.15)",border:"1px solid rgba(209,154,74,0.4)",borderRadius:"50%",width:24,height:24,color:"var(--gold)",fontSize:15,cursor:"pointer",lineHeight:1,padding:0}}
                  title="Add a fish you didn't photograph">+</button>
              </div>
            </div>
          </div>
          {trip.techniques?.length>0&&<div className="hr"><span className="hn">Techniques</span><span className="ha">{trip.techniques.join(", ")}</span></div>}
          {(trip.airTemp||trip.waterTemp||trip.weatherDesc||trip.streamCFS)&&(
            <div style={{marginTop:10,marginBottom:4}}>
              <div className="lbl" style={{marginBottom:6}}>Conditions on the Water</div>
              {trip.streamGaugeName&&<div style={{fontSize:15,color:"var(--gold)",marginBottom:6,fontStyle:"italic"}}>🏞 {trip.streamGaugeName}</div>}
              <div style={{display:"flex",gap:10,flexWrap:"wrap",fontSize:15,color:"var(--sky)"}}>
                {trip.streamCFS&&<span>💧 {Number(trip.streamCFS).toLocaleString()} CFS</span>}
                {trip.waterTemp&&<span>🌡 Water: {trip.waterTemp}°F</span>}
                {trip.weatherDesc&&<span>{trip.weatherDesc}</span>}
                {trip.airTemp&&<span>🌡 Air: {trip.airTemp}°F</span>}
                {trip.windSpeed&&<span>💨 {trip.windSpeed} mph {trip.windDir}</span>}
              </div>
            </div>
          )}
          {trip.notes&&(
            <div style={{marginTop:12,padding:"10px 12px",background:"rgba(0,0,0,0.2)",borderRadius:10,borderLeft:"3px solid var(--water)"}}>
              <div className="lbl" style={{marginBottom:4}}>Notes</div>
              <p style={{fontSize:15,color:"var(--sky)",lineHeight:1.6,fontStyle:"italic"}}>{trip.notes}</p>
            </div>
          )}
            </>
          )}
          {isPro?(
            <div style={{marginTop:12,padding:"10px 12px",background:"rgba(209,154,74,0.08)",borderRadius:10,borderLeft:"3px solid var(--gold)"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:trip.aiIntel?6:0}}>
                <div className="lbl" style={{marginBottom:0}}>🎣 My Intel</div>
                <button disabled={intelLoading} onClick={()=>onGenerateIntel(trip)}
                  style={{background:"none",border:"1px solid rgba(209,154,74,0.4)",borderRadius:20,padding:"4px 12px",color:"var(--gold)",fontSize:13,cursor:intelLoading?"default":"pointer",opacity:intelLoading?0.6:1,fontFamily:"var(--font-body)",whiteSpace:"nowrap"}}>
                  {intelLoading?"Reading trips…":trip.aiIntel?"↻ Regenerate":"Get My Intel"}
                </button>
              </div>
              {intelError&&<div style={{fontSize:14,color:"var(--red)",marginTop:6}}>{intelError}</div>}
              {trip.aiIntel?(
                <>
                  <p style={{fontSize:15,color:"var(--sky)",lineHeight:1.6,whiteSpace:"pre-wrap"}}>{trip.aiIntel}</p>
                  {trip.aiIntelGeneratedAt&&<div style={{fontSize:13,color:"var(--stone)",marginTop:4}}>Generated {new Date(trip.aiIntelGeneratedAt).toLocaleDateString("en-US",{month:"short",day:"numeric"})}</div>}
                </>
              ):(!intelLoading&&<p style={{fontSize:14,color:"var(--stone)",fontStyle:"italic",marginTop:6}}>Tap "Get My Intel" for a guide-style read on what's working across your logged trips.</p>)}
            </div>
          ):(
            <div style={{marginTop:12,padding:"14px",background:"rgba(0,0,0,0.2)",borderRadius:10,textAlign:"center"}}>
              <div style={{fontSize:15,color:"var(--foam)",marginBottom:4}}>🔒 My Intel is a {TIER_INFO.consumer_pro.name} feature</div>
              <div style={{fontSize:14,color:"var(--stone)",marginBottom:10}}>Guide-style feedback on what's working, grounded in your own logged trips.</div>
              <button onClick={()=>startCheckout("consumer_pro","monthly")} style={{background:"var(--gold)",border:"none",borderRadius:8,padding:"8px 18px",color:"#0c1e25",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"var(--font-body)"}}>Upgrade — {TIER_INFO.consumer_pro.price}</button>
            </div>
          )}
        </div>
        {tripCatches.length>0&&(
          <div style={{marginTop:14}}>
            {expandedCatchId?(()=>{
              const ec=tripCatches.find(c=>c.id===expandedCatchId);
              if(!ec){ setExpandedCatchId(null); return null; }
              return (
                <>
                  <button onClick={()=>setExpandedCatchId(null)} style={{background:"none",border:"none",color:"var(--gold)",fontSize:15,cursor:"pointer",padding:0,marginBottom:8,fontFamily:"var(--font-body)"}}>← All catches</button>
                  <CatchCard c={ec} {...catchCardProps}/>
                </>
              );
            })():(
              <>
                <div className="lbl" style={{marginBottom:8}}>Catches from this trip</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                  {tripCatches.map(c=>(
                    <div key={c.id} style={{cursor:"pointer"}} onClick={()=>setExpandedCatchId(c.id)}>
                      {c.photo?(
                        <div style={{position:"relative",aspectRatio:"1",overflow:"hidden",borderRadius:8}}>
                          <img src={toThumbUrl(c.photo)} alt={c.species||"catch"} loading="lazy" style={{width:"100%",height:"100%",objectFit:"cover"}} onError={e=>{e.target.onerror=null;e.target.src=c.photo;}}/>
                        </div>
                      ):(
                        <div style={{position:"relative",aspectRatio:"1",borderRadius:8,background:"rgba(0,0,0,0.25)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24}}>🐟</div>
                      )}
                      <div style={{fontSize:12,color:"var(--stone)",marginTop:2,textAlign:"center"}}>{c.species}{c.length?` · ${c.length}"`:""}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function PhotoCropModal({photoUrl,onSave,onCancel}){
  const [ratioKey,setRatioKey]=useState("3:2");
  const [natSize,setNatSize]=useState(null);
  const [zoom,setZoom]=useState(1);
  const [offset,setOffset]=useState({x:0,y:0});
  const [frameSize,setFrameSize]=useState({w:320,h:213});
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState(null);
  const [dragging,setDragging]=useState(false);
  const pointers=useRef(new Map());
  const gestureRef=useRef(null);

  const ratio=CROP_RATIOS.find(r=>r.key===ratioKey)||CROP_RATIOS[0];

  useEffect(()=>{
    function computeFrame(){
      const maxW=Math.min(window.innerWidth*0.92,440);
      const maxH=window.innerHeight*0.5;
      let rw=ratio.w,rh=ratio.h;
      if(!rw){ if(natSize){rw=natSize.w;rh=natSize.h;} else {rw=1;rh=1;} }
      let w=maxW,h=w*(rh/rw);
      if(h>maxH){ h=maxH; w=h*(rw/rh); }
      setFrameSize({w:Math.round(w),h:Math.round(h)});
    }
    computeFrame();
    window.addEventListener("resize",computeFrame);
    return()=>window.removeEventListener("resize",computeFrame);
  },[ratioKey,natSize]);

  useEffect(()=>{ setZoom(1); setOffset({x:0,y:0}); },[ratioKey,photoUrl]);

  function onImgLoad(e){
    setNatSize({w:e.target.naturalWidth,h:e.target.naturalHeight});
  }

  const baseScale=natSize?Math.max(frameSize.w/natSize.w,frameSize.h/natSize.h):1;
  const scale=baseScale*zoom;
  const dispW=natSize?natSize.w*scale:frameSize.w;
  const dispH=natSize?natSize.h*scale:frameSize.h;
  const maxOffX=Math.max(0,(dispW-frameSize.w)/2);
  const maxOffY=Math.max(0,(dispH-frameSize.h)/2);

  function clamp(o,mx,my){ return {x:Math.max(-mx,Math.min(mx,o.x)),y:Math.max(-my,Math.min(my,o.y))}; }
  function dist(a,b){ return Math.hypot(a.x-b.x,a.y-b.y); }

  function onPointerDown(e){
    e.preventDefault();
    try{e.currentTarget.setPointerCapture(e.pointerId);}catch{}
    pointers.current.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pointers.current.size===1){
      gestureRef.current={mode:"pan",startPt:{x:e.clientX,y:e.clientY},startOffset:offset};
    } else if(pointers.current.size>=2){
      const pts=[...pointers.current.values()];
      gestureRef.current={mode:"pinch",startDist:dist(pts[0],pts[1])||1,startZoom:zoom,startOffset:offset};
    }
    setDragging(true);
  }
  function onPointerMove(e){
    if(!pointers.current.has(e.pointerId))return;
    e.preventDefault();
    pointers.current.set(e.pointerId,{x:e.clientX,y:e.clientY});
    const g=gestureRef.current;
    if(!g)return;
    if(g.mode==="pan"){
      const dx=e.clientX-g.startPt.x, dy=e.clientY-g.startPt.y;
      setOffset(clamp({x:g.startOffset.x+dx,y:g.startOffset.y+dy},maxOffX,maxOffY));
    } else if(g.mode==="pinch"&&pointers.current.size>=2){
      const pts=[...pointers.current.values()];
      const d=dist(pts[0],pts[1])||1;
      const newZoom=Math.max(0.5,Math.min(4,g.startZoom*(d/g.startDist)));
      setZoom(newZoom);
      setOffset(o=>clamp(o,maxOffX,maxOffY));
    }
  }
  function onPointerUp(e){
    pointers.current.delete(e.pointerId);
    if(pointers.current.size===0){ gestureRef.current=null; setDragging(false); }
    else {
      const [pt]=[...pointers.current.values()];
      gestureRef.current={mode:"pan",startPt:pt,startOffset:offset};
    }
  }
  function nudgeZoom(delta){
    setZoom(z=>Math.max(0.5,Math.min(4,z+delta)));
    setOffset(o=>clamp(o,maxOffX,maxOffY));
  }

  async function handleUse(){
    if(!natSize){ setError("Photo still loading — try again in a second."); return; }
    setSaving(true); setError(null);
    try{
      const outMaxDim=1600;
      const source=await loadImageSource(photoUrl);
      const canvas=document.createElement("canvas");
      const ctx=canvas.getContext("2d");
      if(zoom>=1){
        // Normal crop — photo fully covers the frame. Unchanged from before: crop a
        // source rectangle 1:1 into the output, capped at outMaxDim so we never upscale
        // past the source photo's own resolution.
        const cropW=frameSize.w/scale, cropH=frameSize.h/scale;
        let cropX=natSize.w/2 - cropW/2 - offset.x/scale;
        let cropY=natSize.h/2 - cropH/2 - offset.y/scale;
        cropX=Math.max(0,Math.min(natSize.w-cropW,cropX));
        cropY=Math.max(0,Math.min(natSize.h-cropH,cropY));
        const outScale=Math.min(1,outMaxDim/Math.max(cropW,cropH));
        const outW=Math.max(1,Math.round(cropW*outScale)), outH=Math.max(1,Math.round(cropH*outScale));
        canvas.width=outW;canvas.height=outH;
        ctx.drawImage(source,cropX,cropY,cropW,cropH,0,0,outW,outH);
      } else {
        // Zoomed out past "fill the frame" — the photo no longer covers every edge, so
        // pad around it with black (matching the crop tool's own frame background,
        // so the export matches exactly what was previewed) instead of cropping.
        // Output canvas mirrors the frame's aspect ratio, scaled up to outMaxDim on
        // the long side (capped at 4x so a tiny on-screen frame doesn't blow up huge).
        const frameLong=Math.max(frameSize.w,frameSize.h);
        const outFrameScale=Math.min(outMaxDim/frameLong,4);
        const outW=Math.max(1,Math.round(frameSize.w*outFrameScale)), outH=Math.max(1,Math.round(frameSize.h*outFrameScale));
        canvas.width=outW;canvas.height=outH;
        ctx.fillStyle="#000";
        ctx.fillRect(0,0,outW,outH);
        const drawW=natSize.w*scale*outFrameScale, drawH=natSize.h*scale*outFrameScale;
        const drawX=outW/2-drawW/2+offset.x*outFrameScale, drawY=outH/2-drawH/2+offset.y*outFrameScale;
        ctx.drawImage(source,drawX,drawY,drawW,drawH);
      }
      const dataUrl=canvas.toDataURL("image/jpeg",0.9);
      await onSave(dataUrl);
    }catch(e){
      setError("Couldn't process that crop — try again.");
      setSaving(false);
      return;
    }
    setSaving(false);
  }

  return createPortal(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(8,20,25,0.97)",zIndex:10050,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"20px 16px",touchAction:"none"}}>
      <div style={{width:"100%",maxWidth:480,display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <button onClick={onCancel} disabled={saving} style={{background:"none",border:"none",color:"var(--stone)",fontSize:16,cursor:saving?"default":"pointer",fontFamily:"var(--font-body)",padding:"8px 4px"}}>Cancel</button>
        <div style={{fontFamily:"var(--font-head)",fontSize:16,color:"var(--foam)",letterSpacing:0.5}}>Crop Photo</div>
        <button onClick={handleUse} disabled={saving||!natSize} style={{background:"none",border:"none",color:"var(--gold)",fontSize:16,fontWeight:600,cursor:(saving||!natSize)?"default":"pointer",fontFamily:"var(--font-body)",padding:"8px 4px",opacity:(saving||!natSize)?0.5:1}}>{saving?"Saving…":"Use Photo"}</button>
      </div>

      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{position:"relative",width:frameSize.w,height:frameSize.h,overflow:"hidden",borderRadius:12,background:"#000",cursor:dragging?"grabbing":"grab",touchAction:"none",border:"1px solid rgba(209,154,74,0.4)"}}>
        <img src={photoUrl} onLoad={onImgLoad} alt="Crop preview" draggable={false}
          style={{position:"absolute",left:"50%",top:"50%",width:natSize?natSize.w*scale:"auto",height:natSize?natSize.h*scale:"auto",maxWidth:"none",
            transform:`translate(-50%,-50%) translate(${offset.x}px,${offset.y}px)`,userSelect:"none",pointerEvents:"none"}}/>
        {dragging&&(
          <div style={{position:"absolute",inset:0,pointerEvents:"none"}}>
            {[1,2].map(i=><div key={"v"+i} style={{position:"absolute",top:0,bottom:0,left:`${i*100/3}%`,width:1,background:"rgba(255,255,255,0.5)"}}/>)}
            {[1,2].map(i=><div key={"h"+i} style={{position:"absolute",left:0,right:0,top:`${i*100/3}%`,height:1,background:"rgba(255,255,255,0.5)"}}/>)}
          </div>
        )}
      </div>

      <div style={{display:"flex",gap:8,marginTop:16}}>
        {CROP_RATIOS.map(r=>(
          <button key={r.key} onClick={()=>setRatioKey(r.key)} disabled={saving}
            style={{background:ratioKey===r.key?"rgba(209,154,74,0.25)":"rgba(255,255,255,0.06)",border:"1px solid "+(ratioKey===r.key?"var(--gold)":"rgba(255,255,255,0.15)"),borderRadius:20,padding:"6px 16px",color:ratioKey===r.key?"var(--gold)":"var(--stone)",fontSize:14,cursor:"pointer",fontFamily:"var(--font-body)"}}>
            {r.label}
          </button>
        ))}
      </div>

      <div style={{display:"flex",alignItems:"center",gap:12,marginTop:16,width:"100%",maxWidth:320}}>
        <button onClick={()=>nudgeZoom(-0.25)} disabled={saving} style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:"50%",width:32,height:32,color:"var(--foam)",fontSize:18,cursor:"pointer",flexShrink:0}}>−</button>
        <input type="range" min={0.5} max={4} step={0.01} value={zoom}
          onChange={e=>{const z=parseFloat(e.target.value);setZoom(z);setOffset(o=>clamp(o,maxOffX,maxOffY));}}
          style={{flex:1}}/>
        <button onClick={()=>nudgeZoom(0.25)} disabled={saving} style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:"50%",width:32,height:32,color:"var(--foam)",fontSize:18,cursor:"pointer",flexShrink:0}}>+</button>
      </div>
      <div style={{fontSize:13,color:"var(--stone)",marginTop:10,textAlign:"center"}}>Drag to reposition · Pinch or use +/− to zoom{zoom<1?" · Below 1× pads the frame in black":""}</div>
      {error&&<div style={{fontSize:14,color:"var(--red)",marginTop:10,textAlign:"center"}}>{error}</div>}
    </div>,
    document.body
  );
}

function App({user, tier, trialExpired, refreshTier, redeemInviteCode, autoRedeemNotice, setAutoRedeemNotice, tierCheckFailed, tierDebug, tierChecking, onRequestAuth}){
  // Guests (no account) always land on Intel/conditions — a stale non-conditions value
  // left in sessionStorage from a previous signed-in session on this device/browser
  // must not carry over to a signed-out visitor.
  const [tab,setTab]=useState(()=>{try{const t=sessionStorage.getItem("tl_tab")||"conditions";return (user||t==="conditions")?t:"conditions";}catch{return "conditions";}});
  useEffect(()=>{try{sessionStorage.setItem("tl_tab",tab);}catch{}},[tab]);
  // Deep link from a background-report email (?report=<id>&tab=plan): switch to the
  // Trip Planner tab and hand the id down for TripPlanner to load, same pattern as the
  // ?checkout= handling in Root above. A signed-out visitor following this link (e.g. a
  // stale/shared link, or a session that expired) is prompted to sign in instead of
  // dropping straight into the Trip Planner tab; the URL param is only consumed once a
  // real user is present, so signing in from the prompt re-triggers this and still opens
  // the report.
  const [pendingReportId,setPendingReportId]=useState(null);
  useEffect(()=>{
    const params=new URLSearchParams(window.location.search);
    const rid=params.get("report");
    if(!rid)return;
    if(!user){onRequestAuth&&onRequestAuth("Sign in to view your trip report.");return;}
    window.history.replaceState({},"",window.location.pathname);
    setTab("plan");
    setPendingReportId(rid);
  },[user]);
  const [hideGuide,setHideGuide]=useState(()=>{try{return localStorage.getItem("tl_hideguide")==="1";}catch(e){return false;}});
  const [showSettings,setShowSettings]=useState(false);
  const settingsWrapRef=useRef(null);
  const [settingsPos,setSettingsPos]=useState(null);
  const openSettings=()=>{
    if(settingsWrapRef.current){
      const r=settingsWrapRef.current.getBoundingClientRect();
      setSettingsPos({top:r.bottom+8,right:window.innerWidth-r.right});
    }
    setShowSettings(s=>!s);
  };
  const [settingsUpgradeBusy,setSettingsUpgradeBusy]=useState(null);
  const [settingsUpgradeErr,setSettingsUpgradeErr]=useState("");
  const [settingsBilling,setSettingsBilling]=useState("monthly");
  const [redeemCode,setRedeemCode]=useState("");
  const [redeemBusy,setRedeemBusy]=useState(false);
  const [redeemMsg,setRedeemMsg]=useState(null);
  async function handleRedeemCode(){
    if(!redeemCode.trim()||redeemBusy) return;
    setRedeemBusy(true); setRedeemMsg(null);
    const r=await redeemInviteCode(redeemCode);
    setRedeemBusy(false);
    if(r.ok){ setRedeemMsg({type:"ok",text:"Code applied — you're upgraded!"}); setRedeemCode(""); }
    else{
      const friendly = r.reason==="not_a_comp_code" ? "That code isn't valid."
        : r.reason==="already_paying_subscriber" ? "You already have an active paid subscription."
        : r.reason==="not_signed_in" ? "Please sign in again and retry."
        : (r.message || "Couldn't apply that code.");
      setRedeemMsg({type:"err",text:friendly});
    }
  }
  const [trialBannerDismissed,setTrialBannerDismissed]=useState(null); // stores the expiredAt it was dismissed for
  const [trialBannerBusy,setTrialBannerBusy]=useState(false);
  const [trialBannerErr,setTrialBannerErr]=useState("");
  const [tierRetryBusy,setTierRetryBusy]=useState(false);
  const [signOutBusy,setSignOutBusy]=useState(false);
  const [signOutErr,setSignOutErr]=useState("");
  const handleSignOut=async()=>{
    if(!sb||signOutBusy) return;
    setSignOutErr(""); setSignOutBusy(true);
    // sb.auth.signOut() has been observed hanging indefinitely — no error, no network
    // call ever fires — across multiple devices, browsers, and networks (2026-07-10),
    // after a day of heavy rapid auth activity (many sign-ins/outs across tabs and test
    // accounts). Most likely the Supabase client's internal auth lock getting stuck.
    // Rather than trust it to always resolve, race it against a timeout: if it doesn't
    // finish in time, wipe the local session ourselves and reload. This guarantees the
    // button can never get stuck again, regardless of the exact underlying cause.
    const TIMED_OUT = Symbol("timeout");
    try{
      const result = await Promise.race([
        sb.auth.signOut(),
        new Promise(resolve=>setTimeout(()=>resolve(TIMED_OUT), 4000))
      ]);
      if(result===TIMED_OUT){
        try{ Object.keys(localStorage).forEach(k=>{ if(k.startsWith("sb-")) localStorage.removeItem(k); }); }catch(e){}
        window.location.reload();
        return;
      }
      if(result?.error) throw result.error;
    }catch(e){
      setSignOutErr(e?.message||"Sign out failed. Check your connection and try again.");
    }finally{
      setSignOutBusy(false);
    }
  };
  useEffect(()=>{
    const onPageShow=(e)=>{ if(e.persisted) setSettingsUpgradeBusy(null); };
    window.addEventListener("pageshow",onPageShow);
    return ()=>window.removeEventListener("pageshow",onPageShow);
  },[]);
  const toggleGuide=()=>{const n=!hideGuide;setHideGuide(n);try{localStorage.setItem("tl_hideguide",n?"1":"0");}catch(e){void 0;}if(n&&tab==="guide")setTab("conditions");};
  const [addOpen,setAddOpen]=useState(false);
  const [editingCatchId,setEditingCatchId]=useState(null);
  // Personal trip tracking — a single post-hoc "Log a Trip" form, same pattern as
  // GuideBook's Add Trip (tripForm0/saveTrip/handleTripPhoto): fill in location,
  // conditions, techniques, and photos, then Save once. No start/end session — a
  // trip with zero linked catches is still saved (skunked), so later trend analysis
  // doesn't only ever see days that already worked.
  const [personalTrips,setPersonalTrips]=useState([]);
  const [personalTripsLoading,setPersonalTripsLoading]=useState(true);
  const [showLogTripForm,setShowLogTripForm]=useState(false);
  const logTripForm0={date:new Date().toISOString().split("T")[0],location:"",techniques:[],notes:"",photos:[],catchDetails:[],linkedCatchIds:[],airTemp:"",waterTemp:"",windSpeed:"",windDir:"",pressure:"",pressureTrend:"",weatherConditions:"",streamCFS:"",streamCondition:"",streamGaugeName:""};
  const [logTripForm,setLogTripForm]=useState(logTripForm0);
  const [showCatchPicker,setShowCatchPicker]=useState(false);
  const [personalTripDetail,setPersonalTripDetail]=useState(null);
  const [personalIntelLoading,setPersonalIntelLoading]=useState(false);
  const [personalIntelError,setPersonalIntelError]=useState(null);
  const [personalTripSaving,setPersonalTripSaving]=useState(false);
  const [personalTripSaveError,setPersonalTripSaveError]=useState(null);
  const [savingPersonalTrip,setSavingPersonalTrip]=useState(false);
  const logTripPhotoRef=useRef(null);
  const [sharingCatchId,setSharingCatchId]=useState(null);
  const [sharingBusy,setSharingBusy]=useState(false);
  const [editCatchFlyInput,setEditCatchFlyInput]=useState("");
  const [editingTripCatchIdx,setEditingTripCatchIdx]=useState(null);
  const [lightboxPhoto,setLightboxPhoto]=useState(null);
  const [lightboxCatchId,setLightboxCatchId]=useState(null);
  const [cropCatchId,setCropCatchId]=useState(null);
  const [mapPinCatchId,setMapPinCatchId]=useState(null);
  useEffect(()=>{
    // The catch-locations map (Catch Log tab) runs Leaflet inside a sandboxed iframe —
    // a separate document, so a marker tap can't call setState directly. It posts a
    // message instead; this is the one listener for it, mounted once for the component's
    // life. Filtered by message type so it can't be triggered by anything else on the page.
    function onMapMsg(e){
      if(e.data&&e.data.type==="gc_catch_pin_tap") setMapPinCatchId(e.data.id);
    }
    window.addEventListener("message",onMapMsg);
    return()=>window.removeEventListener("message",onMapMsg);
  },[]);
  useEffect(()=>{
    // Trip-photo viewers (Guide tab) call this with just a URL — no catch id in that
    // context, so the lightbox's crop button correctly stays hidden for those. Crop is
    // scoped to standalone Catch Log entries for now (see GUIDES_CHOICE_CONTEXT.md).
    window._setLightbox=(url)=>{ setLightboxCatchId(null); setLightboxPhoto(url); };
    return()=>{window._setLightbox=null;};
  },[]);


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
    el.innerHTML='<img src="'+lightboxPhoto+'" style="max-width:100vw;max-height:100vh;object-fit:contain;display:block;" alt="catch"/>'
      +(lightboxCatchId?'<button id="gc-lightbox-crop" style="position:fixed;top:20px;right:76px;background:rgba(255,255,255,0.2);border:none;color:white;border-radius:50%;width:44px;height:44px;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;" aria-label="Crop photo" title="Crop photo">✂️</button>':'')
      +'<button id="gc-lightbox-close" style="position:fixed;top:20px;right:20px;background:rgba(255,255,255,0.2);border:none;color:white;border-radius:50%;width:44px;height:44px;font-size:22px;cursor:pointer;display:flex;align-items:center;justify-content:center;">✕</button>';
    el.onclick=(e)=>{ setLightboxPhoto(null); setLightboxCatchId(null); };
    const cropBtn=document.getElementById("gc-lightbox-crop");
    if(cropBtn) cropBtn.onclick=(e)=>{ e.stopPropagation(); setCropCatchId(lightboxCatchId); setLightboxPhoto(null); setLightboxCatchId(null); };
    return()=>{ const el2=document.getElementById("gc-lightbox"); if(el2) el2.remove(); };
  },[lightboxPhoto,lightboxCatchId]);
  // Init loc from localStorage so Guide tab has it immediately
  const [loc,setLoc]=useState(()=>{try{const s=localStorage.getItem("tl_loc");return s?JSON.parse(s):null;}catch{return null;}});
  // Ref so handleLogTripPhoto always reads current loc, not a stale closure
  // value, during its multi-second async photo processing — same pattern GuideBook
  // uses for its own trip photo handler.
  const locRef=useRef(loc);
  useEffect(()=>{locRef.current=loc;},[loc]);
  // Guards loadConditions against overlapping invocations — see that function's own
  // comment for why this exists and what it fixes.
  const loadGenRef=useRef(0);
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

  // ── Catch field-name mapping (single source of truth) ───────────────────
  // The app's JS/state side is camelCase everywhere (matches the render code and
  // the share-card builder); the "catches" table columns are snake_case. Every
  // insert/update must convert at the DB boundary via catchDataToDbRow, and every
  // row read back from Supabase must convert via catchRowToCamel — so a freshly
  // -added catch and a reloaded one always end up in the exact same shape. Before
  // this, addCatch's own local-state update skipped that conversion and stored the
  // raw snake_case insert payload, so conditions/flow silently vanished from a
  // catch's card until the next full reload re-fetched it correctly.
  function catchRowToCamel(r){
    return {
      id:r.id,species:r.species||"",length:r.length!=null?String(r.length):"",flies:r.flies||[],photo:r.photo,
      gps:r.gps,time:r.time,notes:r.notes,airTemp:r.air_temp!=null?String(r.air_temp):"",
      weatherDesc:r.weather_desc||"",windSpeed:r.wind_speed!=null?String(r.wind_speed):"",
      windDir:r.wind_dir||"",pressure:r.pressure!=null?String(r.pressure):"",
      streamCFS:r.stream_cfs!=null?String(r.stream_cfs):"",
      streamCondition:r.stream_condition||"",streamGaugeName:r.stream_gauge_name||"",
      waterTemp:r.water_temp!=null?String(r.water_temp):"",tripId:r.trip_id||null
    };
  }
  function catchDataToDbRow(cd){
    return {
      species:cd.species,length:cd.length,flies:cd.flies,photo:cd.photo,gps:cd.gps,time:cd.time,notes:cd.notes,
      air_temp:cd.airTemp||null,weather_desc:cd.weatherDesc||null,wind_speed:cd.windSpeed||null,
      wind_dir:cd.windDir||null,pressure:cd.pressure||null,stream_cfs:cd.streamCFS||null,
      stream_condition:cd.streamCondition||null,stream_gauge_name:cd.streamGaugeName||null,water_temp:cd.waterTemp||null,
      trip_id:cd.tripId||null
    };
  }
  // catches state is insertion order, not date order — fine for most logic, but
  // batch trip-photo processing runs several photos in parallel, so whichever
  // finishes its AI ID + conditions lookup first gets inserted first, regardless of
  // the photo's actual date. The log itself should always read chronologically.
  function catchTimeMs(c){
    const d=new Date((c.time||"").replace(" at "," "));
    return isNaN(d)?0:d.getTime();
  }
  const catchesByDate=[...catches].sort((a,b)=>catchTimeMs(b)-catchTimeMs(a));

  // Load catches from Supabase on mount
  useEffect(()=>{
    if(!user) return;
    if(!sb){ setCatchesLoading(false); return; }
    sb.from("catches").select("*").eq("user_id",user.id).order("created_at",{ascending:false})
      .then(async({data,error})=>{
        if(!error&&data){
          const key=await getOrCreateKey(user.id);
          const rows=await Promise.all(data.map(async r=>{
            const gps=r.gps?.startsWith("ENC:")?await Promise.race([decryptGPS(r.gps,key),new Promise(res=>setTimeout(()=>res(r.gps),3000))]):r.gps;
            return {...catchRowToCamel(r),gps};
          }));
          setCatches(rows);window._catches=rows;
        }
        setCatchesLoading(false);
      });
  },[user]);

  function personalTripRowToCamel(r){
    return {
      id:r.id,date:r.date,startTime:r.start_time,endTime:r.end_time,
      location:r.location||"",gps:r.gps||"",techniques:r.techniques||[],skunked:!!r.skunked,
      airTemp:r.air_temp!=null?String(r.air_temp):"",waterTemp:r.water_temp!=null?String(r.water_temp):"",
      weatherDesc:r.weather_desc||"",windSpeed:r.wind_speed!=null?String(r.wind_speed):"",windDir:r.wind_dir||"",
      streamCFS:r.stream_cfs!=null?String(r.stream_cfs):"",streamCondition:r.stream_condition||"",
      streamGaugeName:r.stream_gauge_name||"",notes:r.notes||"",
      aiIntel:r.ai_intel||"",aiIntelGeneratedAt:r.ai_intel_generated_at||null,
      extraCatches:r.extra_catches!=null?r.extra_catches:0
    };
  }

  // Load personal trips from Supabase on mount, and re-attach to any trip that was
  // started but never ended (e.g. the app was closed mid-session).
  useEffect(()=>{
    if(!user) return;
    if(!sb){ setPersonalTripsLoading(false); return; }
    sb.from("personal_trips").select("*").eq("user_id",user.id).order("start_time",{ascending:false})
      .then(({data,error})=>{
        if(!error&&data) setPersonalTrips(data.map(personalTripRowToCamel));
        setPersonalTripsLoading(false);
      });
  },[user]);

  function toggleLogTripTechnique(s){
    setLogTripForm(f=>({...f,techniques:f.techniques.includes(s)?f.techniques.filter(x=>x!==s):[...f.techniques,s]}));
  }

  // Photo add for the Log Trip form — same two-phase pipeline as GuideBook's
  // handleTripPhoto (optimistic add + EXIF parse + parallel AI fish ID/conditions
  // lookup), held in local form state until Save. At Save time each becomes its own
  // catches-table row (tripId attached) rather than a JSON blob on the trip, so it's
  // editable and shareable the same way as any other catch log entry — same
  // architecture the old Add-Photos-during-trip flow used.
  async function handleLogTripPhoto(e){
    const files=Array.from(e.target.files);
    e.target.value="";
    if(!files.length) return;
    let devLocPromise=null;
    const getDeviceLoc=()=>{
      if(!devLocPromise){
        devLocPromise=(async()=>{
          const currentLoc=locRef.current;
          if(currentLoc?.lat&&currentLoc?.lng)return{lat:currentLoc.lat,lng:currentLoc.lng};
          try{
            const pos=await new Promise((res,rej)=>navigator.geolocation.getCurrentPosition(res,rej,{timeout:10000,maximumAge:60000,enableHighAccuracy:false}));
            return{lat:pos.coords.latitude,lng:pos.coords.longitude};
          }catch(ge){return null;}
        })();
      }
      return devLocPromise;
    };
    const items=[];
    for(const file of files){
      const rawUrl=await new Promise(res=>{const r=new FileReader();r.onload=ev=>res(ev.target.result);r.readAsDataURL(file);});
      const dataUrl=await new Promise(res=>{const img=new Image();img.onload=()=>{const MAX=1200;let w=img.naturalWidth,h=img.naturalHeight;if(w>MAX||h>MAX){const s=MAX/Math.max(w,h);w=Math.round(w*s);h=Math.round(h*s);}const cv=document.createElement("canvas");cv.width=w;cv.height=h;cv.getContext("2d").drawImage(img,0,0,w,h);res(cv.toDataURL("image/jpeg",0.82));};img.onerror=()=>res(rawUrl);img.src=rawUrl;});
      let photoTime=null,photoGps="",photoLat=null,photoLng=null;
      try{
        const abuf=await file.arrayBuffer();
        const exif=parseExif(abuf);
        photoTime=exif.time;photoGps=exif.gps||"";photoLat=exif.lat??null;photoLng=exif.lng??null;
      }catch(xe){void 0;}
      const tripDateFallback=logTripForm.date?new Date(logTripForm.date+"T12:00:00").toLocaleString("en-US",{month:"long",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit",hour12:true}):new Date().toLocaleString("en-US",{month:"long",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit",hour12:true});
      const t=photoTime||tripDateFallback;
      const _id="lt"+Date.now().toString(36)+Math.random().toString(36).slice(2,8);
      items.push({_id,dataUrl,t,photoGps,photoLat,photoLng});
      setLogTripForm(f=>({...f,photos:[...f.photos,dataUrl],catchDetails:[...(f.catchDetails||[]),{_id,photo:dataUrl,time:t,gps:photoGps,species:"Unidentified",length:"",analyzing:true}]}));
    }
    const updDetail=(id,patch)=>setLogTripForm(f=>({...f,catchDetails:(f.catchDetails||[]).map(d=>d._id===id?{...d,...patch}:d)}));
    await mapLimit(items,3,async(it)=>{
      try{
        const idPromise=(async()=>{
          try{
            const b64=await resizeForID(it.dataUrl,800,0.7);
            const r=await identifyFish(b64,"Look carefully at this fish. Identify species based on coloring and spot patterns. Rainbow trout have pink lateral stripe. Brown trout have red spots on golden body. Choose from: "+SPECIES.join(", ")+". Estimate length if visible. Reply ONLY with JSON: {\"species\":\"Rainbow Trout\",\"length\":14}. Use null for length if unknown.");
            if(r&&r.species&&r.species!=="Unidentified")return r;
            return{species:"Unidentified",length:""};
          }catch(ie){return{species:"Unidentified",length:""};}
        })();
        const condPromise=(async()=>{
          try{
            let fetchLat=it.photoLat,fetchLng=it.photoLng,fetchGps=it.photoGps;
            if(!fetchLat||!fetchLng){
              const dl=await getDeviceLoc();
              if(dl){fetchLat=dl.lat;fetchLng=dl.lng;fetchGps=fetchLat.toFixed(4)+"\u00b0N, "+Math.abs(fetchLng).toFixed(4)+"\u00b0W";}
            }
            if(!fetchLat||!fetchLng)return null;
            let dateStr=null,hourStr="12";
            const d2=new Date(it.t.replace(" at "," "));
            if(!isNaN(d2)){dateStr=d2.toISOString().split("T")[0];hourStr=String(d2.getHours()).padStart(2,"0");}
            const today=new Date().toISOString().split("T")[0];
            const conds=dateStr&&dateStr<today?await fetchHistoricalConditions(fetchLat,fetchLng,dateStr,hourStr):await fetchLiveNearestConditions(fetchLat,fetchLng);
            return{gps:fetchGps||"",conds};
          }catch(ce){return null;}
        })();
        const[idRes,condRes]=await Promise.all([idPromise,condPromise]);
        const patch={analyzing:false};
        if(idRes){patch.species=idRes.species;patch.length=idRes.length;}
        const c=condRes?.conds;
        if(condRes&&condRes.gps) patch.gps=condRes.gps;
        if(c){
          patch.airTemp=c.airTemp||null;patch.weatherDesc=c.weatherDesc||null;patch.windSpeed=c.windSpeed||null;
          patch.windDir=c.windDir||null;patch.pressure=c.pressure||null;patch.streamCFS=c.streamCFS||null;
          patch.streamCondition=c.streamCondition||null;patch.streamGaugeName=c.streamGaugeName||null;
        }
        updDetail(it._id,patch);
      }catch(err){void 0;}
    });
  }

  // Save the whole trip at once — insert the trip row, then attach every photo
  // added above (as new catches-table rows) and every catch picked via "From Catch
  // Log" (relinked in place). Mirrors GuideBook's saveTrip single-shot pattern.
  async function saveLogTrip(){
    if(savingPersonalTrip||!sb||!user) return;
    setSavingPersonalTrip(true);
    try{
      // Resolve GPS for the trip record: geocode the typed location if there is
      // one, otherwise fall back to device location — same "uses your current
      // location if left blank" behavior the old form had.
      let gpsStr=null;
      if(logTripForm.location.trim()){
        try{
          const g=await geocode(logTripForm.location);
          if(g.length) gpsStr=fmtCoord(parseFloat(g[0].lat),parseFloat(g[0].lon));
        }catch(ge){void 0;}
      }
      if(!gpsStr&&loc) gpsStr=fmtCoord(loc.lat,loc.lng);
      const now=new Date();
      const row={
        date:logTripForm.date||now.toISOString().split("T")[0],
        start_time:now.toISOString(),
        end_time:now.toISOString(),
        location:logTripForm.location||null,
        gps:gpsStr,
        techniques:logTripForm.techniques,
        skunked:false,
        notes:logTripForm.notes||null,
        air_temp:logTripForm.airTemp||null,
        water_temp:logTripForm.waterTemp||null,
        weather_desc:logTripForm.weatherConditions||null,
        wind_speed:logTripForm.windSpeed||null,
        wind_dir:logTripForm.windDir||null,
        stream_cfs:logTripForm.streamCFS||null,
        stream_condition:logTripForm.streamCondition||null,
        stream_gauge_name:logTripForm.streamGaugeName||null
      };
      const{data,error}=await sb.from("personal_trips").insert({user_id:user.id,...row}).select().single();
      if(error||!data){
        alert("Trip save failed: "+(error?.message||"Unknown error"));
        return;
      }
      const newTripId=data.id;
      for(const cd of (logTripForm.catchDetails||[])){
        const catchData={
          species:cd.species,length:cd.length,flies:[],photo:cd.photo,
          gps:cd.gps||"Location not recorded",time:cd.time,notes:"",
          airTemp:cd.airTemp||null,weatherDesc:cd.weatherDesc||null,windSpeed:cd.windSpeed||null,
          windDir:cd.windDir||null,pressure:cd.pressure||null,streamCFS:cd.streamCFS||null,
          streamCondition:cd.streamCondition||null,streamGaugeName:cd.streamGaugeName||null,
          waterTemp:null,tripId:newTripId
        };
        await addCatch(catchData);
      }
      for(const id of logTripForm.linkedCatchIds){
        await updateCatch(id,{tripId:newTripId});
      }
      const totalLinked=(logTripForm.catchDetails||[]).length+logTripForm.linkedCatchIds.length;
      if(totalLinked===0){
        await sb.from("personal_trips").update({skunked:true}).eq("id",newTripId);
        row.skunked=true;
      }
      setPersonalTrips(ts=>[personalTripRowToCamel({id:newTripId,...row}),...ts]);
      setShowLogTripForm(false);
      setShowCatchPicker(false);
      setLogTripForm(logTripForm0);
    } finally {
      setSavingPersonalTrip(false);
    }
  }

  async function deletePersonalTrip(id){
    if(!window.confirm("Delete this trip? Catches logged to it will stay in your catch log, just no longer linked to a trip.")) return;
    setPersonalTrips(ts=>ts.filter(t=>t.id!==id));
    setCatches(cs=>cs.map(c=>c.tripId===id?{...c,tripId:null}:c));
    if(!sb) return;
    try{
      await sb.from("personal_trips").delete().eq("id",id);
      // DB foreign key already sets trip_id to null on linked catches automatically
      // (on delete set null) — the setCatches above just keeps local state in sync
      // with that immediately instead of waiting for a reload.
    }catch(e){void 0;}
  }

  // Manual +/- tally for fish that were never photographed (so never became a real
  // catches-table row). Additive on top of the real photographed-catch count, not a
  // replacement for it — lets the accurate photo-based count stay accurate while still
  // covering "caught one more, didn't get a pic." Clamped at 0. Also clears `skunked`
  // once the combined total is positive, since a trip with a manually-added fish isn't
  // skunked anymore even with zero photographed catches.
  async function adjustExtraCatches(tripId,delta){
    const trip=personalTrips.find(t=>t.id===tripId);
    if(!trip) return;
    const newExtra=Math.max(0,(trip.extraCatches||0)+delta);
    const tripCatchCount=catches.filter(c=>c.tripId===tripId).length;
    const newSkunked=(tripCatchCount+newExtra)>0?false:trip.skunked;
    const prevExtra=trip.extraCatches||0,prevSkunked=trip.skunked;
    setPersonalTrips(ts=>ts.map(t=>t.id===tripId?{...t,extraCatches:newExtra,skunked:newSkunked}:t));
    if(!sb) return;
    try{
      const{error}=await sb.from("personal_trips").update({extra_catches:newExtra,skunked:newSkunked}).eq("id",tripId);
      if(error) throw error;
    }catch(e){
      // Revert so the shown count never drifts from what's actually saved
      setPersonalTrips(ts=>ts.map(t=>t.id===tripId?{...t,extraCatches:prevExtra,skunked:prevSkunked}:t));
      alert("Couldn't update the catch count — check your connection and try again.");
    }
  }

  // Personal trip rows don't store species/flies directly — those live on the linked
  // catches-table rows — so pull them in here before handing off to the shared,
  // subject-agnostic generateTripIntel().
  function deriveTripForIntel(t){
    const tc=catches.filter(c=>c.tripId===t.id);
    return {...t, species:[...new Set(tc.map(c=>c.species).filter(s=>s&&s!=="Unidentified"))],
      flies:[...new Set(tc.flatMap(c=>c.flies||[]))], catches:tc.length+(t.extraCatches||0)};
  }
  async function handleGenerateTripIntel(trip){
    if(personalIntelLoading) return;
    setPersonalIntelLoading(true); setPersonalIntelError(null);
    try{
      const curCatches=catches.filter(c=>c.tripId===trip.id);
      const hist=personalTrips.filter(t=>t.id!==trip.id).map(deriveTripForIntel);
      const text=await generateTripIntel("this angler",trip,curCatches,hist);
      const now=new Date().toISOString();
      if(sb) await sb.from("personal_trips").update({ai_intel:text,ai_intel_generated_at:now}).eq("id",trip.id);
      setPersonalTrips(ts=>ts.map(t=>t.id===trip.id?{...t,aiIntel:text,aiIntelGeneratedAt:now}:t));
      setPersonalTripDetail(d=>d&&d.id===trip.id?{...d,aiIntel:text,aiIntelGeneratedAt:now}:d);
    }catch(e){
      setPersonalIntelError("Could not generate intel. Try again.");
    }
    setPersonalIntelLoading(false);
  }

  // Saves the Trip Summary edit form — location, techniques, notes, and conditions.
  // Same column set saveLogTrip already writes on create (no pressure/pressure_trend —
  // personal_trips doesn't have those columns, unlike the per-catch conditions snapshot).
  async function handleSavePersonalTrip(tripId, form){
    if(personalTripSaving) return false;
    setPersonalTripSaving(true); setPersonalTripSaveError(null);
    try{
      const patch={
        location:form.location||null, techniques:form.techniques||[], notes:form.notes||null,
        air_temp:form.airTemp||null, water_temp:form.waterTemp||null, weather_desc:form.weatherConditions||null,
        wind_speed:form.windSpeed||null, wind_dir:form.windDir||null,
        stream_cfs:form.streamCFS||null, stream_condition:form.streamCondition||null, stream_gauge_name:form.streamGaugeName||null
      };
      if(sb){
        const{error}=await sb.from("personal_trips").update(patch).eq("id",tripId);
        if(error) throw error;
      }
      setPersonalTrips(ts=>ts.map(t=>t.id===tripId?{...t,
        location:patch.location||"", techniques:patch.techniques, notes:patch.notes||"",
        airTemp:patch.air_temp!=null?String(patch.air_temp):"", waterTemp:patch.water_temp!=null?String(patch.water_temp):"",
        weatherDesc:patch.weather_desc||"", windSpeed:patch.wind_speed!=null?String(patch.wind_speed):"", windDir:patch.wind_dir||"",
        streamCFS:patch.stream_cfs!=null?String(patch.stream_cfs):"", streamCondition:patch.stream_condition||"", streamGaugeName:patch.stream_gauge_name||""
      }:t));
      setPersonalTripSaving(false);
      return true;
    }catch(e){
      setPersonalTripSaveError("Could not save changes. Try again.");
      setPersonalTripSaving(false);
      return false;
    }
  }

  async function updateCatch(id, updates){
    setCatches(cs=>cs.map(c=>c.id===id?{...c,...updates}:c));
    if(!sb||String(id).startsWith("local")) return;
    try{
      await sb.from("catches").update({
        species:updates.species, length:updates.length, flies:updates.flies, photo:updates.photo,
        notes:updates.notes, gps:updates.gps, time:updates.time,
        air_temp:updates.airTemp, weather_desc:updates.weatherDesc,
        wind_speed:updates.windSpeed, wind_dir:updates.windDir,
        pressure:updates.pressure, stream_cfs:updates.streamCFS,
        stream_condition:updates.streamCondition, stream_gauge_name:updates.streamGaugeName, water_temp:updates.waterTemp,
        trip_id:updates.tripId
      }).eq("id",id);
    }catch(e){ void 0; }
  }

  async function syncOfflineCatches(){
    if(!sb||!user) return;
    const queue=JSON.parse(localStorage.getItem('tl_sync_queue')||'[]');
    if(!queue.length) return;
    const remaining=[];
    const today=new Date().toISOString().split("T")[0];
    for(const item of queue){
      try{
        // Fill in conditions with a fresh, confidence-checked lookup keyed to the
        // catch's own GPS and time — not a stale cached snapshot from whenever the
        // app last had a location fix. We're back online by the time this runs, so
        // a live/historical lookup (same one "Update Catch Data" uses) is available
        // and more accurate than guessing from an old cache.
        if(!item.streamCFS||!item.airTemp){
          const coords=parseGpsCoords(item.gps);
          if(coords){
            const d=new Date((item.time||"").replace(" at "," "));
            const dateStr=!isNaN(d)?d.toISOString().split("T")[0]:null;
            if(dateStr){
              const hourStr=String(d.getHours()).padStart(2,"0");
              const conds=dateStr<today?await fetchHistoricalConditions(coords.lat,coords.lng,dateStr,hourStr):await fetchLiveNearestConditions(coords.lat,coords.lng);
              if(!item.airTemp&&conds.airTemp) item.airTemp=conds.airTemp;
              if(!item.weatherDesc&&conds.weatherDesc) item.weatherDesc=conds.weatherDesc;
              if(!item.streamCFS&&conds.streamCFS){
                item.streamCFS=conds.streamCFS;
                item.streamCondition=conds.streamCondition;
                item.streamGaugeName=conds.streamGaugeName;
              }
              // No confident flow reading found (or the nearest gauge isn't reporting)
              // — leave flow blank rather than guessing at the wrong water body.
            }
          }
        }
        const{data,error}=await sb.from('catches').insert({user_id:user.id,...catchDataToDbRow(item)}).select().single();
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
        const rd=await aiFetch({model:"claude-haiku-4-5-20251001",max_tokens:150,messages:[{role:"user",content:[{type:"image",source:{type:"base64",media_type:mediaType,data:base64}},{type:"text",text:"Look carefully at this fish photo. Identify the exact species based on coloring, spot patterns, and body shape. Rainbow trout have pink/red lateral stripe and black spots. Brown trout have brown/golden coloring with red spots. Cutthroat trout have red slash marks under jaw. Choose from: "+SPECIES.join(", ")+". Estimate length in inches if a hand or scale is visible for reference. Reply ONLY with JSON: {\"species\":\"Rainbow Trout\",\"length\":14}. Use null for length if unknown."}]}]},"cheap");
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
    const toEnrich=catches.filter(c2=>(!c2.streamCFS||c2.streamCFS==="0")&&c2.gps&&c2.gps!=="Location not recorded");
    void 0;
    const today=new Date().toISOString().split("T")[0];
    for(const catch2 of toEnrich){
      if((catch2.streamCFS&&catch2.streamCFS!=="0")||!catch2.gps) continue;
      const coords=parseGpsCoords(catch2.gps);
      if(!coords) continue;
      const{lat,lng}=coords;
      try{
        const d=new Date((catch2.time||"").replace(" at "," "));
        const dateStr=!isNaN(d)?d.toISOString().split("T")[0]:null;
        if(!dateStr) continue;
        // Past catches: historical archive (has finalized data). Today's catch: the
        // archive/daily-values endpoints aren't finalized yet, so use live gauges.
        const conds=dateStr<today?await fetchHistoricalConditions(lat,lng,dateStr,"12"):await fetchLiveNearestConditions(lat,lng);
        if(conds.streamCFS){
          await updateCatch(catch2.id,{streamCFS:conds.streamCFS,streamCondition:conds.streamCondition,streamGaugeName:conds.streamGaugeName,airTemp:conds.airTemp||catch2.airTemp,weatherDesc:conds.weatherDesc||catch2.weatherDesc});
          updated++;
        } else if(catch2.streamCFS==="0"){
          // Known-fabricated zero and we still can't confidently verify a real
          // reading (e.g. the nearest gauge to this spot isn't reporting) — clear
          // it to blank/N/A rather than leave the wrong number showing.
          await updateCatch(catch2.id,{streamCFS:"",streamCondition:"",streamGaugeName:""});
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
    let photoUploadFailed=false;
    if(catchData.photo&&catchData.photo.startsWith("data:")){
      const url=await uploadPhotoToStorage(catchData.photo,"catches");
      if(!url) photoUploadFailed=true;
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
    let data=null,error=null;
    try{
      const r=await sb.from("catches").insert({user_id:user.id,...catchDataToDbRow(catchData)}).select().single();
      data=r.data;error=r.error;
    }catch(netErr){error={message:netErr.message,_network:true};}
    if(error&&(error._network||/load failed|network|fetch|timeout/i.test(error.message||""))){
      // Network hiccup: route to the offline sync queue instead of losing the catch
      const offlineId="offline-"+Date.now()+"-"+Math.random().toString(36).slice(2,6);
      const offlineItem={...catchData,_offlineId:offlineId,_pending:true,id:offlineId};
      setCatches(cs=>[offlineItem,...cs]);
      const queue=JSON.parse(localStorage.getItem('tl_sync_queue')||'[]');
      queue.push({...catchData,_offlineId:offlineId});
      localStorage.setItem('tl_sync_queue',JSON.stringify(queue));
      setSyncQueue(queue);
      return offlineId;
    }
    if(error){
      alert("Catch save failed: "+error.message);
    } else if(data){
      setCatches(c=>[catchRowToCamel(data),...c]);
      if(photoUploadFailed) alert("Catch saved, but the photo didn't upload — check your connection and try adding the photo again from the catch log.");
      return data.id;
    }
  }

  async function deleteCatch(id){
    if(sb) await sb.from("catches").delete().eq("id",id);
    setCatches(cs=>cs.filter(x=>x.id!==id));
  }

  // Called by PhotoCropModal with the cropped JPEG data URL. Re-runs it through the
  // same upload pipeline the original photo used (uploadPhotoToStorage → "catches"
  // folder) so the crop replaces the canonical photo everywhere it's referenced (catch
  // card, share card, photo journal, lightbox all read the same catch.photo field) —
  // rather than adding a second image to track. Offline/local-only catches (not yet
  // synced to Supabase) have no storage to upload to, so those just keep the cropped
  // photo inline, same as the rest of the offline-catch flow.
  async function handleCropSave(catchId,dataUrl){
    if(!sb||String(catchId).startsWith("local")){
      updateCatch(catchId,{photo:dataUrl});
      setCropCatchId(null);
      return;
    }
    const uploaded=await uploadPhotoToStorage(dataUrl,"catches");
    if(!uploaded){
      alert("Couldn't save that crop — check your connection and try again.");
      return;
    }
    await updateCatch(catchId,{photo:uploaded});
    setCropCatchId(null);
  }

  // ── Catch card social share ─────────────────────────────────────────────
  function loadSameOriginImage(src){
    return new Promise((res,rej)=>{const im=new Image();im.onload=()=>res(im);im.onerror=rej;im.src=src;});
  }
  function roundRectPath(ctx,x,y,w,h,r){
    ctx.beginPath();
    ctx.moveTo(x+r,y);
    ctx.arcTo(x+w,y,x+w,y+h,r);
    ctx.arcTo(x+w,y+h,x,y+h,r);
    ctx.arcTo(x,y+h,x,y,r);
    ctx.arcTo(x,y,x+w,y,r);
    ctx.closePath();
  }
  // style: "minimal" (photo + small watermark) or "stat" (photo + species/length/
  // river/date bar + watermark). No exact GPS is ever drawn — river name only.
  async function buildCatchShareBlob(c,style){
    const W=1080,H=1350;
    // Build content strings first — the stat-card bar is sized to whatever
    // is actually present, so a sparse catch (no flies, no conditions) gets a
    // short bar and a catch with everything logged still fits cleanly.
    const headline=(c.species||"Catch")+(c.length?` · ${c.length}"`:"");
    const riverName=(c.streamGaugeName||"").split(" ").slice(0,4).join(" ");
    const subline=[riverName,c.time].filter(Boolean).join("  ·  ");
    const flowPart=c.streamCFS?`${c.streamCFS} CFS`:"";
    const wxPart=[c.airTemp?`${c.airTemp}°F`:"",c.weatherDesc||""].filter(Boolean).join(" · ");
    const windPart=c.windSpeed?`${c.windSpeed}mph ${c.windDir||""}`.trim():"";
    const condLine=[flowPart,wxPart,windPart].filter(Boolean).join("   ·   ");
    const fliesLine=(c.flies&&c.flies.length)?"Flies: "+c.flies.join(", "):"";
    const statLines=[{text:headline,color:"#d09a4a",font:"700 58px Oswald, sans-serif",advance:54}];
    if(subline) statLines.push({text:subline,color:"#f2efe6",font:"400 32px Montserrat, sans-serif",advance:44});
    if(condLine) statLines.push({text:condLine,color:"#c2b49a",font:"400 28px Montserrat, sans-serif",advance:40,shrinkToFit:true});
    if(fliesLine) statLines.push({text:fliesLine,color:"#d09a4a",font:"400 28px Montserrat, sans-serif",advance:40,shrinkToFit:true});

    const cv=document.createElement("canvas");
    cv.width=W;cv.height=H;
    const ctx=cv.getContext("2d");
    ctx.fillStyle="#2f3527";ctx.fillRect(0,0,W,H);
    const topPad=76,bottomReserve=112;
    const barNeeded=topPad+statLines.reduce((s,l)=>s+l.advance,0)+bottomReserve;
    const photoH=style==="stat"?Math.min(Math.round(H*0.78),Math.max(Math.round(H*0.55),H-barNeeded)):H;
    let photoDrawn=false;
    if(c.photo){
      try{
        const img=await loadImageSource(c.photo);
        const iw=img.naturalWidth||img.width,ih=img.naturalHeight||img.height;
        const scale=Math.max(W/iw,photoH/ih);
        const dw=iw*scale,dh=ih*scale;
        ctx.drawImage(img,(W-dw)/2,(photoH-dh)/2,dw,dh);
        photoDrawn=true;
      }catch(photoErr){ void 0; }
    }
    if(!photoDrawn){
      ctx.font="220px serif";ctx.textAlign="center";ctx.textBaseline="middle";
      ctx.fillText("🐟",W/2,photoH/2);
    }
    await Promise.all(["700 58px Oswald","600 30px Oswald","400 32px Montserrat","400 28px Montserrat"].map(f=>document.fonts.load(f).catch(()=>{})));
    const logo=await loadSameOriginImage("/logo-mark.png").catch(()=>null);
    if(style==="stat"){
      ctx.fillStyle="#2f3527";ctx.fillRect(0,photoH,W,H-photoH);
      const grad=ctx.createLinearGradient(0,photoH-140,0,photoH);
      grad.addColorStop(0,"rgba(47,53,39,0)");grad.addColorStop(1,"rgba(47,53,39,1)");
      ctx.fillStyle=grad;ctx.fillRect(0,photoH-140,W,140);
      const pad=56;
      ctx.textAlign="left";ctx.textBaseline="alphabetic";
      let y=photoH+topPad;
      for(const line of statLines){
        let fs=parseInt(line.font.match(/(\d+)px/)[1],10);
        ctx.font=line.font;
        if(line.shrinkToFit){
          while(ctx.measureText(line.text).width>W-pad*2&&fs>18){ fs-=2; ctx.font=line.font.replace(/\d+px/,fs+"px"); }
        }
        ctx.fillStyle=line.color;
        ctx.fillText(line.text,pad,y);
        y+=line.advance;
      }
      const wmY=H-50,logoSize=52;
      if(logo) ctx.drawImage(logo,pad,wmY-logoSize+14,logoSize,logoSize);
      ctx.fillStyle="#c2b49a";ctx.font="600 26px Oswald, sans-serif";
      ctx.fillText("GUIDE'S CHOICE FISHING",pad+(logo?logoSize+14:0),wmY);
    } else {
      // Pill is sized to fit "GUIDE'S CHOICE FISHING" at the base font size, with a
      // shrink-to-fit fallback (same technique as the statLines loop above) in case a
      // font-load fallback renders wider than Oswald's measured metrics.
      const pillW=372,pillH=64,pad=32;
      const px=W-pad-pillW,py=H-pad-pillH;
      ctx.fillStyle="rgba(31,35,29,0.6)";
      roundRectPath(ctx,px,py,pillW,pillH,16);ctx.fill();
      const logoSize=38;
      if(logo) ctx.drawImage(logo,px+16,py+(pillH-logoSize)/2,logoSize,logoSize);
      ctx.textAlign="left";ctx.textBaseline="middle";
      ctx.fillStyle="#f2efe6";
      const wmText="GUIDE'S CHOICE FISHING";
      const textX=px+16+(logo?logoSize+12:0);
      const maxTextW=(px+pillW-16)-textX;
      let wmFs=24;
      ctx.font=`600 ${wmFs}px Oswald, sans-serif`;
      while(ctx.measureText(wmText).width>maxTextW&&wmFs>14){ wmFs-=1; ctx.font=`600 ${wmFs}px Oswald, sans-serif`; }
      ctx.fillText(wmText,textX,py+pillH/2+1);
    }
    return await new Promise(res=>cv.toBlob(res,"image/jpeg",0.92));
  }
  async function shareCatch(c,style){
    setSharingBusy(true);
    try{
      const blob=await buildCatchShareBlob(c,style);
      if(!blob){ alert("Couldn't build the share image — try again."); return; }
      const fname=`guides-choice-${(c.species||"catch").toLowerCase().replace(/\s+/g,"-")}.jpg`;
      const file=new File([blob],fname,{type:"image/jpeg"});
      const shareText=[c.species,(c.streamGaugeName||"").split(" ").slice(0,4).join(" ")].filter(Boolean).join(" — ");
      if(navigator.canShare&&navigator.canShare({files:[file]})){
        await navigator.share({files:[file],title:"Guide's Choice",text:shareText});
      } else {
        const url=URL.createObjectURL(blob);
        const a=document.createElement("a");
        a.href=url;a.download=fname;document.body.appendChild(a);a.click();a.remove();
        setTimeout(()=>URL.revokeObjectURL(url),4000);
        alert("Your browser can't share images directly — the image saved to your device instead. Open it from Photos/Downloads to post it.");
      }
    }catch(shareErr){
      if(shareErr?.name!=="AbortError") alert("Couldn't create the share image: "+(shareErr.message||shareErr));
    } finally {
      setSharingBusy(false);
      setSharingCatchId(null);
    }
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

  // Load saved gauges ordered by sort_order — shared loadSavedGaugesOrdered() (see above)
  // also backs the Guide CRM's My Gauges, since both read the same saved_gauges rows.
  useEffect(()=>{
    if(!sb||!user||String(user.id).startsWith("local")) return;
    loadSavedGaugesOrdered(user.id).then(setSavedGauges);
  },[user?.id]);

  // Swaps two adjacent My Gauges entries' positions — shared moveSavedGaugeCore() (see
  // above) also backs the Guide CRM's My Gauges. direction: -1 to move up, +1 to move down.
  function moveSavedGauge(id,direction){
    moveSavedGaugeCore(setSavedGauges,user?.id,id,direction);
  }

  async function fetchSavedGaugeData(gauge){
    try{
      var siteNo=gauge.site_no;
      if(!siteNo&&gauge.url){
        var m=gauge.url.match(/sites?[=\/]([0-9]{8,})/i);
        if(m) siteNo=m[1];
      }
      if(!siteNo) return {...gauge,cfs:null,label:"NO DATA",cls:"nodata"};
      // DWR-sourced gauges store their DWR abbrev (letters, e.g. "BOCBGRCO") as site_no,
      // not a USGS site number (see gaugeSources.js, 2026-08-15) — route those to DWR's
      // API instead of USGS's, which has no record of them at all under that ID. This is
      // exactly the South Boulder Creek below Gross Reservoir case: stuck on "Loading..."
      // forever because this function only knew how to ask USGS.
      if(!/^\d+$/.test(String(siteNo))){
        var dwrCfs=await fetchCODWRSingleValue(siteNo);
        var dwrLbl=cfsLabel(dwrCfs);
        return {...gauge,cfs:dwrCfs,label:dwrLbl.label,cls:dwrLbl.cls};
      }
      // Fetch CFS and location in parallel
      var [cfsResult,locResult]=await Promise.allSettled([
        (async()=>{
          try{
            var nf=await nwLatest([siteNo],"00060");
            if(nf.length){var ncfs=parseFloat(nf[0].properties.value);if(!isNaN(ncfs))return{cfs:ncfs,name:null};}
          }catch{}
          var controller=new AbortController();
          var timer=setTimeout(()=>controller.abort(),8000);
          var r=await fetch("https://waterservices.usgs.gov/nwis/iv/?format=json&sites="+siteNo+"&parameterCd=00060",{signal:controller.signal});
          clearTimeout(timer);
          if(!r.ok)return{cfs:null,name:null};
          var d=await r.json();
          var ts=(d.value&&d.value.timeSeries)||[];
          if(!ts.length)return{cfs:null,name:null};
          var raw=ts[0].values&&ts[0].values[0]&&ts[0].values[0].value&&ts[0].values[0].value[0]&&ts[0].values[0].value[0].value;
          var rawDt=ts[0].values&&ts[0].values[0]&&ts[0].values[0].value&&ts[0].values[0].value[0]&&ts[0].values[0].value[0].dateTime;
          // Same staleness guard as the two other USGS legacy-fallback call sites
          // (gaugeSources.js NW_STALE_MS / legacyFresh) — this THIRD, independent copy of
          // the same fallback pattern was missed by the original codebase-wide search
          // because it uses old-style `&&` guards instead of `?.` optional chaining, so a
          // text search for the `?.` pattern didn't catch it. This is the actual function
          // powering the on-screen "My Gauges" list (SavedGaugesList component) — confirmed
          // directly, 2026-08-19, via a temporary on-screen debug tag that proved the other
          // two (already-fixed) copies were never being called for this view at all.
          if(raw==null||!legacyFresh(rawDt))return{cfs:null,name:(ts[0].sourceInfo&&ts[0].sourceInfo.siteName)||null};
          return{cfs:parseFloat(raw),name:(ts[0].sourceInfo&&ts[0].sourceInfo.siteName)||null};
        })(),
        nwLocation(siteNo)
      ]);
      var cfsVal=(cfsResult.status==="fulfilled"?cfsResult.value?.cfs:null);
      var nameFromCfs=(cfsResult.status==="fulfilled"?cfsResult.value?.name:null);
      var loc2=(locResult.status==="fulfilled"?locResult.value:null);
      var lat=loc2?.lat||null,lng=loc2?.lng||null;
      var name=nameFromCfs||loc2?.name||gauge.name;
      var lbl=cfsLabel(cfsVal);
      // NWM fallback (SPEC_streamflow_forecast.md) — same treatment as the Stream Gauges
      // list and the Guide tab's gauge list, and the same real confirmed cases (Hot
      // Sulphur Springs, Boulder Creek near Orodell). Only fires when cfsVal is still
      // null after both the new-API and legacy-fallback attempts above. Label always
      // says "(modeled)" — same trust rule as everywhere else this fallback appears.
      var nwmOutlook=null;
      var nwmModeled=false;
      if(cfsVal==null&&lat!=null&&lng!=null){
        try{
          var nwm=await fetchNWMStreamflow(lat,lng);
          if(nwm&&nwm.cfs!=null){
            cfsVal=Math.round(nwm.cfs);
            nwmModeled=true;
            if(nwm.reachId!=null){
              try{var outlook=await fetchNWMForecastOutlook(sb,nwm.reachId);if(outlook&&outlook.length)nwmOutlook=outlook;}catch{}
            }
          }
        }catch{}
      }
      return{...gauge,cfs:cfsVal,label:lbl.label,cls:lbl.cls,name,lat,lng,nwmOutlook,nwmModeled};
    }catch(e){return {...gauge,cfs:null,label:"NO DATA",cls:"nodata"};}
  }

  async function addSavedGauge(){
    if(!user){onRequestAuth&&onRequestAuth("Create a free account to save your favorite gauges.");return;}
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
    try{var loc=await nwLocation(siteNo);if(loc&&loc.name&&!loc.name.startsWith("Site "))name=loc.name;}catch(e){}
    if(name==="Custom Gauge"){
      try{
        var r=await fetch("https://waterservices.usgs.gov/nwis/iv/?format=json&sites="+siteNo+"&parameterCd=00060");
        if(r.ok){var d=await r.json();var ts=(d.value&&d.value.timeSeries)||[];if(ts.length) name=ts[0].sourceInfo&&ts[0].sourceInfo.siteName||name;}
      }catch(e){}
    }
    var newGauge={user_id:user.id,site_no:siteNo,name:name,url:url,sort_order:savedGauges.length};
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
    if(!user){onRequestAuth&&onRequestAuth("Create a free account to save your favorite gauges.");return;}
    if(isStarred(gauge.siteNo)){
      const g=savedGauges.find(s=>s.site_no===gauge.siteNo);
      if(g) removeSavedGauge(g.id);
    } else {
      // DWR-sourced gauges (siteNo is a letters abbrev, not numeric — see
      // gaugeSources.js, 2026-08-15) don't have a USGS monitoring-location page; point
      // at DWR's own station page instead so the saved link actually works.
      const isNumericSite=/^\d+$/.test(String(gauge.siteNo||""));
      const url=isNumericSite
        ?"https://waterdata.usgs.gov/monitoring-location/"+gauge.siteNo+"/"
        :"https://dwr.state.co.us/Tools/StationsLite/"+gauge.siteNo+"?params=DISCHRG";
      const newG={user_id:user?.id,site_no:gauge.siteNo,name:gauge.name,url,sort_order:savedGauges.length};
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
      const d=await aiFetch({
        model:"claude-sonnet-4-6",max_tokens:600,
        messages:[{role:"user",content:prompt}]
      },"cheap");
      const txt=(d.content||[]).map(b=>b.text||"").filter(Boolean).join("");
      if(txt) setCondReport(txt.replace(/<cite[^>]*>|<\/cite>/g,""));
    }catch(e){if(e&&e.isLimit)setCondReport("⚠️ "+e.message);}
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
    // Two separate mount-time effects both call this function for what's usually the
    // SAME location — a preWarm call from the last saved location (near-instant, no
    // await before it fires) and a real geolocation call shortly after. When they
    // overlap, their async DWR-merge steps (see applyGaugeData below) raced to append
    // onto a shared `gauges` state with no way to tell an in-flight call apart from a
    // newer one — confirmed directly: a user reported the same gauge appearing twice
    // with the identical live CFS value, and this is the only place two independent
    // calls both append DWR results onto shared state without any dedup. Pre-existing
    // (unrelated to the DWR endpoint fix from earlier today), but the DWR fetch got
    // much faster today (raw endpoint: ~300-700ms vs. the old daily endpoint), which
    // narrowed the timing gap between two overlapping calls enough to make the race
    // land visibly rather than being an unnoticed near-miss. myGen is captured once
    // here and checked before every setGauges call downstream that resulted from an
    // await/then — if a newer call has started by the time an older one's async step
    // resolves, the older one's result is stale and gets dropped instead of applied.
    const myGen=++loadGenRef.current;
    setLoc(newLoc);
    try{localStorage.setItem("tl_loc",JSON.stringify({lat:newLoc.lat,lng:newLoc.lng,label:newLoc.label}));}catch{}
    const{lat,lng}=newLoc;
    setWxLoading(true);setWxError(null);setCondReport(null);setGaugeLoading(true);setGaugeError(null);
    // Check localStorage for cached weather to show instantly
    try{const cachedWx=localStorage.getItem("tl_wx_"+lat.toFixed(2)+"_"+lng.toFixed(2));if(cachedWx){const{data,ts}=JSON.parse(cachedWx);if(Date.now()-ts<30*60*1000){const c2=data.current;const pressureInHg=(c2.surface_pressure*0.02953).toFixed(2);const trend=pressureTrend(parseFloat(pressureInHg),null);setWeather({temp:Math.round(c2.temperature_2m),humidity:c2.relative_humidity_2m,wind:Math.round(c2.wind_speed_10m),windDir:windDir(c2.wind_direction_10m),pressure:pressureInHg,pressureTrend:trend,uv:Math.round(c2.uv_index??0),desc:`${WX_EMOJI[c2.weather_code]||""} ${WX_DESC[c2.weather_code]||""}`.trim()});setWxForecast(data);setWxLoading(false);}}}catch{}
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
        setWeather({temp:Math.round(c.temperature_2m),humidity:c.relative_humidity_2m,wind:Math.round(c.wind_speed_10m),windDir:windDir(c.wind_direction_10m),pressure:pressureInHg,pressureTrend:trend,uv:Math.round(c.uv_index??0),desc:`${WX_EMOJI[c.weather_code]||""} ${WX_DESC[c.weather_code]||""}`.trim()});
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
          const waterWords=["creek","river","brook"," run"," fork","branch","stream","slough","gulch","canyon","bayou","kill"," rio "," riv"," r "," cr"," ck"," fk"];
          const hasWaterword=waterWords.some(function(w){return n.indexOf(w)!==-1;});
          const hasNonFishable=NON_FISHABLE.some(function(kw){return streamPart.indexOf(kw)!==-1;});
          return hasWaterword&&!hasNonFishable;
        };
        const rawParsed=ts.map(t=>{
          const raw=t.values?.[0]?.value?.[0]?.value;const cfs=raw!=null?parseFloat(raw):null;
          const siteNo=(t.sourceInfo?.siteCode?.[0]?.value)||"";
          const siteLat=parseFloat(t.sourceInfo?.geoLocation?.geogLocation?.latitude||0);
          const siteLng=parseFloat(t.sourceInfo?.geoLocation?.geogLocation?.longitude||0);
          const dist=Math.sqrt(Math.pow(siteLat-lat,2)+Math.pow(siteLng-lng,2));
          const name=t.sourceInfo?.siteName??"Unknown";
          const distMi=Math.round(dist*69);
          return{name,cfs,siteNo,dist,distMi,lat:siteLat,lng:siteLng,fishable:isFishable(name)};
        }).filter(s=>s.fishable&&s.cfs!==null&&s.cfs>=0&&s.cfs<500000&&s.distMi<=50)
          .sort((a,b)=>a.distMi-b.distMi).slice(0,25);
        const maxCFS=Math.max(...rawParsed.map(x=>x.cfs||0),1);
        const parsed=rawParsed.map(g=>{
          const pct=g.cfs!=null?Math.min(Math.round((g.cfs/maxCFS)*95),100):0;
          const{label,cls}=cfsLabel(g.cfs);
          return{...g,pct,histMax:null,waterTempF:null,label,cls};
        });
        if(myGen!==loadGenRef.current) return; // a newer loadConditions call has started — this result is stale, don't apply it
        setGauges(parsed);window._loadedGauges=parsed;if(window._recomputeHatches)window._recomputeHatches();
        setLastUpd(new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}));
        try{localStorage.setItem(gaugeKey,JSON.stringify({data:parsed,ts:Date.now()}));}catch{}
        fetchUSGSTempBatch(parsed.map(g=>g.siteNo)).then(tempMap=>{
          if(myGen!==loadGenRef.current) return; // stale — a newer call has since taken over
          const withTemp=parsed.map(g=>({...g,waterTempF:(tempMap[g.siteNo]!=null?tempMap[g.siteNo]:null)}));
          setGauges(withTemp);window._loadedGauges=withTemp;if(window._recomputeHatches)window._recomputeHatches();
        }).catch(()=>{}).finally(()=>{
          // Supplemental sources beyond USGS (SPEC_gauge_sources.md) — Colorado DWR
          // today. Fired after the temp patch settles (never before the initial
          // render) and merged via the functional setGauges form so it can't race
          // or overwrite whatever the temp patch already set. This tab already
          // races USGS against a 9s patience budget on first load; DWR's own
          // latency varies too much in practice (tested: 0.4s-4s) to safely add to
          // that budget, so it only ever runs as a later, progressive enrichment —
          // same idea as the temp patch itself. Doesn't fetch water temps for
          // DWR-sourced gauges yet (kept out of Phase 1's scope); they'll just show
          // without a temp badge for now.
          fetchCODWRGauges(lat,lng,30,new Set(parsed.map(g=>g.siteNo))).then(dwrGauges=>{
            if(myGen!==loadGenRef.current) return; // stale — an overlapping newer call already owns `gauges` state; applying this would append onto (and duplicate against) that call's own results
            if(!dwrGauges.length) return;
            const dwrParsed=dwrGauges.map(g=>({...g,distMi:Math.round(g.dist*69),fishable:true,histMax:null,waterTempF:null}))
              .filter(g=>g.distMi<=50);
            if(!dwrParsed.length) return;
            setGauges(prev=>{
              // Not re-sliced to 25: prev is already the USGS-only top-25-by-CFS list,
              // and re-competing dwrParsed against it for the same 25 slots means a
              // DWR gap-filling gauge's survival depends on how its CFS happens to
              // rank against that day's specific USGS flow distribution — tested
              // directly, BOCBGRCO only survived that competition by chance (68.9 CFS
              // landing mid-pack), not because it was ever guaranteed to. DWR gauges
              // only reach here because dedup already excluded anything USGS also
              // covers, so appending them is adding non-redundant coverage, not
              // padding out redundant entries.
              // Deduped by siteNo (keeping prev's copy on a collision) as a backstop —
              // the generation guard above stops new duplicates from forming, but a
              // gauge list cached from BEFORE that guard existed could already have
              // one baked in, and this tab caches for 30min. Filtering here means the
              // very next background refresh (which fires on every load regardless of
              // cache freshness — see the "else" branch above) cleans an already-bad
              // cache immediately rather than waiting out the full TTL.
              const seenSiteNo=new Set();
              const merged=[...prev,...dwrParsed]
                .filter(g=>{if(seenSiteNo.has(g.siteNo))return false;seenSiteNo.add(g.siteNo);return true;})
                .sort((a,b)=>(a.distMi??9999)-(b.distMi??9999));
              const maxCFS2=Math.max(...merged.map(x=>x.cfs||0),1);
              const withPct=merged.map(g=>({...g,pct:g.cfs!=null?Math.min(Math.round((g.cfs/maxCFS2)*95),100):0}));
              window._loadedGauges=withPct;if(window._recomputeHatches)window._recomputeHatches();
              try{localStorage.setItem(gaugeKey,JSON.stringify({data:withPct,ts:Date.now()}));}catch{}
              return withPct;
            });
          }).catch(()=>{}).then(()=>{
            // NOAA NWPS forecast enrichment (SPEC_nwps_forecast_integration.md) — same
            // progressive-enrichment pattern as DWR just above: fires after DWR settles
            // (success or failure, via the .catch before this .then), never blocks or
            // blanks the stream list USGS/DWR already built. Attaches onto whatever
            // gauges are already showing — USGS or DWR sourced — rather than adding new
            // cards (see attachNWPSForecasts's own comment in gaugeSources.js for why).
            if(myGen!==loadGenRef.current) return;
            // Source list is window._loadedGauges, which every prior pass in this chain
            // (USGS parse, temp patch, DWR merge) already keeps current — so this picks
            // up DWR-sourced gauges too, not just the USGS ones.
            const snapshot=Array.isArray(window._loadedGauges)?window._loadedGauges:[];
            if(!snapshot.length) return;
            enrichWithNWPSForecasts(snapshot).then(enriched=>{
              if(myGen!==loadGenRef.current) return;
              if(!enriched||!enriched.length) return;
              setGauges(prev=>{
                // Re-map by siteNo onto whatever `prev` is NOW rather than replacing it
                // wholesale — the DWR pass above may have appended gauges after this
                // enrichment started, and blindly returning `enriched` would drop them.
                const fcBySite={};
                enriched.forEach(g=>{if(g.forecastCfs!=null)fcBySite[g.siteNo]=g;});
                const merged=prev.map(g=>fcBySite[g.siteNo]
                  ?{...g,forecastCfs:fcBySite[g.siteNo].forecastCfs,forecastHorizonHrs:fcBySite[g.siteNo].forecastHorizonHrs}
                  :g);
                window._loadedGauges=merged;
                try{localStorage.setItem(gaugeKey,JSON.stringify({data:merged,ts:Date.now()}));}catch{}
                return merged;
              });
            }).catch(()=>{}).then(()=>{
              // NWM fallback (SPEC_streamflow_forecast.md) — same progressive-enrichment
              // pattern as DWR and NWPS above: fires after NWPS settles, only ever touches
              // gauges still showing no reading at all (confirmed real cases tonight: Hot
              // Sulphur Springs offline since 1994, Boulder Creek near Orodell offline
              // since 1993 — both currently in this exact list). Never overwrites a real
              // reading. Label always says "(modeled)" — same trust rule as everywhere
              // else this fallback appears.
              if(myGen!==loadGenRef.current) return;
              const snapshot2=Array.isArray(window._loadedGauges)?window._loadedGauges:[];
              const needsFallback=snapshot2.filter(g=>g.cfs==null&&g.lat!=null&&g.lng!=null);
              if(!needsFallback.length) return;
              Promise.all(needsFallback.map(async(g)=>{
                try{
                  const nwm=await fetchNWMStreamflow(g.lat,g.lng);
                  if(!nwm||nwm.cfs==null) return null;
                  const rounded=Math.round(nwm.cfs);
                  const{label,cls}=cfsLabel(rounded);
                  let outlook=null;
                  if(nwm.reachId!=null){
                    try{outlook=await fetchNWMForecastOutlook(sb,nwm.reachId);}catch{}
                  }
                  return{siteNo:g.siteNo,cfs:rounded,label:label+" (modeled)",cls,nwmOutlook:(outlook&&outlook.length)?outlook:null};
                }catch{return null;}
              })).then(results=>{
                if(myGen!==loadGenRef.current) return;
                const bySite={};
                results.forEach(r=>{if(r)bySite[r.siteNo]=r;});
                if(!Object.keys(bySite).length) return;
                setGauges(prev=>{
                  const merged2=prev.map(g=>bySite[g.siteNo]?{...g,...bySite[g.siteNo]}:g);
                  window._loadedGauges=merged2;
                  try{localStorage.setItem(gaugeKey,JSON.stringify({data:merged2,ts:Date.now()}));}catch{}
                  return merged2;
                });
              });
            });
          });
        });
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
        const maxCfs=gl.reduce((m,g)=>Math.max(m,g.cfs||0),0);
        setHatchResult(predictHatches({month:new Date().getMonth()+1,waterTempF:null,lat:newLoc.lat!=null?newLoc.lat:null,lng:newLoc.lng!=null?newLoc.lng:null,maxCfs,tempGaugeName:null}));
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
      setAddOpen(false); // return to the catch list — new catches appear there as each one saves
      setBatchProgress({total:files.length,done:0,current:""});
      // Phase 1 — read photos + EXIF in selection order
      const items=[];
      for(const file of files){
        try{
          const dataUrl=await new Promise(res=>{const r=new FileReader();r.onload=ev=>res(ev.target.result);r.readAsDataURL(file);});
          let photoTime=null,photoGps=null,photoLat=null,photoLng=null;
          try{const abuf=await file.arrayBuffer();const exif=parseExif(abuf);photoTime=exif.time;photoGps=exif.gps;photoLat=exif.lat??null;photoLng=exif.lng??null;}catch(xe){void 0;}
          items.push({dataUrl,photoTime,photoGps,photoLat,photoLng});
        }catch(re){void 0;}
      }
      // Phase 2 — fish ID and conditions run in PARALLEL for each photo, 3 photos at a time
      try{
      await mapLimit(items,3,async(it)=>{
        try{
          const fetchLat=it.photoLat??loc?.lat;
          const fetchLng=it.photoLng??loc?.lng;
          const now=new Date();
          const t=it.photoTime||now.toLocaleString("en-US",{month:"long",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit",hour12:true});
          const coords=it.photoLat&&it.photoLng?fmtCoord(it.photoLat,it.photoLng):"Location not recorded";
          const idPromise=(async()=>{
            try{
              const base64=await resizeForID(it.dataUrl,800,0.7);
              const r=await identifyFish(base64,"Look carefully at this fish. Identify species based on coloring and spot patterns. Rainbow trout have pink lateral stripe. Brown trout have red spots on golden body. Choose from: "+SPECIES.join(", ")+". Estimate length if visible. Reply ONLY with JSON: {\"species\":\"Rainbow Trout\",\"length\":14}. Use null for length if unknown.");
              if(r&&r.species&&r.species!=="Unidentified")return r;
              return{species:"Unidentified",length:""};
            }catch(fishErr){return{species:"Unidentified",length:""};}
          })();
          const condPromise=Promise.race([new Promise(r=>setTimeout(()=>r(null),20000)),(async()=>{
            if(!fetchLat||!fetchLng)return null;
            try{
              const d2=new Date(t.replace(" at "," "));
              const today=new Date().toISOString().split("T")[0];
              const dateStr=!isNaN(d2)?d2.toISOString().split("T")[0]:null;
              if(dateStr&&dateStr<today){
                const conds=await fetchHistoricalConditions(fetchLat,fetchLng,dateStr,"12");
                if(conds)return{airTemp:conds.airTemp||null,weatherDesc:conds.weatherDesc||null,windSpeed:conds.windSpeed||null,windDir:conds.windDir||null,pressure:conds.pressure||null,streamCFS:conds.streamCFS||null,streamCondition:conds.streamCondition||null,streamGaugeName:conds.streamGaugeName||null};
                return null;
              }
              const[wx,usgs]=await Promise.all([fetchWeather(fetchLat,fetchLng),fetchUSGSLive(fetchLat,fetchLng)]);
              const wc=wx.current;
              const pressureInHg=(wc.surface_pressure*0.02953).toFixed(2);
              let cd={airTemp:String(Math.round(wc.temperature_2m)),weatherDesc:WX_DESC[wc.weather_code]||"",windSpeed:String(Math.round(wc.wind_speed_10m)),windDir:windDir(wc.wind_direction_10m),pressure:pressureInHg};
              const ts2=(usgs.value?.timeSeries)??[];
              if(ts2.length){
                const parsed2=ts2.map(t2=>{const raw=t2.values?.[0]?.value?.[0]?.value;const cfs=raw!=null?parseFloat(raw):null;const sLat=parseFloat(t2.sourceInfo?.geoLocation?.geogLocation?.latitude||0);const sLng=parseFloat(t2.sourceInfo?.geoLocation?.geogLocation?.longitude||0);const dist=Math.sqrt(Math.pow(sLat-fetchLat,2)+Math.pow(sLng-fetchLng,2));const siteNo=(t2.sourceInfo?.siteCode?.[0]?.value)||"";return{name:t2.sourceInfo?.siteName??"",cfs,dist,siteNo};}).filter(x=>x.cfs!=null&&x.cfs>=0&&x.cfs<500000&&x.dist<=0.3).sort((a,b)=>a.dist-b.dist);
                if(parsed2.length){const nd2b=parsed2[0].dist;const cb2b=parsed2.filter(x=>x.dist-nd2b<=0.05).reduce((a,b)=>b.cfs>a.cfs?b:a,parsed2[0]);cd={...cd,streamCFS:String(Math.round(cb2b.cfs)),streamCondition:cfsLabel(cb2b.cfs).label,streamGaugeName:cb2b.name};}
              }
              return cd;
            }catch(condErr){return null;}
          })()]);
          const[idRes,condRes]=await Promise.all([idPromise,condPromise]);
          let catchData={species:idRes.species,length:idRes.length,flies:[],photo:it.dataUrl,gps:coords,time:t,notes:"",airTemp:null,weatherDesc:null,windSpeed:null,windDir:null,pressure:null,streamCFS:null,streamCondition:null,streamGaugeName:null,waterTemp:null,tripId:null};
          if(condRes)catchData={...catchData,...condRes};
          const savedId=await addCatch(catchData);
          if(savedId) lastCatchIdRef.current=savedId;
        }catch(batchErr){void 0;}
        finally{setBatchProgress(p=>p?{...p,done:Math.min((p.done||0)+1,p.total)}:p);}
      });
      }finally{
        // Overlay must clear no matter what happened above
        setBatchProgress({total:files.length,done:files.length,current:""});
        setTimeout(()=>setBatchProgress(null),1500);
      }
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
    // AI fish ID — kicked off NOW so it runs in parallel with the conditions fetch below (downscaled for speed)
    const idPromise=(async()=>{
      try{
        const base64=await resizeForID(dataUrl,800,0.7);
        const r=await identifyFish(base64,`Identify this fish and estimate its length. Choose species from: ${SPECIES.join(", ")}. Reply ONLY with JSON: {"species":"Rainbow Trout","length":14}. Use null for length if unknown.`);
        if(r&&(r.species||r.length)){
          setForm(f=>({...f,species:r.species||f.species,length:r.length||f.length,sizeEstimated:!!r.length}));
        } else if(r){
          setForm(f=>({...f,idNote:"Could not identify fish from this photo. Please select species manually."}));
        } else {
          setForm(f=>({...f,idNote:"Photo analysis failed. Please select species manually."}));
        }
      }catch(e3){
        void 0;
        setForm(f=>({...f,idNote:"Photo analysis failed. Please select species manually."}));
      }
    })();
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
            const parsed=ts2.map(t2=>{const raw=t2.values?.[0]?.value?.[0]?.value;const cfs=raw!=null?parseFloat(raw):null;const sLat=parseFloat(t2.sourceInfo?.geoLocation?.geogLocation?.latitude||0);const sLng=parseFloat(t2.sourceInfo?.geoLocation?.geogLocation?.longitude||0);const dist=Math.sqrt(Math.pow(sLat-fetchLat,2)+Math.pow(sLng-fetchLng,2));const siteNo=(t2.sourceInfo?.siteCode?.[0]?.value)||"";return{name:t2.sourceInfo?.siteName??"",cfs,dist,siteNo};}).filter(x=>x.cfs!=null&&x.cfs>=0&&x.cfs<500000&&x.dist<=0.3).sort((a,b)=>a.dist-b.dist);
            if(parsed.length){
              const _ndc=parsed[0].dist;const _cbc=parsed.filter(x=>x.dist-_ndc<=0.05).reduce((a,b)=>b.cfs>a.cfs?b:a,parsed[0]);
              const streamData={streamCFS:String(Math.round(_cbc.cfs)),streamCondition:cfsLabel(_cbc.cfs).label,streamGaugeName:_cbc.name,waterTemp:_cbc.waterTempF?String(_cbc.waterTempF):""};
              setForm(f=>({...f,...streamData}));
              if(lastCatchIdRef.current) updateCatch(lastCatchIdRef.current,streamData);
            }
          }
        }
      }catch(e2){void 0;}
    }
    await idPromise;
    setForm(f=>({...f,sizeEstimating:false}));
  }

  function addFly(){if(!form.flyInput.trim())return;setForm(f=>({...f,flies:[...f.flies,f.flyInput.trim()],flyInput:""}));}
  function removeFly(i){setForm(f=>({...f,flies:f.flies.filter((_,j)=>j!==i)}));}
  function submitCatch(){
    const now=new Date();
    const t=form.time||now.toLocaleString("en-US",{month:"long",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit",hour12:true});
    const catchData={species:form.species,length:form.length,flies:[...form.flies],photo:form.photo,gps:form.gps||"Location not recorded",time:t,notes:form.notes,airTemp:form.airTemp||null,weatherDesc:form.weatherDesc||null,windSpeed:form.windSpeed||null,windDir:form.windDir||null,pressure:form.pressure||null,streamCFS:form.streamCFS||null,streamCondition:form.streamCondition||null,streamGaugeName:form.streamGaugeName||null,waterTemp:form.waterTemp||null,tripId:null};
    addCatch(catchData).then(id=>{if(id)lastCatchIdRef.current=id;});
    setForm(blank);setAddOpen(false);
  }

  const hatches=HATCHES[new Date().getMonth()];
  // The header buttons (gear + Sign Out) get portaled to document.body below, to escape
  // .hdr's own stacking context (position:relative;z-index:5) — nesting them in .hdr
  // capped their effective z-index at 5 no matter what value was set on the buttons
  // themselves, letting the top status banner (z-index 1000, a sibling of .hdr rather
  // than a descendant) silently swallow every click whenever it was showing. This is
  // the same class of bug the Settings dropdown panel was already portaled to fix;
  // the toggle buttons that open it were missed at the time.
  const appRef=useRef(null);
  const [btnPos,setBtnPos]=useState(null);
  useEffect(()=>{
    function measure(){
      if(appRef.current){
        const r=appRef.current.getBoundingClientRect();
        setBtnPos({top:r.top+14, right:window.innerWidth-r.right+16});
      }
    }
    measure();
    window.addEventListener("resize",measure);
    return ()=>window.removeEventListener("resize",measure);
  },[]);

  return(
    <div className="app" ref={appRef}>
      <div className="bgbar"/>
      {(()=>{
        const showTrial = trialExpired && trialBannerDismissed!==trialExpired.expiredAt;
        if(!isOnline || signOutErr || showTrial || autoRedeemNotice || tierCheckFailed) return (
          <div style={{position:"fixed",top:0,left:0,right:0,zIndex:1000,display:"flex",flexDirection:"column"}}>
            {!isOnline&&<div style={{background:"rgba(200,100,50,0.95)",padding:"8px 16px",textAlign:"center",fontSize:15,color:"white",fontFamily:"var(--font-body)"}}>
              📵 Offline mode — catches will sync when you reconnect{syncQueue.length>0?" · "+syncQueue.length+" pending":""}
            </div>}
            {tierCheckFailed&&<div style={{background:"rgba(140,73,54,0.95)",padding:"8px 16px",textAlign:"center",fontSize:15,color:"white",fontFamily:"var(--font-body)",display:"flex",alignItems:"center",justifyContent:"center",gap:10,flexWrap:"wrap"}}>
              ⚠ Couldn't verify your plan — you may be seeing Free features while this is unresolved.
              <button disabled={tierRetryBusy} onClick={async()=>{setTierRetryBusy(true);await refreshTier();setTierRetryBusy(false);}}
                style={{background:"rgba(255,255,255,0.15)",border:"1px solid rgba(255,255,255,0.3)",borderRadius:6,padding:"4px 12px",color:"white",fontSize:13,cursor:"pointer",fontFamily:"var(--font-body)"}}>
                {tierRetryBusy?"Retrying…":"Retry"}
              </button>
            </div>}
            {signOutErr&&<div style={{background:"rgba(140,73,54,0.95)",padding:"8px 16px",textAlign:"center",fontSize:15,color:"white",fontFamily:"var(--font-body)"}}>
              ⚠ {signOutErr} <button onClick={()=>setSignOutErr("")} style={{background:"none",border:"none",color:"white",textDecoration:"underline",cursor:"pointer",fontSize:14,marginLeft:8}}>Dismiss</button>
            </div>}
            {autoRedeemNotice&&(autoRedeemNotice.ok
              ? <div style={{background:"rgba(60,120,80,0.95)",padding:"8px 16px",textAlign:"center",fontSize:15,color:"white",fontFamily:"var(--font-body)"}}>
                  ✓ Your invite code was applied — {TIER_INFO[autoRedeemNotice.tier]?TIER_INFO[autoRedeemNotice.tier].name:autoRedeemNotice.tier} is now active.
                  <button onClick={()=>setAutoRedeemNotice(null)} style={{background:"none",border:"none",color:"white",textDecoration:"underline",cursor:"pointer",fontSize:14,marginLeft:8}}>Dismiss</button>
                </div>
              : <div style={{background:"rgba(140,73,54,0.95)",padding:"8px 16px",textAlign:"center",fontSize:15,color:"white",fontFamily:"var(--font-body)"}}>
                  ⚠ Couldn't apply your invite code automatically ({
                    autoRedeemNotice.reason==="not_signed_in" ? "session wasn't ready yet"
                    : autoRedeemNotice.reason==="already_paying_subscriber" ? "this account already has an active subscription"
                    : autoRedeemNotice.reason==="not_a_comp_code" ? "that code has no automatic access attached"
                    : autoRedeemNotice.message || autoRedeemNotice.reason || "unknown reason"
                  }). You can enter it manually in Settings → "Have a code?".
                  <button onClick={()=>setAutoRedeemNotice(null)} style={{background:"none",border:"none",color:"white",textDecoration:"underline",cursor:"pointer",fontSize:14,marginLeft:8}}>Dismiss</button>
                </div>
            )}
            {showTrial&&<div style={{background:"rgba(209,154,74,0.97)",padding:"8px 16px",display:"flex",alignItems:"center",justifyContent:"center",gap:12,flexWrap:"wrap",fontSize:14,color:"#1f231d",fontFamily:"var(--font-body)"}}>
              <span>Your {TIER_INFO[trialExpired.tier]?TIER_INFO[trialExpired.tier].name:"trial"} trial has ended.</span>
              {trialBannerErr&&<span style={{fontSize:13}}>{trialBannerErr}</span>}
              <button disabled={trialBannerBusy} onClick={async()=>{setTrialBannerBusy(true);setTrialBannerErr("");try{await startCheckout(trialExpired.tier);}catch(e){setTrialBannerErr(e.message);setTrialBannerBusy(false);}}}
                style={{background:"#1f231d",border:"none",borderRadius:6,padding:"5px 12px",color:"var(--gold)",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"var(--font-body)"}}>
                {trialBannerBusy?"Opening…":"Upgrade"}
              </button>
              <button onClick={()=>setTrialBannerDismissed(trialExpired.expiredAt)} aria-label="Dismiss"
                style={{background:"none",border:"none",color:"#1f231d",fontSize:16,cursor:"pointer",lineHeight:1,padding:"0 2px"}}>
                ×
              </button>
            </div>}
          </div>
        );
        return null;
      })()}
      <input ref={camRef} type="file" accept="image/*" capture="environment" style={{display:"none"}} onChange={handlePhoto}/>
      <input ref={galRef} type="file" accept="image/*" multiple style={{display:"none"}} onChange={handlePhoto}/>

      <div className={`main${addOpen?" off":""}`}>
        <div className="hdr">
          {btnPos&&!addOpen&&createPortal(
            <div ref={settingsWrapRef} style={{position:"fixed",top:btnPos.top,right:btnPos.right,zIndex:2001,display:"flex",gap:8,alignItems:"flex-start"}}>
              {user?<>
                <button onClick={openSettings} aria-label="Settings"
                  style={{background:showSettings?"rgba(209,154,74,0.18)":"rgba(0,0,0,0.3)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:10,padding:"6px 10px",color:"var(--stone)",fontSize:15,cursor:"pointer",fontFamily:"var(--font-body)"}}>
                  ⚙
                </button>
                <button disabled={signOutBusy} onClick={handleSignOut}
                  style={{background:"rgba(0,0,0,0.3)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:10,padding:"6px 12px",color:"var(--stone)",fontSize:15,cursor:signOutBusy?"default":"pointer",fontFamily:"var(--font-body)",opacity:signOutBusy?0.6:1}}>
                  {signOutBusy?"Signing out…":"Sign Out"}
                </button>
              </>:(
                <button onClick={()=>onRequestAuth&&onRequestAuth("")}
                  style={{background:"var(--gold)",border:"none",borderRadius:10,padding:"6px 14px",color:"#0c1e25",fontSize:15,fontWeight:600,cursor:"pointer",fontFamily:"var(--font-body)"}}>
                  Sign In
                </button>
              )}
            </div>,
            document.body
          )}
          {showSettings&&settingsPos&&createPortal(
              <div style={{position:"fixed",top:settingsPos.top,right:settingsPos.right,background:"#0c1e25",border:"1px solid rgba(209,154,74,0.3)",borderRadius:12,padding:"14px 16px",minWidth:210,boxShadow:"0 8px 24px rgba(0,0,0,0.5)",textAlign:"left",zIndex:2000}}>
                <div style={{fontSize:13,color:"var(--gold)",letterSpacing:1.5,textTransform:"uppercase",marginBottom:10}}>Settings</div>
                <div style={{fontSize:14,color:"var(--foam)",fontFamily:"var(--font-body)",marginBottom:10,paddingBottom:10,borderBottom:"1px solid rgba(255,255,255,0.1)",wordBreak:"break-all"}}>
                  {user?.email||"(not signed in)"}
                </div>
                <div style={{fontSize:13,color:"var(--gold)",letterSpacing:1.5,textTransform:"uppercase",marginBottom:6}}>Plan</div>
                <div style={{fontSize:15,color:"var(--foam)",fontFamily:"var(--font-body)",marginBottom:8}}>
                  Current: {tier==="free"?"Free":(TIER_INFO[tier]?TIER_INFO[tier].name:tier)}
                </div>
                {tierDebug&&<div style={{fontSize:11,color:"var(--stone)",fontFamily:"monospace",marginBottom:10,padding:"6px 8px",background:"rgba(0,0,0,0.25)",borderRadius:6,wordBreak:"break-all",lineHeight:1.5}}>
                  uid:{tierDebug.uid||"none"} · try:{tierDebug.attempt||"-"}{tierDebug.error?` · err:${tierDebug.error}`:""}{tierDebug.note?` · ${tierDebug.note}`:""}{tierDebug.data?` · row:{tier:${tierDebug.data.tier},status:${tierDebug.data.status},comped:${tierDebug.data.is_comped},end:${tierDebug.data.current_period_end}}`:""}
                </div>}
                {tier!=="free"&&<button disabled={settingsUpgradeBusy==="portal"} onClick={async()=>{setSettingsUpgradeBusy("portal");setSettingsUpgradeErr("");try{await startPortal();}catch(e){setSettingsUpgradeErr(e.message);setSettingsUpgradeBusy(null);}}}
                  style={{display:"block",width:"100%",textAlign:"left",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:8,padding:"8px 10px",color:"var(--foam)",fontSize:14,marginBottom:10,cursor:"pointer",fontFamily:"var(--font-body)"}}>
                  {settingsUpgradeBusy==="portal"?"Opening…":"⚙ Manage Subscription"}
                </button>}
                {settingsUpgradeErr&&<div style={{fontSize:12,color:"var(--red)",marginBottom:6}}>{settingsUpgradeErr}</div>}
                {tier!=="guide_pro"&&<>
                  <BillingToggle billing={settingsBilling} onChange={setSettingsBilling}/>
                  {tier==="free"&&<button disabled={settingsUpgradeBusy==="consumer_pro"} onClick={async()=>{setSettingsUpgradeBusy("consumer_pro");setSettingsUpgradeErr("");try{await startCheckout("consumer_pro",settingsBilling);}catch(e){setSettingsUpgradeErr(e.message);setSettingsUpgradeBusy(null);}}}
                    style={{display:"block",width:"100%",textAlign:"left",background:"rgba(209,154,74,0.12)",border:"1px solid rgba(209,154,74,0.3)",borderRadius:8,padding:"8px 10px",color:"var(--foam)",fontSize:14,marginBottom:6,cursor:"pointer",fontFamily:"var(--font-body)"}}>
                    {settingsUpgradeBusy==="consumer_pro"?"Starting…":`Upgrade to Consumer Pro — ${settingsBilling==="annual"?TIER_INFO.consumer_pro.priceAnnual:TIER_INFO.consumer_pro.price}`}
                  </button>}
                  <button disabled={settingsUpgradeBusy==="guide_pro"} onClick={async()=>{setSettingsUpgradeBusy("guide_pro");setSettingsUpgradeErr("");try{await startCheckout("guide_pro",settingsBilling);}catch(e){setSettingsUpgradeErr(e.message);setSettingsUpgradeBusy(null);}}}
                    style={{display:"block",width:"100%",textAlign:"left",background:"rgba(209,154,74,0.12)",border:"1px solid rgba(209,154,74,0.3)",borderRadius:8,padding:"8px 10px",color:"var(--foam)",fontSize:14,marginBottom:10,cursor:"pointer",fontFamily:"var(--font-body)"}}>
                    {settingsUpgradeBusy==="guide_pro"?"Starting…":`Upgrade to Guide Pro — ${settingsBilling==="annual"?TIER_INFO.guide_pro.priceAnnual:TIER_INFO.guide_pro.price}`}
                  </button>
                  <div style={{fontSize:13,color:"var(--gold)",letterSpacing:1.5,textTransform:"uppercase",marginBottom:6}}>Have a code?</div>
                  <div style={{display:"flex",gap:6,marginBottom:10}}>
                    <input value={redeemCode} onChange={e=>setRedeemCode(e.target.value)} placeholder="Enter code"
                      onKeyDown={e=>{if(e.key==="Enter") handleRedeemCode();}}
                      style={{flex:1,minWidth:0,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:8,padding:"7px 9px",color:"var(--foam)",fontSize:14,fontFamily:"var(--font-body)"}}/>
                    <button disabled={redeemBusy||!redeemCode.trim()} onClick={handleRedeemCode}
                      style={{background:"rgba(209,154,74,0.18)",border:"1px solid rgba(209,154,74,0.3)",borderRadius:8,padding:"7px 12px",color:"var(--foam)",fontSize:14,cursor:"pointer",fontFamily:"var(--font-body)"}}>
                      {redeemBusy?"…":"Apply"}
                    </button>
                  </div>
                  {redeemMsg&&<div style={{fontSize:12,marginTop:-4,marginBottom:10,color:redeemMsg.type==="ok"?"var(--moss)":"var(--red)"}}>{redeemMsg.text}</div>}
                </>}
                <label style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,cursor:"pointer",fontSize:15,color:"var(--foam)",fontFamily:"var(--font-body)"}}>
                  <span>🧭 Guide tab</span>
                  <input type="checkbox" checked={!hideGuide} onChange={toggleGuide} style={{width:18,height:18,accentColor:"#d09a4a",cursor:"pointer"}}/>
                </label>
                <div style={{fontSize:13,color:"var(--stone)",marginTop:8,lineHeight:1.5}}>Hide the Guide tab if you don't run client trips. Your guide data is kept safe.</div>
                <div style={{borderTop:"1px solid rgba(255,255,255,0.1)",marginTop:12,paddingTop:10,display:"flex",gap:14,flexWrap:"wrap"}}>
                  <a href="mailto:adam@guideschoicefishing.com" style={{fontSize:13,color:"var(--sky)",textDecoration:"none"}}>✉ Contact Support</a>
                  <a href="/privacy.html" target="_blank" rel="noreferrer" style={{fontSize:13,color:"var(--sky)",textDecoration:"none"}}>Privacy Policy</a>
                  <a href="/terms.html" target="_blank" rel="noreferrer" style={{fontSize:13,color:"var(--sky)",textDecoration:"none"}}>Terms</a>
                </div>
              </div>,
              document.body
            )}
          <div style={{textAlign:"left"}}><Logo layout="horizontal" scale={0.58} tagline={false} /></div>
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
          {[{id:"conditions",icon:<IconTarget/>,label:"Intel"},{id:"log",icon:<IconFish/>,label:"Catch Log"},{id:"plan",icon:<IconCalendar/>,label:"Plan"},{id:"guide",icon:<IconCompass/>,label:"Guide"}].filter(t=>t.id!=="guide"||!hideGuide).map(t=>(
            <button key={t.id} className={`nb${tab===t.id?" on":""}`} onClick={()=>{
              // Guests may browse Intel (live conditions), Log (sample catches), and
              // Plan (sample report) — all previews needing no account. Guide is the
              // CRM and has nothing meaningful to preview, so it still prompts.
              if(!user&&t.id==="guide"){onRequestAuth&&onRequestAuth("Create a free account to use "+t.label+".");return;}
              setTab(t.id);if(t.id==="conditions"&&sb&&user?.id)sb.from("saved_gauges").select("*").eq("user_id",user.id).then(({data})=>{if(data)setSavedGauges(data);});
            }}>
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
                  <button key={id} onClick={()=>{setIntelTab(id);if(id==="report")setHatchAutoRun(true);}} style={{fontSize:15,padding:"6px 16px",borderRadius:20,border:"1px solid rgba(209,154,74,0.3)",background:intelTab===id?"rgba(209,154,74,0.25)":"rgba(255,255,255,0.05)",color:intelTab===id?"var(--gold)":"var(--stone)",cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>{label}</button>
                ))}
              </div>
              {intelTab==="weather"&&<>
              <div className="card">
                <div className="ctitle">🌡 Weather & Fishing Read<button className="rfsh" onClick={()=>loadConditions(loc)}>↻ Refresh</button></div>
                {wxLoading&&<div className="loading">Fetching weather…</div>}
                {wxError&&<div className="err">{wxError}</div>}
                {wxForecast&&!wxLoading&&<WeekForecast data={wxForecast}/>}
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
                moveSavedGauge={moveSavedGauge}
                fetchSavedGaugeData={fetchSavedGaugeData}
                cfsLabel={cfsLabel}
              />}
              <div style={{marginBottom:12}}>
                {showAddGauge?(
                  <div className="card">
                    <div style={{fontSize:15,color:"var(--gold)",marginBottom:8,fontFamily:"var(--font-head)"}}>⭐ Add a Gauge</div>
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
                  <span style={{fontSize:15,color:"var(--gold)",fontFamily:"var(--font-head)"}}>🗺 Nearby Waters{gauges.length>0&&" · "+gauges.length+" gauges"}</span>
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
                    <div style={{fontSize:14,color:"var(--foam)",fontFamily:"var(--font-body)",fontWeight:600}}>{s.name}</div>
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

          {tab==="log"&&!user&&<SampleCatchLog onSignUp={reason=>onRequestAuth&&onRequestAuth(reason)}/>}
          {tab==="log"&&user&&<>
            <div className="lhdr" style={{flexDirection:"column",gap:8}}>
              <div style={{display:"flex",gap:6}}>
                <button onClick={()=>setCatchLogTab("list")} style={{fontSize:14,padding:"4px 12px",borderRadius:20,border:"1px solid rgba(209,154,74,0.3)",background:catchLogTab==="list"?"rgba(209,154,74,0.25)":"rgba(255,255,255,0.05)",color:catchLogTab==="list"?"var(--gold)":"var(--stone)",cursor:"pointer"}}>📋 Log</button>
                <button onClick={()=>setCatchLogTab("photos")} style={{fontSize:14,padding:"4px 12px",borderRadius:20,border:"1px solid rgba(209,154,74,0.3)",background:catchLogTab==="photos"?"rgba(209,154,74,0.25)":"rgba(255,255,255,0.05)",color:catchLogTab==="photos"?"var(--gold)":"var(--stone)",cursor:"pointer"}}>📷 Photos</button>
                <button onClick={()=>setCatchLogTab("trips")} style={{fontSize:14,padding:"4px 12px",borderRadius:20,border:"1px solid rgba(209,154,74,0.3)",background:catchLogTab==="trips"?"rgba(209,154,74,0.25)":"rgba(255,255,255,0.05)",color:catchLogTab==="trips"?"var(--gold)":"var(--stone)",cursor:"pointer"}}>🧾 Trips</button>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",width:"100%"}}>
                <span className="lttl">My Catches · {catches.length} fish</span>
                <button className="btn" style={{padding:"6px 12px",fontSize:15}} onClick={()=>{
                  const rows=[["Species","Length","Flies","GPS","Date","Notes"],...catchesByDate.map(c=>[c.species,c.length,c.flies.join("|"),c.gps,c.time,c.notes])];
                  const csv=rows.map(r=>r.map(v=>`"${(v||"").toString().replace(/"/g,'""')}"`).join(",")).join("\n");
                  const a=document.createElement("a");a.href="data:text/csv;charset=utf-8,"+encodeURIComponent(csv);a.download="tight-lines-catches.csv";a.click();
                }}>⬇ CSV</button>
              </div>
              <button onClick={enrichCatches} disabled={enriching} style={{width:"100%",marginTop:6,background:"rgba(44,95,110,0.2)",border:"1px solid rgba(44,95,110,0.4)",borderRadius:10,padding:"8px",color:"var(--sky)",fontSize:15,cursor:"pointer",fontFamily:"var(--font-body)"}}>{enriching?"⏳ Updating catch data…":"🔄 Update Catch Data"}</button>
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
              // Build Leaflet map in iframe with real map tiles. Tapping a pin posts a
              // message to the parent window (see the gc_catch_pin_tap listener above)
              // instead of showing a text popup, so it opens the real CatchCard directly.
              const markers=cr.map((co,i)=>{
                const c=wg[i];
                return `L.circleMarker([${co.lat},${co.lng}],{radius:8,fillColor:'#d09a4a',color:'#876430',weight:2,fillOpacity:0.85}).addTo(map).on('click',function(){window.parent.postMessage({type:'gc_catch_pin_tap',id:${JSON.stringify(c.id)}},'*');});`;
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
                    <span style={{fontSize:15,color:"var(--gold)",fontFamily:"var(--font-head)"}}>📍 Catch Locations · {wg.length} mapped</span>
                  </div>
                  <iframe title="Catch map" srcDoc={mapHtml} style={{width:"100%",height:280,border:"none",display:"block"}} sandbox="allow-scripts allow-same-origin allow-popups"/>
                </div>
              );
            })()}
            {catchLogTab==="photos"?<PhotoJournal catches={catchesByDate} onPhotoClick={(url,id)=>{setLightboxPhoto(url);setLightboxCatchId(id||null);}}/>:catchLogTab==="trips"?(
              <div>
                <input ref={logTripPhotoRef} type="file" accept="image/*" multiple style={{display:"none"}} onChange={handleLogTripPhoto}/>
                {!showLogTripForm&&(
                  <button className="btn btnp" onClick={()=>{setLogTripForm(logTripForm0);setShowCatchPicker(false);setShowLogTripForm(true);}} style={{width:"100%",marginBottom:12}}>+ Log a Trip</button>
                )}

                {showLogTripForm&&(
                  <div className="card" style={{marginBottom:12}}>
                    <div className="ctitle">Log a Trip</div>
                    <div style={{fontSize:14,color:"var(--stone)",marginTop:8,marginBottom:3}}>Date</div>
                    <input className="inp" type="date" value={logTripForm.date} onChange={e=>setLogTripForm(f=>({...f,date:e.target.value}))}/>
                    <div style={{fontSize:14,color:"var(--stone)",marginTop:2,marginBottom:3}}>Location</div>
                    <TripLocationWeather tripForm={logTripForm} setTripForm={setLogTripForm}/>
                    <div style={{fontSize:14,color:"var(--stone)",marginTop:2,marginBottom:6}}>Technique(s)</div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:12}}>
                      {FISHING_STYLES.map(s=>(
                        <button key={s} onClick={()=>toggleLogTripTechnique(s)}
                          style={{fontSize:14,padding:"5px 12px",borderRadius:20,border:"1px solid rgba(209,154,74,0.3)",background:logTripForm.techniques.includes(s)?"rgba(209,154,74,0.25)":"rgba(255,255,255,0.05)",color:logTripForm.techniques.includes(s)?"var(--gold)":"var(--stone)",cursor:"pointer"}}>{s}</button>
                      ))}
                    </div>
                    <div style={{fontSize:14,color:"var(--stone)",marginBottom:3}}>Notes (optional)</div>
                    <input className="inp" style={{marginBottom:14}} value={logTripForm.notes} onChange={e=>setLogTripForm(f=>({...f,notes:e.target.value}))}/>

                    <label className="lbl">Catches</label>
                    <div style={{display:"flex",gap:8,marginBottom:10}}>
                      <button className="pbtn" style={{flex:1}} onClick={()=>logTripPhotoRef.current.click()}><span className="pi">📷</span>Upload Photos</button>
                      <button className="pbtn" style={{flex:1}} onClick={()=>setShowCatchPicker(v=>!v)}><span className="pi">🎣</span>From Catch Log</button>
                    </div>

                    {showCatchPicker&&(
                      <div style={{background:"rgba(0,0,0,0.25)",borderRadius:12,padding:10,marginBottom:12}}>
                        <div style={{fontSize:14,color:"var(--stone)",marginBottom:8}}>Tap catches not already on another trip to add them</div>
                        {catches.filter(c=>!c.tripId).length===0&&<div style={{fontSize:14,color:"var(--stone)",fontStyle:"italic"}}>No unlinked catches yet.</div>}
                        <div style={{maxHeight:300,overflowY:"auto"}}>
                          {catchesByDate.filter(c=>!c.tripId).map(c=>{
                            const picked=logTripForm.linkedCatchIds.includes(c.id);
                            return (
                              <div key={c.id} onClick={()=>setLogTripForm(f=>({...f,linkedCatchIds:picked?f.linkedCatchIds.filter(x=>x!==c.id):[...f.linkedCatchIds,c.id]}))}
                                style={{display:"flex",gap:10,alignItems:"center",padding:8,borderRadius:10,marginBottom:6,cursor:"pointer",background:picked?"rgba(209,154,74,0.18)":"rgba(0,0,0,0.2)",border:"1px solid "+(picked?"rgba(209,154,74,0.4)":"rgba(255,255,255,0.08)")}}>
                                {c.photo?<img src={toThumbUrl(c.photo)} style={{width:44,height:44,objectFit:"cover",borderRadius:8}} alt="catch" loading="lazy" onError={e=>{e.target.onerror=null;e.target.src=c.photo;}}/>:<div style={{width:44,height:44,borderRadius:8,background:"rgba(255,255,255,0.05)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>🐟</div>}
                                <div style={{flex:1,fontSize:15,color:"var(--foam)"}}>{c.species}{c.length?` · ${c.length}"`:""}<div style={{fontSize:13,color:"var(--stone)"}}>{c.time}</div></div>
                                <span style={{fontSize:18,color:picked?"var(--gold)":"var(--stone)"}}>{picked?"✓":"+"}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {logTripForm.photos.length>0&&(
                      <div style={{marginBottom:12}}>
                        {logTripForm.photos.map((p,i)=>{
                          const cd=(logTripForm.catchDetails||[])[i]||{};
                          return(
                            <div key={i} style={{display:"flex",gap:10,background:"rgba(0,0,0,0.2)",borderRadius:12,padding:10,marginBottom:8,alignItems:"flex-start"}}>
                              <div style={{position:"relative",flexShrink:0}}>
                                <img src={p} style={{width:64,height:64,objectFit:"cover",borderRadius:8}} alt="catch" loading="lazy"/>
                                <button onClick={()=>setLogTripForm(f=>({...f,photos:f.photos.filter((_,j)=>j!==i),catchDetails:(f.catchDetails||[]).filter((_,j)=>j!==i)}))}
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
                                </>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {logTripForm.linkedCatchIds.length>0&&(
                      <div style={{marginBottom:12}}>
                        {logTripForm.linkedCatchIds.map(id=>{
                          const c=catches.find(c2=>c2.id===id);
                          if(!c) return null;
                          return(
                            <div key={id} style={{display:"flex",gap:10,background:"rgba(0,0,0,0.2)",borderRadius:12,padding:10,marginBottom:8,alignItems:"center"}}>
                              {c.photo?<img src={toThumbUrl(c.photo)} style={{width:48,height:48,objectFit:"cover",borderRadius:8}} alt="catch" loading="lazy" onError={e=>{e.target.onerror=null;e.target.src=c.photo;}}/>:<div style={{width:48,height:48,borderRadius:8,background:"rgba(255,255,255,0.05)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20}}>🐟</div>}
                              <div style={{flex:1,fontSize:15,color:"var(--foam)"}}>{c.species}{c.length?` · ${c.length}"`:""}<div style={{fontSize:14,color:"var(--stone)"}}>{c.time}</div></div>
                              <button onClick={()=>setLogTripForm(f=>({...f,linkedCatchIds:f.linkedCatchIds.filter(x=>x!==id)}))} style={{background:"none",border:"none",color:"var(--stone)",fontSize:16,cursor:"pointer"}}>✕</button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {(logTripForm.photos.length+logTripForm.linkedCatchIds.length)===0&&(
                      <div style={{fontSize:14,color:"var(--stone)",fontStyle:"italic",marginBottom:12}}>No catches added — will be recorded as skunked.</div>
                    )}

                    <div style={{display:"flex",gap:8}}>
                      <button className="btn" style={{flex:1}} onClick={()=>{setShowLogTripForm(false);setShowCatchPicker(false);setLogTripForm(logTripForm0);}}>Cancel</button>
                      <button className="btn btnp" style={{flex:1,opacity:savingPersonalTrip?0.6:1}} disabled={savingPersonalTrip} onClick={saveLogTrip}>{savingPersonalTrip?"⏳ Saving…":"Save Trip"}</button>
                    </div>
                  </div>
                )}

                {personalTripsLoading&&<div className="loading">Loading trips…</div>}
                {!personalTripsLoading&&personalTrips.length===0&&(
                  <div className="empty"><div className="ei">🧾</div><p>No trips logged yet.<br/>"Log a Trip" tracks a full session — including the ones where nothing bites.</p></div>
                )}
                {personalTrips.map(t=>{
                  const tripCatches=catches.filter(c=>c.tripId===t.id);
                  const tripPhotos=tripCatches.filter(c=>c.photo);
                  const totalCatches=tripCatches.length+(t.extraCatches||0);
                  return(
                    <div className="card" key={t.id} style={{marginBottom:10,cursor:"pointer"}} onClick={()=>setPersonalTripDetail(t)}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                        <span style={{fontFamily:"var(--font-head)",fontSize:17,color:"var(--gold)",fontStyle:"italic"}}>
                          {new Date((t.date||(t.startTime?t.startTime.split("T")[0]:new Date().toISOString().split("T")[0]))+"T12:00:00").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric",year:"numeric"})}
                        </span>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          {t.skunked&&<span style={{fontSize:14,color:"var(--stone)",fontStyle:"italic"}}>Skunked</span>}
                          <button onClick={e=>{e.stopPropagation();deletePersonalTrip(t.id);}} style={{background:"none",border:"none",color:"var(--stone)",fontSize:16,cursor:"pointer",padding:2}}>🗑</button>
                        </div>
                      </div>
                      {t.location&&<div style={{fontSize:15,color:"var(--stone)",marginTop:4}}>📍 {t.location}</div>}
                      <div style={{fontSize:15,color:"var(--stone)",marginTop:4}}>
                        🐟 {totalCatches} catch{totalCatches!==1?"es":""}
                      </div>
                      {t.techniques?.length>0&&<div style={{fontSize:15,color:"var(--stone)",marginTop:4}}>🎣 {t.techniques.join(", ")}</div>}
                      {t.streamCFS&&<div style={{fontSize:15,color:"var(--stone)",marginTop:4}}>💧 {t.streamCFS} CFS</div>}
                      {t.notes&&<div style={{fontSize:15,color:"var(--stone)",marginTop:4,fontStyle:"italic"}}>{t.notes}</div>}
                      {tripPhotos.length>0&&(
                        <div style={{display:"flex",gap:6,marginTop:8}}>
                          {tripPhotos.slice(0,4).map((c,i)=>(
                            <img key={i} src={toThumbUrl(c.photo)} alt="" loading="lazy" style={{width:52,height:52,objectFit:"cover",borderRadius:8,border:"1px solid rgba(255,255,255,0.1)"}} onError={e=>{e.target.onerror=null;e.target.src=c.photo;}}/>
                          ))}
                          {tripPhotos.length>4&&<div style={{width:52,height:52,borderRadius:8,background:"rgba(0,0,0,0.25)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,color:"var(--stone)"}}>+{tripPhotos.length-4}</div>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ):<CatchPatterns catches={catches}/>}
          {catchLogTab==="list"&&catches.length===0&&<div className="empty"><div className="ei">🎣</div><p>No catches yet.<br/>Tap + to record your first!</p></div>}
            {catchLogTab==="list"&&catchesByDate.map(c=>(
              <CatchCard key={c.id} c={c}
                editingCatchId={editingCatchId} setEditingCatchId={setEditingCatchId}
                sharingCatchId={sharingCatchId} setSharingCatchId={setSharingCatchId}
                sharingBusy={sharingBusy} shareCatch={shareCatch} deleteCatch={deleteCatch} updateCatch={updateCatch}
                editCatchFlyInput={editCatchFlyInput} setEditCatchFlyInput={setEditCatchFlyInput}
                setLightboxPhoto={setLightboxPhoto} setLightboxCatchId={setLightboxCatchId} setCropCatchId={setCropCatchId}/>
            ))}
          </>}

          {tab==="plan"&&(!user
            ? <TripPlanner key="trip-planner-sample" sampleMode onSignUp={reason=>onRequestAuth&&onRequestAuth(reason)} defaultLocation="" parentGauges={[]} savedGauges={[]} parentLoc={null} user={null} anglerHistory={null}/>
            : ((tierChecking&&tier==="free")?<CheckingPlan/>:(PLAN_TIERS.has(tier)?<TripPlanner defaultLocation={loc?.label||""} key="trip-planner" parentGauges={gauges} savedGauges={savedGauges} parentLoc={loc} openReportId={pendingReportId} onOpenedReportId={()=>setPendingReportId(null)} user={user} anglerHistory={buildAnglerHistorySummary(personalTrips,catches)}/>:<UpgradeLock tierKey="consumer_pro" featureLabel="The AI Trip Planner"/>)))}
          {tab==="guide"&&!hideGuide&&((tierChecking&&tier==="free")?<CheckingPlan/>:(GUIDE_TIERS.has(tier)?<GuideBook user={user} loc={loc}/>:<UpgradeLock tierKey="guide_pro" featureLabel="The Guide CRM"/>))}
        </div>

        {batchProgress&&(
          <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.7)",zIndex:9000,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <div style={{background:"var(--water)",borderRadius:16,padding:"28px 32px",textAlign:"center",maxWidth:300}}>
              <div style={{fontSize:32,marginBottom:12}}>📷</div>
              <div style={{fontFamily:"var(--font-head)",fontSize:18,color:"var(--foam)",marginBottom:8}}>Adding Catches</div>
              <div style={{fontSize:15,color:"var(--stone)",marginBottom:16}}>{batchProgress.done} of {batchProgress.total} photos processed</div>
              <div style={{background:"rgba(0,0,0,0.3)",borderRadius:8,height:8,overflow:"hidden"}}>
                <div style={{height:"100%",background:"var(--gold)",borderRadius:8,width:`${(batchProgress.done/batchProgress.total)*100}%`,transition:"width 0.3s"}}/>
              </div>
              {batchProgress.done===batchProgress.total&&<div style={{marginTop:12,fontSize:15,color:"#9cd47a"}}>✓ All done!</div>}
            </div>
          </div>
        )}
        {tab==="log"&&(
          <button className="fab" onClick={()=>{
            if(!user){onRequestAuth&&onRequestAuth("Create a free account to start your own catch log.");return;}
            setForm(blank);setAddOpen(true);
          }}
            style={{position:"fixed",bottom:28,right:"max(20px, calc(50% - 195px))"}}>＋</button>
        )}
      </div>

      {cropCatchId&&(()=>{
        const cropCatch=catches.find(c2=>c2.id===cropCatchId);
        if(!cropCatch?.photo){ setCropCatchId(null); return null; }
        return <PhotoCropModal key={cropCatchId} photoUrl={cropCatch.photo}
          onSave={dataUrl=>handleCropSave(cropCatchId,dataUrl)}
          onCancel={()=>setCropCatchId(null)}/>;
      })()}

      {personalTripDetail&&(()=>{
        const live=personalTrips.find(t=>t.id===personalTripDetail.id)||personalTripDetail;
        return <PersonalTripDetailModal trip={live} catches={catches} tier={tier}
          onClose={()=>setPersonalTripDetail(null)}
          onGenerateIntel={handleGenerateTripIntel}
          intelLoading={personalIntelLoading} intelError={personalIntelError}
          onSaveTrip={handleSavePersonalTrip} tripSaving={personalTripSaving} tripSaveError={personalTripSaveError}
          onAdjustExtraCatches={adjustExtraCatches}
          catchCardProps={{
            editingCatchId,setEditingCatchId,sharingCatchId,setSharingCatchId,sharingBusy,shareCatch,
            deleteCatch,updateCatch,editCatchFlyInput,setEditCatchFlyInput,
            setLightboxPhoto,setLightboxCatchId,setCropCatchId
          }}/>;
      })()}

      {mapPinCatchId&&(()=>{
        const pc=catches.find(c2=>c2.id===mapPinCatchId);
        if(!pc){ setMapPinCatchId(null); return null; }
        return (
          <div style={{position:"fixed",inset:0,zIndex:2500,background:"rgba(10,20,17,0.82)",display:"flex",alignItems:"center",justifyContent:"center",padding:20,overflowY:"auto"}}
            onClick={e=>{if(e.target===e.currentTarget)setMapPinCatchId(null);}}>
            <div style={{position:"relative",width:"100%",maxWidth:420,maxHeight:"88vh",overflowY:"auto"}}>
              <button onClick={()=>setMapPinCatchId(null)} aria-label="Close"
                style={{position:"absolute",top:-10,right:-4,width:32,height:32,borderRadius:"50%",background:"rgba(255,255,255,0.15)",border:"1px solid rgba(255,255,255,0.3)",color:"var(--foam)",fontSize:16,cursor:"pointer",zIndex:2}}>✕</button>
              <CatchCard c={pc}
                editingCatchId={editingCatchId} setEditingCatchId={setEditingCatchId}
                sharingCatchId={sharingCatchId} setSharingCatchId={setSharingCatchId}
                sharingBusy={sharingBusy} shareCatch={shareCatch} deleteCatch={deleteCatch} updateCatch={updateCatch}
                editCatchFlyInput={editCatchFlyInput} setEditCatchFlyInput={setEditCatchFlyInput}
                setLightboxPhoto={setLightboxPhoto} setLightboxCatchId={setLightboxCatchId} setCropCatchId={setCropCatchId}/>
            </div>
          </div>
        );
      })()}

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
          {form.sizeEstimating&&<div style={{fontSize:15,color:"var(--gold)",fontStyle:"italic",marginBottom:8,padding:"8px 12px",background:"rgba(209,154,74,0.1)",borderRadius:8}}>🤖 Identifying fish…</div>}
          {form.idNote&&!form.sizeEstimating&&<div style={{fontSize:15,color:"var(--red)",marginBottom:8,padding:"8px 12px",background:"rgba(150,80,80,0.15)",border:"1px solid rgba(150,80,80,0.3)",borderRadius:8}}>⚠️ {form.idNote}</div>}
          <label className="lbl">Species</label>
          <SpeciesInput value={form.species} onChange={val=>setForm(f=>({...f,species:val}))}/>
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
                {form.streamCFS&&<span style={{fontSize:14,color:"var(--foam)"}}>💧 {form.streamCFS} CFS</span>}
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


// Loading screen shown while cold-launch auth is resolving (the very first session
// check on page load/refresh). The existing 8s automatic recovery (attemptAuthRecovery,
// inside useAuth's mount effect) already retries this on its own if the underlying
// Supabase auth-lock issue strikes here — but sitting on a bare "Loading…" with no
// indication anything might be wrong and no way to act is exactly the kind of silent
// experience this project avoids elsewhere (every other failure gets a visible banner
// and a way to retry). Added after a live "code red" report of this screen hanging on
// open. After a few seconds, shows a manual reload option so a person is never stuck
// purely waiting on an invisible timer — clears the one-shot recovery flag first so a
// deliberate manual click always gets a fresh attempt, even if the automatic one-shot
// already fired earlier this tab session.
function AuthLoadingScreen(){
  const [showEscape,setShowEscape]=useState(false);
  useEffect(()=>{
    const t=setTimeout(()=>setShowEscape(true),5000);
    return ()=>clearTimeout(t);
  },[]);
  return(
    <div style={{minHeight:"100vh",background:"var(--deep)",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{textAlign:"center"}}>
        <img src="/logo-badge.png" alt="Guide's Choice Fishing — Find the Pattern" style={{width:88,height:88,objectFit:"contain",display:"block",margin:"0 auto 12px"}}/>
        <div style={{fontFamily:"var(--font-head)",fontSize:18,color:"var(--sky)",animation:"pulse 1.5s infinite"}}>Loading…</div>
        {showEscape&&<div style={{marginTop:20}}>
          <div style={{fontSize:14,color:"var(--stone)",marginBottom:10}}>Taking longer than usual.</div>
          <button onClick={()=>{
              // A deliberate manual click, after already waiting, is a strong enough signal
              // to skip straight to the strongest fix rather than hope a soft reload is
              // enough — same as manually signing out: clears the recovery counter (so the
              // automatic tiers get a fresh start too) AND wipes the stored session before
              // reloading. Will require signing in again, same as a manual sign-out would.
              try{ sessionStorage.removeItem("gc_auth_recover_attempted"); }catch(e){}
              try{ Object.keys(localStorage).forEach(k=>{ if(k.startsWith("sb-")) localStorage.removeItem(k); }); }catch(e){}
              window.location.reload();
            }}
            style={{background:"rgba(209,154,74,0.15)",border:"1px solid rgba(209,154,74,0.4)",borderRadius:8,padding:"8px 22px",color:"var(--gold)",fontSize:14,cursor:"pointer",fontFamily:"var(--font-body)"}}>
            Reload &amp; Sign In Again
          </button>
        </div>}
      </div>
    </div>
  );
}
// ── First-visit welcome modal (signed-out visitors only) ───────────────────────
// Replaces the old 4-screen SplashScreen, which sat in front of the entire app and
// funneled everyone into a signup form before they'd seen a single number — the
// suspected main driver of the 90% bounce rate measured 2026-08-11→13.
//
// The app now loads straight to live Intel/conditions and this appears OVER it a few
// seconds later, so the first thing a visitor sees is real gauge data for their own
// area, not a form. Proof first, ask second.
//
// Shown only to signed-out visitors, once per browser SESSION (sessionStorage, not
// localStorage): dismissing it won't nag again during this visit, but someone who
// comes back another day gets one more chance to convert. Change to localStorage if
// that ever reads as too pushy.
const WELCOME_KEY = "gc_welcome_seen";
const WELCOME_DELAY_MS = 2600; // long enough for gauges/weather to populate behind it
function WelcomeModal({onSignUp, onDismiss}){
  const [vidOpen,setVidOpen]=useState(false);
  // Same YouTube Short (privacy-enhanced/no-cookie mode) the old splash used.
  const WELCOME_VIDEO_EMBED="https://www.youtube-nocookie.com/embed/4BpQmrpQj9U";
  return createPortal(
    <div style={{position:"fixed",inset:0,zIndex:4500,background:"rgba(8,18,24,0.78)",backdropFilter:"blur(3px)",display:"flex",alignItems:"center",justifyContent:"center",padding:20,overflowY:"auto"}}
      onClick={e=>{if(e.target===e.currentTarget)onDismiss();}}>
      <div style={{position:"relative",width:"100%",maxWidth:360,background:"linear-gradient(170deg,#0d1f26 0%,#16333f 60%,#0d2a1f 100%)",border:"1px solid rgba(209,154,74,0.35)",borderRadius:20,padding:"26px 24px 20px",textAlign:"center",boxShadow:"0 18px 50px rgba(0,0,0,0.5)"}}>
        <button onClick={onDismiss} aria-label="Close"
          style={{position:"absolute",top:10,right:12,background:"none",border:"none",color:"var(--stone)",fontSize:20,lineHeight:1,cursor:"pointer"}}>✕</button>
        <div style={{marginBottom:12,display:"flex",justifyContent:"center"}}><Logo layout="stacked" scale={0.42}/></div>
        <div style={{fontFamily:"var(--font-head)",fontWeight:700,fontSize:26,color:"var(--foam)",lineHeight:1.15,marginBottom:8}}>Know Before You Go</div>
        <p style={{fontFamily:"var(--font-body)",fontSize:14.5,color:"var(--sky)",lineHeight:1.5,margin:"0 0 18px"}}>
          Nearby streams, ranked best to worst by live flows, weather, and current conditions.
        </p>
        <button onClick={onSignUp}
          style={{width:"100%",background:"var(--gold)",color:"#0d1f26",border:"none",borderRadius:24,padding:"13px 20px",fontSize:16,fontFamily:"var(--font-head)",fontWeight:600,letterSpacing:0.5,cursor:"pointer",marginBottom:10}}>
          Create Free Account
        </button>
        <div style={{fontFamily:"var(--font-body)",fontSize:12.5,color:"var(--stone)",lineHeight:1.45,marginBottom:14}}>
          Free: save your home rivers, log catches, and track conditions daily.
        </div>
        <button onClick={onDismiss}
          style={{width:"100%",background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.18)",borderRadius:24,padding:"11px 20px",fontSize:15,fontFamily:"var(--font-body)",color:"var(--foam)",cursor:"pointer",marginBottom:16}}>
          Look Around First
        </button>
        <button onClick={()=>setVidOpen(true)}
          style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,width:"100%",background:"none",border:"none",color:"var(--sky)",fontSize:13.5,fontFamily:"var(--font-body)",cursor:"pointer",marginBottom:14}}>
          <span style={{width:0,height:0,borderTop:"5px solid transparent",borderBottom:"5px solid transparent",borderLeft:"8px solid var(--gold)"}}/>
          Watch the 30-second tour
        </button>
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
          <span style={{fontSize:12}}>🔒</span>
          <span style={{fontFamily:"var(--font-body)",fontSize:11.5,color:"var(--stone)"}}>Your spots stay private — encrypted, never shared.</span>
        </div>
      </div>
      {vidOpen&&(
        <div style={{position:"fixed",inset:0,background:"#000",zIndex:10000,display:"flex",alignItems:"center",justifyContent:"center"}}
          onClick={e=>e.stopPropagation()}>
          <iframe
            src={WELCOME_VIDEO_EMBED+"?autoplay=1&playsinline=1&rel=0"}
            title="Guide's Choice walkthrough"
            style={{width:"min(100vw, 56.25vh)",height:"100%",border:"none"}}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
          />
          <button onClick={()=>setVidOpen(false)} style={{position:"absolute",top:"max(16px, env(safe-area-inset-top))",right:16,background:"rgba(255,255,255,0.12)",border:"1px solid rgba(255,255,255,0.3)",borderRadius:20,padding:"8px 16px",color:"#fff",fontSize:16,cursor:"pointer",fontFamily:"var(--font-body)",zIndex:10001}}>✕ Close</button>
        </div>
      )}
    </div>,
    document.body
  );
}

// ── Add to Home Screen install prompt ──────────────────────────────────────────
// The manifest + apple meta tags already make the site installable; this is the UI
// that tells anyone that, since iOS gives no automatic prompt at all and Android's
// only fires if you capture beforeinstallprompt yourself.
//
// Portaled to document.body for the same stacking-context reason as the header
// buttons and the planner loading overlay. z-index 4000 sits below the planner
// takeover (5000) and the video modal (10000) so it can never cover them.
const A2HS_KEY="gc_a2hs_snooze";
const A2HS_SNOOZE_DAYS=14;
function isStandaloneMode(){
  try{
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone===true;
  }catch(_){return false;}
}
// In-app browsers (Instagram, Facebook, TikTok, LinkedIn, Twitter) can't install a PWA
// at all — showing them a prompt is a dead end, so they're excluded outright. This
// matters here specifically because Instagram is the main traffic source.
function isInAppBrowser(){
  const ua=String(navigator.userAgent||"");
  return /Instagram|FBAN|FBAV|FB_IAB|Line\/|TikTok|LinkedInApp|Twitter/i.test(ua);
}
function isIOSSafari(){
  const ua=String(navigator.userAgent||"");
  const iOS=/iPad|iPhone|iPod/.test(ua) || (navigator.platform==="MacIntel" && navigator.maxTouchPoints>1);
  if(!iOS) return false;
  // Chrome/Firefox/Edge on iOS can't add to home screen — only Safari can.
  if(/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua)) return false;
  return true;
}
function InstallPrompt(){
  const [show,setShow]=useState(false);
  const [mode,setMode]=useState("");        // "ios" | "android"
  const deferredRef=React.useRef(null);

  useEffect(()=>{
    if(isStandaloneMode()||isInAppBrowser()) return;
    let snoozed=false;
    try{
      const until=Number(localStorage.getItem(A2HS_KEY)||0);
      snoozed=until>Date.now();
    }catch(_){}
    if(snoozed) return;

    // Android/desktop Chrome: the event only fires if the app is installable and not
    // already installed, so its arrival IS the eligibility check.
    const onBIP=(e)=>{
      e.preventDefault();
      deferredRef.current=e;
      setMode("android");
      setShow(true);
    };
    window.addEventListener("beforeinstallprompt",onBIP);

    // iOS never fires that event, so it gets an instructional card instead — delayed
    // so it doesn't land on top of a first impression.
    let t=null;
    if(isIOSSafari()){
      t=setTimeout(()=>{setMode("ios");setShow(true);},4000);
    }
    const onInstalled=()=>{setShow(false);};
    window.addEventListener("appinstalled",onInstalled);
    return ()=>{
      window.removeEventListener("beforeinstallprompt",onBIP);
      window.removeEventListener("appinstalled",onInstalled);
      if(t) clearTimeout(t);
    };
  },[]);

  // Snooze rather than dismiss forever: someone who isn't ready today may well be
  // after a few more trips through the app.
  const dismiss=()=>{
    try{ localStorage.setItem(A2HS_KEY,String(Date.now()+A2HS_SNOOZE_DAYS*86400000)); }catch(_){}
    setShow(false);
  };
  const install=async()=>{
    const ev=deferredRef.current;
    if(!ev){dismiss();return;}
    try{
      ev.prompt();
      await ev.userChoice;
    }catch(_){}
    deferredRef.current=null;
    setShow(false);
  };

  if(!show) return null;
  return createPortal(
    <div style={{position:"fixed",left:0,right:0,bottom:0,zIndex:4000,display:"flex",justifyContent:"center",padding:"0 12px 12px",pointerEvents:"none"}}>
      <div style={{pointerEvents:"auto",width:"100%",maxWidth:440,background:"rgba(18,26,20,0.98)",border:"1px solid rgba(209,154,74,0.35)",borderRadius:16,padding:"16px 16px 14px",boxShadow:"0 8px 32px rgba(0,0,0,0.5)"}}>
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:mode==="ios"?10:14}}>
          <img src="/icon-192.png" alt="" width="42" height="42" style={{borderRadius:10,flexShrink:0}}/>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontFamily:"var(--font-head)",fontSize:17,color:"var(--foam)",letterSpacing:0.3}}>Add Guide's Choice to your phone</div>
            <div style={{fontSize:13.5,color:"var(--stone)",marginTop:2}}>Opens full screen, right from your home screen.</div>
          </div>
          <button onClick={dismiss} aria-label="Dismiss" style={{background:"none",border:"none",color:"var(--stone)",fontSize:20,lineHeight:1,cursor:"pointer",padding:"2px 4px",flexShrink:0}}>✕</button>
        </div>
        {mode==="ios"?(
          <div style={{background:"rgba(0,0,0,0.3)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:11,padding:"11px 13px",fontSize:14,color:"var(--sky)",lineHeight:1.65}}>
            Tap <span style={{color:"var(--gold)"}}>Share</span> <span style={{fontSize:15}}>􀈂</span> at the bottom of Safari, then choose <span style={{color:"var(--gold)"}}>Add to Home Screen</span>.
          </div>
        ):(
          <div style={{display:"flex",gap:10}}>
            <button onClick={install} style={{flex:1,background:"var(--gold)",border:"none",borderRadius:11,padding:"11px 14px",fontSize:15.5,fontWeight:600,color:"#1f231d",cursor:"pointer",fontFamily:"var(--font-body)"}}>Install</button>
            <button onClick={dismiss} style={{background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.13)",borderRadius:11,padding:"11px 16px",fontSize:15.5,color:"var(--stone)",cursor:"pointer",fontFamily:"var(--font-body)"}}>Not now</button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function Root(){
  const {user, loading, demoError, tier, trialExpired, refreshTier, redeemInviteCode, autoRedeemNotice, setAutoRedeemNotice, tierCheckFailed, tierDebug, tierChecking} = useAuth();
  // First-visit welcome modal, guests only. Deliberately NOT rendered until the app
  // behind it has had a moment to populate real gauge/weather data — the whole point of
  // dropping the old full-screen splash was that a visitor should see the product
  // working before being asked for anything. Gated on !loading so it can never flash in
  // front of a signed-in user while their session is still resolving.
  const [showWelcome,setShowWelcome]=useState(false);
  useEffect(()=>{
    if(loading||user) return;
    let seen=false;
    try{ seen=!!sessionStorage.getItem(WELCOME_KEY); }catch(_){ seen=false; }
    if(seen) return;
    const t=setTimeout(()=>setShowWelcome(true),WELCOME_DELAY_MS);
    return ()=>clearTimeout(t);
  },[loading,user]);
  function dismissWelcome(){
    try{ sessionStorage.setItem(WELCOME_KEY,"1"); }catch(_){}
    setShowWelcome(false);
  }
  const [checkoutNotice,setCheckoutNotice]=useState("");
  // Guest auth-prompt overlay: null = hidden, "" or a reason string = shown. Reset
  // whenever a real user shows up (fresh sign-in) so a later sign-out doesn't
  // instantly re-open it with a stale reason from before.
  const [authPromptReason,setAuthPromptReason]=useState(null);
  useEffect(()=>{ if(user) setAuthPromptReason(null); },[user]);
  // Handles the redirect back from Stripe Checkout (?checkout=success|cancel). The
  // webhook that actually activates the tier in Supabase runs async on Stripe's side,
  // so on success we poll refreshTier briefly rather than assuming it's already there.
  // Gated on [user,loading] (not []) so it only fires once auth has actually resolved —
  // otherwise refreshTier would close over a not-yet-set user and silently no-op.
  useEffect(()=>{
    if(loading || !user) return;
    const params=new URLSearchParams(window.location.search);
    const status=params.get("checkout");
    if(!status) return;
    window.history.replaceState({},"",window.location.pathname);
    if(status==="success"){
      setCheckoutNotice("Activating your subscription…");
      let tries=0;
      const poll=setInterval(async()=>{
        tries++;
        await refreshTier();
        if(tries>=6) clearInterval(poll);
      },1500);
      const clearNotice=setTimeout(()=>setCheckoutNotice(""),9000);
      return ()=>{clearInterval(poll);clearTimeout(clearNotice);};
    }
  },[user,loading]);
  if(loading) return <AuthLoadingScreen/>;
  // Only bypass auth if Supabase is genuinely not configured
  if(!SUPABASE_CONFIGURED) return <App user={{id:"local",email:"local user"}} tier="free" refreshTier={()=>{}} redeemInviteCode={async()=>({ok:false,reason:"not_configured"})}/>;
  // Supabase IS configured. Guests (no account) still see the app itself — gauges and
  // weather are the free tier and shouldn't require signup just to look. Personal/paid
  // actions (save a gauge, log a catch, plan a trip, guide tools) call onRequestAuth
  // instead, which pops AuthScreen as a dismissible overlay with a reason message.
  return <>
    {checkoutNotice&&<div style={{position:"fixed",top:0,left:0,right:0,zIndex:1000,background:"rgba(60,120,80,0.95)",padding:"8px 16px",textAlign:"center",fontSize:15,color:"white",fontFamily:"var(--font-body)"}}>✓ {checkoutNotice}</div>}
    <App user={user} tier={tier} trialExpired={trialExpired} refreshTier={refreshTier} redeemInviteCode={redeemInviteCode} autoRedeemNotice={autoRedeemNotice} setAutoRedeemNotice={setAutoRedeemNotice} tierCheckFailed={tierCheckFailed} tierDebug={tierDebug} tierChecking={tierChecking} onRequestAuth={reason=>setAuthPromptReason(reason||"")}/>
    {!user&&authPromptReason!==null&&(
      <div style={{position:"fixed",inset:0,zIndex:3000,background:"rgba(10,20,17,0.82)",display:"flex",alignItems:"center",justifyContent:"center",padding:20,overflowY:"auto"}}
        onClick={e=>{if(e.target===e.currentTarget)setAuthPromptReason(null);}}>
        <div style={{position:"relative",width:"100%",maxWidth:380,maxHeight:"92vh"}}>
          <button onClick={()=>setAuthPromptReason(null)} aria-label="Close"
            style={{position:"absolute",top:-10,right:-4,width:32,height:32,borderRadius:"50%",background:"rgba(255,255,255,0.15)",border:"1px solid rgba(255,255,255,0.3)",color:"var(--foam)",fontSize:16,cursor:"pointer",zIndex:2}}>✕</button>
          <AuthScreen demoError={demoError} promptReason={authPromptReason} compact/>
        </div>
      </div>
    )}
    {!user&&showWelcome&&authPromptReason===null&&(
      <WelcomeModal
        onSignUp={()=>{dismissWelcome();setAuthPromptReason("");}}
        onDismiss={dismissWelcome}
      />
    )}
    {!showWelcome&&<InstallPrompt/>}
  </>;
}
export default Root;
