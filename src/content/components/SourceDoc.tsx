import { memo, useMemo } from 'react';
import type { DiffInfo } from '../lib/patch';

interface Props {
  source: string;
  diff: DiffInfo | null;
  threadLines: number[];
  pendingLines: number[];
  /** Base-file lines with conversations or drafts on removed text. */
  leftLines?: number[];
  activeRange: [number, number] | null;
  onBadge: (sl: number, el: number, side?: 'LEFT' | 'RIGHT') => void;
}

/** Raw Markdown with line numbers – precise line-level commenting. */
export const SourceDoc = memo(function SourceDoc({ source, diff, threadLines, pendingLines, leftLines = [], activeRange, onBadge }: Props) {
  const lines = useMemo(() => source.replace(/\r?\n$/, '').split(/\r?\n/), [source]);
  const removalsAt = useMemo(() => {
    const m = new Map<number, { lines: string[]; oldStart: number; moved: Set<number> }[]>();
    diff?.removals.forEach((r) => {
      const moved = new Set<number>();
      for (const c of r.moved ?? []) for (let k = c.from; k < c.to; k++) moved.add(k);
      m.set(r.anchor, [...(m.get(r.anchor) ?? []), { lines: r.lines, oldStart: r.oldStart, moved }]);
    });
    return m;
  }, [diff]);
  const reflowed = useMemo(() => {
    const s = new Set<number>();
    for (const r of diff?.reflowed ?? []) for (let l = r.start; l <= r.end; l++) s.add(l);
    return s;
  }, [diff]);
  const left = useMemo(() => leftLines.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<number, number>()), [leftLines]);
  const count = (arr: number[]) => arr.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<number, number>());
  const threads = useMemo(() => count(threadLines), [threadLines]);
  const pending = useMemo(() => count(pendingLines), [pendingLines]);

  const rows: JSX.Element[] = [];
  const pushRemoved = (ln: number) => {
    for (const group of removalsAt.get(ln) ?? []) {
      group.lines.forEach((text, k) => {
        const ol = group.oldStart + k;
        const c = left.get(ol) ?? 0;
        const moved = group.moved.has(k);
        rows.push(
          <div
            key={`r${ln}-${rows.length}-${k}`}
            data-osl={ol}
            data-oel={ol}
            className={`mdr-src-line mdr-src-del${moved ? ' mdr-src-moved' : ''}${k === 0 ? ' mdr-removed-start' : ''}`}
            title={moved ? 'Moved elsewhere in the file' : undefined}
          >
            <span className="mdr-src-num" title={`Line ${ol} of the previous version`}>{ol}</span>
            <span className="mdr-src-sign">{moved ? '⇅' : '−'}</span>
            <span className="mdr-src-text">{text || ' '}</span>
            {c > 0 && (
              <span className="mdr-gutter">
                <button className="mdr-badge mdr-badge-thread" onClick={() => onBadge(ol, ol, 'LEFT')}>💬 {c}</button>
              </span>
            )}
          </div>,
        );
      });
    }
  };
  lines.forEach((text, i) => {
    const ln = i + 1;
    pushRemoved(ln);
    const added = diff?.added.has(ln);
    const moved = added && diff?.moved.has(ln);
    const active = activeRange && ln >= activeRange[0] && ln <= activeRange[1];
    const t = threads.get(ln) ?? 0;
    const p = pending.get(ln) ?? 0;
    rows.push(
      <div
        key={ln}
        data-sl={ln}
        data-el={ln}
        data-block=""
        className={`mdr-src-line${moved ? ' mdr-src-moved mdr-moved' : added ? ' mdr-src-add mdr-added' : ''}${reflowed.has(ln) ? ' mdr-src-reflow' : ''}${active ? ' mdr-active' : ''}`}
        title={moved ? 'Moved here unchanged' : reflowed.has(ln) ? 'Only re-wrapped (whitespace changes hidden)' : undefined}
      >
        <span className="mdr-src-num">{ln}</span>
        <span className="mdr-src-sign">{moved ? '⇅' : added ? '+' : ' '}</span>
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
