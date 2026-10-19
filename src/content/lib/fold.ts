import type { Element, ElementContent, Root } from 'hast';

/**
 * rehype plugin (after rehypeAnnotate): "changes only" reading. Runs of top-level blocks with
 * nothing to review (no change, no comment, not next to one) are folded into one expandable
 * placeholder. Headings always stay, so the document keeps its outline and every change is
 * seen in its section.
 */

const MARKS = ['mdr-added', 'mdr-mod', 'mdr-moved', 'mdr-removed', 'mdr-removed-row', 'mdr-active'];
const PROPS = ['dataThreads', 'dataPending', 'dataMods', 'dataModCont', 'dataModPart', 'dataRemoval'];

function interesting(n: ElementContent): boolean {
  if (n.type !== 'element') return false;
  const cls = Array.isArray(n.properties.className) ? n.properties.className.map(String) : [];
  if (cls.some((c) => MARKS.includes(c))) return true;
  if (PROPS.some((p) => n.properties[p] !== undefined)) return true;
  return n.children.some(interesting);
}

const kept = (n: Element) => /^h[1-6]$/.test(n.tagName) || n.properties.dataFootnotes !== undefined || n.properties.dataFrontmatter !== undefined;

export interface FoldOptions {
  enabled: boolean;
  /** Unchanged blocks kept around each change. */
  context?: number;
}

export function rehypeFold(opts: FoldOptions) {
  return (tree: Root) => {
    if (!opts.enabled) return;
    const context = opts.context ?? 1;
    const els = tree.children.filter((n): n is Element => n.type === 'element');
    const hot = els.map(interesting);
    if (!hot.some(Boolean)) return;
    const near = els.map((n, i) => kept(n) || hot.slice(Math.max(0, i - context), i + context + 1).some(Boolean));

    const out: Root['children'] = [];
    let run: Element[] = [];
    const flush = () => {
      if (run.length >= 2) {
        const first = run[0].position?.start.line;
        const last = run[run.length - 1].position?.end.line;
        out.push({
          type: 'element',
          tagName: 'div',
          properties: { className: ['mdr-fold'], dataFold: run.length, dataFoldSl: first, dataFoldEl: last },
          children: run,
        });
      } else out.push(...run);
      run = [];
    };
    let k = 0;
    for (const n of tree.children) {
      if (n.type !== 'element') {
        if (!run.length) out.push(n);
        continue;
      }
      if (near[k++]) {
        flush();
        out.push(n);
      } else run.push(n);
    }
    flush();
    tree.children = out;
  };
}
