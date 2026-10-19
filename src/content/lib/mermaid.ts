// Loads mermaid lazily from dist/mermaid.js (a separate ESM bundle exposed through
// web_accessible_resources) and wraps the two calls the diagram UI needs: parsing a
// diagram into its vertices/edges and rendering it to SVG markup.

declare global {
  interface Window {
    __MDR_MERMAID_URL__?: string;
  }
}

export type Theme = 'light' | 'dark';

export interface MermaidGraph {
  /** mermaid's diagram type id, e.g. 'flowchart-v2' or 'sequence'. */
  type: string;
  /** vertex id → label text; only filled for flowcharts. */
  nodes: Map<string, string>;
  /** edges in parser order; only filled for flowcharts. */
  edges: { from: string; to: string; label: string }[];
}

export const isFlowchart = (type: string) => /^flowchart|^graph/.test(type);

const baseConfig = {
  startOnLoad: false,
  securityLevel: 'strict',
  suppressErrorRendering: true,
  fontFamily: 'inherit',
} as const;

const themeName = (theme: Theme) => (theme === 'dark' ? 'dark' : 'default');

let loading: Promise<any> | undefined;
let lastTheme: Theme = 'light';
let counter = 0;

/** Imports mermaid once and initializes it (light theme); a failed import is retried on the next call. */
export function loadMermaid(): Promise<any> {
  if (!loading) {
    loading = (async () => {
      const url = window.__MDR_MERMAID_URL__ ?? chrome.runtime.getURL('mermaid.js');
      const mod = await import(/* @vite-ignore */ url);
      const mermaid = mod.default;
      mermaid.initialize({ ...baseConfig, theme: themeName(lastTheme) });
      return mermaid;
    })();
    loading.catch(() => {
      loading = undefined;
    });
  }
  return loading;
}

/** mermaid throws Errors, strings and `{ str, hash }` objects; reduce them to one readable message. */
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  const str = (e as { str?: unknown } | null)?.str;
  return typeof str === 'string' ? str : String(e);
}

/** Parses `text`; throws a plain Error with mermaid's message when the diagram doesn't parse. */
export async function parseMermaid(text: string): Promise<MermaidGraph> {
  const mermaid = await loadMermaid();
  let diagram: any;
  try {
    diagram = await mermaid.mermaidAPI.getDiagramFromText(text);
  } catch (e) {
    throw new Error(errorMessage(e));
  }
  const type: string = diagram.type;
  const nodes = new Map<string, string>();
  const edges: MermaidGraph['edges'] = [];
  if (isFlowchart(type)) {
    const db = diagram.db;
    for (const [id, v] of db.getVertices() as Map<string, { text?: string }>) nodes.set(id, v.text ?? id);
    for (const e of db.getEdges() as { start: string; end: string; text?: string }[]) {
      edges.push({ from: e.start, to: e.end, label: e.text ?? '' });
    }
  }
  return { type, nodes, edges };
}

let scratch: HTMLElement | undefined;

/**
 * mermaid looks its drawing surface up with document-wide selectors, which don't reach
 * into a shadow root or a detached element (a block unmounted while its job was queued):
 * for those, draw in a hidden light-DOM element that copies the container's font so text
 * is measured the way it will be shown. A detached container can't be measured; the font
 * the last connected block set is kept (every block shares the review's font).
 */
function drawingSurface(container: Element): Element {
  if (container.isConnected && !(container.getRootNode() instanceof ShadowRoot)) return container;
  if (!scratch) {
    scratch = document.createElement('div');
    scratch.setAttribute('aria-hidden', 'true');
    scratch.style.cssText = 'position:absolute;top:0;left:-100000px;visibility:hidden;pointer-events:none';
  }
  if (!scratch.isConnected) document.body.appendChild(scratch);
  if (container.isConnected) {
    const { fontFamily, fontSize } = getComputedStyle(container);
    scratch.style.fontFamily = fontFamily;
    scratch.style.fontSize = fontSize;
  }
  return scratch;
}

/**
 * Renders `text` and returns the SVG markup. `container` is the element the diagram
 * will be shown in (mermaid empties the element it draws in, so don't pass one with
 * content); it may have been detached meanwhile. Throws a plain Error with mermaid's
 * message on failure.
 */
export async function renderMermaid(text: string, theme: Theme, container: Element): Promise<string> {
  const mermaid = await loadMermaid();
  if (theme !== lastTheme) {
    mermaid.initialize({ ...baseConfig, theme: themeName(theme) });
    lastTheme = theme;
  }
  try {
    const { svg } = await mermaid.render(`mdr-mm-${++counter}`, text, drawingSurface(container));
    return svg as string;
  } catch (e) {
    throw new Error(errorMessage(e));
  }
}
