import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { baseLines, diffTexts, headToBase, isReflow, parsePatch, presentDiff } from '../src/content/lib/patch';

const diffOf = (a: string, b: string) => parsePatch(diffTexts(a, b));

describe('diffTexts', () => {
  it('produces a GitHub-style patch that parsePatch reads', () => {
    const d = diffOf('a\nb\nc\n', 'a\nB\nc\nd\n');
    expect([...d.added]).toEqual([2, 4]);
    expect(d.removals).toMatchObject([{ anchor: 2, oldStart: 2, lines: ['b'], replacedBy: { start: 2, end: 2 } }]);
    expect(d.hunks).toEqual([{ start: 1, end: 4 }]);
    expect(d.oldHunks).toEqual([{ start: 1, end: 3 }]);
  });
  it('is empty for identical texts and tolerates a missing final newline / CRLF', () => {
    expect(diffTexts('x\ny', 'x\r\ny\n')).toBe('');
  });
  it('handles a brand-new and an emptied file', () => {
    expect([...diffOf('', 'one\ntwo\n').added]).toEqual([1, 2]);
    expect(diffOf('one\ntwo\n', '').removals).toMatchObject([{ anchor: 1, oldStart: 1, lines: ['one', 'two'] }]);
  });
});

describe('old line numbers', () => {
  it('records where removed lines were in the base file', () => {
    const d = parsePatch('@@ -10,6 +10,5 @@\n ctx\n-gone one\n-gone two\n ctx\n-old\n+new\n+newer\n ctx\n');
    expect(d.removals.map((r) => [r.oldStart, r.anchor])).toEqual([[11, 11], [14, 12]]);
    expect(d.oldHunks).toEqual([{ start: 10, end: 15 }]);
    expect(d.hunks).toEqual([{ start: 10, end: 14 }]);
  });
});

describe('isReflow', () => {
  it('spots a re-wrapped paragraph', () => {
    expect(isReflow(['The quick brown fox', 'jumps over the dog.'], ['The quick brown', 'fox jumps over', 'the dog.'])).toBe(true);
  });
  it('spots a re-padded table', () => {
    expect(isReflow(['| a | bb |', '|---|---|', '| ccc | d |'], ['| a   | bb |', '| --- | -- |', '| ccc | d  |'])).toBe(true);
    expect(isReflow(['| a | bb |', '|---|---|'], ['| a | bb |', '|:--|---|'])).toBe(false); // alignment changed
    expect(isReflow(['| a | bb |', '| ccc | d |'], ['| a   | bb |', '| ccc | d  |'])).toBe(true);
  });
  it('spots a re-wrapped list item but not a split one', () => {
    expect(isReflow(['- one two', '  three'], ['- one', '  two three'])).toBe(true);
    expect(isReflow(['- one two three'], ['- one', '- two three'])).toBe(false);
    expect(isReflow(['- one'], ['  - one'])).toBe(false); // nesting changed
  });
  it('treats real edits, paragraph splits and hard breaks as changes', () => {
    expect(isReflow(['one two'], ['one three'])).toBe(false);
    expect(isReflow(['one two'], ['one', '', 'two'])).toBe(false);
    expect(isReflow(['one two'], ['one  ', 'two'])).toBe(false);
    expect(isReflow(['same'], ['same'])).toBe(false);
  });
  it('never treats code as whitespace-insensitive', () => {
    expect(isReflow(['```', 'a  b', '```'], ['```', 'a b', '```'])).toBe(false);
  });
  it('keeps quote depth significant', () => {
    expect(isReflow(['> a b'], ['> a', '> b'])).toBe(true);
    expect(isReflow(['> a b'], ['> a', '> > b'])).toBe(false);
  });
});

describe('moved text', () => {
  const oldDoc = '# Doc\n\n## Setup\n\nInstall the package with npm and run it.\n\n## Usage\n\nCall the function with a config object.\n';
  const newDoc = '# Doc\n\n## Usage\n\nCall the function with a config object.\n\n## Setup\n\nInstall the package with npm and run it.\n';
  it('pairs a removed section with the same section added elsewhere, heading included', () => {
    const d = diffOf(oldDoc, newDoc);
    const at = (s: string) => newDoc.split('\n').indexOf(s) + 1;
    expect(d.removals).toHaveLength(1);
    expect(d.removals[0].moved).toEqual([
      { from: 0, to: 1, start: at('## Setup'), end: at('## Setup') },
      { from: 2, to: 3, start: at('Install the package with npm and run it.'), end: at('Install the package with npm and run it.') },
    ]);
    expect([...d.moved.keys()].sort()).toEqual([at('## Setup'), at('Install the package with npm and run it.')]);
  });
  it('ignores short coincidences', () => {
    const d = diffOf('a\n\n---\n\nb\n', 'b\n\n---\n\na\n');
    expect(d.moved.size).toBe(0);
  });
  it('does not call an edited paragraph moved', () => {
    const d = diffOf('Intro text that is long enough.\n\nOther\n', 'Other\n\nIntro text that is long enough!\n');
    expect(d.moved.size).toBe(0);
  });
});

describe('presentDiff', () => {
  const d = diffOf('Para one two\nthree four.\n\nReal change here.\n', 'Para one\ntwo three four.\n\nReal edit here.\n');
  it('drops whitespace-only changes and remembers where they were', () => {
    const shown = presentDiff(d, true);
    expect(shown.removals).toHaveLength(1);
    expect(shown.removals[0].lines).toEqual(['Real change here.']);
    expect([...shown.added]).toEqual([4]);
    expect(shown.reflowed).toEqual([{ start: 1, end: 2 }]);
    expect(shown.hunks).toEqual(d.hunks); // anchors stay GitHub's
  });
  it('is the same diff when whitespace counts', () => {
    expect(presentDiff(d, false)).toBe(d);
  });
});

describe('baseLines / headToBase', () => {
  const oldDoc = 'a\nb\nc\nd\ne';
  const newDoc = 'a\nX\nc\ne\nf';
  const d = diffOf(oldDoc, newDoc);
  it('rebuilds the base version from the head and the diff', () => {
    expect(baseLines(d, newDoc.split('\n'))).toEqual(oldDoc.split('\n'));
  });
  it('maps head lines to base lines', () => {
    expect(headToBase(d, 5).slice(1)).toEqual([1, 2, 3, 5, 6]);
  });
});

describe('moved text that git paired with a rewrite', () => {
  const fx = (f: string) => readFileSync(new URL(`../dev/fixtures/${f}`, import.meta.url), 'utf8');
  const head = fx('guide-head.md').split('\n');
  const at = (s: string) => head.indexOf(s) + 1;
  const d = parsePatch(fx('guide.patch'));
  it('finds the section moved below "Usage", heading included', () => {
    const moved = d.removals.filter((r) => r.moved?.length);
    expect(moved.flatMap((r) => r.moved!.map((m) => m.start))).toEqual([at('## Setup'), at('Install the operator CLI with Homebrew and log in with your SSO account before')]);
    expect(d.moved.has(at('you run any of the commands below.'))).toBe(true);
    expect(moved.every((r) => !r.replacedBy)).toBe(true);
  });
  it('leaves what was written in its place as new text', () => {
    const l = at(':::warning[Read this first]');
    expect(d.added.has(l)).toBe(true);
    expect(d.removals.some((r) => r.replacedBy && r.replacedBy.start <= l && l <= r.replacedBy.end)).toBe(false);
    expect(d.moved.has(l)).toBe(false);
  });
  it('still sees the re-wrapped intro as whitespace-only', () => {
    const r = d.removals.find((x) => x.lines[0]?.startsWith('This guide is for'))!;
    expect(r.reflow).toBe(true);
  });
});
