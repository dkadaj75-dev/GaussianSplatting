import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.argv[2];
const OUT = process.argv[3];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.splat': 'application/octet-stream' };

const server = createServer(async (req, res) => {
  try {
    const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto(`http://127.0.0.1:${port}/harness.html?src=/scene.splat`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true || window.__error, null, { timeout: 60000 });
const err = await page.evaluate(() => window.__error);
if (err) { console.log('LOAD ERROR', err); process.exit(1); }
console.log('splats loaded:', await page.evaluate(() => window.__splatCount));

const views = [
  ['front',        25,  12, 2.5],
  ['upper-left',  110,  38, 2.6],
  ['side',        200,  10, 2.5],
  ['top-down',     70,  72, 2.8],
  ['low-angle',   300, -18, 2.5],
  ['close',       150,  25, 1.7],
];
for (const [name, az, el, dist] of views) {
  await page.evaluate(([a,e,d]) => window.__view(a,e,d), [az, el, dist]);
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, `angle-${name}.png`) });
  console.log('shot', name);
}
await browser.close();
server.close();
