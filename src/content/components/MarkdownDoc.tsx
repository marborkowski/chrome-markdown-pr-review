import { Children, cloneElement, createContext, isValidElement, memo, useContext, useMemo, useState, type ReactElement } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import { BLOCK_TAGS, rehypeAnnotate } from '../lib/annotate';
import type { DiffInfo } from '../lib/patch';
import { WordDiff } from './WordDiff';

export type UrlResolver = (url: string, key: string) => string;

interface DocCtxValue {
  diff: DiffInfo | null;
  lines: string[];
  inlineDiff: boolean;
  onBadge: (sl: number, el: number) => void;
  onMods: (mods: number[], anchor: HTMLElement) => void;
}

const DocCtx = createContext<DocCtxValue>(null as any);

const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;

/**
 * Prepare source text for an inline word diff inside an already-rendered block:
 * drop block syntax the element itself renders (list markers, heading hashes, quote
 * markers) and turn soft line breaks into spaces, like the rendered paragraph does.
 */
export function cleanForInline(tag: string, text: string): string {
  if (tag === 'pre') return text;
  let lines = text.split('\n');
  if (tag === 'blockquote') lines = lines.map((l) => l.replace(/^\s*>\s?/, ''));
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

const idxList = (v: unknown): number[] =>
  v === undefined || v === null || v === '' ? [] : String(v).split(' ').map(Number);

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
          <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={() => ''}>
            {r.lines.join('\n')}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

function makeBlock(Tag: string) {
  return function Block({ node: _node, children, ...props }: any) {
    const ctx = useContext(DocCtx);
    if (Tag === 'div' && props['data-removal'] !== undefined) return <RemovedBlock idx={Number(props['data-removal'])} />;

    const sl = Number(props['data-sl']);
    const el = Number(props['data-el']);
    const mods = idxList(props['data-mods']);
    const cont = idxList(props['data-mod-cont']);
    const threads = Number(props['data-threads'] ?? 0);
    const pending = Number(props['data-pending'] ?? 0);
    const El = Tag as any;

    if (ctx.inlineDiff && ctx.diff && Tag !== 'tr' && Tag !== 'table') {
      const repl = mods.filter((i) => ctx.diff!.removals[i]?.replacedBy);
      if (!repl.length && cont.length) return null; // rendered as part of the block that starts the change
      if (repl.length) {
        const rs = repl.map((i) => ctx.diff!.removals[i]);
        const start = Math.min(...rs.map((r) => r.replacedBy!.start));
        const end = Math.max(...rs.map((r) => r.replacedBy!.end));
        const oldText = cleanForInline(Tag, rs.flatMap((r) => r.lines).join('\n'));
        const newText = cleanForInline(Tag, ctx.lines.slice(start - 1, end).join('\n'));
        const rest = mods.filter((i) => !repl.includes(i));
        const Wrap = VOID_TAGS.has(Tag) ? 'div' : El; // the word diff needs an element that can hold it
        return (
          <Wrap {...props} data-sl={Math.min(sl, start)} data-el={Math.max(el, end)} className={`${props.className ?? ''} mdr-inline`}>
            <WordDiff oldText={oldText} newText={newText} />
            <Gutter threads={threads} pending={pending} mods={rest} sl={sl} el={el} />
          </Wrap>
        );
      }
    }

    const gutter = <Gutter threads={threads} pending={pending} mods={mods} sl={sl} el={el} />;
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
  a: ({ node: _n, ...props }: any) => <a {...props} target="_blank" rel="noopener noreferrer" />,
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
}

export const MarkdownDoc = memo(function MarkdownDoc(p: MarkdownDocProps) {
  const lines = useMemo(() => p.source.split(/\r?\n/), [p.source]);
  const ctx = useMemo<DocCtxValue>(
    () => ({ diff: p.diff, lines, inlineDiff: p.inlineDiff, onBadge: p.onBadge, onMods: p.onMods }),
    [p.diff, lines, p.inlineDiff, p.onBadge, p.onMods],
  );
  const rehypePlugins = useMemo(
    () => [[rehypeAnnotate, { diff: p.diff, lines, threadLines: p.threadLines, pendingLines: p.pendingLines, activeRange: p.activeRange }]] as any,
    [p.diff, lines, p.threadLines, p.pendingLines, p.activeRange],
  );
  return (
    <DocCtx.Provider value={ctx}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkFrontmatter]}
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
