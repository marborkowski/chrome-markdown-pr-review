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
let seed = 777;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const W = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu'.split(' ');
const words = (n = 3 + Math.floor(rnd() * 6)) => Array.from({ length: n }, () => pick(W)).join(' ');
const BLOCKS: (() => string)[] = [
  () => words(),
  () => words() + '\n' + words(),
  () => '## ' + words(2),
  () => '- ' + words() + '\n- ' + words() + '\n  - ' + words(),
  () => '1. ' + words() + '\n2. ' + words(),
  () => '| a | b |\n|---|---|\n| ' + words(1) + ' | ' + words(1) + ' |\n| ' + words(1) + ' | ' + words(1) + ' |',
  () => '```js\n' + words() + '\n' + words() + '\n```',
  () => '> ' + words() + '\n> ' + words(),
  () => '> [!NOTE]\n> ' + words(),
  () => ':::tip\n' + words() + '\n:::',
  () => ':::warning[Title]\n\n' + words() + '\n\n- ' + words() + '\n\n:::',
  () => '!!! note "T"\n\n    ' + words() + '\n\n    - ' + words(),
  () => '<details>\n<summary>' + words(2) + '</summary>\n\n' + words() + '\n\n</details>',
  () => 'Math $x^2 + ' + pick(W) + '$ and $$y$$ here ' + words(2),
  () => '$$\n' + pick(W) + '^2\n$$',
  () => '```math\n' + pick(W) + '\n```',
  () => '```mermaid\ngraph TD\nA-->' + pick(['B', 'C']) + '\n```',
  () => '<p align="center"><img src="x.png" alt="' + pick(W) + '"></p>',
  () => '---',
  () => words() + '[^1]\n\n[^1]: ' + words(),
  () => '- [ ] ' + words() + '\n- [x] ' + words(),
  () => '',
];
const doc = () => Array.from({ length: 2 + Math.floor(rnd() * 8) }, () => pick(BLOCKS)()).join('\n\n');
const mutate = (s: string) => {
  const lines = s.split('\n');
  const n = 1 + Math.floor(rnd() * 4);
  for (let i = 0; i < n; i++) {
    const r = rnd();
    const at = Math.floor(rnd() * (lines.length + 1));
    if (r < 0.3) lines.splice(at, 0, ...pick(BLOCKS)().split('\n'));
    else if (r < 0.55 && lines.length) lines.splice(at, 1 + Math.floor(rnd() * 3));
    else if (r < 0.8 && lines[at]) lines[at] = lines[at].replace(/\b\w+\b/, pick(W));
    else if (lines.length > 4) { const blk = lines.splice(at, 3); lines.splice(Math.floor(rnd() * lines.length), 0, ...blk); }
  }
  return (rnd() < 0.2 ? '---\ntitle: x\n---\n\n' : '') + lines.join('\n') + (rnd() < 0.5 ? '\n' : '');
};

describe('render fuzz', () => {
  it('does not throw', () => {
    let fails = 0;
    const seen = new Set<string>();
    for (let iter = 0; iter < 1500; iter++) {
      const a = doc();
      const b = mutate(a);
      const raw = parsePatch(diffTexts(a, b));
      for (const ws of [true, false]) for (const inline of [true, false]) for (const fold of [false, true]) {
        try {
          render(b, { diff: presentDiff(raw, ws), inlineDiff: inline, fold, ignoreWhitespace: ws, threadLines: [1, 3], pendingLines: [2] });
        } catch (e) {
          const m = (e as Error).message.slice(0, 120);
          if (!seen.has(m)) { seen.add(m); console.log('THROW', m, JSON.stringify({ a, b, ws, inline, fold }).slice(0, 1500)); }
          fails++;
        }
      }
    }
    console.log('fails', fails);
  });
});
