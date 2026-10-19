import { describe, expect, it } from 'vitest';
import {
  diffDirectives,
  graphDiff,
  isMermaidCode,
  labelDiff,
  mergedSource,
  normalizeLabel,
  pairWidths,
  type DiffColors,
  type GraphShape,
} from '../src/content/lib/mermaidDiff';

/** Just enough of a flowchart parser to turn test sources into GraphShapes the way mermaid would (later label wins). */
function toy(src: string): GraphShape {
  const g: GraphShape = { nodes: new Map(), edges: [] };
  const node = (s: string) => {
    const m = s.trim().match(/^(\w+)(?:[[({]([^\])}]*)[\])}])?$/);
    if (!m) throw new Error(`toy parser: bad node "${s}"`);
    if (m[2] !== undefined || !g.nodes.has(m[1])) g.nodes.set(m[1], m[2] ?? m[1]);
    return m[1];
  };
  for (const raw of src.split('\n')) {
    const l = raw.trim();
    if (!l || /^(graph|flowchart|subgraph|end|direction|classDef|class|style|linkStyle|click)\b|^%%/.test(l)) continue;
    const e = l.match(/^(.+?)\s*-->\s*(?:\|([^|]*)\|\s*)?(.+)$/);
    if (e) g.edges.push({ from: node(e[1]), to: node(e[3]), label: e[2] ?? '' });
    else node(l);
  }
  return g;
}

const light: DiffColors = {
  addedFill: '#dafbe1',
  addedStroke: '#1a7f37',
  removedFill: '#ffebe9',
  removedStroke: '#cf222e',
  changedFill: '#fff8c5',
  changedStroke: '#9a6700',
};

describe('isMermaidCode', () => {
  it('accepts hast className arrays and strings', () => {
    expect(isMermaidCode(['language-mermaid'])).toBe(true);
    expect(isMermaidCode(['hljs', 'language-mermaid'])).toBe(true);
    expect(isMermaidCode('language-mermaid')).toBe(true);
    expect(isMermaidCode('lang-mermaid')).toBe(true);
    expect(isMermaidCode('foo language-Mermaid')).toBe(true);
  });
  it('rejects other languages and junk', () => {
    expect(isMermaidCode(['language-js'])).toBe(false);
    expect(isMermaidCode('language-mermaidjs')).toBe(false);
    expect(isMermaidCode(undefined)).toBe(false);
    expect(isMermaidCode(null)).toBe(false);
    expect(isMermaidCode(42)).toBe(false);
    expect(isMermaidCode([])).toBe(false);
  });
});

describe('mergedSource', () => {
  it('returns the new source when nothing changed', () => {
    const src = 'graph TD\n  A --> B';
    expect(mergedSource(src, src)).toBe(src);
    expect(mergedSource('', src)).toBe(src);
  });

  it('normalises CRLF and trailing newlines', () => {
    expect(mergedSource('graph TD\r\n  A --> B\r\n', 'graph TD\r\n  A --> B\r\n  B --> C\r\n')).toBe('graph TD\n  A --> B\n  B --> C');
    expect(mergedSource('graph TD\n  A --> B', 'graph TD\n  A --> B\n')).toBe('graph TD\n  A --> B');
    expect(mergedSource('graph TD\n  A --> B\n\n\n', 'graph TD\n  A --> B')).toBe('graph TD\n  A --> B');
  });

  it('keeps only the new header line', () => {
    expect(mergedSource('graph TD\n  A --> B', 'flowchart LR\n  A --> B')).toBe('flowchart LR\n  A --> B');
    expect(mergedSource('%%{init: {"theme": "dark"}}%%\ngraph TD\n  A --> B', 'graph LR\n  A --> B')).toBe('graph LR\n  A --> B');
  });

  it('keeps removed node and edge lines in place, old before new', () => {
    const oldSrc = 'graph TD\n  A[Start] --> B[Old]\n  B --> C[End]';
    const newSrc = 'graph TD\n  A[Begin] --> D[New]\n  D --> C[End]';
    expect(mergedSource(oldSrc, newSrc)).toBe('graph TD\n  A[Start] --> B[Old]\n  B --> C[End]\n  A[Begin] --> D[New]\n  D --> C[End]');
  });

  it('drops the frame of a removed subgraph but keeps its nodes, indentation included', () => {
    const oldSrc = ['flowchart TD', '  A --> B', '  subgraph Legacy', '    direction LR', '    L1[Export] --> L2[Archive]', '\tL2 --> L3', '  end', '  B --> L1'].join('\n');
    const newSrc = 'flowchart TD\n  A --> B';
    expect(mergedSource(oldSrc, newSrc)).toBe('flowchart TD\n  A --> B\n    L1[Export] --> L2[Archive]\n\tL2 --> L3\n  B --> L1');
  });

  it('drops removed blank lines, comments and styling lines', () => {
    const oldSrc = [
      'graph TD',
      '  %% old comment',
      '  A --> B',
      '',
      '  classDef hot fill:#f00',
      '  class A hot',
      '  style B fill:#0f0',
      '  linkStyle 0 stroke:#00f',
      '  click A "https://example.com"',
      '  accTitle: Old title',
      '  B --> C',
    ].join('\n');
    expect(mergedSource(oldSrc, 'graph TD\n  A --> B')).toBe('graph TD\n  A --> B\n  B --> C');
  });

  it('does not mistake node ids starting with a keyword for structural lines', () => {
    const oldSrc = 'graph TD\n  endpoint[API] --> graphics\n  classA --> styleGuide\n  A --> B';
    expect(mergedSource(oldSrc, 'graph TD\n  A --> B')).toBe('graph TD\n  endpoint[API] --> graphics\n  classA --> styleGuide\n  A --> B');
  });

  it('keeps a moved line once, even when its indentation changed', () => {
    const oldSrc = 'graph TD\n  A --> B\n  B --> C\n  C --> D';
    expect(mergedSource(oldSrc, 'graph TD\n  B --> C\n  C --> D\n  A --> B')).toBe('graph TD\n  B --> C\n  C --> D\n  A --> B');
    expect(mergedSource(oldSrc, 'graph TD\n  B --> C\n  C --> D\n      A --> B')).toBe('graph TD\n  B --> C\n  C --> D\n      A --> B');
  });

  it('matches moved lines as a multiset', () => {
    const oldSrc = 'graph TD\n  X --> Y\n  X --> Y\n  M --> N\n  N --> O';
    const newSrc = 'graph TD\n  M --> N\n  N --> O\n  X --> Y';
    expect(mergedSource(oldSrc, newSrc)).toBe('graph TD\n  X --> Y\n  M --> N\n  N --> O\n  X --> Y');
  });

  it('keeps unchanged lines inside a subgraph that only gained a node', () => {
    const oldSrc = 'graph TD\n  subgraph S\n    A\n  end\n  B';
    const newSrc = 'graph TD\n  subgraph S\n    A\n    B\n  end';
    expect(mergedSource(oldSrc, newSrc)).toBe(newSrc);
  });

  it('declares a node relabelled inline on an edge line once, so the edge is not duplicated', () => {
    const oldSrc = 'flowchart TD\n  A[Old] --> B\n  B --> C';
    const newSrc = 'flowchart TD\n  A[New] --> B\n  B --> C';
    const merged = mergedSource(oldSrc, newSrc);
    expect(merged).toBe('flowchart TD\n  A[New] --> B\n  B --> C');
    const d = graphDiff(toy(oldSrc), toy(newSrc), toy(merged));
    expect(d.changed).toEqual(['A']);
    expect(toy(merged).edges).toHaveLength(2);
    expect(mergedSource('graph TD\n  A -->|yes| B[Old]', 'graph TD\n  A -->|yes| B[New]')).toBe('graph TD\n  A -->|yes| B[New]');
    expect(mergedSource('graph TD\n  A[Start] --> B', 'graph TD\n  A{Start} --> B')).toBe('graph TD\n  A{Start} --> B');
  });

  it('lets the new label win when a relabelled declaration moved before its old one', () => {
    expect(
      mergedSource('flowchart TD\n  A[Start] --> B[Validate]\n  B --> C[Done]', 'flowchart TD\n  C[Finished]\n  A[Start] --> B[Validate]\n  B --> C'),
    ).toBe('flowchart TD\n  C[Finished]\n  A[Start] --> B[Validate]\n  B --> C');
    expect(mergedSource('flowchart TD\n  A --> B\n  B[Old]', 'flowchart TD\n  B[New]\n  A --> B')).toBe('flowchart TD\n  B[New]\n  A --> B');
  });

  it('still keeps both lines of an edge whose label changed', () => {
    expect(mergedSource('graph TD\n  A -->|yes| B', 'graph TD\n  A -->|no| B')).toBe('graph TD\n  A -->|yes| B\n  A -->|no| B');
  });

  it('pairs removed lines verbatim before pairing them by shape', () => {
    expect(mergedSource('graph TD\n  X[Lbl] --> Y\n  X --> Y\n  M --> N', 'graph TD\n  M --> N\n  X --> Y')).toBe('graph TD\n  X[Lbl] --> Y\n  M --> N\n  X --> Y');
  });
});

describe('pairWidths', () => {
  it('scales the narrower diagram to its share of the wider one', () => {
    expect(pairWidths(400, 800)).toEqual([50, 100]);
    expect(pairWidths(600, 300)).toEqual([100, 50]);
    expect(pairWidths(500, 500)).toEqual([100, 100]);
    expect(pairWidths(0, 0)).toEqual([0, 0]);
  });
});

describe('graphDiff', () => {
  it('classifies nodes and maps edges onto the merged diagram', () => {
    const oldSrc = 'graph TD\n  A[Start] --> B[Old]\n  B --> C[End]';
    const newSrc = 'graph TD\n  A[Begin] --> D[New]\n  D --> C[End]';
    const merged = toy(mergedSource(oldSrc, newSrc));
    expect([...merged.nodes.get('A')!]).toEqual([...'Begin']);
    const d = graphDiff(toy(oldSrc), toy(newSrc), merged);
    expect(d).toEqual({ added: ['D'], removed: ['B'], changed: ['A'], addedEdges: [2, 3], removedEdges: [0, 1] });
  });

  it('reports a label-only change without touching edges', () => {
    const oldSrc = 'graph TD\n  A[One] --> B';
    const newSrc = 'graph TD\n  A[Uno] --> B';
    const d = graphDiff(toy(oldSrc), toy(newSrc), toy(mergedSource(oldSrc, newSrc)));
    expect(d).toEqual({ added: [], removed: [], changed: ['A'], addedEdges: [], removedEdges: [] });
  });

  it('ignores whitespace-only label differences', () => {
    const o: GraphShape = { nodes: new Map([['A', 'Foo  bar ']]), edges: [] };
    const n: GraphShape = { nodes: new Map([['A', 'Foo bar']]), edges: [] };
    expect(graphDiff(o, n, n).changed).toEqual([]);
  });

  it('tells edges apart by label', () => {
    const oldSrc = 'graph TD\n  A -->|yes| B\n  A --> C';
    const newSrc = 'graph TD\n  A -->|no| B\n  A --> C';
    const merged = toy(mergedSource(oldSrc, newSrc));
    expect(merged.edges.map((e) => e.label)).toEqual(['yes', 'no', '']);
    const d = graphDiff(toy(oldSrc), toy(newSrc), merged);
    expect(d.addedEdges).toEqual([1]);
    expect(d.removedEdges).toEqual([0]);
  });

  it('is multiset-aware for duplicate edge keys', () => {
    const oldSrc = 'graph TD\n  X --> Y\n  X --> Y\n  M --> N\n  N --> O';
    const newSrc = 'graph TD\n  M --> N\n  N --> O\n  X --> Y';
    const merged = toy(mergedSource(oldSrc, newSrc));
    expect(merged.edges.length).toBe(4);
    const d = graphDiff(toy(oldSrc), toy(newSrc), merged);
    expect(d.removedEdges).toEqual([0]);
    expect(d.addedEdges).toEqual([]);

    const o: GraphShape = { nodes: new Map([['A', 'A']]), edges: [{ from: 'A', to: 'A', label: '' }] };
    const n: GraphShape = { nodes: new Map([['A', 'A']]), edges: [{ from: 'A', to: 'A', label: '' }, { from: 'A', to: 'A', label: '' }] };
    expect(graphDiff(o, n, n).addedEdges).toEqual([0]); // exactly one of the two identical copies
  });

  it('marks edges of a removed subgraph as removed', () => {
    const oldSrc = 'flowchart TD\n  A --> B\n  subgraph Legacy\n    L1[Export] --> L2[Archive]\n  end\n  B --> L1';
    const newSrc = 'flowchart TD\n  A --> B';
    const d = graphDiff(toy(oldSrc), toy(newSrc), toy(mergedSource(oldSrc, newSrc)));
    expect(d.removed.sort()).toEqual(['L1', 'L2']);
    expect(d.removedEdges).toEqual([1, 2]);
    expect(d.addedEdges).toEqual([]);
  });
});

describe('diffDirectives', () => {
  it('emits one classDef/class pair per group and one linkStyle per edge', () => {
    const out = diffDirectives({ added: ['A', 'B'], removed: ['C'], changed: ['D'], addedEdges: [2], removedEdges: [4, 5] }, light);
    expect(out).toBe(
      [
        '',
        'classDef mdrAdded fill:#dafbe1,stroke:#1a7f37,stroke-width:2px,color:#1a7f37',
        'class A,B mdrAdded',
        'classDef mdrRemoved fill:#ffebe9,stroke:#cf222e,stroke-width:2px,stroke-dasharray:5 3,color:#cf222e',
        'class C mdrRemoved',
        'classDef mdrChanged fill:#fff8c5,stroke:#9a6700,stroke-width:2px',
        'class D mdrChanged',
        'linkStyle 2 stroke:#1a7f37,stroke-width:2.5px',
        'linkStyle 4 stroke:#cf222e,stroke-width:2.5px,stroke-dasharray:5 3',
        'linkStyle 5 stroke:#cf222e,stroke-width:2.5px,stroke-dasharray:5 3',
      ].join('\n'),
    );
  });

  it('emits nothing for an empty diff and only the needed groups otherwise', () => {
    expect(diffDirectives({ added: [], removed: [], changed: [], addedEdges: [], removedEdges: [] }, light)).toBe('');
    const out = diffDirectives({ added: [], removed: ['X'], changed: [], addedEdges: [], removedEdges: [] }, light);
    expect(out).toBe('\nclassDef mdrRemoved fill:#ffebe9,stroke:#cf222e,stroke-width:2px,stroke-dasharray:5 3,color:#cf222e\nclass X mdrRemoved');
    expect(out).not.toContain('mdrAdded');
    expect(out).not.toContain('linkStyle');
  });

  it('skips ids that would break a class statement', () => {
    const out = diffDirectives({ added: ['ok', 'has space', 'a,b', 'tab\tbed'], removed: ['x y'], changed: [], addedEdges: [], removedEdges: [] }, light);
    expect(out).toBe('\nclassDef mdrAdded fill:#dafbe1,stroke:#1a7f37,stroke-width:2px,color:#1a7f37\nclass ok mdrAdded');
  });

  it('can be appended straight onto a source', () => {
    const src = 'graph TD\n  A --> B';
    const out = src + diffDirectives({ added: ['B'], removed: [], changed: [], addedEdges: [0], removedEdges: [] }, light);
    expect(out.split('\n')).toEqual(['graph TD', '  A --> B', 'classDef mdrAdded fill:#dafbe1,stroke:#1a7f37,stroke-width:2px,color:#1a7f37', 'class B mdrAdded', 'linkStyle 0 stroke:#1a7f37,stroke-width:2.5px']);
  });
});

describe('labelDiff', () => {
  it('finds labels present on one side only', () => {
    const d = labelDiff(['Alice', 'Bob', 'hello'], ['Alice', 'Carol', 'hello']);
    expect([...d.added]).toEqual(['Carol']);
    expect([...d.removed]).toEqual(['Bob']);
  });

  it('normalises whitespace and ignores empty labels', () => {
    const d = labelDiff(['  Ping   server ', '', '  '], ['Ping server', 'Pong', '']);
    expect([...d.added]).toEqual(['Pong']);
    expect(d.removed.size).toBe(0);
  });

  it('is a multiset difference', () => {
    const d = labelDiff(['ack', 'ack', 'ack'], ['ack']);
    expect([...d.removed]).toEqual(['ack']);
    expect(d.added.size).toBe(0);
    const e = labelDiff(['ack'], ['ack', 'ack']);
    expect([...e.added]).toEqual(['ack']);
    expect(e.removed.size).toBe(0);
    expect(labelDiff(['a', 'b'], ['b', 'a']).added.size + labelDiff(['a', 'b'], ['b', 'a']).removed.size).toBe(0);
  });
});

describe('normalizeLabel', () => {
  it('collapses whitespace', () => {
    expect(normalizeLabel('  a \n\t b  ')).toBe('a b');
    expect(normalizeLabel('')).toBe('');
  });
});
