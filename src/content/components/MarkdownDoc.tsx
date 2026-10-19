import { Children, cloneElement, createContext, isValidElement, memo, useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMath from 'remark-math';
import remarkGemoji from 'remark-gemoji';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import type { Root as HastRoot, Element as HastElement } from 'hast';
import { visit } from 'unist-util-visit';
import { remarkAdmonitions, remarkMdxEsm } from '../lib/admonitions';
import { BLOCK_TAGS, rehypeAnnotate } from '../lib/annotate';
import { rehypeFold } from '../lib/fold';
import { findAnchor, rehypeCallouts, rehypeHeadingIds, rehypeSrcset, remarkAlerts, sanitizeSchema } from '../lib/gfm';
import { LIST_MARKER, blockDiffSource, markdownDiffSource, rehypeDiffMarks, type RemovalParts } from '../lib/inlineDiff';
import { mathCached, rehypeMathMarks, remarkMathGuard, renderMath } from '../lib/math';
import { isMermaidCode } from '../lib/mermaidDiff';
import type { DiffInfo, Removal } from '../lib/patch';
import { splitRow } from '../lib/tables';
import { MermaidBlock } from './MermaidBlock';
import { WordDiff } from './WordDiff';

export type UrlResolver = (url: string, key: string) => string;

/** An image file the PR adds or changes, found behind an image of the document. */
export interface AssetChange {
  status: 'added' | 'modified' | 'renamed' | 'removed';
  /** The image as it was before the PR (modified / renamed). */
  before?: string;
}

interface DocCtxValue {
  diff: DiffInfo | null;
  lines: string[];
  inlineDiff: boolean;
  resolveUrl: UrlResolver;
  onBadge: (sl: number, el: number, side?: 'LEFT' | 'RIGHT') => void;
  onMods: (mods: number[], anchor: HTMLElement) => void;
  onLink?: (href: string) => boolean;
  /** Base-file lines with unresolved conversations on the removed side. */
  leftThreadLines: number[];
  /** Links and images whose target is missing → why (keyed by resolved URL). */
  broken: Map<string, string>;
  assetChange?: (src: string) => AssetChange | null;
  /** Scroll to a head line (the destination of moved text). */
  onJump?: (line: number) => void;
}

const DocCtx = createContext<DocCtxValue>(null as any);

/** Scroll an element into view and flash it. */
export function reveal(el: Element) {
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('mdr-flash');
  window.setTimeout(() => el.classList.remove('mdr-flash'), 1300);
}

/** In-document anchors scroll inside the review; links to other files of the PR open them here. */
function DocLink({ node: _n, href, className, title, ...props }: any) {
  const ctx = useContext(DocCtx);
  const internal = typeof href === 'string' && href.startsWith('#');
  const broken = typeof href === 'string' ? ctx?.broken.get(href) : undefined;
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!href || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (internal) {
      e.preventDefault();
      const target = findAnchor(e.currentTarget.closest('.mdr-doc'), href.slice(1));
      if (target) reveal(target);
    } else if (ctx?.onLink?.(href)) {
      e.preventDefault();
    }
  };
  return (
    <a
      {...props}
      href={href}
      className={[className, broken && 'mdr-broken'].filter(Boolean).join(' ') || undefined}
      title={broken ? `Broken link: ${broken}` : title}
      onClick={onClick}
      {...(internal ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
    />
  );
}

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

/** TeX rendered by KaTeX as MathML (loaded on first use); the TeX source shows until then, or if it can't load. */
function MathTex({ tex, display }: { tex: string; display: boolean }) {
  const [html, setHtml] = useState(() => mathCached(tex, display));
  useEffect(() => {
    let live = true;
    renderMath(tex, display).then(
      (h) => live && setHtml(h),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [tex, display]);
  if (html === undefined) return <code className="mdr-math-src">{tex}</code>;
  const Tag = display ? 'div' : 'span';
  return <Tag className={`mdr-math${display ? ' mdr-math-display' : ''}`} data-tex={tex} dangerouslySetInnerHTML={{ __html: html }} />;
}

const hastText = (n: any): string => (n.type === 'text' ? n.value : (n.children ?? []).map(hastText).join(''));

/** Inline code, or inline math ($…$ is turned into code.language-math by remark-math). */
function CodeEl({ node, children, ...props }: any) {
  if (node?.properties?.dataMath === 'inline') return <MathTex tex={hastText(node)} display={false} />;
  return <code {...props}>{children}</code>;
}

/** The TeX of a display-math block ($$…$$ or ```math) in `text`, or null. */
function texOf(text: string): string | null {
  const t = text.trim();
  const fence = /^(`{3,}|~{3,})[ \t]*math\b[^\n]*\n([\s\S]*?)\n?[ \t]*\1[ \t]*$/.exec(t);
  if (fence) return fence[2];
  const dollars = /^\$\$([\s\S]*?)\$\$$/.exec(t);
  return dollars ? dollars[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

type ImageView = 'both' | 'after' | 'before';

/** An image; when the PR adds or replaces the image file itself, it says so and can show the old version next to the new one. */
function ImageEl({ node: _n, src, alt, className, title, ...props }: any) {
  const ctx = useContext(DocCtx);
  const [view, setView] = useState<ImageView>('both');
  const change = typeof src === 'string' ? ctx?.assetChange?.(src) ?? null : null;
  const broken = typeof src === 'string' ? ctx?.broken.get(src) : undefined;
  const img = (s: string, cls?: string) => (
    <img {...props} src={s} alt={alt} title={broken ? `Broken image: ${broken}` : title} className={[className, cls, broken && 'mdr-broken'].filter(Boolean).join(' ') || undefined} />
  );
  if (!change || change.status === 'removed') return img(src);
  if (change.status === 'added' || !change.before) {
    return (
      <span className="mdr-img-change mdr-img-new">
        <span className="mdr-img-bar" contentEditable={false}>New image</span>
        {img(src)}
      </span>
    );
  }
  return (
    <span className={`mdr-img-change mdr-img-mod mdr-img-${view}`}>
      <span className="mdr-img-bar" contentEditable={false}>
        Image changed
        {(['both', 'after', 'before'] as const).map((v) => (
          <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
            {v === 'both' ? 'Before & after' : v === 'after' ? 'After' : 'Before'}
          </button>
        ))}
      </span>
      {view !== 'after' && <span className="mdr-img-pane mdr-img-before">{img(change.before, 'mdr-img-old')}</span>}
      {view !== 'before' && <span className="mdr-img-pane mdr-img-after">{img(src)}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Word diff
// ---------------------------------------------------------------------------

/** What a word diff may contain once rendered: inline Markdown only (it lives inside a <p>, <li>, …). */
const DIFF_INLINE = ['code', 'strong', 'em', 'del', 'ins', 'a', 'img', 'br', 'sup', 'sub', 'kbd', 's', 'b', 'i', 'q', 'samp', 'var', 'tt', 'span', 'strike', 'picture', 'source', 'ruby', 'rt', 'rp'];
const diffComponents: Components = { a: DocLink, img: ImageEl, code: CodeEl };
const diffRemark = [remarkGfm, [remarkMath, { singleDollarTextMath: true }], remarkMathGuard, remarkGemoji] as any;

/** Word diff of a block's Markdown source, rendered as Markdown with insertions and deletions marked. */
function MarkdownWordDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const ctx = useContext(DocCtx);
  const source = useMemo(() => markdownDiffSource(oldText, newText), [oldText, newText]);
  const rehype = useMemo(() => [rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeMathMarks, [rehypeSrcset, ctx.resolveUrl], rehypeDiffMarks] as any, [ctx.resolveUrl]);
  return (
    <span className="mdr-worddiff mdr-worddiff-md">
      <ReactMarkdown
        remarkPlugins={diffRemark}
        rehypePlugins={rehype}
        allowedElements={DIFF_INLINE}
        unwrapDisallowed
        components={diffComponents}
        urlTransform={(url, key) => ctx.resolveUrl(url, key)}
      >
        {source}
      </ReactMarkdown>
    </span>
  );
}

/**
 * Prepare source text for an inline word diff inside an already-rendered block:
 * drop block syntax the element itself renders (list markers, heading hashes, quote
 * markers) and turn soft line breaks into spaces, like the rendered paragraph does.
 */
export function cleanForInline(tag: string, text: string): string {
  if (tag === 'pre') return text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*(\n|$)/, '').replace(/(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*$/, '');
  // Quote markers belong to the block quote itself or to one around this block.
  let lines = text.split('\n').map((l) => l.replace(/^(?:[ \t]*>)+[ \t]?/, ''));
  if (/^h[1-6]$/.test(tag)) lines = lines.map((l) => l.replace(/^\s*#{1,6}\s+/, '').replace(/\s+#+\s*$/, ''));
  const out: string[] = [];
  for (const raw of lines) {
    const isItem = tag === 'li' && LIST_MARKER.test(raw);
    const l = isItem ? raw.replace(LIST_MARKER, '') : raw.trim();
    if (!l) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    if (isItem || !out.length || out[out.length - 1] === '') out.push(l);
    else out[out.length - 1] += ' ' + l;
  }
  return out.join('\n').replace(/\n{2,}/g, '\n\n').trim();
}

/** Block tags that can't have children (React throws): their gutter hangs beside them instead. */
const VOID_TAGS = new Set(['hr']);

/** The code of a ```mermaid block (a hast <pre> whose first child is <code class="language-mermaid">), else null. */
function mermaidSource(node: any): string | null {
  const code = node?.children?.[0];
  if (!code || code.type !== 'element' || code.tagName !== 'code' || !isMermaidCode(code.properties?.className)) return null;
  return hastText(code).replace(/\n$/, '');
}

/** The TeX of a display-math <pre> (rehypeMathMarks tagged its <code>), else null. */
function mathSource(node: any): string | null {
  const code = node?.children?.[0];
  if (!code || code.type !== 'element' || code.tagName !== 'code' || code.properties?.dataMath !== 'display') return null;
  return hastText(code).replace(/\n$/, '');
}

const MERMAID_FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*mermaid\b/i;

const QUOTE_MARKERS = /^(?:[ \t]*>)+/;

/**
 * The code of the ```mermaid block in `text`, or null when there is none (the block counts as
 * brand new). Blockquote markers are stripped as deep as the opening fence is quoted, so a
 * diagram inside a quote or alert is found and code lines that start with `>` stay intact.
 */
function oldMermaidSource(text: string): string | null {
  let ls = text.split('\n');
  const open = ls.findIndex((l) => MERMAID_FENCE.test(l.replace(/^(?:[ \t]*>)+[ \t]?/, '')));
  if (open < 0) return null;
  const depth = (QUOTE_MARKERS.exec(ls[open])?.[0].match(/>/g) ?? []).length;
  if (depth) {
    const q = new RegExp(`^(?:[ \\t]*>){1,${depth}}[ \\t]?`);
    ls = ls.map((l) => l.replace(q, ''));
  }
  const fence = MERMAID_FENCE.exec(ls[open])![1];
  const closing = new RegExp(`^[ \\t]*${fence[0]}{${fence.length},}[ \\t]*$`);
  const close = ls.findIndex((l, i) => i > open && closing.test(l));
  return ls.slice(open + 1, close < 0 ? undefined : close).join('\n');
}

/** The source lines [start, end] of a block as they were before the PR: added lines taken out, removed lines put back. */
function oldLines(ctx: DocCtxValue, start: number, end: number): string[] {
  const { added, removals } = ctx.diff!;
  const out: string[] = [];
  for (let ln = start; ln <= end; ln++) {
    // A deletion anchored at the block's first line sat before the block; one at end + 1 belongs to what follows.
    for (const r of removals) if (r.replacedBy ? r.replacedBy.start === ln : r.anchor === ln && ln > start) out.push(...r.lines);
    if (!added.has(ln)) out.push(ctx.lines[ln - 1] ?? '');
  }
  return out;
}

const idxList = (v: unknown): number[] =>
  v === undefined || v === null || v === '' ? [] : String(v).split(' ').map(Number);

/** "removal:from:to" entries (data-mod-part) → this block's share of replacements spanning several blocks. */
const partMap = (v: unknown): RemovalParts =>
  new Map(
    (v === undefined || v === null || v === '' ? [] : String(v).split(' ')).map((s) => {
      const [i, from, to] = s.split(':').map(Number);
      return [i, [from, to]];
    }),
  );

/** Front matter (YAML, or TOML for Hugo) and MDX import / export lines are shown as a dimmed code block instead of being dropped. */
const frontmatter = (fence: string | null, lang?: string) => (state: any, node: any) => {
  const result = {
    type: 'element',
    tagName: 'pre',
    properties: { dataFrontmatter: '' },
    children: [{ type: 'element', tagName: 'code', properties: lang ? { className: [`language-${lang}`] } : {}, children: [{ type: 'text', value: fence ? `${fence}\n${node.value}\n${fence}` : node.value }] }],
  };
  state.patch(node, result);
  return result;
};
/** Footnote ids are prefixed once, by the sanitizer (like GitHub's user-content- ids). */
const remarkRehypeOptions = { clobberPrefix: '', handlers: { yaml: frontmatter('---'), toml: frontmatter('+++'), esm: frontmatter(null, 'js') } } as any;

function Gutter({ threads, pending, mods, sl, el, movedFrom }: { threads: number; pending: number; mods: number[]; sl: number; el: number; movedFrom?: number }) {
  const ctx = useContext(DocCtx);
  if (!threads && !pending && !mods.length && movedFrom === undefined) return null;
  return (
    <span className="mdr-gutter" contentEditable={false} suppressContentEditableWarning>
      {threads > 0 && (
        <button className="mdr-badge mdr-badge-thread" title="Show comments" onClick={() => ctx.onBadge(sl, el)}>
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden><path fill="currentColor" d="M1 2.75C1 1.78 1.78 1 2.75 1h10.5c.97 0 1.75.78 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.57 2.57A1.46 1.46 0 0 1 4 13.54V12H2.75A1.75 1.75 0 0 1 1 10.25Z" /></svg>
          {threads}
        </button>
      )}
      {pending > 0 && (
        <button className="mdr-badge mdr-badge-pending" title="Draft comments (not yet submitted)" onClick={() => ctx.onBadge(sl, el)}>
          draft {pending > 1 ? pending : ''}
        </button>
      )}
      {mods.length > 0 && (
        <button className="mdr-badge mdr-badge-mod" title="Show what changed" aria-label="Show what changed" onClick={(e) => ctx.onMods(mods, e.currentTarget)}>
          ±
        </button>
      )}
      {movedFrom !== undefined && (
        <button
          className="mdr-badge mdr-badge-moved"
          title="Moved here unchanged – show where it was"
          onClick={(e) => {
            // A moved section's pieces may be shown as one block (data-removal-more lists the others).
            const src = e.currentTarget.closest('.mdr-doc')?.querySelector(`[data-removal="${movedFrom}"], [data-removal-more~="${movedFrom}"]`);
            if (src) reveal(src);
          }}
        >
          moved
        </button>
      )}
    </span>
  );
}

/** A removed Mermaid block is still shown as a diagram (the old code, nothing to compare it with). */
const removedComponents: Components = {
  pre: ({ node, children, ...props }: any) => {
    const source = mermaidSource(node);
    if (source === null) return <pre {...props}>{children}</pre>;
    return <MermaidBlock source={source} oldSource={null} changed={false} sourceView={<pre {...props}>{children}</pre>} gutter={null} attrs={{}} />;
  },
  code: CodeEl,
};

/** rehype plugin for removed text: base-file line numbers on every element, so a selection there maps to the left side of the diff. */
function rehypeOldLines(opts: { offset: number }) {
  return (tree: HastRoot) => {
    visit(tree, 'element', (n: HastElement) => {
      if (!n.position) return;
      n.properties.dataOsl = opts.offset + n.position.start.line - 1;
      n.properties.dataOel = opts.offset + n.position.end.line - 1;
    });
  };
}

/** The removed lines that were really deleted, not moved elsewhere. */
function deletedPart(r: Removal): { lines: string[]; offset: number }[] {
  const moved = r.moved ?? [];
  const parts: { lines: string[]; offset: number }[] = [];
  let from = 0;
  for (const m of [...moved].sort((a, b) => a.from - b.from)) {
    if (m.from > from) parts.push({ lines: r.lines.slice(from, m.from), offset: r.oldStart + from });
    from = m.to;
  }
  if (from < r.lines.length) parts.push({ lines: r.lines.slice(from), offset: r.oldStart + from });
  return parts.filter((p) => p.lines.some((l) => l.trim()));
}

/** Destinations of moved pieces, merging pieces that landed next to each other. */
function movedTargets(moved: Removal['moved'] & {}) {
  const out: { start: number; end: number }[] = [];
  for (const m of [...moved].sort((a, b) => a.start - b.start)) {
    const prev = out[out.length - 1];
    if (prev && m.start - prev.end <= 2) prev.end = Math.max(prev.end, m.end);
    else out.push({ start: m.start, end: m.end });
  }
  return out;
}

function RemovedBody({ lines, offset }: { lines: string[]; offset: number }) {
  const rehype = useMemo(() => [rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeCallouts, rehypeMathMarks, [rehypeOldLines, { offset }]] as any, [offset]);
  return (
    <ReactMarkdown remarkPlugins={diffRemark} remarkRehypeOptions={remarkRehypeOptions} rehypePlugins={rehype} components={removedComponents} urlTransform={() => ''}>
      {lines.join('\n')}
    </ReactMarkdown>
  );
}

/** A removal, or a moved section's pieces that git split around new text (`more`), shown as one block. */
function RemovedBlock({ idx, more = [] }: { idx: number; more?: number[] }) {
  const ctx = useContext(DocCtx);
  const r = ctx.diff?.removals[idx];
  const rest = more.map((i) => ctx.diff?.removals[i]).filter((x): x is Removal => !!x);
  const nonBlank = r ? [r, ...rest].reduce((n, x) => n + x.lines.filter((l) => l.trim()).length, 0) : 0;
  const parts = useMemo(() => (r ? deletedPart(r) : []), [r]);
  const deleted = parts.reduce((n, p) => n + p.lines.filter((l) => l.trim()).length, 0);
  const [open, setOpen] = useState(() => deleted > 0 && deleted <= 12);
  if (!r || !nonBlank) return null;
  const moved = [r, ...rest].flatMap((x) => x.moved ?? []);
  const targets = movedTargets(moved);
  const last = rest[rest.length - 1] ?? r;
  const oldEnd = last.oldStart + last.lines.length - 1;
  const threads = ctx.leftThreadLines.filter((l) => l >= r.oldStart && l <= oldEnd).length;
  const movedLinks = moved.length > 0 && (
    <span className="mdr-moved-links">
      {deleted ? ' · ' : ''}
      {targets.length === 1 ? 'moved' : `${targets.length} parts moved`} to{' '}
      {targets.map((m, k) => (
        <button key={k} className="mdr-link" onClick={() => ctx.onJump?.(m.start)}>
          line {m.start}
        </button>
      ))}
    </span>
  );
  if (!deleted) {
    return (
      <div className="mdr-removed mdr-removed-moved" data-removal={idx} data-removal-more={more.length ? more.join(' ') : undefined} data-osl={r.oldStart} data-oel={oldEnd}>
        <div className="mdr-removed-head">
          <span className="mdr-chev">⇅</span> {nonBlank} line{nonBlank === 1 ? '' : 's'} {movedLinks}
        </div>
      </div>
    );
  }
  return (
    <div className="mdr-removed" data-removal={idx} data-removal-more={more.length ? more.join(' ') : undefined} data-osl={r.oldStart} data-oel={oldEnd}>
      <div className="mdr-removed-head">
        <button className="mdr-removed-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="mdr-chev">{open ? '▾' : '▸'}</span> Removed {deleted} line{deleted === 1 ? '' : 's'}
        </button>
        {movedLinks}
        {threads > 0 && (
          <button className="mdr-badge mdr-badge-thread" title="Comments on the removed text" onClick={() => ctx.onBadge(r.oldStart, oldEnd, 'LEFT')}>
            💬 {threads}
          </button>
        )}
      </div>
      {open && (
        <div className="mdr-removed-body">
          {parts.map((p) => (
            <RemovedBody key={p.offset} lines={p.lines} offset={p.offset} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Unchanged blocks folded away in "changes only" reading. */
function Fold({ count, sl, el, children }: { count: number; sl: number; el: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const expand = () => setOpen(true);
    node.addEventListener('mdr-expand', expand);
    return () => node.removeEventListener('mdr-expand', expand);
  }, []);
  const range = sl && el ? ` · lines ${sl}–${el}` : '';
  return (
    <div ref={ref} className={`mdr-fold${open ? ' mdr-fold-open' : ''}`} data-fold-sl={sl} data-fold-el={el}>
      <button className="mdr-fold-toggle" onClick={() => setOpen(!open)} contentEditable={false}>
        {open ? `▾ Hide ${count} unchanged blocks` : `⋯ ${count} unchanged blocks${range}`}
      </button>
      {open && children}
    </div>
  );
}

/**
 * Old and new source of a block that owns a change (its own removals, or its share of a
 * replacement spanning sibling blocks), with the nested blocks the change doesn't reach.
 * Null when the block owns nothing: it is simply new, or continues another block's change.
 */
function changeOf(ctx: DocCtxValue, props: any, children: any, sl: number, el: number, mods: number[]) {
  const { removals } = ctx.diff!;
  const parts = partMap(props['data-mod-part']);
  const own = mods.filter((i) => removals[i] && !parts.has(i));
  // A block with no removed lines of its own share is simply new: it renders like any added block.
  const shared = [...parts].some(([i, [from, to]]) => removals[i] && to > from);
  if (!own.length && !shared) return null;
  const repl = own.flatMap((i) => removals[i].replacedBy ?? []);
  const start = Math.min(sl, ...repl.map((r) => r.start));
  const reach = Math.max(0, Number(props['data-mod-el'] ?? 0), ...repl.map((r) => r.end));
  const end = Math.max(el, reach);
  // Nested blocks the change doesn't reach (e.g. a sub-list) keep rendering as themselves.
  const nested = Children.toArray(children).filter(
    (k): k is ReactElement<any> => isValidElement(k) && (k.props as any)['data-block'] !== undefined && Number((k.props as any)['data-sl']) > start,
  );
  const cutAt = nested.length ? Number(nested[0].props['data-sl']) : Infinity;
  const keepNested = cutAt <= end && reach < cutAt;
  const src = blockDiffSource(ctx.lines, removals, start, keepNested ? cutAt - 1 : end, parts);
  const rest = own.filter((i) => !src.used.has(i));
  return { start, end, src, nested, keepNested, rest };
}

/** A table row deleted by the PR, struck out in its table. */
function RemovedRow({ spec, osl }: { spec: string; osl: number }) {
  const ctx = useContext(DocCtx);
  const [i, k] = spec.split(':').map(Number);
  const line = ctx.diff?.removals[i]?.lines[k];
  if (line === undefined) return null;
  return (
    <tr className="mdr-removed-row" data-osl={osl} data-oel={osl} title="Row removed in this pull request">
      {splitRow(line).map((cell, c) => (
        <td key={c}>
          <del className="mdr-d-del">
            <MarkdownWordDiff oldText={cell} newText={cell} />
          </del>
        </td>
      ))}
    </tr>
  );
}

/** A changed math block: the new formula, and the old one struck through above it. */
function MathChange({ tex, oldTex, attrs, gutter }: { tex: string; oldTex: string | null; attrs: any; gutter: ReactNode }) {
  return (
    <div {...attrs} className={`${attrs.className ?? ''} mdr-math-block`}>
      {oldTex !== null && oldTex !== tex && (
        <div className="mdr-math-old" title="Before">
          <MathTex tex={oldTex} display />
        </div>
      )}
      <MathTex tex={tex} display />
      {gutter}
    </div>
  );
}

function makeBlock(Tag: string) {
  return function Block({ node, children, ...props }: any) {
    const ctx = useContext(DocCtx);
    if (Tag === 'div' && props['data-removal'] !== undefined) return <RemovedBlock idx={Number(props['data-removal'])} more={idxList(props['data-removal-more'])} />;
    if (Tag === 'div' && props['data-fold'] !== undefined) {
      return <Fold count={Number(props['data-fold'])} sl={Number(props['data-fold-sl'] ?? 0)} el={Number(props['data-fold-el'] ?? 0)}>{children}</Fold>;
    }
    if (Tag === 'tr' && props['data-removed-row'] !== undefined) return <RemovedRow spec={String(props['data-removed-row'])} osl={Number(props['data-osl'])} />;

    const sl = Number(props['data-sl']);
    const el = Number(props['data-el']);
    const mods = idxList(props['data-mods']);
    const cont = idxList(props['data-mod-cont']);
    const threads = Number(props['data-threads'] ?? 0);
    const pending = Number(props['data-pending'] ?? 0);
    const movedFrom = props['data-moved-from'] !== undefined ? Number(props['data-moved-from']) : undefined;
    const El = Tag as any;
    const mermaid = Tag === 'pre' ? mermaidSource(node) : null;
    const math = Tag === 'pre' ? mathSource(node) : null;
    const oldMermaid = (start = sl, end = el) => (ctx.diff ? oldMermaidSource(oldLines(ctx, start, end).join('\n')) : null);
    const oldMath = (start = sl, end = el) => (ctx.diff ? texOf(oldLines(ctx, start, end).join('\n')) : null);
    /** Callouts (alerts, admonitions) are containers: their changes are shown by the blocks inside them. */
    const callout = /\bmarkdown-alert\b/.test(props.className ?? '');

    if (ctx.inlineDiff && ctx.diff && Tag !== 'tr' && Tag !== 'table' && !callout) {
      const change = changeOf(ctx, props, children, sl, el, mods);
      if (!change && cont.length) return null; // rendered as part of the block that starts the change
      if (change) {
        const { start, end, src, nested, keepNested, rest } = change;
        const oldText = cleanForInline(Tag, src.oldText);
        const newText = cleanForInline(Tag, src.newText);
        const attrs = { ...props, 'data-sl': start, 'data-el': end, className: `${props.className ?? ''} mdr-inline` };
        const gutter = <Gutter threads={threads} pending={pending} mods={rest} sl={sl} el={el} />;
        if (mermaid !== null) {
          const sourceView = <pre><WordDiff oldText={oldText} newText={newText} /></pre>;
          return <MermaidBlock source={mermaid} oldSource={oldMermaid(start, end)} changed sourceView={sourceView} gutter={gutter} attrs={attrs} resolveUrl={ctx.resolveUrl} onLink={ctx.onLink} />;
        }
        if (math !== null) return <MathChange tex={math} oldTex={oldMath(start, end)} attrs={attrs} gutter={gutter} />;
        const Wrap = VOID_TAGS.has(Tag) ? 'div' : El; // the word diff needs an element that can hold it
        return (
          <Wrap {...attrs}>
            {Tag === 'pre' ? <WordDiff oldText={oldText} newText={newText} /> : <MarkdownWordDiff oldText={oldText} newText={newText} />}
            {keepNested && nested}
            {gutter}
          </Wrap>
        );
      }
    }

    const gutter = <Gutter threads={threads} pending={pending} mods={mods} sl={sl} el={el} movedFrom={movedFrom} />;
    if (mermaid !== null) {
      const changed = mods.length > 0 || /\bmdr-added\b/.test(props.className ?? '');
      let oldSource: string | null = null;
      if (changed && ctx.diff) {
        // The old code spans the block's own replacements too, which may start before it (a blank line added above the fence).
        const repl = mods.flatMap((i) => ctx.diff!.removals[i]?.replacedBy ?? []);
        const start = Math.min(sl, ...repl.map((r) => r.start));
        const end = Math.max(el, Number(props['data-mod-el'] ?? 0), ...repl.map((r) => r.end));
        oldSource = oldMermaid(start, end);
      }
      return <MermaidBlock source={mermaid} oldSource={oldSource} changed={changed} sourceView={<pre>{children}</pre>} gutter={gutter} attrs={props} resolveUrl={ctx.resolveUrl} onLink={ctx.onLink} />;
    }
    if (math !== null) {
      const changed = mods.length > 0 && ctx.inlineDiff;
      return <MathChange tex={math} oldTex={changed ? oldMath() : null} attrs={props} gutter={gutter} />;
    }
    if (Tag === 'tr') {
      // <tr> may only contain cells: put the gutter inside the last cell.
      let kids = Children.toArray(children);
      const rowOld = props['data-row-old'];
      if (rowOld !== undefined && ctx.inlineDiff && ctx.diff) {
        // An edited row: a word diff in every cell.
        const [i, k] = String(rowOld).split(':').map(Number);
        const before = splitRow(ctx.diff.removals[i]?.lines[k] ?? '');
        const after = splitRow(ctx.lines[sl - 1] ?? '');
        let c = 0;
        kids = kids.map((kid) => {
          if (!isValidElement(kid)) return kid;
          const n = c++;
          return cloneElement(kid as ReactElement<any>, {}, <MarkdownWordDiff oldText={before[n] ?? ''} newText={after[n] ?? ''} />);
        });
      }
      const i = kids.findLastIndex((k) => isValidElement(k));
      if (i >= 0) {
        const last = kids[i] as ReactElement<any>;
        kids[i] = cloneElement(last, { style: { ...(last.props.style ?? {}), position: 'relative' } }, last.props.children, gutter);
      }
      return <El {...props}>{kids}</El>;
    }
    if (VOID_TAGS.has(Tag)) {
      return (
        <div className="mdr-void">
          <El {...props} />
          {gutter}
        </div>
      );
    }
    return (
      <El {...props}>
        {children}
        {gutter}
      </El>
    );
  };
}

const components: Components = {
  ...Object.fromEntries(BLOCK_TAGS.map((t) => [t, makeBlock(t)])),
  a: DocLink,
  img: ImageEl,
  code: CodeEl,
  input: ({ node: _n, ...props }: any) => <input {...props} disabled />,
};

export interface MarkdownDocProps {
  source: string;
  diff: DiffInfo | null;
  threadLines: number[];
  pendingLines: number[];
  activeRange: [number, number] | null;
  inlineDiff: boolean;
  resolveUrl: UrlResolver;
  onBadge: (sl: number, el: number, side?: 'LEFT' | 'RIGHT') => void;
  onMods: (mods: number[], anchor: HTMLElement) => void;
  /** Return true when the link was handled inside the review (e.g. another Markdown file of the PR). */
  onLink?: (href: string) => boolean;
  /** Base-file lines with unresolved conversations on removed text. */
  leftThreadLines?: number[];
  /** Whitespace-only changes are hidden (the diff was made with presentDiff(…, true)). */
  ignoreWhitespace?: boolean;
  /** Fold runs of unchanged blocks ("changes only" reading). */
  fold?: boolean;
  /** Render documentation-site admonitions (Docusaurus :::note, MkDocs !!! note). */
  docsSyntax?: boolean;
  /** An .mdx file: its import / export lines are shown as code. */
  mdx?: boolean;
  /** Broken links and images → why, keyed by resolved URL. */
  broken?: Map<string, string>;
  assetChange?: (src: string) => AssetChange | null;
  onJump?: (line: number) => void;
}

const NO_LINES: number[] = [];
const NO_BROKEN = new Map<string, string>();

export const MarkdownDoc = memo(function MarkdownDoc(p: MarkdownDocProps) {
  const lines = useMemo(() => p.source.split(/\r?\n/), [p.source]);
  const leftThreadLines = p.leftThreadLines ?? NO_LINES;
  const broken = p.broken ?? NO_BROKEN;
  const ctx = useMemo<DocCtxValue>(
    () => ({ diff: p.diff, lines, inlineDiff: p.inlineDiff, resolveUrl: p.resolveUrl, onBadge: p.onBadge, onMods: p.onMods, onLink: p.onLink, leftThreadLines, broken, assetChange: p.assetChange, onJump: p.onJump }),
    [p.diff, lines, p.inlineDiff, p.resolveUrl, p.onBadge, p.onMods, p.onLink, leftThreadLines, broken, p.assetChange, p.onJump],
  );
  const remarkPlugins = useMemo(
    () =>
      [
        remarkGfm,
        [remarkFrontmatter, ['yaml', 'toml']],
        ...(p.mdx ? [remarkMdxEsm] : []),
        ...(p.docsSyntax === false ? [] : [remarkAdmonitions]),
        remarkAlerts,
        [remarkMath, { singleDollarTextMath: true }],
        remarkMathGuard,
        remarkGemoji,
      ] as any,
    [p.docsSyntax, p.mdx],
  );
  const rehypePlugins = useMemo(
    () =>
      [
        rehypeRaw,
        [rehypeSanitize, sanitizeSchema],
        rehypeCallouts,
        rehypeMathMarks,
        [rehypeSrcset, p.resolveUrl],
        rehypeHeadingIds,
        [rehypeAnnotate, { diff: p.diff, lines, threadLines: p.threadLines, pendingLines: p.pendingLines, activeRange: p.activeRange, ignoreWhitespace: p.ignoreWhitespace }],
        [rehypeFold, { enabled: !!p.fold && !!p.diff && (p.diff.added.size > 0 || p.diff.removals.length > 0) }],
      ] as any,
    [p.diff, lines, p.threadLines, p.pendingLines, p.activeRange, p.ignoreWhitespace, p.fold, p.resolveUrl],
  );
  return (
    <DocCtx.Provider value={ctx}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        remarkRehypeOptions={remarkRehypeOptions}
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={(url, key) => p.resolveUrl(url, key)}
      >
        {p.source}
      </ReactMarkdown>
    </DocCtx.Provider>
  );
});

/** Build a resolver for relative links/images inside a repository file. */
export function makeUrlResolver(origin: string, owner: string, repo: string, sha: string, filePath: string): UrlResolver {
  const dir = filePath.split('/').slice(0, -1);
  return (url, key) => {
    const safe = defaultUrlTransform(url);
    if (!safe) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('#') || url.startsWith('//')) return safe;
    const [pathPart, hash = ''] = url.split('#');
    const [cleanPath] = pathPart.split('?');
    const parts = cleanPath.startsWith('/') ? [] : [...dir];
    for (const seg of cleanPath.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    const rel = parts.map((s) => {
      try {
        return encodeURIComponent(decodeURIComponent(s));
      } catch {
        return encodeURIComponent(s);
      }
    }).join('/');
    const base = `${origin}/${owner}/${repo}`;
    // GitHub keeps #gh-dark-mode-only / #gh-light-mode-only on images: the stylesheet hides the one for the other theme.
    return key === 'src' ? `${base}/raw/${sha}/${rel}${hash ? '#' + hash : ''}` : `${base}/blob/${sha}/${rel}${hash ? '#' + hash : ''}`;
  };
}
