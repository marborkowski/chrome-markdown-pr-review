import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, drafts as draftStore, gh } from '../api';
import { narrowLines, resolveAnchor } from '../lib/anchor';
import { contentFromRemovedPatch, parsePatch, type DiffInfo } from '../lib/patch';
import { prKey, type PendingComment, type PrContext, type PrFile, type PullRequest, type ReviewComment, type Thread, type ThreadState } from '../types';
import { Composer, type ComposerTarget } from './Composer';
import { ErrorBoundary } from './ErrorBoundary';
import { findAnchor } from '../lib/gfm';
import { makeUrlResolver, MarkdownDoc, reveal } from './MarkdownDoc';
import { SourceDoc } from './SourceDoc';
import { needsReviewCall, SubmitReview, type ReviewEvent } from './SubmitReview';
import { buildThreads, ThreadsPanel } from './Threads';
import { WordDiff } from './WordDiff';

interface Props {
  ctx: PrContext;
  pr: PullRequest;
  files: PrFile[];
  onClose: () => void;
  onReload: () => void;
}

type Toolbar = { rect: DOMRect; start: number; end: number; quote: string };
type Toast = { kind: 'ok' | 'err'; text: string } | null;

const pref = {
  get: (k: string, d: string) => {
    try { return localStorage.getItem(`mdr:${k}`) ?? d; } catch { return d; }
  },
  set: (k: string, v: string) => {
    try { localStorage.setItem(`mdr:${k}`, v); } catch { /* ignore */ }
  },
};

const STATUS: Record<string, { letter: string; cls: string }> = {
  added: { letter: 'A', cls: 'add' },
  removed: { letter: 'D', cls: 'del' },
  renamed: { letter: 'R', cls: 'ren' },
  copied: { letter: 'C', cls: 'ren' },
};

function splitPath(p: string) {
  const i = p.lastIndexOf('/');
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Review({ ctx, pr, files, onClose, onReload }: Props) {
  const key = prKey(ctx);
  const [path, setPath] = useState(() => {
    const last = sessionStorage.getItem(`mdr:last:${key}`);
    return files.find((f) => f.filename === last)?.filename ?? files[0]?.filename ?? '';
  });
  const [contents, setContents] = useState<Record<string, { text?: string; error?: string }>>({});
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [threadStates, setThreadStates] = useState<Map<number, ThreadState>>(() => new Map());
  const [viewed, setViewed] = useState<Record<string, boolean> | null>(null);
  const [drafts, setDrafts] = useState<PendingComment[]>([]);
  const [mode, setMode] = useState<'rendered' | 'source'>(() => (pref.get('mode', 'rendered') as any));
  const [inline, setInline] = useState(() => pref.get('inline', '1') === '1');
  const [toolbar, setToolbar] = useState<Toolbar | null>(null);
  const [composer, setComposer] = useState<ComposerTarget | null>(null);
  const [popover, setPopover] = useState<{ mods: number[]; rect: DOMRect } | null>(null);
  const [focus, setFocus] = useState<[number, number] | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [changeCount, setChangeCount] = useState(0);
  const [panelOpen, setPanelOpen] = useState(() => pref.get('panel', '1') === '1');

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<HTMLDivElement>(null);

  const file = files.find((f) => f.filename === path);

  const notify = useCallback((kind: 'ok' | 'err', text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast((t) => (t?.text === text ? null : t)), kind === 'err' ? 9000 : 3500);
  }, []);

  // ---- data loading -------------------------------------------------------
  const loadComments = useCallback(async () => {
    try {
      // Resolved state comes from GraphQL; without it (no token, old server) threads just can't be resolved here.
      const [list, states] = await Promise.all([gh.comments(ctx), gh.reviewThreads(ctx).catch(() => null)]);
      setComments(list);
      if (states) setThreadStates(states);
    } catch (e) {
      notify('err', `Couldn't load comments: ${errText(e)}`);
    }
  }, [ctx, notify]);

  useEffect(() => {
    loadComments();
    gh.viewedStates(ctx).then(setViewed).catch(() => setViewed(null));
    draftStore.load(key).then(setDrafts);
  }, [key]);

  useEffect(() => {
    if (!file || contents[file.filename]) return;
    sessionStorage.setItem(`mdr:last:${key}`, file.filename);
    if (file.status === 'removed' && file.patch) {
      setContents((c) => ({ ...c, [file.filename]: { text: contentFromRemovedPatch(file.patch) } }));
      return;
    }
    // A deleted file without a patch (too large to diff) is read from the base commit.
    gh.raw(ctx, file.filename, file.status === 'removed' ? pr.base.sha : pr.head.sha)
      .then((text) => setContents((c) => ({ ...c, [file.filename]: { text } })))
      .catch((e) => setContents((c) => ({ ...c, [file.filename]: { error: errText(e) } })));
  }, [file?.filename, pr.head.sha]);

  useEffect(() => {
    setToolbar(null);
    setComposer(null);
    setPopover(null);
    setFocus(null);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [path]);

  const saveDrafts = useCallback(
    (next: PendingComment[]) => {
      setDrafts(next);
      draftStore.save(key, next);
    },
    [key],
  );

  // ---- derived ------------------------------------------------------------
  const text = file ? contents[file.filename]?.text : undefined;
  const lines = useMemo(() => (text ?? '').split(/\r?\n/), [text]);
  const rawDiff = useMemo(() => (file && file.status !== 'removed' ? parsePatch(file.patch) : null), [file]);
  /** For brand-new files every line is "added" – highlighting it all is just noise. */
  const shownDiff: DiffInfo | null = useMemo(
    () => (rawDiff && file?.status === 'added' ? { ...rawDiff, added: new Set(), removals: [] } : rawDiff),
    [rawDiff, file?.status],
  );
  const threads = useMemo(() => buildThreads(comments, path, threadStates), [comments, path, threadStates]);
  /** Resolved conversations don't get a badge in the document. */
  const threadLines = useMemo(() => threads.filter((t) => t.kind === 'line' && !t.resolved).map((t) => t.end!), [threads]);
  const fileDrafts = useMemo(() => drafts.filter((d) => d.path === path), [drafts, path]);
  const pendingLines = useMemo(() => fileDrafts.map((d) => d.end), [fileDrafts]);
  const activeRange = useMemo<[number, number] | null>(
    () => (composer ? [composer.anchor.start, composer.anchor.end] : null),
    [composer],
  );
  const resolveUrl = useMemo(
    () => makeUrlResolver(ctx.origin, ctx.owner, ctx.repo, file?.status === 'removed' ? pr.base.sha : pr.head.sha, path),
    [ctx, pr, path, file?.status],
  );
  const threadCount = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of comments) if (!c.in_reply_to_id && !threadStates.get(c.id)?.resolved) m[c.path] = (m[c.path] ?? 0) + 1;
    return m;
  }, [comments, threadStates]);

  // ---- selection → comment ------------------------------------------------
  const getSelection = () => {
    const root = rootRef.current?.getRootNode() as (ShadowRoot & { getSelection?: () => Selection | null }) | Document | undefined;
    return (root && 'getSelection' in root && root.getSelection?.()) || document.getSelection();
  };

  const onMouseUp = () => {
    window.setTimeout(() => {
      const sel = getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount || !docRef.current) return setToolbar(null);
      const range = sel.getRangeAt(0);
      if (!docRef.current.contains(range.commonAncestorContainer)) return setToolbar(null);
      const quote = sel.toString().trim();
      if (!quote) return setToolbar(null);
      const elOf = (n: Node) => (n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement);
      const startEl = elOf(range.startContainer);
      let endEl = elOf(range.endContainer);
      if (range.endOffset === 0 && range.endContainer !== range.startContainer && range.endContainer.nodeType === Node.ELEMENT_NODE) {
        endEl = startEl; // triple-click selects up to the start of the next block
      }
      if (!startEl || !endEl || startEl.closest('.mdr-removed, .mdr-src-del') || endEl.closest('.mdr-removed, .mdr-src-del')) {
        return setToolbar(null);
      }
      const a = startEl.closest('[data-sl]');
      const b = endEl.closest('[data-sl]');
      if (!a || !b) return setToolbar(null);
      const sl = Math.min(Number(a.getAttribute('data-sl')), Number(b.getAttribute('data-sl')));
      const el = Math.max(Number(a.getAttribute('data-el')), Number(b.getAttribute('data-el')));
      const { start, end } = narrowLines(lines, sl, el, quote);
      setToolbar({ rect: range.getBoundingClientRect(), start, end, quote });
    }, 0);
  };

  const openComposer = (suggest: boolean) => {
    if (!toolbar) return;
    const anchor = file?.status === 'removed'
      ? { kind: 'file' as const, start: toolbar.start, end: toolbar.end, reason: 'the file was deleted' }
      : resolveAnchor(rawDiff, toolbar.start, toolbar.end);
    const r = toolbar.rect;
    setComposer({ anchor, quote: toolbar.quote, suggest, rect: { top: r.top, bottom: r.bottom, left: r.left, width: r.width } });
    setToolbar(null);
  };

  const submitComment = async (body: string, how: 'now' | 'review') => {
    if (!composer || !file) return;
    const { anchor } = composer;
    if (how === 'review') {
      saveDrafts([
        ...drafts,
        { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, path: file.filename, kind: anchor.kind, start: anchor.start, end: anchor.end, body, quote: composer.quote, createdAt: Date.now(), sha: pr.head.sha },
      ]);
      setComposer(null);
      getSelection()?.removeAllRanges();
      return;
    }
    setBusy(true);
    try {
      if (anchor.kind === 'line') {
        await gh.createLineComment(ctx, pr.head.sha, { path: file.filename, body, line: anchor.end, start_line: anchor.start });
      } else {
        await gh.createFileComment(ctx, pr.head.sha, file.filename, body);
      }
      setComposer(null);
      getSelection()?.removeAllRanges();
      notify('ok', 'Comment posted');
      loadComments();
    } catch (e) {
      notify('err', `GitHub rejected the comment: ${errText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const submitReview = async (event: ReviewEvent, body: string) => {
    setBusy(true);
    let remaining = drafts;
    try {
      const lineDrafts = drafts.filter((d) => d.kind === 'line');
      // File-level drafts are posted separately; a plain comment review with nothing else in it would be rejected.
      if (needsReviewCall(event, body, lineDrafts.length)) {
        await gh.createReview(
          ctx,
          pr.head.sha,
          event,
          body,
          lineDrafts.map((d) => ({ path: d.path, body: d.body, line: d.end, start_line: d.start })),
        );
      }
      remaining = remaining.filter((d) => d.kind !== 'line');
      saveDrafts(remaining);
      for (const d of drafts.filter((x) => x.kind === 'file')) {
        await gh.createFileComment(ctx, pr.head.sha, d.path, d.body);
        remaining = remaining.filter((x) => x.id !== d.id);
        saveDrafts(remaining);
      }
      setSubmitOpen(false);
      notify('ok', 'Review submitted');
      loadComments();
    } catch (e) {
      const hint = e instanceof ApiError && /pending review/i.test(e.message)
        ? ' – you have a pending review started in the GitHub UI; submit or discard it there first.'
        : '';
      notify('err', `Couldn't submit the review: ${errText(e)}${hint}`);
    } finally {
      setBusy(false);
    }
  };

  const reply = async (t: Thread, body: string) => {
    try {
      await gh.reply(ctx, t.root.id, body);
      await loadComments();
    } catch (e) {
      notify('err', `Couldn't reply: ${errText(e)}`);
      throw e;
    }
  };

  const resolveThread = async (t: Thread, resolved: boolean) => {
    if (!t.threadId) return;
    try {
      await gh.setThreadResolved(ctx, t.threadId, resolved);
      setThreadStates((m) => new Map(m).set(t.root.id, { id: t.threadId!, resolved }));
    } catch (e) {
      notify('err', `Couldn't ${resolved ? 'resolve' : 'unresolve'} the conversation: ${errText(e)}`);
    }
  };

  const toggleViewed = async () => {
    if (!viewed || !file) return;
    const next = !viewed[file.filename];
    setViewed({ ...viewed, [file.filename]: next });
    try {
      await gh.setViewed(ctx, pr.node_id, file.filename, next);
      if (next) {
        const i = files.findIndex((f) => f.filename === file.filename);
        const nextUnviewed = [...files.slice(i + 1), ...files.slice(0, i)].find((f) => !viewed[f.filename]);
        if (nextUnviewed) setPath(nextUnviewed.filename);
      }
    } catch (e) {
      setViewed({ ...viewed, [file.filename]: !next });
      notify('err', `Couldn't update viewed state: ${errText(e)}`);
    }
  };

  // ---- navigation ---------------------------------------------------------
  const changeEls = useCallback((): HTMLElement[] => {
    const all = [...(docRef.current?.querySelectorAll<HTMLElement>('.mdr-added, .mdr-mod, .mdr-removed, .mdr-removed-start') ?? [])];
    return all.filter((el, i) => {
      const prev = all[i - 1];
      if (!prev) return true;
      if (prev.contains(el)) return false;
      let s = el.previousElementSibling;
      while (s && s !== prev && s.classList.contains('mdr-src-del')) s = s.previousElementSibling;
      return s !== prev;
    });
  }, []);

  useEffect(() => {
    const id = requestAnimationFrame(() => setChangeCount(changeEls().length));
    return () => cancelAnimationFrame(id);
  });

  const gotoChange = (dir: 1 | -1) => {
    const els = changeEls();
    const box = scrollRef.current?.getBoundingClientRect();
    if (!els.length || !box) return;
    const mid = box.top + box.height / 2;
    const target = dir === 1
      ? els.find((e) => e.getBoundingClientRect().top > mid + 4) ?? els[0]
      : [...els].reverse().find((e) => e.getBoundingClientRect().top < mid - 4) ?? els[els.length - 1];
    reveal(target);
  };

  const jumpToLine = useCallback((line: number) => {
    const blocks = [...(docRef.current?.querySelectorAll<HTMLElement>('[data-block]') ?? [])];
    let best: HTMLElement | null = null;
    let span = Infinity;
    for (const b of blocks) {
      const s = Number(b.dataset.sl);
      const e = Number(b.dataset.el);
      if (s <= line && line <= e && e - s <= span) {
        best = b;
        span = e - s;
      }
    }
    if (best) reveal(best);
    setFocus([line, line]);
  }, []);

  const onBadge = useCallback((sl: number, el: number) => {
    setFocus([sl, el]);
    setPanelOpen(true);
  }, []);
  const onMods = useCallback((mods: number[], anchor: HTMLElement) => {
    setPopover({ mods, rect: anchor.getBoundingClientRect() });
  }, []);

  /** Links to another Markdown file of this PR open it in the review (and jump to its #anchor). */
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);
  const onLink = useCallback(
    (href: string) => {
      const base = `${ctx.origin}/${ctx.owner}/${ctx.repo}/blob/`;
      if (!href.startsWith(base)) return false;
      const rest = href.slice(base.length);
      const [target, hash = ''] = rest.slice(rest.indexOf('/') + 1).split('#');
      let name: string;
      try {
        name = target.split('?')[0].split('/').map(decodeURIComponent).join('/');
      } catch {
        return false;
      }
      const f = files.find((x) => x.filename === name);
      if (!f) return false;
      setPath(f.filename);
      setPendingAnchor(hash || null);
      return true;
    },
    [ctx, files],
  );

  useEffect(() => {
    if (!pendingAnchor || text === undefined) return;
    const id = requestAnimationFrame(() => {
      const el = findAnchor(docRef.current, pendingAnchor);
      if (el) reveal(el);
      setPendingAnchor(null);
    });
    return () => cancelAnimationFrame(id);
  }, [pendingAnchor, text, mode]);

  const switchFile = (delta: number) => {
    const i = files.findIndex((f) => f.filename === path);
    const n = files[(i + delta + files.length) % files.length];
    if (n) setPath(n.filename);
  };

  // ---- keyboard -----------------------------------------------------------
  type KeyLike = Pick<KeyboardEvent, 'key' | 'target' | 'metaKey' | 'ctrlKey' | 'altKey' | 'preventDefault' | 'stopPropagation'>;
  const onKeyDown = (e: KeyLike) => {
    const t = e.target as HTMLElement;
    const typing = t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable;
    if (e.key === 'Escape') {
      if (popover) setPopover(null);
      else if (composer) setComposer(null);
      else if (toolbar) setToolbar(null);
      else if (typing) t.blur(); // leave a reply box first; closing would throw away what was typed
      else if (!submitOpen) onClose();
      e.stopPropagation();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'n') gotoChange(1);
    else if (e.key === 'p') gotoChange(-1);
    else if (e.key === ']') switchFile(1);
    else if (e.key === '[') switchFile(-1);
    else if (e.key === 'v') toggleViewed();
    else if (e.key === 'c' && toolbar) { e.preventDefault(); openComposer(false); }
    else if (e.key === 's' && toolbar && file?.status !== 'removed') { e.preventDefault(); openComposer(true); }
    else return;
    e.stopPropagation();
  };

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  // When focus falls back to the page (e.g. after a popover closes), keep our shortcuts working
  // and keep GitHub's own hotkeys from firing underneath the overlay.
  const keyRef = useRef(onKeyDown);
  keyRef.current = onKeyDown;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || e.composedPath().includes(root)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      keyRef.current(e);
      root.focus({ preventScroll: true });
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, []);
  useEffect(() => {
    if (!composer && !submitOpen) rootRef.current?.focus({ preventScroll: true });
  }, [composer, submitOpen]);

  // Stop GitHub's global hotkeys while the overlay is open.
  const stopKeys = (e: React.KeyboardEvent) => e.nativeEvent.stopImmediatePropagation?.();

  // ---- render -------------------------------------------------------------
  const isViewed = !!(viewed && file && viewed[file.filename]);
  const viewedCount = viewed ? files.filter((f) => viewed[f.filename]).length : 0;

  return (
    <div className="mdr-overlay" ref={rootRef} tabIndex={-1} onKeyDown={(e) => { onKeyDown(e.nativeEvent); stopKeys(e); }} onKeyUp={stopKeys} onKeyPress={stopKeys}>
      <header className="mdr-header">
        <div className="mdr-brand" title="Markdown PR Review">
          <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden><path fill="currentColor" d="M14.85 3c.63 0 1.15.52 1.14 1.15v7.7c0 .63-.51 1.15-1.15 1.15H1.15C.52 13 0 12.48 0 11.84V4.15C0 3.52.52 3 1.15 3ZM9 11V5H7L5.5 7 4 5H2v6h2V8l1.5 1.92L7 8v3Zm2.99.5L14.5 8H13V5h-2v3H9.5Z" /></svg>
        </div>
        <div className="mdr-title">
          <a href={pr.html_url} target="_blank" rel="noreferrer">{pr.title}</a>
          <span className="mdr-muted"> #{pr.number}</span>
        </div>
        <div className="mdr-seg" role="tablist">
          {(['rendered', 'source'] as const).map((m) => (
            <button key={m} className={mode === m ? 'on' : ''} onClick={() => { setMode(m); pref.set('mode', m); }}>
              {m === 'rendered' ? 'Rendered' : 'Source'}
            </button>
          ))}
        </div>
        {mode === 'rendered' && (
          <label className="mdr-toggle" title="Show changed paragraphs as a word-level diff">
            <input type="checkbox" checked={inline} onChange={(e) => { setInline(e.target.checked); pref.set('inline', e.target.checked ? '1' : '0'); }} />
            Word diff
          </label>
        )}
        <div className="mdr-nav" title="Previous / next change (p / n)">
          <button className="mdr-icon-btn" onClick={() => gotoChange(-1)} disabled={!changeCount}>↑</button>
          <span className="mdr-muted">{changeCount} change{changeCount === 1 ? '' : 's'}</span>
          <button className="mdr-icon-btn" onClick={() => gotoChange(1)} disabled={!changeCount}>↓</button>
        </div>
        <span className="mdr-spacer" />
        <button className="mdr-icon-btn" title="Reload pull request" onClick={onReload}>⟳</button>
        <button className="mdr-icon-btn" title="Toggle comments panel" onClick={() => { setPanelOpen(!panelOpen); pref.set('panel', panelOpen ? '0' : '1'); }}>
          ☰
        </button>
        <button className="mdr-btn mdr-btn-primary" onClick={() => setSubmitOpen(true)}>
          Finish review{drafts.length ? <span className="mdr-pill">{drafts.length}</span> : null}
        </button>
        <button className="mdr-icon-btn mdr-close" title="Close (Esc)" onClick={onClose}>✕</button>
      </header>

      <div className={`mdr-body${panelOpen ? '' : ' mdr-no-panel'}`}>
        <nav className="mdr-files">
          <div className="mdr-files-head">
            Markdown files <span className="mdr-count">{files.length}</span>
            {viewed && <span className="mdr-muted mdr-viewed-count">{viewedCount}/{files.length} viewed</span>}
          </div>
          {files.map((f) => {
            const { dir, name } = splitPath(f.filename);
            const st = STATUS[f.status];
            const drafted = drafts.filter((d) => d.path === f.filename).length;
            return (
              <button key={f.filename} className={`mdr-file${f.filename === path ? ' on' : ''}${viewed?.[f.filename] ? ' viewed' : ''}`} onClick={() => setPath(f.filename)} title={f.filename}>
                <span className="mdr-file-name">
                  {st && <span className={`mdr-status mdr-status-${st.cls}`}>{st.letter}</span>}
                  <span className="mdr-file-dir">{dir}</span>
                  <b>{name}</b>
                </span>
                <span className="mdr-file-meta">
                  <span className="mdr-add">+{f.additions}</span>
                  <span className="mdr-del">−{f.deletions}</span>
                  {threadCount[f.filename] ? <span>💬 {threadCount[f.filename]}</span> : null}
                  {drafted ? <span className="mdr-draft-dot">{drafted} draft</span> : null}
                  {viewed?.[f.filename] && <span className="mdr-check">✓</span>}
                </span>
              </button>
            );
          })}
          <div className="mdr-files-foot mdr-muted">
            <kbd>n</kbd>/<kbd>p</kbd> next/prev change · <kbd>[</kbd>/<kbd>]</kbd> file · <kbd>v</kbd> viewed · select text + <kbd>c</kbd> comment / <kbd>s</kbd> suggest
          </div>
        </nav>

        <main className="mdr-main" ref={scrollRef} onScroll={() => { if (toolbar) setToolbar(null); if (popover) setPopover(null); }}>
          {file && (
            <div className="mdr-filebar">
              <span className="mdr-filebar-path">{file.previous_filename ? `${file.previous_filename} → ` : ''}{file.filename}</span>
              <span className="mdr-add">+{file.additions}</span>
              <span className="mdr-del">−{file.deletions}</span>
              {!file.patch && file.status !== 'removed' && <span className="mdr-warn">Diff too large – comments will be file-level</span>}
              <span className="mdr-spacer" />
              <a className="mdr-link" href={`${ctx.origin}/${ctx.owner}/${ctx.repo}/blob/${file.status === 'removed' ? pr.base.sha : pr.head.sha}/${file.filename}`} target="_blank" rel="noreferrer">
                View file
              </a>
              {viewed && (
                <label className="mdr-toggle mdr-viewed-toggle">
                  <input type="checkbox" checked={isViewed} onChange={toggleViewed} /> Viewed
                </label>
              )}
            </div>
          )}
          {file?.status === 'removed' && <div className="mdr-banner mdr-banner-del">This file is deleted in this pull request.</div>}
          {file?.status === 'added' && <div className="mdr-banner mdr-banner-add">New file</div>}

          <div className="mdr-doc-wrap">
            {!file && <p className="mdr-muted">No Markdown files in this pull request.</p>}
            {file && text === undefined && !contents[file.filename]?.error && <div className="mdr-skeleton"><div /><div /><div /><div /></div>}
            {file && contents[file.filename]?.error && <div className="mdr-banner mdr-banner-del">Couldn't load the file: {contents[file.filename]!.error}</div>}
            {file && text !== undefined && !text.trim() && <p className="mdr-muted mdr-empty-doc">This file is empty.</p>}
            {file && text !== undefined && !!text.trim() && (
              <article ref={docRef} className={`markdown-body mdr-doc mdr-mode-${mode}`} onMouseUp={onMouseUp}>
                {mode === 'rendered' ? (
                  <ErrorBoundary
                    key={file.filename}
                    fallback={(e) => (
                      <div className="mdr-banner mdr-banner-del">
                        Couldn't render this file: {e.message}{' '}
                        <button className="mdr-link" onClick={() => setMode('source')}>Show source</button>
                      </div>
                    )}
                  >
                    <MarkdownDoc
                      source={text}
                      diff={shownDiff}
                      threadLines={threadLines}
                      pendingLines={pendingLines}
                      activeRange={activeRange}
                      inlineDiff={inline}
                      resolveUrl={resolveUrl}
                      onBadge={onBadge}
                      onMods={onMods}
                      onLink={onLink}
                    />
                  </ErrorBoundary>
                ) : (
                  <SourceDoc source={text} diff={shownDiff} threadLines={threadLines} pendingLines={pendingLines} activeRange={activeRange} onBadge={onBadge} />
                )}
              </article>
            )}
          </div>
        </main>

        {panelOpen && (
          <aside className="mdr-side">
            <ThreadsPanel
              threads={threads}
              drafts={fileDrafts}
              focus={focus}
              headSha={pr.head.sha}
              onJump={jumpToLine}
              onReply={reply}
              onResolve={resolveThread}
              onDeleteDraft={(id) => saveDrafts(drafts.filter((d) => d.id !== id))}
              onEditDraft={(id, body) => saveDrafts(drafts.map((d) => (d.id === id ? { ...d, body } : d)))}
            />
          </aside>
        )}
      </div>

      {toolbar && !composer && (
        <div className="mdr-toolbar" style={{ top: Math.max(8, toolbar.rect.top - 44), left: toolbar.rect.left + toolbar.rect.width / 2 }} onMouseDown={(e) => e.preventDefault()}>
          <button onClick={() => openComposer(false)} title="Comment (c)">💬 Comment</button>
          <button onClick={() => openComposer(true)} disabled={file?.status === 'removed'} title="Suggest a change (s)">± Suggest</button>
        </div>
      )}

      {composer && (
        <Composer
          key={`${composer.anchor.start}-${composer.anchor.end}-${composer.quote.length}`}
          target={composer}
          lines={lines}
          hasDrafts={drafts.length > 0}
          busy={busy}
          onCancel={() => setComposer(null)}
          onSubmit={submitComment}
        />
      )}

      {popover && shownDiff && (
        <>
          <div className="mdr-popover-backdrop" onMouseDown={() => setPopover(null)} />
          <div className="mdr-popover" style={{ top: Math.min(popover.rect.bottom + 6, window.innerHeight - 260), left: Math.max(12, popover.rect.right - 440) }}>
            {popover.mods.map((i) => {
              const r = shownDiff.removals[i];
              if (!r) return null;
              return (
                <div key={i} className="mdr-popover-item">
                  {r.replacedBy ? (
                    <>
                      <div className="mdr-muted">Changed {r.replacedBy.start === r.replacedBy.end ? `line ${r.replacedBy.start}` : `lines ${r.replacedBy.start}–${r.replacedBy.end}`}</div>
                      <WordDiff oldText={r.lines.join('\n')} newText={lines.slice(r.replacedBy.start - 1, r.replacedBy.end).join('\n')} />
                    </>
                  ) : (
                    <>
                      <div className="mdr-muted">Removed</div>
                      <span className="mdr-worddiff"><del>{r.lines.join('\n')}</del></span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {submitOpen && (
        <SubmitReview
          draftCount={drafts.length}
          lineDraftCount={drafts.filter((d) => d.kind === 'line').length}
          staleCount={drafts.filter((d) => d.sha && d.sha !== pr.head.sha).length}
          busy={busy}
          onCancel={() => setSubmitOpen(false)}
          onSubmit={submitReview}
        />
      )}

      {toast && (
        <div className={`mdr-toast mdr-toast-${toast.kind}`} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
    </div>
  );
}
