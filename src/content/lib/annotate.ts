import type { Element, ElementContent, Root, Parent } from 'hast';
import { visit } from 'unist-util-visit';
import { similarity, splitRemoved, wordCounts } from './inlineDiff';
import type { DiffInfo, Removal } from './patch';
import { isDelimiterRow, isTableLine, pairRows, sameRow, splitRow } from './tables';

/** Elements that represent a block of source lines and can own changes, threads and comments. */
export const BLOCK_TAGS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'pre', 'tr', 'blockquote', 'table', 'hr',
  'ul', 'ol', 'dl', 'dt', 'dd', 'div', 'details', 'summary',
] as const;
const BLOCK = new Set<string>(BLOCK_TAGS);
const CONTAINERS = new Set(['ul', 'ol', 'table', 'blockquote', 'dl', 'details', 'div']);
/** Sibling blocks of these kinds share out a replacement spanning them instead of folding it into the first one. */
const SPLIT_TAGS = new Set(['li', 'p']);
const hasBlocks = (n: Element): boolean => n.children.some((c) => c.type === 'element' && (BLOCK.has(c.tagName) || hasBlocks(c)));

/**
 * Old and new text with too little in common for a word diff to help: a paragraph rewritten from
 * scratch reads better as the old text removed and the new text added.
 */
function unrelated(oldLines: string[], newLines: string[]) {
  const a = wordCounts(oldLines);
  const b = wordCounts(newLines);
  const size = (m: Map<string, number>) => [...m.values()].reduce((x, y) => x + y, 0);
  return size(a) >= 8 && size(b) >= 8 && similarity(a, b) < 0.25;
}

export interface AnnotateOptions {
  diff: DiffInfo | null;
  lines: string[];
  threadLines: number[];
  pendingLines: number[];
  activeRange: [number, number] | null;
  /** Whitespace-only changes are hidden: a table row that only got re-padded counts as unchanged. */
  ignoreWhitespace?: boolean;
}

interface BlockRec {
  node: Element;
  parent: Parent;
  sl: number;
  el: number;
  order: number;
}

function addClass(node: Element, cls: string) {
  const cur = node.properties.className;
  const list = Array.isArray(cur) ? cur.map(String) : typeof cur === 'string' ? cur.split(' ') : [];
  if (!list.includes(cls)) list.push(cls);
  node.properties.className = list;
}

function appendIdx(node: Element, key: string, i: number | string) {
  const cur = node.properties[key];
  node.properties[key] = cur === undefined || cur === null || cur === '' ? String(i) : `${cur} ${i}`;
}

function bump(node: Element, key: string) {
  node.properties[key] = Number(node.properties[key] ?? 0) + 1;
}

function removeClass(node: Element, cls: string) {
  const cur = node.properties.className;
  if (Array.isArray(cur)) node.properties.className = cur.filter((c) => c !== cls);
}

const hasClass = (node: Element, cls: string) => Array.isArray(node.properties.className) && node.properties.className.includes(cls);

/** A table row that is gone, shown inside its table (rendered from the removal's line by the tr component). */
const removedRow = (i: number, k: number, oldLine: number): Element => ({
  type: 'element',
  tagName: 'tr',
  properties: { className: ['mdr-removed-row'], dataRemovedRow: `${i}:${k}`, dataOsl: oldLine, dataOel: oldLine },
  children: [],
});

/**
 * rehype plugin: tags every element with its source line range (data-sl / data-el)
 * and marks the smallest block owning each changed / commented line.
 */
export function rehypeAnnotate(opts: AnnotateOptions) {
  return (tree: Root) => {
    const blocks: BlockRec[] = [];
    visit(tree, 'element', (node: Element, _i, parent) => {
      const pos = node.position;
      if (!pos) return;
      node.properties.dataSl = pos.start.line;
      node.properties.dataEl = pos.end.line;
      if (BLOCK.has(node.tagName) && parent) {
        node.properties.dataBlock = '';
        blocks.push({ node, parent: parent as Parent, sl: pos.start.line, el: pos.end.line, order: blocks.length });
      }
    });

    const ownerCache = new Map<number, BlockRec | null>();
    const ownerOf = (line: number): BlockRec | null => {
      if (ownerCache.has(line)) return ownerCache.get(line)!;
      let best: BlockRec | null = null;
      for (const b of blocks) {
        if (b.sl <= line && line <= b.el) {
          if (!best || b.el - b.sl < best.el - best.sl || (b.el - b.sl === best.el - best.sl && b.order > best.order)) best = b;
        }
      }
      ownerCache.set(line, best);
      return best;
    };
    const isBlank = (line: number) => !(opts.lines[line - 1] ?? '').trim();

    /** Each block's slice of a replacement's removed lines when it spans sibling list items or paragraphs, else null. */
    const splitAmong = (r: Removal, first: number, group: BlockRec[]) => {
      const [o] = group;
      const last = group[group.length - 1];
      if (group.length < 2 || !SPLIT_TAGS.has(o.node.tagName)) return null;
      if (group.some((b) => b.node.tagName !== o.node.tagName || b.parent !== o.parent || hasBlocks(b.node))) return null;
      const { start, end } = r.replacedBy!;
      const shown = group.map((b) => opts.lines.slice(Math.max(b.sl, start) - 1, Math.min(b.el, end)));
      return splitRemoved(r.lines, shown, o.node.tagName, o.sl < first, last.el > end);
    };

    const { diff } = opts;
    if (diff) {
      for (const l of diff.added) {
        if (isBlank(l)) continue;
        const o = ownerOf(l);
        if (!o) continue;
        // A table's delimiter row has no element of its own: a new one doesn't make the whole table new.
        if (o.node.tagName === 'table' && isDelimiterRow(opts.lines[l - 1] ?? '')) continue;
        const from = diff.moved.get(l);
        if (from === undefined) addClass(o.node, 'mdr-added');
        else {
          addClass(o.node, 'mdr-moved');
          o.node.properties.dataMovedFrom = from;
        }
      }
      // A moved block that also contains new lines is a change like any other.
      for (const b of blocks) if (hasClass(b.node, 'mdr-added') && hasClass(b.node, 'mdr-moved')) removeClass(b.node, 'mdr-moved');
      for (const r of diff.reflowed) {
        for (let l = r.start; l <= r.end; l++) {
          const o = isBlank(l) ? null : ownerOf(l);
          if (o && !hasClass(o.node, 'mdr-added') && !hasClass(o.node, 'mdr-mod')) addClass(o.node, 'mdr-reflow');
        }
      }

      /** Rows to insert into tables (removed rows), and removed blocks to insert before the block that follows them. */
      const rowInserts: { parent: Parent; node: Element; ref: Element; after: boolean }[] = [];
      /**
       * The removed lines as rows of a table with `cols` columns, or null when they aren't rows:
       * every line must look like one (a leading or trailing pipe, or exactly the table's cell
       * count – prose with a `|` in it doesn't count), with no blank line among them.
       */
      const tableRows = (r: Removal, cols: number) => {
        const rows = r.lines.map((l, k) => [l, k] as const).filter(([l]) => l.trim());
        if (!rows.length || rows[rows.length - 1][1] - rows[0][1] + 1 !== rows.length) return null;
        const isRow = (l: string) => isTableLine(l) && (/^\s*\|/.test(l) || /\|\s*$/.test(l) || splitRow(l).length === cols);
        return rows.every(([l]) => isRow(l)) ? rows.filter(([l]) => !isDelimiterRow(l)) : null;
      };
      const colsOf = (b: BlockRec) => splitRow(opts.lines[b.sl - 1] ?? '').length;

      /** A replacement made only of table rows: pair old and new rows, so edited rows get a cell diff and removed rows stay in the table. */
      const replaceRows = (r: Removal, i: number): boolean => {
        const rows: BlockRec[] = [];
        for (let l = r.replacedBy!.start; l <= r.replacedBy!.end; l++) {
          if (isBlank(l)) continue;
          const o = ownerOf(l);
          if (!o) return false;
          if (o.node.tagName === 'table' && isDelimiterRow(opts.lines[l - 1] ?? '')) continue;
          if (o.node.tagName !== 'tr') return false;
          if (!rows.includes(o)) rows.push(o);
        }
        if (!rows.length) return false;
        const old = tableRows(r, colsOf(rows[0]));
        if (!old) return false;
        const pairs = pairRows(old.map(([l]) => l), rows.map((b) => opts.lines[b.sl - 1] ?? ''));
        appendIdx(rows[0].node, 'dataMods', i);
        rows.forEach((b, j) => {
          if (pairs[j] < 0) return;
          const [text, k] = old[pairs[j]];
          removeClass(b.node, 'mdr-added');
          if (sameRow(text, opts.lines[b.sl - 1] ?? '')) {
            if (opts.ignoreWhitespace) addClass(b.node, 'mdr-reflow');
            else addClass(b.node, 'mdr-mod');
            return;
          }
          addClass(b.node, 'mdr-mod');
          b.node.properties.dataRowOld = `${i}:${k}`;
        });
        const paired = new Set(pairs.filter((p) => p >= 0));
        old.forEach(([, k], p) => {
          if (paired.has(p)) return;
          const j = pairs.findIndex((q) => q > p);
          const ref = j >= 0 ? rows[j] : rows[rows.length - 1];
          rowInserts.push({ parent: ref.parent, node: removedRow(i, k, r.oldStart + k), ref: ref.node, after: j < 0 });
        });
        return true;
      };

      const inserts: { parent: Parent; before: Element | null; idx: number; more: number[] }[] = [];
      /** Every removed line was moved elsewhere. */
      const allMoved = (r: Removal) => {
        const moved = new Set<number>();
        for (const m of r.moved ?? []) for (let k = m.from; k < m.to; k++) moved.add(k);
        return moved.size > 0 && r.lines.every((l, k) => !l.trim() || moved.has(k));
      };
      /** Only blank or new lines between two removals: in the old file they were neighbours. */
      const besides = (a: Removal, b: Removal) => {
        for (let l = a.anchor; l < b.anchor; l++) if (!diff.added.has(l) && !isBlank(l)) return false;
        return true;
      };
      diff.removals.forEach((r, i) => {
        if (r.replacedBy && replaceRows(r, i)) return;
        if (!r.replacedBy) {
          // Rows deleted from inside or from the end of a table stay in it, struck out. Lines deleted
          // right before a table weren't part of it (they'd land above its header).
          const next = ownerOf(r.anchor);
          const prev = ownerOf(r.anchor - 1);
          const afterRow = prev?.node.tagName === 'tr';
          const afterHeader = prev?.node.tagName === 'table' && isDelimiterRow(opts.lines[r.anchor - 2] ?? '') && next?.node.tagName === 'tr';
          const ref = afterRow ? prev : afterHeader ? next : null;
          const rows = ref ? tableRows(r, colsOf(ref)) : null;
          if (ref && rows) {
            rows.forEach(([, k]) => rowInserts.push({ parent: ref.parent, node: removedRow(i, k, r.oldStart + k), ref: ref.node, after: afterRow }));
            return;
          }
        }
        if (r.replacedBy) {
          let first = -1;
          for (let l = r.replacedBy.start; l <= r.replacedBy.end; l++) if (!isBlank(l)) { first = l; break; }
          const o = first > 0 ? ownerOf(first) : null;
          // Replaced by a container (raw HTML <details>, a callout, …) or by unrelated text: removed + added, not a word diff.
          if (o && (CONTAINERS.has(o.node.tagName) || unrelated(r.lines, opts.lines.slice(r.replacedBy.start - 1, r.replacedBy.end)))) {
            inserts.push({ parent: o.parent, before: o.node, idx: i, more: [] });
            return;
          }
          if (o) {
            const group = [o];
            let cut = false;
            for (let l = first + 1; l <= r.replacedBy.end; l++) {
              if (isBlank(l)) continue;
              const c = ownerOf(l);
              if (!c || group.includes(c) || CONTAINERS.has(c.node.tagName)) continue;
              // A code block can't be shown inside another block's word diff: a new one stays its own added block.
              if (c.node.tagName === 'pre') {
                cut = true;
                break;
              }
              group.push(c);
            }
            const parts = splitAmong(r, first, group);
            if (parts) {
              // Each block shows its own share; the first one that had removed lines owns the change.
              const owner = group.find((_, k) => parts[k][1] > parts[k][0]) ?? o;
              appendIdx(owner.node, 'dataMods', i);
              addClass(owner.node, 'mdr-mod');
              group.forEach((b, k) => appendIdx(b.node, 'dataModPart', `${i}:${parts[k][0]}:${parts[k][1]}`));
              return;
            }
            appendIdx(o.node, 'dataMods', i);
            addClass(o.node, 'mdr-mod');
            for (const c of group.slice(1)) appendIdx(c.node, 'dataModCont', i);
            // The owner's share stops before the code block: all removed lines against the new lines up to it.
            if (cut) appendIdx(o.node, 'dataModPart', `${i}:0:${r.lines.length}`);
            // Blocks continuing the change are rendered inside the owner's inline diff, whole.
            const reach = Math.max(...group.map((b) => b.el));
            if (reach > o.el) o.node.properties.dataModEl = Math.max(Number(o.node.properties.dataModEl ?? 0), reach);
            return;
          }
        }
        // Lines removed from the middle of a block (e.g. a paragraph or code block)?
        const inside = ownerOf(r.anchor);
        if (inside && inside.sl < r.anchor && !CONTAINERS.has(inside.node.tagName)) {
          appendIdx(inside.node, 'dataMods', i);
          addClass(inside.node, 'mdr-mod');
          return;
        }
        // A section moved away in several pieces (git split it around new text) gets one marker.
        const last = inserts[inserts.length - 1];
        const prev = last && diff.removals[last.more.length ? last.more[last.more.length - 1] : last.idx];
        if (last && !r.replacedBy && allMoved(r) && prev && !prev.replacedBy && allMoved(prev) && last.idx + last.more.length === i - 1 && besides(prev, r)) {
          last.more.push(i);
          return;
        }
        // Otherwise show a standalone "removed" block before the next block.
        const target = blocks.find((b) => b.sl >= r.anchor);
        inserts.push(target ? { parent: target.parent, before: target.node, idx: i, more: [] } : { parent: tree, before: null, idx: i, more: [] });
      });

      // Insert after the reference row in order: keep a running cursor per reference.
      const after = new Map<Element, Element>();
      for (const ins of rowInserts) {
        const kids = ins.parent.children as ElementContent[];
        if (ins.after) {
          const prev = after.get(ins.ref) ?? ins.ref;
          kids.splice(kids.indexOf(prev) + 1, 0, ins.node);
          after.set(ins.ref, ins.node);
        } else {
          kids.splice(kids.indexOf(ins.ref), 0, ins.node);
        }
      }

      for (const ins of inserts) {
        const node: Element = {
          type: 'element',
          tagName: 'div',
          properties: { className: ['mdr-removed'], dataRemoval: ins.idx, ...(ins.more.length ? { dataRemovalMore: ins.more.join(' ') } : {}) },
          children: [],
        };
        const kids = ins.parent.children as ElementContent[];
        const at = ins.before ? kids.indexOf(ins.before) : -1;
        if (at >= 0) kids.splice(at, 0, node);
        else kids.push(node);
      }
    }

    for (const l of opts.threadLines) {
      const o = ownerOf(l);
      if (o) bump(o.node, 'dataThreads');
    }
    for (const l of opts.pendingLines) {
      const o = ownerOf(l);
      if (o) bump(o.node, 'dataPending');
    }
    if (opts.activeRange) {
      const [a, b] = opts.activeRange;
      for (let l = a; l <= b; l++) {
        const o = ownerOf(l);
        if (o) addClass(o.node, 'mdr-active');
      }
    }
  };
}
