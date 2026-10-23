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
// A replacement spanning several blocks (list items, paragraphs, a heading and the text
// under it, …) is shared out among them, so each block keeps its own element and shows
// its own part of the word diff; a block that gets none of the removed lines is simply new.
// ---------------------------------------------------------------------------

export const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;
const unquote = (l: string) => l.replace(/^(?:[ \t]*>)+[ \t]?/, '');
const blank = (l: string) => !unquote(l).trim();
const indentOf = (l: string) => unquote(l).search(/\S/);
const FENCE = /^[ \t]*(`{3,}|~{3,})/;
const HEADING = /^[ \t]{0,3}#{1,6}(?:[ \t]|$)/;
const RULE = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/** What a block is, for pairing old blocks with new ones: text only goes with text, code with code. */
export type BlockKind = 'text' | 'code' | 'rule';

/** For each line: inside a fenced code block, after its opening fence (the closing fence included). */
function fencedLines(lines: string[]): boolean[] {
  const code: boolean[] = [];
  let fence = '';
  for (const raw of lines) {
    const l = unquote(raw);
    const m = FENCE.exec(l);
    code.push(!!fence);
    if (!fence) fence = m?.[1] ?? '';
    else if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !l.slice(m[0].length).trim()) fence = '';
  }
  return code;
}

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
 * block's own new lines inside the replacement, `kinds`: what each block is). Returns each
 * block's [from, to) slice of `old`, contiguous and in order, or null when they can't be split
 * cleanly.
 *
 * The removed lines are cut into the blocks they used to be (paragraphs, list items, headings,
 * code blocks), and each old block goes to the most similar new block of its kind, keeping the
 * order. Old blocks left over are paired with the unmatched new blocks of their kind around
 * them in order; extra ones join a neighbour. New blocks that get nothing are simply new.
 * `items`: the blocks are items of one list (nested items stay with the item they're in).
 * `continuesFirst` / `continuesLast`: the first / last block also has unchanged lines before /
 * after the replacement, so the removed lines there belong to it.
 */
export function splitRemoved(
  old: string[],
  shown: string[][],
  kinds: BlockKind[],
  items: boolean,
  continuesFirst: boolean,
  continuesLast: boolean,
): [number, number][] | null {
  // Lines of a fenced code block after its opening fence never start a block.
  const code = fencedLines(old);
  const depth = Math.min(...old.filter((l) => LIST_MARKER.test(unquote(l))).map(indentOf));
  const opens = (i: number) => {
    const l = unquote(old[i]);
    if (items) return LIST_MARKER.test(l) && indentOf(old[i]) <= depth;
    if (blank(old[i]) || code[i]) return false;
    if (LIST_MARKER.test(l) || HEADING.test(l) || FENCE.test(l)) return true;
    return i > 0 && (blank(old[i - 1]) || code[i - 1] || HEADING.test(unquote(old[i - 1])));
  };
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
  const chunkKinds = chunks.map(([a, b]): BlockKind => {
    const text = old.slice(a, b).map(unquote).filter((l) => l.trim());
    return text.length && FENCE.test(text[0]) ? 'code' : text.length === 1 && RULE.test(text[0]) ? 'rule' : 'text';
  });
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
    const score = oldWords.map((o, i) =>
      newWords.map((w, j) => (chunkKinds[c0 + i] === kinds[b0 + j] ? Math.max(0, similarity(o, w) - SIMILAR) : 0)),
    );
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
    // Old blocks between two matches take, in order, the unmatched new blocks of their kind between them.
    let b = prev[1];
    for (let c = prev[0] + 1; c < next[0]; c++) {
      let j = b + 1;
      while (j < next[1] && kinds[j] !== chunkKinds[c]) j++;
      if (j < next[1]) b = j;
      else if (b < 0) b = next[1] < k ? next[1] : 0;
      owner[c] = b;
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
 * Words, whitespace and punctuation; code spans, links (also bare URLs), footnote references,
 * HTML tags and entities, inline math and emoji shortcodes are kept whole so the diff never splits
 * their syntax. A run of emphasis markers (`**`, `__`, `~~`) is one token, and an underscore only
 * belongs to a word inside it (snake_case), not at its edge (_emphasis_).
 */
const MD_TOKEN =
  /`+[^`\n]+?`+|!?\[[^\]\n]*\](?:\([^)\n]*\)|\[[^\]\n]*\])|\[\^[^\]\s]+\]|<https?:[^>\s]+>|<\/?[A-Za-z][^<>\n]*>|\$[^$\n]+\$|(?:https?:\/\/|www\.)[^\s<>]*[^\s<>.,:;!?'")\]*_~]|:[\w+-]+:|&(?:#\d+|#[xX][\da-fA-F]+|\w+);|[\p{L}\p{M}\p{N}]+(?:_+[\p{L}\p{M}\p{N}]+)*|\*+|_+|~+|\s+|[^\s]/gu;
const MARKS = /^(?:\*+|_+|~+)$/;
const BARE_URL = /^https?:\/\/\S/;
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

/** A piece of a word diff: unchanged, removed or added text. */
export interface DiffPiece {
  value: string;
  added?: boolean;
  removed?: boolean;
}

/**
 * Spacing and plain punctuation. Left between two changes it splits a rewritten phrase into
 * alternating single words. Markdown syntax and line breaks don't count: both sides of the
 * merged change would repeat them.
 */
const GLUE = /^[^\S\n]*(?:[^\s\p{L}\p{N}*_~`[\]<>$\\|&][^\S\n]*)*$/u;

/** Unchanged text, or a change: what was removed and what was added in its place. */
type Op = string | { del: string; ins: string };

function toOps(parts: DiffPiece[]): Op[] {
  const ops: Op[] = [];
  for (const p of parts) {
    const last = ops[ops.length - 1];
    if (!p.added && !p.removed) ops.push(p.value);
    else {
      const op = typeof last === 'object' ? last : { del: '', ins: '' };
      if (op !== last) ops.push(op);
      if (p.added) op.ins += p.value;
      else op.del += p.value;
    }
  }
  return ops;
}

const fromOps = (ops: Op[]): DiffPiece[] =>
  ops.flatMap((op) =>
    typeof op === 'string' ? [{ value: op }] : [...(op.del ? [{ value: op.del, removed: true }] : []), ...(op.ins ? [{ value: op.ins, added: true }] : [])],
  );

/**
 * Fold the glue sitting between two changes into them, so a rewritten phrase reads as one
 * deletion and one insertion (`~~a~~b ~~c~~d` → `~~a c~~b d`). Changes on both sides of the glue
 * must add up to a replacement: two deletions stay apart.
 */
function joinGlue(ops: Op[]): Op[] {
  const out: Op[] = [];
  for (const op of ops) {
    const glue = out[out.length - 1];
    const a = out[out.length - 2];
    if (
      typeof op === 'object' && typeof glue === 'string' && typeof a === 'object' && GLUE.test(glue) &&
      (a.del || op.del) && (a.ins || op.ins) && !/\n/.test(a.del + a.ins + op.del + op.ins)
    ) {
      out.pop();
      a.del += glue + op.del;
      a.ins += glue + op.ins;
    } else out.push(op);
  }
  return out;
}

export const joinChanges = (parts: DiffPiece[]): DiffPiece[] => fromOps(joinGlue(toOps(parts)));

/** Every kind of emphasis marker comes in pairs: no run of `*`, `_` or `~` is left without its partner. */
function paired(text: string) {
  const tokens = tokenizeMarkdown(text);
  const runs = new Map<string, number>();
  tokens.forEach((t, k) => {
    // A run between spaces is a plain character (2 * 3), not emphasis.
    if (MARKS.test(t) && !(/^\s/.test(tokens[k - 1] ?? 'x') && /^\s/.test(tokens[k + 1] ?? 'x'))) runs.set(t[0], (runs.get(t[0]) ?? 0) + 1);
  });
  return [...runs.values()].every((n) => n % 2 === 0);
}

/** How many tokens a change of formatting may grow over to find its markers' partners. */
const GROW_LIMIT = 400;

/**
 * A change that adds, removes or swaps emphasis markers would leave the old markers formatting
 * the new text, or the new formatting unmarked (`before` → `**before**`). Grow it over its
 * neighbours, within the paragraph, until the markers on each side pair up, so the formatted span
 * shows as replaced: ~~**before**~~before. Left as it is when they never do.
 */
function wholeFormatting(ops: Op[]): Op[] {
  // Unchanged text token by token, so a change grows no further than its markers need.
  const out: Op[] = ops.flatMap((op): Op[] => (typeof op === 'string' ? tokenizeMarkdown(op) : [op]));
  const side = (op: Op, s: 'del' | 'ins') => (typeof op === 'string' ? op : op[s]);
  const breaks = (op: Op) => /\n\n/.test(side(op, 'del') + side(op, 'ins'));
  for (let i = 0; i < out.length; i++) {
    if (typeof out[i] === 'string') continue;
    let a = i;
    let b = i;
    const text = (s: 'del' | 'ins') => out.slice(a, b + 1).map((op) => side(op, s)).join('');
    const fits = () => paired(text('del')) && paired(text('ins'));
    for (let right = true; !fits() && b - a < GROW_LIMIT; right = !right) {
      const canRight = b + 1 < out.length && !breaks(out[b + 1]);
      const canLeft = a > 0 && !breaks(out[a - 1]);
      if (!canRight && !canLeft) break;
      if ((right && canRight) || !canLeft) b++;
      else a--;
    }
    if (a === b || !fits()) continue;
    // Give back unchanged text at the edges that the markers don't need.
    while (a < i && typeof out[a] === 'string') {
      a++;
      if (fits()) continue;
      a--;
      break;
    }
    while (b > i && typeof out[b] === 'string') {
      b--;
      if (fits()) continue;
      b++;
      break;
    }
    out.splice(a, b - a + 1, { del: text('del'), ins: text('ins') });
    i = a;
  }
  // Unchanged tokens back together, and changes that ended up side by side.
  return out.reduce<Op[]>((acc, op) => {
    const last = acc[acc.length - 1];
    if (typeof op === 'string' && typeof last === 'string') acc[acc.length - 1] = last + op;
    else if (typeof op === 'object' && typeof last === 'object') acc[acc.length - 1] = { del: last.del + op.del, ins: last.ins + op.ins };
    else acc.push(op);
    return acc;
  }, []);
}

export function diffMarkdownWords(oldText: string, newText: string): DiffPiece[] {
  const parts = tokenDiff.diff(oldText.replace(SENTINELS_ALL, ''), newText.replace(SENTINELS_ALL, ''));
  return fromOps(joinGlue(wholeFormatting(toOps(parts))));
}

/**
 * A bare URL next to a sentinel isn't recognised as a link, or takes the sentinel into its
 * target: written as an explicit link it renders as GitHub renders it and stays whole.
 */
const linkable = (value: string) =>
  tokenizeMarkdown(value)
    .map((t) => (BARE_URL.test(t) ? `<${t}>` : /^www\./.test(t) ? `[${t.replace(/[\\`*_[\]]/g, '\\$&')}](<http://${t}>)` : t))
    .join('');

/** Merged Markdown source with sentinel-marked insertions and deletions. */
export function markdownDiffSource(oldText: string, newText: string): string {
  return diffMarkdownWords(oldText, newText)
    .map((p) => {
      const v = linkable(p.value);
      return p.added ? INS_START + v + INS_END : p.removed ? DEL_START + v + DEL_END : v;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// A word diff renders a block's source on its own, but the link reference definitions and
// footnotes it refers to live elsewhere in the file: they're handed to it.
// ---------------------------------------------------------------------------

const DEFINITION = /^ {0,3}\[(\^?)([^\]]+)\]:/;
const FOOTNOTE_REF = /\[\^([^\]\s]+)\]/g;

export interface DiffContext {
  /** Link reference definitions as written, by lower-case label. */
  links: Map<string, string>;
  /** Labels of footnotes (lower case). */
  notes: Set<string>;
  /** Footnote label → its number in the file. */
  footnotes: Map<string, number>;
}

/**
 * The definitions of the file (`lines`), then those of removed text (`removed`, for references in
 * deleted words), and the number of each footnote: the order the file first refers to them in.
 */
export function diffContext(lines: string[], removed: string[]): DiffContext {
  const links = new Map<string, string>();
  const notes = new Set<string>();
  const refs: string[] = [];
  for (const [ls, head] of [[lines, true], [removed, false]] as const) {
    const code = fencedLines(ls);
    ls.forEach((l, i) => {
      if (code[i] || FENCE.test(l)) return;
      const d = DEFINITION.exec(l);
      const label = d?.[2].toLowerCase() ?? '';
      if (d?.[1]) notes.add(label);
      else if (d) links.set(label, links.get(label) ?? l.trim()); // the first definition counts
      else if (head) for (const m of l.matchAll(FOOTNOTE_REF)) refs.push(m[1].toLowerCase());
    });
  }
  const footnotes = new Map<string, number>();
  for (const r of refs) if (notes.has(r) && !footnotes.has(r)) footnotes.set(r, footnotes.size + 1);
  return { links, notes, footnotes };
}

/** The definitions a word diff's `source` refers to, as Markdown to append to it. */
export function definitionsFor(source: string, ctx: DiffContext): string {
  const s = source.toLowerCase();
  const links = [...ctx.links].filter(([label]) => s.includes(`[${label}]`)).map(([, line]) => line);
  // A footnote's text isn't shown in a word diff: any will do. Each gets its own paragraph, so nothing runs into it.
  const notes = [...ctx.notes].filter((n) => s.includes(`[^${n}]`)).map((n) => `[^${n}]: .`);
  const defs = [links.join('\n'), ...notes].filter(Boolean);
  return defs.length ? `\n\n${defs.join('\n\n')}` : '';
}

/** Elements with no text of their own (an image, a line break), or whose text is source (math), that sit inside a changed region as a whole. */
const ATOMIC = new Set(['img', 'br', 'input', 'picture', 'svg']);
const atomic = (n: { tagName: string; properties: Record<string, unknown> }) => ATOMIC.has(n.tagName) || (n.tagName === 'code' && n.properties.dataMath !== undefined);

/**
 * rehype plugin: keep paragraphs apart once unwrapped, and turn sentinel regions into <ins>/<del>.
 * Footnote references keep the number they have in the file; the footnotes themselves are listed
 * at its end, not in the word diff.
 */
export function rehypeDiffMarks(opts: { footnotes?: Map<string, number> } = {}) {
  return (tree: Root) => {
    tree.children = tree.children.filter((n) => !(n.type === 'element' && n.tagName === 'section' && n.properties.dataFootnotes !== undefined));
    visit(tree, 'element', (n) => {
      if (n.tagName !== 'a' || n.properties.dataFootnoteRef === undefined) return;
      const href = String(n.properties.href ?? '');
      let label = href.replace(/^#fn-/, '');
      try {
        label = decodeURIComponent(label);
      } catch {
        /* keep as is */
      }
      const k = opts.footnotes?.get(label.toLowerCase());
      if (k) n.children = [{ type: 'text', value: String(k) }];
      delete n.properties.id; // the file's own reference has it
    });
    // The newline after a hard line break would show as a second break in the word diff's pre-wrap.
    visit(tree, 'element', (n) => {
      n.children.forEach((c, k) => {
        const next = n.children[k + 1];
        if (c.type === 'element' && c.tagName === 'br' && next?.type === 'text') next.value = next.value.replace(/^\n/, '');
      });
    });
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
