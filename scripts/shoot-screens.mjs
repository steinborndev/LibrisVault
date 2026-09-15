/**
 * Screenshot the dashboard screens for the README, at retina scale, from a running service.
 *
 * Pair it with `demo-vault.mjs` so the pictures show a synthetic vault instead of real
 * notes (the README's first set leaked page titles into a public repo). Full recipe:
 *
 *   node scripts/demo-vault.mjs
 *   cd server && VAULT_ROOT=~/.local/share/vault-service/demo-vault \
 *     DB_PATH=~/.local/share/vault-service/demo-jobs.db PORT=8421 \
 *     TELEGRAM_BOT_TOKEN= CLAUDE_CODE_OAUTH_TOKEN=demo node dist/main.js &
 *   ~/.cache/ms-playwright/chromium-*\/chrome-linux64/chrome --headless --disable-gpu \
 *     --no-sandbox --remote-debugging-port=9333 --user-data-dir=/tmp/shoot-profile about:blank &
 *   node --experimental-websocket scripts/shoot-screens.mjs
 *
 * `TELEGRAM_BOT_TOKEN=` is not optional: without it the demo process picks the real token
 * out of the service env file and starts a second poller, which knocks the real bot off
 * its own token (Telegram allows exactly one consumer).
 *
 * Waiting is done on the DOM, never on the network: the dashboard holds an SSE connection
 * open forever, so `networkidle` never fires and `--virtual-time-budget` never expires.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8421'
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9333'
const OUT = process.env.OUT_DIR ?? 'docs/img'
/** 2x of a 1440x900 window - the size the README renders at, on a retina display. */
const WIDTH = Number(process.env.SHOT_WIDTH ?? 1440)
const HEIGHT = Number(process.env.SHOT_HEIGHT ?? 900)
const SCALE = Number(process.env.SHOT_SCALE ?? 2)

/**
 * `settle` is what the screen has to reach before the shutter fires, evaluated in the page.
 * The graph is the reason this exists: its force layout animates in, and a shot taken too
 * early catches the nodes still flying apart.
 */
const SHOTS = [
  {
    file: 'home.png',
    route: '/',
    settle: `document.querySelectorAll('.fact').length > 2 && document.querySelectorAll('table.dtable tbody tr').length > 3`,
    hold: 5000,
  },
  {
    file: 'graph.png',
    route: '/graph',
    // Any canvas, not the first: the screen also mounts a zero-sized offscreen one, and
    // querySelector picks that up and never settles.
    settle: `[...document.querySelectorAll('canvas')].some((c) => c.getBoundingClientRect().height > 300)`,
    // A vault-sized graph (800+ nodes, 4k edges) takes far longer to settle than a toy one.
    hold: 24000,
  },
  {
    file: 'research.png',
    route: '/research',
    settle: `document.querySelectorAll('table.dtable tbody tr').length > 1`,
    hold: 2000,
  },
  {
    // The tabular view: called Library until 2026-09-06, Catalog since, when the name went to
    // the room screen below. The old file name is kept so the README's link does not break.
    file: 'library.png',
    route: '/catalog',
    settle: `document.querySelectorAll('table.dtable tbody tr').length > 8`,
    hold: 2000,
  },
  {
    file: 'system.png',
    route: '/system?section=vault',
    settle: `document.querySelectorAll('.subcard, .fact, .setting').length > 2`,
    hold: 2500,
  },

  /* ---------------------------------------- the surfaces the research agents add ---- */

  {
    // The room itself. Figures animate in and the isometric canvas draws in passes, so it
    // needs a hold closer to the graph's than to a table's.
    file: 'library-room.png',
    route: '/library',
    settle: `[...document.querySelectorAll('canvas, svg')].some((c) => c.getBoundingClientRect().height > 300)`,
    hold: 9000,
  },
  {
    /*
     * A wing: the room one floor out, where the shelves of a dozen domains stand and each
     * carries its own page count. Reached by CLICKING rather than by a room id, because the
     * ids are generated fresh with the vault and a shot pinned to one would break on the next
     * rebuild - which is the same reason the Fellow dossier below uses a stable seeded id.
     */
    file: 'library-wing.png',
    route: '/library',
    settle: `[...document.querySelectorAll('canvas, svg')].some((c) => c.getBoundingClientRect().height > 300)`,
    hold: 7000,
    act: `(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim().startsWith('Wing A'))
      if (!b) return false
      b.click()
      return true
    })()`,
    actHold: 7000,
  },
  {
    // The command centre, opened on the night rather than on a list - which is the decision
    // the whole window rests on, so it is what a screenshot should show.
    file: 'command-centre.png',
    route: '/library?cc=1',
    settle: `document.body.innerText.includes('Tonight') || document.querySelectorAll('.cc-card, .cc-tasks').length > 0`,
    hold: 4000,
  },
  {
    // One Fellow's dossier: its notebook, its ledger, its settings, its decisions.
    file: 'fellow-dossier.png',
    route: '/library?cc=1&agent=01DEMO00000000000000000401',
    settle: `document.querySelectorAll('.cc-card, .cc-tasks, .cc-settings').length > 0`,
    hold: 4000,
  },
  {
    // The morning recap on the wall board, which is where a night is read.
    file: 'recap.png',
    route: '/library?board=recap',
    settle: `document.body.innerText.includes('run') && document.querySelectorAll('.recap-row, .rcp, article').length > 0`,
    hold: 3500,
  },
  {
    // The reading list: publications a run could not read, with the open copies the sweep found.
    file: 'reading-list.png',
    route: '/library?board=reading',
    settle: `document.querySelectorAll('.rl-entry, .rl-row, li, tr').length > 3`,
    hold: 3000,
  },
  {
    /*
     * Home's night view: the same recap the Library's wall board shows, in the place the
     * morning actually starts. Reached by the toggle in the flow tab strip, which is why this
     * one clicks.
     */
    file: 'home-night.png',
    route: '/',
    settle: `document.querySelectorAll('[role="tab"], .seg button').length > 1`,
    hold: 2500,
    /*
     * `[role="tab"]` only. Home has a second "Night shift" button, in the intake box, which
     * holds a dropped file for the shift - a broader selector finds that one first and the
     * shot comes back showing the activity view it was meant to leave.
     */
    act: `(() => {
      const b = [...document.querySelectorAll('[role="tab"]')]
        .find((x) => /night shift/i.test(x.textContent || ''))
      if (!b) return false
      b.click()
      return true
    })()`,
    actHold: 4000,
  },
  {
    /*
     * A research result as it is actually read: the synthesis page one of the real runs
     * filed. This is the shot the ledger screenshots cannot stand in for - a list of runs
     * says the function exists, a page says what it produces.
     */
    file: 'research-result.png',
    route: '/catalog/page/wiki%2Fquestions%2FResearch%3A%20ADC%20Patent%20and%20IP%20Filings%20Since%202025%20for%20New%20Payload%2C%20Linker%20and%20Bispecific-Dual-Payload%20Platforms%20%E2%80%94%20Patent%20Landscape.md',
    settle: `document.body.innerText.includes('Findings')`,
    hold: 2500,
  },
]

const targets = await (await fetch(`${CDP}/json/list`)).json()
const target = targets.find((t) => t.type === 'page')
if (!target) {
  console.error('No page target on the CDP port - is Chromium running with --remote-debugging-port?')
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
const send = (method, params = {}) =>
  new Promise((res) => {
    const n = ++id
    pending.set(n, res)
    ws.send(JSON.stringify({ id: n, method, params }))
  })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value

await send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: SCALE,
  mobile: false,
})

for (const shot of SHOTS) {
  await send('Page.navigate', { url: BASE + shot.route })
  let ready = false
  for (let i = 0; i < 40 && !ready; i++) {
    await sleep(500)
    ready = (await evaluate(shot.settle)) === true
  }
  /*
   * Some surfaces have no address: Home's night view is a toggle in a tab strip and the screen
   * keeps it in component state. `act` is evaluated in the page after it settles - a click
   * expression that returns true when it found its target - and the shot waits again.
   */
  if (shot.act) {
    const acted = await evaluate(shot.act)
    if (acted !== true) console.error(`${shot.file}: the click did not find its target`)
    await sleep(shot.actHold ?? 2500)
  }
  if (!ready) {
    console.error(`${shot.file}: never settled - shooting anyway`)
  }
  // Let animations (graph layout, chart reveal, count-ups) finish before the shutter.
  await sleep(shot.hold)
  const { result } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  if (!result?.data) {
    console.error(`${shot.file}: no image data`)
    continue
  }
  const buf = Buffer.from(result.data, 'base64')
  writeFileSync(join(OUT, shot.file), buf)
  console.log(`${shot.file.padEnd(14)} ${String(Math.round(buf.length / 1024)).padStart(5)} KB  ${shot.route}`)
}

ws.close()
console.log(`\nWrote ${SHOTS.length} screenshots to ${OUT}/ at ${WIDTH}x${HEIGHT}@${SCALE}x.`)
