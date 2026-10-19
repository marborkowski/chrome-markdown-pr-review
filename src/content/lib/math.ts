import type { Element, Root as HastRoot } from 'hast';
import type { InlineCode, Parent, Root as MdastRoot, Text } from 'mdast';
import type { Position } from 'unist';

/** remark-math's inline node (its mdast types live in a transitive package). */
interface InlineMath {
  type: 'inlineMath';
  value: string;
  position?: Position;
  data?: unknown;
}

/** An inline math node the way remark-math builds it (to-hast reads `data`, not `value`). */
const inlineMath = (value: string, position?: Position): InlineMath => ({
  type: 'inlineMath',
  value,
  position,
  data: { hName: 'code', hProperties: { className: ['language-math', 'math-inline'] }, hChildren: [{ type: 'text', value }] },
});
import { visit } from 'unist-util-visit';

declare global {
  interface Window {
    __MDR_KATEX_URL__?: string;
  }
}

// ---------------------------------------------------------------------------
// GitHub math: $inline$, $`inline`$, $$display$$ and ```math blocks.
// ---------------------------------------------------------------------------

/**
 * remark plugin (after remark-math): undo inline math that is really prose with dollar amounts
 * ("between $5 and $10"): like GitHub and pandoc, math can't start or end with a space and the
 * closing dollar can't be followed by a digit. Also reads GitHub's $`…`$ syntax as inline math.
 */
export function remarkMathGuard() {
  return (tree: MdastRoot, file: { value?: unknown }) => {
    const src = String(file.value ?? '');
    visit(tree as any, 'inlineMath', (node: InlineMath, index: number | undefined, parent: Parent | undefined) => {
      const s = node.position?.start.offset;
      const e = node.position?.end.offset;
      if (s == null || e == null || !parent || index === undefined) return;
      const raw = src.slice(s, e);
      const fence = /^\$+/.exec(raw)?.[0].length ?? 0;
      const inner = raw.slice(fence, raw.length - fence);
      if (fence === 1 && /^`[^`]+`$/.test(inner)) {
        parent.children[index] = inlineMath(inner.slice(1, -1), node.position) as any; // GitHub's $`…`$ form
      } else if (fence === 1 && (/^\s|\s$/.test(inner) || /\d/.test(src[e] ?? ''))) {
        parent.children[index] = { type: 'text', value: raw, position: node.position } as Text;
      }
    });
    visit(tree, (node) => {
      const kids = (node as Parent).children;
      if (!kids) return;
      for (let i = 1; i < kids.length - 1; i++) {
        const [a, code, b] = [kids[i - 1], kids[i], kids[i + 1]];
        if (code.type !== 'inlineCode' || a.type !== 'text' || b.type !== 'text' || !a.value.endsWith('$') || !b.value.startsWith('$')) continue;
        a.value = a.value.slice(0, -1);
        b.value = b.value.slice(1);
        kids[i] = inlineMath((code as InlineCode).value, code.position) as any;
      }
    });
    // Merge the text nodes left next to each other so later text plugins (emoji) see whole runs.
    visit(tree, (node) => {
      const kids = (node as Parent).children;
      if (!kids) return;
      for (let i = kids.length - 1; i > 0; i--) {
        const a = kids[i - 1];
        const b = kids[i];
        if (a.type === 'text' && b.type === 'text') {
          a.value += b.value;
          if (a.position && b.position) a.position = { start: a.position.start, end: b.position.end };
          kids.splice(i, 1);
        }
      }
    });
  };
}

/** rehype plugin (after sanitizing, which keeps only the language-math class): tag math code as inline or display. */
export function rehypeMathMarks() {
  return (tree: HastRoot) => {
    visit(tree, 'element', (node: Element, _i, parent) => {
      if (node.tagName !== 'code') return;
      const cls = node.properties.className;
      if (!(Array.isArray(cls) ? cls.map(String) : []).includes('language-math')) return;
      node.properties.dataMath = parent && parent.type === 'element' && parent.tagName === 'pre' ? 'display' : 'inline';
    });
  };
}

// ---------------------------------------------------------------------------
// KaTeX, loaded on demand.
// ---------------------------------------------------------------------------

type Katex = { renderToString: (tex: string, opts: Record<string, unknown>) => string };
let loading: Promise<Katex> | undefined;

export function loadKatex(): Promise<Katex> {
  if (!loading) {
    loading = (async () => {
      const url = window.__MDR_KATEX_URL__ ?? chrome.runtime.getURL('katex.js');
      return (await import(/* @vite-ignore */ url)) as Katex;
    })();
    loading.catch(() => {
      loading = undefined;
    });
  }
  return loading;
}

const cache = new Map<string, string>();

/** MathML markup for `tex`; KaTeX reports errors inline (in red) instead of throwing. */
export async function renderMath(tex: string, display: boolean): Promise<string> {
  const key = `${display ? 'D' : 'I'}${tex}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const katex = await loadKatex();
  const html = katex.renderToString(tex, { displayMode: display, output: 'mathml', throwOnError: false, trust: false, strict: 'ignore' });
  cache.set(key, html);
  return html;
}

export const mathCached = (tex: string, display: boolean) => cache.get(`${display ? 'D' : 'I'}${tex}`);
