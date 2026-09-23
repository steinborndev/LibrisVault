/**
 * The scripted half of the domain split's end-to-end test (docs/tasks/TASKS-DOMAIN-SPLIT.md,
 * phase 7). Milestone A's stages are here: E0 to E3, the [A] half of E10, E11 and E12. The
 * [B] stages (E4 to E9, the write) are added with milestone B.
 *
 *   node --experimental-websocket scripts/e2e-domain-split.mjs --stage E0 --port 8435 \
 *     --vault ~/e2e-split/vault
 *   … --stage E1         after the copy and the snapshot are taken (setup commands: E1 in the plan)
 *   … --stage E2,E3 --cdp http://127.0.0.1:9335    once the instance runs on --port
 *   … --stage E10 --expect-agents off --cdp …      after a restart with AGENTS_ENABLED=0
 *   … --stage E10 --expect-demo --cdp …            after a restart with DEMO_MODE=1
 *   … --stage E11        the live system untouched
 *   … --stage E12        stops the instance on --port (the worktree and the copy are removed by
 *                        hand, after the results are recorded and the user agrees)
 *
 * IT REFUSES TO RUN against the live vault. `--vault` must not be `~/vault` by realpath, and
 * every stage that talks to the instance first checks that the process listening on `--port`
 * has `VAULT_ROOT` equal to `--vault` in its `/proc/<pid>/environ` - identity, not merely an
 * HTTP 200 (the lesson of TASKS-E2E-SETUP.md). E0 is the one stage that asserts the port is
 * FREE instead: it runs before the instance exists.
 *
 * Output is PASS or FAIL per check with its numbers, a summary, and a non-zero exit on any
 * FAIL. Numbers only, never a page title or a tag, so a run can be quoted into the task file
 * (hard rule 7); the screenshots it takes show real vault names and stay under `--shots`.
 *
 * It records the copy's HEAD before and after every stage, so a commit a stage did not make (a
 * recap written in the background, say) is listed and explained rather than miscounted.
 *
 * Waiting is done on the DOM, never on the network: the dashboard keeps an SSE connection
 * open, so "network idle" never comes. localStorage is cleared before each screen, because the
 * domain selection survives a reload.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/* ---------------------------------------------------------------------------------- args */

const argv = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(name)
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const expandHome = (p) => (p?.startsWith('~/') ? join(homedir(), p.slice(2)) : p)

const STAGES = (arg('--stage') ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
const PORT = Number(arg('--port', '8435'))
const VAULT = expandHome(arg('--vault'))
const LIVE_PORT = Number(arg('--live-port', '8421'))
const LIVE_VAULT = expandHome(arg('--live-vault', '~/vault'))
const LIVE_DB = expandHome(arg('--live-db', '~/.local/share/librisvault-dev/jobs.db'))
const DATA = VAULT ? join(dirname(VAULT), 'data') : null
const DB = expandHome(arg('--db')) ?? (DATA ? join(DATA, 'jobs.db') : null)
const LOG = expandHome(arg('--log')) ?? (DATA ? join(DATA, 'service.log') : null)
const STATE = expandHome(arg('--state')) ?? (DATA ? join(DATA, 'e2e-state.json') : null)
const SHOTS = expandHome(arg('--shots')) ?? (VAULT ? join(dirname(VAULT), 'shots') : null)
const UI = arg('--ui', `http://127.0.0.1:${PORT}`)
const CDP = arg('--cdp')
const EXPECT_AGENTS = arg('--expect-agents') // 'on' | 'off' | null
const EXPECT_DEMO = has('--expect-demo')
const EXPECT_DB_VERSION = Number(arg('--expect-db-version', '36'))
const EXPECT_SIZES = arg('--expect-sizes') // "161,67,…" sorted descending, optional
const RUN_CHECKS = arg('--run-checks') // a checkout to run test, typecheck and lint in (E0)

if (STAGES.length === 0 || !VAULT) {
  console.error('usage: e2e-domain-split.mjs --stage <E0,E1,E2,E3,E10,E11,E12> --vault <copy> [--port 8435] [--cdp url] …')
  process.exit(2)
}

/* ------------------------------------------------------------------------------- results */

const results = []
function check(stage, name, ok, detail = '') {
  results.push({ stage, name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  return ok
}
const note = (text) => console.log(`        ${text}`)

/* ---------------------------------------------------------------------------------- guard */

const real = (p) => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}
if (real(VAULT) === real(LIVE_VAULT)) {
  console.error(`refusing: --vault ${VAULT} is the live vault ${LIVE_VAULT}`)
  process.exit(2)
}

/** The pid listening on a TCP port, or null. */
function listener(port) {
  const out = execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' })
  const m = /pid=(\d+)/.exec(out)
  return m ? Number(m[1]) : null
}
const environOf = (pid) =>
  Object.fromEntries(
    readFileSync(`/proc/${pid}/environ`, 'utf8')
      .split('\0')
      .filter(Boolean)
      .map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]),
  )

function assertIdentity() {
  const pid = listener(PORT)
  if (pid === null) {
    console.error(`refusing: nothing listens on port ${PORT}`)
    process.exit(2)
  }
  const env = environOf(pid)
  if (!env.VAULT_ROOT || real(env.VAULT_ROOT) !== real(VAULT) || real(env.VAULT_ROOT) === real(LIVE_VAULT)) {
    console.error(`refusing: pid ${pid} on ${PORT} has VAULT_ROOT=${env.VAULT_ROOT ?? '(unset)'}, not ${VAULT}`)
    process.exit(2)
  }
  return { pid, env }
}

/* -------------------------------------------------------------------------------- helpers */

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim()
const sqlite = (db, sql) => execFileSync('sqlite3', ['-readonly', db, sql], { encoding: 'utf8' }).trim()
const loadState = () => (STATE && existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {})
const saveState = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2))

async function getJson(base, path) {
  const res = await fetch(`${base}${path}`)
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() }
}
const api = (path) => getJson(`http://127.0.0.1:${PORT}`, path)
const liveApi = (path) => getJson(`http://127.0.0.1:${LIVE_PORT}`, path)

/** Status counts of the `jobs` table, for comparing a snapshot with what an instance reports. */
function jobCounts(db) {
  const out = {}
  for (const line of sqlite(db, 'SELECT status, count(*) FROM jobs GROUP BY status ORDER BY status').split('\n')) {
    if (!line) continue
    const [status, n] = line.split('|')
    out[status] = Number(n)
  }
  return out
}
const sameCounts = (a, b) => JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort())

/** The largest department domain of a graph payload, by knowledge pages. */
function largestDomain(graph) {
  const counts = new Map()
  let knowledge = 0
  for (const n of graph.nodes) {
    if ((n.kind ?? 'knowledge') !== 'knowledge' || n.origin === 'upstream-demo') continue
    knowledge++
    if (n.domain === null || n.domain === 'meta' || n.domain === 'unassigned') continue
    counts.set(n.domain, (counts.get(n.domain) ?? 0) + 1)
  }
  const [domain, pages] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
  return { domain, pages, share: pages / knowledge }
}

/** The Fellow-only routes (server/test/agents-flag-off.test.ts, GATED). */
const FELLOW_ROUTES = ['/api/v1/agents', '/api/v1/recaps', '/api/v1/library/scene', '/api/v1/wings', '/api/v1/usage/plan', '/api/v1/reading-list', '/api/v1/questions']

/* ------------------------------------------------------------------------------------ CDP */

async function cdpPage(cdpBase) {
  const target = await (await fetch(`${cdpBase}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, fail) => {
    ws.onopen = ok
    ws.onerror = fail
  })
  let id = 0
  const pending = new Map()
  const listeners = []
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { ok, fail } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) fail(new Error(msg.error.message))
      else ok(msg.result)
    } else if (msg.method) for (const l of listeners) l(msg)
  }
  const send = (method, params = {}) =>
    new Promise((ok, fail) => {
      pending.set(++id, { ok, fail })
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed')
    return r.result.value
  }
  const waitFor = async (expression, timeoutMs = 30000) => {
    const until = Date.now() + timeoutMs
    for (;;) {
      const v = await evaluate(expression).catch(() => null)
      if (v) return v
      if (Date.now() > until) return null
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  const network = []
  listeners.push((m) => {
    if (m.method === 'Network.responseReceived') network.push({ url: m.params.response.url, status: m.params.response.status })
    if (m.method === 'Network.requestWillBeSent') network.push({ url: m.params.request.url, status: null })
  })
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  const goto = async (url) => {
    await send('Page.navigate', { url })
    await waitFor(`document.readyState === 'complete'`, 20000)
  }
  const shot = async (file) => {
    if (!SHOTS) return
    mkdirSync(SHOTS, { recursive: true })
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(SHOTS, file), Buffer.from(data, 'base64'))
  }
  const close = async () => {
    ws.close()
    await fetch(`${cdpBase}/json/close/${target.id}`).catch(() => {})
  }
  return { send, evaluate, waitFor, goto, shot, close, network }
}

/** A JS string literal of a value, for building expressions. */
const lit = (v) => JSON.stringify(v)

/* --------------------------------------------------------------------------------- stages */

async function stageE0() {
  console.log('\nE0: preconditions')
  const health = await liveApi('/api/v1/health')
  check('E0', 'live instance answers', health.status === 200, `port ${LIVE_PORT}`)
  check('E0', 'live queue idle', health.body?.queue?.inFlight === 0, `inFlight ${health.body?.queue?.inFlight}`)
  const runs = await liveApi('/api/v1/maintenance/runs')
  const running = (runs.body?.runs ?? []).filter((r) => r.status === 'running').length
  check('E0', 'no maintenance run in flight', running === 0, `${running} running`)
  const dirty = git(LIVE_VAULT, 'status', '--short')
  check('E0', 'live vault clean', dirty === '', `${dirty === '' ? 0 : dirty.split('\n').length} paths`)
  const hour = new Date().getHours()
  check('E0', 'outside the night window (01:00 to 06:00)', hour < 1 || hour >= 6, `hour ${hour}`)
  check('E0', `port ${PORT} free`, listener(PORT) === null)
  const avail = Number(execFileSync('df', ['-k', '--output=avail', homedir()], { encoding: 'utf8' }).trim().split('\n').pop()) * 1024
  check('E0', 'at least 10 GB free', avail >= 10e9, `${(avail / 1e9).toFixed(0)} GB`)
  if (RUN_CHECKS) {
    for (const cmd of ['test', 'typecheck', 'lint']) {
      let ok = true
      try {
        execFileSync('npm', ['run', '-s', cmd], { cwd: RUN_CHECKS, stdio: 'ignore' })
      } catch {
        ok = false
      }
      check('E0', `npm run ${cmd} exits 0`, ok, RUN_CHECKS)
    }
  } else note('the three commands: not run here (pass --run-checks <checkout>)')
  const liveHead = git(LIVE_VAULT, 'rev-parse', 'HEAD')
  const liveJobs = health.body?.jobs ?? {}
  saveState({ ...loadState(), liveHead, liveJobs, e0At: new Date().toISOString() })
  note(`recorded: live HEAD ${liveHead.slice(0, 8)}, live jobs ${JSON.stringify(liveJobs)}`)
}

async function stageE1() {
  console.log('\nE1: the copy')
  const state = loadState()
  const head = git(VAULT, 'rev-parse', 'HEAD')
  check('E1', "the copy's HEAD equals E0's live HEAD", head === state.liveHead, `${head.slice(0, 8)} vs ${(state.liveHead ?? '').slice(0, 8)}`)
  const dirty = git(VAULT, 'status', '--short')
  check('E1', 'the copy is clean', dirty === '', `${dirty === '' ? 0 : dirty.split('\n').length} paths`)
  const pushUrls = git(VAULT, 'remote', '-v').split('\n').filter((l) => l.endsWith('(push)'))
  check('E1', 'every push URL is disabled', pushUrls.every((l) => l.includes('PUSH_DISABLED')), `${pushUrls.length} push URLs`)
  const vCopy = Number(sqlite(DB, 'PRAGMA user_version'))
  const vLive = Number(sqlite(LIVE_DB, 'PRAGMA user_version'))
  check('E1', "the snapshot's user_version equals the live one", vCopy === vLive, `${vCopy} vs ${vLive}`)
  const snapshotJobs = jobCounts(DB)
  saveState({ ...state, snapshotJobs, snapshotVersion: vCopy })
  note(`recorded: snapshot jobs ${JSON.stringify(snapshotJobs)}`)
}

async function stageE2() {
  console.log('\nE2: the instance')
  const { pid, env } = assertIdentity()
  check('E2', 'the pid on the port runs against the copy', real(env.VAULT_ROOT) === real(VAULT), `pid ${pid}`)
  check('E2', 'the bot token is empty in its environment', env.TELEGRAM_BOT_TOKEN === '')
  const lines = readFileSync(LOG, 'utf8').split('\n')
  check('E2', "the log's first line names the copy", (lines[0] ?? '').includes(VAULT))
  const started = lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter((o) => o?.msg === 'vault-service started').pop()
  check('E2', 'the startup log names the copy and the bot off', started?.vaultRoot === VAULT && started?.telegram === 'off', `telegram ${started?.telegram}`)
  const health = await api('/api/v1/health')
  const state = loadState()
  check('E2', "health shows the snapshot's job counts", sameCounts(health.body?.jobs, state.snapshotJobs), JSON.stringify(health.body?.jobs))
  const v = Number(sqlite(DB, 'PRAGMA user_version'))
  check('E2', 'the database is at the expected version', v === EXPECT_DB_VERSION, `user_version ${v}`)
  check('E2', 'quick_check ok', sqlite(DB, 'PRAGMA quick_check') === 'ok')
}

/** The proposal checks of E3 against the route, splitprobe and the stability bounds. */
async function proposalChecks(stage) {
  const graph = await api('/api/v1/graph')
  const parent = largestDomain(graph.body)
  note(`PARENT: the largest department domain, ${parent.pages} knowledge pages (${(parent.share * 100).toFixed(1)} %)`)
  const a = await api(`/api/v1/domains/${encodeURIComponent(parent.domain)}/split`)
  const b = await api(`/api/v1/domains/${encodeURIComponent(parent.domain)}/split`)
  check(stage, 'the route answers 200', a.status === 200)
  check(stage, 'two calls return deep-equal bodies', JSON.stringify(a.body) === JSON.stringify(b.body))
  const p = a.body
  const sizes = [...p.shelves.map((s) => s.size)].sort((x, y) => y - x)
  note(`shelves ${p.shelves.length}: ${sizes.join(', ')}; with the parent ${p.totals.withParent}`)
  if (EXPECT_SIZES) check(stage, 'the shelf sizes are the expected ones', sizes.join(',') === EXPECT_SIZES, EXPECT_SIZES)
  let probe = null
  try {
    const out = execFileSync('npx', ['tsx', 'server/src/cli/splitprobe.ts', '--vault', VAULT, parent.domain, '--stability', '--json'], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    probe = JSON.parse(out)
  } catch (err) {
    note(`splitprobe failed: ${err.message.split('\n')[0]}`)
  }
  check(stage, 'the route returns exactly what splitprobe computes for this vault', probe !== null && JSON.stringify(probe.proposal) === JSON.stringify(p))
  for (const c of probe?.stability ?? []) {
    const bounded = c.case === 'seed+1' || c.case === '3d'
    if (bounded) check(stage, `${c.case === '3d' ? 'three days back' : 'another seed'} moves at most 1 %`, c.share <= 0.01, `${c.moved} of ${c.common}, ${(c.share * 100).toFixed(1)} %`)
    else note(`${c.case}: ${c.moved} of ${c.common} (${(c.share * 100).toFixed(1)} %), ${c.shelves} shelves`)
  }
  const wrong = p.shelves.filter((s) => s.misfile !== (s.precision !== null && s.precision < 0.6))
  check(stage, 'the misfiling warning is on exactly the shelves under precision 0.6', wrong.length === 0, `${p.shelves.filter((s) => s.misfile).length} warned`)
  return { parent, proposal: p }
}

/** The UI walk of E3 (and E10): Graph, Catalog, System, with the network log. */
async function uiWalk(stage, parent, p, tag) {
  if (!CDP) {
    note('UI walk skipped: no --cdp')
    return
  }
  const page = await cdpPage(CDP)
  try {
    const chips = [...p.shelves.map((s) => s.size), ...(p.rest.size > 0 ? [p.rest.size] : [])]
    // Graph, filtered to the parent through the saved view preferences.
    await page.goto(`${UI}/`)
    await page.evaluate(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('vault.graphPrefs', ${lit(
      JSON.stringify({ v: 2, lens: 'domain', selectedTypes: [], selectedDomains: [parent.domain], showClusters: false, showGaps: false, showNetwork: false, spotlight: false, showSystem: false, landmarks: null }),
    )}); true`)
    await page.goto(`${UI}/graph`)
    await page.waitFor(`[...document.querySelectorAll('canvas')].some((c) => c.getBoundingClientRect().height > 300)`)
    const toggle = `[...document.querySelectorAll('button.rowtoggle')].find((b) => b.querySelector('.tname')?.textContent === 'Shelves')`
    const enabled = await page.waitFor(`(${toggle}) && !(${toggle}).disabled`, 20000)
    check(stage, 'the Shelves switch is available for the parent', Boolean(enabled))
    await page.evaluate(`(${toggle}).click(); true`)
    const shown = await page.waitFor(
      `(() => { const b = [...document.querySelectorAll('.gs-shelves button')]; return b.length === ${chips.length} ? b.map((x) => Number(x.querySelector('.chip-n')?.textContent)) : null })()`,
      30000,
    )
    check(stage, 'one chip per shelf plus the rest, each with the route\'s size', JSON.stringify(shown) === JSON.stringify(chips), `${shown?.length ?? 0} chips`)
    const hulls = await page.waitFor(
      `(() => { const c = [...document.querySelectorAll('canvas')].find((x) => x.dataset.hulls !== undefined && x.getBoundingClientRect().height > 300); return c && Number(c.dataset.hulls) === ${p.shelves.length} ? Number(c.dataset.hulls) : null })()`,
      30000,
    )
    check(stage, 'one hull per shelf', hulls === p.shelves.length, `${hulls ?? 'n/a'} hulls, ${p.shelves.length} shelves`)
    await new Promise((r) => setTimeout(r, 4000))
    await page.shot(`${tag}-graph-shelves.png`)
    const showing = `Number((/Showing\\s+(\\d+)\\s+of/.exec(document.querySelector('.scopeline')?.textContent ?? '') ?? [])[1])`
    let narrowOk = 0
    for (let i = 0; i < chips.length; i++) {
      await page.evaluate(`document.querySelectorAll('.gs-shelves button')[${i}].click(); true`)
      const n = await page.waitFor(`${showing} === ${chips[i]} ? ${showing} : null`, 15000)
      if (n === chips[i]) narrowOk++
      else note(`chip ${i + 1}: Showing ${await page.evaluate(showing)} against ${chips[i]}`)
      if (i === 0) await page.shot(`${tag}-graph-chip1.png`)
      await page.evaluate(`document.querySelectorAll('.gs-shelves button')[${i}].click(); true`)
    }
    check(stage, 'every chip narrows the Graph to exactly its size', narrowOk === chips.length, `${narrowOk} of ${chips.length}`)

    // Catalog, the same chips when the parent is the one domain selected.
    await page.evaluate(`localStorage.clear(); true`)
    await page.goto(`${UI}/catalog?domain=${encodeURIComponent(parent.domain)}`)
    const section = `[...document.querySelectorAll('.gpanel .gp-sec')].find((s) => s.querySelector('.gp-eyebrow')?.textContent === 'Shelves')`
    const catChips = await page.waitFor(`(() => { const s = ${section}; return s ? s.querySelectorAll('button.chip').length : null })()`, 30000)
    check(stage, 'the Catalog shows the same chips', catChips === chips.length, `${catChips ?? 0} chips`)
    const rows = `document.querySelectorAll('table.lib-table tbody tr').length`
    let rowsOk = 0
    for (let i = 0; i < chips.length && catChips === chips.length; i++) {
      await page.evaluate(`(${section}).querySelectorAll('button.chip')[${i}].click(); true`)
      const n = await page.waitFor(`${rows} === ${chips[i]} ? ${rows} : null`, 15000)
      if (n === chips[i]) rowsOk++
      else note(`catalog chip ${i + 1}: ${await page.evaluate(rows)} rows against ${chips[i]}`)
      if (i === 0) await page.shot(`${tag}-catalog-chip1.png`)
      await page.evaluate(`(${section}).querySelectorAll('button.chip')[${i}].click(); true`)
    }
    check(stage, 'every Catalog chip shows exactly its number of rows', rowsOk === chips.length, `${rowsOk} of ${chips.length}`)

    // System: the status item, and the panel it jumps to.
    await page.goto(`${UI}/system`)
    const item = `[...document.querySelectorAll('.ms-item')].find((b) => b.querySelector('.ms-title')?.textContent.startsWith('One domain holds'))`
    const title = await page.waitFor(`(${item})?.querySelector('.ms-title')?.textContent ?? null`, 30000)
    const pct = Math.round(parent.share * 100)
    check(stage, 'the status item is recommended and names the share', title === `One domain holds ${pct} % of the vault` && (await page.evaluate(`(${item})?.querySelector('.sev')?.classList.contains('rec') === true`)), title ?? 'absent')
    if (title) await page.evaluate(`(${item}).click(); true`)
    const cards = await page.waitFor(
      `(() => { const c = [...document.querySelectorAll('.split-shelf')]; return c.length === ${p.shelves.length} ? c.map((x) => Number(/^(\\d+) pages/.exec(x.querySelector('.candidate-head .candidate-meta')?.textContent ?? '')?.[1])) : null })()`,
      30000,
    )
    check(stage, "the System panel shows the shelves in the route's rank order and sizes", JSON.stringify(cards) === JSON.stringify(p.shelves.map((s) => s.size)), `${cards?.length ?? 0} cards`)
    const numbers = await page.evaluate(`[...document.querySelectorAll('.split-shelf .split-numbers')].map((x) => x.textContent)`)
    const expected = p.shelves.map((s) => `${Math.round(s.conductance * 100)} % of links leave it`)
    check(stage, "the panel's conductance figures are the route's", numbers.length === expected.length && numbers.every((t, i) => t.startsWith(expected[i])))
    const warned = await page.evaluate(`document.querySelectorAll('.split-shelf.misfile').length`)
    check(stage, 'the panel warns on the misfiling shelves only', warned === p.shelves.filter((s) => s.misfile).length, `${warned} warned`)
    await page.shot(`${tag}-system-panel.png`)

    const api404 = page.network.filter((r) => r.status === 404 && r.url.includes('/api/'))
    check(stage, 'no API request answered 404 during the walk', api404.length === 0, `${api404.length} of ${page.network.filter((r) => r.status !== null).length} responses`)
    // Route paths only, never a query string: a query can carry a page path of the vault.
    for (const r of api404) note(`404: ${new URL(r.url).pathname}`)
    if (EXPECT_AGENTS === 'off') {
      const fellow = page.network.filter((r) => FELLOW_ROUTES.some((f) => new URL(r.url).pathname.startsWith(f)))
      check(stage, 'no request to a Fellow route', fellow.length === 0, `${fellow.length} requests`)
      for (const path of new Set(fellow.map((r) => new URL(r.url).pathname))) note(`Fellow route asked: ${path}`)
    }
  } finally {
    await page.close()
  }
}

async function stageE3() {
  console.log('\nE3: the proposal and the view')
  assertIdentity()
  const { parent, proposal } = await proposalChecks('E3')
  await uiWalk('E3', parent, proposal, 'e3')
}

async function stageE10() {
  console.log(`\nE10: the ${EXPECT_DEMO ? 'demo' : 'flag-off'} walk`)
  assertIdentity()
  const health = await api('/api/v1/health')
  if (EXPECT_AGENTS === 'off') check('E10', 'health.fellows is the boolean false', health.body?.fellows === false, JSON.stringify(health.body?.fellows))
  if (EXPECT_DEMO) check('E10', 'health.demoMode is true', health.body?.demoMode === true)
  const graph = await api('/api/v1/graph')
  const parent = largestDomain(graph.body)
  const r = await api(`/api/v1/domains/${encodeURIComponent(parent.domain)}/split`)
  check('E10', 'the GET route works', r.status === 200 && Array.isArray(r.body?.shelves), `${r.status}`)
  await uiWalk('E10', parent, r.body, EXPECT_DEMO ? 'e10-demo' : 'e10-flagoff')
}

async function stageE11() {
  console.log('\nE11: the live system untouched')
  const state = loadState()
  const head = git(LIVE_VAULT, 'rev-parse', 'HEAD')
  check('E11', "the live vault's HEAD equals E0's", head === state.liveHead, `${head.slice(0, 8)}`)
  const dirty = git(LIVE_VAULT, 'status', '--short')
  check('E11', 'the live vault is clean', dirty === '')
  const health = await liveApi('/api/v1/health')
  check('E11', 'the live instance answers', health.status === 200)
  note(`live jobs now ${JSON.stringify(health.body?.jobs)}, at E0 ${JSON.stringify(state.liveJobs)}`)
  const html = await (await fetch(`http://127.0.0.1:${LIVE_PORT}/`)).text()
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1])
  let ok = 0
  for (const a of assets) if ((await fetch(`http://127.0.0.1:${LIVE_PORT}${a}`)).status === 200) ok++
  check('E11', "the live UI's own assets answer 200", assets.length > 0 && ok === assets.length, `${ok} of ${assets.length}`)
}

async function stageE12() {
  console.log('\nE12: teardown')
  const pid = listener(PORT)
  if (pid === null) {
    check('E12', `nothing listens on ${PORT}`, true)
    return
  }
  const env = environOf(pid)
  const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
  if (env.PORT !== String(PORT) || comm !== 'node' || real(env.VAULT_ROOT ?? '') !== real(VAULT)) {
    check('E12', 'the listener is our instance', false, `PORT=${env.PORT} comm=${comm}`)
    return
  }
  process.kill(pid, 'SIGTERM')
  const until = Date.now() + 30000
  while (Date.now() < until && existsSync(`/proc/${pid}`)) await new Promise((r) => setTimeout(r, 250))
  if (existsSync(`/proc/${pid}`)) process.kill(pid, 'SIGKILL')
  await new Promise((r) => setTimeout(r, 500))
  check('E12', `the instance on ${PORT} is stopped`, listener(PORT) === null, `pid ${pid}`)
  note(`still by hand: git -C ${REPO} worktree remove <app>; rm -rf ${dirname(VAULT)} once the results are recorded and agreed`)
}

/* ----------------------------------------------------------------------------------- main */

const RUN = { E0: stageE0, E1: stageE1, E2: stageE2, E3: stageE3, E10: stageE10, E11: stageE11, E12: stageE12 }
for (const stage of STAGES) {
  if (!RUN[stage]) {
    console.error(`unknown stage ${stage} (milestone A: ${Object.keys(RUN).join(', ')})`)
    process.exit(2)
  }
  const copyHead = () => (existsSync(join(VAULT, '.git')) ? git(VAULT, 'rev-parse', 'HEAD') : null)
  const before = copyHead()
  await RUN[stage]()
  const after = copyHead()
  if (before !== null && after !== null && before !== after) {
    const subjects = git(VAULT, 'log', '--format=%s', `${before}..${after}`).split('\n').filter(Boolean)
    const kinds = [...new Set(subjects.map((s) => s.split(':')[0]))]
    note(`the copy's HEAD moved during ${stage}: ${subjects.length} commit(s), kinds ${kinds.join(', ')}`)
  } else if (before !== null) note(`the copy's HEAD unmoved during ${stage} (${(after ?? '').slice(0, 8)})`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} PASS, ${failed.length} FAIL`)
for (const f of failed) console.log(`  FAIL  ${f.stage}  ${f.name}`)
process.exitCode = failed.length > 0 ? 1 : 0
