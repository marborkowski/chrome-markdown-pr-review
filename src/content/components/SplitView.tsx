import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

interface Props {
  before: ReactNode;
  after: ReactNode;
  /** Head line → base line at the same place in the document (index 0 unused). */
  headToBase: number[];
  /** The scroll container of the new version (change navigation scrolls it). */
  afterRef: RefObject<HTMLDivElement>;
  beforeLabel: string;
  afterLabel: string;
}

/** Top-level blocks of a rendered document with their source lines. */
function blocksOf(pane: HTMLElement) {
  return [...pane.querySelectorAll<HTMLElement>('.mdr-doc > [data-sl], .mdr-doc > .mdr-fold, .mdr-doc > .mdr-void, .mdr-doc > .mdr-mermaid')];
}

const lineOf = (el: HTMLElement) => Number(el.dataset.sl ?? el.dataset.foldSl ?? el.querySelector<HTMLElement>('[data-sl]')?.dataset.sl ?? NaN);

/** The block at the top edge of a pane, and how far into it the edge is (0–1). */
function topBlock(pane: HTMLElement): { line: number; frac: number } | null {
  const top = pane.getBoundingClientRect().top + 4;
  for (const b of blocksOf(pane)) {
    const r = b.getBoundingClientRect();
    if (r.bottom <= top) continue;
    const line = lineOf(b);
    if (Number.isNaN(line)) continue;
    return { line, frac: r.height ? Math.max(0, Math.min(1, (top - r.top) / r.height)) : 0 };
  }
  return null;
}

/** Scroll `pane` so the block holding `line` (or the last one before it) sits at the top, `frac` of the way in. */
function scrollToLine(pane: HTMLElement, line: number, frac: number) {
  let best: HTMLElement | null = null;
  for (const b of blocksOf(pane)) {
    const l = lineOf(b);
    if (Number.isNaN(l) || l > line) break;
    best = b;
  }
  if (!best) return void (pane.scrollTop = 0);
  const r = best.getBoundingClientRect();
  pane.scrollTop += r.top - pane.getBoundingClientRect().top - 4 + frac * r.height;
}

/**
 * Before and after, side by side. Scrolling either side keeps the other at the same place of
 * the document (matched through the diff's line mapping, not by scroll percentage).
 */
export function SplitView({ before, after, headToBase, afterRef, beforeLabel, afterLabel }: Props) {
  const beforeRef = useRef<HTMLDivElement>(null);
  const lead = useRef<'before' | 'after' | null>(null);
  const frame = useRef(0);
  const release = useRef(0);

  const baseToHead = (base: number) => {
    let head = 1;
    for (let l = 1; l < headToBase.length; l++) {
      if (headToBase[l] > base) break;
      head = l;
    }
    return head;
  };

  const sync = (from: 'before' | 'after') => {
    if (lead.current && lead.current !== from) return;
    lead.current = from;
    window.clearTimeout(release.current);
    release.current = window.setTimeout(() => (lead.current = null), 120);
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const src = from === 'after' ? afterRef.current : beforeRef.current;
      const dst = from === 'after' ? beforeRef.current : afterRef.current;
      if (!src || !dst) return;
      const at = topBlock(src);
      if (!at) return;
      scrollToLine(dst, from === 'after' ? headToBase[at.line] ?? at.line : baseToHead(at.line), at.frac);
    });
  };

  useEffect(() => () => {
    cancelAnimationFrame(frame.current);
    window.clearTimeout(release.current);
  }, []);

  return (
    <div className="mdr-split">
      <div className="mdr-split-pane mdr-split-before" ref={beforeRef} onScroll={() => sync('before')}>
        <div className="mdr-split-label">{beforeLabel}</div>
        {before}
      </div>
      <div className="mdr-split-pane mdr-split-after" ref={afterRef} onScroll={() => sync('after')}>
        <div className="mdr-split-label">{afterLabel}</div>
        {after}
      </div>
    </div>
  );
}
