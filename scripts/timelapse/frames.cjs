const { chromium } = require('/home/benjamin/.npm/_npx/705bc6b22212b352/node_modules/playwright/index.js');
const fs = require('fs'), path = require('path');
const FRAMES = process.argv[2], OUT = process.argv[3];
const HOLD = Number(process.argv[4] || 5);      // Aufnahmen pro Datenstand
const SIZE = 1080;

(async () => {
  const files = fs.readdirSync(FRAMES).filter((f) => /^\d+\.json$/.test(f)).sort();
  const graphs = files.map((f) => fs.readFileSync(path.join(FRAMES, f), 'utf8'));
  console.log(`${graphs.length} Datenstaende, ${HOLD} Aufnahmen je Stand = ${graphs.length * HOLD} Bilder`);
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ args: ['--force-device-scale-factor=1'] });
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, colorScheme: 'dark' });
  let idx = 0;

  // Der Graph kommt aus den Snapshots.
  await page.route('**/api/v1/graph', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: graphs[idx] }));
  /*
   * Der Auslöser zum Nachladen: die App invalidiert ['graph'] auf ein `vault`-Ereignis des
   * SSE-Stroms. Playwright kann keinen offenen Strom bedienen, also liefert jede Verbindung
   * genau ein Ereignis und schliesst; `retry:` setzt die Wiederverbindung auf 120 ms. Jede
   * Wiederverbindung ist damit ein Frame - über den echten Pfad der App, nicht daran vorbei.
   */
  await page.route('**/api/v1/events', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'retry: 120\n\nevent: vault\ndata: {}\n\n' }));

  // Ansicht vorbereiten: Domain-Lens (Farbe traegt das Bild, sobald die Beschriftung weg ist),
  // keine Huellen, keine Systemseiten.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('vault.graphPrefs', JSON.stringify({ v: 1, lens: 'domain', showClusters: false, showGaps: false, showNetwork: false, spotlight: false, showSystem: false, selectedTypes: [], selectedDomains: [] }));
    } catch { /* ohne localStorage laeuft die Ansicht auf ihren Vorgaben */ }
  });

  await page.goto('http://localhost:8421/graph?labels=off', { waitUntil: 'domcontentloaded' });   // nicht networkidle: der SSE-Strom verbindet sich alle 120 ms neu
  await page.locator('canvas.graph-canvas').waitFor({ timeout: 40000 });
  await page.waitForTimeout(3000);

  // Nur die Zeichenflaeche: der Vollbildmodus der App blendet das Bedienfeld aus, Minimap und
  // Statusmarke gehen per CSS - was bleibt, ist das Bild.
  await page.getByTitle(/Show the graph on its own/).click();
  await page.addStyleTag({ content: '.graph-minimap,.graph-status,.graph-controls{display:none!important}' });
  await page.waitForTimeout(1500);

  /*
   * Feste Kamera. Der letzte Stand wird zuerst geladen und eingepasst, dann wird
   * zurueckgespult: die Kamera bleibt, und die Positionskarte (nach Seitenpfad) kennt schon
   * jeden Knoten. Ein Knoten erscheint damit an dem Platz, den er behalten wird, statt dass
   * das ganze Layout bei jedem Zuwachs neu zuckt - anders waere es nicht anzusehen.
   */
  idx = graphs.length - 1;
  await page.waitForTimeout(2500);
  await page.keyboard.press('f');
  await page.waitForTimeout(4000);

  const canvas = page.locator('canvas.graph-canvas').first();
  let box = await canvas.boundingBox();
  console.log('Zeichenflaeche:', JSON.stringify(box && { w: Math.round(box.width), h: Math.round(box.height) }));

  let shot = 0;
  for (idx = 0; idx < graphs.length; idx++) {
    for (let k = 0; k < HOLD; k++) {
      await page.screenshot({ path: path.join(OUT, `f${String(shot).padStart(5, '0')}.png`), clip: box });
      shot++;
    }
    if (idx % 20 === 0) console.log(`  Stand ${idx + 1}/${graphs.length}, ${shot} Bilder`);
  }
  console.log(`${shot} Bilder geschrieben`);
  await browser.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
