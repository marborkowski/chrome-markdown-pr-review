/**
 * GFM table rows: telling a changed row from an added or removed one, and splitting rows into
 * cells so a changed row can show a word diff per cell instead of one amber line.
 */

const unquote = (l: string) => l.replace(/^(?:[ \t]*>)+[ \t]?/, '');

/** A table row or delimiter row line ("| a | b |", "a | b", "|---|:--:|"). */
export const isTableLine = (l: string) => /\|/.test(unquote(l)) && !!unquote(l).trim();

/** The delimiter row under the header ("| --- | :-: |"). */
export const isDelimiterRow = (l: string) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(unquote(l));

/** The cells of a row, as Markdown source (escaped pipes stay escaped, GFM unescapes them when rendering). */
export function splitRow(line: string): string[] {
  let s = unquote(line).trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') {
      cur += '\\|';
      i++;
    } else if (c === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

const WORD = /[\p{L}\p{N}_]+/gu;

function words(line: string) {
  const m = new Map<string, number>();
  for (const w of line.toLowerCase().match(WORD) ?? []) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
}

function dice(a: Map<string, number>, b: Map<string, number>) {
  let common = 0;
  let total = 0;
  for (const [w, n] of a) {
    common += Math.min(n, b.get(w) ?? 0);
    total += n;
  }
  for (const n of b.values()) total += n;
  return total ? (2 * common) / total : 0;
}

/** How alike two rows are: word overlap, with matching first cells (usually the row's key) weighing in. */
function rowSimilarity(a: string, b: string) {
  const s = dice(words(a), words(b));
  const ka = splitRow(a)[0]?.toLowerCase();
  const kb = splitRow(b)[0]?.toLowerCase();
  return ka && ka === kb ? Math.max(s, 0.5 + s / 2) : s;
}

/** Rows this much alike count as one row that was edited, not one removed and another added. */
const SAME_ROW = 0.34;

/**
 * Pairs old rows with new rows (in order, most similar first, like an LCS weighted by
 * similarity). Returns, for each new row, the index of its old version or -1 when it is new.
 */
export function pairRows(oldRows: string[], newRows: string[]): number[] {
  const n = oldRows.length;
  const k = newRows.length;
  const out = new Array<number>(k).fill(-1);
  if (!n || !k || n * k > 40000) return out;
  const score = oldRows.map((o) => newRows.map((w) => Math.max(0, rowSimilarity(o, w) - SAME_ROW)));
  const best = Array.from({ length: n + 1 }, () => new Array<number>(k + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= k; j++) {
      const s = score[i - 1][j - 1];
      best[i][j] = Math.max(best[i - 1][j], best[i][j - 1], s > 0 ? best[i - 1][j - 1] + s : 0);
    }
  }
  for (let i = n, j = k; i > 0 && j > 0; ) {
    const s = score[i - 1][j - 1];
    if (s > 0 && best[i][j] === best[i - 1][j - 1] + s) {
      out[j - 1] = i - 1;
      i--;
      j--;
    } else if (best[i][j] === best[i - 1][j]) i--;
    else j--;
  }
  return out;
}

/** Two rows render the same (only the padding around cells changed). */
export const sameRow = (a: string, b: string) => {
  const x = splitRow(a).map((c) => c.replace(/\s+/g, ' '));
  const y = splitRow(b).map((c) => c.replace(/\s+/g, ' '));
  return x.length === y.length && x.every((c, i) => c === y[i]);
};
