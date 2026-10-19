import { describe, expect, it } from 'vitest';
import { strikeMarkdown, strikeUnicode } from '../src/content/lib/quote';

describe('quoting deleted text', () => {
  it('wraps deleted text in GFM strikethrough, keeping whitespace outside the markers', () => {
    expect(strikeMarkdown('300')).toBe('~~300~~');
    expect(strikeMarkdown(' and the No access summaries ')).toBe(' ~~and the No access summaries~~ ');
    expect(strikeMarkdown('first line\n  second line\n\n')).toBe('~~first line~~\n  ~~second line~~\n\n');
    expect(strikeMarkdown('   ')).toBe('   ');
  });

  it('strikes code with combining strokes, where GFM markup would not render', () => {
    expect(strikeUnicode('ab c')).toBe('a̶b̶ c̶');
  });
});
