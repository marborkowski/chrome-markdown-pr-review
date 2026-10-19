import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, gh, openOptions } from './api';
import { Review } from './components/Review';
import { isMarkdown, prKey, type PrContext, type PrFile, type PullRequest } from './types';

declare global {
  interface Window {
    __MDR_DEV_CTX__?: PrContext;
  }
}

function parseContext(): PrContext | null {
  if (window.__MDR_DEV_CTX__) return window.__MDR_DEV_CTX__;
  const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/.exec(location.pathname);
  if (!m) return null;
  return { origin: location.origin, owner: decodeURIComponent(m[1]), repo: decodeURIComponent(m[2]), number: Number(m[3]) };
}

/** GitHub is a SPA (Turbo / React router) – watch for URL changes. */
function usePrContext() {
  const [ctx, setCtx] = useState(parseContext);
  const last = useRef(location.href);
  useEffect(() => {
    const check = () => {
      if (location.href === last.current) return;
      last.current = location.href;
      setCtx((prev) => {
        const next = parseContext();
        return prev && next && prKey(prev) === prKey(next) ? prev : next;
      });
    };
    const t = window.setInterval(check, 500);
    window.addEventListener('popstate', check);
    document.addEventListener('turbo:load', check);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('popstate', check);
      document.removeEventListener('turbo:load', check);
    };
  }, []);
  return ctx;
}

type Load =
  | { state: 'idle' | 'loading' }
  | { state: 'ready'; pr: PullRequest; files: PrFile[] }
  | { state: 'error'; error: string; needsToken: boolean };

export function App() {
  const ctx = usePrContext();
  const [load, setLoad] = useState<Load>({ state: 'idle' });
  const [open, setOpen] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const key = ctx ? prKey(ctx) : null;

  useEffect(() => {
    if (!ctx) {
      setLoad({ state: 'idle' });
      setOpen(false);
      return;
    }
    let cancelled = false;
    setLoad({ state: 'loading' });
    Promise.all([gh.pr(ctx), gh.files(ctx)])
      .then(([pr, files]) => {
        if (!cancelled) setLoad({ state: 'ready', pr, files: files.filter((f) => isMarkdown(f.filename)) });
      })
      .catch((e) => {
        if (cancelled) return;
        setLoad({ state: 'error', error: e instanceof Error ? e.message : String(e), needsToken: e instanceof ApiError && e.needsToken });
      });
    return () => {
      cancelled = true;
    };
  }, [key, reloadKey]);

  const toggle = useCallback(() => {
    const noFiles = load.state === 'ready' && !load.files.length;
    if (!ctx || noFiles) {
      setHint(noFiles ? 'This pull request has no Markdown files.' : 'Open a pull request to review its Markdown files.');
      window.setTimeout(() => setHint(null), 3500);
      return;
    }
    setOpen((o) => !o);
  }, [ctx, load]);

  useEffect(() => {
    const onMsg = (msg: any) => {
      if (msg?.type === 'toggle') toggle();
    };
    try {
      chrome.runtime.onMessage.addListener(onMsg);
      return () => chrome.runtime.onMessage.removeListener(onMsg);
    } catch {
      return undefined;
    }
  }, [toggle]);

  // Lock page scroll behind the overlay.
  useEffect(() => {
    if (!open) return;
    const html = document.documentElement;
    const prev = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => {
      html.style.overflow = prev;
    };
  }, [open]);

  useEffect(() => {
    if (load.state === 'error') setOpen(false);
  }, [load.state]);

  if (hint) return <div className="mdr-toast mdr-toast-ok">{hint}</div>;
  if (!ctx) return null;

  if (load.state === 'error') {
    return (
      <button
        className="mdr-launcher mdr-launcher-warn"
        title={load.error}
        onClick={() => (load.needsToken ? openOptions(ctx.origin) : setReloadKey((k) => k + 1))}
      >
        <span className="mdr-launcher-icon">M↓</span>
        {load.needsToken ? 'Connect a token to review Markdown' : 'Markdown review unavailable – retry'}
      </button>
    );
  }
  if (load.state !== 'ready' || !load.files.length) return null;

  if (open) {
    return (
      <Review
        key={`${key}:${reloadKey}`}
        ctx={ctx}
        pr={load.pr}
        files={load.files}
        onClose={() => setOpen(false)}
        onReload={() => setReloadKey((k) => k + 1)}
      />
    );
  }

  return (
    <button className="mdr-launcher" onClick={() => setOpen(true)} title="Review Markdown files (Alt+Shift+M)">
      <span className="mdr-launcher-icon">M↓</span>
      Review Markdown
      <span className="mdr-pill">{load.files.length}</span>
    </button>
  );
}
