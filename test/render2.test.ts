import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownDoc, type MarkdownDocProps } from '../src/content/components/MarkdownDoc';
import { diffTexts, parsePatch, presentDiff } from '../src/content/lib/patch';
import { joinChanges, markdownDiffSource } from '../src/content/lib/inlineDiff';

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

const withDiff = (oldSrc: string, newSrc: string, extra: Partial<MarkdownDocProps> = {}) =>
  render(newSrc, { diff: parsePatch(diffTexts(oldSrc, newSrc)), inlineDiff: true, ...extra });

describe('raw HTML', () => {
  it('renders the HTML GitHub allows, keeping source lines for comments', () => {
    const html = render('Intro\n\n<details>\n<summary>More</summary>\n\nHidden **text**\n\n</details>\n\n<p align="center">\n  <img src="logo.png" width="80" alt="Logo">\n</p>\n\nPress <kbd>Ctrl</kbd>+<kbd>C</kbd>.\n');
    expect(html).toMatch(/<details[^>]*data-sl="3" data-el="8"/);
    expect(html).toContain('<summary');
    expect(html).toMatch(/<p align="center"[^>]*data-sl="10"/);
    expect(html).toMatch(/<img width="80"[^>]*src="logo.png" alt="Logo"/);
    expect(html).toContain('<kbd data-sl="14" data-el="14">Ctrl</kbd>');
    expect(html).not.toContain('&lt;details');
  });

  it('strips scripts, event handlers, styles, javascript: links and classes', () => {
    const html = render('<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)" style="color:red">\n\n<a href="javascript:alert(1)" class="mdr-added">x</a>\n\n<div class="mdr-gutter mdr-added">fake</div>\n\n<iframe src="https://evil.example"></iframe>\n');
    expect(html).not.toMatch(/<script|onerror|style=|javascript:|<iframe/);
    expect(html).not.toMatch(/class="[^"]*mdr-(added|gutter)/);
    expect(html).toContain('fake');
  });

  it('resolves relative srcset candidates of <picture>', () => {
    const html = render('<picture>\n<source media="(prefers-color-scheme: dark)" srcset="img/dark.png 1x, img/dark@2x.png 2x">\n<img src="img/light.png" alt="x">\n</picture>\n', {
      resolveUrl: (u) => (u.startsWith('http') ? u : `https://r/${u}`),
    });
    expect(html).toMatch(/srcset="https:\/\/r\/img\/dark.png 1x, https:\/\/r\/img\/dark@2x.png 2x"/i);
    expect(html).toContain('src="https://r/img/light.png"');
  });

  it('keeps <a name> anchors and footnotes linkable', () => {
    const html = render('See[^1] and <a name="legacy"></a>old.\n\n[^1]: The note.\n');
    expect(html).toMatch(/id="user-content-fn-1"/);
    expect(html).toMatch(/href="#fn-1"/);
    expect(html).toMatch(/name="user-content-legacy"/);
  });
});

describe('callouts', () => {
  it('renders Docusaurus admonitions with their title and exact lines', () => {
    const html = render('Intro\n\n:::warning[Mind the gap]\n\nKeep **clear** of the doors.\n\n:::\n\nAfter\n');
    expect(html).toMatch(/<div class="markdown-alert markdown-alert-warning" data-sl="3" data-el="7"/);
    expect(html).toMatch(/markdown-alert-title[^>]*><svg[\s\S]*?<\/svg>Mind the gap<\/p>/);
    expect(html).toMatch(/<p data-sl="5" data-el="5"[^>]*>Keep <strong/);
    expect(html).not.toContain(':::');
  });

  it('handles a compact admonition and the legacy title syntax', () => {
    const html = render(':::tip Pro tip\nUse the cache.\n:::\n');
    expect(html).toContain('markdown-alert-tip');
    expect(html).toContain('Pro tip');
    expect(html).toContain('Use the cache.');
    expect(html).not.toContain(':::');
  });

  it('renders MkDocs admonitions, re-parsing their indented body on the right lines', () => {
    const html = render('# T\n\n!!! danger "Data loss"\n\n    Run `backup` **first**.\n\n    - one\n    - two\n\nOutside\n');
    expect(html).toMatch(/markdown-alert-caution/);
    expect(html).toContain('Data loss');
    expect(html).toMatch(/<p data-sl="5" data-el="5"[^>]*>Run <code/);
    expect(html).toMatch(/<li data-sl="8" data-el="8"/);
    expect(html).toMatch(/<p data-sl="10"[^>]*>Outside/);
  });

  it('leaves unknown or unclosed syntax as text, and can be switched off', () => {
    expect(render(':::foo\nx\n:::\n')).toContain(':::foo');
    expect(render(':::note\nnever closed\n')).toContain(':::note');
    expect(render(':::note\nx\n:::\n', { docsSyntax: false })).toContain(':::note');
  });

  it('still renders GitHub alerts after sanitizing', () => {
    const html = render('> [!CAUTION]\n> Irreversible.\n');
    expect(html).toContain('markdown-alert markdown-alert-caution');
    expect(html).toContain('Irreversible.');
  });
});

describe('math, emoji, front matter', () => {
  it('turns $…$, $`…`$ and $$…$$ into math but leaves dollar amounts alone', () => {
    const html = render('Euler: $e^{i\\pi}+1=0$ and $`\\sqrt{2}`$.\n\nIt costs $5 and $10 today.\n\n$$\n\\int_0^1 x\\,dx\n$$\n');
    expect(html).toContain('<code class="mdr-math-src">e^{i\\pi}+1=0</code>');
    expect(html).toContain('<code class="mdr-math-src">\\sqrt{2}</code>');
    expect(html).toContain('It costs $5 and $10 today.');
    expect(html).toMatch(/<div[^>]*class="[^"]*mdr-math-block[^"]*"[^>]*><code class="mdr-math-src">\\int_0\^1 x\\,dx<\/code>/);
  });

  it('renders ```math blocks as display math', () => {
    expect(render('```math\na^2+b^2=c^2\n```\n')).toContain('<code class="mdr-math-src">a^2+b^2=c^2</code>');
  });

  it('renders emoji shortcodes', () => {
    expect(render('Shipped :rocket: :not_an_emoji:\n')).toContain('Shipped 🚀 :not_an_emoji:');
  });

  it('shows YAML and TOML front matter', () => {
    expect(render('---\ntitle: A\n---\n\n# A\n')).toMatch(/<pre data-frontmatter=""[^>]*><code>---\ntitle: A\n---<\/code>/);
    expect(render('+++\ntitle = "A"\n+++\n\n# A\n')).toContain('+++\ntitle = &quot;A&quot;\n+++');
  });
});

describe('tables', () => {
  const oldT = '| Name | Limit |\n|---|---|\n| alpha | 10 |\n| beta | 20 |\n| gamma | 30 |\n';
  it('diffs an edited row cell by cell', () => {
    const html = withDiff(oldT, oldT.replace('| beta | 20 |', '| beta | 25 |'));
    const row = /<tr[^>]*class="[^"]*mdr-mod[^"]*"[^>]*>[\s\S]*?<\/tr>/.exec(html)![0];
    expect(row).toContain('beta');
    expect(row).toMatch(/<del class="mdr-d-del">20<\/del>/);
    expect(row).toMatch(/<ins class="mdr-d-ins">25<\/ins>/);
    expect(row).not.toMatch(/<del[^>]*>beta/);
  });

  it('keeps a removed row in its table, struck out', () => {
    const html = withDiff(oldT, oldT.replace('| beta | 20 |\n', ''));
    expect(html).toMatch(/<tbody[\s\S]*alpha[\s\S]*<tr class="mdr-removed-row" data-osl="4"[\s\S]*beta[\s\S]*gamma[\s\S]*<\/tbody>/);
    expect(html).not.toContain('mdr-removed"');
  });

  it('keeps removed last rows in the table and marks added rows', () => {
    const html = withDiff(oldT, oldT.replace('| gamma | 30 |\n', '| delta | 40 |\n'));
    expect(html).toMatch(/delta[\s\S]*<\/tr><tr class="mdr-removed-row"[\s\S]*gamma/);
    expect(html).toMatch(/<tr[^>]*class="mdr-added"[^>]*>[\s\S]*delta/);
  });

  it('treats a re-padded table as unchanged when whitespace is ignored', () => {
    const padded = '| Name  | Limit |\n|-------|-------|\n| alpha | 10    |\n| beta  | 20    |\n| gamma | 30    |\n';
    const diff = presentDiff(parsePatch(diffTexts(oldT, padded)), true);
    const html = render(padded, { diff, inlineDiff: true, ignoreWhitespace: true });
    expect(html).not.toMatch(/mdr-added|mdr-mod|mdr-removed/);
  });
});

describe('moved and re-wrapped text', () => {
  const a = '# Doc\n\n## Setup\n\nInstall the package with npm and run it.\n\n## Usage\n\nCall the function with a config object.\n';
  const b = '# Doc\n\n## Usage\n\nCall the function with a config object.\n\n## Setup\n\nInstall the package with npm and run it.\n';
  it('marks moved blocks instead of showing them as removed and added', () => {
    const html = withDiff(a, b);
    expect(html).toMatch(/<p[^>]*class="mdr-moved"[^>]*>Install the package/);
    expect(html).toMatch(/<h2[^>]*class="mdr-moved"/);
    expect(html).toContain('mdr-removed-moved');
    expect(html).not.toMatch(/Removed \d+ line/);
    expect(html).not.toContain('mdr-added');
  });

  it('hints at a re-wrapped paragraph without calling it a change', () => {
    const oldP = 'One two three four five six.\n\nOther.\n';
    const newP = 'One two three\nfour five six.\n\nOther.\n';
    const diff = presentDiff(parsePatch(diffTexts(oldP, newP)), true);
    const html = render(newP, { diff, inlineDiff: true, ignoreWhitespace: true });
    expect(html).toMatch(/<p[^>]*class="mdr-reflow"/);
    expect(html).not.toMatch(/mdr-mod|mdr-added|<del/);
  });
});

describe('changes-only folding', () => {
  const base = Array.from({ length: 12 }, (_, i) => `Paragraph number ${i + 1}.`).join('\n\n') + '\n';
  const head = base.replace('Paragraph number 8.', 'Paragraph number eight.');
  it('folds runs of unchanged blocks but keeps headings and context', () => {
    const src = '# Title\n\n' + head;
    const html = render(src, { diff: parsePatch(diffTexts('# Title\n\n' + base, src)), inlineDiff: true, fold: true });
    expect(html).toContain('<h1');
    expect(html).toMatch(/⋯ 6 unchanged blocks/);
    expect(html).toMatch(/⋯ 3 unchanged blocks/);
    expect(html).toContain('Paragraph number 7.');
    expect(html).toContain('Paragraph number 9.');
    expect(html).not.toContain('Paragraph number 2.');
  });
  it('does nothing without changes', () => {
    expect(render(base, { diff: parsePatch(''), fold: true })).not.toContain('mdr-fold');
  });
});

describe('word diff of rewritten phrases', () => {
  it('shows a rewritten phrase as one deletion and one insertion, not alternating words', () => {
    const html = withDiff(
      'The service retries failed requests up to three times before giving up.\n',
      'The service now retries each failed request up to five times, then reports an error.\n',
    );
    expect(html).toContain('times<del class="mdr-d-del"> before giving up</del><ins class="mdr-d-ins">, then reports an error</ins>.');
    expect(html).toContain('up to <del class="mdr-d-del">three</del><ins class="mdr-d-ins">five</ins> times');
    const cell = withDiff('| Option | Meaning |\n|---|---|\n| retries | How many times a failed call is retried |\n', '| Option | Meaning |\n|---|---|\n| retries | Maximum number of attempts for each failed call |\n');
    expect(cell).toContain('<del class="mdr-d-del">How many times a failed call is retried</del><ins class="mdr-d-ins">Maximum number of attempts for each failed call</ins>');
  });

  it('keeps changes apart when real words between them stayed', () => {
    const html = withDiff('The cat sat on the mat.\n', 'The dog sat on the rug.\n');
    expect(html).toContain('The <del class="mdr-d-del">cat</del><ins class="mdr-d-ins">dog</ins> sat on the <del class="mdr-d-del">mat</del><ins class="mdr-d-ins">rug</ins>.');
    expect(markdownDiffSource('Requires Node v18.2.0 or newer.', 'Requires Node v20.10.1 or newer.')).toBe('Requires Node ⸟v18.2.0⸪⸛v20.10.1⸞ or newer.');
  });

  it('never repeats Markdown syntax or a line break on both sides of a merged change', () => {
    expect(markdownDiffSource('**Note:** old', '**Warning:** new')).toBe('**⸟Note⸪⸛Warning⸞:** ⸟old⸪⸛new⸞');
    expect(markdownDiffSource('one\n\ntwo', 'uno\n\ndos')).toBe('⸟one⸪⸛uno⸞\n\n⸟two⸪⸛dos⸞');
  });

  it('leaves two deletions or two insertions apart', () => {
    const pieces = [{ value: 'a', removed: true }, { value: ' ' }, { value: 'b', removed: true }];
    expect(joinChanges(pieces)).toEqual(pieces);
    expect(joinChanges([{ value: 'a', removed: true }, { value: 'b', added: true }, { value: ' ' }, { value: 'c', removed: true }, { value: 'd', added: true }])).toEqual([
      { value: 'a c', removed: true },
      { value: 'b d', added: true },
    ]);
  });
});

describe('word diff of formatting changes', () => {
  it('shows removed emphasis as the old formatted words struck out, not as still formatted', () => {
    const html = withDiff('Run the migration **before** deploying.\n', 'Run the migration before deploying.\n');
    expect(html).toContain('Run the migration <strong><del class="mdr-d-del">before</del></strong><ins class="mdr-d-ins">before</ins> deploying.');
  });

  it('marks added emphasis and a changed kind of emphasis', () => {
    expect(withDiff('Run the migration before deploying.\n', 'Run the migration **before** deploying.\n')).toContain(
      'Run the migration <del class="mdr-d-del">before</del><strong><ins class="mdr-d-ins">before</ins></strong> deploying.',
    );
    const html = withDiff('This is *important* to know.\n', 'This is **important** to know.\n');
    expect(html).toContain('This is <em><del class="mdr-d-del">important</del></em><strong><ins class="mdr-d-ins">important</ins></strong> to know.');
    expect(html).not.toContain('*');
  });

  it('keeps underscore emphasis intact when a word at its edge changes', () => {
    const html = withDiff('Note: _do not edit this file_ by hand.\n', 'Note: _do not edit this config_ by hand.\n');
    expect(html).toContain('<em>do not edit this <del class="mdr-d-del">file</del><ins class="mdr-d-ins">config</ins></em> by hand.');
    expect(markdownDiffSource('Set my_var here', 'Set my_value here')).toBe('Set ⸟my_var⸪⸛my_value⸞ here');
  });

  it('shows emphasis stretched over more words as the whole span replaced', () => {
    expect(markdownDiffSource('x **a** b c d', 'x **a b** c d')).toBe('x ⸟**a** b⸪⸛**a b**⸞ c d');
    expect(markdownDiffSource('Compute 2 * 3 now', 'Compute 2 * 4 now')).toBe('Compute 2 * ⸟3⸪⸛4⸞ now');
  });
});

describe('word diff of references to the rest of the file', () => {
  it('renders reference-style links and footnotes in a changed paragraph', () => {
    const html = withDiff(
      'See the [setup guide][setup] and the note[^1] for details.\n\n[setup]: ./setup.md\n\n[^1]: Mostly.\n',
      'See the [setup guide][setup] and the note[^1] for more details.\n\n[setup]: ./setup.md\n\n[^1]: Mostly.\n',
    );
    const p = /<p[^>]*mdr-inline[^>]*>([\s\S]*?)<\/p>/.exec(html)![1];
    expect(p).toMatch(/<a href="\.\/setup\.md"[^>]*>setup guide<\/a>/);
    expect(p).toMatch(/<sup><a [^>]*href="#fn-1"[^>]*>1<\/a><\/sup>/);
    expect(p).not.toContain('[^1]');
    expect(p).not.toContain('Mostly');
  });

  it('numbers a footnote as the file does and links a deleted reference to its old target', () => {
    const notes = withDiff('First[^a] para.\n\nSecond[^b] para.\n\n[^a]: A.\n[^b]: B.\n', 'First[^a] para.\n\nSecond[^b] para changed.\n\n[^a]: A.\n[^b]: B.\n');
    expect(notes).toMatch(/Second<sup><a [^>]*href="#fn-b"[^>]*>2<\/a><\/sup>/);
    const html = withDiff('Use [old][o] here.\n\n[o]: ./old.md\n', 'Use [new][n] here.\n\n[n]: ./new.md\n');
    expect(html).toContain('<a href="./old.md" target="_blank" rel="noopener noreferrer"><del class="mdr-d-del">old</del></a>');
    expect(html).toContain('<a href="./new.md" target="_blank" rel="noopener noreferrer"><ins class="mdr-d-ins">new</ins></a>');
  });

  it('shows a changed footnote without its label', () => {
    const html = withDiff('Note[^1] here.\n\n[^1]: The old note.\n', 'Note[^1] here.\n\n[^1]: The new note.\n');
    expect(html).toMatch(/<p[^>]*mdr-inline[^>]*><span class="mdr-worddiff mdr-worddiff-md">The <del class="mdr-d-del">old<\/del><ins class="mdr-d-ins">new<\/ins> note\./);
  });
});

describe('word diff of task lists', () => {
  it('shows a ticked checkbox as the old box struck out and the new one added', () => {
    const html = withDiff('- [ ] Write tests\n- [ ] Update docs\n', '- [x] Write tests\n- [ ] Update docs\n');
    expect(html).toContain(
      '<span class="mdr-worddiff"><del class="mdr-d-del"><input type="checkbox" disabled=""/></del><ins class="mdr-d-ins"><input type="checkbox" disabled="" checked=""/></ins></span> <span class="mdr-worddiff mdr-worddiff-md">Write tests</span>',
    );
  });

  it('keeps the checkbox of a task whose text changed', () => {
    const html = withDiff('- [x] Write tests\n', '- [x] Write unit tests\n');
    expect(html).toMatch(/<li[^>]*mdr-inline[^>]*><input type="checkbox" disabled="" checked=""\/> <span class="mdr-worddiff mdr-worddiff-md">Write <ins class="mdr-d-ins">unit <\/ins>tests/);
  });
});

describe('word diff of line breaks, emoji, URLs and entities', () => {
  it('keeps hard line breaks', () => {
    for (const brk of ['\\', '  ']) {
      const html = withDiff(`ACME Corp.${brk}\nMain Street 1${brk}\nWarsaw\n`, `ACME Corp.${brk}\nMain Street 12${brk}\nWarsaw\n`);
      expect(html).toContain('ACME Corp.<br/>Main Street <del class="mdr-d-del">1</del><ins class="mdr-d-ins">12</ins><br/>Warsaw</span>');
    }
  });

  it('shows a changed emoji as emoji', () => {
    expect(withDiff('Ship it :tada: today.\n', 'Ship it :rocket: today.\n')).toContain('Ship it <del class="mdr-d-del">🎉</del><ins class="mdr-d-ins">🚀</ins> today.');
  });

  it('links a changed bare URL to itself, not to a mix of both', () => {
    const html = withDiff('Docs: https://example.com/v1/guide here.\n', 'Docs: https://example.com/v2/guide here.\n');
    expect(html).toContain('<a href="https://example.com/v1/guide" target="_blank" rel="noopener noreferrer"><del class="mdr-d-del">https://example.com/v1/guide</del></a>');
    expect(html).toContain('<a href="https://example.com/v2/guide" target="_blank" rel="noopener noreferrer"><ins class="mdr-d-ins">https://example.com/v2/guide</ins></a>');
    const www = withDiff('See www.example.com/a now.\n', 'See www.example.com/b now.\n');
    expect(www).toContain('<a href="http://www.example.com/b" target="_blank" rel="noopener noreferrer"><ins class="mdr-d-ins">www.example.com/b</ins></a>');
    expect(html + www).not.toContain('%E2%B8');
  });

  it('keeps HTML entities whole', () => {
    expect(markdownDiffSource('Press Ctrl&nbsp;+&nbsp;C', 'Press Cmd&nbsp;+&nbsp;C')).toBe('Press ⸟Ctrl⸪⸛Cmd⸞&nbsp;+&nbsp;C');
    expect(markdownDiffSource('a&nbsp;b', 'a&ensp;b')).toBe('a⸟&nbsp;⸪⸛&ensp;⸞b');
  });
});

describe('word diff details', () => {
  it('keeps the ± badge, for what a word diff cannot show (a link\'s new target)', () => {
    const html = withDiff('Read [the guide](guide.md) first.\n', 'Read [the guide](setup.md) first.\n');
    expect(html).toMatch(/<p[^>]*mdr-inline[\s\S]*mdr-badge-mod/);
  });

  it('marks a replaced image as removed and added', () => {
    const html = withDiff('See ![old](a.png) here.\n', 'See ![new](b.png) here.\n');
    expect(html).toMatch(/<del class="mdr-d-del"><img src="a.png" alt="old"\/><\/del>/);
    expect(html).toMatch(/<ins class="mdr-d-ins"><img src="b.png" alt="new"\/><\/ins>/);
  });
  it('diffs CJK text word by word, not sentence by sentence', () => {
    const html = withDiff('這是一個測試文件。\n', '這是一個重要文件。\n');
    expect(html).toMatch(/<del class="mdr-d-del">測試<\/del>/);
    expect(html).toMatch(/<ins class="mdr-d-ins">重要<\/ins>/);
  });
  it('keeps inline HTML whole in a word diff', () => {
    const html = withDiff('Press <kbd>Ctrl</kbd> now.\n', 'Press <kbd>Cmd</kbd> now.\n');
    expect(html).toMatch(/<kbd><del class="mdr-d-del">Ctrl<\/del><ins class="mdr-d-ins">Cmd<\/ins><\/kbd>/);
  });
});

describe('word diff of math and removed rows', () => {
  it('marks a changed inline formula as a whole', () => {
    const html = withDiff('Time is $t = d + 1$ days.\n', 'Time is $t = d + 2$ days.\n');
    expect(html).toMatch(/<del class="mdr-d-del"><code class="mdr-math-src">t = d \+ 1<\/code><\/del>/);
    expect(html).toMatch(/<ins class="mdr-d-ins"><code class="mdr-math-src">t = d \+ 2<\/code><\/ins>/);
  });
  it('shows a removed row as plain struck text, not as an insertion', () => {
    const t = '| A | B |\n|---|---|\n| one | 1 |\n| two | 2 |\n';
    const html = withDiff(t, t.replace('| two | 2 |\n', ''));
    const row = /<tr class="mdr-removed-row"[\s\S]*?<\/tr>/.exec(html)![0];
    expect(row).toContain('two');
    expect(row).not.toContain('mdr-d-ins');
  });
});
