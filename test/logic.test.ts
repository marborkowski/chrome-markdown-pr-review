import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkRehype from 'remark-rehype';
import type { Element, Root } from 'hast';
import { visit } from 'unist-util-visit';
import { parsePatch } from '../src/content/lib/patch';
import { narrowLines, resolveAnchor } from '../src/content/lib/anchor';
import { rehypeAnnotate } from '../src/content/lib/annotate';

const fx = (f: string) => readFileSync(new URL(`../dev/fixtures/${f}`, import.meta.url), 'utf8');
const head = fx('head.md');
const lines = head.split('\n');
const lineOf = (needle: string) => lines.findIndex((l) => l.includes(needle)) + 1;

describe('parsePatch', () => {
  const d = parsePatch(fx('modified.patch'));

  it('finds added lines in head numbering', () => {
    expect(d.added.has(lineOf('status: draft'))).toBe(true);
    expect(d.added.has(lineOf('fraud service scores'))).toBe(true);
    expect(d.added.has(lineOf('Keep the ledger'))).toBe(false);
    expect(d.additions).toBe(22);
    expect(d.deletions).toBe(14);
  });

  it('pairs removals with their replacements', () => {
    const r = d.removals.find((x) => x.lines[0].includes('300 ms'))!;
    expect(r.replacedBy).toEqual({ start: lineOf('250 ms'), end: lineOf('250 ms') });
    const legacy = d.removals.find((x) => x.lines.some((l) => l.includes('Legacy batch')))!;
    expect(legacy.lines).toHaveLength(6);
    expect(legacy.replacedBy).toEqual({ start: lineOf('30 days'), end: lineOf('outbox') });
  });

  it('collects hunk ranges (U1 → several hunks)', () => {
    const u1 = parsePatch(fx('modified-u1.patch'));
    expect(u1.hunks.length).toBe(7);
    expect(u1.hunks[0]).toEqual({ start: 3, end: 5 });
    expect(u1.hunks[u1.hunks.length - 1].end).toBe(lines.length - 1 /* trailing newline */);
  });
});

describe('resolveAnchor', () => {
  const u1 = parsePatch(fx('modified-u1.patch'));
  it('keeps a range inside a hunk', () => {
    const l = lineOf('fraud service scores');
    expect(resolveAnchor(u1, l, l)).toMatchObject({ kind: 'line', start: l, end: l, clamped: false });
  });
  it('clamps a range that sticks out of a hunk', () => {
    const a = resolveAnchor(u1, 1, 4);
    expect(a).toMatchObject({ kind: 'line', start: 3, end: 4, clamped: true });
  });
  it('falls back to a file comment outside hunks', () => {
    const l = lineOf('# Payments service architecture');
    expect(resolveAnchor(u1, l, l).kind).toBe('file');
    expect(resolveAnchor(null, 1, 1).kind).toBe('file');
  });
});

describe('narrowLines', () => {
  it('narrows a selection inside a multi-line paragraph', () => {
    const sl = lineOf('The adapter is **asynchronous**');
    const r = narrowLines(lines, sl, sl + 1, 'response is correlated');
    expect(r).toEqual({ start: sl + 1, end: sl + 1 });
  });
  it('ignores markdown syntax (bold, code, links)', () => {
    const sl = lineOf('The adapter is **asynchronous**');
    const r = narrowLines(lines, sl, sl + 1, 'asynchronous: it publishes a ProviderRequested event and the response');
    expect(r).toEqual({ start: sl, end: sl + 1 });
  });
  it('falls back to the whole region when nothing matches', () => {
    expect(narrowLines(lines, 10, 12, 'zzz qqq')).toEqual({ start: 10, end: 12 });
  });
});

describe('rehypeAnnotate', () => {
  const diff = parsePatch(fx('modified.patch'));
  const run = (threadLines: number[] = []) => {
    const proc = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkFrontmatter)
      .use(remarkRehype)
      .use(rehypeAnnotate, { diff, lines, threadLines, pendingLines: [], activeRange: null });
    return proc.runSync(proc.parse(head)) as Root;
  };
  const find = (tree: Root, pred: (e: Element) => boolean) => {
    const out: Element[] = [];
    visit(tree, 'element', (e: Element) => { if (pred(e)) out.push(e); });
    return out;
  };
  const text = (e: Element): string => e.children.map((c: any) => (c.type === 'text' ? c.value : c.children ? text(c) : '')).join('');
  const cls = (e: Element) => (e.properties.className as string[] | undefined) ?? [];

  it('marks only the changed list item, not the whole list', () => {
    const tree = run();
    const items = find(tree, (e) => e.tagName === 'li');
    const changed = items.filter((e) => cls(e).includes('mdr-added')).map(text);
    expect(changed.some((t) => t.includes('idempotency keys supplied'))).toBe(true);
    expect(changed.some((t) => t.includes('Keep the ledger'))).toBe(false);
    const lists = find(tree, (e) => e.tagName === 'ul' && cls(e).includes('mdr-added'));
    expect(lists).toHaveLength(0);
  });

  it('attaches replacements as modifications to the right block', () => {
    const tree = run();
    const mods = find(tree, (e) => e.properties.dataMods !== undefined);
    const p = mods.find((e) => e.tagName === 'p' && text(e).includes('wallet transactions'));
    expect(p).toBeTruthy();
    const tr = mods.find((e) => e.tagName === 'tr');
    expect(tr && text(tr)).toContain('30 days');
  });

  it('places thread markers on the owning block', () => {
    const tree = run([lineOf('fraud service scores')]);
    const owners = find(tree, (e) => e.properties.dataThreads !== undefined);
    expect(owners).toHaveLength(1);
    expect(owners[0].tagName).toBe('li');
    expect(text(owners[0])).toContain('fraud service');
  });

  it('inserts standalone removed blocks for pure deletions', () => {
    const base = fx('base.md');
    const patch = `@@ -1,3 +1,1 @@\n # Title\n-\n-Old paragraph.\n`;
    const d = parsePatch(patch);
    expect(d.removals[0]).toMatchObject({ anchor: 2, lines: ['', 'Old paragraph.'] });
    const src = '# Title\n';
    const proc = unified().use(remarkParse).use(remarkRehype)
      .use(rehypeAnnotate, { diff: d, lines: src.split('\n'), threadLines: [], pendingLines: [], activeRange: null });
    const tree = proc.runSync(proc.parse(src)) as Root;
    expect(find(tree, (e) => e.properties.dataRemoval !== undefined)).toHaveLength(1);
    expect(base.length).toBeGreaterThan(0);
  });
});

import { cleanForInline } from '../src/content/components/MarkdownDoc';
describe('cleanForInline', () => {
  it('strips list markers and joins soft-wrapped lines', () => {
    expect(cleanForInline('li', '- Support retries\n  without charging.\n- Make events.')).toBe('Support retries without charging.\nMake events.');
    expect(cleanForInline('li', '3. [x] Done')).toBe('Done');
  });
  it('strips heading hashes and quote markers, collapses soft breaks', () => {
    expect(cleanForInline('h2', '## Storage ##')).toBe('Storage');
    expect(cleanForInline('p', 'one\ntwo\n\nthree')).toBe('one two\n\nthree');
    expect(cleanForInline('blockquote', '> a\n> b')).toBe('a b');
  });
  it('drops code fences (the <pre> element shows the code) but keeps front matter delimiters', () => {
    expect(cleanForInline('pre', '```js\nx\ny\n```')).toBe('x\ny');
    expect(cleanForInline('pre', 'x\ny')).toBe('x\ny');
    expect(cleanForInline('pre', '---\ntitle: a\n---')).toBe('---\ntitle: a\n---');
  });
});

import { buildThreads } from '../src/content/components/Threads';
import { needsReviewCall, submitBlocker } from '../src/content/components/SubmitReview';
import { blockDiffSource } from '../src/content/lib/inlineDiff';
import type { ReviewComment } from '../src/content/types';

describe('buildThreads', () => {
  const c = (id: number, extra: Partial<ReviewComment> = {}): ReviewComment => ({
    id, node_id: `n${id}`, path: 'a.md', body: 'x', user: { login: 'u', avatar_url: '' }, created_at: '', html_url: '',
    line: 3, start_line: null, original_line: 3, side: 'RIGHT', commit_id: 'h', ...extra,
  });

  it('attaches resolved state and thread ids from GraphQL', () => {
    const threads = buildThreads([c(1), c(2, { in_reply_to_id: 1 }), c(3, { line: 9 })], 'a.md', new Map([[1, { id: 'T1', resolved: true }]]));
    expect(threads.map((t) => [t.root.id, t.resolved, t.threadId, t.replies.length])).toEqual([[1, true, 'T1', 1], [3, false, undefined, 0]]);
  });
});

describe('review submission', () => {
  it('skips the review call for a plain comment with only file-level drafts', () => {
    expect(needsReviewCall('COMMENT', '', 0)).toBe(false);
    expect(needsReviewCall('COMMENT', 'Summary', 0)).toBe(true);
    expect(needsReviewCall('COMMENT', '', 2)).toBe(true);
    expect(needsReviewCall('APPROVE', '', 0)).toBe(true);
  });

  it('explains what is missing', () => {
    expect(submitBlocker('APPROVE', '', 0, 0)).toBeNull();
    expect(submitBlocker('COMMENT', '', 0, 0)).toMatch(/summary/);
    expect(submitBlocker('COMMENT', '', 0, 1)).toBeNull(); // file-level drafts only
    expect(submitBlocker('REQUEST_CHANGES', '', 0, 1)).toMatch(/request changes/);
    expect(submitBlocker('REQUEST_CHANGES', '', 1, 1)).toBeNull();
  });
});

describe('blockDiffSource', () => {
  const lines = ['- item one', '  continues here', '- item two'];
  it('swaps changed lines back and keeps the unchanged ones on both sides', () => {
    const r = blockDiffSource(lines, [{ anchor: 2, lines: ['  continued there'], replacedBy: { start: 2, end: 2 } }], 1, 2);
    expect(r.oldText).toBe('- item one\n  continued there');
    expect(r.newText).toBe('- item one\n  continues here');
    expect([...r.used]).toEqual([0]);
  });
  it('puts lines removed inside the block back in the old version', () => {
    const r = blockDiffSource(lines, [{ anchor: 2, lines: ['  gone'] }], 1, 2);
    expect(r.oldText).toBe('- item one\n  gone\n  continues here');
    expect(r.newText).toBe('- item one\n  continues here');
  });
});
