import { createTwoFilesPatch } from 'diff';

/** A run of removed lines found again, unchanged, among the lines the PR added elsewhere. */
export interface MovedChunk {
  /** [from, to) of the removal's `lines`. */
  from: number;
  to: number;
  /** Head-file lines the text was moved to. */
  start: number;
  end: number;
}

/** Lines removed from the base version, positioned relative to the head (new) file. */
export interface Removal {
  /** Head-file line number before which the removed lines used to sit (may be lines.length + 1). */
  anchor: number;
  /** The removed source lines (without the leading "-"). */
  lines: string[];
  /** Base-file line number of the first removed line (what a comment on the left side of the diff refers to). */
  oldStart: number;
  /** Head-file line range that replaced the removed lines (a modification), if any. */
  replacedBy?: { start: number; end: number };
  /** Only line breaks or spacing changed: the document reads the same (a re-wrapped paragraph, re-padded table). */
  reflow?: boolean;
  /** Parts of the removed lines that were moved elsewhere in the file rather than deleted. */
  moved?: MovedChunk[];
}

export interface HunkRange {
  /** First and last line covered by the hunk (context + changed lines). */
  start: number;
  end: number;
}

export interface DiffInfo {
  hasPatch: boolean;
  /** Head-file line numbers that were added. */
  added: Set<number>;
  removals: Removal[];
  /** Head-side line ranges GitHub accepts line comments on (side: RIGHT). */
  hunks: HunkRange[];
  /** Base-side line ranges GitHub accepts line comments on (side: LEFT). */
  oldHunks: HunkRange[];
  /** Added head lines that are text moved from elsewhere in the file → index of the removal it came from. */
  moved: Map<number, number>;
  /** Head-file line ranges whose only change was whitespace, when those changes are hidden (see presentDiff). */
  reflowed: HunkRange[];
  additions: number;
  deletions: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export const emptyDiff = (hasPatch = false): DiffInfo => ({
  hasPatch,
  added: new Set(),
  removals: [],
  hunks: [],
  oldHunks: [],
  moved: new Map(),
  reflowed: [],
  additions: 0,
  deletions: 0,
});

export function parsePatch(patch: string | undefined | null): DiffInfo {
  const info = emptyDiff(!!patch);
  if (!patch) return info;

  type Op = { t: '+' | '-' | ' '; text: string };
  const hunks: { oldStart: number; newStart: number; ops: Op[] }[] = [];
  for (const raw of patch.replace(/\r?\n$/, '').split(/\r?\n/)) {
    const m = HUNK_RE.exec(raw);
    if (m) {
      hunks.push({ oldStart: Number(m[1]), newStart: Number(m[3]), ops: [] });
      continue;
    }
    const h = hunks[hunks.length - 1];
    if (!h) continue;
    const c = raw[0];
    if (c === '+' || c === '-' || c === ' ') h.ops.push({ t: c, text: raw.slice(1) });
    else if (raw === '') h.ops.push({ t: ' ', text: '' }); // tolerate stripped trailing spaces
    // "\ No newline at end of file" and anything else is ignored
  }
  /** Text of every added head line, for telling re-wraps and moves apart from real edits. */
  const addedText = new Map<number, string>();
  /** Base-file text of the context lines (to tell whether two removals are neighbouring paragraphs). */
  const contextText = new Map<number, string>();
  for (const h of hunks) {
    // A hunk that starts at line 0 has no lines on that side (a file created or emptied).
    let ln = Math.max(1, h.newStart);
    let ol = Math.max(1, h.oldStart);
    const start = ln;
    const oldFirst = ol;
    const ops = h.ops;
    for (let i = 0; i < ops.length; ) {
      const op = ops[i];
      if (op.t === ' ') {
        contextText.set(ol, op.text);
        ln++;
        ol++;
        i++;
      } else if (op.t === '+') {
        info.added.add(ln);
        addedText.set(ln, op.text);
        info.additions++;
        ln++;
        i++;
      } else {
        const del: string[] = [];
        const oldStart = ol;
        while (i < ops.length && ops[i].t === '-') del.push(ops[i++].text);
        ol += del.length;
        info.deletions += del.length;
        const anchor = ln;
        let n = 0;
        while (i < ops.length && ops[i].t === '+') {
          info.added.add(ln + n);
          addedText.set(ln + n, ops[i].text);
          info.additions++;
          n++;
          i++;
        }
        const r: Removal = { anchor, lines: del, oldStart, replacedBy: n ? { start: ln, end: ln + n - 1 } : undefined };
        // The item before a renumbered run tells whether the run starts its list (then its first number counts).
        const afterItem = LIST_ITEM.test((contextText.get(oldStart - 1) ?? '').replace(QUOTES, ''));
        if (n && isReflow(del, Array.from({ length: n }, (_, k) => addedText.get(ln + k) ?? ''), afterItem)) r.reflow = true;
        info.removals.push(r);
        ln += n;
      }
    }
    if (ln - 1 >= start) info.hunks.push({ start, end: ln - 1 });
    if (ol - 1 >= oldFirst) info.oldHunks.push({ start: oldFirst, end: ol - 1 });
  }
  findMoves(info, addedText, contextText);
  return info;
}

/** For a deleted file, the patch contains the full old content. */
export function contentFromRemovedPatch(patch: string | undefined): string {
  if (!patch) return '';
  return patch
    .split('\n')
    .filter((l) => l.startsWith('-'))
    .map((l) => l.slice(1))
    .join('\n');
}

/**
 * A unified diff of two versions of a file, in the shape GitHub's API returns (hunks only, no
 * file headers). Null when the diff takes longer than `timeout` ms: it runs on the page's main
 * thread, and two very different long files would freeze the tab for many seconds.
 */
export function diffTexts(oldText: string, newText: string, timeout = 2000): string | null {
  const eol = (s: string) => (s && !s.endsWith('\n') ? s + '\n' : s);
  const patch = createTwoFilesPatch('a', 'b', eol(oldText.replace(/\r\n/g, '\n')), eol(newText.replace(/\r\n/g, '\n')), '', '', { context: 3, timeout }) as string | undefined;
  if (patch === undefined) return null;
  const at = patch.indexOf('\n@@');
  return at < 0 ? '' : patch.slice(at + 1);
}

// ---------------------------------------------------------------------------
// Re-wrapped text: a change that only moves line breaks or spacing around reads the same.
// ---------------------------------------------------------------------------

const FENCE = /^[ \t]*(`{3,}|~{3,})/;
const LIST_ITEM = /^([ \t]*)([-*+]|\d+[.)])([ \t]+|$)/;
const QUOTES = /^(?:[ \t]*>)+[ \t]?/;
const TABLE_ROW = /^\s*\|/;
const RULE = /^[ \t]*(?:([-=])\1*|(?:[*_-][ \t]*){3,})[ \t]*$/;
const BLOCK_START = /^[ \t]*(?:#{1,6}(?:[ \t]|$)|<\/?[a-zA-Z]|\[[^\]]+\]:)/;

/**
 * What a run of Markdown lines says, with the line breaks and spacing that don't change how it
 * renders taken out: words, paragraph breaks, hard breaks, and the lines that start a block
 * (list items with their indentation, headings, table rows cell by cell, rules, HTML).
 */
function signature(lines: string[], afterItem = false): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let blank = true;
  let first = true;
  for (const raw of lines) {
    if (FENCE.test(raw.replace(QUOTES, ''))) return null; // whitespace inside code is significant
    const q = (QUOTES.exec(raw)?.[0].match(/>/g) ?? []).length;
    const line = raw.replace(QUOTES, '');
    if (!line.trim()) {
      if (!blank) out.push('¶');
      blank = true;
      continue;
    }
    if (q !== depth) out.push(`>${q}`);
    depth = q;
    const indent = /^[ \t]*/.exec(line)![0].replace(/\t/g, '    ').length;
    const item = LIST_ITEM.exec(line);
    // Where a block starts, its indentation matters: it decides whether a paragraph belongs to the
    // list item above it, and whether it is indented code.
    if (blank && indent > 0 && !item) out.push(`I${indent}`);
    if (TABLE_ROW.test(line)) {
      // Cells without their padding; a delimiter row only by its alignment colons.
      const cells = line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\s+/g, ' '));
      out.push('|' + cells.map((c) => (/^:?-+:?$/.test(c) ? c.replace(/-+/, '-') : c)).join('|'));
      blank = false;
      continue;
    }
    if (RULE.test(line)) {
      out.push(`R${line.trim()[0]}`);
      blank = false;
      continue;
    }
    let text = line;
    if (item) {
      // Renumbering the items of a list doesn't change how it renders, but the first item's number
      // sets where the list starts: keep it where a run of items begins.
      out.push(`L${indent}${blank && !(first && afterItem) ? item[2] : item[2].replace(/\d+/, '1')}`);
      text = line.slice(item[0].length);
    } else if (BLOCK_START.test(line)) {
      out.push('B');
    }
    out.push(...text.trim().split(/\s+/).filter(Boolean));
    if (/(?: {2,}|\\)$/.test(line)) out.push('↵'); // a hard line break
    blank = false;
    first = false;
  }
  return out;
}

/**
 * The old and new lines differ only in line breaks and spacing that don't change the rendered
 * text. `afterItem`: the line before them is a list item, so a renumbered first line continues a
 * list rather than starting one.
 */
export function isReflow(oldLines: string[], newLines: string[], afterItem = false): boolean {
  if (oldLines.join('\n') === newLines.join('\n')) return false;
  const a = signature(oldLines, afterItem);
  const b = signature(newLines, afterItem);
  return !!a && !!b && a.length > 0 && a.join('\u0000') === b.join('\u0000');
}

// ---------------------------------------------------------------------------
// Moved text: a paragraph removed in one place and added, unchanged, in another.
// ---------------------------------------------------------------------------

const moveKey = (lines: string[]) => lines.map((l) => l.trim().replace(/\s+/g, ' ')).join('\n');
/** Enough text that finding it twice isn't a coincidence (not a lone "---", "}" or "Yes."). */
const substantial = (key: string) => (key.match(/[\p{L}\p{N}]/gu) ?? []).length >= 16;

/** Splits lines into paragraphs: [from, to) of the non-blank runs. */
function chunksOf(lines: string[]): [number, number][] {
  const out: [number, number][] = [];
  let from = -1;
  lines.forEach((l, i) => {
    if (l.trim()) {
      if (from < 0) from = i;
    } else if (from >= 0) {
      out.push([from, i]);
      from = -1;
    }
  });
  if (from >= 0) out.push([from, lines.length]);
  return out;
}

/**
 * Pairs removed paragraphs with identical paragraphs added elsewhere in the file (as pure
 * additions). A substantial paragraph found again anchors a match; the paragraphs around it that
 * travelled along with it (a section's heading, a short line) then count as moved too, also
 * across neighbouring removals. Git often pairs moved-away text with whatever was written in its
 * place; such a replacement is split, so the moved part shows as moved and the rest as new.
 */
function findMoves(info: DiffInfo, addedText: Map<number, string>, contextText: Map<number, string>) {
  const replaced = new Set<number>();
  for (const r of info.removals) if (r.replacedBy) for (let l = r.replacedBy.start; l <= r.replacedBy.end; l++) replaced.add(l);

  // Runs of purely added lines, cut into paragraphs.
  type Target = { start: number; end: number; key: string; run: number; used: boolean };
  const targets: Target[] = [];
  const sorted = [...info.added].filter((l) => !replaced.has(l)).sort((a, b) => a - b);
  for (let i = 0, run = 0; i < sorted.length; run++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    const first = sorted[i];
    const text = sorted.slice(i, j + 1).map((l) => addedText.get(l) ?? '');
    for (const [from, to] of chunksOf(text)) targets.push({ start: first + from, end: first + to - 1, key: moveKey(text.slice(from, to)), run, used: false });
    i = j + 1;
  }
  if (!targets.some((t) => substantial(t.key))) return;

  // Removed paragraphs in base-file order.
  type Chunk = { r: number; from: number; to: number; key: string; target: number };
  const chunks: Chunk[] = [];
  info.removals.forEach((r, idx) => {
    if (r.reflow) return;
    for (const [from, to] of chunksOf(r.lines)) chunks.push({ r: idx, from, to, key: moveKey(r.lines.slice(from, to)), target: -1 });
  });
  const oldFirst = (c: Chunk) => info.removals[c.r].oldStart + c.from;
  const oldLast = (c: Chunk) => info.removals[c.r].oldStart + c.to - 1;
  chunks.sort((a, b) => oldFirst(a) - oldFirst(b));
  /** Only blank lines between two removed paragraphs: they were next to each other. */
  const adjacent = (a: Chunk, b: Chunk) => {
    for (let l = oldLast(a) + 1; l < oldFirst(b); l++) {
      const removed = info.removals.some((r) => l >= r.oldStart && l < r.oldStart + r.lines.length);
      const text = removed ? '' : contextText.get(l);
      if (text === undefined || text.trim()) return false;
    }
    return true;
  };
  const link = (c: Chunk, t: number) => {
    c.target = t;
    targets[t].used = true;
  };
  for (const c of chunks) {
    if (!substantial(c.key)) continue;
    const t = targets.findIndex((x) => !x.used && x.key === c.key);
    if (t >= 0) link(c, t);
  }
  // Neighbours that travelled along: same text, next to the match on both sides.
  for (let changed = true; changed; ) {
    changed = false;
    chunks.forEach((c, k) => {
      if (c.target < 0) return;
      for (const d of [-1, 1]) {
        const n = chunks[k + d];
        const t = c.target + d;
        if (!n || n.target >= 0 || !targets[t] || targets[t].used || targets[t].run !== targets[c.target].run || targets[t].key !== n.key) continue;
        if (!(d < 0 ? adjacent(n, c) : adjacent(c, n))) continue;
        link(n, t);
        changed = true;
      }
    });
  }

  // Record the moves, splitting replacements whose moved part leads or trails the rest.
  const out: Removal[] = [];
  const movedTo: { removal: number; start: number; end: number }[] = [];
  info.removals.forEach((r, idx) => {
    const mine = chunks.filter((c) => c.r === idx && c.target >= 0).sort((a, b) => a.from - b.from);
    if (!mine.length) return void out.push(r);
    const record = (piece: Removal, offset: number, list: Chunk[]) => {
      const i = out.length;
      piece.moved = list.map((c) => {
        const t = targets[c.target];
        movedTo.push({ removal: i, start: t.start, end: t.end });
        return { from: c.from - offset, to: c.to - offset, start: t.start, end: t.end };
      });
      out.push(piece);
    };
    const textLines = r.lines.map((l, k) => [l, k] as const).filter(([l]) => l.trim()).map(([, k]) => k);
    const covered = (from: number, to: number) => textLines.filter((k) => k >= from && k < to).every((k) => mine.some((c) => k >= c.from && k < c.to));
    if (!r.replacedBy || covered(0, r.lines.length)) {
      // A replacement whose old text all moved away: the new lines are simply new.
      return record({ ...r, replacedBy: undefined }, 0, mine);
    }
    const prefix: Chunk[] = [];
    for (const c of mine) if (covered(0, c.to) && prefix.length === mine.indexOf(c)) prefix.push(c);
    const suffix: Chunk[] = [];
    for (const c of [...mine].reverse()) if (covered(c.from, r.lines.length) && suffix.length === mine.length - 1 - mine.indexOf(c)) suffix.unshift(c);
    if (prefix.length) {
      const cut = prefix[prefix.length - 1].to;
      const at = textLines.find((k) => k >= cut) ?? r.lines.length;
      record({ anchor: r.anchor, lines: r.lines.slice(0, at), oldStart: r.oldStart }, 0, prefix);
      return void out.push({ ...r, lines: r.lines.slice(at), oldStart: r.oldStart + at });
    }
    if (suffix.length) {
      const at = suffix[0].from;
      out.push({ ...r, lines: r.lines.slice(0, at) });
      return record({ anchor: r.replacedBy.end + 1, lines: r.lines.slice(at), oldStart: r.oldStart + at }, at, suffix);
    }
    // Moved text in the middle of a rewrite: show the rewrite as it is.
    for (const c of mine) targets[c.target].used = false;
    out.push(r);
  });
  info.removals = out;
  for (const m of movedTo) for (let l = m.start; l <= m.end; l++) info.moved.set(l, m.removal);
}

// ---------------------------------------------------------------------------
// The diff as shown: optionally without whitespace-only changes.
// ---------------------------------------------------------------------------

/**
 * The diff to display. With `ignoreWhitespace`, re-wrapped and re-padded blocks stop counting
 * as changes (they are listed in `reflowed` so they can still be hinted at). `verbatim` holds the
 * head lines where whitespace is always significant (code blocks, HTML, front matter): a change
 * there is never hidden, even when only spacing moved. Comment anchors must keep using the
 * original diff: GitHub only accepts lines of its own hunks.
 */
export function presentDiff(diff: DiffInfo, ignoreWhitespace: boolean, verbatim?: Set<number>): DiffInfo {
  if (!ignoreWhitespace || !diff.removals.some((r) => r.reflow)) return diff;
  const inVerbatim = (r: Removal) => {
    if (!verbatim || !r.replacedBy) return false;
    for (let l = r.replacedBy.start; l <= r.replacedBy.end; l++) if (verbatim.has(l)) return true;
    return false;
  };
  const added = new Set(diff.added);
  const reflowed: HunkRange[] = [];
  const keep: Removal[] = [];
  const index = new Map<number, number>();
  diff.removals.forEach((r, i) => {
    if (r.reflow && r.replacedBy && !inVerbatim(r)) {
      for (let l = r.replacedBy.start; l <= r.replacedBy.end; l++) added.delete(l);
      reflowed.push({ ...r.replacedBy });
    } else {
      index.set(i, keep.length);
      keep.push(r);
    }
  });
  const moved = new Map<number, number>();
  for (const [l, i] of diff.moved) if (index.has(i)) moved.set(l, index.get(i)!);
  return { ...diff, added, removals: keep, moved, reflowed };
}

// ---------------------------------------------------------------------------
// The base version.
// ---------------------------------------------------------------------------

/** The file as it was before the PR: added lines taken out, removed lines put back. */
export function baseLines(diff: DiffInfo, headLines: string[]): string[] {
  const before = new Map<number, Removal[]>();
  for (const r of diff.removals) before.set(r.anchor, [...(before.get(r.anchor) ?? []), r]);
  const out: string[] = [];
  for (let ln = 1; ln <= headLines.length + 1; ln++) {
    for (const r of before.get(ln) ?? []) out.push(...r.lines);
    if (ln <= headLines.length && !diff.added.has(ln)) out.push(headLines[ln - 1]);
  }
  return out;
}

/**
 * For every head line (1-based index), the base line at the same place in the document: the
 * line itself when it is unchanged, else the base line where the change sits.
 */
export function headToBase(diff: DiffInfo, lineCount: number): number[] {
  const deleted = new Map<number, number>();
  const replaced = new Map<number, number>();
  for (const r of diff.removals) {
    const m = r.replacedBy ? replaced : deleted;
    m.set(r.anchor, (m.get(r.anchor) ?? 0) + r.lines.length);
  }
  const map = [0];
  let ol = 1;
  for (let ln = 1; ln <= lineCount; ln++) {
    ol += deleted.get(ln) ?? 0;
    map.push(ol); // a replacement's first new line sits where its old lines started
    ol += replaced.get(ln) ?? 0;
    if (!diff.added.has(ln)) ol++;
  }
  return map;
}
