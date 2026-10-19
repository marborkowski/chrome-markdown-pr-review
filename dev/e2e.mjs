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
assert.match(await page.locator('.mdr-launcher').innerText(), /Review Markdown\s*4/);
await page.screenshot({ path: `${shots}/01-launcher.png` });

await page.locator('.mdr-launcher').click();
await page.locator('.mdr-doc h1').waitFor();
await page.locator('.mdr-mermaid svg').waitFor({ timeout: 15000 }); // the new sequence diagram of architecture.md
await page.waitForTimeout(400);
assert.equal(await page.locator('.mdr-file').count(), 4, 'only markdown files listed');
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
await page.locator('.mdr-header .mdr-seg button', { hasText: 'Source' }).click();
await page.waitForTimeout(200);
await page.screenshot({ path: `${shots}/08-source.png` });
await page.locator('.mdr-header .mdr-seg button', { hasText: 'Rendered' }).click();
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

// 7) GitHub alerts, in-document anchors and links to other Markdown files of the PR.
await page.evaluate(() => { document.documentElement.dataset.colorMode = 'light'; });
await page.locator('.mdr-file', { hasText: 'README' }).click();
await page.locator('.mdr-doc .markdown-alert-note').waitFor();
assert.match(await page.locator('.mdr-doc .markdown-alert-title').innerText(), /Note/);
await page.locator('.mdr-doc a', { hasText: 'Running locally' }).click();
await page.locator('.mdr-doc h2#running-locally.mdr-flash').waitFor();
await page.locator('.mdr-doc a', { hasText: 'goals' }).click();
await page.locator('.mdr-filebar-path', { hasText: 'docs/architecture.md' }).waitFor();
await page.locator('.mdr-doc h2#goals.mdr-flash').waitFor();
await page.screenshot({ path: `${shots}/10-anchor.png` });

// 8) Resolve a conversation: it moves to the collapsed "Resolved" section.
const convCount = () => page.locator('.mdr-panel h4', { hasText: 'Conversations' }).locator('.mdr-count').innerText();
const before = Number(await convCount());
await page.locator('.mdr-thread', { hasText: 'SLA of the fraud service' }).locator('button', { hasText: 'Resolve' }).click();
await page.locator('.mdr-panel .mdr-link', { hasText: 'Resolved conversations (1)' }).waitFor();
assert.equal(Number(await convCount()), before - 1);
calls = await page.evaluate(() => window.__calls);
assert.ok(calls.some((c) => c.path === 'graphql' && c.body.query.includes('resolveReviewThread')), 'resolve mutation sent');

// 9) Esc in a reply box leaves the box, it doesn't close the review.
await page.locator('.mdr-reply-open').first().click();
await page.locator('.mdr-reply textarea').fill('Half-written reply');
await page.keyboard.press('Escape');
assert.equal(await page.locator('.mdr-overlay').count(), 1, 'review stays open');
assert.equal(await page.locator('.mdr-reply textarea').inputValue(), 'Half-written reply');
await page.locator('.mdr-reply button', { hasText: 'Cancel' }).click();

// 10) Esc on a written comment asks before discarding it.
await selectText('h2', 'Request flow');
await page.keyboard.press('c');
await page.locator('.mdr-composer textarea').fill('Half-written thought');
await page.keyboard.press('Escape');
await page.locator('.mdr-composer .mdr-warn').waitFor();
await page.keyboard.press('Escape');
assert.equal(await page.locator('.mdr-composer').count(), 0, 'second Esc discards');

// 11) Mermaid: a changed flowchart gets one merged "Changes" diagram, other changed diagram
//     types a Before / After pair; After / Before / Source show the single versions and the code.
const texts = (loc) => loc.evaluateAll((els) => els.map((e) => e.textContent.trim()));
async function switchView(block, name) {
  await block.locator('.mdr-seg button', { hasText: name }).click();
  await block.locator('.mdr-mermaid-loading').waitFor({ state: 'detached' });
  assert.equal(await block.locator('.mdr-banner-del').count(), 0, `${name} view rendered without errors`);
}
await page.locator('.mdr-file', { hasText: 'flow.md' }).click();
await page.locator('.mdr-doc h1', { hasText: 'Checkout flow' }).waitFor();
const flow = page.locator('.mdr-mermaid').nth(0);
await flow.locator('svg').waitFor({ timeout: 15000 });
assert.deepEqual(await flow.locator('.mdr-seg button').allInnerTexts(), ['Changes', 'After', 'Before', 'Source']);
assert.equal(await flow.locator('.mdr-seg button.on').innerText(), 'Changes', 'a modified flowchart opens on the Changes view');
assert.equal(await flow.locator('svg').count(), 1, 'one merged diagram');
assert.deepEqual(await texts(flow.locator('.node.mdrAdded')), ['Notify']);
assert.deepEqual(await texts(flow.locator('.node.mdrRemoved')), ['Old step']);
assert.deepEqual(await texts(flow.locator('.node.mdrChanged')), ['Valid request?']);
const edgeStyles = await flow.locator('path.flowchart-link').evaluateAll((ps) => ps.map((p) => p.getAttribute('style') ?? ''));
assert.equal(edgeStyles.filter((s) => /stroke-dasharray:\s*5 3/.test(s)).length, 2, 'removed edges (D→F, F→G) are dashed');
assert.equal(edgeStyles.filter((s) => /stroke:\s*#1a7f37/.test(s)).length, 2, 'added edges (D→N, N→G) are green');
assert.equal(await flow.locator('.mdr-mermaid-legend').count(), 1);
await flow.scrollIntoViewIfNeeded();
await page.screenshot({ path: `${shots}/11-mermaid-changes.png` });

await switchView(flow, 'After');
assert.equal(await flow.locator('svg').count(), 1);
assert.equal(await flow.locator('.node.mdrRemoved').count(), 0, 'After has no removed nodes');
let labels = await texts(flow.locator('.node'));
assert.ok(labels.includes('Notify') && !labels.includes('Old step'), 'After shows the new version');
await page.screenshot({ path: `${shots}/12-mermaid-after.png` });
await switchView(flow, 'Before');
labels = await texts(flow.locator('.node'));
assert.ok(labels.includes('Old step') && !labels.includes('Notify'), 'Before shows the old version');
await switchView(flow, 'Source');
assert.equal(await flow.locator('svg').count(), 0);
assert.match(await flow.locator('pre').innerText(), /flowchart TD[\s\S]*N\[Notify\]/, 'Source shows the code block again');
await page.screenshot({ path: `${shots}/13-mermaid-source.png` });
await switchView(flow, 'Changes');
assert.equal(await flow.locator('.node.mdrRemoved').count(), 1);

const pie = page.locator('.mdr-mermaid').nth(1);
await pie.locator('svg').waitFor();
assert.deepEqual(await pie.locator('.mdr-seg button').allInnerTexts(), ['After', 'Source'], 'an unchanged diagram has no Changes / Before');

const seq = page.locator('.mdr-mermaid').nth(2);
await seq.locator('.mdr-mermaid-pane svg').nth(1).waitFor({ timeout: 15000 });
assert.deepEqual(await seq.locator('.mdr-seg button').allInnerTexts(), ['Changes', 'After', 'Before', 'Source']);
assert.match(await seq.locator('.mdr-mermaid-note').innerText(), /before \/ after/);
const panes = seq.locator('.mdr-mermaid-pane');
assert.deepEqual(await texts(panes.locator('.mdr-mermaid-caption')), ['Before', 'After']);
assert.ok((await texts(panes.nth(0).locator('.mdr-svg-removed'))).includes('approved'), 'removed message highlighted in Before');
assert.equal(await panes.nth(0).locator('.mdr-svg-added').count(), 0);
assert.ok((await texts(panes.nth(1).locator('.mdr-svg-added'))).includes('score intent'), 'added message highlighted in After');
assert.equal(await panes.nth(1).locator('.mdr-svg-removed').count(), 0);
await seq.scrollIntoViewIfNeeded();
await page.screenshot({ path: `${shots}/14-mermaid-sequence.png` });
await page.evaluate(() => { document.documentElement.dataset.colorMode = 'dark'; });
await flow.scrollIntoViewIfNeeded();
await flow.locator('.mdr-mermaid-loading').waitFor({ state: 'detached' });
await flow.locator('svg').waitFor();
await page.waitForTimeout(300);
await page.screenshot({ path: `${shots}/15-mermaid-dark.png` });
await page.evaluate(() => { document.documentElement.dataset.colorMode = 'light'; });

assert.deepEqual(errors, [], 'no console errors');
console.log('E2E OK –', calls.length, 'write calls recorded, no console errors');
await browser.close();
