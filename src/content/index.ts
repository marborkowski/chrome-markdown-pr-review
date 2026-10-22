// The content script: small on purpose, it runs on every GitHub page. It finds pull request
// pages, shows the "Review Markdown" button, and loads the review UI (review.js: React, the
// Markdown pipeline, …) only when the review is opened.
import { ApiError, gh, openOptions } from './api';
import { isMarkdown, prKey, type PrContext, type PrFile, type PullRequest } from './types';
import launcherCss from './launcher.css';
import { devHook } from './lib/devHook';
import type { ReviewHandle, ReviewMountProps } from '../review/entry';

declare global {
  interface Window {
    __mdrLoaded?: boolean;
    __MDR_DEV_CTX__?: PrContext;
    /** The dev harness serves review.js itself. */
    __MDR_REVIEW_URL__?: string;
    __MDR_HARNESS__?: boolean;
  }
}

function detectTheme(): 'light' | 'dark' {
  const html = document.documentElement;
  const mode = html.getAttribute('data-color-mode');
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function parseContext(): PrContext | null {
  const devCtx = devHook('__MDR_DEV_CTX__');
  if (devCtx) return devCtx;
  const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/.exec(location.pathname);
  if (!m) return null;
  return { origin: location.origin, owner: decodeURIComponent(m[1]), repo: decodeURIComponent(m[2]), number: Number(m[3]) };
}

type Load =
  | { state: 'idle' | 'loading' }
  | { state: 'ready'; pr: PullRequest; files: PrFile[]; allFiles: PrFile[] }
  | { state: 'error'; error: string; needsToken: boolean };

type ReviewModule = { mountReview: (shadow: ShadowRoot, container: HTMLElement, props: ReviewMountProps) => ReviewHandle };
let reviewModule: Promise<ReviewModule> | undefined;
function loadReview(): Promise<ReviewModule> {
  if (!reviewModule) {
    const url = devHook('__MDR_REVIEW_URL__') ?? chrome.runtime.getURL('review.js');
    reviewModule = import(/* @vite-ignore */ url) as Promise<ReviewModule>;
    reviewModule.catch(() => (reviewModule = undefined));
  }
  return reviewModule;
}

function button(cls: string, title: string, label: string, onClick: () => void, pill?: number) {
  const b = document.createElement('button');
  b.className = cls;
  b.title = title;
  const icon = document.createElement('span');
  icon.className = 'mdr-launcher-icon';
  icon.textContent = 'M↓';
  b.append(icon, label);
  if (pill !== undefined) {
    const p = document.createElement('span');
    p.className = 'mdr-pill';
    p.textContent = String(pill);
    b.append(p);
  }
  b.addEventListener('click', onClick);
  return b;
}

export function mount() {
  if (window.__mdrLoaded) return;
  window.__mdrLoaded = true;

  // Attach outside <body>: GitHub's Turbo navigation replaces the body element.
  const host = document.createElement('div');
  host.id = 'md-pr-review-root';
  host.style.all = 'initial';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = launcherCss;
  const container = document.createElement('div');
  container.className = 'mdr-root';
  const ui = document.createElement('div');
  const overlay = document.createElement('div');
  container.append(ui, overlay);
  shadow.append(style, container);

  const applyTheme = () => host.setAttribute('data-theme', detectTheme());
  applyTheme();
  new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-color-mode', 'data-dark-theme', 'data-light-theme'] });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  let ctx = parseContext();
  let load: Load = { state: 'idle' };
  let review: ReviewHandle | null = null;
  let opening = false;
  let reloadKey = 0;
  let hint: string | null = null;
  let generation = 0;
  let scrollLock: string | null = null;

  const render = () => {
    ui.replaceChildren();
    if (hint) {
      const t = document.createElement('div');
      t.className = 'mdr-toast mdr-toast-ok';
      t.setAttribute('role', 'status');
      t.textContent = hint;
      ui.append(t);
      return;
    }
    if (!ctx || review) return;
    if (load.state === 'error') {
      const { needsToken, error } = load;
      ui.append(
        button(
          'mdr-launcher mdr-launcher-warn',
          error,
          needsToken ? 'Connect a token to review Markdown' : 'Markdown review unavailable – retry',
          () => (needsToken ? openOptions(ctx!.origin) : fetchPr()),
        ),
      );
      return;
    }
    if (load.state !== 'ready' || !load.files.length) return;
    const b = button('mdr-launcher', 'Review Markdown files (Alt+Shift+M)', opening ? 'Opening…' : 'Review Markdown', () => openReview(), load.files.length);
    b.disabled = opening;
    ui.append(b);
  };

  const showHint = (text: string) => {
    hint = text;
    render();
    window.setTimeout(() => {
      if (hint === text) {
        hint = null;
        render();
      }
    }, 3500);
  };

  const lock = (on: boolean) => {
    const html = document.documentElement;
    if (on && scrollLock === null) {
      scrollLock = html.style.overflow;
      html.style.overflow = 'hidden';
    } else if (!on && scrollLock !== null) {
      html.style.overflow = scrollLock;
      scrollLock = null;
    }
  };

  const props = (): ReviewMountProps | null =>
    ctx && load.state === 'ready'
      ? {
          ctx,
          pr: load.pr,
          files: load.files,
          allFiles: load.allFiles,
          reloadKey,
          onClose: closeReview,
          onReload: () => {
            reloadKey++;
            fetchPr();
          },
        }
      : null;

  function closeReview() {
    review?.unmount();
    review = null;
    lock(false);
    render();
  }

  async function openReview() {
    const p = props();
    if (!p || review || opening) return;
    opening = true;
    render();
    try {
      const mod = await loadReview();
      // The reader may have navigated to another PR while review.js was loading: nothing to show then.
      if (!review && props()) review = mod.mountReview(shadow, overlay, props()!);
      if (review) lock(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showHint(/context invalidated/i.test(msg) ? 'The extension was updated. Reload this page to continue.' : `Couldn't load the review: ${msg}`);
    } finally {
      opening = false;
      render();
    }
  }

  async function fetchPr() {
    const c = ctx;
    if (!c) return;
    const gen = ++generation;
    if (load.state !== 'ready') {
      load = { state: 'loading' };
      render();
    }
    try {
      const [pr, files] = await Promise.all([gh.pr(c), gh.files(c)]);
      if (gen !== generation) return;
      load = { state: 'ready', pr, files: files.filter((f) => isMarkdown(f.filename)), allFiles: files };
      const p = props();
      if (review && p) review.update(p);
      // Warm the review bundle up while the reader is still looking at the page.
      if (load.files.length) window.setTimeout(() => loadReview().catch(() => {}), 1500);
    } catch (e) {
      if (gen !== generation) return;
      load = { state: 'error', error: e instanceof Error ? e.message : String(e), needsToken: e instanceof ApiError && e.needsToken };
      if (review) closeReview();
    }
    render();
  }

  const toggle = () => {
    const noFiles = load.state === 'ready' && !load.files.length;
    if (!ctx || noFiles) return showHint(noFiles ? 'This pull request has no Markdown files.' : 'Open a pull request to review its Markdown files.');
    if (review) closeReview();
    else openReview();
  };

  try {
    chrome.runtime.onMessage.addListener((msg: any) => {
      if (msg?.type === 'toggle') toggle();
    });
  } catch { /* harness */ }

  // GitHub is a SPA (Turbo / React router) – watch for URL changes.
  let last = location.href;
  const check = () => {
    if (location.href === last) return;
    last = location.href;
    const next = parseContext();
    if (ctx && next && prKey(ctx) === prKey(next)) return;
    if (review) closeReview();
    ctx = next;
    load = { state: 'idle' };
    render();
    fetchPr();
  };
  window.setInterval(check, 500);
  window.addEventListener('popstate', check);
  document.addEventListener('turbo:load', check);

  // If Turbo ever removes our host, put it back.
  new MutationObserver(() => {
    if (!host.isConnected) document.documentElement.appendChild(host);
  }).observe(document.documentElement, { childList: true });

  fetchPr();
}

if (!devHook('__MDR_HARNESS__')) mount();
