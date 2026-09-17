const { chromium } = require('./playwright.cjs')();
const fs = require('fs'), path = require('path');
const FRAMES = process.argv[2], OUT = process.argv[3];
const HOLD = Number(process.argv[4] || 5);      // stills per snapshot
const SIZE = 1080;

(async () => {
  const files = fs.readdirSync(FRAMES).filter((f) => /^\d+\.json$/.test(f)).sort();
  const graphs = files.map((f) => fs.readFileSync(path.join(FRAMES, f), 'utf8'));
  console.log(`${graphs.length} snapshots, ${HOLD} stills each = ${graphs.length * HOLD} frames`);
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ args: ['--force-device-scale-factor=1'] });
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, colorScheme: 'dark' });
  let idx = 0;

  // The graph comes from the snapshots.
  await page.route('**/api/v1/graph', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: graphs[idx] }));
  /*
   * What triggers a reload: the app invalidates ['graph'] on a `vault` event of the SSE
   * stream. Playwright cannot serve an open stream, so every connection delivers exactly one
   * event and closes; `retry:` sets the reconnect to 120 ms. Each reconnect is therefore one
   * frame - through the app's own path rather than around it.
   */
  await page.route('**/api/v1/events', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'retry: 120\n\nevent: vault\ndata: {}\n\n' }));

  // Prepare the view: domain lens (colour carries the picture once the labels are off), no
  // hulls, no system pages.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('vault.graphPrefs', JSON.stringify({ v: 1, lens: 'domain', showClusters: false, showGaps: false, showNetwork: false, spotlight: false, showSystem: false, selectedTypes: [], selectedDomains: [] }));
    } catch { /* without localStorage the view runs on its defaults */ }
  });

  await page.goto('http://localhost:8421/graph?labels=off', { waitUntil: 'domcontentloaded' });   // not networkidle: the SSE stream reconnects every 120 ms
  await page.locator('canvas.graph-canvas').waitFor({ timeout: 40000 });
  await page.waitForTimeout(3000);

  // The drawing area alone: the app's full-screen mode hides the control panel, minimap and
  // status chip go by CSS - what is left is the picture.
  await page.getByTitle(/Show the graph on its own/).click();
  await page.addStyleTag({ content: '.graph-minimap,.graph-status,.graph-controls{display:none!important}' });
  await page.waitForTimeout(1500);

  /*
   * A fixed camera. The last snapshot is loaded and fitted first, then the film is rewound:
   * the camera stays, and the position map (by page path) already knows every node. A node
   * therefore appears in the place it will keep, instead of the whole layout twitching on
   * every addition - which is the difference between a growth animation and a seizure.
   */
  idx = graphs.length - 1;
  await page.waitForTimeout(2500);
  await page.keyboard.press('f');
  await page.waitForTimeout(4000);

  const canvas = page.locator('canvas.graph-canvas').first();
  let box = await canvas.boundingBox();
  console.log('drawing area:', JSON.stringify(box && { w: Math.round(box.width), h: Math.round(box.height) }));

  let shot = 0;
  for (idx = 0; idx < graphs.length; idx++) {
    for (let k = 0; k < HOLD; k++) {
      await page.screenshot({ path: path.join(OUT, `f${String(shot).padStart(5, '0')}.png`), clip: box });
      shot++;
    }
    if (idx % 20 === 0) console.log(`  snapshot ${idx + 1}/${graphs.length}, ${shot} frames`);
  }
  console.log(`${shot} frames written`);
  await browser.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
