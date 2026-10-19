import { describe, expect, it } from 'vitest';
import { baseLines, diffTexts, headToBase, isReflow, parsePatch, presentDiff } from '../src/content/lib/patch';

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const WORDS = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon'.split(' ');
const para = () => Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => Array.from({ length: 4 + Math.floor(rnd() * 6) }, () => pick(WORDS)).join(' '));
const doc = () => {
  const blocks: string[][] = [];
  const n = 3 + Math.floor(rnd() * 8);
  for (let i = 0; i < n; i++) blocks.push(rnd() < 0.2 ? ['## ' + pick(WORDS) + ' ' + pick(WORDS)] : para());
  return blocks;
};
const join = (b: string[][]) => b.map((x) => x.join('\n')).join('\n\n') + (rnd() < 0.5 ? '\n' : '');

describe('fuzz', () => {
  it('baseLines round trip and removal positions', () => {
    let fails = 0;
    for (let iter = 0; iter < 3000; iter++) {
      const a = doc();
      const b = a.map((x) => [...x]);
      const ops = 1 + Math.floor(rnd() * 4);
      for (let o = 0; o < ops; o++) {
        const r = rnd();
        if (r < 0.25 && b.length > 1) { // move
          const i = Math.floor(rnd() * b.length); const [blk] = b.splice(i, 1); b.splice(Math.floor(rnd() * (b.length + 1)), 0, blk);
        } else if (r < 0.45) { const i = Math.floor(rnd() * b.length); b[i] = para(); }
        else if (r < 0.6 && b.length > 1) b.splice(Math.floor(rnd() * b.length), 1);
        else if (r < 0.8) b.splice(Math.floor(rnd() * (b.length + 1)), 0, para());
        else { const i = Math.floor(rnd() * b.length); const t = b[i].join(' ').split(' '); const k = 1 + Math.floor(rnd() * 3); const out: string[] = []; for (let s = 0; s < t.length; s += k + 3) out.push(t.slice(s, s + k + 3).join(' ')); b[i] = out; }
      }
      const oldText = join(a);
      const newText = join(b);
      const d = parsePatch(diffTexts(oldText, newText));
      const head = newText.split('\n');
      const oldL = oldText.split('\n');
      const base = baseLines(d, head);
      const norm = (x: string[]) => (x[x.length - 1] === '' ? x.slice(0, -1) : x);
      let bad = '';
      if (norm(base).join('\n') !== norm(oldL).join('\n')) bad += 'base mismatch;';
      for (const r of d.removals) r.lines.forEach((l, k) => { if (oldL[r.oldStart - 1 + k] !== l) bad += `oldStart wrong ${r.oldStart}+${k};`; });
      for (const [l] of d.moved) if (!d.added.has(l)) bad += 'moved not added;';
      for (const ws of [true, false]) {
        const s = presentDiff(d, ws);
        for (const [l, i] of s.moved) if (!s.removals[i] || !(s.removals[i].moved ?? []).some((m) => m.start <= l && l <= m.end)) bad += `moved idx wrong ws=${ws};`;
      }
      const h2b = headToBase(d, head.length);
      for (let l = 1; l <= norm(head).length; l++) if (!d.added.has(l) && oldL[h2b[l] - 1] !== head[l - 1]) { bad += `h2b ${l}->${h2b[l]};`; break; }
      if (bad) {
        if (fails++ < 3) console.log(bad, JSON.stringify({ oldText, newText }), JSON.stringify(d.removals));
      }
    }
    console.log('fails', fails);
  });
});
