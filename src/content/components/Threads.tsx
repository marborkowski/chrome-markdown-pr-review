import { createContext, useContext, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { lineLabel, type Side } from '../lib/anchor';
import type { Finding } from '../lib/checks';
import type { PendingComment, ReviewComment, Thread, ThreadState } from '../types';
import { WordDiff } from './WordDiff';

export function timeAgo(iso: string | number) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** The lines a comment's suggestion would replace, so it can be shown as a diff (like GitHub does). */
const SuggestionBase = createContext<string | null>(null);

function SuggestionBlock({ node, children, ...props }: any) {
  const base = useContext(SuggestionBase);
  const code = node?.children?.[0];
  const cls = code?.properties?.className;
  if (!(Array.isArray(cls) && cls.includes('language-suggestion'))) return <pre {...props}>{children}</pre>;
  const text = (code.children ?? []).map((c: any) => c.value ?? '').join('').replace(/\n$/, '');
  return (
    <div className="mdr-suggestion">
      <div className="mdr-suggestion-head">Suggested change</div>
      {base !== null ? (
        <pre className="mdr-suggestion-diff"><WordDiff oldText={base} newText={text} /></pre>
      ) : (
        <pre {...props}>{children}</pre>
      )}
    </div>
  );
}

const commentComponents = {
  pre: SuggestionBlock,
  a: ({ node: _n, ...props }: any) => <a {...props} target="_blank" rel="noreferrer" />,
};

export function Body({ text, base = null }: { text: string; base?: string | null }) {
  return (
    <SuggestionBase.Provider value={base}>
      <div className="markdown-body mdr-comment-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={commentComponents}>{text}</ReactMarkdown>
      </div>
    </SuggestionBase.Provider>
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

interface CommentActions {
  viewer: string | null;
  onEdit: (c: ReviewComment, body: string) => Promise<void>;
  onDelete: (c: ReviewComment) => Promise<void>;
}

function Comment({ c, base, actions }: { c: ReviewComment; base: string | null; actions: CommentActions }) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const mine = !!actions.viewer && c.user.login === actions.viewer;
  return (
    <div className="mdr-comment">
      <div className="mdr-comment-head">
        <img src={c.user.avatar_url} alt="" width={20} height={20} />
        <b>{c.user.login}</b>
        {mine && !editing && (
          <span className="mdr-comment-tools">
            <button className="mdr-icon-btn mdr-icon-small" title="Edit comment" aria-label="Edit comment" onClick={() => setEditing(true)}>✎</button>
            <button className="mdr-icon-btn mdr-icon-small" title="Delete comment" aria-label="Delete comment" onClick={() => setConfirm(true)}>🗑</button>
          </span>
        )}
        <a className="mdr-muted" href={c.html_url} target="_blank" rel="noreferrer">{timeAgo(c.created_at)}</a>
      </div>
      {confirm && (
        <div className="mdr-confirm">
          Delete this comment on GitHub? This can't be undone.
          <button className="mdr-btn mdr-btn-small" onClick={() => setConfirm(false)}>Keep</button>
          <button className="mdr-btn mdr-btn-small mdr-btn-danger" onClick={() => actions.onDelete(c).finally(() => setConfirm(false))}>Delete</button>
        </div>
      )}
      {editing ? (
        <Editor
          initial={c.body}
          placeholder="Comment"
          saveLabel="Update comment"
          onCancel={() => setEditing(false)}
          onSave={async (text) => {
            await actions.onEdit(c, text.trim());
            setEditing(false);
          }}
        />
      ) : (
        <Body text={c.body} base={base} />
      )}
    </div>
  );
}

export interface Focus {
  side: Side;
  start: number;
  end: number;
}

function threadLabel(t: Thread) {
  if (t.kind === 'line') return lineLabel(t.start!, t.end!);
  if (t.kind === 'left') return lineLabel(t.start!, t.end!, 'LEFT');
  if (t.kind === 'file') return 'File';
  const l = t.root.original_line;
  return l ? `Outdated · was ${t.root.side === 'LEFT' ? 'removed ' : ''}line ${l}` : 'Outdated';
}

function ThreadCard({ t, focused, base, actions, onJump, onReply, onResolve }: {
  t: Thread;
  focused: boolean;
  base: string | null;
  actions: CommentActions;
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
        <button className="mdr-thread-label" onClick={onJump} disabled={t.kind !== 'line' && t.kind !== 'left'}>{threadLabel(t)}</button>
        <span className="mdr-spacer" />
        {onResolve && t.threadId && (
          <button className="mdr-btn mdr-btn-ghost mdr-btn-small" onClick={resolve} disabled={resolving}>
            {t.resolved ? 'Unresolve' : '✓ Resolve'}
          </button>
        )}
      </div>
      <Comment c={t.root} base={base} actions={actions} />
      {t.replies.map((r) => <Comment key={r.id} c={r} base={base} actions={actions} />)}
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

function DraftCard({ d, focused, stale, base, onJump, onDelete, onEdit }: {
  d: PendingComment;
  focused: boolean;
  stale: boolean;
  base: string | null;
  onJump: () => void;
  onDelete: () => void;
  onEdit: (body: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focused]);
  const label = lineLabel(d.start, d.end, d.side);
  return (
    <div ref={ref} className={`mdr-thread mdr-draft${focused ? ' mdr-thread-focus' : ''}`}>
      <div className="mdr-row mdr-thread-top">
        <button className="mdr-thread-label" onClick={onJump}>
          {d.kind === 'file' ? `File · ${label}` : label}
        </button>
        <span className="mdr-spacer" />
        {!editing && <button className="mdr-icon-btn mdr-icon-small" title="Edit draft" aria-label="Edit draft" onClick={() => setEditing(true)}>✎</button>}
        <button className="mdr-icon-btn mdr-icon-small" title="Delete draft" aria-label="Delete draft" onClick={onDelete}>✕</button>
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
        <Body text={d.body} base={base} />
      )}
    </div>
  );
}

function Collapsible({ title, count, open: initial = false, children }: { title: string; count: number; open?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(initial);
  if (!count) return null;
  return (
    <section>
      <button className="mdr-link mdr-collapse-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? '▾' : '▸'} {title} ({count})
      </button>
      {open && <div className="mdr-collapsible">{children}</div>}
    </section>
  );
}

const SEVERITY: Record<Finding['severity'], string> = { error: '⛔', warning: '⚠️', info: 'ℹ️' };

function Checks({ findings, onJump, onComment }: { findings: Finding[]; onJump: (line: number) => void; onComment: (f: Finding) => void }) {
  const [all, setAll] = useState(false);
  const inChange = findings.filter((f) => f.changed);
  const shown = all ? findings : inChange;
  if (!findings.length) return null;
  return (
    <section className="mdr-checks">
      <h4>
        Checks <span className="mdr-count">{inChange.length}</span>
        <span className="mdr-spacer" />
        {findings.length > inChange.length && (
          <button className="mdr-link mdr-small" onClick={() => setAll(!all)}>
            {all ? 'Only changed lines' : `+${findings.length - inChange.length} in unchanged lines`}
          </button>
        )}
      </h4>
      {!shown.length && <p className="mdr-muted mdr-empty">Nothing found in the lines this pull request changes.</p>}
      {shown.map((f, i) => (
        <div key={i} className={`mdr-finding mdr-finding-${f.severity}`}>
          <span aria-hidden>{SEVERITY[f.severity]}</span>
          <span className="mdr-finding-msg">
            {f.message}
            <span className="mdr-finding-meta">
              <button className="mdr-link" onClick={() => onJump(f.line)}>line {f.line}</button>
              {f.changed && (
                <>
                  {' · '}
                  <button className="mdr-link" onClick={() => onComment(f)}>Comment</button>
                </>
              )}
            </span>
          </span>
        </div>
      ))}
    </section>
  );
}

interface Props {
  threads: Thread[];
  drafts: PendingComment[];
  focus: Focus | null;
  headSha: string;
  /** Head-file lines, to show suggestions as diffs of what they replace. */
  lines: string[];
  /** Base-file lines, for suggestions… on removed text there are none, but outdated threads keep their own text. */
  viewer: string | null;
  findings: Finding[];
  onJump: (line: number, side: Side) => void;
  onReply: (t: Thread, body: string) => Promise<void>;
  onResolve: (t: Thread, resolved: boolean) => Promise<void>;
  onEditComment: (c: ReviewComment, body: string) => Promise<void>;
  onDeleteComment: (c: ReviewComment) => Promise<void>;
  onDeleteDraft: (id: string) => void;
  onEditDraft: (id: string, body: string) => void;
  onCommentFinding: (f: Finding) => void;
}

export function ThreadsPanel(p: Props) {
  const { threads, drafts, focus, headSha, lines, onJump } = p;
  const inFocus = (side: Side, s: number | null, e: number | null) =>
    !!focus && focus.side === side && s !== null && e !== null && e >= focus.start && s <= focus.end;
  const current = threads.filter((t) => !t.resolved && t.kind !== 'outdated');
  const outdated = threads.filter((t) => !t.resolved && t.kind === 'outdated');
  const resolved = threads.filter((t) => t.resolved);
  const actions: CommentActions = { viewer: p.viewer, onEdit: p.onEditComment, onDelete: p.onDeleteComment };
  const baseOf = (side: Side | undefined, start: number | null, end: number | null) =>
    side !== 'LEFT' && start && end && end <= lines.length ? lines.slice(start - 1, end).join('\n') : null;
  const card = (t: Thread, focusable = true) => (
    <ThreadCard
      key={t.root.id}
      t={t}
      focused={focusable && inFocus(t.kind === 'left' ? 'LEFT' : 'RIGHT', t.start, t.end)}
      base={t.kind === 'line' ? baseOf('RIGHT', t.start, t.end) : null}
      actions={actions}
      onJump={() => (t.kind === 'line' || t.kind === 'left') && t.end && onJump(t.end, t.kind === 'left' ? 'LEFT' : 'RIGHT')}
      onReply={(b) => p.onReply(t, b)}
      onResolve={(r) => p.onResolve(t, r)}
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
              focused={inFocus(d.side ?? 'RIGHT', d.start, d.end)}
              stale={!!d.sha && d.sha !== headSha}
              base={d.kind === 'line' && (!d.sha || d.sha === headSha) ? baseOf(d.side, d.start, d.end) : null}
              onJump={() => onJump(d.end, d.side ?? 'RIGHT')}
              onDelete={() => p.onDeleteDraft(d.id)}
              onEdit={(body) => p.onEditDraft(d.id, body)}
            />
          ))}
        </section>
      )}
      <section>
        <h4>Conversations <span className="mdr-count">{current.length}</span></h4>
        {!current.length && <p className="mdr-muted mdr-empty">Select text in the document, or use the + next to a paragraph, to comment.</p>}
        {current.map((t) => card(t))}
      </section>
      <Checks findings={p.findings} onJump={(l) => onJump(l, 'RIGHT')} onComment={p.onCommentFinding} />
      <Collapsible title="Outdated conversations" count={outdated.length}>{outdated.map((t) => card(t, false))}</Collapsible>
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
      c.subject_type === 'file' ? 'file' : c.line == null ? 'outdated' : c.side === 'LEFT' ? 'left' : 'line';
    const state = states?.get(c.id);
    const placed = kind === 'line' || kind === 'left';
    roots.set(c.id, {
      root: c,
      replies: [],
      kind,
      start: placed ? c.start_line ?? c.line : null,
      end: placed ? c.line : null,
      resolved: !!state?.resolved,
      threadId: state?.id,
    });
  }
  for (const c of forFile) {
    if (c.in_reply_to_id) roots.get(c.in_reply_to_id)?.replies.push(c);
  }
  const order = (t: Thread) => (t.kind === 'line' ? t.end! : t.kind === 'left' ? 1e8 + t.end! : 1e9);
  return [...roots.values()].sort((a, b) => order(a) - order(b) || a.root.id - b.root.id);
}
