import { useState } from 'react';

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

interface Props {
  draftCount: number;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (event: ReviewEvent, body: string) => void;
}

export function SubmitReview({ draftCount, busy, onCancel, onSubmit }: Props) {
  const [body, setBody] = useState('');
  const [event, setEvent] = useState<ReviewEvent>('COMMENT');
  const options: { v: ReviewEvent; label: string; hint: string }[] = [
    { v: 'COMMENT', label: 'Comment', hint: 'Submit general feedback without explicit approval.' },
    { v: 'APPROVE', label: 'Approve', hint: 'Give your approval to merge these changes.' },
    { v: 'REQUEST_CHANGES', label: 'Request changes', hint: 'Submit feedback that must be addressed before merging.' },
  ];
  const invalid = event !== 'APPROVE' && !body.trim() && draftCount === 0;
  return (
    <div className="mdr-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="mdr-modal" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onCancel())}>
        <h3>Finish your review</h3>
        <p className="mdr-muted">
          {draftCount ? `${draftCount} draft comment${draftCount === 1 ? '' : 's'} will be submitted with this review.` : 'No draft comments yet.'}
        </p>
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
          <span className="mdr-spacer" />
          <button className="mdr-btn" onClick={onCancel}>Cancel</button>
          <button className="mdr-btn mdr-btn-primary" disabled={busy || invalid} onClick={() => onSubmit(event, body.trim())}>
            {busy ? 'Submitting…' : 'Submit review'}
          </button>
        </div>
      </div>
    </div>
  );
}
