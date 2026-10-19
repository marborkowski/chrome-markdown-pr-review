import { Children, cloneElement, createContext, isValidElement, memo, useContext, useMemo, useState, type MouseEvent, type ReactElement } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import { BLOCK_TAGS, rehypeAnnotate } from '../lib/annotate';
import { findAnchor, rehypeHeadingIds, remarkAlerts } from '../lib/gfm';
import { LIST_MARKER, blockDiffSource, markdownDiffSource, rehypeDiffMarks, type RemovalParts } from '../lib/inlineDiff';
import { isMermaidCode } from '../lib/mermaidDiff';
import type { DiffInfo } from '../lib/patch';
import { MermaidBlock } from './MermaidBlock';
import { WordDiff } from './WordDiff';

export type UrlResolver = (url: string, key: string) => string;

interface DocCtxValue {
  diff: DiffInfo | null;
  lines: string[];
  inlineDiff: boolean;
  resolveUrl: UrlResolver;
  onBadge: (sl: number, el: number) => void;
  onMods: (mods: number[], anchor: HTMLElement) => void;
  onLink?: (href: string) => boolean;
}

const DocCtx = createContext<DocCtxValue>(null as any);

/** Scroll an element into view and flash it. */
export function reveal(el: Element) {
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('mdr-flash');
  window.setTimeout(() => el.classList.remove('mdr-flash'), 1300);
}

/** In-document anchors scroll inside the review; links to other files of the PR open them here. */
function DocLink({ node: _n, href, ...props }: any) {
  const ctx = useContext(DocCtx);
  const internal = typeof href === 'string' && href.startsWith('#');
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
  return <a {...props} href={href} onClick={onClick} {...(internal ? {} : { target: '_blank', rel: 'noopener noreferrer' })} />;
}

/** What a word diff may contain once rendered: inline Markdown only (it lives inside a <p>, <li>, …). */
const DIFF_INLINE = ['code', 'strong', 'em', 'del', 'ins', 'a', 'img', 'br', 'sup', 'sub', 'kbd'];
const diffComponents: Components = { a: DocLink };

/** Word diff of a block's Markdown source, rendered as Markdown with insertions and deletions marked. */
function MarkdownWordDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const ctx = useContext(DocCtx);
  const source = useMemo(() => markdownDiffSource(oldText, newText), [oldText, newText]);
  return (
    <span className="mdr-worddiff mdr-worddiff-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeDiffMarks]}
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

const hastText = (n: any): string => (n.type === 'text' ? n.value : (n.children ?? []).map(hastText).join(''));

/** The code of a ```mermaid block (a hast <pre> whose first child is <code class="language-mermaid">), else null. */
function mermaidSource(node: any): string | null {
  const code = node?.children?.[0];
  if (!code || code.type !== 'element' || code.tagName !== 'code' || !isMermaidCode(code.properties?.className)) return null;
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

/** Frontmatter (YAML) is shown as a code block instead of being dropped. */
const remarkRehypeOptions = {
  handlers: {
    yaml(state: any, node: any) {
      const result = {
        type: 'element',
        tagName: 'pre',
        properties: { className: ['mdr-frontmatter'] },
        children: [{ type: 'element', tagName: 'code', properties: {}, children: [{ type: 'text', value: `---\n${node.value}\n---` }] }],
      };
      state.patch(node, result);
      return result;
    },
  },
} as any;

function Gutter({ threads, pending, mods, sl, el }: { threads: number; pending: number; mods: number[]; sl: number; el: number }) {
  const ctx = useContext(DocCtx);
  if (!threads && !pending && !mods.length) return null;
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
        <button className="mdr-badge mdr-badge-mod" title="Show what changed" onClick={(e) => ctx.onMods(mods, e.currentTarget)}>
          ±
        </button>
      )}
    </span>
  );
}

/** A removed mermaid block is still shown as a diagram (the old code, nothing to compare it with). */
const removedComponents: Components = {
  pre: ({ node, children, ...props }: any) => {
    const source = mermaidSource(node);
    if (source === null) return <pre {...props}>{children}</pre>;
    return <MermaidBlock source={source} oldSource={null} changed={false} sourceView={<pre {...props}>{children}</pre>} gutter={null} attrs={{}} />;
  },
};

function RemovedBlock({ idx }: { idx: number }) {
  const ctx = useContext(DocCtx);
  const r = ctx.diff?.removals[idx];
  const [open, setOpen] = useState(() => (r?.lines.length ?? 0) <= 12);
  if (!r) return null;
  const nonBlank = r.lines.filter((l) => l.trim()).length;
  if (!nonBlank) return null;
  return (
    <div className="mdr-removed" data-removal={idx}>
      <button className="mdr-removed-head" onClick={() => setOpen(!open)}>
        <span className="mdr-chev">{open ? '▾' : '▸'}</span> Removed {nonBlank} line{nonBlank === 1 ? '' : 's'}
      </button>
      {open && (
        <div className="mdr-removed-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={removedComponents} urlTransform={() => ''}>
            {r.lines.join('\n')}
          </ReactMarkdown>
        </div>
      )}
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

function makeBlock(Tag: string) {
  return function Block({ node, children, ...props }: any) {
    const ctx = useContext(DocCtx);
    if (Tag === 'div' && props['data-removal'] !== undefined) return <RemovedBlock idx={Number(props['data-removal'])} />;

    const sl = Number(props['data-sl']);
    const el = Number(props['data-el']);
    const mods = idxList(props['data-mods']);
    const cont = idxList(props['data-mod-cont']);
    const threads = Number(props['data-threads'] ?? 0);
    const pending = Number(props['data-pending'] ?? 0);
    const El = Tag as any;
    const mermaid = Tag === 'pre' ? mermaidSource(node) : null;
    const oldMermaid = (start = sl, end = el) => (ctx.diff ? oldMermaidSource(oldLines(ctx, start, end).join('\n')) : null);

    if (ctx.inlineDiff && ctx.diff && Tag !== 'tr' && Tag !== 'table') {
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

    const gutter = <Gutter threads={threads} pending={pending} mods={mods} sl={sl} el={el} />;
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
    if (Tag === 'tr') {
      // <tr> may only contain cells: put the gutter inside the last cell.
      const kids = Children.toArray(children);
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
  onBadge: (sl: number, el: number) => void;
  onMods: (mods: number[], anchor: HTMLElement) => void;
  /** Return true when the link was handled inside the review (e.g. another Markdown file of the PR). */
  onLink?: (href: string) => boolean;
}

export const MarkdownDoc = memo(function MarkdownDoc(p: MarkdownDocProps) {
  const lines = useMemo(() => p.source.split(/\r?\n/), [p.source]);
  const ctx = useMemo<DocCtxValue>(
    () => ({ diff: p.diff, lines, inlineDiff: p.inlineDiff, resolveUrl: p.resolveUrl, onBadge: p.onBadge, onMods: p.onMods, onLink: p.onLink }),
    [p.diff, lines, p.inlineDiff, p.resolveUrl, p.onBadge, p.onMods, p.onLink],
  );
  const rehypePlugins = useMemo(
    () => [rehypeHeadingIds, [rehypeAnnotate, { diff: p.diff, lines, threadLines: p.threadLines, pendingLines: p.pendingLines, activeRange: p.activeRange }]] as any,
    [p.diff, lines, p.threadLines, p.pendingLines, p.activeRange],
  );
  return (
    <DocCtx.Provider value={ctx}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkFrontmatter, remarkAlerts]}
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
    const rel = parts.map(encodeURIComponent).join('/');
    const base = `${origin}/${owner}/${repo}`;
    return key === 'src' ? `${base}/raw/${sha}/${rel}` : `${base}/blob/${sha}/${rel}${hash ? '#' + hash : ''}`;
  };
}
