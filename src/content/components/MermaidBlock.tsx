import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { isFlowchart, parseMermaid, renderMermaid, type MermaidGraph, type Theme } from '../lib/mermaid';
import { diffDirectives, graphDiff, labelDiff, mergedSource, normalizeLabel, pairWidths, type DiffColors } from '../lib/mermaidDiff';
import { hardenSvg, linkHref } from '../lib/svgHarden';

export interface MermaidBlockProps {
  /** The block's new code, fences stripped. */
  source: string;
  /** The code before the PR for a modified block; null when the block is unchanged or brand new. */
  oldSource: string | null;
  /** The block was added or modified in this PR. */
  changed: boolean;
  /** What the <pre> block renders today (plain or word diff): the Source view, also shown while the diagram loads. */
  sourceView: ReactNode;
  /** The comment / draft / change badges, rendered inside the wrapper so they stay positioned. */
  gutter: ReactNode;
  /** data-sl, data-el, data-block, className, … of the block, spread on the wrapper so anchoring and change markers keep working. */
  attrs: Record<string, unknown>;
  /** Resolves a link authored in the diagram (`click A "docs/x.md"`) like a document link. */
  resolveUrl?: (url: string, key: string) => string;
  /** Opens a link to another file of the PR inside the review; true when handled. */
  onLink?: (href: string) => boolean;
}

type View = 'changes' | 'after' | 'before' | 'source';
const LABELS: Record<View, string> = { changes: 'Changes', after: 'After', before: 'Before', source: 'Source' };

const COLORS: Record<Theme, DiffColors> = {
  light: { addedFill: '#dafbe1', addedStroke: '#1a7f37', removedFill: '#ffebe9', removedStroke: '#cf222e', changedFill: '#fff8c5', changedStroke: '#9a6700' },
  dark: { addedFill: '#12361f', addedStroke: '#3fb950', removedFill: '#3c1618', removedStroke: '#f85149', changedFill: '#3b2e00', changedStroke: '#d29922' },
};

/** One diagram of a Before / After pair: its markup and natural width, or why it couldn't be drawn. */
interface Pane {
  svg?: string;
  width?: number;
  error?: string;
}

type Rendered = { kind: 'single'; svg: string } | { kind: 'merged'; svg: string } | { kind: 'pair'; before: Pane; after: Pane };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

// mermaid keeps global state (config, the drawing surface), so all its work runs one job at a time.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const p = queue.then(job);
  queue = p.catch(() => {});
  return p;
}

/** Memoised promise per key; a rejected one is forgotten so the next attempt (e.g. after a failed load) retries. */
function memo<T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
  let p = cache.get(key);
  if (!p) {
    p = make();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}

const graphs = new Map<string, Promise<MermaidGraph>>();
const svgs = new Map<string, Promise<string>>();
const views = new Map<string, Promise<Rendered>>();
/** Results already available, so a block mounting again shows its diagram without a loading flash. */
const settled = new Map<string, Rendered>();

const graphOf = (text: string) => memo(graphs, text, () => serial(() => parseMermaid(text)));
const svgOf = (text: string, theme: Theme, container: Element) =>
  memo(svgs, `${theme}\n${text}`, () => serial(() => renderMermaid(text, theme, container)).then(hardenSvg));
const paneOf = (text: string, theme: Theme, container: Element): Promise<Pane> =>
  svgOf(text, theme, container).then(
    (svg) => ({ svg }),
    (e) => ({ error: messageOf(e) }),
  );

/** The non-empty labels mermaid drew: <text>, or <foreignObject> for HTML labels. */
const labelElements = (root: ParentNode) => [...root.querySelectorAll('text, foreignObject')].filter((el) => normalizeLabel(el.textContent ?? ''));

const parseSvg = (svg: string) => {
  const tpl = document.createElement('template');
  tpl.innerHTML = svg;
  return tpl;
};

/** The diagram's natural width: its viewBox width, else mermaid's inline max-width; 0 when unknown. */
function naturalWidth(svg: Element | null): number {
  if (!svg) return 0;
  const vb = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0) return vb[2];
  return parseFloat((svg as SVGElement).style?.maxWidth) || 0;
}

/** Tags the group drawing each label in `labels` (or the text itself) with `cls`. */
function markLabels(tpl: HTMLTemplateElement, labels: Set<string>, cls: string): string {
  const hit = (el: Element) => labels.has(normalizeLabel(el.textContent ?? ''));
  for (const el of labelElements(tpl.content)) {
    if (!hit(el)) continue;
    (el.closest('g[class]') ?? el).classList.add(cls);
    // A node none of whose labels exists on the other side is new / gone as a whole: its shape shows it too.
    const node = el.closest('g.node');
    if (node && labelElements(node).every(hit)) node.classList.add(cls);
  }
  return tpl.innerHTML;
}

/**
 * The Changes view: two flowcharts become one merged diagram with the diff coloured in;
 * anything else (other diagram types, a version that doesn't parse, a merge mermaid rejects)
 * is shown as Before / After with the labels present on one side only highlighted.
 */
async function renderChanges(oldText: string, newText: string, theme: Theme, container: Element): Promise<Rendered> {
  try {
    const [oldG, newG] = await Promise.all([graphOf(oldText), graphOf(newText)]);
    if (isFlowchart(oldG.type) && isFlowchart(newG.type)) {
      const merged = mergedSource(oldText, newText);
      const mergedG = await graphOf(merged);
      const svg = await svgOf(merged + diffDirectives(graphDiff(oldG, newG, mergedG), COLORS[theme]), theme, container);
      return { kind: 'merged', svg };
    }
  } catch {
    // fall back to the generic Before / After view
  }
  const [before, after] = await Promise.all([paneOf(oldText, theme, container), paneOf(newText, theme, container)]);
  if (before.svg && after.svg) {
    const b = parseSvg(before.svg);
    const a = parseSvg(after.svg);
    before.width = naturalWidth(b.content.querySelector('svg'));
    after.width = naturalWidth(a.content.querySelector('svg'));
    const labels = (tpl: HTMLTemplateElement) => labelElements(tpl.content).map((el) => el.textContent ?? '');
    const d = labelDiff(labels(b), labels(a));
    before.svg = markLabels(b, d.removed, 'mdr-svg-removed');
    after.svg = markLabels(a, d.added, 'mdr-svg-added');
  }
  return { kind: 'pair', before, after };
}

const viewKey = (view: View, source: string, oldSource: string | null, theme: Theme) => `${view}\n${theme}\n${oldSource ?? ''}\n\u0000\n${source}`;

function renderView(view: View, source: string, oldSource: string | null, theme: Theme, container: Element): Promise<Rendered> {
  const key = viewKey(view, source, oldSource, theme);
  return memo(views, key, async () => {
    const r =
      view === 'changes'
        ? await renderChanges(oldSource!, source, theme, container)
        : { kind: 'single' as const, svg: await svgOf(view === 'before' ? oldSource! : source, theme, container) };
    // A pane that failed may have failed for a transient reason (loader, detached container):
    // forget it so the next mount retries instead of showing the banner for the session.
    if (r.kind === 'pair' && (r.before.error !== undefined || r.after.error !== undefined)) views.delete(key);
    else settled.set(key, r);
    return r;
  });
}

/** The theme of the shadow host the element lives in, followed as it changes; null before mount. */
function useHostTheme(ref: RefObject<HTMLElement>): Theme | null {
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => {
    const root = ref.current?.getRootNode();
    const host = root instanceof ShadowRoot ? root.host : null;
    const read = () => setTheme(host?.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
    read();
    if (!host) return;
    const mo = new MutationObserver(read);
    mo.observe(host, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

// Layout effects never run on the server (react-dom/server renders the loading state), and must not warn there.
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Runs `fn` now and whenever the element's size changes. */
function useResize(ref: RefObject<HTMLElement>, fn: () => void, deps: unknown[]) {
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    fn();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fn);
    ro.observe(el);
    return () => ro.disconnect();
  }, deps);
}

const VIEW_PADDING = 16;
/** Below this scale labels stop being readable: show the diagram 1:1 and let the view scroll instead. */
const MIN_SCALE = 0.6;

/**
 * The diagram markup. mermaid sizes its SVG to 100% of the view capped at its natural width;
 * a wide diagram that would shrink past MIN_SCALE is shown at its natural size (scrolling),
 * and `share` (a Before / After pane's part of the wider diagram) keeps a pair at one scale.
 */
function Svg({ svg, old, share = 1 }: { svg: string; old?: boolean; share?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useResize(
    ref,
    () => {
      const view = ref.current;
      const el = view?.querySelector('svg');
      if (!view || !el) return;
      const natural = naturalWidth(el);
      const room = (view.clientWidth - VIEW_PADDING) * share;
      if (natural && room > 0 && room / natural < MIN_SCALE) {
        el.style.maxWidth = 'none';
        el.style.width = `${natural}px`;
      } else {
        el.style.maxWidth = natural ? `${natural}px` : '';
        el.style.width = `${share * 100}%`;
      }
    },
    [svg, share],
  );
  return <div ref={ref} className={`mdr-mermaid-view${old ? ' mdr-mermaid-old' : ''}`} dangerouslySetInnerHTML={{ __html: svg }} />;
}

function PaneView({ caption, pane, old, share }: { caption: string; pane: Pane; old?: boolean; share: number }) {
  return (
    <div className="mdr-mermaid-pane">
      <div className="mdr-mermaid-caption">{caption}</div>
      {pane.svg !== undefined ? <Svg svg={pane.svg} old={old} share={share} /> : <div className="mdr-banner mdr-banner-del">Couldn't render the diagram: {pane.error}</div>}
    </div>
  );
}

const PAIR_GAP = 12;

export function MermaidBlock({ source, oldSource, changed, sourceView, gutter, attrs, resolveUrl, onLink }: MermaidBlockProps) {
  const { className, ...rest } = attrs;
  const hasBefore = oldSource !== null;
  const hasChanges = hasBefore && changed;
  const [picked, setPicked] = useState<View | null>(null);
  const view: View = picked && (picked !== 'changes' || hasChanges) && (picked !== 'before' || hasBefore) ? picked : hasChanges ? 'changes' : 'after';
  const options: View[] = [...(hasChanges ? ['changes' as const] : []), 'after', ...(hasBefore ? ['before' as const] : []), 'source'];

  const ref = useRef<HTMLDivElement>(null);
  const theme = useHostTheme(ref);
  const key = theme && view !== 'source' ? viewKey(view, source, oldSource, theme) : '';
  const [state, setState] = useState<{ key: string; result?: Rendered; error?: string }>({ key: '' });

  useEffect(() => {
    if (!key || !ref.current) return;
    let live = true;
    renderView(view, source, oldSource, theme!, ref.current).then(
      (result) => live && setState({ key, result }),
      (e) => live && setState({ key, error: messageOf(e) }),
    );
    return () => {
      live = false;
    };
  }, [key]);

  const current = state.key === key ? state : settled.has(key) ? { key, result: settled.get(key) } : null;
  const result = current?.result;

  // A Before / After pair sits side by side only while the wider diagram fits half the block at full scale.
  const pairWidth = result?.kind === 'pair' ? Math.max(result.before.width ?? 0, result.after.width ?? 0) : 0;
  const [stack, setStack] = useState(false);
  useResize(
    ref,
    () => {
      if (!pairWidth || !ref.current) return;
      setStack(pairWidth > (ref.current.clientWidth - PAIR_GAP) / 2 - VIEW_PADDING);
    },
    [pairWidth],
  );

  // Links authored in the diagram follow the document's link rules instead of navigating the GitHub tab.
  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as Element).closest?.('a');
    if (!a || !a.closest('.mdr-mermaid-view')) return;
    e.preventDefault();
    e.stopPropagation();
    const href = linkHref(a);
    const url = resolveUrl ? resolveUrl(href, 'href') : href;
    if (!url) return;
    if (!onLink?.(url)) window.open(url, '_blank', 'noopener,noreferrer');
  };

  let body: ReactNode;
  if (view === 'source') body = sourceView;
  else if (!key || !current) {
    body = (
      <>
        <div className="mdr-mermaid-loading mdr-muted">Rendering diagram…</div>
        {sourceView}
      </>
    );
  } else if (!result) {
    body = (
      <>
        <div className="mdr-banner mdr-banner-del">Couldn't render the diagram: {current.error}</div>
        {sourceView}
      </>
    );
  } else if (result.kind === 'pair') {
    const [b, a] = pairWidths(result.before.width ?? 0, result.after.width ?? 0);
    body = (
      <div className={`mdr-mermaid-pair${stack ? ' mdr-mermaid-stack' : ''}`}>
        <PaneView caption="Before" pane={result.before} old share={b / 100} />
        <PaneView caption="After" pane={result.after} share={a / 100} />
      </div>
    );
  } else body = <Svg svg={result.svg} old={view === 'before'} />;

  return (
    <div ref={ref} {...(rest as Record<string, any>)} className={`mdr-mermaid ${className ?? ''}`.trim()} onClickCapture={onClickCapture}>
      <div className="mdr-mermaid-bar">
        <div className="mdr-seg" role="tablist">
          {options.map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => setPicked(v)}>
              {LABELS[v]}
            </button>
          ))}
        </div>
        {view === 'changes' && result?.kind === 'merged' && (
          <span className="mdr-mermaid-legend">
            <span><i className="mdr-sw mdr-sw-add" /> added</span>
            <span><i className="mdr-sw mdr-sw-del" /> removed</span>
            <span><i className="mdr-sw mdr-sw-mod" /> changed</span>
          </span>
        )}
        {view === 'changes' && result?.kind === 'pair' && <span className="mdr-mermaid-note">before / after</span>}
      </div>
      {body}
      {gutter}
    </div>
  );
}
