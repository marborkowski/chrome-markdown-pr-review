import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { lineLabel, type Anchor } from '../lib/anchor';

export interface ComposerTarget {
  anchor: Anchor;
  quote: string;
  rect: { top: number; bottom: number; left: number; width: number };
  suggest: boolean;
}

interface Props {
  target: ComposerTarget;
  lines: string[];
  hasDrafts: boolean;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (body: string, mode: 'now' | 'review') => void;
}

export function buildBody(text: string, quote: string, includeQuote: boolean, anchor: Anchor) {
  let out = '';
  if (includeQuote && quote) out += quote.trim().split('\n').map((l) => `> ${l}`).join('\n') + '\n\n';
  if (anchor.kind === 'file') out += `_${lineLabel(anchor.start, anchor.end).replace(/^l/, 'L')}:_\n\n`;
  return out + text.trim();
}

/** Show ~~deleted~~ parts of the quote struck through, like GitHub will render them. */
function quotePreview(quote: string) {
  const parts = quote.split(/(~~[^~\n]+~~)/);
  return parts.map((p, i) => (/^~~[^~\n]+~~$/.test(p) ? <del key={i}>{p.slice(2, -2)}</del> : p));
}

export function Composer({ target, lines, hasDrafts, busy, onCancel, onSubmit }: Props) {
  const { anchor, quote } = target;
  const suggestionText = () =>
    '```suggestion\n' + lines.slice(anchor.start - 1, anchor.end).join('\n') + '\n```\n';
  const canSuggest = anchor.kind === 'line';
  const [initial] = useState(() => (target.suggest && canSuggest ? suggestionText() : ''));
  const [text, setText] = useState(initial);
  const [includeQuote, setIncludeQuote] = useState(!(target.suggest && canSuggest));
  /** Esc on a comment with real content asks for a second Esc instead of silently dropping it. */
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const [pos, setPos] = useState({ top: target.rect.bottom + 10, left: target.rect.left });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    let top = target.rect.bottom + 10;
    if (top + h > window.innerHeight - 12) top = Math.max(12, target.rect.top - h - 10);
    let left = target.rect.left + target.rect.width / 2 - w / 2;
    left = Math.min(Math.max(12, left), window.innerWidth - w - 12);
    setPos({ top, left });
  }, [target]);

  useEffect(() => {
    const t = ta.current;
    if (!t) return;
    t.focus();
    if (target.suggest && canSuggest) {
      // place caret inside the suggestion block
      const end = t.value.lastIndexOf('\n```');
      t.setSelectionRange(end, end);
    }
  }, []);

  const insertSuggestion = () => {
    setText((t) => (t.includes('```suggestion') ? t : suggestionText() + t));
    setIncludeQuote(false);
    ta.current?.focus();
  };

  const submit = (mode: 'now' | 'review') => {
    if (!text.trim() || busy) return;
    onSubmit(buildBody(text, quote, includeQuote, anchor), mode);
  };

  return (
    <div
      ref={ref}
      className="mdr-composer"
      style={{ top: pos.top, left: pos.left }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          if (text.trim() && text !== initial && !confirmDiscard) setConfirmDiscard(true);
          else onCancel();
        }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit(e.shiftKey ? 'now' : 'review');
        }
      }}
    >
      <div className="mdr-composer-head">
        {anchor.kind === 'line' ? (
          <span>
            Comment on <b>{lineLabel(anchor.start, anchor.end)}</b>
            {anchor.clamped && <span className="mdr-muted"> · trimmed to the diff hunk</span>}
          </span>
        ) : (
          <span title={`GitHub only accepts line comments inside the diff; ${anchor.reason}.`}>
            File comment <span className="mdr-muted">· {lineLabel(anchor.start, anchor.end)} are outside the diff</span>
          </span>
        )}
      </div>
      {quote && (
        <label className="mdr-quote">
          <input type="checkbox" checked={includeQuote} onChange={(e) => setIncludeQuote(e.target.checked)} />
          <blockquote>{quotePreview(quote.length > 280 ? quote.slice(0, 280) + '…' : quote)}</blockquote>
        </label>
      )}
      <textarea
        ref={ta}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setConfirmDiscard(false);
        }}
        placeholder="Leave a comment (Markdown supported)"
        rows={text.split('\n').length > 4 ? Math.min(14, text.split('\n').length + 1) : 4}
      />
      {confirmDiscard && <div className="mdr-warn">Press Esc again to discard this comment.</div>}
      <div className="mdr-composer-actions">
        <button className="mdr-btn mdr-btn-ghost" onClick={insertSuggestion} disabled={!canSuggest} title={canSuggest ? 'Propose replacement text (GitHub suggestion)' : 'Suggestions need lines inside the diff'}>
          ± Suggest change
        </button>
        <span className="mdr-spacer" />
        <button className="mdr-btn" onClick={onCancel}>Cancel</button>
        <button className="mdr-btn" onClick={() => submit('now')} disabled={!text.trim() || busy} title="Post immediately (Ctrl/⌘+Shift+Enter)">
          Comment now
        </button>
        <button className="mdr-btn mdr-btn-primary" onClick={() => submit('review')} disabled={!text.trim() || busy} title="Ctrl/⌘+Enter">
          {hasDrafts ? 'Add to review' : 'Start a review'}
        </button>
      </div>
    </div>
  );
}
