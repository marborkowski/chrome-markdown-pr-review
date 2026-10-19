import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownDoc, type MarkdownDocProps } from '../src/content/components/MarkdownDoc';
import { diffTexts, parsePatch, presentDiff } from '../src/content/lib/patch';

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

describe('word diff details', () => {
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
