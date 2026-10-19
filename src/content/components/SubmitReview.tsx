import { useState } from 'react';

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
  draftCount: number;
  lineDraftCount: number;
  staleCount: number;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (event: ReviewEvent, body: string) => void;
}

export function SubmitReview({ draftCount, lineDraftCount, staleCount, busy, onCancel, onSubmit }: Props) {
  const [body, setBody] = useState('');
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
        {staleCount > 0 && (
          <p className="mdr-warn">
            {staleCount} draft{staleCount === 1 ? ' was' : 's were'} written on an older version of this pull request – check the lines still match.
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
