import { createRoot } from 'react-dom/client';
import { App } from './App';
import uiCss from './styles.css';
import mdLight from 'github-markdown-css/github-markdown-light.css';
import mdDark from 'github-markdown-css/github-markdown-dark.css';

declare global {
  interface Window {
    __mdrLoaded?: boolean;
  }
}

function detectTheme(): 'light' | 'dark' {
  const html = document.documentElement;
  const mode = html.getAttribute('data-color-mode');
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
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

  const mdStyle = document.createElement('style');
  const uiStyle = document.createElement('style');
  uiStyle.textContent = uiCss;
  shadow.append(mdStyle, uiStyle);

  const applyTheme = () => {
    const t = detectTheme();
    host.setAttribute('data-theme', t);
    mdStyle.textContent = t === 'dark' ? mdDark : mdLight;
  };
  applyTheme();
  new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-color-mode', 'data-dark-theme', 'data-light-theme'] });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  const container = document.createElement('div');
  container.className = 'mdr-root';
  shadow.appendChild(container);
  createRoot(container).render(<App />);

  // If Turbo ever removes our host, put it back.
  new MutationObserver(() => {
    if (!host.isConnected) document.documentElement.appendChild(host);
  }).observe(document.documentElement, { childList: true });
}

if (!(window as any).__MDR_HARNESS__) mount();
