import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { lineLabel } from '../lib/anchor';
import type { PendingComment, ReviewComment, Thread } from '../types';

export function timeAgo(iso: string | number) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Render ```suggestion blocks like GitHub does. */
const commentComponents = {
  pre: ({ node, children, ...props }: any) => {
    const code = node?.children?.[0];
    const cls = code?.properties?.className;
    if (Array.isArray(cls) && cls.includes('language-suggestion')) {
      return (
        <div className="mdr-suggestion">
          <div className="mdr-suggestion-head">Suggested change</div>
          <pre {...props}>{children}</pre>
        </div>
      );
    }
    return <pre {...props}>{children}</pre>;
  },
  a: ({ node: _n, ...props }: any) => <a {...props} target="_blank" rel="noreferrer" />,
};

function Comment({ c }: { c: ReviewComment }) {
  return (
    <div className="mdr-comment">
      <div className="mdr-comment-head">
        <img src={c.user.avatar_url} alt="" width={20} height={20} />
        <b>{c.user.login}</b>
        <a className="mdr-muted" href={c.html_url} target="_blank" rel="noreferrer">{timeAgo(c.created_at)}</a>
      </div>
      <div className="markdown-body mdr-comment-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={commentComponents}>{c.body}</ReactMarkdown>
      </div>
    </div>
  );
}

function ThreadCard({ t, focused, onJump, onReply }: { t: Thread; focused: boolean; onJump: () => void; onReply: (body: string) => Promise<void> }) {
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focused]);
  const label =
    t.kind === 'line' ? lineLabel(t.start!, t.end!) : t.kind === 'file' ? 'File' : t.kind === 'left' ? `Removed ${lineLabel(t.root.original_line ?? 0, t.root.original_line ?? 0)}` : 'Outdated';
  return (
    <div ref={ref} className={`mdr-thread${focused ? ' mdr-thread-focus' : ''}`}>
      <button className="mdr-thread-label" onClick={onJump} disabled={t.kind !== 'line'}>{label}</button>
      <Comment c={t.root} />
      {t.replies.map((r) => <Comment key={r.id} c={r} />)}
      {replying ? (
        <div className="mdr-reply">
          <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Reply…"
            onKeyDown={async (e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) {
                setBusy(true);
                try { await onReply(text); setText(''); setReplying(false); } finally { setBusy(false); }
              }
            }} />
          <div className="mdr-row">
            <span className="mdr-spacer" />
            <button className="mdr-btn" onClick={() => setReplying(false)}>Cancel</button>
            <button className="mdr-btn mdr-btn-primary" disabled={!text.trim() || busy}
              onClick={async () => {
                setBusy(true);
                try { await onReply(text); setText(''); setReplying(false); } finally { setBusy(false); }
              }}>Reply</button>
          </div>
        </div>
      ) : (
        <button className="mdr-reply-open" onClick={() => setReplying(true)}>Reply…</button>
      )}
    </div>
  );
}

interface Props {
  threads: Thread[];
  drafts: PendingComment[];
  focus: [number, number] | null;
  onJump: (line: number) => void;
  onReply: (t: Thread, body: string) => Promise<void>;
  onDeleteDraft: (id: string) => void;
}

export function ThreadsPanel({ threads, drafts, focus, onJump, onReply, onDeleteDraft }: Props) {
  const [showOutdated, setShowOutdated] = useState(false);
  const inFocus = (s: number | null, e: number | null) => !!focus && s !== null && e !== null && e >= focus[0] && e <= focus[1];
  const current = threads.filter((t) => t.kind === 'line' || t.kind === 'file');
  const outdated = threads.filter((t) => t.kind === 'outdated' || t.kind === 'left');

  return (
    <div className="mdr-panel">
      {drafts.length > 0 && (
        <section>
          <h4>Your draft comments <span className="mdr-count">{drafts.length}</span></h4>
          {drafts.map((d) => (
            <div key={d.id} className={`mdr-thread mdr-draft${inFocus(d.start, d.end) ? ' mdr-thread-focus' : ''}`}>
              <div className="mdr-row">
                <button className="mdr-thread-label" onClick={() => onJump(d.end)}>
                  {d.kind === 'file' ? `File · ${lineLabel(d.start, d.end)}` : lineLabel(d.start, d.end)}
                </button>
                <span className="mdr-spacer" />
                <button className="mdr-icon-btn" title="Delete draft" onClick={() => onDeleteDraft(d.id)}>✕</button>
              </div>
              <div className="markdown-body mdr-comment-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={commentComponents}>{d.body}</ReactMarkdown>
              </div>
            </div>
          ))}
        </section>
      )}
      <section>
        <h4>Conversations <span className="mdr-count">{current.length}</span></h4>
        {!current.length && <p className="mdr-muted mdr-empty">Select text in the document to comment on it.</p>}
        {current.map((t) => (
          <ThreadCard key={t.root.id} t={t} focused={inFocus(t.start, t.end)} onJump={() => t.end && onJump(t.end)} onReply={(b) => onReply(t, b)} />
        ))}
      </section>
      {outdated.length > 0 && (
        <section>
          <button className="mdr-link" onClick={() => setShowOutdated(!showOutdated)}>
            {showOutdated ? '▾' : '▸'} Outdated & removed-line comments ({outdated.length})
          </button>
          {showOutdated && outdated.map((t) => (
            <ThreadCard key={t.root.id} t={t} focused={false} onJump={() => {}} onReply={(b) => onReply(t, b)} />
          ))}
        </section>
      )}
    </div>
  );
}

export function buildThreads(comments: ReviewComment[], path: string): Thread[] {
  const roots = new Map<number, Thread>();
  const forFile = comments.filter((c) => c.path === path);
  for (const c of forFile) {
    if (c.in_reply_to_id) continue;
    const kind: Thread['kind'] =
      c.subject_type === 'file' ? 'file' : c.side === 'LEFT' ? 'left' : c.line == null ? 'outdated' : 'line';
    roots.set(c.id, {
      root: c,
      replies: [],
      kind,
      start: kind === 'line' ? c.start_line ?? c.line : null,
      end: kind === 'line' ? c.line : null,
    });
  }
  for (const c of forFile) {
    if (c.in_reply_to_id) roots.get(c.in_reply_to_id)?.replies.push(c);
  }
  return [...roots.values()].sort((a, b) => (a.end ?? 1e9) - (b.end ?? 1e9) || a.root.id - b.root.id);
}
