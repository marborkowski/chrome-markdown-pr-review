/** Lines removed from the base version, positioned relative to the head (new) file. */
export interface Removal {
  /** Head-file line number before which the removed lines used to sit (may be lines.length + 1). */
  anchor: number;
  /** The removed source lines (without the leading "-"). */
  lines: string[];
  /** Head-file line range that replaced the removed lines (a modification), if any. */
  replacedBy?: { start: number; end: number };
}

export interface HunkRange {
  /** First and last head-file line covered by the hunk (context + added). */
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
  additions: number;
  deletions: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parsePatch(patch: string | undefined | null): DiffInfo {
  const info: DiffInfo = { hasPatch: !!patch, added: new Set(), removals: [], hunks: [], additions: 0, deletions: 0 };
  if (!patch) return info;

  type Op = { t: '+' | '-' | ' '; text: string };
  const hunks: { newStart: number; ops: Op[] }[] = [];
  for (const raw of patch.replace(/\r?\n$/, '').split(/\r?\n/)) {
    const m = HUNK_RE.exec(raw);
    if (m) {
      hunks.push({ newStart: Number(m[3]), ops: [] });
      continue;
    }
    const h = hunks[hunks.length - 1];
    if (!h) continue;
    const c = raw[0];
    if (c === '+' || c === '-' || c === ' ') h.ops.push({ t: c, text: raw.slice(1) });
    else if (raw === '') h.ops.push({ t: ' ', text: '' }); // tolerate stripped trailing spaces
    // "\ No newline at end of file" and anything else is ignored
  }
  for (const h of hunks) {
    let ln = h.newStart;
    const start = ln;
    const ops = h.ops;
    for (let i = 0; i < ops.length; ) {
      const op = ops[i];
      if (op.t === ' ') {
        ln++;
        i++;
      } else if (op.t === '+') {
        info.added.add(ln);
        info.additions++;
        ln++;
        i++;
      } else {
        const del: string[] = [];
        while (i < ops.length && ops[i].t === '-') del.push(ops[i++].text);
        info.deletions += del.length;
        const anchor = ln;
        let n = 0;
        while (i < ops.length && ops[i].t === '+') {
          info.added.add(ln + n);
          info.additions++;
          n++;
          i++;
        }
        info.removals.push({ anchor, lines: del, replacedBy: n ? { start: ln, end: ln + n - 1 } : undefined });
        ln += n;
      }
    }
    if (ln - 1 >= start) info.hunks.push({ start, end: ln - 1 });
  }
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
