import type { DiffInfo } from './patch';

export type Anchor =
  | { kind: 'line'; start: number; end: number; clamped: boolean }
  | { kind: 'file'; start: number; end: number; reason: string };

/**
 * GitHub only accepts line comments on lines inside a diff hunk (and a multi-line
 * comment must stay inside one hunk). Map a selected head-file line range to the
 * best valid anchor, falling back to a file-level comment.
 */
export function resolveAnchor(diff: DiffInfo | null, start: number, end: number): Anchor {
  if (end < start) [start, end] = [end, start];
  if (!diff || !diff.hasPatch) {
    return { kind: 'file', start, end, reason: 'GitHub shows no diff for this file' };
  }
  let best: { s: number; e: number } | null = null;
  for (const h of diff.hunks) {
    const s = Math.max(start, h.start);
    const e = Math.min(end, h.end);
    if (s <= e && (!best || e - s > best.e - best.s)) best = { s, e };
  }
  if (!best) return { kind: 'file', start, end, reason: 'the selected lines are outside the changed part of the file' };
  return { kind: 'line', start: best.s, end: best.e, clamped: best.s !== start || best.e !== end };
}

export function lineLabel(start: number, end: number) {
  return start === end ? `line ${start}` : `lines ${start}–${end}`;
}

// ---------------------------------------------------------------------------
// Narrowing a rendered-text selection to source lines.
// ---------------------------------------------------------------------------

/** Strip the most common Markdown syntax so source text can be compared with rendered text. */
export function plainify(src: string): string {
  return src
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images
    .replace(/\]\([^)]*\)/g, ']') // link targets
    .replace(/\]\[[^\]]*\]/g, ']') // reference links
    .replace(/<[^>\n]+>/g, ' ') // html tags / autolinks
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, ''); // link definitions
}

/** Letters and digits only, lower-cased: robust against markup, whitespace and punctuation. */
export function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Given the source lines of a region [sl, el] and the user's selected text,
 * return the tightest line range that contains the selection.
 */
export function narrowLines(lines: string[], sl: number, el: number, selected: string): { start: number; end: number } {
  const target = norm(selected);
  if (!target || sl >= el) return { start: sl, end: el };

  let concat = '';
  const owner: number[] = []; // owner[i] = line number of concat[i]
  for (let ln = sl; ln <= el; ln++) {
    const n = norm(plainify(lines[ln - 1] ?? ''));
    concat += n;
    for (let k = 0; k < n.length; k++) owner.push(ln);
  }
  if (!concat) return { start: sl, end: el };

  const idx = concat.indexOf(target);
  if (idx >= 0) return { start: owner[idx], end: owner[idx + target.length - 1] };

  // Selection includes text that isn't in the source verbatim (e.g. list numbers, inline diff).
  // Fall back to matching its head and tail separately.
  const k = Math.min(16, target.length);
  const head = concat.indexOf(target.slice(0, k));
  const tail = concat.lastIndexOf(target.slice(-k));
  const start = head >= 0 ? owner[head] : sl;
  const end = tail >= 0 ? owner[tail + k - 1] : el;
  return start <= end ? { start, end } : { start: sl, end: el };
}
