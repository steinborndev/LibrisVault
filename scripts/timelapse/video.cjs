const { chromium } = require('./playwright.cjs')();
const fs = require('fs'), path = require('path');
const FRAMES = process.argv[2], OUT = process.argv[3];
const SECONDS = Number(process.argv[4] || 20);
const SIZE = 1080;

/*
 * The film. Playwright records the page itself, so the page has to BE the picture: top bar,
 * control panel, minimap and status chip go, the padding to zero, and the drawing area fills
 * exactly 1080x1080. No cropping and no ffmpeg needed.
 */
const CHROME_OFF = `
  .topbar { display: none !important; }
  .screens { position: absolute !important; inset: 0 !important; }
  .workspace { padding: 0 !important; gap: 0 !important; }
  .graph-canvas-wrap, .graph-stage, .graph-main { border: none !important; border-radius: 0 !important; padding: 0 !important; margin: 0 !important; }
  .graph-controls, .graph-minimap, .graph-status, .gpanel { display: none !important; }
`;

(async () => {
  const files = fs.readdirSync(FRAMES).filter((f) => /^\d+\.json$/.test(f)).sort();
  const graphs = files.map((f) => fs.readFileSync(path.join(FRAMES, f), 'utf8'));
  const stepMs = Math.round((SECONDS * 1000) / graphs.length);
  console.log(`${graphs.length} snapshots, ${stepMs} ms each = ${Math.round((graphs.length * stepMs) / 1000)} s`);
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: SIZE, height: SIZE },
    colorScheme: 'dark',
    recordVideo: { dir: OUT, size: { width: SIZE, height: SIZE } },
  });
  const page = await ctx.newPage();
  let idx = 0;
  await page.route('**/api/v1/graph', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: graphs[idx] }));
  await page.route('**/api/v1/events', (r) =>
    r.fulfill({ status: 200, contentType: 'text/event-stream', body: 'retry: 100\n\nevent: vault\ndata: {}\n\n' }));
  await page.addInitScript(() => {
    try {
      localStorage.setItem('vault.graphPrefs', JSON.stringify({ v: 1, lens: 'domain', showClusters: false, showGaps: false, showNetwork: false, spotlight: false, showSystem: false, selectedTypes: [], selectedDomains: [] }));
    } catch { /* the defaults will do */ }
  });

  // Set up on the last snapshot: fit the camera and fill the position map, so that a node
  // later appears where it stays.
  idx = graphs.length - 1;
  await page.goto('http://localhost:8421/graph?labels=off', { waitUntil: 'domcontentloaded' });
  /*
   * Playwright records the whole session, the setup included, which is why the setup is kept
   * as short as possible. What survives of it in the film is about two seconds of the
   * finished graph standing still before the rewind. Only an encoder can cut that cleanly;
   * the PNG sequence beside this has no lead-in.
   */
  await page.locator('canvas.graph-canvas').waitFor({ timeout: 40000 });
  await page.getByTitle(/Show the graph on its own/).click();
  await page.addStyleTag({ content: CHROME_OFF });
  await page.waitForTimeout(700);
  const box = await page.locator('canvas.graph-canvas').boundingBox();
  console.log('drawing area:', Math.round(box.width) + 'x' + Math.round(box.height));
  await page.waitForTimeout(1200);
  await page.keyboard.press('f');
  await page.waitForTimeout(1600);

  // Rewind, and let it grow.
  const t0 = Date.now();
  for (idx = 0; idx < graphs.length; idx++) {
    await page.waitForTimeout(stepMs);
    if (idx % 20 === 0) console.log(`  snapshot ${idx + 1}/${graphs.length}`);
  }
  idx = graphs.length - 1;
  await page.waitForTimeout(2600);   // the ending holds for a moment
  console.log(`run time ${Math.round((Date.now() - t0) / 1000)} s`);

  const video = page.video();
  await ctx.close();
  const file = await video.path();
  console.log('video:', file, (fs.statSync(file).size / 1024 / 1024).toFixed(1), 'MB');
  await browser.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
