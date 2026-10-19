import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownDoc, type MarkdownDocProps } from '../src/content/components/MarkdownDoc';
import { parsePatch } from '../src/content/lib/patch';

const render = (source: string, extra: Partial<MarkdownDocProps> = {}) =>
  renderToStaticMarkup(
    createElement(MarkdownDoc, {
      source,
      diff: null,
      threadLines: [],
      pendingLines: [],
      activeRange: null,
      inlineDiff: false,
      resolveUrl: (u) => u,
      onBadge: () => {},
      onMods: () => {},
      ...extra,
    }),
  );

describe('MarkdownDoc', () => {
  const doc = 'Intro\n\n---\n\nOutro\n';

  it('renders a thematic break (void <hr>) without crashing', () => {
    const html = render(doc);
    expect(html).toMatch(/<hr[^>]*data-sl="3"[^>]*\/>/);
    expect(html).toContain('Outro');
  });

  it('shows gutter badges for an <hr> that has threads', () => {
    const html = render(doc, { threadLines: [3] });
    expect(html).toMatch(/<hr[^>]*\/><span class="mdr-gutter"/);
  });

  it('renders a replaced <hr> as a word diff in inline mode', () => {
    const diff = parsePatch('@@ -1,5 +1,5 @@\n Intro\n \n----\n+***\n \n Outro\n');
    const html = render('Intro\n\n***\n\nOutro\n', { diff, inlineDiff: true });
    expect(html).toContain('mdr-worddiff');
    expect(html).toContain('Outro');
  });
});
