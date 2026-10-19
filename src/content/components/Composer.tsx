import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { lineLabel, type Anchor } from '../lib/anchor';
import { Body } from './Threads';

export interface ComposerTarget {
  anchor: Anchor;
  quote: string;
  /** The selected words as they read now (deleted words left out): pre-selected in a suggestion so typing replaces them. */
  phrase?: string;
  rect: { top: number; bottom: number; left: number; width: number };
  suggest: boolean;
  /** Text to start the comment with (e.g. a finding of the checks). */
  initialText?: string;
}

interface Props {
  target: ComposerTarget;
  /** Head-file lines (what a suggestion replaces). */
  lines: string[];
  hasDrafts: boolean;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (body: string, mode: 'now' | 'review') => void;
}

export function buildBody(text: string, quote: string, includeQuote: boolean, anchor: Anchor) {
  let out = '';
  if (includeQuote && quote) out += quote.trim().split('\n').map((l) => `> ${l}`).join('\n') + '\n\n';
  if (anchor.kind === 'file' && anchor.start) {
    const label = lineLabel(anchor.start, anchor.end).replace(/^l/, 'L');
    out += anchor.side === 'LEFT' ? `_${label} of the previous version:_\n\n` : `_${label}:_\n\n`;
  }
  return out + text.trim();
}

/** Show ~~deleted~~ parts of the quote struck through, like GitHub will render them. */
function quotePreview(quote: string) {
  const parts = quote.split(/(~~[^~\n]+~~)/);
  return parts.map((p, i) => (/^~~[^~\n]+~~$/.test(p) ? <del key={i}>{p.slice(2, -2)}</del> : p));
}

/** Where `phrase` sits in `text`, tolerating differences in whitespace; null when it isn't there verbatim. */
export function findPhrase(text: string, phrase: string): [number, number] | null {
  const p = phrase.trim();
  if (!p) return null;
  const exact = text.indexOf(p);
  if (exact >= 0) return [exact, exact + p.length];
  const re = new RegExp(p.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
  const m = re.exec(text);
  return m ? [m.index, m.index + m[0].length] : null;
}

export function Composer({ target, lines, hasDrafts, busy, onCancel, onSubmit }: Props) {
  const { anchor, quote } = target;
  const original = lines.slice(anchor.start - 1, anchor.end).join('\n');
  const suggestionText = () => '```suggestion\n' + original + '\n```\n';
  const canSuggest = anchor.kind === 'line' && anchor.side === 'RIGHT';
  const [initial] = useState(() => (target.suggest && canSuggest ? suggestionText() : '') + (target.initialText ?? ''));
  const [text, setText] = useState(initial);
  const [tab, setTab] = useState<'write' | 'preview'>('write');
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

  /** Put the caret inside the suggestion, with the selected words selected so typing replaces them. */
  const selectInSuggestion = (t: HTMLTextAreaElement) => {
    const open = t.value.indexOf('```suggestion\n');
    if (open < 0) return;
    const from = open + '```suggestion\n'.length;
    const to = t.value.indexOf('\n```', from);
    const hit = target.phrase ? findPhrase(t.value.slice(from, to), target.phrase) : null;
    if (hit) t.setSelectionRange(from + hit[0], from + hit[1]);
    else t.setSelectionRange(to, to);
  };

  useEffect(() => {
    const t = ta.current;
    if (!t) return;
    t.focus();
    if (target.suggest && canSuggest) selectInSuggestion(t);
  }, []);

  const insertSuggestion = () => {
    setTab('write');
    setText((t) => (t.includes('```suggestion') ? t : suggestionText() + t));
    setIncludeQuote(false);
    requestAnimationFrame(() => {
      if (!ta.current) return;
      ta.current.focus();
      selectInSuggestion(ta.current);
    });
  };

  const submit = (mode: 'now' | 'review') => {
    if (!text.trim() || busy) return;
    onSubmit(buildBody(text, quote, includeQuote, anchor), mode);
  };

  const where = lineLabel(anchor.start, anchor.end, anchor.side);
  return (
    <div
      ref={ref}
      className="mdr-composer"
      role="dialog"
      aria-label="Comment"
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
            Comment on <b>{where}</b>
            {anchor.side === 'LEFT' && <span className="mdr-muted"> · removed text</span>}
            {anchor.clamped && <span className="mdr-muted"> · trimmed to the diff hunk</span>}
          </span>
        ) : (
          <span title={anchor.start ? `GitHub only accepts line comments inside the diff; ${anchor.reason}.` : undefined}>
            File comment{' '}
            <span className="mdr-muted">· {anchor.start ? `${where} ${anchor.start === anchor.end ? 'is' : 'are'} outside the diff` : 'on the whole file'}</span>
          </span>
        )}
        <span className="mdr-spacer" />
        <span className="mdr-seg mdr-seg-small" role="tablist">
          <button className={tab === 'write' ? 'on' : ''} onClick={() => setTab('write')}>Write</button>
          <button className={tab === 'preview' ? 'on' : ''} onClick={() => setTab('preview')} disabled={!text.trim()}>Preview</button>
        </span>
      </div>
      {quote && (
        <label className="mdr-quote">
          <input type="checkbox" checked={includeQuote} onChange={(e) => setIncludeQuote(e.target.checked)} />
          <blockquote>{quotePreview(quote.length > 280 ? quote.slice(0, 280) + '…' : quote)}</blockquote>
        </label>
      )}
      {tab === 'write' ? (
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
      ) : (
        <div className="mdr-preview">
          <Body text={buildBody(text, quote, includeQuote, anchor)} base={canSuggest ? original : null} />
        </div>
      )}
      {confirmDiscard && <div className="mdr-warn">Press Esc again to discard this comment.</div>}
      <div className="mdr-composer-actions">
        <button className="mdr-btn mdr-btn-ghost" onClick={insertSuggestion} disabled={!canSuggest} title={canSuggest ? 'Propose replacement text (GitHub suggestion)' : anchor.side === 'LEFT' ? 'Suggestions apply to the new version only' : 'Suggestions need lines inside the diff'}>
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
