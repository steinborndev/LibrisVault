const { chromium } = require('/home/benjamin/.npm/_npx/705bc6b22212b352/node_modules/playwright/index.js');
const fs = require('fs'), path = require('path');
const FRAMES = process.argv[2], OUT = process.argv[3];
const SECONDS = Number(process.argv[4] || 20);
const SIZE = 1080;

/*
 * Der Film. Playwright nimmt die Seite selbst auf, deshalb muss die Seite das Bild SEIN:
 * Kopfleiste, Bedienfeld, Minimap und Statusmarke gehen weg, die Polster auf null, und die
 * Zeichenflaeche fuellt genau 1080x1080. Damit braucht es keinen Zuschnitt und kein ffmpeg.
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
  console.log(`${graphs.length} Datenstaende, ${stepMs} ms je Stand = ${Math.round((graphs.length * stepMs) / 1000)} s`);
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
    } catch { /* Vorgaben tun es auch */ }
  });

  // Aufbau beim letzten Stand: Kamera einpassen und die Positionskarte fuellen, damit ein
  // Knoten spaeter dort erscheint, wo er bleibt.
  idx = graphs.length - 1;
  await page.goto('http://localhost:8421/graph?labels=off', { waitUntil: 'domcontentloaded' });
  /*
   * Playwright nimmt die ganze Sitzung auf, auch den Aufbau - deshalb ist er so kurz wie
   * moeglich gehalten. Was davon im Film uebrigbleibt, ist ein Standbild des fertigen Graphen
   * von rund zwei Sekunden, bevor zurueckgespult wird. Sauber schneiden kann nur ein Encoder;
   * die PNG-Folge daneben hat diesen Vorlauf nicht.
   */
  await page.locator('canvas.graph-canvas').waitFor({ timeout: 40000 });
  await page.getByTitle(/Show the graph on its own/).click();
  await page.addStyleTag({ content: CHROME_OFF });
  await page.waitForTimeout(700);
  const box = await page.locator('canvas.graph-canvas').boundingBox();
  console.log('Zeichenflaeche:', Math.round(box.width) + 'x' + Math.round(box.height));
  await page.waitForTimeout(1200);
  await page.keyboard.press('f');
  await page.waitForTimeout(1600);

  // Zurueckspulen und wachsen lassen.
  const t0 = Date.now();
  for (idx = 0; idx < graphs.length; idx++) {
    await page.waitForTimeout(stepMs);
    if (idx % 20 === 0) console.log(`  Stand ${idx + 1}/${graphs.length}`);
  }
  idx = graphs.length - 1;
  await page.waitForTimeout(2600);   // der Schluss steht einen Moment
  console.log(`Laufzeit ${Math.round((Date.now() - t0) / 1000)} s`);

  const video = page.video();
  await ctx.close();
  const file = await video.path();
  console.log('Video:', file, (fs.statSync(file).size / 1024 / 1024).toFixed(1), 'MB');
  await browser.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
