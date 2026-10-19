// Renders the README screenshots from the dev harness (npm run harness && python3 -m http.server 8765):
//   CHROMIUM="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node dev/readme-shots.mjs [outDir]
// Writes docs/review.png and docs/split.png by default.
import { chromium } from 'playwright-core';

const out = process.argv[2] ?? 'docs';
const base = process.env.HARNESS_URL ?? 'http://localhost:8765';
const box = (x, y, w, label, fill, stroke) =>
  `<rect x="${x}" y="${y}" width="${w}" height="44" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>` +
  `<text x="${x + w / 2}" y="${y + 27}" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif" font-size="15" text-anchor="middle" fill="#1f2328">${label}</text>`;
const arrow = (x1, x2, y) => `<line x1="${x1}" y1="${y}" x2="${x2 - 6}" y2="${y}" stroke="#59636e" stroke-width="1.5" marker-end="url(#a)"/>`;
const svg = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#59636e"/></marker></defs><rect width="${w}" height="${h}" fill="#ffffff"/>${body}</svg>`;
const flowOld = svg(330, 90, box(10, 23, 90, 'Gateway', '#ddf4ff', '#0969da') + arrow(100, 120, 45) + box(120, 23, 90, 'Payments', '#ddf4ff', '#0969da') + arrow(210, 230, 45) + box(230, 23, 90, 'Adapter', '#ddf4ff', '#0969da'));
const flowNew = svg(440, 90, box(10, 23, 90, 'Gateway', '#ddf4ff', '#0969da') + arrow(100, 120, 45) + box(120, 23, 90, 'Payments', '#ddf4ff', '#0969da') + arrow(210, 230, 45) + box(230, 23, 90, 'Fraud', '#fff8c5', '#9a6700') + arrow(320, 340, 45) + box(340, 23, 90, 'Adapter', '#ddf4ff', '#0969da'));
const logo = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="22" fill="#1f883d"/><text x="48" y="60" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif" font-size="34" font-weight="700" text-anchor="middle" fill="#fff">Pay</text></svg>`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
await page.route('https://github.com/**', (route) => {
  const u = route.request().url();
  const body = u.includes('logo') ? logo : u.includes('/basesha/') ? flowOld : flowNew;
  route.fulfill({ status: 200, contentType: 'image/svg+xml', body });
});
const root = () => page.locator('#md-pr-review-root');
await page.goto(`${base}/dev/harness.html`);
await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('mdr:')) localStorage.removeItem(k); });
await page.reload();
await page.locator('.mdr-launcher').click();
await page.locator('.mdr-doc h1').waitFor();
await page.locator('.mdr-file', { hasText: 'guide.md' }).click();
await page.locator('.mdr-doc h1', { hasText: 'Operator guide' }).waitFor();
await page.locator('.mdr-doc .mdr-math math').first().waitFor({ timeout: 10000 });

// A conversation on the edited table row.
const row = page.locator('.mdr-doc tr', { hasText: 'Stripe' });
await row.scrollIntoViewIfNeeded();
await row.hover();
await page.locator('.mdr-hover-add').click();
await page.locator('.mdr-composer textarea').fill('Is 5 s still below the gateway timeout? The gateway gives up after 6 s.');
await page.locator('.mdr-composer button', { hasText: 'Comment now' }).click();
await page.locator('.mdr-toast-ok').click();
await page.locator('.mdr-toast').waitFor({ state: 'detached' });

const scrollTo = async (pane, heading, offset) =>
  page.evaluate(([pane, heading, offset]) => {
    const r = document.getElementById('md-pr-review-root').shadowRoot;
    const main = r.querySelector(pane);
    const h = [...main.querySelectorAll('h2')].find((e) => e.textContent.trim() === heading);
    main.scrollTop += h.getBoundingClientRect().top - main.getBoundingClientRect().top - offset;
  }, [pane, heading, offset]);

await scrollTo('.mdr-main', 'Usage', 64);
await page.mouse.move(700, 850);
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/review.png` });

await page.keyboard.press('2');
await page.locator('.mdr-split-before .mdr-doc').waitFor();
await page.waitForTimeout(500);
await scrollTo('.mdr-split-after', 'Usage', 40);
await page.waitForTimeout(700);
await page.mouse.move(700, 850);
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/split.png` });
await browser.close();
console.log('ok');
