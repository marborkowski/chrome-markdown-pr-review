import { memo, useMemo } from 'react';
import type { DiffInfo } from '../lib/patch';

interface Props {
  source: string;
  diff: DiffInfo | null;
  threadLines: number[];
  pendingLines: number[];
  activeRange: [number, number] | null;
  onBadge: (sl: number, el: number) => void;
}

/** Raw Markdown with line numbers – precise line-level commenting. */
export const SourceDoc = memo(function SourceDoc({ source, diff, threadLines, pendingLines, activeRange, onBadge }: Props) {
  const lines = useMemo(() => source.replace(/\r?\n$/, '').split(/\r?\n/), [source]);
  const removalsAt = useMemo(() => {
    const m = new Map<number, string[][]>();
    diff?.removals.forEach((r) => m.set(r.anchor, [...(m.get(r.anchor) ?? []), r.lines]));
    return m;
  }, [diff]);
  const count = (arr: number[]) => arr.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<number, number>());
  const threads = useMemo(() => count(threadLines), [threadLines]);
  const pending = useMemo(() => count(pendingLines), [pendingLines]);

  const rows: JSX.Element[] = [];
  const pushRemoved = (ln: number) => {
    for (const group of removalsAt.get(ln) ?? []) {
      group.forEach((text, k) => {
        rows.push(
          <div key={`r${ln}-${rows.length}-${k}`} className={`mdr-src-line mdr-src-del${k === 0 ? ' mdr-removed-start' : ''}`}>
            <span className="mdr-src-num" />
            <span className="mdr-src-sign">−</span>
            <span className="mdr-src-text">{text || ' '}</span>
          </div>,
        );
      });
    }
  };
  lines.forEach((text, i) => {
    const ln = i + 1;
    pushRemoved(ln);
    const added = diff?.added.has(ln);
    const active = activeRange && ln >= activeRange[0] && ln <= activeRange[1];
    const t = threads.get(ln) ?? 0;
    const p = pending.get(ln) ?? 0;
    rows.push(
      <div
        key={ln}
        data-sl={ln}
        data-el={ln}
        data-block=""
        className={`mdr-src-line${added ? ' mdr-src-add mdr-added' : ''}${active ? ' mdr-active' : ''}`}
      >
        <span className="mdr-src-num">{ln}</span>
        <span className="mdr-src-sign">{added ? '+' : ' '}</span>
        <span className="mdr-src-text">{text || ' '}</span>
        {(t > 0 || p > 0) && (
          <span className="mdr-gutter">
            {t > 0 && <button className="mdr-badge mdr-badge-thread" onClick={() => onBadge(ln, ln)}>💬 {t}</button>}
            {p > 0 && <button className="mdr-badge mdr-badge-pending" onClick={() => onBadge(ln, ln)}>draft</button>}
          </span>
        )}
      </div>,
    );
  });
  pushRemoved(lines.length + 1);
  return <div className="mdr-source">{rows}</div>;
});
