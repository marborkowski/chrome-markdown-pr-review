import type { Element, ElementContent, Root as HastRoot } from 'hast';
import type { Blockquote, Root as MdastRoot } from 'mdast';
import { defaultSchema, type Options as Schema } from 'rehype-sanitize';
import { visit } from 'unist-util-visit';

// ---------------------------------------------------------------------------
// GitHub alerts: > [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION]
// ---------------------------------------------------------------------------

const ALERTS: Record<string, { title: string; icon: string }> = {
  note: {
    title: 'Note',
    icon: 'M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z',
  },
  tip: {
    title: 'Tip',
    icon: 'M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 0 1-1.484.211c-.04-.282-.163-.547-.37-.847a8.456 8.456 0 0 0-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.751.751 0 0 1-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75ZM5.75 12h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM6 15.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z',
  },
  important: {
    title: 'Important',
    icon: 'M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm7 2.25v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z',
  },
  warning: {
    title: 'Warning',
    icon: 'M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z',
  },
  caution: {
    title: 'Caution',
    icon: 'M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z',
  },
};

/** The marker has to be alone on the first line of the quote, like on GitHub. */
const ALERT_RE = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\r?\n|$)/i;

/**
 * remark plugin: a GitHub alert blockquote loses its [!KIND] marker and is tagged as a callout;
 * rehypeCallouts gives it GitHub's markup after sanitizing (github-markdown-css styles it).
 */
export function remarkAlerts() {
  return (tree: MdastRoot) => {
    visit(tree, 'blockquote', (node: Blockquote) => {
      const p = node.children[0];
      const t = p?.type === 'paragraph' ? p.children[0] : undefined;
      if (!p || p.type !== 'paragraph' || t?.type !== 'text') return;
      const m = ALERT_RE.exec(t.value);
      if (!m) return;
      t.value = t.value.slice(m[0].length);
      if (!t.value) p.children.shift();
      if (!p.children.length) node.children.shift();
      node.data = { ...node.data, hProperties: { ...(node.data?.hProperties as object), dataCallout: m[1].toLowerCase() } };
    });
  };
}

/** rehype plugin: render callouts (GitHub alerts, docs-site admonitions) with GitHub's alert markup. */
export function rehypeCallouts() {
  return (tree: HastRoot) => {
    visit(tree, 'element', (node: Element) => {
      const kind = node.properties.dataCallout;
      if (typeof kind !== 'string' || !ALERTS[kind]) return;
      const custom = node.properties.dataCalloutTitle;
      delete node.properties.dataCallout;
      delete node.properties.dataCalloutTitle;
      const { title, icon } = ALERTS[kind];
      node.properties.className = ['markdown-alert', `markdown-alert-${kind}`];
      const svg: Element = {
        type: 'element',
        tagName: 'svg',
        properties: { className: ['octicon'], viewBox: '0 0 16 16', width: 16, height: 16, ariaHidden: 'true' },
        children: [{ type: 'element', tagName: 'path', properties: { d: icon }, children: [] }],
      };
      const label = typeof custom === 'string' && custom.trim() ? custom.trim() : title;
      node.children.unshift({ type: 'element', tagName: 'p', properties: { className: ['markdown-alert-title'] }, children: [svg, { type: 'text', value: label }] });
    });
  };
}

// ---------------------------------------------------------------------------
// Raw HTML: rendered like GitHub renders it, through GitHub's sanitizing rules.
// ---------------------------------------------------------------------------

const allow = (tag: string, ...extra: NonNullable<Schema['attributes']>[string]) => [...(defaultSchema.attributes?.[tag] ?? []), ...extra];

/**
 * GitHub's allow-list (hast-util-sanitize's default schema), plus the data attributes our own
 * Markdown extensions hand to the plugins that run after sanitizing. Classes stay restricted, so
 * HTML in a document can never pose as a change marker or as part of the review UI.
 */
export const sanitizeSchema: Schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    blockquote: allow('blockquote', 'dataCallout'),
    div: allow('div', 'dataCallout', 'dataCalloutTitle'),
    pre: allow('pre', 'dataFrontmatter'),
  },
};

/** rehype plugin: resolve relative `srcset` candidates (<picture><source srcset>), which react-markdown leaves alone. */
export function rehypeSrcset(resolve: (url: string, key: string) => string) {
  return (tree: HastRoot) => {
    visit(tree, 'element', (node: Element) => {
      const v = node.properties.srcSet;
      if (v == null) return;
      const list = Array.isArray(v) ? v.map(String).join(', ') : String(v);
      node.properties.srcSet = list
        .split(/,\s+/)
        .map((c) => {
          const [url, ...desc] = c.trim().split(/\s+/);
          const r = url ? resolve(url, 'src') : '';
          return r ? [r, ...desc].join(' ') : '';
        })
        .filter(Boolean)
        .join(', ');
    });
  };
}

// ---------------------------------------------------------------------------
// Heading anchors (GitHub's slug rules), so in-document links like #goals work.
// ---------------------------------------------------------------------------

export function slugger() {
  const seen = new Map<string, number>();
  return (text: string) => {
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '').replace(/ /g, '-');
    let slug = base;
    let n = seen.get(base);
    while (seen.has(slug)) {
      n = (n ?? 0) + 1;
      seen.set(base, n);
      slug = `${base}-${n}`;
    }
    seen.set(slug, 0);
    return slug;
  };
}

const textOf = (n: ElementContent): string =>
  n.type === 'text' ? n.value : n.type === 'element' ? n.children.map(textOf).join('') : '';

/** rehype plugin: give headings GitHub-compatible ids. */
export function rehypeHeadingIds() {
  return (tree: HastRoot) => {
    const slug = slugger();
    visit(tree, 'element', (node: Element) => {
      if (/^h[1-6]$/.test(node.tagName) && node.properties.id == null) node.properties.id = slug(node.children.map(textOf).join(''));
    });
  };
}

/** Find the element an in-document link (#fragment) points at; GitHub prefixes ids with "user-content-". */
export function findAnchor(root: ParentNode | null | undefined, fragment: string): HTMLElement | null {
  if (!root || !fragment) return null;
  let id = fragment;
  try { id = decodeURIComponent(fragment); } catch { /* keep as is */ }
  const bare = id.replace(/^user-content-/, '');
  for (const cand of [id, bare, `user-content-${bare}`]) {
    const el = root.querySelector<HTMLElement>(`#${CSS.escape(cand)}`) ?? root.querySelector<HTMLElement>(`a[name="${CSS.escape(cand)}"]`);
    if (el) return el;
  }
  return null;
}
