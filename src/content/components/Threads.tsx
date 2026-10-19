import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { lineLabel } from '../lib/anchor';
import type { PendingComment, ReviewComment, Thread, ThreadState } from '../types';

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

function Body({ text }: { text: string }) {
  return (
    <div className="markdown-body mdr-comment-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={commentComponents}>{text}</ReactMarkdown>
    </div>
  );
}

function Comment({ c }: { c: ReviewComment }) {
  return (
    <div className="mdr-comment">
      <div className="mdr-comment-head">
        <img src={c.user.avatar_url} alt="" width={20} height={20} />
        <b>{c.user.login}</b>
        <a className="mdr-muted" href={c.html_url} target="_blank" rel="noreferrer">{timeAgo(c.created_at)}</a>
      </div>
      <Body text={c.body} />
    </div>
  );
}

/** Textarea with Ctrl/⌘+Enter to save and Esc to cancel (Esc never reaches the review, so nothing gets closed). */
function Editor({ initial, placeholder, saveLabel, onSave, onCancel }: {
  initial: string;
  placeholder: string;
  saveLabel: string;
  onSave: (text: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await onSave(text);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mdr-reply">
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={Math.min(12, Math.max(3, text.split('\n').length + 1))}
        placeholder={placeholder}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          } else if (e.key === 'Escape' && (!text.trim() || text === initial)) {
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="mdr-row">
        <span className="mdr-spacer" />
        <button className="mdr-btn" onClick={onCancel}>Cancel</button>
        <button className="mdr-btn mdr-btn-primary" disabled={!text.trim() || busy} onClick={save} title="Ctrl/⌘+Enter">{saveLabel}</button>
      </div>
    </div>
  );
}

function ThreadCard({ t, focused, onJump, onReply, onResolve }: {
  t: Thread;
  focused: boolean;
  onJump: () => void;
  onReply: (body: string) => Promise<void>;
  onResolve?: (resolved: boolean) => Promise<void>;
}) {
  const [replying, setReplying] = useState(false);
  const [resolving, setResolving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focused]);
  const label =
    t.kind === 'line' ? lineLabel(t.start!, t.end!) : t.kind === 'file' ? 'File' : t.kind === 'left' ? `Removed ${lineLabel(t.root.original_line ?? 0, t.root.original_line ?? 0)}` : 'Outdated';
  const resolve = async () => {
    if (!onResolve) return;
    setResolving(true);
    try {
      await onResolve(!t.resolved);
    } finally {
      setResolving(false);
    }
  };
  return (
    <div ref={ref} className={`mdr-thread${focused ? ' mdr-thread-focus' : ''}${t.resolved ? ' mdr-thread-resolved' : ''}`}>
      <div className="mdr-row mdr-thread-top">
        <button className="mdr-thread-label" onClick={onJump} disabled={t.kind !== 'line'}>{label}</button>
        <span className="mdr-spacer" />
        {onResolve && t.threadId && (
          <button className="mdr-btn mdr-btn-ghost mdr-btn-small" onClick={resolve} disabled={resolving}>
            {t.resolved ? 'Unresolve' : '✓ Resolve'}
          </button>
        )}
      </div>
      <Comment c={t.root} />
      {t.replies.map((r) => <Comment key={r.id} c={r} />)}
      {replying ? (
        <Editor
          initial=""
          placeholder="Reply…"
          saveLabel="Reply"
          onCancel={() => setReplying(false)}
          onSave={async (text) => {
            await onReply(text);
            setReplying(false);
          }}
        />
      ) : (
        <button className="mdr-reply-open" onClick={() => setReplying(true)}>Reply…</button>
      )}
    </div>
  );
}

function DraftCard({ d, focused, stale, onJump, onDelete, onEdit }: {
  d: PendingComment;
  focused: boolean;
  stale: boolean;
  onJump: () => void;
  onDelete: () => void;
  onEdit: (body: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className={`mdr-thread mdr-draft${focused ? ' mdr-thread-focus' : ''}`}>
      <div className="mdr-row mdr-thread-top">
        <button className="mdr-thread-label" onClick={onJump}>
          {d.kind === 'file' ? `File · ${lineLabel(d.start, d.end)}` : lineLabel(d.start, d.end)}
        </button>
        <span className="mdr-spacer" />
        {!editing && <button className="mdr-icon-btn mdr-icon-small" title="Edit draft" onClick={() => setEditing(true)}>✎</button>}
        <button className="mdr-icon-btn mdr-icon-small" title="Delete draft" onClick={onDelete}>✕</button>
      </div>
      {stale && <div className="mdr-warn mdr-stale">Written on an older version of this pull request – check the lines still match.</div>}
      {editing ? (
        <Editor
          initial={d.body}
          placeholder="Comment"
          saveLabel="Save"
          onCancel={() => setEditing(false)}
          onSave={(text) => {
            onEdit(text.trim());
            setEditing(false);
          }}
        />
      ) : (
        <Body text={d.body} />
      )}
    </div>
  );
}

interface Props {
  threads: Thread[];
  drafts: PendingComment[];
  focus: [number, number] | null;
  headSha: string;
  onJump: (line: number) => void;
  onReply: (t: Thread, body: string) => Promise<void>;
  onResolve: (t: Thread, resolved: boolean) => Promise<void>;
  onDeleteDraft: (id: string) => void;
  onEditDraft: (id: string, body: string) => void;
}

function Collapsible({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!count) return null;
  return (
    <section>
      <button className="mdr-link" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {title} ({count})
      </button>
      {open && <div className="mdr-collapsible">{children}</div>}
    </section>
  );
}

export function ThreadsPanel({ threads, drafts, focus, headSha, onJump, onReply, onResolve, onDeleteDraft, onEditDraft }: Props) {
  const inFocus = (s: number | null, e: number | null) => !!focus && s !== null && e !== null && e >= focus[0] && e <= focus[1];
  const current = threads.filter((t) => !t.resolved && (t.kind === 'line' || t.kind === 'file'));
  const outdated = threads.filter((t) => !t.resolved && (t.kind === 'outdated' || t.kind === 'left'));
  const resolved = threads.filter((t) => t.resolved);
  const card = (t: Thread, focusable = true) => (
    <ThreadCard
      key={t.root.id}
      t={t}
      focused={focusable && inFocus(t.start, t.end)}
      onJump={() => t.kind === 'line' && t.end && onJump(t.end)}
      onReply={(b) => onReply(t, b)}
      onResolve={(r) => onResolve(t, r)}
    />
  );

  return (
    <div className="mdr-panel">
      {drafts.length > 0 && (
        <section>
          <h4>Your draft comments <span className="mdr-count">{drafts.length}</span></h4>
          {drafts.map((d) => (
            <DraftCard
              key={d.id}
              d={d}
              focused={inFocus(d.start, d.end)}
              stale={!!d.sha && d.sha !== headSha}
              onJump={() => onJump(d.end)}
              onDelete={() => onDeleteDraft(d.id)}
              onEdit={(body) => onEditDraft(d.id, body)}
            />
          ))}
        </section>
      )}
      <section>
        <h4>Conversations <span className="mdr-count">{current.length}</span></h4>
        {!current.length && <p className="mdr-muted mdr-empty">Select text in the document to comment on it.</p>}
        {current.map((t) => card(t))}
      </section>
      <Collapsible title="Outdated & removed-line comments" count={outdated.length}>{outdated.map((t) => card(t, false))}</Collapsible>
      <Collapsible title="Resolved conversations" count={resolved.length}>{resolved.map((t) => card(t))}</Collapsible>
    </div>
  );
}

export function buildThreads(comments: ReviewComment[], path: string, states?: Map<number, ThreadState>): Thread[] {
  const roots = new Map<number, Thread>();
  const forFile = comments.filter((c) => c.path === path);
  for (const c of forFile) {
    if (c.in_reply_to_id) continue;
    const kind: Thread['kind'] =
      c.subject_type === 'file' ? 'file' : c.side === 'LEFT' ? 'left' : c.line == null ? 'outdated' : 'line';
    const state = states?.get(c.id);
    roots.set(c.id, {
      root: c,
      replies: [],
      kind,
      start: kind === 'line' ? c.start_line ?? c.line : null,
      end: kind === 'line' ? c.line : null,
      resolved: !!state?.resolved,
      threadId: state?.id,
    });
  }
  for (const c of forFile) {
    if (c.in_reply_to_id) roots.get(c.in_reply_to_id)?.replies.push(c);
  }
  return [...roots.values()].sort((a, b) => (a.end ?? 1e9) - (b.end ?? 1e9) || a.root.id - b.root.id);
}
