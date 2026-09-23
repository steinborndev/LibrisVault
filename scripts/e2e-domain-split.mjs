/**
 * The scripted half of the domain split's end-to-end test (docs/tasks/TASKS-DOMAIN-SPLIT.md,
 * phase 7): every stage, E0 to E12. The [A] stages were written with milestone A, the [B]
 * stages (E4 to E9, the write, and the [B] halves of E10) with milestone B.
 *
 *   node --experimental-websocket scripts/e2e-domain-split.mjs --stage E0 --port 8435 \
 *     --vault ~/e2e-split/vault
 *   … --stage E1         after the copy and the snapshot are taken (setup commands: E1 in the plan)
 *   … --stage E2,E3 --cdp http://127.0.0.1:9335    once the instance runs on --port
 *   … --stage E10 --expect-agents off --cdp …      after a restart with AGENTS_ENABLED=0
 *   … --stage E10 --expect-demo --cdp …            after a restart with DEMO_MODE=1
 *   … --stage E11        the live system untouched
 *   … --stage E4,E5,E6 --cdp … [--naming | --keys a,b,c]
 *                        the decision set, the plan and the apply, in ONE browser page: the
 *                        decisions live in the page, so the three stages share it. `--naming`
 *                        runs the paid naming pass (about $0.40, asked of the user first);
 *                        `--keys` types three keys by hand instead
 *   … --stage E7 --cdp … the remainder, re-filed through the panel
 *   … --stage E8 (--doc <file> | --url <url>)
 *                        a real ingest after the split (paid, $1 to $2, asked of the user first)
 *   … --stage E9         the revert, refused and then done
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
const EXPECT_DB_VERSION = Number(arg('--expect-db-version', '37'))
const EXPECT_SIZES = arg('--expect-sizes') // "161,67,…" sorted descending, optional
const RUN_CHECKS = arg('--run-checks') // a checkout to run test, typecheck and lint in (E0)
const NAMING = has('--naming') // E4: run the paid naming pass
const KEYS = arg('--keys') // E4 without the naming pass: three keys, typed by hand
const DOC = expandHome(arg('--doc')) // E8: the document to ingest
const URL_DOC = arg('--url') // E8: or a URL

if (STAGES.length === 0 || !VAULT) {
  console.error('usage: e2e-domain-split.mjs --stage <E0,…,E12> --vault <copy> [--port 8435] [--cdp url] …')
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
    if (m.method === 'Network.responseReceived') network.push({ id: m.params.requestId, url: m.params.response.url, status: m.params.response.status })
    if (m.method === 'Network.requestWillBeSent')
      network.push({ id: m.params.requestId, url: m.params.request.url, status: null, method: m.params.request.method, postData: m.params.request.postData ?? null })
  })
  /** The body of a response the page received, once it has finished loading. */
  const responseBody = async (requestId) => {
    const r = await send('Network.getResponseBody', { requestId })
    return r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body
  }
  /** Waits for the response to the next request matching `pred` issued after `since` entries. */
  const awaitResponse = async (pred, since, timeoutMs = 60000) => {
    const until = Date.now() + timeoutMs
    for (;;) {
      const req = network.slice(since).find((r) => r.status === null && pred(r))
      const res = req ? network.find((r) => r.id === req.id && r.status !== null) : undefined
      if (res) {
        for (let i = 0; i < 40; i++) {
          try {
            return { status: res.status, request: req, body: JSON.parse(await responseBody(res.id)) }
          } catch {
            await new Promise((r) => setTimeout(r, 250))
          }
        }
        return { status: res.status, request: req, body: null }
      }
      if (Date.now() > until) return null
      await new Promise((r) => setTimeout(r, 250))
    }
  }
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
  return { send, evaluate, waitFor, goto, shot, close, network, awaitResponse }
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
  // `decisions` rides beside the proposal in the route's answer (6.3); the proposal is the rest.
  const { decisions: _decisions, ...proposalOnly } = p
  check(stage, 'the route returns exactly what splitprobe computes for this vault', probe !== null && JSON.stringify(probe.proposal) === JSON.stringify(proposalOnly))
  if (stage === 'E3') saveState({ ...loadState(), e3: { parent: parent.domain, shelves: p.shelves.map((s) => ({ size: s.size, fingerprint: s.fingerprint })), withParent: p.totals.withParent } })
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

    // System: the status item, and the panel it jumps to. The hosted demo switches the whole
    // screen off (SPEC.md §12.8), so there the check is that it stays off.
    await page.goto(`${UI}/system`)
    if (EXPECT_DEMO) {
      const off = await page.waitFor(`[...document.querySelectorAll('h1, h2, h3, strong, div')].some((x) => x.textContent?.trim() === 'System is switched off here')`, 20000)
      check(stage, 'System stays switched off in the demo, the panel with it', Boolean(off) && (await page.evaluate(`document.querySelectorAll('.split-shelf').length`)) === 0)
      await page.shot(`${tag}-system-off.png`)
    } else {
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
    // [B] One promote and back: the decision surface renders its summary, parent entry and
    // Fellow line - the one place that may ask a Fellow route, and only with the flag on.
    const first = p.shelves[0].id
    await clickIn(page, first, 'Promote')
    const surface = await page.waitFor(`document.querySelector('.split-decision') !== null`, 15000)
    check(stage, '[B] promoting a shelf opens the decision surface', Boolean(surface))
    await page.shot(`${tag}-system-promoted.png`)
    await clickIn(page, first, 'Promote')
    await page.waitFor(`document.querySelector('.split-decision') === null`, 15000)
    }

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
  if (EXPECT_DEMO) await demoWrites()
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

/* ------------------------------------------------------------------------ [B] helpers */

/** The card of one shelf, by its id in the proposal. */
const cardOf = (id) => `document.querySelector('.split-shelf[data-shelf="${id}"]')`

/** Clicks the button with this exact text inside a shelf's card. */
async function clickIn(page, id, text) {
  return page.evaluate(`(() => { const b = [...(${cardOf(id)})?.querySelectorAll('button') ?? []].find((x) => x.textContent.trim() === ${lit(text)}); if (!b) return false; b.click(); return true })()`)
}

/** Sets a React-controlled field the way typing does: the native setter, then an input event. */
async function setField(page, selector, value) {
  return page.evaluate(`(() => { const el = ${selector}; if (!el) return false; const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${lit(value)}); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return true })()`)
}

/** Clicks the first button whose text starts with `text`, anywhere in the split panel. */
async function clickPanel(page, text) {
  return page.evaluate(`(() => { const b = [...document.querySelectorAll('.split-proposal button')].find((x) => x.textContent.trim().startsWith(${lit(text)})); if (!b || b.disabled) return false; b.click(); return true })()`)
}

/** ONE page for E4 to E7: the decisions live in it, so the stages that act on them share it. */
let SHARED = null
async function uiPage() {
  if (!CDP) throw new Error('this stage drives the UI: pass --cdp')
  if (SHARED === null) SHARED = await cdpPage(CDP)
  return SHARED
}

/** System, the split status item, the panel with one card per shelf of the proposal. */
async function openPanel(page, shelves) {
  await page.goto(`${UI}/system`)
  const item = `[...document.querySelectorAll('.ms-item')].find((b) => b.querySelector('.ms-title')?.textContent.startsWith('One domain holds'))`
  await page.waitFor(`(${item}) !== undefined`, 30000)
  await page.evaluate(`(${item})?.click(); true`)
  return page.waitFor(`document.querySelectorAll('.split-shelf').length === ${shelves} ? ${shelves} : null`, 30000)
}

/** Every log line the instance publishes while `fn` runs, from its own SSE stream. */
async function withLog(fn) {
  const ac = new AbortController()
  const lines = []
  const reading = (async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/events`, { signal: ac.signal })
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          if (!line.startsWith('data:')) continue
          try {
            const ev = JSON.parse(line.slice(5))
            if (ev?.log?.message) lines.push({ channel: ev.log.jobId, message: ev.log.message })
          } catch {
            /* not a log event */
          }
        }
      }
    } catch {
      /* aborted */
    }
  })()
  try {
    return { result: await fn(), lines }
  } finally {
    ac.abort()
    await reading
  }
}

/** The parent and its proposal as the route answers now. */
async function parentProposal() {
  const graph = await api('/api/v1/graph')
  const parent = largestDomain(graph.body)
  const state = loadState()
  // After the split the parent is no longer the largest domain: E3's parent is THE parent.
  const domain = state.e3?.parent ?? parent.domain
  const r = await api(`/api/v1/domains/${encodeURIComponent(domain)}/split`)
  return { parent: { ...parent, domain }, p: r.body, graph: graph.body }
}

const lockScript = (...args) =>
  execFileSync('bash', [join(VAULT, 'scripts/wiki-lock.sh'), ...args], { cwd: VAULT, env: { ...process.env, WIKI_LOCK_VAULT: VAULT }, encoding: 'utf8' })

/** The open standing findings, counted by rule. */
async function openFindings() {
  const r = await api('/api/v1/validation')
  const out = {}
  for (const f of r.body?.findings ?? []) if (f.resolvedAt == null && f.acceptedAt == null) out[f.rule] = (out[f.rule] ?? 0) + 1
  return out
}

/** Lines of `wiki/index.md` under each `## ` heading that are page entries. */
function indexCounts() {
  const out = {}
  let current = null
  for (const line of readFileSync(join(VAULT, 'wiki/index.md'), 'utf8').split('\n')) {
    const h = /^## (.+?)\s*$/.exec(line)
    if (h) {
      current = h[1].trim()
      out[current] = 0
    } else if (current !== null && /^- /.test(line)) out[current]++
  }
  return out
}

/** The registry's sections as raw text, by key, and their order. */
function registrySections(text) {
  const body = text.slice(text.search(/^## Domains\s*$/m))
  const parts = body.split(/^(?=## )/m).slice(1)
  return parts.map((t) => ({ key: /^## (.+?)\s*$/m.exec(t)[1].trim().toLowerCase(), text: t }))
}

/* ------------------------------------------------------------------------------ [B] stages */

async function stageE4() {
  console.log('\nE4: the decision set, and the naming pass')
  assertIdentity()
  const { parent, p } = await parentProposal()
  const page = await uiPage()
  const cards = await openPanel(page, p.shelves.length)
  check('E4', 'the panel shows one card per shelf', cards === p.shelves.length, `${cards ?? 0} of ${p.shelves.length}`)
  const ids = p.shelves.map((s) => s.id) // rank order
  const [a, b, c, d, left, deferred] = ids
  await clickIn(page, a, 'Promote')
  await clickIn(page, b, 'Promote')
  await setField(page, `${cardOf(d)}?.querySelector('select.split-merge')`, String(c))
  await clickIn(page, left, 'Leave')
  await clickIn(page, deferred, 'Defer')
  const groups = await page.waitFor(`document.querySelectorAll('.split-child').length === 3 ? 3 : null`, 15000)
  check('E4', 'three new domains: two promoted, two merged into one', groups === 3)
  check('E4', 'the left shelf is no card any more, and listed as left', (await page.evaluate(`${cardOf(left)} === null && document.querySelector('.split-left') !== null`)) === true)
  check('E4', 'the deferred shelf carries the deferred mark', (await page.evaluate(`[...(${cardOf(deferred)})?.querySelectorAll('.chip') ?? []].some((x) => x.textContent === 'deferred')`)) === true)
  const stored = (await api(`/api/v1/domains/${encodeURIComponent(parent.domain)}/split`)).body.decisions ?? []
  const fp = (id) => p.shelves.find((s) => s.id === id).fingerprint
  check(
    'E4',
    'the leave and the defer are remembered on the server',
    stored.some((x) => x.fingerprint === fp(left) && x.decision === 'leave') && stored.some((x) => x.fingerprint === fp(deferred) && x.decision === 'defer'),
    `${stored.length} decisions`,
  )
  saveState({ ...loadState(), decision: { parent: parent.domain, promoted: [a, b], merged: [c, d], left, deferred, leftFp: fp(left), deferredFp: fp(deferred) } })
  await page.shot('e4-decisions.png')

  const keyField = (id) => `${cardOf(id)}?.querySelector('[data-field="key"]')`
  const leaders = [a, b, c]
  const registryBefore = (await api('/api/v1/domains')).body.domains.find((x) => x.key === parent.domain)
  if (NAMING) {
    const head = git(VAULT, 'rev-parse', 'HEAD')
    const { result: named, lines } = await withLog(async () => {
      const since = page.network.length
      if (!(await clickPanel(page, 'Draft names with an agent'))) return null
      const start = await page.awaitResponse((r) => r.method === 'POST' && r.url.endsWith('/split/naming'), since, 30000)
      const filled = await page.waitFor(
        `(${JSON.stringify(leaders)}).every((id) => (document.querySelector('.split-shelf[data-shelf="' + id + '"] [data-field="key"]')?.value ?? '') !== '') || document.querySelector('.split-decision .toast.err') !== null`,
        10 * 60000,
      )
      return { start, filled }
    })
    check('E4', 'the naming pass started', named?.start?.status === 202, `${named?.start?.status ?? 'no request'}`)
    const runId = named?.start?.body?.id
    let run = null
    for (let i = 0; i < 600 && runId; i++) {
      run = (await api(`/api/v1/maintenance/runs/${runId}`)).body
      if (run?.status !== 'running') break
      await new Promise((r) => setTimeout(r, 1000))
    }
    check('E4', 'the naming pass settled ok and answered every shelf', run?.status === 'done' && Object.keys(run?.result?.splitNaming?.shelves ?? {}).length === 3, `${run?.status}, ${Object.keys(run?.result?.splitNaming?.shelves ?? {}).length} named, $${run?.result?.usage?.costUsd?.toFixed(2)}`)
    const own = lines.filter((l) => l.channel === 'maintenance:split-naming').map((l) => l.message)
    check('E4', 'the run log shows the query profile', own.some((m) => m.includes('runs read-only under the query profile')), `${own.length} log lines`)
    check('E4', 'HEAD unmoved and the copy clean after the pass', git(VAULT, 'rev-parse', 'HEAD') === head && git(VAULT, 'status', '--short') === '')
    check('E4', 'the run committed nothing', run?.result?.commit === null)
  } else if (KEYS) {
    const keys = KEYS.split(',')
    for (let i = 0; i < 3; i++) await setField(page, keyField(leaders[i]), keys[i])
    note('the naming pass not run (--keys): keys typed by hand')
  }
  await new Promise((r) => setTimeout(r, 500))
  const keys = await page.evaluate(`(${JSON.stringify(leaders)}).map((id) => document.querySelector('.split-shelf[data-shelf="' + id + '"] [data-field="key"]')?.value ?? '')`)
  check('E4', 'every new domain has a key', keys.every((k) => /^[a-z0-9][a-z0-9-]*$/.test(k)), `${keys.filter(Boolean).length} of 3`)
  const collisions = await page.evaluate(`(${JSON.stringify(leaders)}).map((id) => document.querySelector('.split-shelf[data-shelf="' + id + '"] [data-collision]')?.dataset.collision ?? null)`)
  const totals = collisions.map((c) => (c === null ? null : c.split(',').map(Number).reduce((x, y) => x + y, 0)))
  check('E4', 'the collision counts are shown, and no key is a tag of more than a handful of pages', totals.every((t) => t !== null && t <= 5), `pages carrying each key: ${totals.join(', ')}`)
  const parentText = await page.evaluate(`document.querySelector('[data-field="parent-description"]')?.value ?? ''`)
  check('E4', "the parent's description differs from the old one", parentText !== '' && parentText !== registryBefore?.description)
  const problems = await page.evaluate(`document.querySelectorAll('.split-decision .field-err, .split-child .field-err').length`)
  check('E4', 'no field shows a problem', problems === 0, `${problems}`)
  saveState({ ...loadState(), keys })
  await page.shot('e4-named.png')
}

async function stageE5() {
  console.log('\nE5: the plan')
  assertIdentity()
  const state = loadState()
  const page = await uiPage()
  const head = git(VAULT, 'rev-parse', 'HEAD')
  const registryText = readFileSync(join(VAULT, 'wiki/meta/domains.md'), 'utf8')
  const since = page.network.length
  check('E5', 'Preview is enabled and clicked', await clickPanel(page, 'Preview'))
  const res = await page.awaitResponse((r) => r.method === 'POST' && r.url.endsWith('/split/plan'), since, 60000)
  check('E5', 'the plan answers 200', res?.status === 200, `${res?.status}`)
  const plan = res?.body
  const req = JSON.parse(res?.request?.postData ?? '{}')
  const { p } = await parentProposal()
  const size = (id) => p.shelves.find((s) => s.id === id).size
  const expectedPages = state.decision.promoted.map(size).reduce((x, y) => x + y, 0) + state.decision.merged.map(size).reduce((x, y) => x + y, 0)
  check('E5', 'the request carries three children and every page of their shelves', req.children?.length === 3 && req.children.reduce((n, c) => n + c.pages.length, 0) === expectedPages, `${expectedPages} pages`)
  check('E5', 'every page line pair is domain: from the parent to its child', plan?.pages?.filter((x) => x.verdict === 'ok').every((x) => x.from === `domain: ${plan.parent}` && x.to === `domain: ${x.child}`) === true, `${plan?.counts?.ok} ok`)
  // The registry diff: every removed line is a line of the parent's old section, and the new
  // sections appear in order.
  const oldParent = registrySections(registryText).find((x) => x.key === plan?.parent)?.text.split('\n') ?? []
  const removed = (plan?.registry?.diff ?? '').split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2))
  check('E5', "the registry diff removes only lines of the parent's section", removed.every((l) => oldParent.includes(l)), `${removed.length} removed`)
  const addedKeys = (plan?.registry?.diff ?? '').split('\n').filter((l) => /^\+ ## /.test(l)).map((l) => l.slice(5).trim())
  check('E5', 'it adds exactly the new sections, in order', JSON.stringify(addedKeys) === JSON.stringify(req.children?.map((c) => c.key)), `${addedKeys.length} sections`)
  const misfileIds = p.shelves.filter((s) => s.misfile).map((s) => s.id)
  const expectMisfile = [...state.decision.promoted, ...state.decision.merged].some((id) => misfileIds.includes(id))
  const kinds = (plan?.warnings ?? []).map((w) => w.kind)
  check('E5', 'the warnings are the expected ones', kinds.includes('misfile') === expectMisfile && !kinds.includes('parent-small'), kinds.join(', ') || 'none')
  check('E5', 'nothing written: HEAD unmoved, the copy clean', git(VAULT, 'rev-parse', 'HEAD') === head && git(VAULT, 'status', '--short') === '')
  saveState({ ...state, plan: { ok: plan?.counts?.ok, children: req.children?.map((c) => c.key) } })
  await page.shot('e5-plan.png')
}

async function stageE6() {
  console.log('\nE6: the apply, with its edge cases')
  assertIdentity()
  const state = loadState()
  const page = await uiPage()
  const { p, graph } = await parentProposal()
  const pagesOf = (id) => p.shelves.find((s) => s.id === id).pages.filter((m) => m.address !== null).map((m) => m.path).sort()
  // Prepared just before the apply: one page of a promoted shelf locked, another moved by hand.
  const busy = pagesOf(state.decision.promoted[0])[0]
  const moved = pagesOf(state.decision.promoted[1])[0]
  const elsewhere = [...new Set(graph.nodes.map((n) => n.domain))].filter((d) => d && d !== state.decision.parent && d !== 'meta' && d !== 'unassigned').sort()[0]
  const movedAbs = join(VAULT, moved)
  writeFileSync(movedAbs, readFileSync(movedAbs, 'utf8').replace(/^domain:.*$/m, `domain: ${elsewhere}`))
  const handBase = git(VAULT, 'rev-parse', 'HEAD')
  git(VAULT, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-q', '-m', 'e2e: one page moved to another domain by hand', '--', moved)
  const preApply = git(VAULT, 'rev-parse', 'HEAD')
  lockScript('acquire', busy)
  const findingsBefore = await openFindings()
  const registryBefore = readFileSync(join(VAULT, 'wiki/meta/domains.md'), 'utf8')
  saveState({ ...state, handBase, preApply, busy, moved })

  const since = page.network.length
  const t0 = Date.now()
  const armed = await clickPanel(page, 'Apply')
  const confirmed = armed && (await page.waitFor(`[...document.querySelectorAll('.split-proposal button')].some((x) => x.textContent.startsWith('Confirm: write'))`, 5000)) && (await clickPanel(page, 'Confirm: write'))
  check('E6', 'Apply asks a second time, then writes', Boolean(confirmed))
  const res = await page.awaitResponse((r) => r.method === 'POST' && r.url.endsWith('/split/apply'), since, 10 * 60000)
  const ms = Date.now() - t0
  const out = res?.body
  check('E6', 'the apply answers 200', res?.status === 200, `${res?.status}, ${(ms / 1000).toFixed(1)} s in the browser, ${((out?.durationMs ?? 0) / 1000).toFixed(1)} s on the server`)
  const commits = git(VAULT, 'rev-list', `${preApply}..HEAD`).split('\n').filter(Boolean)
  check('E6', 'exactly ONE new commit', commits.length === 1 && commits[0] === out?.commit, `${commits.length}`)
  const files = git(VAULT, 'show', '--name-only', '--pretty=format:', out?.commit ?? 'HEAD').split('\n').filter(Boolean).sort()
  const expected = ['wiki/index.md', 'wiki/meta/domains.md', ...(out?.written ?? []).map((w) => w.path)].sort()
  check('E6', 'the commit holds the registry, the index and the written pages, and nothing else', JSON.stringify(files) === JSON.stringify(expected), `${files.length} files`)
  const diff = git(VAULT, 'show', '--pretty=format:', '--unified=0', out?.commit ?? 'HEAD', '--', ...(out?.written ?? []).map((w) => w.path))
  const changed = diff.split('\n').filter((l) => /^[-+](?![-+])/.test(l))
  const other = changed.filter((l) => !/^[-+](domain|updated):/.test(l))
  check('E6', 'per page only the domain: and updated: lines change', other.length === 0 && changed.filter((l) => l.startsWith('+domain:')).length === out?.written?.length, `${changed.length} changed lines over ${out?.written?.length} pages`)
  check('E6', 'content_updated: is never touched', !/^[-+]content_updated/m.test(git(VAULT, 'show', out?.commit ?? 'HEAD')))
  const reason = (path) => out?.skipped?.find((x) => x.path === path)?.reason
  check('E6', 'the busy page is skipped as busy, the hand-moved one as moved', reason(busy) === 'busy' && reason(moved) === 'moved', `${out?.skipped?.length} skipped`)
  check('E6', 'every written page read back with its child key', out?.verified === true && (out?.unverified ?? []).length === 0)
  const domains = (await api('/api/v1/domains')).body.domains.map((x) => x.key)
  const at = domains.indexOf(state.decision.parent)
  check('E6', 'the registry lists the children directly after the parent', JSON.stringify(domains.slice(at + 1, at + 4)) === JSON.stringify(state.plan.children))
  const before = registrySections(registryBefore)
  const after = registrySections(readFileSync(join(VAULT, 'wiki/meta/domains.md'), 'utf8'))
  const untouched = before.filter((x) => x.key !== state.decision.parent).every((x) => after.find((y) => y.key === x.key)?.text === x.text)
  check('E6', 'every other section of the registry is byte-identical', untouched && after.length === before.length + 3)
  const perChild = {}
  for (const w of out?.written ?? []) perChild[w.child] = (perChild[w.child] ?? 0) + 1
  const idx = indexCounts()
  check('E6', 'the index shows each child with its count', state.plan.children.every((k) => idx[k] === perChild[k]), state.plan.children.map((k) => `${idx[k]}/${perChild[k]}`).join(', '))
  const findingsAfter = await openFindings()
  check('E6', 'no new tag-mirroring finding', (findingsAfter['tag-mirroring'] ?? 0) <= (findingsBefore['tag-mirroring'] ?? 0), `${findingsBefore['tag-mirroring'] ?? 0} -> ${findingsAfter['tag-mirroring'] ?? 0}`)
  const deltas = Object.keys({ ...findingsBefore, ...findingsAfter }).filter((r) => (findingsBefore[r] ?? 0) !== (findingsAfter[r] ?? 0))
  note(`standing list, rules that changed: ${deltas.map((r) => `${r} ${findingsBefore[r] ?? 0}->${findingsAfter[r] ?? 0}`).join(', ') || 'none'}`)
  let fsck = true
  try {
    execFileSync('git', ['-C', VAULT, 'fsck', '--no-progress'], { stdio: 'ignore' })
  } catch {
    fsck = false
  }
  check('E6', 'git fsck exits 0', fsck)
  const g2 = (await api('/api/v1/graph')).body
  const inGraph = state.plan.children.map((k) => g2.nodes.filter((n) => n.domain === k).length)
  check('E6', 'the Graph shows the new domains', inGraph.every((n, i) => n === perChild[state.plan.children[i]]), inGraph.join(', '))
  const scene = await api('/api/v1/library/scene')
  if (scene.status === 404) note('the Library room: not wired (flag off)')
  else {
    const shelves = [scene.body?.main, ...(scene.body?.wings ?? [])].flatMap((r) => r?.shelves ?? [])
    check('E6', 'the Library room places the new shelves without an error', scene.status === 200 && state.plan.children.every((k) => shelves.some((x) => x.domain === k && x.books > 0)), `${scene.status}`)
  }
  // The Catalog with a new domain selected.
  await page.goto(`${UI}/catalog?domain=${encodeURIComponent(state.plan.children[0])}`)
  const rows = await page.waitFor(`(() => { const n = document.querySelectorAll('table.lib-table tbody tr').length; return n === ${perChild[state.plan.children[0]]} ? n : null })()`, 30000)
  check('E6', 'the Catalog lists the first new domain with its pages', rows === perChild[state.plan.children[0]], `${rows ?? 0} rows`)
  await page.shot('e6-catalog-child.png')
  // The proposal for the parent afterwards.
  const after2 = (await api(`/api/v1/domains/${encodeURIComponent(state.decision.parent)}/split`)).body
  const writtenAddr = new Set((out?.written ?? []).map((w) => w.address))
  check('E6', 'the promoted shelves are gone from the proposal', after2.shelves.every((s) => s.pages.filter((m) => writtenAddr.has(m.address)).length === 0), `${after2.shelves.length} shelves, ${after2.pages} pages`)
  const leftShelf = after2.shelves.find((s) => s.fingerprint === state.decision.leftFp)
  const deferredShelf = after2.shelves.find((s) => s.fingerprint === state.decision.deferredFp)
  const leftStored = after2.decisions.some((x) => x.fingerprint === state.decision.leftFp && x.decision === 'leave')
  check('E6', 'the left shelf is not proposed (its fingerprint holds and is remembered)', Boolean(leftShelf) && leftStored, leftShelf ? 'fingerprint holds' : 'fingerprint changed')
  check('E6', 'the deferred shelf is proposed again', Boolean(deferredShelf), deferredShelf ? 'fingerprint holds' : 'fingerprint changed')
  await openPanel(page, after2.shelves.length - (leftShelf ? 1 : 0))
  const shownCards = await page.evaluate(`[...document.querySelectorAll('.split-shelf')].map((x) => Number(x.dataset.shelf))`)
  check('E6', 'the panel shows no card for the left shelf', leftShelf ? !shownCards.includes(leftShelf.id) : false, `${shownCards.length} cards`)
  await page.shot('e6-after.png')
  saveState({ ...loadState(), splitId: out?.splitId, splitCommit: out?.commit, written: out?.written?.length })
}

async function stageE7() {
  console.log('\nE7: the remainder')
  assertIdentity()
  const state = loadState()
  lockScript('release', state.busy)
  const split = (await api('/api/v1/domains/splits')).body.splits.find((x) => x.id === state.splitId)
  check('E7', 'the applied split shows a remainder of 1', split?.remainder === 1, `${split?.remainder}`)
  const page = await uiPage()
  const { p } = await parentProposal()
  const left = p.shelves.some((s) => s.fingerprint === state.decision.leftFp) ? 1 : 0
  await openPanel(page, p.shelves.length - left)
  const row = `document.querySelector('.split-row[data-split="${state.splitId}"]')`
  const btn = (text) => `[...(${row})?.querySelectorAll('button') ?? []].find((x) => x.textContent.startsWith(${lit(text)}))`
  const head = git(VAULT, 'rev-parse', 'HEAD')
  const since = page.network.length
  await page.evaluate(`(${btn('Re-file the remainder')})?.click(); true`)
  await page.waitFor(`(${btn('Confirm: re-file')}) !== undefined`, 5000)
  await page.evaluate(`(${btn('Confirm: re-file')})?.click(); true`)
  const res = await page.awaitResponse((r) => r.method === 'POST' && r.url.endsWith('/remainder'), since, 5 * 60000)
  check('E7', 'the re-file answers 200', res?.status === 200, `${res?.status}`)
  const commits = git(VAULT, 'rev-list', `${head}..HEAD`).split('\n').filter(Boolean)
  const files = commits.length === 1 ? git(VAULT, 'show', '--name-only', '--pretty=format:', commits[0]).split('\n').filter(Boolean).sort() : []
  check('E7', 'one commit with exactly that page and the index', commits.length === 1 && JSON.stringify(files) === JSON.stringify([state.busy, 'wiki/index.md'].sort()), `${commits.length} commit(s), ${files.length} files`)
  const after = (await api('/api/v1/domains/splits')).body.splits.find((x) => x.id === state.splitId)
  check('E7', 'the remainder is 0, and the split holds both commits', after?.remainder === 0 && after?.commits.length === 2)
  check('E7', 'the hand-moved page is not remainder', !JSON.stringify(res?.body?.written ?? []).includes(state.moved))
  await page.shot('e7-remainder.png')
}

async function stageE8() {
  console.log('\nE8: a real ingest after the split')
  assertIdentity()
  const state = loadState()
  if (!DOC && !URL_DOC) {
    console.error('E8 needs --doc <file> or --url <url>')
    process.exit(2)
  }
  const head = git(VAULT, 'rev-parse', 'HEAD')
  let res
  if (DOC) {
    const form = new FormData()
    form.append('file', new Blob([readFileSync(DOC)]), DOC.split('/').pop())
    res = await fetch(`http://127.0.0.1:${PORT}/api/v1/jobs`, { method: 'POST', body: form })
  } else {
    res = await fetch(`http://127.0.0.1:${PORT}/api/v1/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: URL_DOC }) })
  }
  const body = await res.json()
  const jobId = body.jobs?.[0]?.id
  check('E8', 'the upload is accepted and not a duplicate', res.status < 300 && jobId && !body.jobs[0].duplicateOf, `${res.status} ${body.jobs?.[0]?.status}`)
  let job = null
  let refusal = null
  const until = Date.now() + 45 * 60000
  while (Date.now() < until) {
    job = (await api(`/api/v1/jobs/${jobId}`)).body.job
    if (refusal === null && job?.status === 'ingesting') {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/v1/domains/splits/${state.splitId}/remainder`, { method: 'POST' })
      refusal = { status: r.status, body: await r.json() }
    }
    if (['done', 'failed', 'duplicate', 'cancelled', 'deferred'].includes(job?.status)) break
    await new Promise((r) => setTimeout(r, 5000))
  }
  check('E8', 'while it runs, the remainder re-file answers 409 "a run is writing the vault"', refusal?.status === 409 && refusal?.body?.code === 'run-active', `${refusal?.status} ${refusal?.body?.code}`)
  check('E8', 'the job ends done', job?.status === 'done', `${job?.status}, $${job?.cost_usd ?? '?'}`)
  const hash = job?.commit_hash
  const status = hash ? git(VAULT, 'show', '--name-status', '--pretty=format:', hash).split('\n').filter(Boolean).map((l) => l.split('\t')) : []
  const created = status.filter(([st, f]) => st === 'A' && /^wiki\/(concepts|entities|sources|comparisons|questions|references)\//.test(f)).map(([, f]) => f)
  const byKey = {}
  for (const f of created) {
    const d = /^domain:\s*["']?([^"'\n]+)/m.exec(readFileSync(join(VAULT, f), 'utf8'))?.[1]?.trim() ?? '(none)'
    const cls = state.plan.children.includes(d) ? `child ${d}` : d === state.decision.parent ? 'PARENT' : 'other'
    byKey[cls] = (byKey[cls] ?? 0) + 1
  }
  note(`created pages by domain: ${JSON.stringify(byKey)}`)
  const onChild = created.length - (byKey.PARENT ?? 0) - (byKey.other ?? 0)
  check('E8', 'every page it created carries a CHILD key (the narrowed parent works)', created.length > 0 && onChild === created.length, `${onChild} of ${created.length}`)
  const commits = git(VAULT, 'rev-list', `${head}..HEAD`).split('\n').filter(Boolean)
  note(`the copy's HEAD moved by ${commits.length} commit(s)`)
  saveState({ ...state, jobId, jobCommit: hash, created })
}

async function stageE9() {
  console.log('\nE9: revert')
  assertIdentity()
  const state = loadState()
  const post = async (path) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method: 'POST' })
    return { status: r.status, body: await r.json() }
  }
  const createdOnChild = (state.created ?? []).filter((f) => {
    const d = /^domain:\s*["']?([^"'\n]+)/m.exec(readFileSync(join(VAULT, f), 'utf8'))?.[1]?.trim()
    return state.plan.children.includes(d)
  })
  const refused = await post(`/api/v1/domains/splits/${state.splitId}/revert`)
  const named = (refused.body?.pages ?? []).slice().sort()
  check('E9', 'the revert is refused while pages outside the split carry its keys', refused.status === 409 && refused.body?.code === 'orphans', `${refused.status} ${refused.body?.code}`)
  check('E9', 'the refusal names exactly the pages the ingest filed into a child', JSON.stringify(named) === JSON.stringify(createdOnChild.slice().sort()), `${named.length} named, ${createdOnChild.length} expected`)
  if (state.jobId) {
    const jr = await post(`/api/v1/jobs/${state.jobId}/revert`)
    check('E9', 'the E8 job reverts', jr.status === 200, `${jr.status} ${jr.body?.error ?? ''}`)
  }
  const head = git(VAULT, 'rev-parse', 'HEAD')
  const done = await post(`/api/v1/domains/splits/${state.splitId}/revert`)
  check('E9', "the split reverts: its commits newest first, then the index", done.status === 200 && done.body?.commits?.length === 2, `${done.status} ${done.body?.commits?.length ?? done.body?.error}`)
  const subjects = git(VAULT, 'log', '--format=%s', `${head}..HEAD`).split('\n').filter(Boolean).reverse()
  const order = subjects.filter((x) => x.startsWith('domains: revert')).map((x) => /revert ([0-9a-f]{8})/.exec(x)?.[1])
  const own = (await api('/api/v1/domains/splits')).body.splits.find((x) => x.id === state.splitId)
  check('E9', 'newest first', JSON.stringify(order) === JSON.stringify(own?.commits.slice().reverse().map((c) => c.slice(0, 8))))
  check('E9', 'the split record is marked reverted', own?.revertedAt != null)
  // The hand move was made by hand in E6, so it is undone by hand here: the proposal is E3's
  // only once that page is back in the parent too.
  git(VAULT, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'revert', '--no-edit', git(VAULT, 'log', '--format=%H', '-1', '--grep', '^e2e: one page moved'))
  // What `revertCommit` leaves alone on purpose: the hubs (derived or append-only) and the
  // monotonic address counter. Everything else is back where it was before the hand move.
  const excluded = [':!wiki/index.md', ':!wiki/log.md', ':!wiki/overview.md', ':!wiki/hot.md', ':!**/_index.md', ':!.vault-meta/address-counter.txt']
  const rest = git(VAULT, 'diff', '--stat', state.handBase, 'HEAD', '--', '.', ...excluded)
  check('E9', 'git diff against the tree before E6 prints nothing, hubs and the address counter aside', rest === '', rest === '' ? 'empty' : `${rest.split('\n').length} lines`)
  const hubs = git(VAULT, 'diff', '--name-only', state.handBase, 'HEAD', '--', 'wiki/index.md', 'wiki/log.md', 'wiki/overview.md', 'wiki/hot.md', '.vault-meta/address-counter.txt')
  note(`left alone by design and changed since: ${hubs.split('\n').filter(Boolean).length} file(s)`)
  check('E9', 'the copy is clean', git(VAULT, 'status', '--short') === '')
  const now = (await api(`/api/v1/domains/${encodeURIComponent(state.e3.parent)}/split`)).body
  const same = JSON.stringify(now.shelves.map((s) => ({ size: s.size, fingerprint: s.fingerprint }))) === JSON.stringify(state.e3.shelves)
  check('E9', "the proposal for the parent is E3's again", same && now.totals.withParent === state.e3.withParent, `${now.shelves.map((s) => s.size).join(', ')}; ${now.totals.withParent} with the parent`)
}

/** [B] of E10: every split write refused in the demo, 403 demo_read_only. */
async function demoWrites() {
  const key = encodeURIComponent(largestDomain((await api('/api/v1/graph')).body).domain)
  const routes = [
    ['POST', `/api/v1/domains/${key}/split/plan`],
    ['POST', `/api/v1/domains/${key}/split/apply`],
    ['POST', `/api/v1/domains/${key}/split/naming`],
    ['POST', `/api/v1/domains/${key}/split/decisions`],
    ['DELETE', `/api/v1/domains/${key}/split/decisions/x`],
    ['POST', '/api/v1/domains/splits/x/remainder'],
    ['POST', '/api/v1/domains/splits/x/revert'],
  ]
  let refused = 0
  for (const [method, path] of routes) {
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { 'content-type': 'application/json' }, body: '{}' })
    const b = await r.json().catch(() => ({}))
    if (r.status === 403 && b.error === 'demo_read_only') refused++
  }
  check('E10', '[B] every split write answers 403 demo_read_only', refused === routes.length, `${refused} of ${routes.length}`)
}

/* ----------------------------------------------------------------------------------- main */

const RUN = { E0: stageE0, E1: stageE1, E2: stageE2, E3: stageE3, E4: stageE4, E5: stageE5, E6: stageE6, E7: stageE7, E8: stageE8, E9: stageE9, E10: stageE10, E11: stageE11, E12: stageE12 }
for (const stage of STAGES) {
  if (!RUN[stage]) {
    console.error(`unknown stage ${stage} (known: ${Object.keys(RUN).join(', ')})`)
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

if (SHARED !== null) await SHARED.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} PASS, ${failed.length} FAIL`)
for (const f of failed) console.log(`  FAIL  ${f.stage}  ${f.name}`)
process.exitCode = failed.length > 0 ? 1 : 0
