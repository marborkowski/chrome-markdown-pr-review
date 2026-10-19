import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Commit } from '../types';

/** A button that opens a small panel below it; closes on outside click and Esc. */
function Dropdown({ label, title, active, children }: { label: ReactNode; title: string; active?: boolean; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (ref.current && !e.composedPath().includes(ref.current)) setOpen(false);
    };
    window.addEventListener('mousedown', away, true);
    return () => window.removeEventListener('mousedown', away, true);
  }, [open]);
  return (
    <div
      className="mdr-dropdown"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button className={`mdr-btn mdr-btn-menu${active ? ' mdr-btn-active' : ''}`} title={title} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>
        {label} <span aria-hidden>▾</span>
      </button>
      {open && <div className="mdr-menu" role="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}

export interface ViewOptions {
  inline: boolean;
  ignoreWs: boolean;
  fold: boolean;
  docsSyntax: boolean;
}

const VIEW_ITEMS: { key: keyof ViewOptions; label: string; hint: string; key2?: string }[] = [
  { key: 'inline', label: 'Word diff', hint: 'Show exactly which words changed inside a changed paragraph, list item, table cell or code block.', key2: 'w' },
  { key: 'ignoreWs', label: 'Hide whitespace-only changes', hint: 'Re-wrapped paragraphs and re-padded tables are not shown as changes (they get a faint dotted marker).' },
  { key: 'fold', label: 'Changes only', hint: 'Fold the unchanged parts of the document; headings stay as signposts.', key2: 'f' },
  { key: 'docsSyntax', label: 'Docs-site admonitions', hint: 'Render Docusaurus (:::note) and MkDocs (!!! note) admonitions like GitHub alerts.' },
];

export function ViewMenu({ options, onChange, wordDiffApplies }: { options: ViewOptions; onChange: (key: keyof ViewOptions, value: boolean) => void; wordDiffApplies: boolean }) {
  const changed = !options.inline || !options.ignoreWs || options.fold || !options.docsSyntax;
  return (
    <Dropdown label="View" title="View options" active={changed}>
      {() =>
        VIEW_ITEMS.map((it) => (
          <label key={it.key} className={`mdr-menu-item${it.key === 'inline' && !wordDiffApplies ? ' mdr-menu-off' : ''}`} title={it.hint}>
            <input type="checkbox" checked={options[it.key]} onChange={(e) => onChange(it.key, e.target.checked)} />
            <span>
              {it.label}
              {it.key2 && <kbd>{it.key2}</kbd>}
              <small>{it.hint}</small>
            </span>
          </label>
        ))
      }
    </Dropdown>
  );
}

export interface CompareChoice {
  sha: string;
  label: string;
}

const short = (sha: string) => sha.slice(0, 7);
const firstLine = (m: string) => m.split('\n')[0];

/** Pick what the highlighted changes are relative to: the whole PR, or a later commit (e.g. your last review). */
export function CompareMenu({ commits, lastReviewed, current, headSha, onPick }: {
  commits: Commit[] | null;
  lastReviewed: string | null;
  current: CompareChoice | null;
  headSha: string;
  onPick: (c: CompareChoice | null) => void;
}) {
  const others = (commits ?? []).filter((c) => c.sha !== headSha).reverse();
  const reviewedIdx = lastReviewed ? (commits ?? []).findIndex((c) => c.sha === lastReviewed) : -1;
  const sinceReview = reviewedIdx >= 0 && commits ? commits.length - 1 - reviewedIdx : null;
  const label = current ? `Since ${current.label}` : 'All changes';
  return (
    <Dropdown label={label} title="Which changes to highlight" active={!!current}>
        {(close) => (
          <div className="mdr-compare">
            <button className={`mdr-menu-item${!current ? ' on' : ''}`} onClick={() => (onPick(null), close())}>
              <span>
                All changes
                <small>Everything this pull request changes{commits ? ` (${commits.length} commit${commits.length === 1 ? '' : 's'})` : ''}.</small>
              </span>
            </button>
            {lastReviewed && lastReviewed !== headSha && (
              <button className={`mdr-menu-item${current?.sha === lastReviewed ? ' on' : ''}`} onClick={() => (onPick({ sha: lastReviewed, label: 'your last review' }), close())}>
                <span>
                  Since your last review
                  <small>
                    Changes after {short(lastReviewed)}
                    {sinceReview !== null ? ` · ${sinceReview} new commit${sinceReview === 1 ? '' : 's'}` : ' (the commit was force-pushed away; compared file by file)'}
                  </small>
                </span>
              </button>
            )}
            {lastReviewed === headSha && <div className="mdr-menu-note mdr-muted">No new commits since your last review.</div>}
            {commits === null && <div className="mdr-menu-note mdr-muted">Loading commits…</div>}
            {others.length > 0 && <div className="mdr-menu-sep">Changes after commit…</div>}
            {others.map((c) => (
              <button key={c.sha} className={`mdr-menu-item${current?.sha === c.sha ? ' on' : ''}`} onClick={() => (onPick({ sha: c.sha, label: short(c.sha) }), close())} title={c.commit.message}>
                <span>
                  <code>{short(c.sha)}</code> {firstLine(c.commit.message)}
                  <small>{c.author?.login ?? c.commit.author?.name ?? ''}{c.commit.author?.date ? ` · ${new Date(c.commit.author.date).toLocaleString()}` : ''}</small>
                </span>
              </button>
            ))}
          </div>
        )}
    </Dropdown>
  );
}

const SHORTCUTS: [string, string][] = [
  ['Alt + Shift + M', 'Open or close the review (rebind at chrome://extensions/shortcuts)'],
  ['n / p', 'Next / previous change'],
  ['j / k', 'Next / previous conversation'],
  ['[ / ]', 'Previous / next file'],
  ['v', 'Toggle Viewed for the file (and move on to the next unviewed one)'],
  ['c / s', 'Comment on / suggest a change to the selected text'],
  ['w', 'Word diff on / off'],
  ['f', 'Changes only on / off'],
  ['1 / 2 / 3', 'Rendered / Split / Source'],
  ['/', 'Filter files'],
  ['Ctrl/⌘ + Enter', 'Add the comment to the review · send a reply · submit the review'],
  ['Ctrl/⌘ + Shift + Enter', 'Post the comment immediately'],
  ['Esc', 'Close the dialog, then the review (a half-written comment asks first)'],
  ['?', 'This list'],
];

export function Help({ onClose }: { onClose: () => void }) {
  return (
    <div className="mdr-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="mdr-modal mdr-help"
        role="dialog"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        ref={(el) => el?.focus()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || e.key === '?') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <h3>Keyboard shortcuts</h3>
        <table>
          <tbody>
            {SHORTCUTS.map(([k, d]) => (
              <tr key={k}>
                <td><kbd>{k}</kbd></td>
                <td>{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mdr-muted">Hover a paragraph and press the <b>+</b> on its left to comment on all of it — handy for images, diagrams, tables and code blocks.</p>
        <div className="mdr-row">
          <span className="mdr-spacer" />
          <button className="mdr-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
