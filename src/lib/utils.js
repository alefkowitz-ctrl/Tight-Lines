// ── CFS Labels ────────────────────────────────────────────────────────────────
export function cfsLabel(cfs) {
  if (cfs == null) return { label: 'NO DATA', cls: 'nodata' }
  if (cfs === 0) return { label: 'NO FLOW', cls: 'nodata' }
  if (cfs < 5) return { label: 'VERY LOW', cls: 'vlow' }
  if (cfs < 50) return { label: 'LOW', cls: 'low' }
  if (cfs < 200) return { label: 'GOOD', cls: 'good' }
  if (cfs < 600) return { label: 'HIGH', cls: 'high' }
  return { label: 'FLOOD', cls: 'flood' }
}

// ── Fishable Stream Filter ────────────────────────────────────────────────────
const NON_FISHABLE = [
  'canal', 'ditch', 'drain', 'diversion', 'lateral', 'irrigation',
  'pipeline', 'tunnel', 'aqueduct', 'municipal', 'effluent', 'waste',
  'sewage', 'outfall', 'reservoir', 'lake', 'pond', 'inlet', 'outlet',
  'tailrace', 'headgate', 'bypass', 'flume', 'delivery', 'supply',
  'district', 'index', 'well', 'rocky flats', 'buffer zone', ' rfp',
  'landfill', ' plant', 'facility', 'treatment',
]

const WATER_WORDS = [
  'creek', 'river', ' run', ' fork', 'branch', 'stream', 'slough',
  'gulch', 'canyon', ' rio ', ' cr', ' ck', ' fk', 'south boulder',
  'clear creek', 'platte', 'arkansas', 'colorado r',
]

const SPLIT_WORDS = ['near ', 'at ', 'below ', 'above ', ' nr ', ' abv ', ' ab ', ' bl ']

export function isFishable(name) {
  const n = name.toLowerCase()
  let streamPart = n
  for (const sw of SPLIT_WORDS) {
    const idx = n.indexOf(sw)
    if (idx > 5) { streamPart = n.substring(0, idx); break }
  }
  const hasWater = WATER_WORDS.some(w => n.includes(w))
  const hasNonFishable = NON_FISHABLE.some(kw => streamPart.includes(kw))
  return hasWater && !hasNonFishable
}

// ── Wind Direction ────────────────────────────────────────────────────────────
export function windDir(deg) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW']
  return dirs[Math.round(deg / 22.5) % 16]
}

// ── Pressure Trend ────────────────────────────────────────────────────────────
export function pressureTrend(current, prev) {
  if (!prev) return { label: 'Steady', icon: '→', color: '#c8e6c9' }
  const diff = current - prev
  if (diff > 0.5) return { label: 'Rising', icon: '↑', color: '#81c784' }
  if (diff < -0.5) return { label: 'Falling', icon: '↓', color: '#e57373' }
  return { label: 'Steady', icon: '→', color: '#c8e6c9' }
}

export function fishingPressureNote(pressure) {
  if (pressure > 30.2) return 'High pressure — fish holding deep, try nymphs near bottom'
  if (pressure < 29.6) return 'Very low pressure — storm incoming, fish feeding aggressively before front'
  if (pressure < 29.9) return 'Low pressure — overcast conditions favor dry fly fishing'
  return null
}

// ── Moon Phase ────────────────────────────────────────────────────────────────
export function getMoonPhase(date = new Date()) {
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  const day = date.getDate()
  let jd
  if (month < 3) {
    const y = year - 1, m = month + 12
    jd = Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day - 1524.5
  } else {
    jd = Math.floor(365.25 * (year + 4716)) + Math.floor(30.6001 * (month + 1)) + day - 1524.5
  }
  const phase = ((jd - 2451550.1) / 29.530588853) % 1
  const p = phase < 0 ? phase + 1 : phase
  const pct = Math.round(p * 100)
  if (p < 0.03 || p > 0.97) return { name: 'New Moon', emoji: '🌑', pct, note: 'Low light — excellent evening fishing' }
  if (p < 0.22) return { name: 'Waxing Crescent', emoji: '🌒', pct, note: 'Increasing light — fish active at dusk' }
  if (p < 0.28) return { name: 'First Quarter', emoji: '🌓', pct, note: 'Good — moderate feeding activity' }
  if (p < 0.47) return { name: 'Waxing Gibbous', emoji: '🌔', pct, note: 'Good — all-day feeding activity' }
  if (p < 0.53) return { name: 'Full Moon', emoji: '🌕', pct, note: 'Best — peak feeding, especially early AM' }
  if (p < 0.72) return { name: 'Waning Gibbous', emoji: '🌖', pct, note: 'Good — all-day feeding activity' }
  if (p < 0.78) return { name: 'Last Quarter', emoji: '🌗', pct, note: 'Good — morning feeding peak' }
  return { name: 'Waning Crescent', emoji: '🌘', pct, note: 'Decreasing light — fish active at dawn' }
}

// ── Hatches ───────────────────────────────────────────────────────────────────
const HATCH_DATA = {
  1: [], 2: [],
  3: [{ name: 'Blue-Winged Olive', intensity: 'Early', flies: ['BWO #18-22', 'Parachute Adams #18'] }],
  4: [
    { name: 'Blue-Winged Olive', intensity: 'Moderate', flies: ['BWO #18-22', 'CDC Dun #18'] },
    { name: 'Midges', intensity: 'Heavy', flies: ['Zebra Midge #20-24', 'Mercury Midge #22'] },
  ],
  5: [
    { name: 'Pale Morning Dun', intensity: 'Heavy', flies: ['PMD #16-18', 'Sparkle Dun #16'] },
    { name: 'Caddis', intensity: 'Moderate', flies: ['Elk Hair Caddis #14-16', 'X-Caddis #16'] },
    { name: 'Green Drake', intensity: 'Early', flies: ['Green Drake #10-12', 'Paradrake #10'] },
  ],
  6: [
    { name: 'Green Drake', intensity: 'Heavy', flies: ['Green Drake #10-12', 'Paradrake #10'] },
    { name: 'Pale Morning Dun', intensity: 'Heavy', flies: ['PMD #16-18', 'Cripple #16'] },
    { name: 'Caddis', intensity: 'Heavy', flies: ['Elk Hair Caddis #14-16', 'Goddard Caddis #14'] },
    { name: 'Yellow Sally', intensity: 'Moderate', flies: ['Yellow Sally #14-16', 'Stimulator #14'] },
  ],
  7: [
    { name: 'Trico', intensity: 'Heavy', flies: ['Trico #20-24', 'Trico Spinner #22'] },
    { name: 'Caddis', intensity: 'Moderate', flies: ['Elk Hair Caddis #14-16'] },
    { name: 'Hoppers', intensity: 'Early', flies: ['Dave\'s Hopper #8-12', 'Parachute Hopper #10'] },
  ],
  8: [
    { name: 'Trico', intensity: 'Heavy', flies: ['Trico #20-24'] },
    { name: 'Hoppers', intensity: 'Heavy', flies: ['Dave\'s Hopper #8-12', 'Chernobyl Ant #8'] },
    { name: 'PMD (evening)', intensity: 'Moderate', flies: ['PMD #16-18'] },
  ],
  9: [
    { name: 'Blue-Winged Olive', intensity: 'Moderate', flies: ['BWO #18-22'] },
    { name: 'Trico', intensity: 'Moderate', flies: ['Trico #20-24'] },
    { name: 'Mahogany Dun', intensity: 'Early', flies: ['Mahogany Dun #14-16'] },
  ],
  10: [
    { name: 'Blue-Winged Olive', intensity: 'Heavy', flies: ['BWO #18-22', 'Parachute Adams #18'] },
    { name: 'Midges', intensity: 'Moderate', flies: ['Zebra Midge #20-24'] },
  ],
  11: [{ name: 'Blue-Winged Olive', intensity: 'Moderate', flies: ['BWO #20-22'] }],
  12: [{ name: 'Midges', intensity: 'Heavy', flies: ['Zebra Midge #20-24', 'Mercury Midge #22'] }],
}

export function getHatches(month) {
  return HATCH_DATA[month] || []
}

// ── State Regs Links ──────────────────────────────────────────────────────────
export function getStateRegLink(label) {
  if (!label) return null
  const l = label.toLowerCase()
  const states = {
    ', co': { name: 'Colorado', url: 'https://cpw.state.co.us/thingstodo/Pages/Fishing.aspx' },
    ', mt': { name: 'Montana', url: 'https://fwp.mt.gov/fishing' },
    ', wy': { name: 'Wyoming', url: 'https://wgfd.wyo.gov/Fishing' },
    ', id': { name: 'Idaho', url: 'https://idfg.idaho.gov/fish/regs' },
    ', ut': { name: 'Utah', url: 'https://wildlife.utah.gov/fishing.html' },
    ', nm': { name: 'New Mexico', url: 'https://www.wildlife.state.nm.us/fishing/' },
    ', or': { name: 'Oregon', url: 'https://myodfw.com/fishing' },
    ', wa': { name: 'Washington', url: 'https://wdfw.wa.gov/fishing' },
  }
  for (const [key, val] of Object.entries(states)) {
    if (l.includes(key)) return val
  }
  return null
}

// ── EXIF Parser ───────────────────────────────────────────────────────────────
export function parseExif(buffer) {
  const view = new DataView(buffer)
  if (view.getUint16(0) !== 0xFFD8) return {}
  let offset = 2
  while (offset < view.byteLength - 2) {
    const marker = view.getUint16(offset)
    offset += 2
    if (marker === 0xFFE1) {
      const len = view.getUint16(offset)
      const exifHeader = String.fromCharCode(...new Uint8Array(buffer, offset + 2, 4))
      if (exifHeader === 'Exif') {
        const tiffStart = offset + 8
        const littleEndian = view.getUint16(tiffStart) === 0x4949
        const ifdOffset = view.getUint32(tiffStart + 4, littleEndian)
        const ifdStart = tiffStart + ifdOffset
        const entries = view.getUint16(ifdStart, littleEndian)
        const result = {}
        for (let i = 0; i < entries; i++) {
          const entryOffset = ifdStart + 2 + i * 12
          const tag = view.getUint16(entryOffset, littleEndian)
          if (tag === 0x8769) { // ExifIFD
            const exifIFDOffset = tiffStart + view.getUint32(entryOffset + 8, littleEndian)
            const exifEntries = view.getUint16(exifIFDOffset, littleEndian)
            for (let j = 0; j < exifEntries; j++) {
              const eOff = exifIFDOffset + 2 + j * 12
              const eTag = view.getUint16(eOff, littleEndian)
              if (eTag === 0x9003) { // DateTimeOriginal
                const strOff = tiffStart + view.getUint32(eOff + 8, littleEndian)
                let str = ''
                for (let k = 0; k < 19; k++) str += String.fromCharCode(view.getUint8(strOff + k))
                result.dateTime = str
              }
            }
          }
          if (tag === 0x8825) { // GPSInfo
            const gpsOffset = tiffStart + view.getUint32(entryOffset + 8, littleEndian)
            const gpsEntries = view.getUint16(gpsOffset, littleEndian)
            const gps = {}
            for (let j = 0; j < gpsEntries; j++) {
              const gOff = gpsOffset + 2 + j * 12
              const gTag = view.getUint16(gOff, littleEndian)
              if (gTag === 1) gps.latRef = String.fromCharCode(view.getUint8(gOff + 8))
              if (gTag === 3) gps.lngRef = String.fromCharCode(view.getUint8(gOff + 8))
              if (gTag === 2 || gTag === 4) {
                const vOff = tiffStart + view.getUint32(gOff + 8, littleEndian)
                const deg = view.getUint32(vOff, littleEndian) / view.getUint32(vOff + 4, littleEndian)
                const min = view.getUint32(vOff + 8, littleEndian) / view.getUint32(vOff + 12, littleEndian)
                const sec = view.getUint32(vOff + 16, littleEndian) / view.getUint32(vOff + 20, littleEndian)
                if (gTag === 2) gps.lat = deg + min / 60 + sec / 3600
                else gps.lng = deg + min / 60 + sec / 3600
              }
            }
            if (gps.lat && gps.lng) {
              result.lat = gps.latRef === 'S' ? -gps.lat : gps.lat
              result.lng = gps.lngRef === 'W' ? -gps.lng : gps.lng
            }
          }
        }
        return result
      }
      offset += len
    } else if ((marker & 0xFF00) === 0xFF00) {
      offset += view.getUint16(offset)
    } else break
  }
  return {}
}

export function fmtCoord(lat, lng) {
  return `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(4)}°${lng >= 0 ? 'E' : 'W'}`
}

export function extractJSON(text) {
  const c = text.replace(/```json|```/g, '').trim()
  try { const m = c.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]) } catch {}
  try { const m = c.match(/\[[\s\S]*\]/); if (m) return JSON.parse(m[0]) } catch {}
  return null
}
