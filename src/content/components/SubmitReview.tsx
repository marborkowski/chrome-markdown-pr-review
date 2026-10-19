import { useState } from 'react';
import { lineLabel } from '../lib/anchor';
import type { PendingComment } from '../types';

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

/** A review needs a call to GitHub unless it's a plain comment with no summary and no line comments. */
export function needsReviewCall(event: ReviewEvent, body: string, lineDrafts: number) {
  return event !== 'COMMENT' || !!body.trim() || lineDrafts > 0;
}

/** Why the review can't be submitted yet, or null. GitHub wants a summary or line comments for these events. */
export function submitBlocker(event: ReviewEvent, body: string, lineDrafts: number, drafts: number): string | null {
  if (event === 'APPROVE' || body.trim() || lineDrafts) return null;
  if (event === 'REQUEST_CHANGES') return 'Add a summary or line comments to request changes.';
  return drafts ? null : 'Add a summary or some comments first.';
}

interface Props {
  drafts: PendingComment[];
  headSha: string;
  /** A review the user started in GitHub's own UI and hasn't submitted: GitHub allows only one pending review. */
  pendingReviewUrl?: string | null;
  /** The summary typed earlier and not submitted yet. */
  summary: string;
  onSummary: (text: string) => void;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (event: ReviewEvent, body: string) => void;
  onOpenDraft: (d: PendingComment) => void;
}

export function SubmitReview({ drafts, headSha, pendingReviewUrl, summary, onSummary, busy, onCancel, onSubmit, onOpenDraft }: Props) {
  const draftCount = drafts.length;
  const lineDraftCount = drafts.filter((d) => d.kind === 'line').length;
  const staleCount = drafts.filter((d) => d.sha && d.sha !== headSha).length;
  const body = summary;
  const setBody = onSummary;
  const byFile = new Map<string, PendingComment[]>();
  for (const d of drafts) byFile.set(d.path, [...(byFile.get(d.path) ?? []), d]);
  const [event, setEvent] = useState<ReviewEvent>('COMMENT');
  const options: { v: ReviewEvent; label: string; hint: string }[] = [
    { v: 'COMMENT', label: 'Comment', hint: 'Submit general feedback without explicit approval.' },
    { v: 'APPROVE', label: 'Approve', hint: 'Give your approval to merge these changes.' },
    { v: 'REQUEST_CHANGES', label: 'Request changes', hint: 'Submit feedback that must be addressed before merging.' },
  ];
  const blocker = submitBlocker(event, body, lineDraftCount, draftCount);
  const submit = () => {
    if (!busy && !blocker) onSubmit(event, body.trim());
  };
  return (
    <div className="mdr-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="mdr-modal"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel();
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <h3>Finish your review</h3>
        <p className="mdr-muted">
          {draftCount ? `${draftCount} draft comment${draftCount === 1 ? '' : 's'} will be submitted with this review.` : 'No draft comments yet.'}
        </p>
        {draftCount > 0 && (
          <ul className="mdr-draft-list">
            {[...byFile].map(([path, list]) => (
              <li key={path}>
                <span className="mdr-draft-file">{path}</span>
                {list.map((d) => (
                  <button key={d.id} className={`mdr-draft-chip${d.sha && d.sha !== headSha ? ' mdr-draft-stale' : ''}`} onClick={() => onOpenDraft(d)} title={d.body.slice(0, 200)}>
                    {d.kind === 'file' ? 'file · ' : ''}
                    {lineLabel(d.start, d.end, d.side)}
                  </button>
                ))}
              </li>
            ))}
          </ul>
        )}
        {staleCount > 0 && (
          <p className="mdr-warn">
            {staleCount} draft{staleCount === 1 ? ' was' : 's were'} written on an older version of this pull request – check the lines still match.
          </p>
        )}
        {pendingReviewUrl && (
          <p className="mdr-warn">
            You have a pending review started in GitHub's own interface. GitHub allows one pending review at a time, so submit or discard it{' '}
            <a href={pendingReviewUrl} target="_blank" rel="noreferrer">on GitHub</a> first.
          </p>
        )}
        <textarea autoFocus rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Leave a summary (optional)" />
        <div className="mdr-radio-group">
          {options.map((o) => (
            <label key={o.v} className={event === o.v ? 'mdr-radio-on' : ''}>
              <input type="radio" name="mdr-event" checked={event === o.v} onChange={() => setEvent(o.v)} />
              <span>
                <b>{o.label}</b>
                <small>{o.hint}</small>
              </span>
            </label>
          ))}
        </div>
        <div className="mdr-row">
          {blocker && <span className="mdr-muted mdr-small">{blocker}</span>}
          <span className="mdr-spacer" />
          <button className="mdr-btn" onClick={onCancel}>Cancel</button>
          <button className="mdr-btn mdr-btn-primary" disabled={busy || !!blocker} onClick={submit} title="Ctrl/⌘+Enter">
            {busy ? 'Submitting…' : 'Submit review'}
          </button>
        </div>
      </div>
    </div>
  );
}
