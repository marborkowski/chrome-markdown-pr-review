import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownDoc, type MarkdownDocProps } from '../src/content/components/MarkdownDoc';
import { parseMarkdown, verbatimLines } from '../src/content/lib/outline';
import { diffTexts, isReflow, parsePatch, presentDiff } from '../src/content/lib/patch';

const fx = (f: string) => readFileSync(new URL(`../dev/fixtures/${f}`, import.meta.url), 'utf8');
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
const withDiff = (oldSrc: string, newSrc: string, extra: Partial<MarkdownDocProps> = {}) =>
  render(newSrc, { diff: parsePatch(diffTexts(oldSrc, newSrc)!), inlineDiff: true, ...extra });

describe('whitespace-only changes', () => {
  it('never hides a change inside a code block whose fence lines are unchanged context', () => {
    const oldDoc = '# T\n\n```py\nx = 1\na = 1  # two spaces\nb = 2\n```\n\nText.\n';
    const newDoc = '# T\n\n```py\nx = 1\na = 1 # two spaces\nb = 2\n```\n\nText.\n';
    const diff = parsePatch(diffTexts(oldDoc, newDoc)!);
    expect(diff.removals[0].reflow).toBe(true); // from the lines alone it looks like one
    const shown = presentDiff(diff, true, verbatimLines(parseMarkdown(newDoc)));
    expect(shown.removals).toHaveLength(1);
    expect(shown.reflowed).toEqual([]);
    expect([...shown.added]).toEqual([5]);
    // Re-indenting code is a change too, even from the lines alone.
    expect(isReflow(['  port: 80', '  host: x'], ['port: 80', 'host: x'])).toBe(false);
  });
  it('covers fenced and indented code, HTML and front matter', () => {
    const lines = verbatimLines(parseMarkdown('---\na: 1\n---\n\nText\n\n    indented code\n\n<div>\n  html\n</div>\n\n```\nfenced\n```\n'));
    expect([...lines].sort((a, b) => a - b)).toEqual([1, 2, 3, 7, 9, 10, 11, 13, 14, 15]);
  });
  it('treats a paragraph leaving its list item as a change', () => {
    expect(isReflow(['- item', '', '  more'], ['- item', '', 'more'])).toBe(false);
    expect(isReflow(['- item', '', '  more text here'], ['- item', '', '  more text', '  here'])).toBe(true);
  });
  it('keeps the start number of an ordered list significant, but not the renumbering after an insert', () => {
    expect(isReflow(['1. one', '2. two'], ['5. one', '6. two'])).toBe(false);
    expect(isReflow(['2. two', '3. three'], ['3. two', '4. three'], true)).toBe(true);
    const d = parsePatch('@@ -1,3 +1,4 @@\n 1. one\n-2. two\n-3. three\n+2. new\n+3. two\n+4. three\n');
    expect(d.removals[0].reflow).toBeUndefined(); // "2. new" is real content
    const e = parsePatch('@@ -1,3 +1,3 @@\n 1. one\n-2. two\n-3. three\n+5. two\n+6. three\n');
    expect(e.removals[0].reflow).toBe(true);
  });
});

describe('diffTexts', () => {
  it('gives up on two long, unrelated files instead of freezing', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `alpha ${i * 7919} ${i % 13}`).join('\n');
    const b = Array.from({ length: 3000 }, (_, i) => `beta ${i * 104729} ${i % 17}`).join('\n');
    expect(diffTexts(a, b, 1)).toBeNull();
    expect(diffTexts('a\nb\n', 'a\nc\n', 1000)).toMatch(/^@@/);
  });
});

describe('callout kinds', () => {
  it('ignores admonition types that are only Object prototype members', () => {
    expect(render(':::constructor\nx\n:::\n')).toContain(':::constructor');
    expect(render('!!! constructor "T"\n\n    body\n')).not.toContain('markdown-alert');
    expect(render('<div data-callout="constructor">x</div>\n')).not.toContain('markdown-alert');
  });
});

describe('dollar amounts', () => {
  it('keep the Markdown between them rendered', () => {
    const html = render('Pay $5 for [the plan](https://x.y) or **only** $10 today.\n');
    expect(html).toMatch(/<a [^>]*href="https:\/\/x\.y"[^>]*>the plan<\/a>/);
    expect(html).toContain('<strong data-sl="1" data-el="1">only</strong>');
    expect(html).toContain('Pay $5 for ');
    expect(html).toContain(' $10 today.');
    expect(html).not.toContain('language-math');
  });
  it('keeps positions of the re-parsed text right', () => {
    const html = render('Intro\n\nPay $5 or **more** $10 for `x`.\n');
    expect(html).toContain('<strong data-sl="3" data-el="3">more</strong>');
    expect(html).toContain('<code data-sl="3" data-el="3">x</code>');
  });
});

describe('removed table rows', () => {
  const table = '| A | B |\n|---|---|\n| one | 1 |\n| two | 2 |\n';
  it('does not turn deleted prose with a pipe in it into a row', () => {
    const html = withDiff(`${table}\nRun \`cat x | grep y\` to filter.\n\nAfter.\n`, `${table}\nAfter.\n`);
    expect(html).not.toContain('mdr-removed-row');
    expect(html).toMatch(/mdr-removed"[\s\S]*grep y/);
  });
  it('does not put lines deleted before a table above its header', () => {
    const html = withDiff(`| x | y |\n\nIntro\n\n${table}`, `Intro\n\n${table}`);
    expect(html).not.toMatch(/<thead[^>]*><tr class="mdr-removed-row"/);
  });
  it('still keeps rows deleted from the middle and the end of a table', () => {
    const middle = withDiff(table, table.replace('| one | 1 |\n', ''));
    expect(middle).toMatch(/<tbody[^>]*><tr class="mdr-removed-row"[\s\S]*?one[\s\S]*?<\/tr><tr[^>]*>[\s\S]*?two/);
    const end = withDiff(table, table.replace('| two | 2 |\n', ''));
    expect(end).toMatch(/one[\s\S]*<tr class="mdr-removed-row"[\s\S]*two[\s\S]*<\/tbody>/);
  });
});

describe('moved section shown as one block', () => {
  it('lists the merged pieces so the "moved" badge can find the block', () => {
    const html = render(fx('guide-head.md'), { diff: parsePatch(fx('guide.patch')), inlineDiff: true });
    expect(html).toMatch(/<div class="mdr-removed mdr-removed-moved" data-removal="\d+" data-removal-more="\d+"/);
  });
});
