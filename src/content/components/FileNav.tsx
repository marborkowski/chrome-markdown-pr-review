import { forwardRef, useState } from 'react';
import type { OutlineItem } from '../lib/outline';
import type { PendingComment, PrFile } from '../types';

const STATUS: Record<string, { letter: string; cls: string; title: string }> = {
  added: { letter: 'A', cls: 'add', title: 'Added' },
  removed: { letter: 'D', cls: 'del', title: 'Deleted' },
  renamed: { letter: 'R', cls: 'ren', title: 'Renamed' },
  copied: { letter: 'C', cls: 'ren', title: 'Copied' },
};

function splitPath(p: string) {
  const i = p.lastIndexOf('/');
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}

interface Props {
  files: PrFile[];
  path: string;
  viewed: Record<string, boolean> | null;
  drafts: PendingComment[];
  threadCount: Record<string, number>;
  /** Files with no changes since the commit being compared against (when comparing). */
  unchanged?: Set<string> | null;
  onSelect: (path: string) => void;
  outline: OutlineItem[];
  activeHeading: string | null;
  onHeading: (item: OutlineItem) => void;
}

const CHANGE_TITLE = { added: 'New section', changed: 'Changed in this pull request', moved: 'Moved' } as const;

/** The left column: the PR's Markdown files and the outline of the open one. */
export const FileNav = forwardRef<HTMLInputElement, Props>(function FileNav(p, filterRef) {
  const [filter, setFilter] = useState('');
  const [hideViewed, setHideViewed] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const q = filter.trim().toLowerCase();
  const shown = p.files.filter((f) => (!q || f.filename.toLowerCase().includes(q)) && (!hideViewed || !p.viewed?.[f.filename] || f.filename === p.path));
  const viewedCount = p.viewed ? p.files.filter((f) => p.viewed![f.filename]).length : 0;
  const minDepth = Math.min(...p.outline.map((o) => o.depth));

  return (
    <nav className="mdr-files" aria-label="Files and outline">
      <div className="mdr-files-head">
        Markdown files <span className="mdr-count">{p.files.length}</span>
        {p.viewed && <span className="mdr-muted mdr-viewed-count">{viewedCount}/{p.files.length} viewed</span>}
      </div>
      {(p.files.length > 5 || filter) && (
        <div className="mdr-files-tools">
          <input ref={filterRef} className="mdr-filter" type="search" placeholder="Filter files  ( / )" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (setFilter(''), (e.target as HTMLInputElement).blur())} />
          {p.viewed && (
            <label className="mdr-toggle mdr-small" title="Hide files you marked as viewed">
              <input type="checkbox" checked={hideViewed} onChange={(e) => setHideViewed(e.target.checked)} /> Hide viewed
            </label>
          )}
        </div>
      )}
      <div className="mdr-file-list">
        {shown.map((f) => {
          const { dir, name } = splitPath(f.filename);
          const st = STATUS[f.status];
          const drafted = p.drafts.filter((d) => d.path === f.filename).length;
          const same = p.unchanged?.has(f.filename);
          return (
            <button
              key={f.filename}
              className={`mdr-file${f.filename === p.path ? ' on' : ''}${p.viewed?.[f.filename] ? ' viewed' : ''}${same ? ' mdr-file-same' : ''}`}
              onClick={() => p.onSelect(f.filename)}
              title={same ? `${f.filename} – no changes since the selected commit` : f.filename}
              aria-current={f.filename === p.path ? 'page' : undefined}
            >
              <span className="mdr-file-name">
                {st && <span className={`mdr-status mdr-status-${st.cls}`} title={st.title}>{st.letter}</span>}
                <span className="mdr-file-dir">{dir}</span>
                <b>{name}</b>
              </span>
              <span className="mdr-file-meta">
                <span className="mdr-add">+{f.additions}</span>
                <span className="mdr-del">−{f.deletions}</span>
                {p.threadCount[f.filename] ? <span title="Unresolved conversations">💬 {p.threadCount[f.filename]}</span> : null}
                {drafted ? <span className="mdr-draft-dot">{drafted} draft</span> : null}
                {same && <span className="mdr-muted">no new changes</span>}
                {p.viewed?.[f.filename] && <span className="mdr-check" title="Viewed">✓</span>}
              </span>
            </button>
          );
        })}
        {!shown.length && <p className="mdr-muted mdr-empty">No files match.</p>}
      </div>

      {p.outline.length > 1 && (
        <div className="mdr-outline">
          <button className="mdr-files-head mdr-outline-head" onClick={() => setOutlineOpen(!outlineOpen)} aria-expanded={outlineOpen}>
            {outlineOpen ? '▾' : '▸'} Outline <span className="mdr-count">{p.outline.length}</span>
            {p.outline.some((o) => o.change) && <span className="mdr-muted mdr-viewed-count">{p.outline.filter((o) => o.change).length} changed</span>}
          </button>
          {outlineOpen && (
            <ol className="mdr-outline-list">
              {p.outline.map((o) => (
                <li key={`${o.id}-${o.line}`}>
                  <button
                    className={`mdr-outline-item${p.activeHeading === o.id ? ' on' : ''}`}
                    style={{ paddingLeft: 8 + (o.depth - minDepth) * 12 }}
                    onClick={() => p.onHeading(o)}
                    title={o.change ? `${o.text} – ${CHANGE_TITLE[o.change]}` : o.text}
                  >
                    <span className={`mdr-dot${o.change ? ` mdr-dot-${o.change}` : ''}`} aria-hidden />
                    <span className="mdr-outline-text">{o.text || '(untitled)'}</span>
                    {o.comments > 0 && <span className="mdr-outline-comments">💬 {o.comments}</span>}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      <div className="mdr-files-foot mdr-muted">
        <kbd>n</kbd>/<kbd>p</kbd> change · <kbd>j</kbd>/<kbd>k</kbd> comment · <kbd>[</kbd>/<kbd>]</kbd> file · <kbd>?</kbd> all shortcuts
      </div>
    </nav>
  );
});
