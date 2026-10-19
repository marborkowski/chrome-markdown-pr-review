import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownDoc, type MarkdownDocProps } from '../src/content/components/MarkdownDoc';
import { parsePatch } from '../src/content/lib/patch';

const render = (source: string, extra: Partial<MarkdownDocProps> = {}) =>
  renderToStaticMarkup(
    createElement(MarkdownDoc, {
      source,
      diff: null,
      threadLines: [],
      pendingLines: [],
      activeRange: null,
      inlineDiff: false,
      resolveUrl: (u) => u,
      onBadge: () => {},
      onMods: () => {},
      ...extra,
    }),
  );

describe('MarkdownDoc', () => {
  const doc = 'Intro\n\n---\n\nOutro\n';

  it('renders a thematic break (void <hr>) without crashing', () => {
    const html = render(doc);
    expect(html).toMatch(/<hr[^>]*data-sl="3"[^>]*\/>/);
    expect(html).toContain('Outro');
  });

  it('shows gutter badges for an <hr> that has threads', () => {
    const html = render(doc, { threadLines: [3] });
    expect(html).toMatch(/<hr[^>]*\/><span class="mdr-gutter"/);
  });

  it('renders a replaced <hr> as a word diff in inline mode', () => {
    const diff = parsePatch('@@ -1,5 +1,5 @@\n Intro\n \n----\n+***\n \n Outro\n');
    const html = render('Intro\n\n***\n\nOutro\n', { diff, inlineDiff: true });
    expect(html).toContain('mdr-worddiff');
    expect(html).toContain('Outro');
  });
});

/** Build a single-hunk patch from old and new text (whole file as context). */
function patchOf(oldSrc: string, newSrc: string) {
  const a = oldSrc.split('\n');
  const b = newSrc.split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let post = 0;
  while (post < a.length - pre && post < b.length - pre && a[a.length - 1 - post] === b[b.length - 1 - post]) post++;
  const body = [
    ...a.slice(0, pre).map((l) => ' ' + l),
    ...a.slice(pre, a.length - post).map((l) => '-' + l),
    ...b.slice(pre, b.length - post).map((l) => '+' + l),
    ...a.slice(a.length - post).map((l) => ' ' + l),
  ];
  return parsePatch(`@@ -1,${a.length} +1,${b.length} @@\n${body.join('\n')}`);
}

const inline = (oldSrc: string, newSrc: string) => render(newSrc, { diff: patchOf(oldSrc, newSrc), inlineDiff: true });
const strip = (html: string) => html.replace(/<[^>]+>/g, '');

describe('inline word diff', () => {
  it('keeps the unchanged lines of a changed list item (GitHub diff vs. rendered diff)', () => {
    const before = [
      '- `DisabledActionTooltip.tsx`: shows a disabled action\'s reason on hover, focus',
      '  and tap. Used by Manage Permissions only.',
      '- `messages.ts`: level, Create and Manage Permissions labels used by both',
      '  dialogs, and the No access summaries, which only Manage Permissions shows.',
      '- `types.ts`: `PermissionLevel`, categories and the editor\'s props.',
    ].join('\n');
    const after = before.replace('dialogs, and the No access summaries, which only Manage Permissions shows.', 'dialogs.');
    const html = inline(before, after);
    const item = /<li[^>]*mdr-inline[^>]*>([\s\S]*?)<\/li>/.exec(html)![1];
    expect(strip(item)).toContain('messages.ts: level, Create and Manage Permissions labels used by both dialogs');
    expect(item).toContain('<code>messages.ts</code>'); // still rendered as Markdown, not raw backticks
    expect(item).toMatch(/<del class="mdr-d-del">[^<]*No access summaries/);
    expect(strip(html)).toContain('DisabledActionTooltip.tsx: shows');
    expect(strip(html)).toContain('types.ts: PermissionLevel');
  });

  it('keeps the unchanged lines of a changed code block', () => {
    const before = '```js\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```';
    const html = inline(before, before.replace('b = 2', 'b = 20'));
    expect(strip(html)).toContain('const a = 1;');
    expect(strip(html)).toContain('const c = 3;');
    expect(strip(html)).not.toContain('```');
    expect(html).toMatch(/<ins class="mdr-d-ins">[^<]*20/);
  });

  it('keeps a nested list the change does not reach rendered as a list', () => {
    const before = '- Parent item text\n  - child one\n  - child two';
    const html = inline(before, before.replace('Parent item', 'Parent entry'));
    expect(html).toMatch(/<ul[^>]*>\s*<li[^>]*>child one/);
    expect(html).toMatch(/<del class="mdr-d-del">item<\/del>/);
  });

  it('shows lines removed from the middle of a paragraph inline', () => {
    const before = 'First line\nsecond line\nthird line';
    const html = inline(before, 'First line\nthird line');
    expect(html).toMatch(/<del class="mdr-d-del">[^<]*second line/);
    expect(strip(html)).toContain('third line');
  });

  const items = (html: string) => [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1]);

  it('gives each list item of a change spanning several items its own part of the word diff', () => {
    const before = '1. Intro item.\n2. The gateway validates the request.\n3. The adapter calls the network.\n4. Outro item.';
    const after = before.replace('validates the request', 'validates and signs the request').replace('calls the network', 'calls the card network');
    const html = inline(before, after);
    const li = items(html);
    expect(li).toHaveLength(4);
    expect(strip(li[1])).toBe('The gateway validates and signs the request.');
    expect(li[1]).toMatch(/<ins class="mdr-d-ins">[^<]*signs/);
    expect(strip(li[2])).toBe('The adapter calls the card network.');
    expect(li[2]).toMatch(/<ins class="mdr-d-ins">[^<]*card/);
    expect(strip(li[0])).toBe('Intro item.');
    expect(strip(li[3])).toBe('Outro item.');
  });

  it('shows removed words in the list item they were removed from', () => {
    const before = '- Keep the ledger as the single source of truth.\n- Support retries without double charging.';
    const html = inline(before, '- Keep the ledger as the source of truth.\n- Support retries.');
    const li = items(html);
    expect(li).toHaveLength(2);
    expect(li[0]).toMatch(/<del class="mdr-d-del">[^<]*single/);
    expect(li[0]).not.toContain('charging');
    expect(li[1]).toMatch(/<del class="mdr-d-del">[^<]*double charging/);
    expect(li[1]).not.toContain('single');
  });

  it('keeps an inserted item separate from the item it was inserted before', () => {
    const before = '1. Create the intent.\n2. Call the card network.';
    const after = '1. Create the intent.\n2. Score the intent for fraud.\n3. Call the card network.';
    const li = items(inline(before, after));
    expect(li).toHaveLength(3);
    expect(strip(li[1])).toBe('Score the intent for fraud.');
    expect(strip(li[2])).toBe('Call the card network.');
    expect(li[2]).not.toMatch(/mdr-d-(ins|del)/);
  });

  it('gives each of several changed paragraphs its own word diff', () => {
    const before = 'The first paragraph is short.\n\nThe second one is short too.';
    const html = inline(before, 'The first paragraph is longer now.\n\nThe second one is longer too.');
    const ps = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
    expect(ps).toHaveLength(2);
    expect(strip(ps[0])).toBe('The first paragraph is shortlonger now.');
    expect(strip(ps[1])).toBe('The second one is shortlonger too.');
  });

  it('still folds a change into the first block when the blocks are of different kinds', () => {
    const before = 'The adapter is synchronous.';
    const html = inline(before, 'The adapter is asynchronous.\n\n```js\npublish(event);\n```');
    expect(html).not.toContain('<pre');
    expect(strip(html)).toContain('publish(event);');
  });

  it('marks formatting changes without breaking the surrounding code spans', () => {
    const before = '`applyPermissionChange` applies one intention (`level`, `create`, `clear`, `manage`).';
    const html = inline(before, before.replace('`clear`, ', ''));
    expect(html).toContain('<code>applyPermissionChange</code>');
    expect(html).toContain('<code><del class="mdr-d-del">clear</del></code><del class="mdr-d-del">, </del><code>manage</code>');
    expect(html).toContain('<code>manage</code>');
  });
});

describe('GitHub flavoured extras', () => {
  it('renders alerts like GitHub', () => {
    const html = render('> [!WARNING]\n> Rotating the key logs everyone out.\n');
    expect(html).toContain('markdown-alert markdown-alert-warning');
    expect(html).toMatch(/markdown-alert-title[^>]*><svg[\s\S]*?<\/svg>Warning<\/p>/);
    expect(html).not.toContain('[!WARNING]');
    expect(html).toContain('Rotating the key');
  });

  it('leaves ordinary quotes alone', () => {
    expect(render('> [!NOTE] inline is not an alert\n')).not.toContain('markdown-alert');
  });

  it('gives headings GitHub-style ids', () => {
    const html = render('# Payments: API & Webhooks\n\n## Goals\n\n## Goals\n');
    expect(html).toContain('id="payments-api--webhooks"');
    expect(html).toContain('id="goals"');
    expect(html).toContain('id="goals-1"');
  });

  it('opens in-document links in place and other links in a new tab', () => {
    const html = render('[Goals](#goals) and [docs](https://example.com)\n');
    expect(html).toMatch(/<a [^>]*href="#goals">Goals<\/a>/);
    expect(html).not.toMatch(/href="#goals"[^>]*target/);
    expect(html).toMatch(/<a [^>]*href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">docs<\/a>/);
  });
});
