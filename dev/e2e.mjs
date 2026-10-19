// End-to-end check of the review UI against the mocked API (dev/harness.html).
// Usage: python3 -m http.server 8765 &  node dev/e2e.mjs [screenshotDir]
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const shots = process.argv[2] ?? 'dev/out';
const head = readFileSync('dev/fixtures/head.md', 'utf8').split('\n');
const lineOf = (s) => head.findIndex((l) => l.includes(s)) + 1;
const exe = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const base = process.env.HARNESS_URL ?? 'http://localhost:8765';

const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
// Images of the documents resolve to github.com: serve a small PNG instead of going to the network.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAAN0lEQVR4nO3OQQ0AMAgEMCQiDIkTMxccjyYV0Op5p1R8ICQkJJQeCAkJCaUHQkJCQumBkJDQsg9EGVCXhR5mwwAAAABJRU5ErkJggg==', 'base64');
await page.route('https://github.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && errors.push(m.text()));

await page.goto(`${base}/dev/harness.html`);
await page.locator('.mdr-launcher').waitFor();
assert.match(await page.locator('.mdr-launcher').innerText(), /Review Markdown\s*5/);
await page.screenshot({ path: `${shots}/01-launcher.png` });

await page.locator('.mdr-launcher').click();
await page.locator('.mdr-doc h1').waitFor();
await page.locator('.mdr-mermaid svg').waitFor({ timeout: 15000 }); // the new sequence diagram of architecture.md
await page.waitForTimeout(400);
assert.equal(await page.locator('.mdr-file').count(), 5, 'only markdown files listed');
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

/** Switch an option of the header's View menu. */
async function setView(label, on) {
  await page.locator('.mdr-header .mdr-dropdown button', { hasText: 'View' }).click();
  const box = page.locator('.mdr-menu-item', { hasText: label }).locator('input');
  if (on) await box.check();
  else await box.uncheck();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.mdr-menu').count(), 0, 'menu closed');
  assert.equal(await page.locator('.mdr-overlay').count(), 1, 'Esc in the menu keeps the review open');
}

// 1) Comment on a phrase in the middle of a two-line paragraph → should map to the 2nd line only.
await setView('Word diff', false); // plain rendered view (no inline word diff)
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
await setView('Word diff', true);
await page.waitForTimeout(250);
assert.ok((await page.locator('.mdr-doc ins').count()) > 3, 'inline word diff rendered');
await page.locator('.mdr-doc h2', { hasText: 'Goals' }).scrollIntoViewIfNeeded();
await page.screenshot({ path: `${shots}/05-worddiff.png` });

// 4b) Quoting a deleted word of the word diff keeps it struck through.
await selectText('li', '300');
await page.keyboard.press('c');
await page.locator('.mdr-composer blockquote del', { hasText: '300' }).waitFor();
await page.keyboard.press('Escape');
assert.equal(await page.locator('.mdr-composer').count(), 0);

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

// 12) Old diagram text can't be commented on: a selection inside the Before pane shows no toolbar.
const approved = panes.nth(0).locator('text', { hasText: 'approved' }).first();
await approved.scrollIntoViewIfNeeded();
const ab = await approved.boundingBox();
await page.mouse.move(ab.x + 1, ab.y + ab.height / 2);
await page.mouse.down();
await page.mouse.move(ab.x + ab.width - 1, ab.y + ab.height / 2, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(300);
assert.equal(await page.locator('.mdr-toolbar').count(), 0, 'no comment toolbar for text of the old version');
assert.equal(await panes.nth(0).locator('.mdr-mermaid-old').count(), 1, 'Before pane is marked as the old version');

// 13) A selection reaching from a paragraph into a diagram quotes the labels, not mermaid's CSS or the view buttons.
const intro = page.locator('.mdr-doc p', { hasText: 'checkout request' });
await intro.scrollIntoViewIfNeeded();
const from = await page.evaluate(() => {
  const root = document.getElementById('md-pr-review-root').shadowRoot;
  const p = [...root.querySelectorAll('.mdr-doc p')].find((e) => e.textContent.includes('checkout request'));
  const n = document.createTreeWalker(p, NodeFilter.SHOW_TEXT).nextNode();
  const i = n.textContent.indexOf('held');
  const r = document.createRange();
  r.setStart(n, i); r.setEnd(n, i + 1);
  const b = r.getBoundingClientRect();
  return { x: b.left + 1, y: b.top + b.height / 2 };
});
const validate = flow.locator('.node', { hasText: 'Validate' }).first();
const vb = await validate.boundingBox();
await page.mouse.move(from.x, from.y);
await page.mouse.down();
await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2, { steps: 10 });
await page.mouse.up();
await page.locator('.mdr-toolbar').waitFor();
await page.keyboard.press('c');
const quoted = await page.locator('.mdr-composer blockquote').innerText();
assert.ok(!quoted.includes('{font-family') && !quoted.includes('ChangesAfterBeforeSource'), `quote carries no CSS or chrome: ${quoted.slice(0, 80)}`);
assert.ok(quoted.includes('held') && quoted.includes('Start'), `quote keeps the text and labels: ${quoted.slice(0, 80)}`);
await page.keyboard.press('Escape');
assert.equal(await page.locator('.mdr-composer').count(), 0);

// 14) Links authored in the diagram (`click A "https://…"`) open in a new tab instead of navigating the page;
//     form controls in labels are stripped and unsafe link targets unwrapped.
const urlBefore = page.url();
await page.evaluate(() => {
  window.__opened = [];
  window.open = (u) => { window.__opened.push(String(u)); return null; };
});
const linked = flow.locator('a').first();
assert.equal(await linked.getAttribute('target'), '_blank');
await linked.locator('.node').first().click();
await page.waitForTimeout(200);
assert.equal(page.url(), urlBefore, 'the page did not navigate');
assert.deepEqual(await page.evaluate(() => window.__opened), ['https://example.com/checkout']);
const hardened = await page.evaluate(() =>
  window.__hardenSvg(
    '<svg><a xlink:href="https://x.example/"><text>x</text></a><a href="javascript:alert(1)"><text>js</text></a><a href="docs/other.md"><text>rel</text></a>' +
      '<foreignObject><form action="https://evil.example"><input name="s"><button>Go</button></form><span>kept</span></foreignObject></svg>',
  ),
);
assert.ok(/<a xlink:href="https:\/\/x\.example\/" target="_blank" rel="noopener noreferrer">/.test(hardened), 'absolute link opens in a new tab');
assert.ok(!hardened.includes('javascript:') && hardened.includes('<text>js</text>'), 'javascript: link unwrapped');
assert.ok(/<a href="docs\/other\.md" target="_blank"/.test(hardened), 'relative link kept for the delegated handler');
assert.ok(!/<form|<input|<button/.test(hardened) && hardened.includes('<span>kept</span>'), 'form controls stripped');

// 15) Dark theme re-renders; switching files while diagrams are still rendering must not leave
//     error banners behind (the queued jobs then draw into unmounted wrappers).
await page.evaluate(() => { document.documentElement.dataset.colorMode = 'dark'; });
await page.locator('.mdr-file', { hasText: 'README' }).click();
await page.locator('.mdr-doc h1', { hasText: 'Payments service' }).waitFor();
await page.waitForTimeout(2500);
await page.locator('.mdr-file', { hasText: 'flow.md' }).click();
await page.locator('.mdr-doc h1', { hasText: 'Checkout flow' }).waitFor();
await page.locator('.mdr-mermaid-loading').first().waitFor({ state: 'detached', timeout: 15000 });
await page.locator('.mdr-mermaid-pane svg').nth(1).waitFor({ timeout: 15000 });
assert.equal(await page.locator('.mdr-banner-del').count(), 0, 'no diagram errors after switching files mid-render');
assert.equal(await page.locator('.mdr-mermaid svg').count(), 4, 'merged flowchart, pie and the sequence pair rendered in dark');
await flow.scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await page.screenshot({ path: `${shots}/15-mermaid-dark.png` });
await page.evaluate(() => { document.documentElement.dataset.colorMode = 'light'; });

// 16) A docs-site document: raw HTML, admonitions, a moved section, a re-wrapped paragraph,
//     a table diff, math, emoji, a changed image, footnotes and review checks.
const guide = readFileSync('dev/fixtures/guide-head.md', 'utf8').split('\n');
const gLine = (s) => guide.findIndex((l) => l.includes(s)) + 1;
const guideBase = readFileSync('dev/fixtures/guide-base.md', 'utf8').split('\n');
await page.locator('.mdr-file', { hasText: 'guide.md' }).click();
await page.locator('.mdr-doc h1', { hasText: 'Operator guide' }).waitFor();
const doc = page.locator('.mdr-doc');
assert.equal(await doc.locator('p[align="center"] img[width="96"]').count(), 1, 'raw HTML rendered');
assert.equal(await doc.locator('details summary', { hasText: 'Who is on call?' }).count(), 1, '<details> rendered');
assert.equal(await doc.getByText('<details>').count(), 0, 'no literal HTML tags');
assert.equal((await doc.locator('.markdown-alert-warning .markdown-alert-title').innerText()).trim(), 'Read this first', 'Docusaurus admonition');
assert.equal(await doc.locator('h2.mdr-moved', { hasText: 'Setup' }).count(), 1, 'moved heading');
assert.equal(await doc.locator('p.mdr-moved', { hasText: 'Install the operator CLI' }).count(), 1, 'moved paragraph');
assert.equal(await doc.locator('.mdr-removed-moved').count(), 1, 'one "moved" stub where the section was');
assert.match(await doc.locator('.mdr-removed-moved').innerText(), new RegExp(`moved to\\s*line ${gLine('## Setup')}`));
assert.equal(await doc.locator('p.mdr-reflow', { hasText: 'This guide is for the people' }).count(), 1, 're-wrapped intro is only hinted at');
assert.equal(await doc.locator('.markdown-alert-warning p.mdr-added').count(), 1, 'what replaced the moved section is new');
const stripe = doc.locator('tr', { hasText: 'Stripe' });
assert.match(await stripe.getAttribute('class'), /mdr-mod/);
assert.equal(await stripe.locator('del.mdr-d-del').innerText(), '3');
assert.equal(await stripe.locator('ins.mdr-d-ins').innerText(), '5');
assert.equal(await doc.locator('tr.mdr-removed-row', { hasText: 'Legacy bank' }).count(), 1, 'removed row stays in the table');
assert.match(await doc.locator('tr', { hasText: 'Checkout.com' }).getAttribute('class'), /mdr-added/);
await doc.locator('.mdr-math math').first().waitFor({ timeout: 10000 });
assert.ok((await doc.locator('.mdr-math').count()) >= 3, 'inline and display math rendered');
assert.equal(await doc.locator('.mdr-math-old').count(), 1, 'changed formula shows its old version');
assert.match(await doc.locator('p', { hasText: 'instant payout' }).innerText(), /\$0\.25 plus 1% of the amount, between \$1 and \$10/, 'dollar amounts stay text');
assert.match(await doc.locator('p', { hasText: 'Retry-After' }).innerText(), /🚀/);
assert.equal(await doc.locator('.mdr-img-mod').count(), 1, 'changed image');
assert.equal(await doc.locator('.mdr-img-mod img').count(), 2, 'before and after side by side');
await doc.locator('.mdr-img-mod button', { hasText: /^After$/ }).click();
assert.equal(await doc.locator('.mdr-img-mod img').count(), 1);
await doc.locator('a', { hasText: 'runbook' }).waitFor();
await page.waitForFunction(() => document.getElementById('md-pr-review-root').shadowRoot.querySelectorAll('.mdr-doc a.mdr-broken').length === 2);
const checks = page.locator('.mdr-checks');
const checkText = await checks.innerText();
for (const s of ['runbooks/adapter.md', '#escalation', 'Repeated word “the the”', 'TODO']) assert.ok(checkText.includes(s), `check found: ${s}`);
await page.screenshot({ path: `${shots}/16-guide.png` });
await page.keyboard.press('n');
assert.match(await page.locator('.mdr-nav .mdr-muted').innerText(), /^\d+ \/ \d+$/, 'the counter shows which change is in view');

// 17) Footnote and in-document anchors.
await doc.locator('sup a', { hasText: '1' }).click();
await page.waitForFunction(() => !!document.getElementById('md-pr-review-root').shadowRoot.querySelector('.mdr-flash[id*="fn-1"], li.mdr-flash'));

// 18) Outline: sections with their change markers; clicking one scrolls to it.
const outline = page.locator('.mdr-outline-item');
assert.ok((await outline.count()) >= 7);
assert.equal(await page.locator('.mdr-outline-item', { hasText: 'Setup' }).locator('.mdr-dot-moved').count(), 1);
assert.equal(await page.locator('.mdr-outline-item', { hasText: 'Appendix A' }).locator('.mdr-dot.mdr-dot-changed, .mdr-dot.mdr-dot-added').count(), 0);
await page.locator('.mdr-outline-item', { hasText: 'Limits' }).click();
await page.locator('.mdr-doc h2#limits.mdr-flash').waitFor();

// 19) Changes only: unchanged appendix paragraphs fold away, headings stay.
await page.keyboard.press('f');
await page.locator('.mdr-fold-toggle').first().waitFor();
assert.equal(await doc.getByText('The migration took three months').count(), 0, 'unchanged paragraphs folded');
assert.equal(await doc.locator('h2', { hasText: 'Appendix A' }).count(), 1, 'headings stay');
const firstVersion = gLine('The first version ran as a single process');
const fold = page.locator('.mdr-fold').filter({ has: page.locator('.mdr-fold-toggle') });
const folds = await fold.evaluateAll((els) => els.map((e) => [Number(e.dataset.foldSl), Number(e.dataset.foldEl)]));
const k = folds.findIndex(([a, b]) => a <= firstVersion && firstVersion <= b);
assert.ok(k >= 0, `a fold covers line ${firstVersion}: ${JSON.stringify(folds)}`);
await fold.nth(k).locator('.mdr-fold-toggle').click();
await doc.getByText('The first version ran as a single process').waitFor();
await page.keyboard.press('f');
assert.equal(await page.locator('.mdr-fold').count(), 0);

// 20) Comment on removed text (left side of the diff): a removed table row.
await selectText('tr.mdr-removed-row td', 'Legacy bank');
await page.keyboard.press('c');
assert.match(await page.locator('.mdr-composer-head').innerText(), new RegExp(`line ${guideBase.findIndex((l) => l.includes('Legacy bank')) + 1} \\(before\\)`));
assert.ok(await page.locator('.mdr-composer button', { hasText: 'Suggest change' }).isDisabled(), 'no suggestions on removed text');
await page.locator('.mdr-composer textarea').fill('Why drop the legacy bank?');
await page.locator('.mdr-composer button', { hasText: 'Comment now' }).click();
await page.locator('.mdr-toast-ok', { hasText: 'Comment posted' }).waitFor();
calls = await page.evaluate(() => window.__calls);
const left = calls.filter((c) => c.path.endsWith('/pulls/42/comments')).pop();
assert.equal(left.body.side, 'LEFT');
assert.equal(left.body.line, guideBase.findIndex((l) => l.includes('Legacy bank')) + 1);

// 21) Edit and delete your own comment.
const mine = page.locator('.mdr-thread', { hasText: 'Why drop the legacy bank?' });
await mine.locator('button[aria-label="Edit comment"]').click();
await mine.locator('textarea').fill('Why drop the legacy bank? Who still uses it?');
await mine.locator('button', { hasText: 'Update comment' }).click();
await page.locator('.mdr-thread textarea').waitFor({ state: 'detached' });
await page.locator('.mdr-thread .mdr-comment-body', { hasText: 'Who still uses it?' }).waitFor();
calls = await page.evaluate(() => window.__calls);
assert.ok(calls.some((c) => c.method === 'PATCH' && /\/pulls\/comments\/\d+$/.test(c.path)), 'edit sent');
const mine2 = page.locator('.mdr-thread', { hasText: 'Who still uses it?' });
await mine2.locator('button[aria-label="Delete comment"]').click();
await mine2.locator('.mdr-confirm button', { hasText: 'Delete' }).click();
await page.locator('.mdr-toast-ok', { hasText: 'Comment deleted' }).waitFor();
calls = await page.evaluate(() => window.__calls);
assert.ok(calls.some((c) => c.method === 'DELETE'), 'delete sent');

// 22) The + next to a block comments on all of it (here a table row).
const row = doc.locator('tr', { hasText: 'Checkout.com' });
await row.scrollIntoViewIfNeeded();
await row.hover();
const plus = await page.locator('.mdr-hover-add').boundingBox();
await page.mouse.move(plus.x + plus.width / 2, plus.y + plus.height / 2, { steps: 4 });
await page.waitForTimeout(300);
assert.equal(await page.locator('.mdr-hover-add').count(), 1, 'the + stays while the pointer is on it');
await page.locator('.mdr-hover-add').click();
assert.match(await page.locator('.mdr-composer-head').innerText(), new RegExp(`line ${gLine('Checkout.com')}\\b`));
assert.match(await page.locator('.mdr-composer blockquote').innerText(), /Checkout\.com \| 3 s \| 2/);
await page.locator('.mdr-composer textarea').fill('Is 3 s enough for Checkout.com?');
await page.keyboard.press('Control+Enter');
assert.equal(await page.locator('.mdr-draft', { hasText: 'Checkout.com' }).count(), 1);

// 23) Split view: the old version on the left with the removed row in red, scrolled along.
await page.keyboard.press('2');
await page.locator('.mdr-split-before .mdr-doc').waitFor();
assert.equal(await page.locator('.mdr-split-before tr.mdr-added', { hasText: 'Legacy bank' }).count(), 1, 'removed row marked on the left');
assert.equal(await page.locator('.mdr-split-before h2', { hasText: 'Setup' }).locator('xpath=self::*[contains(@class,"mdr-moved")]').count(), 1, 'moved section marked on the left');
await page.locator('.mdr-split-after').evaluate((el) => (el.scrollTop = 1200));
await page.waitForTimeout(400);
const topLine = (sel) => page.locator(sel).evaluate((pane) => {
  const t = pane.getBoundingClientRect().top + 4;
  for (const b of pane.querySelectorAll('.mdr-doc > [data-sl]')) if (b.getBoundingClientRect().bottom > t) return b.textContent.slice(0, 30);
  return null;
});
const [lt, rt] = [await topLine('.mdr-split-before'), await topLine('.mdr-split-after')];
assert.ok(lt && rt && (lt.slice(0, 12) === rt.slice(0, 12) || lt.startsWith('#') === rt.startsWith('#')), `panes in sync: ${lt} | ${rt}`);
await page.screenshot({ path: `${shots}/17-split.png` });
await page.keyboard.press('1');

// 24) Changes after a commit (the review submitted above was on the head commit, so "since your last review" has nothing new).
await page.locator('.mdr-header .mdr-dropdown button', { hasText: 'All changes' }).click();
await page.locator('.mdr-menu-note', { hasText: 'No new commits since your last review' }).waitFor();
await page.locator('.mdr-menu-item', { hasText: 'Move setup below usage' }).click();
await page.locator('.mdr-header .mdr-dropdown button', { hasText: 'Since c2sha' }).waitFor();
await page.waitForFunction(() => document.getElementById('md-pr-review-root').shadowRoot.querySelectorAll('.mdr-doc .mdr-mod, .mdr-doc .mdr-added').length > 0);
assert.equal(await doc.locator('tr.mdr-removed-row').count(), 0, 'only the newer changes are marked');
assert.match(await doc.locator('tr', { hasText: 'Stripe' }).locator('del').innerText(), /4/);
assert.equal(await page.locator('.mdr-file.mdr-file-same').count(), 4, 'the other files have no new changes');
await page.locator('.mdr-file', { hasText: 'architecture' }).click();
await page.locator('.mdr-banner-info', { hasText: 'No changes to this file since c2sha' }).waitFor();
await page.locator('.mdr-header .mdr-dropdown button', { hasText: 'Since c2sha' }).click();
await page.locator('.mdr-menu-item', { hasText: 'All changes' }).click();
await page.locator('.mdr-banner-info').waitFor({ state: 'detached' });

// 25) Help.
await page.keyboard.press('?');
await page.locator('.mdr-help').waitFor();
await page.keyboard.press('Escape');
assert.equal(await page.locator('.mdr-help').count(), 0);
assert.equal(await page.locator('.mdr-overlay').count(), 1);

assert.deepEqual(errors, [], 'no console errors');
console.log('E2E OK –', calls.length, 'write calls recorded, no console errors');
await browser.close();
