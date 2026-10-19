import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it } from 'vitest';
import { MarkdownDoc, type MarkdownDocProps } from '../src/content/components/MarkdownDoc';
import { diffTexts, parsePatch, presentDiff } from '../src/content/lib/patch';

const render = (source: string, extra: Partial<MarkdownDocProps> = {}) =>
  renderToStaticMarkup(
    createElement(MarkdownDoc, {
      source, diff: null, threadLines: [], pendingLines: [], activeRange: null, inlineDiff: false,
      resolveUrl: (u) => u, onBadge: () => {}, onMods: () => {}, ...extra,
    }),
  );
const withDiff = (oldSrc: string, newSrc: string, extra: Partial<MarkdownDocProps> = {}) =>
  render(newSrc, { diff: presentDiff(parsePatch(diffTexts(oldSrc, newSrc)), true), inlineDiff: true, ...extra });

describe('scratch3', () => {
  it('pipe paragraph deleted after table', () => {
    const oldS = '| a | b |\n|---|---|\n| 1 | 2 |\n\nRun `cat x | grep y` to filter.\n';
    const newS = '| a | b |\n|---|---|\n| 1 | 2 |\n';
    console.log(withDiff(oldS, newS));
  });
  it('pipe paragraph deleted before table', () => {
    const oldS = 'Intro\n\nUse a || b here.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    const newS = 'Intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    console.log(withDiff(oldS, newS));
  });
});
