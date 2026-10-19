import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { findPhrase, buildBody } from '../src/content/components/Composer';
import { MarkdownDoc, type MarkdownDocProps } from '../src/content/components/MarkdownDoc';
import { buildThreads } from '../src/content/components/Threads';
import { lineLabel, locateRemoved, resolveAnchor } from '../src/content/lib/anchor';
import { anchorsOf, repoTarget, runChecks } from '../src/content/lib/checks';
import { outlineOf, parseMarkdown } from '../src/content/lib/outline';
import { diffTexts, parsePatch } from '../src/content/lib/patch';
import { isDelimiterRow, pairRows, splitRow } from '../src/content/lib/tables';
import type { ReviewComment } from '../src/content/types';

const fx = (f: string) => readFileSync(new URL(`../dev/fixtures/${f}`, import.meta.url), 'utf8');

describe('checks', () => {
  const guide = fx('guide-head.md');
  const lines = guide.split('\n');
  const at = (s: string) => lines.findIndex((l) => l.includes(s)) + 1;
  const diff = parsePatch(fx('guide.patch'));
  const paths = new Set(['docs/guide.md', 'docs/img/flow.png', 'docs/img/logo.png', 'docs', 'docs/img']);
  const findings = runChecks({ tree: parseMarkdown(guide), path: 'docs/guide.md', diff, paths });
  const kinds = (k: string) => findings.filter((f) => f.kind === k);

  it('finds broken links and anchors, with the URL as written', () => {
    expect(kinds('file')).toMatchObject([{ line: at('[runbook]'), url: 'runbooks/adapter.md', changed: true, severity: 'error' }]);
    expect(kinds('anchor')).toMatchObject([{ line: at('[runbook]'), url: '#escalation' }]);
  });
  it('finds repeated words and placeholders in the text, not in code', () => {
    expect(kinds('repeat').map((f) => f.message)).toEqual(['Repeated word “the the”']);
    expect(kinds('todo')).toMatchObject([{ line: at('TODO: link'), severity: 'info' }]);
  });
  it('knows which findings are on lines the PR changed', () => {
    const old = runChecks({ tree: parseMarkdown('# A\n\nSee [x](#nope).\n'), path: 'a.md', diff: parsePatch('') });
    expect(old).toMatchObject([{ kind: 'anchor', changed: false }]);
  });
  it('checks images, headings, unrendered syntax and HTML GitHub strips', () => {
    const src = '# A\n\n#### Deep\n\n![](pic.png)\n\nA [broken link](has space.md) here and **unpaired.\n\n<center>Hi</center>\n\n<img src="a.png" style="width:1px">\n';
    const f = runChecks({ tree: parseMarkdown(src), path: 'a.md', diff: parsePatch(diffTexts('', src)), paths: new Set(['a.png']) });
    const msgs = f.map((x) => `${x.kind}: ${x.message}`);
    expect(msgs).toContain('heading: Heading level jumps from H1 to H4');
    expect(msgs).toContain("image: Image “pic.png” doesn't exist in this branch");
    expect(msgs.some((m) => m.startsWith('alt:'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('syntax: Link syntax'))).toBe(true);
    expect(msgs).toContain("html: GitHub doesn't render <center> (it is stripped from the page)");
    expect(msgs).toContain('html: GitHub drops the style="…" attribute of <img>');
    expect(msgs.some((m) => /drops the src=/.test(m))).toBe(false);
  });
  it('checks anchors in other loaded files of the PR', () => {
    const f = runChecks({
      tree: parseMarkdown('See [goals](other.md#goals) and [x](other.md#missing).\n'),
      path: 'docs/a.md',
      diff: null,
      anchorsIn: new Map([['docs/other.md', anchorsOf(parseMarkdown('# Goals\n'))]]),
    });
    expect(f.map((x) => x.message)).toEqual(['No heading “#missing” in docs/other.md']);
  });
  it('resolves link targets like GitHub does', () => {
    expect(repoTarget('docs/guide.md', '../README.md#top')).toEqual({ path: 'README.md', hash: 'top' });
    expect(repoTarget('docs/guide.md', '/src/a%20b.ts?plain=1')).toEqual({ path: 'src/a b.ts', hash: '' });
    expect(repoTarget('docs/guide.md', 'https://x.org')).toBeNull();
    expect(repoTarget('docs/guide.md', '#x')).toBeNull();
  });
  it('collects heading, footnote and HTML anchors', () => {
    const ids = anchorsOf(parseMarkdown('# Hello World\n\nText[^n]\n\n<a name="legacy"></a>\n\n[^n]: Note\n'));
    expect([...ids]).toEqual(expect.arrayContaining(['hello-world', 'fn-n', 'legacy']));
  });
});

describe('outline', () => {
  const guide = fx('guide-head.md');
  const lines = guide.split('\n');
  const diff = parsePatch(fx('guide.patch'));
  const items = outlineOf(parseMarkdown(guide), lines, diff, [lines.findIndex((l) => l.includes('| Stripe')) + 1]);
  const by = (t: string) => items.find((i) => i.text === t)!;
  it('lists headings with GitHub ids and their line ranges', () => {
    expect(items.map((i) => i.text)).toEqual(['Operator guide', 'Usage', 'Setup', 'Limits', 'Incidents', 'Glossary', 'Appendix A', 'Appendix B']);
    expect(by('Appendix A')).toMatchObject({ id: 'appendix-a', depth: 2 });
    expect(by('Usage').end).toBe(by('Setup').line - 1);
  });
  it('tells changed, moved and untouched sections apart, and counts comments', () => {
    expect(by('Usage')).toMatchObject({ change: 'changed', comments: 1 });
    expect(by('Setup').change).toBe('moved');
    expect(by('Glossary').change).toBeNull();
    expect(by('Appendix A').change).toBeNull();
  });
});

describe('comments on removed text', () => {
  const d = parsePatch('@@ -1,4 +1,3 @@\n # T\n-Old words are here.\n+New words.\n \n-Gone paragraph.\n');
  it('anchors left-side comments to the base file\'s hunks', () => {
    expect(resolveAnchor(d, 2, 2, 'LEFT')).toMatchObject({ kind: 'line', side: 'LEFT', start: 2, end: 2 });
    expect(resolveAnchor(d, 9, 9, 'LEFT')).toMatchObject({ kind: 'file', side: 'LEFT' });
  });
  it('locates deleted words of a word diff in the base file', () => {
    expect(locateRemoved(d.removals, 2, 2, 'Old words')).toEqual({ start: 2, end: 2 });
    expect(locateRemoved(d.removals, 2, 2, 'Gone paragraph')).toEqual({ start: 4, end: 4 });
    expect(locateRemoved(d.removals, 2, 2, 'nothing like it')).toBeNull();
  });
  it('labels lines of the previous version', () => {
    expect(lineLabel(3, 5, 'LEFT')).toBe('lines 3–5 (before)');
    expect(lineLabel(0, 0)).toBe('whole file');
  });
  it('builds threads for left-side comments with their base lines', () => {
    const c = (id: number, extra: Partial<ReviewComment>): ReviewComment => ({
      id, node_id: `n${id}`, path: 'a.md', body: 'x', user: { login: 'u', avatar_url: '' }, created_at: '', html_url: '',
      line: 3, start_line: null, original_line: 3, side: 'RIGHT', commit_id: 'h', ...extra,
    });
    const t = buildThreads([c(1, { side: 'LEFT', line: 7, start_line: 6 }), c(2, { line: null }), c(3, {})], 'a.md');
    expect(t.map((x) => [x.root.id, x.kind, x.start, x.end])).toEqual([[3, 'line', 3, 3], [1, 'left', 6, 7], [2, 'outdated', null, null]]);
  });
});

describe('composer helpers', () => {
  it('finds the selected words in a suggestion, tolerating re-wrapped whitespace', () => {
    expect(findPhrase('one two\nthree four', 'two three')).toEqual([4, 13]);
    expect(findPhrase('a (b) c', '(b)')).toEqual([2, 5]);
    expect(findPhrase('abc', 'zzz')).toBeNull();
  });
  it('labels file comments on old lines and whole-file comments', () => {
    expect(buildBody('Hi', '', false, { kind: 'file', side: 'LEFT', start: 2, end: 3, reason: '' })).toBe('_Lines 2–3 of the previous version:_\n\nHi');
    expect(buildBody('Hi', '', false, { kind: 'file', side: 'RIGHT', start: 0, end: 0, reason: '' })).toBe('Hi');
  });
});

describe('tables helpers', () => {
  it('splits rows into cells, keeping escaped pipes', () => {
    expect(splitRow('| a | b \\| c | `x` |')).toEqual(['a', 'b \\| c', '`x`']);
    expect(splitRow('a | b')).toEqual(['a', 'b']);
    expect(isDelimiterRow('|:---|--:|')).toBe(true);
    expect(isDelimiterRow('| a | b |')).toBe(false);
  });
  it('pairs edited rows and leaves new ones unpaired', () => {
    expect(pairRows(['| Stripe | 3 s |', '| Legacy | 10 s |'], ['| Stripe | 5 s |', '| Checkout | 3 s |'])).toEqual([0, -1]);
  });
});

describe('MDX', () => {
  const render = (source: string, extra: Partial<MarkdownDocProps> = {}) =>
    renderToStaticMarkup(createElement(MarkdownDoc, { source, diff: null, threadLines: [], pendingLines: [], activeRange: null, inlineDiff: false, resolveUrl: (u) => u, onBadge: () => {}, onMods: () => {}, ...extra }));
  it('shows import / export lines of .mdx files as code', () => {
    const src = "import Tabs from '@theme/Tabs';\nexport const x = 1;\n\n# Title\n\nimport is a word here.\n";
    const html = render(src, { mdx: true });
    expect(html).toMatch(/<pre data-frontmatter=""[^>]*><code class="language-js">import Tabs/);
    expect(html).toContain('<p data-sl="6" data-el="6" data-block="">import is a word here.</p>');
    expect(render(src)).not.toContain('data-frontmatter');
  });
});
