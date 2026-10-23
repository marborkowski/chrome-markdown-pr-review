import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, drafts as draftStore, gh } from '../api';
import { locateRemoved, narrowLines, resolveAnchor, type Anchor, type Side } from '../lib/anchor';
import { anchorsOf, runChecks, type Finding } from '../lib/checks';
import { findAnchor } from '../lib/gfm';
import { outlineOf, parseMarkdown, verbatimLines, type OutlineItem } from '../lib/outline';
import { baseLines, contentFromRemovedPatch, diffTexts, emptyDiff, headToBase, parsePatch, presentDiff, type DiffInfo } from '../lib/patch';
import { rangeToQuote } from '../lib/quote';
import { prKey, type Commit, type Compare, type PendingComment, type PrContext, type PrFile, type PullRequest, type ReviewComment, type Thread, type ThreadState } from '../types';
import { Composer, type ComposerTarget } from './Composer';
import { ErrorBoundary } from './ErrorBoundary';
import { FileNav } from './FileNav';
import { makeUrlResolver, MarkdownDoc, reveal, type AssetChange } from './MarkdownDoc';
import { CompareMenu, Help, ViewMenu, type CompareChoice, type ViewOptions } from './Menus';
import { SourceDoc } from './SourceDoc';
import { SplitView } from './SplitView';
import { needsReviewCall, SubmitReview, type ReviewEvent } from './SubmitReview';
import { buildThreads, ThreadsPanel, type Focus } from './Threads';
import { WordDiff } from './WordDiff';

export interface ReviewProps {
  ctx: PrContext;
  pr: PullRequest;
  /** The PR's Markdown files. */
  files: PrFile[];
  /** Every file of the PR (images the documents show, …). */
  allFiles?: PrFile[];
  onClose: () => void;
  onReload: () => void;
}

type Mode = 'rendered' | 'split' | 'source';
type Toolbar = { rect: DOMRect; start: number; end: number; side: Side; quote: string; phrase: string };
type Hover = { start: number; end: number; side: Side; top: number; left: number; el: HTMLElement };
type Toast = { kind: 'ok' | 'err'; text: string } | null;
type Text = { text?: string; error?: string };

const pref = {
  get: (k: string, d: string) => {
    try { return localStorage.getItem(`mdr:${k}`) ?? d; } catch { return d; }
  },
  set: (k: string, v: string) => {
    try { localStorage.setItem(`mdr:${k}`, v); } catch { /* ignore */ }
  },
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Removed text (left side of the diff): removed blocks and rows, deleted source lines, the old version in split view. */
const OLD_AREA = '.mdr-removed, .mdr-removed-row, .mdr-src-del, .mdr-split-before';
/** Old versions that aren't lines of the base file (a diagram's or formula's previous rendering): not commentable. */
const NOT_COMMENTABLE = '.mdr-mermaid-old, g.mdrRemoved, .mdr-math-old, .mdr-img-before, .mdr-removed-moved';

/** A selection's text as it reads now: struck-out (deleted) words and image placeholders left out. */
const phraseOf = (quote: string) =>
  quote
    .replace(/~~[^~\n]*~~/g, ' ')
    .replace(/\S̶/g, '')
    .replace(/\[image(?::[^\]]*)?\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
/** What to match against source lines: everything selected, without strike markers and image placeholders. */
const matchText = (quote: string) => quote.replace(/~~/g, '').replace(/̶/g, '').replace(/\[image(?::[^\]]*)?\]/g, ' ');

/** A block's text as a short quote (for commenting on a whole block). */
function blockQuote(el: Element): string {
  const r = document.createRange();
  r.selectNodeContents(el);
  const q = rangeToQuote(r);
  if (q.length <= 300) return q;
  const cut = q.slice(0, 300);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 200)) + ' …';
}

const pathOfRaw = (src: string, prefix: string) => {
  if (!src.startsWith(prefix)) return null;
  try {
    return src.slice(prefix.length).split('#')[0].split('/').map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
};
const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export function Review({ ctx, pr, files, allFiles = files, onClose, onReload }: ReviewProps) {
  const key = prKey(ctx);
  const [path, setPath] = useState(() => {
    const last = sessionStorage.getItem(`mdr:last:${key}`);
    return files.find((f) => f.filename === last)?.filename ?? files[0]?.filename ?? '';
  });
  const [contents, setContents] = useState<Record<string, Text>>({});
  const [baseTexts, setBaseTexts] = useState<Record<string, Text>>({});
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [threadStates, setThreadStates] = useState<Map<number, ThreadState>>(() => new Map());
  const [viewed, setViewed] = useState<Record<string, boolean> | null>(null);
  const [drafts, setDrafts] = useState<PendingComment[]>([]);
  const [mode, setMode] = useState<Mode>(() => {
    const m = pref.get('mode', 'rendered');
    return m === 'split' || m === 'source' ? m : 'rendered';
  });
  const [view, setView] = useState<ViewOptions>(() => ({
    inline: pref.get('inline', '1') === '1',
    ignoreWs: pref.get('ws', '1') === '1',
    fold: pref.get('fold', '0') === '1',
    docsSyntax: pref.get('docs', '1') === '1',
  }));
  const [toolbar, setToolbar] = useState<Toolbar | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [composer, setComposer] = useState<ComposerTarget | null>(null);
  const [popover, setPopover] = useState<{ mods: number[]; rect: DOMRect } | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [summary, setSummary] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [changeCount, setChangeCount] = useState(0);
  /** Which change n / p last went to (1-based), shown as "3 / 10". */
  const [changePos, setChangePos] = useState<number | null>(null);
  const [panelOpen, setPanelOpen] = useState(() => pref.get('panel', '1') === '1');
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [viewer, setViewer] = useState<string | null>(null);
  const [lastReviewed, setLastReviewed] = useState<string | null>(null);
  const [pendingReviewUrl, setPendingReviewUrl] = useState<string | null>(null);
  const [compare, setCompare] = useState<CompareChoice | null>(null);
  const [compareData, setCompareData] = useState<{ sha: string; data?: Compare; error?: string } | null>(null);
  const [mergeBase, setMergeBase] = useState<string | null>(null);
  const [paths, setPaths] = useState<Set<string> | null | undefined>(undefined);
  const [newHead, setNewHead] = useState<string | null>(null);
  const [activeHeading, setActiveHeading] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const scrollPos = useRef(new Map<string, number>());

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
    gh.commits(ctx).then(setCommits).catch(() => setCommits([]));
    // Who is reviewing, and their reviews: for "since your last review" and a pending review started in GitHub's UI.
    Promise.all([gh.viewer(ctx).catch(() => null), gh.reviews(ctx).catch(() => [])]).then(([me, reviews]) => {
      if (!me) return;
      setViewer(me.login);
      const mine = reviews.filter((r) => r.user?.login === me.login);
      const done = mine.filter((r) => r.state !== 'PENDING' && r.commit_id);
      setLastReviewed(done.length ? done[done.length - 1].commit_id : null);
      const pending = mine.find((r) => r.state === 'PENDING');
      setPendingReviewUrl(pending ? pending.html_url ?? pr.html_url : null);
    });
  }, [key]);

  // New commits or comments while the review is open: GitHub answers 304 (free) when nothing changed.
  const knownComments = useRef(pr.review_comments);
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.hidden) return;
      gh.pr(ctx)
        .then((now) => {
          if (now.head.sha !== pr.head.sha) setNewHead(now.head.sha);
          if (now.review_comments !== undefined && now.review_comments !== knownComments.current) {
            knownComments.current = now.review_comments;
            loadComments();
          }
        })
        .catch(() => {});
    }, 60_000);
    return () => window.clearInterval(t);
  }, [ctx, pr.head.sha, loadComments]);

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
    if (!compare) return setCompareData(null);
    let live = true;
    setCompareData({ sha: compare.sha });
    gh.compare(ctx, compare.sha, pr.head.sha)
      .then((data) => live && setCompareData({ sha: compare.sha, data }))
      .catch((e) => live && setCompareData({ sha: compare.sha, error: errText(e) }));
    return () => {
      live = false;
    };
  }, [compare?.sha, pr.head.sha]);

  useEffect(() => {
    setToolbar(null);
    setComposer(null);
    setPopover(null);
    setFocus(null);
    setHover(null);
    setChangePos(null);
  }, [path, mode, compare?.sha]);

  const saveDrafts = useCallback(
    (next: PendingComment[]) => {
      setDrafts(next);
      draftStore.save(key, next);
    },
    [key],
  );

  /** Switch files, remembering where the reader was in the one they leave. */
  const selectPath = useCallback(
    (p: string) => {
      const el = scrollRef.current;
      if (el) scrollPos.current.set(path, el.scrollTop);
      setPath(p);
    },
    [path],
  );

  // ---- derived ------------------------------------------------------------
  const text = file ? contents[file.filename]?.text : undefined;
  const lines = useMemo(() => (text ?? '').split(/\r?\n/), [text]);
  /** GitHub's diff of the file: comments can only be anchored to its hunks. */
  const isRemoved = file?.status === 'removed';
  const rawDiff = useMemo(() => (file && (file.patch || !isRemoved) ? parsePatch(file.patch) : null), [file, isRemoved]);

  /** What the highlighted changes are computed from. */
  type Plan =
    | { kind: 'patch'; patch: string }
    | { kind: 'texts'; sha: string; path: string }
    /** Nothing to highlight; `empty`: the file didn't exist in the version compared against. */
    | { kind: 'none'; note?: string; empty?: boolean }
    | { kind: 'loading'; note: string };
  const plan = useMemo<Plan>(() => {
    if (!file || isRemoved) return { kind: 'none' };
    if (compare) {
      if (!compareData || (!compareData.data && !compareData.error)) return { kind: 'loading', note: `Loading the changes since ${compare.label}…` };
      const d = compareData.data;
      if (!d || d.status === 'diverged' || d.status === 'behind') return { kind: 'texts', sha: compare.sha, path: file.filename };
      const cf = d.files?.find((f) => f.filename === file.filename);
      // GitHub lists at most 300 files of a comparison: beyond that a missing file is unknown, not unchanged.
      if (!cf && (d.files?.length ?? 0) >= 300) return { kind: 'texts', sha: compare.sha, path: file.filename };
      if (!cf) return { kind: 'none', note: `No changes to this file since ${compare.label}.` };
      if (cf.status === 'added') return { kind: 'none', note: `This file is new since ${compare.label}.`, empty: true };
      if (cf.patch) return { kind: 'patch', patch: cf.patch };
      return { kind: 'texts', sha: compare.sha, path: cf.previous_filename ?? file.filename };
    }
    if (file.status === 'added') return { kind: 'none', empty: true }; // everything would be green: just noise
    if (file.patch) return { kind: 'patch', patch: file.patch };
    if (!file.changes) return { kind: 'none' }; // a pure rename
    if (!mergeBase) return { kind: 'loading', note: 'GitHub sends no diff for this file (too large) – computing it…' };
    return { kind: 'texts', sha: mergeBase, path: file.previous_filename ?? file.filename };
  }, [file, isRemoved, compare, compareData, mergeBase]);

  // GitHub sends no patch for very large diffs: compute it from the merge base instead.
  useEffect(() => {
    if (!file || isRemoved || compare || file.patch || file.status === 'added' || !file.changes || mergeBase) return;
    gh.compare(ctx, pr.base.sha, pr.head.sha)
      .then((d) => setMergeBase(d.merge_base_commit.sha))
      .catch(() => setMergeBase(pr.base.sha));
  }, [file?.filename, compare]);

  const baseKey = plan.kind === 'texts' ? `${plan.sha}:${plan.path}` : null;
  useEffect(() => {
    if (plan.kind !== 'texts' || baseTexts[baseKey!]) return;
    gh.raw(ctx, plan.path, plan.sha)
      .then((t) => setBaseTexts((b) => ({ ...b, [baseKey!]: { text: t } })))
      // Not in that commit: the file is new since then.
      .catch((e) => setBaseTexts((b) => ({ ...b, [baseKey!]: e instanceof ApiError && e.status === 404 ? { text: '' } : { error: errText(e) } })));
  }, [baseKey]);

  /** A diff computed here (no patch from GitHub); null when it gave up: too large to do on the page's thread. */
  const baseText = plan.kind === 'texts' ? baseTexts[baseKey!]?.text : undefined;
  const localPatch = useMemo(() => (baseText !== undefined && text !== undefined ? diffTexts(baseText, text) : undefined), [baseText, text]);
  /** The diff the document highlights (before hiding whitespace-only changes). */
  const displayDiff = useMemo<DiffInfo | null>(() => {
    if (!file || isRemoved || text === undefined) return null;
    if (plan.kind === 'patch') return plan.patch === file.patch && rawDiff ? rawDiff : parsePatch(plan.patch);
    if (plan.kind === 'texts') return localPatch ? parsePatch(localPatch) : emptyDiff(true);
    return emptyDiff(true);
  }, [file, isRemoved, text, plan, rawDiff, localPatch]);
  const tree = useMemo(() => (text ? parseMarkdown(text) : null), [text]);
  /** Lines of code blocks, HTML and front matter: a change there is never "just whitespace". */
  const verbatim = useMemo(() => (tree ? verbatimLines(tree) : undefined), [tree]);
  const shownDiff = useMemo(() => (displayDiff ? presentDiff(displayDiff, view.ignoreWs, verbatim) : null), [displayDiff, view.ignoreWs, verbatim]);
  /** Comments on removed text need GitHub's own diff on screen (their lines are lines of the PR's base). */
  const leftOk = !!file && !isRemoved && !compare && !!file.patch && plan.kind === 'patch';
  /** For a deleted file, its patch (all of it removed) anchors comments on the left side. */
  const anchorDiff = rawDiff;

  const threads = useMemo(() => buildThreads(comments, path, threadStates), [comments, path, threadStates]);
  /** Resolved conversations don't get a badge in the document. */
  const threadLines = useMemo(() => threads.filter((t) => t.kind === 'line' && !t.resolved).map((t) => t.end!), [threads]);
  const fileDrafts = useMemo(() => drafts.filter((d) => d.path === path), [drafts, path]);
  const pendingLines = useMemo(() => fileDrafts.filter((d) => d.side !== 'LEFT').map((d) => d.end), [fileDrafts]);
  const leftLines = useMemo(
    () => (leftOk || isRemoved ? [...threads.filter((t) => t.kind === 'left' && !t.resolved).map((t) => t.end!), ...fileDrafts.filter((d) => d.side === 'LEFT').map((d) => d.end)] : []),
    [threads, fileDrafts, leftOk, isRemoved],
  );
  const activeRange = useMemo<[number, number] | null>(
    () => (composer && composer.anchor.side === 'RIGHT' ? [composer.anchor.start, composer.anchor.end] : null),
    [composer],
  );
  const headResolver = useMemo(
    () => makeUrlResolver(ctx.origin, ctx.owner, ctx.repo, isRemoved ? pr.base.sha : pr.head.sha, path),
    [ctx, pr, path, isRemoved],
  );
  const beforeSha = compare?.sha ?? mergeBase ?? pr.base.sha;
  const baseResolver = useMemo(() => makeUrlResolver(ctx.origin, ctx.owner, ctx.repo, beforeSha, file?.previous_filename ?? path), [ctx, beforeSha, path, file]);
  const threadCount = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of comments) if (!c.in_reply_to_id && !threadStates.get(c.id)?.resolved && c.line != null) m[c.path] = (m[c.path] ?? 0) + 1;
    return m;
  }, [comments, threadStates]);

  /** An image file this PR adds or changes, behind an image of the document. */
  const assetChange = useCallback(
    (src: string): AssetChange | null => {
      const base = `${ctx.origin}/${ctx.owner}/${ctx.repo}/raw/`;
      const p = pathOfRaw(src, `${base}${pr.head.sha}/`);
      if (!p) return null;
      const f = allFiles.find((x) => x.filename === p);
      if (!f || f.status === 'unchanged') return null;
      const before = f.status === 'modified' || f.status === 'renamed' || f.status === 'changed' ? `${base}${beforeSha}/${encPath(f.previous_filename ?? f.filename)}` : undefined;
      return { status: f.status === 'added' || f.status === 'copied' ? 'added' : f.status === 'removed' ? 'removed' : f.status === 'renamed' ? 'renamed' : 'modified', before };
    },
    [ctx, pr.head.sha, allFiles, beforeSha],
  );

  // ---- outline & checks ---------------------------------------------------
  const commentLines = useMemo(() => [...threadLines, ...pendingLines], [threadLines, pendingLines]);
  const outline = useMemo(() => (tree ? outlineOf(tree, lines, isRemoved ? null : shownDiff, commentLines) : []), [tree, lines, shownDiff, commentLines, isRemoved]);
  const needsPaths = useMemo(() => !!text && /\]\((?![a-z][a-z0-9+.-]*:|#|\/\/)[^)\s]|(?:src|href)=["'](?![a-z][a-z0-9+.-]*:|#|\/\/)/i.test(text), [text]);
  useEffect(() => {
    if (!needsPaths || paths !== undefined) return;
    setPaths(null);
    gh.tree(ctx, pr.head.sha)
      .then((t) => setPaths(t.truncated ? null : new Set(t.tree.map((x) => x.path))))
      .catch(() => setPaths(null));
  }, [needsPaths]);
  const anchorsIn = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const [p, c] of Object.entries(contents)) if (p !== path && c.text !== undefined && files.some((f) => f.filename === p && f.status !== 'removed')) m.set(p, anchorsOf(parseMarkdown(c.text)));
    return m;
  }, [contents, path, files]);
  const findings = useMemo<Finding[]>(
    () => (tree && !isRemoved ? runChecks({ tree, path, diff: shownDiff, paths: paths ?? undefined, anchorsIn }) : []),
    [tree, isRemoved, path, shownDiff, paths, anchorsIn],
  );
  const broken = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of findings) if (f.url) m.set(headResolver(f.url, f.kind === 'image' ? 'src' : 'href'), f.message);
    return m;
  }, [findings, headResolver]);

  // ---- selection → comment ------------------------------------------------
  const getSelection = () => {
    const root = rootRef.current?.getRootNode() as (ShadowRoot & { getSelection?: () => Selection | null }) | Document | undefined;
    return (root && 'getSelection' in root && root.getSelection?.()) || document.getSelection();
  };

  /** Base-file lines (for narrowing selections in removed text). */
  const oldFileLines = useMemo(() => (isRemoved ? lines : displayDiff ? baseLines(displayDiff, lines) : []), [isRemoved, lines, displayDiff]);

  const onMouseUp = () => {
    window.setTimeout(() => {
      const sel = getSelection();
      // In split view the old version is commentable too (a deleted file never gets a split view).
      const area = (docRef.current?.closest('.mdr-split') ?? docRef.current) as Element | null | undefined;
      if (!sel || sel.isCollapsed || !sel.rangeCount || !area) return setToolbar(null);
      const range = sel.getRangeAt(0);
      if (!area.contains(range.commonAncestorContainer)) return setToolbar(null);
      const quote = rangeToQuote(range);
      if (!quote) return setToolbar(null);
      const elOf = (n: Node) => (n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement);
      const startEl = elOf(range.startContainer);
      let endEl = elOf(range.endContainer);
      if (range.endOffset === 0 && range.endContainer !== range.startContainer && range.endContainer.nodeType === Node.ELEMENT_NODE) {
        endEl = startEl; // triple-click selects up to the start of the next block
      }
      if (!startEl || !endEl || startEl.closest(NOT_COMMENTABLE) || endEl.closest(NOT_COMMENTABLE)) return setToolbar(null);
      const rect = range.getBoundingClientRect();
      const phrase = phraseOf(quote);
      const match = matchText(quote);

      // Removed text: a comment on the left side of the diff.
      const oldA = startEl.closest(OLD_AREA);
      const oldB = endEl.closest(OLD_AREA);
      if (!!oldA !== !!oldB) return setToolbar(null); // half removed, half current: no single side to put it on
      if (oldA || isRemoved) {
        if (!leftOk && !isRemoved) return setToolbar(null);
        const attr = oldA?.matches('.mdr-split-before') || isRemoved ? 'sl' : 'osl';
        const a = startEl.closest(`[data-${attr}]`);
        const b = endEl.closest(`[data-${attr}]`);
        if (!a || !b) return setToolbar(null);
        const sl = Math.min(Number(a.getAttribute(`data-${attr}`)), Number(b.getAttribute(`data-${attr}`)));
        const el = Math.max(Number(a.getAttribute(`data-${attr.replace('s', 'e')}`)), Number(b.getAttribute(`data-${attr.replace('s', 'e')}`)));
        const { start, end } = narrowLines(oldFileLines, sl, el, match);
        return setToolbar({ rect, start, end, side: 'LEFT', quote, phrase });
      }

      // Deleted words of a word diff: also the left side, located through the block's removals.
      const delA = startEl.closest('del.mdr-d-del');
      const delB = endEl.closest('del.mdr-d-del');
      const a = startEl.closest('[data-sl]');
      const b = endEl.closest('[data-sl]');
      if (!a || !b) return setToolbar(null);
      const sl = Math.min(Number(a.getAttribute('data-sl')), Number(b.getAttribute('data-sl')));
      const el = Math.max(Number(a.getAttribute('data-el')), Number(b.getAttribute('data-el')));
      if (delA && delB && shownDiff) {
        const loc = leftOk ? locateRemoved(shownDiff.removals, sl, el, match) : null;
        if (!loc) return setToolbar(null);
        return setToolbar({ rect, ...loc, side: 'LEFT', quote, phrase });
      }
      const { start, end } = narrowLines(lines, sl, el, match);
      setToolbar({ rect, start, end, side: 'RIGHT', quote, phrase });
    }, 0);
  };

  const anchorFor = (start: number, end: number, side: Side): Anchor => resolveAnchor(anchorDiff, start, end, isRemoved ? 'LEFT' : side);

  const openComposer = (suggest: boolean) => {
    if (!toolbar) return;
    const r = toolbar.rect;
    setComposer({ anchor: anchorFor(toolbar.start, toolbar.end, toolbar.side), quote: toolbar.quote, phrase: toolbar.phrase, suggest, rect: { top: r.top, bottom: r.bottom, left: r.left, width: r.width } });
    setToolbar(null);
  };

  /** The + next to a block: comment on all of it. */
  const commentOnBlock = (h: Hover, suggest = false) => {
    const r = h.el.getBoundingClientRect();
    const quote = blockQuote(h.el);
    setComposer({ anchor: anchorFor(h.start, h.end, h.side), quote, phrase: '', suggest, rect: { top: r.top, bottom: Math.min(r.bottom, r.top + 60), left: r.left, width: r.width } });
    setHover(null);
  };

  const onDocMouseMove = (e: React.MouseEvent) => {
    if (composer || toolbar) return;
    const t = e.target as Element;
    if (t.closest('.mdr-hover-add')) return;
    const blk = t.closest('[data-block], [data-osl]') as HTMLElement | null;
    if (!blk || blk.closest(NOT_COMMENTABLE) || (hover && hover.el === blk)) return;
    const old = !!blk.closest(OLD_AREA) || isRemoved;
    if (old && !leftOk && !isRemoved) return setHover(null);
    const inSplitBefore = !!blk.closest('.mdr-split-before');
    const attr = old && !inSplitBefore && !isRemoved ? 'osl' : 'sl';
    const start = Number(blk.getAttribute(`data-${attr}`));
    const end = Number(blk.getAttribute(`data-${attr.replace('s', 'e')}`));
    if (!start || !end) return setHover(null);
    const r = blk.getBoundingClientRect();
    const pane = (blk.closest('.mdr-split-pane, .mdr-main') as HTMLElement | null)?.getBoundingClientRect();
    setHover({ start, end, side: old ? 'LEFT' : 'RIGHT', top: r.top + 2, left: Math.max((pane?.left ?? 0) + 2, r.left - 30), el: blk });
  };

  const submitComment = async (body: string, how: 'now' | 'review') => {
    if (!composer || !file) return;
    const { anchor } = composer;
    if (how === 'review') {
      saveDrafts([
        ...drafts,
        { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, path: file.filename, kind: anchor.kind, side: anchor.side, start: anchor.start, end: anchor.end, body, quote: composer.quote, createdAt: Date.now(), sha: pr.head.sha },
      ]);
      setComposer(null);
      getSelection()?.removeAllRanges();
      return;
    }
    setBusy(true);
    try {
      if (anchor.kind === 'line') {
        await gh.createLineComment(ctx, pr.head.sha, { path: file.filename, body, line: anchor.end, start_line: anchor.start, side: anchor.side });
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
          lineDrafts.map((d) => ({ path: d.path, body: d.body, line: d.end, start_line: d.start, side: d.side })),
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
      setSummary('');
      setLastReviewed(pr.head.sha);
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

  const editComment = async (c: ReviewComment, body: string) => {
    try {
      await gh.editComment(ctx, c.id, body);
      await loadComments();
    } catch (e) {
      notify('err', `Couldn't update the comment: ${errText(e)}`);
      throw e;
    }
  };

  const deleteComment = async (c: ReviewComment) => {
    try {
      await gh.deleteComment(ctx, c.id);
      await loadComments();
      notify('ok', 'Comment deleted');
    } catch (e) {
      notify('err', `Couldn't delete the comment: ${errText(e)}`);
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
        if (nextUnviewed) selectPath(nextUnviewed.filename);
      }
    } catch (e) {
      setViewed({ ...viewed, [file.filename]: !next });
      notify('err', `Couldn't update viewed state: ${errText(e)}`);
    }
  };

  // ---- navigation ---------------------------------------------------------
  const changeEls = useCallback((): HTMLElement[] => {
    const all = [...(docRef.current?.querySelectorAll<HTMLElement>('.mdr-added, .mdr-mod, .mdr-moved, .mdr-removed, .mdr-removed-row, .mdr-removed-start') ?? [])];
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

  /** The next / previous element of `els` below / above the middle of the view (wrapping around). */
  const step = (els: HTMLElement[], dir: 1 | -1) => {
    const box = scrollRef.current?.getBoundingClientRect();
    if (!els.length || !box) return null;
    const mid = box.top + box.height / 2;
    return dir === 1
      ? els.find((e) => e.getBoundingClientRect().top > mid + 4) ?? els[0]
      : [...els].reverse().find((e) => e.getBoundingClientRect().top < mid - 4) ?? els[els.length - 1];
  };

  const gotoChange = (dir: 1 | -1) => {
    const els = changeEls();
    const target = step(els, dir);
    if (!target) return;
    reveal(target);
    setChangePos(els.indexOf(target) + 1);
  };

  const gotoThread = (dir: 1 | -1) => {
    const badges = [...(docRef.current?.closest('.mdr-main')?.querySelectorAll<HTMLElement>('.mdr-badge-thread, .mdr-badge-pending') ?? [])].filter((b) => !b.closest('.mdr-split-before'));
    const target = step(badges.map((b) => (b.closest('[data-block], .mdr-removed, .mdr-src-line') as HTMLElement) ?? b), dir);
    if (!target) return;
    reveal(target);
    target.querySelector<HTMLElement>('.mdr-badge-thread, .mdr-badge-pending')?.click();
  };

  /** Scroll to the block holding a line (opening a fold or a collapsed removed block on the way). */
  const jumpToLine = useCallback((line: number, side: Side = 'RIGHT', retry = true) => {
    const root = docRef.current?.closest('.mdr-main') ?? docRef.current;
    if (!root) return;
    let best: HTMLElement | null = null;
    let span = Infinity;
    const consider = (b: HTMLElement, s: number, e: number) => {
      if (s <= line && line <= e && e - s <= span) {
        best = b;
        span = e - s;
      }
    };
    if (side === 'LEFT') {
      // The old version is on screen in split view; otherwise removed blocks and lines carry base-file numbers.
      for (const b of root.querySelectorAll<HTMLElement>('.mdr-split-before [data-block]')) consider(b, Number(b.dataset.sl), Number(b.dataset.el));
      if (!best) for (const b of root.querySelectorAll<HTMLElement>('[data-osl]')) if (b.offsetParent) consider(b, Number(b.dataset.osl), Number(b.dataset.oel));
    } else {
      for (const b of docRef.current?.querySelectorAll<HTMLElement>('[data-block]') ?? []) consider(b, Number(b.dataset.sl), Number(b.dataset.el));
      if (!best && retry) {
        const fold = [...(docRef.current?.querySelectorAll<HTMLElement>('.mdr-fold') ?? [])].find((f) => Number(f.dataset.foldSl) <= line && line <= Number(f.dataset.foldEl));
        if (fold) {
          fold.dispatchEvent(new CustomEvent('mdr-expand'));
          requestAnimationFrame(() => jumpToLine(line, side, false));
          return;
        }
      }
    }
    if (best) reveal(best);
    setFocus({ side, start: line, end: line });
  }, []);

  const onBadge = useCallback((sl: number, el: number, side: Side = 'RIGHT') => {
    setFocus({ side, start: sl, end: el });
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
      selectPath(f.filename);
      setPendingAnchor(hash || null);
      return true;
    },
    [ctx, files, selectPath],
  );

  // Restore the reading position of a file (or open its #anchor), once it has rendered.
  useEffect(() => {
    if (text === undefined) return;
    const id = requestAnimationFrame(() => {
      if (pendingAnchor) {
        const el = findAnchor(docRef.current, pendingAnchor);
        if (el) reveal(el);
        setPendingAnchor(null);
      } else {
        scrollRef.current?.scrollTo({ top: scrollPos.current.get(path) ?? 0 });
      }
    });
    return () => cancelAnimationFrame(id);
  }, [path, text === undefined, pendingAnchor, mode]);

  const onHeading = (o: OutlineItem) => {
    const el = docRef.current?.querySelector<HTMLElement>(`[data-sl="${o.line}"]`) ?? findAnchor(docRef.current, o.id);
    if (el) reveal(el);
    setActiveHeading(o.id);
  };

  /** The heading of the section being read, for the outline. */
  const frame = useRef(0);
  const trackHeading = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const box = scrollRef.current?.getBoundingClientRect();
      if (!box || !docRef.current) return;
      let id: string | null = null;
      for (const h of docRef.current.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]')) {
        if (h.getBoundingClientRect().top - box.top > 80) break;
        id = h.id;
      }
      setActiveHeading(id ?? outline[0]?.id ?? null);
    });
  };

  const onScroll = () => {
    if (toolbar) setToolbar(null);
    if (popover) setPopover(null);
    if (hover) setHover(null);
    trackHeading();
  };

  const switchFile = (delta: number) => {
    const i = files.findIndex((f) => f.filename === path);
    const n = files[(i + delta + files.length) % files.length];
    if (n) selectPath(n.filename);
  };

  const setOption = (k: keyof ViewOptions, v: boolean) => {
    setView((o) => ({ ...o, [k]: v }));
    pref.set({ inline: 'inline', ignoreWs: 'ws', fold: 'fold', docsSyntax: 'docs' }[k], v ? '1' : '0');
  };
  const switchMode = (m: Mode) => {
    if (m === mode) return;
    const el = scrollRef.current;
    if (el) scrollPos.current.set(path, el.scrollTop);
    setMode(m);
    pref.set('mode', m);
    setHover(null);
  };

  const commentOnFinding = (f: Finding) => {
    const el = docRef.current?.querySelector<HTMLElement>(`[data-sl="${f.line}"]`);
    const r = (el ?? docRef.current)?.getBoundingClientRect();
    if (!r) return;
    jumpToLine(f.line);
    setComposer({ anchor: anchorFor(f.line, f.line, 'RIGHT'), quote: '', suggest: false, initialText: `${f.message}.`, rect: { top: r.top, bottom: Math.min(r.bottom, r.top + 40), left: r.left, width: r.width } });
  };

  // ---- keyboard -----------------------------------------------------------
  type KeyLike = Pick<KeyboardEvent, 'key' | 'target' | 'metaKey' | 'ctrlKey' | 'altKey' | 'preventDefault' | 'stopPropagation'>;
  const onKeyDown = (e: KeyLike) => {
    const t = e.target as HTMLElement;
    const typing = t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable;
    if (e.key === 'Escape') {
      if (popover) setPopover(null);
      else if (helpOpen) setHelpOpen(false);
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
    else if (e.key === 'j') gotoThread(1);
    else if (e.key === 'k') gotoThread(-1);
    else if (e.key === ']') switchFile(1);
    else if (e.key === '[') switchFile(-1);
    else if (e.key === 'v') toggleViewed();
    else if (e.key === 'w' && mode !== 'rendered') notify('ok', 'Word diff is shown in the Rendered view (press 1)');
    else if (e.key === 'w') setOption('inline', !view.inline);
    else if (e.key === 'f') setOption('fold', !view.fold);
    else if (e.key === '1') switchMode('rendered');
    else if (e.key === '2') switchMode('split');
    else if (e.key === '3') switchMode('source');
    else if (e.key === '?') setHelpOpen((h) => !h);
    else if (e.key === '/') { e.preventDefault(); filterRef.current?.focus(); }
    else if (e.key === 'c' && toolbar) { e.preventDefault(); openComposer(false); }
    else if (e.key === 's' && toolbar && toolbar.side === 'RIGHT' && !isRemoved) { e.preventDefault(); openComposer(true); }
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
    if (!composer && !submitOpen && !helpOpen) rootRef.current?.focus({ preventScroll: true });
  }, [composer, submitOpen, helpOpen]);

  // Stop GitHub's global hotkeys while the overlay is open.
  const stopKeys = (e: React.KeyboardEvent) => e.nativeEvent.stopImmediatePropagation?.();

  // ---- render -------------------------------------------------------------
  const isViewed = !!(viewed && file && viewed[file.filename]);
  const unchanged = useMemo(() => {
    const d = compareData?.data;
    if (!compare || !d || d.status === 'diverged' || d.status === 'behind' || (d.files?.length ?? 0) >= 300) return null;
    const changed = new Set((d.files ?? []).map((f) => f.filename));
    return new Set(files.filter((f) => !changed.has(f.filename)).map((f) => f.filename));
  }, [compare, compareData, files]);

  const docProps = {
    threadLines,
    pendingLines,
    activeRange,
    onBadge,
    onMods,
    onLink,
    leftThreadLines: leftLines,
    ignoreWhitespace: view.ignoreWs,
    docsSyntax: view.docsSyntax,
    mdx: /\.mdx$/i.test(path),
    broken,
    assetChange,
    onJump: jumpToLine,
  };

  /** The old version for split view: the base text, its removed lines marked (in base numbering). */
  const before = useMemo(() => {
    if (mode !== 'split' || !file || text === undefined || !displayDiff || !shownDiff) return null;
    const empty = plan.kind === 'none' && !!plan.empty;
    const error = plan.kind === 'texts' ? baseTexts[baseKey!]?.error : undefined;
    const loading = plan.kind === 'loading' || (plan.kind === 'texts' && baseText === undefined && !error);
    const source = plan.kind === 'texts' ? baseText ?? '' : empty ? '' : baseLines(displayDiff, lines).join('\n');
    const diff = emptyDiff(true);
    for (const r of shownDiff.removals) {
      const moved = new Set<number>();
      for (const m of r.moved ?? []) for (let k = m.from; k < m.to; k++) moved.add(k);
      r.lines.forEach((l, k) => {
        if (!l.trim()) return;
        if (moved.has(k)) diff.moved.set(r.oldStart + k, 0);
        diff.added.add(r.oldStart + k);
      });
    }
    return { source, diff, map: headToBase(displayDiff, lines.length), empty, error, loading };
  }, [mode, file, text, displayDiff, shownDiff, plan, baseText, baseTexts, baseKey, lines]);

  const renderDoc = () => {
    if (!file || text === undefined) return null;
    if (mode === 'source') {
      return (
        <article ref={docRef} className="markdown-body mdr-doc mdr-mode-source" onMouseUp={onMouseUp} onMouseMove={onDocMouseMove}>
          <SourceDoc source={text} diff={shownDiff} threadLines={threadLines} pendingLines={pendingLines} leftLines={leftLines} activeRange={activeRange} onBadge={onBadge} />
        </article>
      );
    }
    const fallback = (e: Error) => (
      <div className="mdr-banner mdr-banner-del">
        Couldn't render this file: {e.message}{' '}
        <button className="mdr-link" onClick={() => switchMode('source')}>Show source</button>
      </div>
    );
    if (mode === 'split' && before && !isRemoved) {
      return (
        <div className="mdr-split-wrap" onMouseUp={onMouseUp} onMouseMove={onDocMouseMove}>
          <SplitView
            afterRef={scrollRef}
            headToBase={before.map}
            beforeLabel={compare ? `Before · ${compare.label}` : `Before · ${pr.base.ref}`}
            afterLabel={`After · ${pr.head.ref}`}
            before={
              before.source.trim() ? (
                <article className="markdown-body mdr-doc mdr-mode-rendered mdr-doc-before">
                  <ErrorBoundary key={`b:${file.filename}`} fallback={fallback}>
                    <MarkdownDoc
                      {...docProps}
                      source={before.source}
                      diff={before.diff}
                      threadLines={leftOk ? leftLines : []}
                      pendingLines={[]}
                      leftThreadLines={[]}
                      activeRange={composer && composer.anchor.side === 'LEFT' ? [composer.anchor.start, composer.anchor.end] : null}
                      inlineDiff={false}
                      resolveUrl={baseResolver}
                      onBadge={(sl, el) => onBadge(sl, el, 'LEFT')}
                      onLink={undefined}
                      broken={undefined}
                      assetChange={undefined}
                    />
                  </ErrorBoundary>
                </article>
              ) : (
                <p className="mdr-muted mdr-empty-doc">
                  {before.empty ? 'The file didn’t exist before.' : before.error ? `Couldn’t load the previous version: ${before.error}` : before.loading ? 'Loading…' : 'The file was empty before.'}
                </p>
              )
            }
            after={
              <article ref={docRef} className="markdown-body mdr-doc mdr-mode-rendered mdr-doc-after">
                <ErrorBoundary key={file.filename} fallback={fallback}>
                  <MarkdownDoc {...docProps} source={text} diff={shownDiff} inlineDiff={false} resolveUrl={headResolver} />
                </ErrorBoundary>
              </article>
            }
          />
        </div>
      );
    }
    return (
      <div className="mdr-doc-wrap">
        <article ref={docRef} className="markdown-body mdr-doc mdr-mode-rendered" onMouseUp={onMouseUp} onMouseMove={onDocMouseMove}>
          <ErrorBoundary key={`${file.filename}:${view.docsSyntax}:${view.inline}`} fallback={fallback}>
            <MarkdownDoc {...docProps} source={text} diff={shownDiff} inlineDiff={view.inline} fold={view.fold} resolveUrl={headResolver} />
          </ErrorBoundary>
        </article>
      </div>
    );
  };

  const baseError = plan.kind === 'texts' ? baseTexts[baseKey!]?.error : undefined;
  const note =
    plan.kind === 'none' || plan.kind === 'loading'
      ? plan.note
      : baseError
        ? `Couldn't load the previous version of this file (${baseError}) – changes aren't highlighted.`
        : localPatch === null
          ? 'The two versions of this file differ too much to compare in the browser – changes aren\'t highlighted and comments will be file-level.'
          : undefined;
  const split = mode === 'split' && !isRemoved && !!file && text !== undefined;

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
        <div className="mdr-seg" role="tablist" aria-label="Display">
          {(['rendered', 'split', 'source'] as const).map((m, i) => (
            <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'on' : ''} onClick={() => switchMode(m)} title={`${m === 'rendered' ? 'Rendered document with the changes marked' : m === 'split' ? 'Before and after side by side' : 'Markdown source with the line diff'} (${i + 1})`}>
              {m === 'rendered' ? 'Rendered' : m === 'split' ? 'Split' : 'Source'}
            </button>
          ))}
        </div>
        <ViewMenu options={view} onChange={setOption} wordDiffApplies={mode === 'rendered'} />
        <CompareMenu commits={commits} lastReviewed={lastReviewed} current={compare} headSha={pr.head.sha} onPick={setCompare} />
        <div className="mdr-nav" title="Previous / next change (p / n)">
          <button className="mdr-icon-btn" onClick={() => gotoChange(-1)} disabled={!changeCount} aria-label="Previous change">↑</button>
          <span className="mdr-muted" aria-live="polite">{changePos && changePos <= changeCount ? `${changePos} / ${changeCount}` : `${changeCount} change${changeCount === 1 ? '' : 's'}`}</span>
          <button className="mdr-icon-btn" onClick={() => gotoChange(1)} disabled={!changeCount} aria-label="Next change">↓</button>
        </div>
        <span className="mdr-spacer" />
        <button className="mdr-icon-btn" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={() => setHelpOpen(true)}>?</button>
        <button className="mdr-icon-btn" title="Reload pull request" aria-label="Reload pull request" onClick={onReload}>⟳</button>
        <button className="mdr-icon-btn" title="Toggle comments panel" aria-label="Toggle comments panel" onClick={() => { setPanelOpen(!panelOpen); pref.set('panel', panelOpen ? '0' : '1'); }}>
          ☰
        </button>
        <button className="mdr-btn mdr-btn-primary" onClick={() => setSubmitOpen(true)}>
          Finish review{drafts.length ? <span className="mdr-pill">{drafts.length}</span> : null}
        </button>
        <button className="mdr-icon-btn mdr-close" title="Close (Esc)" aria-label="Close" onClick={onClose}>✕</button>
      </header>
      {newHead && (
        <div className="mdr-newcommits" role="status">
          New commits were pushed to this pull request ({newHead.slice(0, 7)}). Your drafts are kept.
          <button className="mdr-btn mdr-btn-small" onClick={onReload}>Reload</button>
          <button className="mdr-link" onClick={() => setNewHead(null)}>Dismiss</button>
        </div>
      )}

      <div className={`mdr-body${panelOpen ? '' : ' mdr-no-panel'}`}>
        <FileNav
          ref={filterRef}
          files={files}
          path={path}
          viewed={viewed}
          drafts={drafts}
          threadCount={threadCount}
          unchanged={unchanged}
          onSelect={selectPath}
          outline={outline}
          activeHeading={activeHeading}
          onHeading={onHeading}
        />

        <main
          className={`mdr-main${split ? ' mdr-main-split' : ''}`}
          ref={split ? undefined : scrollRef}
          onScroll={onScroll}
          onScrollCapture={split ? onScroll : undefined}
          // The + button sits outside <main> in the DOM: moving onto it must not count as leaving.
          onMouseLeave={(e) => {
            if (!(e.relatedTarget instanceof Element && e.relatedTarget.closest('.mdr-hover-add'))) setHover(null);
          }}
        >
          {file && (
            <div className="mdr-filebar">
              <span className="mdr-filebar-path">{file.previous_filename ? `${file.previous_filename} → ` : ''}{file.filename}</span>
              <span className="mdr-add">+{file.additions}</span>
              <span className="mdr-del">−{file.deletions}</span>
              {!file.patch && file.status !== 'removed' && file.changes > 0 && <span className="mdr-warn" title="GitHub sends no diff for very large changes; the changes shown are computed here.">Large diff – comments will be file-level</span>}
              <span className="mdr-spacer" />
              {!isRemoved && (
                <button className="mdr-link" onClick={() => setComposer({ anchor: { kind: 'file', side: 'RIGHT', start: 0, end: 0, reason: 'a comment on the whole file' }, quote: '', suggest: false, rect: { top: 120, bottom: 120, left: window.innerWidth / 2, width: 0 } })} title="A comment on the file as a whole">
                  Comment on file
                </button>
              )}
              <a className="mdr-link" href={`${ctx.origin}/${ctx.owner}/${ctx.repo}/blob/${isRemoved ? pr.base.sha : pr.head.sha}/${encPath(file.filename)}`} target="_blank" rel="noreferrer">
                View file
              </a>
              {viewed && (
                <label className="mdr-toggle mdr-viewed-toggle">
                  <input type="checkbox" checked={isViewed} onChange={toggleViewed} /> Viewed
                </label>
              )}
            </div>
          )}
          {isRemoved && <div className="mdr-banner mdr-banner-del">This file is deleted in this pull request.{anchorDiff?.hasPatch ? ' Comments go on its removed lines.' : ''}</div>}
          {file?.status === 'added' && !compare && <div className="mdr-banner mdr-banner-add">New file</div>}
          {note && <div className="mdr-banner mdr-banner-info">{note}</div>}
          {compare && compareData?.error && <div className="mdr-banner mdr-banner-info">GitHub couldn't compare the commits ({compareData.error}); changes are computed file by file.</div>}

          {!file && <div className="mdr-doc-wrap"><p className="mdr-muted">No Markdown files in this pull request.</p></div>}
          {file && text === undefined && !contents[file.filename]?.error && <div className="mdr-doc-wrap"><div className="mdr-skeleton"><div /><div /><div /><div /></div></div>}
          {file && contents[file.filename]?.error && <div className="mdr-doc-wrap"><div className="mdr-banner mdr-banner-del">Couldn't load the file: {contents[file.filename]!.error}</div></div>}
          {file && text !== undefined && !text.trim() && <div className="mdr-doc-wrap"><p className="mdr-muted mdr-empty-doc">This file is empty.</p></div>}
          {file && text !== undefined && !!text.trim() && renderDoc()}
        </main>

        {panelOpen && (
          <aside className="mdr-side" aria-label="Conversations">
            <ThreadsPanel
              threads={threads}
              drafts={fileDrafts}
              focus={focus}
              headSha={pr.head.sha}
              lines={lines}
              viewer={viewer}
              findings={findings}
              onJump={jumpToLine}
              onReply={reply}
              onResolve={resolveThread}
              onEditComment={editComment}
              onDeleteComment={deleteComment}
              onDeleteDraft={(id) => saveDrafts(drafts.filter((d) => d.id !== id))}
              onEditDraft={(id, body) => saveDrafts(drafts.map((d) => (d.id === id ? { ...d, body } : d)))}
              onCommentFinding={commentOnFinding}
            />
          </aside>
        )}
      </div>

      {hover && !toolbar && !composer && (
        <button
          className="mdr-hover-add"
          style={{ top: hover.top, left: hover.left }}
          title={`Comment on ${hover.side === 'LEFT' ? 'this removed text' : 'this block'} (lines ${hover.start}–${hover.end})`}
          aria-label="Comment on this block"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => commentOnBlock(hover)}
          onMouseLeave={(e) => {
            const main = rootRef.current?.querySelector('.mdr-main');
            if (!(e.relatedTarget instanceof Node && main?.contains(e.relatedTarget))) setHover(null);
          }}
        >
          +
        </button>
      )}

      {toolbar && !composer && (
        <div className="mdr-toolbar" style={{ top: Math.max(8, toolbar.rect.top - 44), left: toolbar.rect.left + toolbar.rect.width / 2 }} onMouseDown={(e) => e.preventDefault()}>
          <button onClick={() => openComposer(false)} title="Comment (c)">💬 Comment</button>
          <button onClick={() => openComposer(true)} disabled={isRemoved || toolbar.side === 'LEFT'} title={toolbar.side === 'LEFT' ? 'Suggestions apply to the new version only' : 'Suggest a change (s)'}>± Suggest</button>
        </div>
      )}

      {composer && (
        <Composer
          key={`${composer.anchor.side}-${composer.anchor.start}-${composer.anchor.end}-${composer.quote.length}`}
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
          drafts={drafts}
          headSha={pr.head.sha}
          pendingReviewUrl={pendingReviewUrl}
          summary={summary}
          onSummary={setSummary}
          busy={busy}
          onCancel={() => setSubmitOpen(false)}
          onSubmit={submitReview}
          onOpenDraft={(d) => {
            setSubmitOpen(false);
            if (d.path !== path) selectPath(d.path);
            setPanelOpen(true);
            window.setTimeout(() => jumpToLine(d.end, d.side ?? 'RIGHT'), 120);
          }}
        />
      )}

      {helpOpen && <Help onClose={() => setHelpOpen(false)} />}

      {toast && (
        <div className={`mdr-toast mdr-toast-${toast.kind}`} role="status" onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
    </div>
  );
}
