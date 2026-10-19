// Loads the built extension (dist/) into Chromium and drives it against dev/mock-ghe.mjs,
// exercising the GitHub Enterprise path: host config → dynamic content script → API via service worker.
import { chromium } from 'playwright-core';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const shots = process.argv[2] ?? 'dev/out';
const exe = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const origin = 'http://localhost:8766';

// Test copy of the extension: pre-grant the mock host (in real use the options page requests it).
const ext = mkdtempSync(join(tmpdir(), 'mdr-ext-'));
cpSync('dist', ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
manifest.host_permissions.push(`${origin}/*`);
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'mdr-prof-')), {
  executablePath: exe,
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-proxy-server'],
  viewport: { width: 1440, height: 900 },
});
const errors = [];

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
console.log('extension loaded:', extId);

// Options page renders.
const opts = await ctx.newPage();
opts.on('pageerror', (e) => errors.push('options: ' + e.message));
await opts.goto(`chrome-extension://${extId}/options.html`);
await opts.getByText('GitHub Enterprise', { exact: true }).waitFor();
await opts.screenshot({ path: `${shots}/10-options.png`, fullPage: true });

// Configure the enterprise host the way the options page would (permission is pre-granted above).
await sw.evaluate(async (origin) => {
  await chrome.storage.local.set({ hosts: { [origin]: { origin, apiBase: `${origin}/api/v3`, token: 'ghp_testtoken' } } });
}, origin);
// Wait for the background worker to register the content script for that host.
for (let i = 0; i < 50; i++) {
  const n = await sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length);
  if (n) break;
  await new Promise((r) => setTimeout(r, 100));
}
const reg = await sw.evaluate(async () => chrome.scripting.getRegisteredContentScripts());
assert.equal(reg[0].matches[0], `${origin}/*`);

// Options page reflects the instance.
await opts.reload();
await opts.getByText('localhost:8766').first().waitFor();
// Save re-validates the connection and reports who you are.
await opts.getByRole('button', { name: 'Save', exact: true }).nth(1).click();
await opts.getByText('Connected as @tester').waitFor({ timeout: 5000 });
await opts.screenshot({ path: `${shots}/11-options-ghe.png`, fullPage: true });

const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && errors.push(m.text()));
await page.goto(`${origin}/acme/payments/pull/42/files`);
await page.locator('.mdr-launcher').waitFor({ timeout: 10000 });
assert.match(await page.locator('.mdr-launcher').innerText(), /Review Markdown\s*4/);
await page.locator('.mdr-launcher').click();
await page.locator('.mdr-doc h1').waitFor();

// Mermaid: the content script import()s mermaid.js from the extension (web_accessible_resources).
await page.locator('.mdr-file', { hasText: 'flow.md' }).click();
await page.locator('.mdr-doc h1', { hasText: 'Checkout flow' }).waitFor();
const flow = page.locator('.mdr-mermaid').first();
await flow.locator('svg').waitFor({ timeout: 15000 });
assert.equal(await flow.locator('.node.mdrAdded').count(), 1, 'merged Changes view of the flowchart rendered');
await page.locator('.mdr-mermaid').nth(2).locator('.mdr-mermaid-pane svg').nth(1).waitFor({ timeout: 15000 });
assert.equal(await page.locator('.mdr-banner-del').count(), 0, 'every diagram rendered');
await page.screenshot({ path: `${shots}/13-ghe-mermaid.png` });

// Math: KaTeX is import()ed from the extension too, and renders MathML.
await page.locator('.mdr-file', { hasText: 'guide.md' }).click();
await page.locator('.mdr-doc h1', { hasText: 'Operator guide' }).waitFor();
await page.locator('.mdr-doc .mdr-math math').first().waitFor({ timeout: 10000 });
assert.equal(await page.locator('.mdr-doc .markdown-alert-warning').count(), 1, 'admonition rendered');

await page.locator('.mdr-file', { hasText: 'architecture' }).click();
await page.locator('.mdr-doc h1', { hasText: 'Payments service architecture' }).waitFor();

// Comment now on a list item → goes through the service worker with the token.
const pts = await page.evaluate(() => {
  const root = document.getElementById('md-pr-review-root').shadowRoot;
  const li = [...root.querySelectorAll('.mdr-doc li')].find((e) => e.textContent.includes('idempotency keys supplied'));
  const w = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
  let n; while ((n = w.nextNode())) { const i = n.textContent.indexOf('idempotency'); if (i >= 0) {
    const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 11); const b = r.getBoundingClientRect();
    return { x1: b.left + 1, x2: b.right - 1, y: b.top + b.height / 2 }; } }
});
await page.mouse.move(pts.x1, pts.y); await page.mouse.down(); await page.mouse.move(pts.x2, pts.y, { steps: 6 }); await page.mouse.up();
await page.locator('.mdr-toolbar').waitFor({ timeout: 5000 });
await page.locator('.mdr-toolbar button', { hasText: 'Comment' }).click();
await page.locator('.mdr-composer textarea').fill('Comment from the real extension');
await page.locator('.mdr-composer button', { hasText: 'Comment now' }).click();
await page.locator('.mdr-toast-ok').waitFor();
await page.waitForTimeout(500);
await page.screenshot({ path: `${shots}/12-ghe-page.png` });

const calls = await (await fetch(`${origin}/__calls`)).json();
const c = calls.find((x) => x.path.endsWith('/pulls/42/comments'));
assert.equal(c.auth, 'Bearer ghp_testtoken');
const headLines = readFileSync('dev/fixtures/head.md', 'utf8').split('\n');
assert.equal(c.body.line, headLines.findIndex((l) => l.includes('idempotency keys supplied')) + 1);
assert.equal(await page.locator('.mdr-badge-thread').count(), 1);

// Escape closes the overlay even when focus fell back to the page.
await page.keyboard.press('Escape');
await page.locator('.mdr-launcher').waitFor();

assert.deepEqual(errors, [], 'no console errors');
console.log('EXTENSION E2E OK – no console errors');
await ctx.close();
