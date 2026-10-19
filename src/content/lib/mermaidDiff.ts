import { diffLines } from 'diff';

// Pure helpers behind the Mermaid "Changes" view. No mermaid import: this runs in Node (tests)
// and must stay out of the big mermaid bundle's way.

/** What the diagram diff needs from a parsed flowchart: vertex id → label, edges in parser order. */
export interface GraphShape {
  nodes: Map<string, string>;
  edges: { from: string; to: string; label: string }[];
}

/** hast `className` (array or string) of a <code> element marks a mermaid fence. */
export const isMermaidCode = (className: unknown): boolean => {
  const names = Array.isArray(className) ? className : typeof className === 'string' ? className.split(/\s+/) : [];
  return names.some((n) => typeof n === 'string' && /^(language|lang)-mermaid$/i.test(n));
};

/** Lines that only shape or style a flowchart: dropping their removed version keeps the merged source valid. */
const STRUCTURAL = /^\s*(subgraph\b|end\b|direction\b|classDef\b|class\b|style\b|linkStyle\b|click\b|%%|graph\b|flowchart\b|accTitle|accDescr|title\b)/;

/** CRLF → LF, no trailing blank lines, exactly one trailing newline so every line is a full diff token. */
const normalizeSource = (s: string) => s.replace(/\r\n?/g, '\n').replace(/\s+$/, '') + '\n';

const splitLines = (value: string) => {
  const ls = value.split('\n');
  if (ls[ls.length - 1] === '') ls.pop();
  return ls;
};

/**
 * The line without its bracketed node labels / shapes (bracket pairs removed inside-out),
 * whitespace collapsed: the same node or edge however it is labelled. `|edge labels|` stay,
 * so a relabelled edge still yields a removed + an added edge.
 */
const shapeKey = (l: string) => {
  let s = l.trim();
  for (let prev = ''; prev !== s; ) {
    prev = s;
    s = s.replace(/\[[^[\]]*\]|\([^()]*\)|\{[^{}]*\}/g, '');
  }
  return s.replace(/\s+/g, ' ');
};

const take = (m: Map<string, number>, k: string) => {
  const n = m.get(k) ?? 0;
  if (n > 0) m.set(k, n - 1);
  return n > 0;
};
const add = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/**
 * Union of both versions of a flowchart, in order: everything in the new version plus the
 * removed lines that still make sense on their own (nodes, edges). Removed blank lines,
 * structural / styling lines (so a removed subgraph loses its `subgraph … end` frame but keeps
 * the nodes inside) and lines that merely moved or only changed a node's label / shape are
 * left out, so the new header line wins and a relabelled node is declared once, with its new
 * label. Each added line pairs with at most one removed line: first verbatim, then by shape.
 * Removed lines are kept verbatim, indentation included.
 */
export function mergedSource(oldText: string, newText: string): string {
  const parts = diffLines(normalizeSource(oldText), normalizeSource(newText));
  const lines: { text: string; removed: boolean }[] = [];
  const owedExact = new Map<string, number>();
  const owedShape = new Map<string, number>();
  for (const p of parts) {
    for (const l of splitLines(p.value)) {
      if (p.removed && (!l.trim() || STRUCTURAL.test(l))) continue;
      lines.push({ text: l, removed: !!p.removed });
      if (p.added) {
        add(owedExact, l.trim());
        add(owedShape, shapeKey(l));
      }
    }
  }
  const removed = lines.filter((e) => e.removed);
  const drop = new Set<(typeof lines)[number]>();
  // A removed line that reappears verbatim among the added lines merely moved: keep the added copy only.
  for (const e of removed) {
    if (take(owedExact, e.text.trim())) {
      drop.add(e);
      take(owedShape, shapeKey(e.text));
    }
  }
  // One that differs from an added line only by node labels / shapes was relabelled: the added line shows it.
  for (const e of removed) if (!drop.has(e) && take(owedShape, shapeKey(e.text))) drop.add(e);
  return lines
    .filter((e) => !drop.has(e))
    .map((e) => e.text)
    .join('\n');
}

/**
 * Percentage widths that draw a Before / After pair at one scale: the wider diagram fills
 * its pane, the narrower one takes the share its viewBox width gives it.
 */
export function pairWidths(before: number, after: number): [number, number] {
  const max = Math.max(before, after, 1);
  return [(before / max) * 100, (after / max) * 100];
}

export interface GraphDiff {
  added: string[];
  removed: string[];
  changed: string[];
  /** Indices into the merged graph's edges (mermaid's linkStyle numbering). */
  addedEdges: number[];
  removedEdges: number[];
}

export const normalizeLabel = (s: string) => s.replace(/\s+/g, ' ').trim();

const edgeKey = (e: GraphShape['edges'][number]) => `${e.from}|${e.to}|${e.label}`;

const counts = (keys: Iterable<string>) => {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
};

/** Keys of `a` not covered by `b`, counted (multiset difference). */
function owed(a: Map<string, number>, b: Map<string, number>) {
  const m = new Map<string, number>();
  for (const [k, n] of a) {
    const left = n - (b.get(k) ?? 0);
    if (left > 0) m.set(k, left);
  }
  return m;
}

/**
 * Nodes added / removed / relabelled between two flowcharts, and which edges of the merged
 * diagram are new or gone. Edges are matched by `from|to|label` as multisets, so a duplicated
 * edge that lost one copy marks exactly one of the merged edges removed.
 */
export function graphDiff(oldG: GraphShape, newG: GraphShape, mergedG: GraphShape): GraphDiff {
  const added = [...newG.nodes.keys()].filter((id) => !oldG.nodes.has(id));
  const removed = [...oldG.nodes.keys()].filter((id) => !newG.nodes.has(id));
  const changed = [...newG.nodes.keys()].filter(
    (id) => oldG.nodes.has(id) && normalizeLabel(oldG.nodes.get(id)!) !== normalizeLabel(newG.nodes.get(id)!),
  );

  const oldKeys = counts(oldG.edges.map(edgeKey));
  const newKeys = counts(newG.edges.map(edgeKey));
  const removedOwed = owed(oldKeys, newKeys);
  const addedOwed = owed(newKeys, oldKeys);
  const addedEdges: number[] = [];
  const removedEdges: number[] = [];
  mergedG.edges.forEach((e, i) => {
    const key = edgeKey(e);
    const r = removedOwed.get(key) ?? 0;
    if (r > 0) {
      removedOwed.set(key, r - 1);
      removedEdges.push(i);
      return;
    }
    const a = addedOwed.get(key) ?? 0;
    if (a > 0) {
      addedOwed.set(key, a - 1);
      addedEdges.push(i);
    }
  });
  return { added, removed, changed, addedEdges, removedEdges };
}

export interface DiffColors {
  addedFill: string;
  addedStroke: string;
  removedFill: string;
  removedStroke: string;
  changedFill: string;
  changedStroke: string;
}

/** An id that can sit in a `class a,b name` statement. */
const safeId = (id: string) => !/[\s,]/.test(id);

/**
 * Flowchart directives colouring the diff, to append to the merged source: a classDef + class
 * line per non-empty node group and a linkStyle line per changed edge. Each line starts with a
 * newline, so the result can be concatenated straight onto the source; '' when nothing changed.
 */
export function diffDirectives(d: GraphDiff, c: DiffColors): string {
  const out: string[] = [];
  const group = (ids: string[], name: string, def: string) => {
    const safe = ids.filter(safeId);
    if (!safe.length) return;
    out.push(`classDef ${name} ${def}`, `class ${safe.join(',')} ${name}`);
  };
  group(d.added, 'mdrAdded', `fill:${c.addedFill},stroke:${c.addedStroke},stroke-width:2px,color:${c.addedStroke}`);
  group(d.removed, 'mdrRemoved', `fill:${c.removedFill},stroke:${c.removedStroke},stroke-width:2px,stroke-dasharray:5 3,color:${c.removedStroke}`);
  group(d.changed, 'mdrChanged', `fill:${c.changedFill},stroke:${c.changedStroke},stroke-width:2px`);
  for (const i of d.addedEdges) out.push(`linkStyle ${i} stroke:${c.addedStroke},stroke-width:2.5px`);
  for (const i of d.removedEdges) out.push(`linkStyle ${i} stroke:${c.removedStroke},stroke-width:2.5px,stroke-dasharray:5 3`);
  return out.map((l) => '\n' + l).join('');
}

/**
 * Labels present only on one side (multiset difference of whitespace-normalised labels, empty
 * ones ignored): drives the Before / After highlighting of diagram types we don't merge.
 */
export function labelDiff(oldLabels: string[], newLabels: string[]): { added: Set<string>; removed: Set<string> } {
  const o = counts(oldLabels.map(normalizeLabel).filter(Boolean));
  const n = counts(newLabels.map(normalizeLabel).filter(Boolean));
  return { added: new Set(owed(n, o).keys()), removed: new Set(owed(o, n).keys()) };
}
