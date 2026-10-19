// Built on its own into dist/review.js (ESM) and imported by the content script when the review
// is opened: React, the Markdown pipeline and the review UI never load on other GitHub pages.
import { createRoot } from 'react-dom/client';
import { Review, type ReviewProps } from '../content/components/Review';
import { prKey } from '../content/types';
import uiCss from '../content/styles.css';
import mdLight from 'github-markdown-css/github-markdown-light.css';
import mdDark from 'github-markdown-css/github-markdown-dark.css';

export interface ReviewMountProps extends ReviewProps {
  /** Bumped by "reload": the review starts over with the fresh pull request data. */
  reloadKey: number;
}

export interface ReviewHandle {
  update: (props: ReviewMountProps) => void;
  unmount: () => void;
}

/** Adds GitHub's Markdown styles (following the host's theme) and the overlay's styles to the shadow root, once. */
function installStyles(shadow: ShadowRoot) {
  if (shadow.querySelector('style[data-mdr="md"]')) return;
  const md = document.createElement('style');
  md.dataset.mdr = 'md';
  const ui = document.createElement('style');
  ui.dataset.mdr = 'ui';
  ui.textContent = uiCss;
  const first = shadow.querySelector('style');
  if (first) first.after(md, ui);
  else shadow.prepend(md, ui);
  const host = shadow.host;
  const apply = () => (md.textContent = host.getAttribute('data-theme') === 'dark' ? mdDark : mdLight);
  apply();
  new MutationObserver(apply).observe(host, { attributes: true, attributeFilter: ['data-theme'] });
}

export function mountReview(shadow: ShadowRoot, container: HTMLElement, props: ReviewMountProps): ReviewHandle {
  installStyles(shadow);
  const root = createRoot(container);
  const render = ({ reloadKey, ...p }: ReviewMountProps) => root.render(<Review key={`${prKey(p.ctx)}:${reloadKey}`} {...p} />);
  render(props);
  return { update: render, unmount: () => root.unmount() };
}
