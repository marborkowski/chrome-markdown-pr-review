import type { ElementContent, Root } from 'hast';
import { Diff } from 'diff';
import { SKIP, visit } from 'unist-util-visit';
import type { Removal } from './patch';

/** A replacement shared among several blocks: removal index → [from, to) of its removed lines shown by this block. */
export type RemovalParts = Map<number, [number, number]>;

/**
 * Old and new source of the head-file lines [start, end] of a block: every change that
 * begins inside the range is swapped back to its removed lines in the old version, so
 * unchanged lines of the block are kept on both sides. A replacement listed in `parts`
 * only contributes this block's share: its slice of the removed lines and the new lines
 * inside the range.
 */
export function blockDiffSource(lines: string[], removals: Removal[], start: number, end: number, parts?: RemovalParts) {
  const replacedAt = new Map<number, number>();
  const removedBefore = new Map<number, number[]>();
  removals.forEach((r, i) => {
    if (r.replacedBy) {
      const at = parts?.has(i) ? Math.max(r.replacedBy.start, start) : r.replacedBy.start;
      if (at >= start && at <= end && at <= r.replacedBy.end) replacedAt.set(at, i);
    } else if (r.anchor > start && r.anchor <= end) {
      removedBefore.set(r.anchor, [...(removedBefore.get(r.anchor) ?? []), i]);
    }
  });
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const used = new Set<number>();
  for (let ln = start; ln <= end; ) {
    for (const i of removedBefore.get(ln) ?? []) {
      oldLines.push(...removals[i].lines);
      used.add(i);
    }
    const i = replacedAt.get(ln);
    if (i === undefined) {
      oldLines.push(lines[ln - 1] ?? '');
      newLines.push(lines[ln - 1] ?? '');
      ln++;
      continue;
    }
    const [from, to] = parts?.get(i) ?? [0, removals[i].lines.length];
    oldLines.push(...removals[i].lines.slice(from, to));
    used.add(i);
    for (const stop = Math.min(removals[i].replacedBy!.end, end); ln <= stop; ln++) newLines.push(lines[ln - 1] ?? '');
  }
  return { oldText: oldLines.join('\n'), newText: newLines.join('\n'), used };
}

// ---------------------------------------------------------------------------
// A replacement spanning several sibling blocks (list items of one list, consecutive
// paragraphs) is shared out among them, so each block keeps its own element and shows
// its own part of the word diff.
// ---------------------------------------------------------------------------

export const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;
const unquote = (l: string) => l.replace(/^(?:[ \t]*>)+[ \t]?/, '');
const blank = (l: string) => !unquote(l).trim();
const indentOf = (l: string) => unquote(l).search(/\S/);

/** Word overlap above which an old block counts as an earlier version of a new one. */
const SIMILAR = 0.3;
const WORD = /[\p{L}\p{N}_]+/gu;

export function wordCounts(lines: string[]) {
  const counts = new Map<string, number>();
  for (const l of lines) {
    for (const w of unquote(l).replace(LIST_MARKER, '').toLowerCase().match(WORD) ?? []) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return counts;
}

/** Dice coefficient of two word multisets. */
export function similarity(a: Map<string, number>, b: Map<string, number>) {
  let common = 0;
  let total = 0;
  for (const [w, n] of a) {
    common += Math.min(n, b.get(w) ?? 0);
    total += n;
  }
  for (const n of b.values()) total += n;
  return total ? (2 * common) / total : 0;
}

/**
 * Share the removed lines of a replacement out among the new blocks it spans (`shown`: each
 * block's new lines inside the replacement). Returns each block's [from, to) slice of `old`,
 * contiguous and in order, or null when they can't be split cleanly.
 *
 * The removed lines are cut into the blocks they used to be (list items or paragraphs), and
 * each old block goes to the most similar new block, keeping the order. Old blocks left over
 * are paired with the unmatched new blocks around them in order; extra ones join a neighbour.
 * `continuesFirst` / `continuesLast`: the first / last block also has unchanged lines before /
 * after the replacement, so the removed lines there belong to it.
 */
export function splitRemoved(old: string[], shown: string[][], tag: string, continuesFirst: boolean, continuesLast: boolean): [number, number][] | null {
  const depth = Math.min(...old.filter((l) => LIST_MARKER.test(unquote(l))).map(indentOf));
  const opens = (i: number) =>
    tag === 'li' ? LIST_MARKER.test(unquote(old[i])) && indentOf(old[i]) <= depth : i > 0 && !blank(old[i]) && blank(old[i - 1]);
  const chunks: [number, number][] = [];
  let from = 0;
  for (let i = 0, text = false; i < old.length; i++) {
    if (text && opens(i)) {
      chunks.push([from, i]);
      from = i;
    }
    if (!blank(old[i])) text = true;
  }
  chunks.push([from, old.length]);

  const n = chunks.length;
  const k = shown.length;
  const firstText = Math.max(0, old.findIndex((l) => !blank(l)));
  const head: [number, number][] = continuesFirst && !opens(firstText) ? [[0, 0]] : [];
  const tail: [number, number][] = continuesLast ? [[n - 1, k - 1]] : [];
  const c0 = head.length;
  const c1 = n - tail.length;
  const b0 = head.length;
  const b1 = k - tail.length;
  if (c0 > c1 || b0 > b1) return null; // one old block would have to go to both the first and the last block

  // Most similar pairs in order (LCS-like, scored by how far the overlap exceeds SIMILAR).
  const matched: [number, number][] = [];
  const rows = c1 - c0;
  const cols = b1 - b0;
  if (rows && cols && rows * cols <= 10000) {
    const oldWords = chunks.slice(c0, c1).map(([a, b]) => wordCounts(old.slice(a, b)));
    const newWords = shown.slice(b0, b1).map(wordCounts);
    const score = oldWords.map((o) => newWords.map((w) => Math.max(0, similarity(o, w) - SIMILAR)));
    const best = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
    for (let i = 1; i <= rows; i++) {
      for (let j = 1; j <= cols; j++) {
        const s = score[i - 1][j - 1];
        best[i][j] = Math.max(best[i - 1][j], best[i][j - 1], s > 0 ? best[i - 1][j - 1] + s : 0);
      }
    }
    for (let i = rows, j = cols; i > 0 && j > 0; ) {
      const s = score[i - 1][j - 1];
      if (s > 0 && best[i][j] === best[i - 1][j - 1] + s) {
        matched.unshift([c0 + i - 1, b0 + j - 1]);
        i--;
        j--;
      } else if (best[i][j] === best[i - 1][j]) i--;
      else j--;
    }
  }

  const owner = new Array<number>(n);
  let prev: [number, number] = [-1, -1];
  for (const next of [...head, ...matched, ...tail, [n, k] as [number, number]]) {
    const gap = next[1] - prev[1] - 1; // unmatched new blocks between the two matches
    for (let c = prev[0] + 1, x = 0; c < next[0]; c++, x++) {
      owner[c] = gap > 0 ? prev[1] + 1 + Math.min(x, gap - 1) : prev[1] >= 0 ? prev[1] : next[1];
    }
    if (next[0] < n) owner[next[0]] = next[1];
    prev = next;
  }

  // Owners only ever move forward, so every block gets a contiguous slice (possibly empty).
  const slices: [number, number][] = [];
  let at = 0;
  for (let b = 0; b < k; b++) {
    let to = at;
    for (let c = 0; c < n; c++) if (owner[c] === b) to = chunks[c][1];
    slices.push([at, to]);
    at = to;
  }
  return slices;
}

// ---------------------------------------------------------------------------
// Word diff rendered as Markdown: the diff is computed on source text, ins/del regions are
// marked with sentinel characters, the merged text is rendered as Markdown and the sentinels
// are turned into <ins>/<del> afterwards. Formatting (code, emphasis, links) survives.
// ---------------------------------------------------------------------------

// Rare Unicode punctuation: Markdown treats them like punctuation, so emphasis next to them still works.
const INS_START = '⸛';
const INS_END = '⸞';
const DEL_START = '⸟';
const DEL_END = '⸪';
const SENTINELS = /([⸛⸞⸟⸪])/;
const SENTINELS_ALL = /[⸛⸞⸟⸪]/g;

/**
 * Words, whitespace and punctuation; code spans, links, HTML tags and inline math are kept whole
 * so the diff never splits their syntax.
 */
const MD_TOKEN = /`+[^`\n]+?`+|!?\[[^\]\n]*\](?:\([^)\n]*\)|\[[^\]\n]*\])|<https?:[^>\s]+>|<\/?[A-Za-z][^<>\n]*>|\$[^$\n]+\$|[\p{L}\p{M}\p{N}_]+|\s+|[^\s]/gu;
/** Scripts written without spaces between words: a whole sentence would otherwise be one "word". */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
let segmenter: Intl.Segmenter | null | undefined;

/** Splits a run of letters into words with the browser's dictionary-based segmenter (one character at a time without it). */
export function splitWords(run: string): string[] {
  if (!UNSPACED.test(run)) return [run];
  if (segmenter === undefined) segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
  return segmenter ? [...segmenter.segment(run)].map((s) => s.segment) : [...run];
}

export function tokenizeMarkdown(value: string): string[] {
  return (value.match(MD_TOKEN) ?? []).flatMap((t) => (/^[\p{L}\p{M}\p{N}_]+$/u.test(t) ? splitWords(t) : [t]));
}

class MarkdownTokenDiff extends Diff<string, string> {
  tokenize(value: string) {
    return tokenizeMarkdown(value);
  }
}
const tokenDiff = new MarkdownTokenDiff();

export function diffMarkdownWords(oldText: string, newText: string) {
  return tokenDiff.diff(oldText.replace(SENTINELS_ALL, ''), newText.replace(SENTINELS_ALL, ''));
}

/** Merged Markdown source with sentinel-marked insertions and deletions. */
export function markdownDiffSource(oldText: string, newText: string): string {
  return diffMarkdownWords(oldText, newText)
    .map((p) => (p.added ? INS_START + p.value + INS_END : p.removed ? DEL_START + p.value + DEL_END : p.value))
    .join('');
}

/** Elements with no text of their own (an image, a line break), or whose text is source (math), that sit inside a changed region as a whole. */
const ATOMIC = new Set(['img', 'br', 'input', 'picture', 'svg']);
const atomic = (n: { tagName: string; properties: Record<string, unknown> }) => ATOMIC.has(n.tagName) || (n.tagName === 'code' && n.properties.dataMath !== undefined);

/** rehype plugin: keep paragraphs apart once unwrapped, and turn sentinel regions into <ins>/<del>. */
export function rehypeDiffMarks() {
  return (tree: Root) => {
    const blocks = tree.children.filter((n) => n.type !== 'text' || n.value.trim());
    tree.children = blocks.flatMap((n, i) => (i ? [{ type: 'text' as const, value: '\n\n' }, n] : [n]));

    let state: 'ins' | 'del' | null = null;
    const mark = (child: ElementContent): ElementContent =>
      ({ type: 'element', tagName: state!, properties: { className: [`mdr-d-${state}`] }, children: [child] }) as ElementContent;
    visit(tree, (node, index, parent) => {
      if (!parent || index === undefined) return;
      if (node.type === 'element' && state && atomic(node)) {
        parent.children.splice(index, 1, mark(node) as any);
        return [SKIP, index + 1];
      }
      if (node.type !== 'text') return;
      if (!state && !SENTINELS.test(node.value)) return;
      const out: ElementContent[] = [];
      for (const s of node.value.split(SENTINELS)) {
        if (s === INS_START) state = 'ins';
        else if (s === DEL_START) state = 'del';
        else if (s === INS_END || s === DEL_END) state = null;
        else if (s) out.push(state ? mark({ type: 'text', value: s }) : { type: 'text', value: s });
      }
      parent.children.splice(index, 1, ...(out as any[]));
      return [SKIP, index + out.length];
    });
  };
}
