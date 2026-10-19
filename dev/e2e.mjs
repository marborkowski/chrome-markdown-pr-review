// End-to-end check of the review UI against the mocked API (dev/harness.html).
// Usage: python3 -m http.server 8765 &  node dev/e2e.mjs [screenshotDir]
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const shots = process.argv[2] ?? 'dev/out';
const head = readFileSync('dev/fixtures/head.md', 'utf8').split('\n');
const lineOf = (s) => head.findIndex((l) => l.includes(s)) + 1;
const exe = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && errors.push(m.text()));

await page.goto('http://localhost:8765/dev/harness.html');
await page.locator('.mdr-launcher').waitFor();
assert.match(await page.locator('.mdr-launcher').innerText(), /Review Markdown\s*3/);
await page.screenshot({ path: `${shots}/01-launcher.png` });

await page.locator('.mdr-launcher').click();
await page.locator('.mdr-doc h1').waitFor();
await page.waitForTimeout(400);
assert.equal(await page.locator('.mdr-file').count(), 3, 'only markdown files listed');
await page.screenshot({ path: `${shots}/02-overview.png` });

/** Drag-select `needle` inside the first element matching `sel` that contains it. */
async function selectText(sel, needle) {
  const box = await page.evaluate(([sel, needle]) => {
    const root = document.getElementById('md-pr-review-root').shadowRoot;
    const els = [...root.querySelectorAll(sel)].filter((e) => e.textContent.includes(needle));
    const el = els[0];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const i = n.textContent.indexOf(needle);
      if (i >= 0) {
        el.scrollIntoView({ block: 'center' });
        const r = document.createRange();
        r.setStart(n, i); r.setEnd(n, i + 1);
        const a = r.getBoundingClientRect();
        r.setStart(n, i + needle.length - 1); r.setEnd(n, i + needle.length);
        const b = r.getBoundingClientRect();
        return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 };
      }
    }
    return null;
  }, [sel, needle]);
  assert.ok(box, `text not found: ${needle}`);
  await page.mouse.move(box.x1, box.y1);
  await page.mouse.down();
  await page.mouse.move(box.x2, box.y2, { steps: 8 });
  await page.mouse.up();
  await page.locator('.mdr-toolbar').waitFor();
}

// 1) Comment on a phrase in the middle of a two-line paragraph → should map to the 2nd line only.
await page.locator('.mdr-toggle input').first().uncheck(); // plain rendered view (no inline word diff)
await page.waitForTimeout(200);
await selectText('p', 'correlated by the webhook');
await page.screenshot({ path: `${shots}/03-toolbar.png` });
await page.locator('.mdr-toolbar button', { hasText: 'Comment' }).click();
const expectLine = lineOf('response is correlated');
assert.match(await page.locator('.mdr-composer-head').innerText(), new RegExp(`line ${expectLine}\\b`));
await page.locator('.mdr-composer textarea').fill('Which component owns the correlation timeout?');
await page.screenshot({ path: `${shots}/04-composer.png` });
await page.locator('.mdr-composer button', { hasText: /Start a review/ }).click();
assert.equal(await page.locator('.mdr-badge-pending').count(), 1);

// 2) Suggest a change on a list item and post it immediately.
await selectText('li', 'high-risk intents');
await page.locator('.mdr-toolbar button', { hasText: 'Suggest' }).click();
const ta = page.locator('.mdr-composer textarea');
const val = await ta.inputValue();
assert.ok(val.startsWith('```suggestion\n3. The fraud service scores'), 'suggestion prefilled with source line');
await ta.fill(val.replace('held for review', 'held for manual review (SLA 4h)'));
await page.locator('.mdr-composer button', { hasText: 'Comment now' }).click();
await page.locator('.mdr-toast-ok').waitFor();
let calls = await page.evaluate(() => window.__calls);
const posted = calls.find((c) => c.path.endsWith('/pulls/42/comments'));
assert.equal(posted.body.line, lineOf('fraud service scores'));
assert.equal(posted.body.side, 'RIGHT');
assert.equal(posted.body.commit_id, 'headsha');
assert.ok(posted.body.body.includes('manual review (SLA 4h)'));

// 3) Multi-paragraph selection → multi-line comment range.
await selectText('h2', 'Storage');
await page.keyboard.press('c');
assert.match(await page.locator('.mdr-composer-head').innerText(), new RegExp(`line ${lineOf('## Storage')}\\b`));
await page.locator('.mdr-composer textarea').fill('Rename to "Persistence"?');
await page.keyboard.press('Control+Enter');

// 4) Word diff view + changes popover.
await page.locator('.mdr-toggle input').first().check();
await page.waitForTimeout(250);
assert.ok((await page.locator('.mdr-doc ins').count()) > 3, 'inline word diff rendered');
await page.locator('.mdr-doc h2', { hasText: 'Goals' }).scrollIntoViewIfNeeded();
await page.screenshot({ path: `${shots}/05-worddiff.png` });

// 5) Submit the review.
await page.locator('.mdr-header button', { hasText: 'Finish review' }).click();
await page.locator('.mdr-modal').waitFor();
await page.locator('.mdr-modal textarea').fill('Looks good overall, a few questions.');
await page.screenshot({ path: `${shots}/06-submit.png` });
await page.locator('.mdr-modal button', { hasText: 'Submit review' }).click();
await page.locator('.mdr-toast-ok', { hasText: 'Review submitted' }).waitFor();
calls = await page.evaluate(() => window.__calls);
const review = calls.find((c) => c.path.endsWith('/reviews'));
assert.equal(review.body.event, 'COMMENT');
assert.deepEqual(review.body.comments.map((c) => c.line).sort((a, b) => a - b), [lineOf('## Storage'), expectLine].sort((a, b) => a - b));
assert.ok(review.body.comments[0].body.startsWith('> '), 'quote included');
await page.waitForTimeout(300);
await page.screenshot({ path: `${shots}/07-after-submit.png` });

// 6) Source view, removed file, dark mode.
await page.locator('.mdr-seg button', { hasText: 'Source' }).click();
await page.waitForTimeout(200);
await page.screenshot({ path: `${shots}/08-source.png` });
await page.locator('.mdr-seg button', { hasText: 'Rendered' }).click();
await page.locator('.mdr-file', { hasText: 'legacy-export' }).click();
await page.locator('.mdr-banner-del').waitFor();
await page.locator('.mdr-file', { hasText: 'README' }).click();
await page.locator('.mdr-doc h1', { hasText: 'Payments service' }).waitFor();
const imgOrLink = await page.locator('.mdr-doc a', { hasText: 'architecture doc' }).getAttribute('href');
assert.equal(imgOrLink, 'https://github.com/acme/payments/blob/headsha/docs/architecture.md');
await page.locator('.mdr-file', { hasText: 'architecture' }).click();
await page.locator('.mdr-doc h1').waitFor();

await page.evaluate(() => { document.documentElement.dataset.colorMode = 'dark'; });
await page.locator('.mdr-badge-thread').first().click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${shots}/09-dark.png` });

assert.deepEqual(errors, [], 'no console errors');
console.log('E2E OK –', calls.length, 'write calls recorded');
await browser.close();
