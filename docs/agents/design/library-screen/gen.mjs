// Generates the Library screen artboards (.dc.html) for the LibrisVault design canvas.
// Everything visual is derived from the dashboard's light-theme tokens and the demo vault.
import fs from 'node:fs'

const counts = JSON.parse(fs.readFileSync('counts.json', 'utf8'))
const T = {
  bg: '#f2f4f9', side: '#e9ecf3', elev: '#ffffff', elev2: '#eceff6', border: '#dde2ec',
  borderStrong: '#c3cde0', text: '#1a2333', dim: '#55627e', faint: '#75819b',
  accent: '#3059c8', accentInk: '#ffffff', accentSoft: '#e2e9fb', gold: '#a6791f',
  goldBg: '#f5ecd7', research: '#6d4fd4', ok: '#177a4c', okBg: '#ddf1e6', warn: '#996712',
  warnBg: '#f7ecd4', err: '#c93540', muted: '#6b7488', mutedBg: '#e7ebf2',
  typeConcept: '#2f62c9', typeEntity: '#a3459f', typeSource: '#10796a', typeQuestion: '#8a6410',
}
const FONT = '"Instrument Sans", system-ui, sans-serif'
const DISPLAY = '"Bricolage Grotesque", "Instrument Sans", system-ui, sans-serif'
const MONO = '"IBM Plex Mono", ui-monospace, Menlo, monospace'

function domainHue(d) { let h = 0; for (let i = 0; i < d.length; i++) h = (h * 31 + d.charCodeAt(i)) >>> 0; return h % 360 }
const domainColor = (d) => `hsl(${domainHue(d)} 62% 52%)`
const hsl = (h, s, l) => `hsl(${h} ${s}% ${l}%)`

/* ----------------------------------------------------------------- isometric scene */
let SCALE = 1
function makeP(ox, oy, TW = 46, TH = 23) { return (i, j, z = 0) => [ox + (i - j) * TW / 2, oy + (i + j) * TH / 2 - z] }
const pts = (arr) => arr.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// seeded pseudo random so the two variants of a scene draw the same books
let seed = 7
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }

function box(P, i0, j0, a, b, h, c, extra = '') {
  const top = [P(i0, j0, h), P(i0 + a, j0, h), P(i0 + a, j0 + b, h), P(i0, j0 + b, h)]
  const left = [P(i0, j0 + b, 0), P(i0 + a, j0 + b, 0), P(i0 + a, j0 + b, h), P(i0, j0 + b, h)]
  const right = [P(i0 + a, j0, 0), P(i0 + a, j0 + b, 0), P(i0 + a, j0 + b, h), P(i0 + a, j0, h)]
  return `<polygon points="${pts(left)}" fill="${c.left}" ${extra}/><polygon points="${pts(right)}" fill="${c.right}" ${extra}/><polygon points="${pts(top)}" fill="${c.top}" ${extra}/>`
}

// A bookcase: frame plus rows of spines on its long visible face. `along` is 'i' or 'j'.
function bookcase(P, i0, j0, along, len, pages, hue, night) {
  const depth = 0.72, h = Math.round(60 * SCALE)
  const frame = night
    ? { top: '#2c3a57', left: '#22304a', right: '#1c283e' }
    : { top: '#e6eaf3', left: '#d6dce9', right: '#c3cde0' }
  const a = along === 'i' ? len : depth, b = along === 'i' ? depth : len
  let out = box(P, i0, j0, a, b, h, frame)
  const rows = 3
  const rowH = (h - 8) / rows
  const capacity = rows * Math.floor((len - 0.3) / 0.21)
  const n = Math.min(capacity, Math.max(6, Math.round(pages * 0.55)))
  let drawn = 0
  for (let r = 0; r < rows; r++) {
    const z0 = 4 + r * rowH
    let t = 0.15
    while (t < len - 0.2 && drawn < n) {
      const thin = rnd() < 0.25
      const ds = thin ? 0.09 : 0.14 + rnd() * 0.1
      const hs = rowH - 5 - rnd() * 5
      const gap = rnd() < 0.08 ? 0.12 : 0.03
      const l = night ? 28 + rnd() * 12 : 40 + rnd() * 20
      const s = thin ? 30 : 48 + rnd() * 16
      const fill = hsl(hue + (rnd() * 16 - 8), s, l)
      const poly = along === 'i'
        ? [P(i0 + t, j0 + b, z0), P(i0 + t + ds, j0 + b, z0), P(i0 + t + ds, j0 + b, z0 + hs), P(i0 + t, j0 + b, z0 + hs)]
        : [P(i0 + a, j0 + t, z0), P(i0 + a, j0 + t + ds, z0), P(i0 + a, j0 + t + ds, z0 + hs), P(i0 + a, j0 + t, z0 + hs)]
      out += `<polygon points="${pts(poly)}" fill="${fill}"/>`
      t += ds + gap
      drawn++
    }
  }
  return out
}

function label(P, i, j, text, c, night, size = 11, weight = 500) {
  const [x, y] = P(i, j, 0)
  return `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle" font-family='${FONT}' font-size="${size}" font-weight="${weight}" fill="${c}" paint-order="stroke" stroke="${night ? '#0f1524' : '#ffffff'}" stroke-width="3" stroke-linejoin="round">${esc(text)}</text>`
}

function tag(x, y, text, kind, night) {
  const w = text.length * 6.6 + 18
  const fills = {
    fellow: [night ? '#1b2947' : T.accentSoft, night ? '#7fa7ff' : T.accent, night ? '#30405f' : '#c5d3f4'],
    visitor: [night ? '#232a3a' : T.mutedBg, night ? '#9aa7c2' : T.muted, night ? '#30405f' : '#d1d7e2'],
    asleep: [night ? '#1a2233' : T.elev2, night ? '#78859f' : T.faint, night ? '#30405f' : T.border],
    warn: [night ? '#33270f' : T.warnBg, night ? '#e2a64d' : T.warn, night ? '#5a4a1a' : '#e8d3a0'],
  }[kind]
  return `<g><rect x="${(x - w / 2).toFixed(1)}" y="${(y - 9).toFixed(1)}" width="${w.toFixed(1)}" height="18" rx="9" fill="${fills[0]}" stroke="${fills[2]}"/><text x="${x.toFixed(1)}" y="${(y + 3.6).toFixed(1)}" text-anchor="middle" font-family='${FONT}' font-size="10.5" font-weight="600" fill="${fills[1]}">${esc(text)}</text></g>`
}

// A figure. pose: shelf | desk | sleep | wait | carry | cart | clipboard | shelve
function figure(P, i, j, o, night, top) {
  const [x, y] = P(i, j, 0)
  const skin = '#e8c39e', hair = o.hair ?? '#5a3a22'
  const shirt = o.color ?? (night ? '#7fa7ff' : T.accent)
  const pants = night ? '#2b3550' : '#3a4763'
  const ink = night ? '#0c101b' : '#1a2333'
  let g = `<ellipse cx="${x}" cy="${y}" rx="10" ry="4.5" fill="${night ? '#0a0d16' : '#c9d0de'}" opacity="0.55"/>`
  if (o.pose === 'sleep') {
    // slumped in an armchair: chair back, body leaning, closed eyes
    g += `<rect x="${x - 12}" y="${y - 34}" width="24" height="26" rx="5" fill="${night ? '#30405f' : '#c3cde0'}"/>`
    g += `<rect x="${x - 9}" y="${y - 22}" width="18" height="14" rx="4" fill="${shirt}"/>`
    g += `<circle cx="${x + 1}" cy="${y - 26}" r="6" fill="${skin}"/><path d="M${x - 5} ${y - 30} q6 -6 12 0" fill="${hair}"/>`
    g += `<path d="M${x - 1} ${y - 25} h3 M${x + 3} ${y - 25} h2" stroke="${ink}" stroke-width="1" stroke-linecap="round"/>`
    g += `<rect x="${x - 10}" y="${y - 12}" width="20" height="6" rx="3" fill="${night ? '#1a2233' : '#9aa7c2'}"/>`
    g += `<text x="${x + 12}" y="${y - 36}" font-family='${MONO}' font-size="9" fill="${night ? '#78859f' : T.faint}">z</text><text x="${x + 17}" y="${y - 42}" font-family='${MONO}' font-size="8" fill="${night ? '#78859f' : T.faint}">z</text>`
  } else {
    const seated = o.pose === 'desk'
    const bodyY = seated ? y - 26 : y - 30
    if (!seated) g += `<rect x="${x - 5}" y="${y - 14}" width="4" height="13" rx="1.5" fill="${pants}"/><rect x="${x + 1}" y="${y - 14}" width="4" height="13" rx="1.5" fill="${pants}"/>`
    g += `<rect x="${x - 7}" y="${bodyY}" width="14" height="${seated ? 14 : 18}" rx="4" fill="${shirt}"/>`
    g += `<circle cx="${x}" cy="${bodyY - 6}" r="6" fill="${skin}"/><path d="M${x - 6} ${bodyY - 8} q6 -7 12 0" fill="${hair}"/>`
    if (o.pose === 'shelf' || o.pose === 'shelve') {
      const bk = o.book ?? '#2f62c9'
      g += `<rect x="${x + 5}" y="${bodyY - 2}" width="7" height="9" rx="1" fill="${bk}" transform="rotate(${o.pose === 'shelve' ? -35 : -10} ${x + 8} ${bodyY + 2})"/>`
    }
    if (o.pose === 'carry') g += `<rect x="${x - 8}" y="${bodyY + 6}" width="16" height="10" rx="1.5" fill="${night ? '#5c4a2c' : '#d9b98a'}" stroke="${night ? '#3a2f1c' : '#b08d5a'}"/><path d="M${x} ${bodyY + 6} v10" stroke="${night ? '#3a2f1c' : '#b08d5a'}"/>`
    if (o.pose === 'clipboard') g += `<rect x="${x + 4}" y="${bodyY + 2}" width="8" height="11" rx="1" fill="${night ? '#dfe4ef' : '#ffffff'}" stroke="${T.borderStrong}"/><path d="M${x + 6} ${bodyY + 6} h4 M${x + 6} ${bodyY + 9} h4" stroke="${T.borderStrong}" stroke-width="1"/>`
    if (o.pose === 'desk') g += `<rect x="${x - 9}" y="${bodyY + 8}" width="8" height="5" rx="1" fill="${night ? '#dfe4ef' : '#ffffff'}" stroke="${T.borderStrong}"/>`
  }
  if (o.name) { const t = tag(x, y - (o.pose === 'sleep' ? 52 : o.pose === 'desk' ? 46 : 50), o.name, o.kind ?? 'fellow', night); if (top) top.push(t); else g = t + g }
  return g
}

function cart(P, i, j, night) {
  const c = night ? { top: '#3a4a6c', left: '#2a3550', right: '#22304a' } : { top: '#e6eaf3', left: '#c9d2e3', right: '#b6c2d8' }
  let g = box(P, i, j, 0.9, 0.55, 18, c)
  const [x, y] = P(i + 0.45, j + 0.28, 0)
  g += `<circle cx="${x - 12}" cy="${y + 4}" r="3.5" fill="${night ? '#0a0d16' : '#55627e'}"/><circle cx="${x + 12}" cy="${y + 2}" r="3.5" fill="${night ? '#0a0d16' : '#55627e'}"/>`
  // two books on the cart
  g += `<polygon points="${pts([P(i + 0.15, j + 0.5, 18), P(i + 0.3, j + 0.5, 18), P(i + 0.3, j + 0.5, 30), P(i + 0.15, j + 0.5, 30)])}" fill="${hsl(200, 50, 45)}"/><polygon points="${pts([P(i + 0.35, j + 0.5, 18), P(i + 0.48, j + 0.5, 18), P(i + 0.48, j + 0.5, 28), P(i + 0.35, j + 0.5, 28)])}" fill="${hsl(330, 45, 50)}"/>`
  return g
}

function lamp(P, i, j, night) {
  const [x, y] = P(i, j, 0)
  if (!night) return ''
  return `<ellipse cx="${x}" cy="${y - 8}" rx="70" ry="38" fill="url(#glow)"/><rect x="${x - 1}" y="${y - 44}" width="2" height="36" fill="#78859f"/><path d="M${x - 9} ${y - 44} h18 l-4 -8 h-10 z" fill="#e2b45c"/>`
}

function scene({ night, card }) {
  const W = card ? 780 : 1128, H = card ? 900 : 760
  const TW = card ? 40 : 56, TH = TW / 2
  SCALE = TW / 46
  const NI = 22, NJ = 15, wallH = 150
  const total = wallH + (NI + NJ) * TH / 2
  const oy = Math.round((H - total) / 2 + wallH - 10)
  const ox = Math.round(W / 2 - (NI - NJ) * TW / 4)
  const P = makeP(ox, oy, TW, TH)
  const layers = [] // { d: depth, s: svg }
  const top = [] // labels and name tags, painted last
  const add = (d, s) => layers.push({ d, s })
  // floor
  const floor = [P(0, 0), P(NI, 0), P(NI, NJ), P(0, NJ)]
  let bg = `<polygon points="${pts(floor)}" fill="${night ? '#161d2e' : '#f7f8fc'}"/>`
  for (let i = 1; i < NI; i++) bg += `<line x1="${P(i, 0)[0]}" y1="${P(i, 0)[1]}" x2="${P(i, NJ)[0]}" y2="${P(i, NJ)[1]}" stroke="${night ? '#1f2940' : '#e9edf5'}" stroke-width="1"/>`
  for (let j = 1; j < NJ; j++) bg += `<line x1="${P(0, j)[0]}" y1="${P(0, j)[1]}" x2="${P(NI, j)[0]}" y2="${P(NI, j)[1]}" stroke="${night ? '#1f2940' : '#e9edf5'}" stroke-width="1"/>`
  // back walls
  const wallL = [P(0, 0, 0), P(NI, 0, 0), P(NI, 0, wallH), P(0, 0, wallH)]
  const wallR = [P(0, 0, 0), P(0, NJ, 0), P(0, NJ, wallH), P(0, 0, wallH)]
  bg += `<polygon points="${pts(wallR)}" fill="${night ? '#111828' : '#eef1f7'}"/><polygon points="${pts(wallL)}" fill="${night ? '#141b2c' : '#f3f5fa'}"/>`
  // windows on the left wall
  for (const wi of [6, 11, 16]) {
    const w = [P(wi, 0, 70), P(wi + 2.6, 0, 70), P(wi + 2.6, 0, 130), P(wi, 0, 130)]
    bg += `<polygon points="${pts(w)}" fill="${night ? '#0c101b' : '#dfe8fb'}" stroke="${night ? '#30405f' : '#c3cde0'}"/>`
  }
  // notice board on the right wall (hot.md), near the entrance side
  const nb = [P(0, 11.2, 60), P(0, 13.4, 60), P(0, 13.4, 110), P(0, 11.2, 110)]
  bg += `<polygon points="${pts(nb)}" fill="${night ? '#2a2414' : '#f5ecd7'}" stroke="${night ? '#5a4a1a' : '#e0cfa2'}"/>`
  for (let k = 0; k < 4; k++) { const z = 100 - k * 10; bg += `<polygon points="${pts([P(0, 11.6, z), P(0, 13.0 - (k % 2) * 0.4, z), P(0, 13.0 - (k % 2) * 0.4, z + 4), P(0, 11.6, z + 4)])}" fill="${night ? '#5a4a1a' : '#d9c58f'}"/>` }
  bg += `<text x="${P(0, 12.3, 118)[0]}" y="${P(0, 12.3, 118)[1]}" text-anchor="middle" font-family='${FONT}' font-size="10" font-weight="600" fill="${night ? '#9aa7c2' : T.faint}" transform="rotate(26.5 ${P(0, 12.3, 118)[0]} ${P(0, 12.3, 118)[1]})">what's new</text>`

  // departments: name, along, i, j, len
  const D = [
    ['astronomy', 'i', 1.0, 0.3, 5.2], ['computing', 'i', 6.8, 0.3, 4.2], ['climate-science', 'i', 11.6, 0.3, 4.0], ['cooking', 'i', 16.2, 0.3, 3.6],
    ['machine-learning', 'j', 0.3, 1.2, 3.4], ['materials-science', 'j', 0.3, 5.0, 3.0], ['neuroscience', 'j', 0.3, 8.4, 2.4],
    ['cryptography', 'i', 4.2, 5.2, 3.2], ['economics', 'i', 8.4, 5.2, 2.8], ['linguistics', 'i', 12.2, 5.2, 2.8],
    ['photography', 'i', 4.2, 8.6, 2.8], ['knowledge-management', 'i', 8.0, 8.6, 3.0], ['music-theory', 'i', 12.0, 8.6, 2.4],
    ['unassigned', 'j', 18.4, 8.6, 2.6],
  ]
  for (const [name, along, i, j, len] of D) {
    const hue = name === 'unassigned' ? 220 : domainHue(name)
    const pages = counts[name] ?? 20
    const depth = along === 'i' ? i + len + j + 0.72 : i + 0.72 + j + len
    add(depth, bookcase(P, i, j, along, len, pages, hue, night))
    const li = along === 'i' ? i + len / 2 : i + 1.6, lj = along === 'i' ? j + 1.6 : j + len / 2
    const txt = name === 'unassigned' ? `unfiled · ${pages}` : `${name} · ${pages}`
    top.push(label(P, li, lj, txt, night ? '#9aa7c2' : T.dim, night))
  }
  // reading room: two tables, armchairs
  const tableC = night ? { top: '#33415f', left: '#2a3550', right: '#22304a' } : { top: '#f0e6d6', left: '#d9cbb3', right: '#c9b99d' }
  add(6 + 12.5, box(P, 4.0, 11.2, 2.2, 1.2, 22, tableC))
  add(6 + 12.5 + 0.02, `<polygon points="${pts([P(4.4, 11.5, 22), P(5.0, 11.5, 22), P(5.0, 11.9, 22), P(4.4, 11.9, 22)])}" fill="${night ? '#dfe4ef' : '#ffffff'}"/>`)
  const chairC = night ? { top: '#3a4a6c', left: '#2a3550', right: '#22304a' } : { top: '#d6dce9', left: '#c3cde0', right: '#b0bcd2' }
  add(8.6 + 13.2, box(P, 8.0, 12.6, 0.9, 0.9, 14, chairC))
  add(10.1 + 13.2, box(P, 9.4, 12.6, 0.9, 0.9, 14, chairC))
  // desks for writing (Fellows write here)
  const deskC = night ? { top: '#33415f', left: '#2a3550', right: '#22304a' } : { top: '#eceff6', left: '#d6dce9', right: '#c3cde0' }
  add(15.6 + 12.4, box(P, 14.2, 11.6, 1.4, 0.8, 22, deskC))
  add(15.6 + 12.4 + 0.02, `<rect x="${P(14.6, 12.0, 24)[0] - 6}" y="${P(14.6, 12.0, 24)[1] - 4}" width="12" height="8" rx="1" fill="${night ? '#dfe4ef' : '#ffffff'}" stroke="${T.borderStrong}"/>`)
  add(15.6 + 12.4 + 0.03, lamp(P, 15.5, 11.7, night))
  add(18.4 + 12.4, box(P, 17.0, 11.6, 1.4, 0.8, 22, deskC))
  add(18.4 + 12.4 + 0.03, lamp(P, 18.3, 11.7, night))
  // front desk (L shape) near the entrance corner
  const fdC = night ? { top: '#2c3a57', left: '#22304a', right: '#1c283e' } : { top: '#e6eaf3', left: '#d6dce9', right: '#c3cde0' }
  add(21.4 + 13.2, box(P, 19.0, 12.4, 2.4, 0.8, 30, fdC))
  top.push(label(P, 20.2, 14.0, 'front desk', night ? '#9aa7c2' : T.dim, night))
  // card catalog cabinet
  add(21.9 + 10.6, box(P, 21.1, 9.8, 0.8, 0.8, 42, fdC))
  for (let k = 0; k < 3; k++) add(21.9 + 10.6 + 0.01, `<polygon points="${pts([P(21.2, 10.6, 6 + k * 12), P(21.8, 10.6, 6 + k * 12), P(21.8, 10.6, 12 + k * 12), P(21.2, 10.6, 12 + k * 12)])}" fill="${night ? '#3a4a6c' : '#f5f7fb'}" stroke="${night ? '#22304a' : '#c3cde0'}"/>`)
  top.push(label(P, 21.5, 11.6, 'catalog', night ? '#9aa7c2' : T.dim, night))
  // parcel on the front desk / returns cart
  add(21.4 + 13.2 + 0.06, `<g>${box(P, 19.3, 12.5, 0.5, 0.4, 12, night ? { top: '#6b5735', left: '#5c4a2c', right: '#4a3b22' } : { top: '#e6cfa6', left: '#d9b98a', right: '#c9a672' }).replace(/<polygon/g, '<polygon transform="translate(0,-30)"')}</g>`)

  // people
  const astro = domainColor('astronomy'), climate = domainColor('climate-science'), comp = domainColor('computing')
  if (!night) {
    add(3.6 + 1.7, figure(P, 3.4, 1.7, { name: 'Ada · at the shelf', pose: 'shelf', color: '#3b64c9', book: astro }, night, top))
    add(14.8 + 12.7, figure(P, 14.8, 12.7, { name: 'Noor · writing', pose: 'desk', color: '#3b8f79' }, night, top))
    add(8.45 + 13.05, figure(P, 8.45, 13.05, { name: 'Tomas · asleep', kind: 'asleep', pose: 'sleep', color: '#8a6db8' }, night, top))
    add(12.3 + 6.6, figure(P, 12.3, 6.6, { name: 'visitor', kind: 'visitor', pose: 'shelf', color: '#8a95ad', book: domainColor('linguistics') }, night, top))
    add(19.6 + 14.1, figure(P, 19.6, 14.1, { name: 'clerk · unpacking', kind: 'visitor', pose: 'carry', color: '#8a95ad' }, night, top))
    add(17.8 + 4.8, figure(P, 17.8, 4.8, { name: 'caretaker · re-sorting', kind: 'visitor', pose: 'wait', color: '#8a95ad' }, night, top))
    add(18.6 + 4.6, cart(P, 18.2, 4.3, night))
    add(9.8 + 10.4, figure(P, 9.8, 10.4, { name: 'reader', kind: 'visitor', pose: 'wait', color: '#8a95ad' }, night, top))
  } else {
    add(14.8 + 12.7, figure(P, 14.8, 12.7, { name: 'Ada · writing', pose: 'desk', color: '#3b64c9' }, night, top))
    add(7.2 + 1.7, figure(P, 7.2, 1.7, { name: 'Noor · reading', pose: 'shelf', color: '#3b8f79', book: comp }, night, top))
    add(8.45 + 13.05, figure(P, 8.45, 13.05, { name: 'Tomas · asleep', kind: 'asleep', pose: 'sleep', color: '#8a6db8' }, night, top))
    add(9.85 + 13.05, figure(P, 9.85, 13.05, { name: 'Mira · quota spent', kind: 'warn', pose: 'sleep', color: '#c26b4a' }, night, top))
    add(20.3 + 14.2, figure(P, 20.3, 14.2, { name: 'Ibra · waiting', pose: 'wait', color: '#b8892c' }, night, top))
    add(7.4 + 1.0 + 0.5, lamp(P, 7.9, 1.0, night))
  }
  layers.sort((a, b) => a.d - b.d)
  const defs = `<defs><radialGradient id="glow"><stop offset="0" stop-color="#e2b45c" stop-opacity="0.32"/><stop offset="1" stop-color="#e2b45c" stop-opacity="0"/></radialGradient></defs>`
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" style="display:block">${defs}${bg}${layers.map((l) => l.s).join('')}${top.join('')}</svg>`
}

/* ------------------------------------------------------------------------ shell */
const ICONS = {
  home: '<path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  flask: '<path d="M10 3v6L4.5 18a2 2 0 0 0 1.8 3h11.4a2 2 0 0 0 1.8-3L14 9V3"/><path d="M8 3h8"/>',
  graph: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="9" cy="18" r="2.5"/><path d="M8.3 7.2l7.4 0.8M7 8.3l1.5 7.2M16.3 9.9l-5.6 6.4"/>',
  library: '<path d="M3 21h18"/><path d="M4 21V9M9 21V9M15 21V9M20 21V9"/><path d="M2 9l10-6 10 6"/>',
  book: '<path d="M4 4h7v16H4z"/><path d="M13 4h7v16h-7z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  play: '<path d="M7 5v14l11-7z"/>', pause: '<path d="M8 5v14M16 5v14"/>', ext: '<path d="M14 4h6v6M20 4l-8 8M18 14v6H4V6h6"/>',
}
const icon = (n, sz = 16) => `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[n]}</svg>`

const CSS = `
  body { margin: 0; background: ${T.bg}; color: ${T.text}; font-family: ${FONT}; font-size: 14px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
  a { color: ${T.accent}; text-decoration: none; } a:hover { text-decoration: underline; }
  .frame { width: 1440px; height: 900px; overflow: hidden; background: ${T.bg}; display: flex; flex-direction: column; }
  .topbar { height: 52px; flex: 0 0 52px; display: flex; align-items: stretch; gap: 12px; padding: 14px 16px 0; border-bottom: 1px solid ${T.border}; background: ${T.side}; box-sizing: border-box; }
  .tabs { display: flex; align-items: flex-end; gap: 3px; flex: 1; }
  .tab { position: relative; top: 1px; display: inline-flex; align-items: center; gap: 8px; height: 38px; padding: 0 14px; border: 1px solid transparent; border-bottom: 0; border-radius: 10px 10px 0 0; color: ${T.dim}; font-size: 13.5px; font-weight: 500; white-space: nowrap; box-sizing: border-box; }
  .tab svg { opacity: 0.8; }
  .tab.on { background: ${T.bg}; border-color: ${T.border}; color: ${T.text}; font-family: ${DISPLAY}; font-weight: 600; }
  .tab.on svg { color: ${T.accent}; opacity: 1; }
  .tab.on::before { content: ''; position: absolute; left: 11px; right: 11px; top: 0; height: 2px; border-radius: 2px; background: ${T.accent}; }
  .tab.on::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; background: ${T.bg}; }
  .badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 3px 7px; background: ${T.warnBg}; color: ${T.warn}; font-size: 11px; font-weight: 700; line-height: 1; }
  .badge.busy { background: ${T.accent}; color: ${T.accentInk}; }
  .topright { display: flex; align-items: center; gap: 10px; }
  .tstat { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 2px; font-size: 12px; color: ${T.faint}; white-space: nowrap; }
  .d { width: 8px; height: 8px; border-radius: 50%; background: ${T.muted}; }
  .d.ok { background: ${T.ok}; box-shadow: 0 0 0 3px rgba(23,122,76,0.25); }
  .d.warn { background: ${T.warn}; box-shadow: 0 0 0 3px rgba(153,103,18,0.25); }
  .screen { flex: 1; min-height: 0; padding: 14px; box-sizing: border-box; display: grid; grid-template-columns: 252px minmax(0, 1fr); gap: 14px; }
  .gpanel { display: flex; flex-direction: column; overflow: hidden; border: 1px solid ${T.border}; border-radius: 12px; background: ${T.elev}; }
  .sec { padding: 11px 14px 12px; border-bottom: 1px solid ${T.border}; }
  .sec:last-child { border-bottom: 0; }
  .sec.grow { flex: 1; min-height: 0; overflow: hidden; }
  .head { display: flex; align-items: center; gap: 8px; min-height: 24px; margin-bottom: 8px; }
  .eyebrow { font-size: 10.5px; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase; color: ${T.faint}; }
  .state { font-size: 11px; color: ${T.faint}; }
  .spacer { flex: 1; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; white-space: nowrap; border: 1px solid ${T.borderStrong}; background: ${T.elev2}; color: ${T.text}; padding: 0 12px; border-radius: 8px; font-weight: 500; font-size: 13px; box-sizing: border-box; }
  .btn.primary { background: ${T.accent}; border-color: ${T.accent}; color: ${T.accentInk}; }
  .btn.ghost { background: transparent; border-color: transparent; color: ${T.dim}; padding: 0 8px; }
  .btn.sm { height: 24px; padding: 0 9px; font-size: 12px; }
  .btn.wide { width: 100%; }
  .pillrow { display: flex; flex-wrap: wrap; gap: 5px; }
  .pill { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border: 1px solid ${T.border}; border-radius: 999px; color: ${T.dim}; font-size: 12px; font-weight: 500; box-sizing: border-box; }
  .pill .dot { width: 6px; height: 6px; border-radius: 50%; background: ${T.borderStrong}; }
  .pill.on { background: ${T.accentSoft}; border-color: ${T.accent}; color: ${T.accent}; }
  .pill.on .dot { background: ${T.accent}; }
  .row { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 13px; }
  .row .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .row .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .sub { font-size: 11px; color: ${T.faint}; }
  .row .n { font-family: ${MONO}; font-size: 11px; color: ${T.dim}; }
  .frow { display: flex; align-items: center; gap: 10px; padding: 7px 8px; margin: 0 -8px; border-radius: 8px; }
  .frow.sel { background: ${T.accentSoft}; }
  .frow .who { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .frow b { font-weight: 600; font-size: 13px; }
  .frow .st { font-size: 11px; color: ${T.faint}; }
  .facts { display: flex; flex-direction: column; gap: 9px; font-size: 11.5px; color: ${T.dim}; }
  .facts b { display: inline-block; width: 62px; font-family: ${MONO}; font-weight: 500; color: ${T.text}; }
  .stage { display: flex; gap: 10px; min-width: 0; min-height: 0; }
  .wrap { position: relative; flex: 1; min-width: 0; display: flex; flex-direction: column; border: 1px solid ${T.border}; border-radius: 12px; overflow: hidden; background: ${T.elev}; }
  .controls { position: relative; z-index: 3; display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-bottom: 1px solid ${T.border}; background: ${T.elev}; }
  .scope { flex: 1; min-width: 0; font-size: 13px; color: ${T.dim}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .scope b { color: ${T.text}; font-weight: 600; }
  .search { display: flex; align-items: center; gap: 6px; width: min(300px, 34%); height: 32px; padding: 0 10px; border: 1px solid ${T.border}; border-radius: 8px; color: ${T.faint}; font-size: 13px; box-sizing: border-box; }
  .area { position: relative; flex: 1; min-height: 0; overflow: hidden; }
  .area.night { background: #0f1524; }
  .corner { position: absolute; display: flex; align-items: center; gap: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border: 1px solid ${T.border}; border-radius: 999px; background: ${T.elev}; color: ${T.dim}; font-size: 12px; font-weight: 500; box-sizing: border-box; }
  .chip.dark { background: #131928; border-color: #30405f; color: #9aa7c2; }
  .legend { display: flex; flex-direction: column; gap: 5px; padding: 8px 10px; border: 1px solid ${T.border}; border-radius: 8px; background: rgba(255,255,255,0.92); font-size: 11px; color: ${T.dim}; }
  .legend.dark { background: rgba(19,25,40,0.92); border-color: #30405f; color: #9aa7c2; }
  .legend .l { display: flex; align-items: center; gap: 7px; }
  .sw { width: 10px; height: 10px; border-radius: 3px; }
  .aside { flex: 0 0 340px; width: 340px; position: relative; display: flex; flex-direction: column; background: ${T.elev}; border: 1px solid ${T.border}; border-radius: 12px; overflow: hidden; }
  .close { position: absolute; top: 10px; right: 10px; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; color: ${T.faint}; }
  .gx-head { padding: 16px 16px 12px; border-bottom: 1px solid ${T.border}; }
  .kicker { font-size: 11px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: ${T.faint}; }
  .gx-title { font-family: ${DISPLAY}; font-size: 18px; font-weight: 650; line-height: 1.25; margin: 3px 34px 9px 0; }
  .tags { display: flex; flex-wrap: wrap; gap: 6px; }
  .tag { font-size: 11px; padding: 3px 8px; border-radius: 6px; background: ${T.elev2}; color: ${T.dim}; border: 1px solid ${T.border}; }
  .gx-body { flex: 1; min-height: 0; overflow: hidden; }
  .gx-sec { padding: 11px 16px 12px; border-bottom: 1px solid ${T.border}; }
  .gx-sec:last-child { border-bottom: 0; }
  .sub { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: ${T.dim}; }
  .steps { display: flex; align-items: center; gap: 6px; margin: 6px 0 8px; }
  .step { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: ${T.faint}; }
  .step i { display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 50%; border: 1px solid ${T.border}; font-style: normal; font-size: 9.5px; }
  .step.done i { background: ${T.okBg}; border-color: ${T.ok}; color: ${T.ok}; }
  .step.now { color: ${T.text}; font-weight: 600; } .step.now i { background: ${T.accentSoft}; border-color: ${T.accent}; color: ${T.accent}; }
  .step .ln { width: 14px; height: 1px; background: ${T.border}; }
  .log { font-family: ${MONO}; font-size: 11px; line-height: 1.55; color: ${T.dim}; background: ${T.bg}; border: 1px solid ${T.border}; border-radius: 8px; padding: 7px 9px; white-space: pre; overflow: hidden; }
  .list { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
  .list .it { display: flex; gap: 8px; align-items: baseline; } .list .it .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: ${T.accent}; } .list .it .m { font-family: ${MONO}; font-size: 11px; color: ${T.faint}; }
  .plan { display: flex; flex-direction: column; gap: 6px; }
  .prop { display: flex; gap: 8px; align-items: flex-start; padding: 7px 9px; border: 1px solid ${T.border}; border-radius: 8px; font-size: 12.5px; }
  .prop.ok { border-color: ${T.ok}; background: ${T.okBg}; }
  .prop .k { font-family: ${MONO}; font-size: 11px; font-weight: 600; color: ${T.dim}; padding-top: 1px; }
  .prop .x { flex: 1; min-width: 0; } .prop .x small { display: block; color: ${T.faint}; font-size: 11px; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .kv { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; font-size: 12.5px; } .kv span:nth-child(2n) { font-family: ${MONO}; font-size: 11.5px; color: ${T.dim}; text-align: right; }
`

function shell({ night, body, badge, height = 900 }) {
  const tabs = [['home', 'Home'], ['flask', 'Research'], ['graph', 'Graph'], ['library', 'Library', true], ['book', 'Catalog'], ['gear', 'System']]
  return `<div class="frame" style="height:${height}px">
  <header class="topbar">
    <nav class="tabs" aria-label="Primary">${tabs.map(([ic, l, on]) => `<div class="tab${on ? ' on' : ''}">${icon(ic)}<span>${l}</span>${on && badge ? `<span class="badge busy">${badge}</span>` : ''}${l === 'System' ? '<span class="badge">1</span>' : ''}</div>`).join('')}</nav>
    <div class="topright"><span class="tstat"><span class="d ok"></span>Watcher</span><span class="tstat"><span class="d"></span>Telegram</span><span class="tstat"><span class="d ok"></span>${night ? 'Night shift' : 'Live'}</span></div>
  </header>
  <div class="screen">${body}</div>
</div>`
}

const FELLOWS = [
  { name: 'Ada', dom: 'astronomy', st: 'at the shelf · Sonnet 5', c: '#3b64c9', night: 'writing · step 2 of 2' },
  { name: 'Noor', dom: 'climate-science', st: 'writing · Sonnet 5', c: '#3b8f79', night: 'reading · step 1 of 1' },
  { name: 'Tomas', dom: 'computing', st: 'asleep · no open questions', c: '#8a6db8', night: 'asleep · no open questions' },
  { name: 'Mira', dom: 'neuroscience', st: 'waiting · plan for tonight', c: '#c26b4a', night: 'asleep · quota spent' },
  { name: 'Ibra', dom: 'economics', st: 'waiting · plan for tonight', c: '#b8892c', night: 'waiting · front desk' },
]
function panel({ night, sel }) {
  const deps = Object.entries(counts).slice(0, 9)
  return `<aside class="gpanel">
    <div class="sec"><div class="head"><span class="eyebrow">Fellows</span><span class="spacer"></span><span class="state">${night ? '2 at work' : '2 at work · 3 waiting'}</span></div>
      ${FELLOWS.map((f) => `<div class="frow${sel === f.name ? ' sel' : ''}"><span class="d" style="background:${f.c}; width:10px; height:10px; box-shadow:none"></span><span class="who"><b>${f.name}</b><span class="st">${night ? f.night : f.st}</span></span><span class="n" style="font-family:${MONO}; font-size:11px; color:${T.faint}">${f.dom.split('-')[0]}</span></div>`).join('')}
      <div style="margin-top:10px"><span class="btn primary wide">Spawn a Fellow</span></div>
    </div>
    <div class="sec"><div class="head"><span class="eyebrow">Show</span></div><div class="pillrow"><span class="pill on"><span class="dot"></span>Everyone</span><span class="pill"><span class="dot"></span>Fellows</span><span class="pill"><span class="dot"></span>Visitors</span><span class="pill"><span class="dot"></span>Caretakers</span></div></div>
    <div class="sec"><div class="head"><span class="eyebrow">Tonight</span><span class="spacer"></span><span class="state">01:00 to 06:00</span></div>
      <div class="facts"><div><b>3</b> steps planned, 2 approved</div><div><b>4.2 %</b> of the week, share is 10 %</div><div><b>${night ? '02:41' : '07:00'}</b> ${night ? 'now, step 2 of 3 running' : 'recap lands here and in Telegram'}</div></div>
    </div>
    <div class="sec grow"><div class="head"><span class="eyebrow">Departments</span><span class="spacer"></span><span class="state">17 shelves</span></div>
      ${deps.map(([d, n]) => `<div class="row"><span class="dot" style="background:${d === 'unassigned' ? T.borderStrong : domainColor(d)}"></span><span class="nm">${d === 'unassigned' ? 'unfiled' : d}</span><span class="n">${n}</span></div>`).join('')}
    </div>
  </aside>`
}

function canvas({ night, card }) {
  const legend = `<div class="legend${night ? ' dark' : ''}"><div class="l"><span class="sw" style="background:${T.accent}"></span>Fellow, named, lives here</div><div class="l"><span class="sw" style="background:${T.muted}"></span>Visitor: your run, a reader, the clerk</div><div class="l"><span class="sw" style="background:${T.gold}"></span>Notice board is hot.md, catalog is the index</div></div>`
  const nowChip = night
    ? `<span class="chip dark">${icon('moon', 14)}02:41 · night shift · step 2 of 3</span>`
    : `<span class="chip">${icon('sun', 14)}14:12 · day · 3 at work, one clerk unpacking</span>`
  return `<div class="wrap">
    <div class="controls"><span class="btn">Fit</span><span class="scope">Showing <b>894 books</b> in <b>17 departments</b> · ${night ? 'the night shift is on the floor' : '2 Fellows and 4 visitors on the floor'} · <a href="#">30 gaps</a></span><span class="btn">Shortcuts</span><span class="btn">${icon('ext', 14)}Fullscreen</span><span class="search">${icon('search', 15)}Search shelves or Fellows…</span></div>
    <div class="area${night ? ' night' : ''}">${scene({ night, card })}<div class="corner" style="left:12px; bottom:10px">${nowChip}</div><div class="corner" style="right:12px; bottom:10px">${legend}</div></div>
  </div>`
}

function cardAside() {
  return `<aside class="aside">
    <span class="close">${icon('x', 16)}</span>
    <div class="gx-head"><div class="kicker">Fellow · astronomy</div><div class="gx-title">Ada</div><div class="tags"><span class="tag">Sonnet 5 · high</span><span class="tag">standard steps</span><span class="tag">veto mode</span><span class="tag">1 step a day</span></div></div>
    <div class="gx-body">
      <div class="gx-sec"><p class="sub">Working on</p><div style="font-size:13px; font-weight:600">Limb darkening in transit photometry</div><div style="font-size:12px; color:${T.faint}">research-step · from the open questions of Research: Transit Depth</div>
        <div class="steps"><span class="step done"><i>1</i>Plan</span><span class="step"><span class="ln"></span></span><span class="step done"><i>2</i>Search</span><span class="step"><span class="ln"></span></span><span class="step now"><i>3</i>Read sources</span><span class="step"><span class="ln"></span></span><span class="step"><i>4</i>Write</span><span class="step"><span class="ln"></span></span><span class="step"><i>5</i>Commit</span></div>
        <div class="log">14:09  WebFetch  journal article, 41 KB
14:10  Read      wiki/concepts/Limb Darkening.md
14:11  WebFetch  survey paper, 38 KB · 6 of 10</div></div>
      <div class="gx-sec"><p class="sub">Intent</p><div style="font-size:12.5px; color:${T.dim}">How far can ground-based transit photometry constrain atmospheric retrievals, and where do the systematics come from?</div></div>
      <div class="gx-sec"><p class="sub">Articles</p><div class="kv"><span>Created</span><span>12 pages</span><span>Updated</span><span>5 pages</span></div><div class="list" style="margin-top:6px"><div class="it"><span class="t">Research: Transit Depth</span><span class="m">synthesis</span></div><div class="it"><span class="t">Stellar Activity Noise</span><span class="m">concept</span></div><div class="it"><span class="t">Detrending Baselines</span><span class="m">updated</span></div></div></div>
      <div class="gx-sec"><p class="sub">Plan</p><div class="plan"><div class="prop ok"><span class="k">A</span><span class="x">Compare detrending baselines across three surveys<small>approved · tonight · about 2 USD, 0.2 % of the week</small></span></div><div class="prop"><span class="k">B</span><span class="x">Deepen Stellar Activity Noise with the two open contradictions<small>pending · research-expand · about 3 USD</small></span></div><div class="prop"><span class="k">C</span><span class="x">Read the source ingested yesterday in astronomy<small>pending · research-step · about 2 USD</small></span></div></div></div>
      <div class="gx-sec"><div class="kv"><span>Last active</span><span>today 14:09</span><span>This week</span><span>4 of 7 runs · 2.3 of 10 pts</span><span>Opened</span><span>9 times this month</span></div></div>
      <div class="gx-sec"><div class="actions"><span class="btn sm">${icon('play', 12)}Run next step</span><span class="btn sm">${icon('pause', 12)}Pause</span><span class="btn sm">Veto tonight</span><span class="btn sm ghost">Notebook</span><span class="btn sm ghost">Ledger</span><span class="btn sm ghost">Open in Obsidian</span></div></div>
    </div>
  </aside>`
}

/* ------------------------------------------------------------------ sprite test */
const PIX = 4
function pixel(map, pal, x0, y0) {
  let g = ''
  map.forEach((row, y) => { [...row].forEach((ch, x) => { if (ch !== '.' && pal[ch]) g += `<rect x="${x0 + x * PIX}" y="${y0 + y * PIX}" width="${PIX}" height="${PIX}" fill="${pal[ch]}"/>` }) })
  return g
}
const PAL = { k: '#1a2333', s: '#e8c39e', h: '#5a3a22', b: '#3059c8', p: '#2b3550', w: '#ffffff', r: '#c93540', d: '#c3cde0', t: '#e6eaf3', g: '#8a95ad', y: '#d9b356' }
const SPR_SHELF = [
  '....kkkk....', '...khhhhk...', '...kssssk...', '...ksksks...', '....ksss....', '.....kk.....',
  '...kbbbbk...', '..kbbbbbbk..', '.kbkbbbbkbk.', '.ks.kbbk.rr.', '.kk.kbbk.rr.', '....kbbk.rr.',
  '....kbbk.rr.', '....kppk....', '....kppk....', '...kp..pk...', '...kp..pk...', '...kk..kk...',
]
const SPR_DESK = [
  '....kkkk....', '...khhhhk...', '...kssssk...', '...ksksks...', '....ksss....', '.....kk.....',
  '...kbbbbk...', '..kbbbbbbk..', '.kbkbbbbkbk.', '.ks.kbbk.sk.', '.kk......kk.', 'kddddddddddk',
  'kttttttttttk', 'kttwwwwttttk', 'kddddddddddk', '.kk......kk.', '.kk......kk.', '.kk......kk.',
]
const SPR_SLEEP = [
  '............', '............', '...kkkkkkk..', '..kddddddd..', '..kd.kkkk.k.', '..kdkhhhhkk.',
  '..kdksssskk.', '..kdksksskk.', '..kdkssss.k.', '..kdkkbbbkk.', '..kdkbbbbbk.', '..kdkbbbbbk.',
  '..kdgggggggk', '..kdggggggkk', '..kkkkkkkkk.', '..kk.....kk.', '..kk.....kk.', '............',
]
function spriteBoard() {
  const P = makeP(0, 0)
  // Style A: flat vector figures at 2x for inspection
  const A = (o) => `<svg viewBox="0 0 120 130" width="240" height="260" xmlns="http://www.w3.org/2000/svg">${o.shelf ? bookcase(makeP(46, 82), 0, 0, 'i', 1.3, 30, domainHue('astronomy'), false) : ''}${o.desk ? box(makeP(58, 108), 0, 0, 1.4, 0.8, 22, { top: '#eceff6', left: '#d6dce9', right: '#c3cde0' }) : ''}${figure(makeP(60, 118), 0, 0, o, false)}</svg>`
  const B = (map, extra = '') => `<svg viewBox="0 0 96 96" width="240" height="240" xmlns="http://www.w3.org/2000/svg" style="image-rendering: pixelated">${extra}${pixel(map, PAL, 24, 12)}</svg>`
  const cell = (title, note, svg) => `<div style="display:flex; flex-direction:column; gap:8px; align-items:center"><div style="border:1px solid ${T.border}; border-radius:12px; background:${T.elev}; padding:12px">${svg}</div><div style="font-size:12.5px; font-weight:600">${title}</div><div style="font-size:11.5px; color:${T.faint}; text-align:center; max-width:220px">${note}</div></div>`
  const props = `<svg viewBox="0 0 520 116" width="520" height="116" xmlns="http://www.w3.org/2000/svg">${bookcase(makeP(40, 70), 0, 0, 'i', 1.4, 40, domainHue('computing'), false)}${cart(makeP(150, 72), 0, 0, false)}${box(makeP(230, 74), 0, 0, 0.5, 0.4, 12, { top: '#e6cfa6', left: '#d9b98a', right: '#c9a672' })}${box(makeP(310, 74), 0, 0, 0.8, 0.8, 42, { top: '#e6eaf3', left: '#d6dce9', right: '#c3cde0' })}<rect x="392" y="30" width="26" height="34" rx="2" fill="#f5ecd7" stroke="#e0cfa2"/><rect x="396" y="36" width="18" height="3" fill="#d9c58f"/><rect x="396" y="44" width="14" height="3" fill="#d9c58f"/><rect x="396" y="52" width="16" height="3" fill="#d9c58f"/><rect x="460" y="30" width="22" height="30" rx="2" fill="#ffffff" stroke="#c3cde0"/><path d="M465 40h12M465 46h12M465 52h8" stroke="#c3cde0"/><text x="55" y="110" font-family='${FONT}' font-size="10.5" fill="${T.faint}" text-anchor="middle">shelf, books, thin volumes</text><text x="170" y="110" font-family='${FONT}' font-size="10.5" fill="${T.faint}" text-anchor="middle">cart</text><text x="245" y="110" font-family='${FONT}' font-size="10.5" fill="${T.faint}" text-anchor="middle">parcel</text><text x="330" y="110" font-family='${FONT}' font-size="10.5" fill="${T.faint}" text-anchor="middle">card catalog</text><text x="405" y="110" font-family='${FONT}' font-size="10.5" fill="${T.faint}" text-anchor="middle">notice board</text><text x="471" y="110" font-family='${FONT}' font-size="10.5" fill="${T.faint}" text-anchor="middle">clipboard</text></svg>`
  return `<div style="width:1440px; height:900px; box-sizing:border-box; padding:32px 40px; background:${T.bg}; display:flex; flex-direction:column; gap:22px; font-family:${FONT}; color:${T.text}">
    <div style="display:flex; align-items:baseline; gap:14px"><div style="font-family:${DISPLAY}; font-size:22px; font-weight:650">Sprite test</div><div style="font-size:13px; color:${T.dim}">one figure, three poses, two styles. Judge consistency across poses, readability at 100 %, and how props read on top.</div></div>
    <div style="display:grid; grid-template-columns: 150px repeat(3, minmax(0, 1fr)); gap:18px; align-items:start">
      <div style="padding-top:12px"><div style="font-size:11px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; color:${T.dim}">Style A</div><div style="font-size:13px; font-weight:600; margin-top:4px">Flat vector</div><div style="font-size:11.5px; color:${T.faint}; margin-top:4px">Drawn from the dashboard tokens. Scales with the canvas, recolors per domain, cheap to extend with a new prop.</div></div>
      ${cell('At the shelf', 'reading, book in the domain color', A({ pose: 'shelf', shelf: true, book: domainColor('astronomy') }))}
      ${cell('At the desk', 'writing, page on the desk', A({ pose: 'desk', desk: true }))}
      ${cell('Asleep', 'armchair in the reading room', A({ pose: 'sleep' }))}
      <div style="padding-top:12px"><div style="font-size:11px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; color:${T.dim}">Style B</div><div style="font-size:13px; font-weight:600; margin-top:4px">Pixel art</div><div style="font-size:11.5px; color:${T.faint}; margin-top:4px">4 px grid, 12 by 18 cells. More charm, less range: every new pose and prop is hand-placed pixels.</div></div>
      ${cell('At the shelf', 'reading, book in the domain color', B(SPR_SHELF))}
      ${cell('At the desk', 'writing, desk as pixel block', B(SPR_DESK))}
      ${cell('Asleep', 'armchair, side view', B(SPR_SLEEP))}
    </div>
    <div style="display:flex; align-items:center; gap:18px"><div style="font-size:11px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; color:${T.dim}; width:150px">Props, style A</div><div style="border:1px solid ${T.border}; border-radius:12px; background:${T.elev}; padding:8px 12px">${props}</div></div>
  </div>`
}

/* ------------------------------------------------------------------- assemble */
const doc = (title, css, body) => `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <title>${title}</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@400;600;700&amp;family=Instrument+Sans:wght@400;500;600;700&amp;family=IBM+Plex+Mono:wght@400;500;600&amp;display=swap">
  <style>${css}</style>
</helmet>
${body}
</x-dc>
</body>
</html>
`
const day = shell({ night: false, badge: '2', body: panel({ night: false }) + `<div class="stage">${canvas({ night: false, card: false })}</div>` })
seed = 7
const night = shell({ night: true, badge: '2', body: panel({ night: true }) + `<div class="stage">${canvas({ night: true, card: false })}</div>` })
seed = 7
const card = shell({ night: false, badge: '2', height: 1130, body: panel({ night: false, sel: 'Ada' }) + `<div class="stage">${canvas({ night: false, card: true })}${cardAside()}</div>` })
fs.writeFileSync('Main.dc.html', doc('Library, day', CSS, day))
fs.writeFileSync('Night.dc.html', doc('Library, night shift', CSS, night))
fs.writeFileSync('Card.dc.html', doc('Library, Fellow card', CSS, card))
fs.writeFileSync('Sprites.dc.html', doc('Sprite test', `body { margin:0; background:${T.bg}; } a { color:${T.accent}; } a:hover { color:${T.accent}; }`, spriteBoard()))
fs.writeFileSync('canvas.json', JSON.stringify({
  artboards: [
    { file: 'Main.dc.html', x: 0, y: 0, w: 1440, h: 900, title: 'Library · day' },
    { file: 'Night.dc.html', x: 1560, y: 0, w: 1440, h: 900, title: 'Library · night shift' },
    { file: 'Card.dc.html', x: 0, y: 1060, w: 1440, h: 1130, title: 'Library · Fellow card docked' },
    { file: 'Sprites.dc.html', x: 1560, y: 1060, w: 1440, h: 900, title: 'Sprite test · style A vs B' },
  ],
  annotations: [
    { id: 'brief', x: 0, y: -150, w: 520, text: 'Library screen, first design round (SPEC section 10).\nShell, tokens and controls are lifted from the dashboard (light theme, Bricolage / Instrument Sans / IBM Plex Mono, 252 px control column, 32 px controls).\nRoom: departments from the demo vault registry, books sized by page count, front desk, reading room, notice board = hot.md, catalog = index.' },
    { id: 'night-note', x: 1560, y: -110, w: 420, text: 'Night shift: dark floor, lamps only where someone works. Mutex drawn literally: Ibra waits at the front desk while Ada runs.' },
    { id: 'card-note', x: 0, y: 960, w: 420, text: 'Card docked right per DESIGN.md (canvas shrinks, no overlay on a control corner). Fields per SPEC 10.5, live run with phase bar and log tail.' },
    { id: 'sprite-note', x: 1560, y: 960, w: 520, text: 'OPEN-15 sprite test: decide style A (flat vector, token colors, recolors per domain) or B (pixel art). Also open: do the figures need faces at this size?' },
  ],
  launch: { view: 'canvas' },
}, null, 2))
console.log('wrote', ['Main', 'Night', 'Card', 'Sprites'].map((n) => `${n}.dc.html ${fs.statSync(n + '.dc.html').size} B`).join(', '))
