import type { Element, ElementContent, Root, Parent } from 'hast';
import { visit } from 'unist-util-visit';
import type { DiffInfo } from './patch';

/** Elements that represent a block of source lines and can own changes, threads and comments. */
export const BLOCK_TAGS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'pre', 'tr', 'blockquote', 'table', 'hr',
  'ul', 'ol', 'dl', 'dt', 'dd', 'div', 'details', 'summary',
] as const;
const BLOCK = new Set<string>(BLOCK_TAGS);
const CONTAINERS = new Set(['ul', 'ol', 'table', 'blockquote', 'dl', 'details', 'div']);

export interface AnnotateOptions {
  diff: DiffInfo | null;
  lines: string[];
  threadLines: number[];
  pendingLines: number[];
  activeRange: [number, number] | null;
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

function appendIdx(node: Element, key: string, i: number) {
  const cur = node.properties[key];
  node.properties[key] = cur === undefined || cur === null || cur === '' ? String(i) : `${cur} ${i}`;
}

function bump(node: Element, key: string) {
  node.properties[key] = Number(node.properties[key] ?? 0) + 1;
}

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

    const { diff } = opts;
    if (diff) {
      for (const l of diff.added) {
        if (isBlank(l)) continue;
        const o = ownerOf(l);
        if (o) addClass(o.node, 'mdr-added');
      }

      const inserts: { parent: Parent; before: Element | null; idx: number }[] = [];
      diff.removals.forEach((r, i) => {
        if (r.replacedBy) {
          let first = -1;
          for (let l = r.replacedBy.start; l <= r.replacedBy.end; l++) if (!isBlank(l)) { first = l; break; }
          const o = first > 0 ? ownerOf(first) : null;
          if (o) {
            appendIdx(o.node, 'dataMods', i);
            addClass(o.node, 'mdr-mod');
            const seen = new Set([o]);
            let reach = o.el;
            for (let l = first + 1; l <= r.replacedBy.end; l++) {
              if (isBlank(l)) continue;
              const c = ownerOf(l);
              if (c && !seen.has(c) && !CONTAINERS.has(c.node.tagName)) {
                seen.add(c);
                appendIdx(c.node, 'dataModCont', i);
                reach = Math.max(reach, c.el);
              }
            }
            // Blocks continuing the change are rendered inside the owner's inline diff, whole.
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
        // Otherwise show a standalone "removed" block before the next block.
        const target = blocks.find((b) => b.sl >= r.anchor);
        inserts.push(target ? { parent: target.parent, before: target.node, idx: i } : { parent: tree, before: null, idx: i });
      });

      for (const ins of inserts) {
        const node: Element = {
          type: 'element',
          tagName: 'div',
          properties: { className: ['mdr-removed'], dataRemoval: ins.idx },
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
