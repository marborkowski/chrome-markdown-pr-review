/**
 * Turn a selection into the text quoted in a comment. Unlike Selection.toString(), deleted
 * words of a word diff (<del>) keep their strikethrough: as GFM ~~text~~, or, inside code
 * (where GFM markup wouldn't render), as Unicode combining strokes.
 */

const BLOCK = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE', 'TR', 'TABLE', 'HR', 'DT', 'DD', 'SECTION', 'ARTICLE', 'DETAILS', 'SUMMARY']);
/** Table cells are separated like in a Markdown row. */
const CELL = new Set(['TD', 'TH']);
const STROKE = '̶';

/** Strike every character of `s` with U+0336 (what "strikethrough text" generators do). */
export const strikeUnicode = (s: string) => [...s].map((ch) => (/\s/.test(ch) ? ch : ch + STROKE)).join('');

/** Wrap each non-blank line in ~~ ~~, keeping surrounding whitespace outside the markers. */
export const strikeMarkdown = (s: string) =>
  s
    .split('\n')
    .map((l) => l.replace(/^(\s*)(.*?)(\s*)$/, (_, a: string, b: string, c: string) => (b ? `${a}~~${b}~~${c}` : a + c)))
    .join('\n');

const elOf = (n: Node): Element | null => (n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement);

function serialize(node: Node, inCode: boolean, out: string[]) {
  if (node.nodeType === Node.TEXT_NODE) {
    out.push(node.textContent ?? '');
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
  const el = node as Element;
  if (el.nodeType === Node.ELEMENT_NODE) {
    // SVG elements keep a lowercase tagName, so match on localName: mermaid's <style> / markers aren't text.
    if (['style', 'script', 'title', 'desc', 'defs', 'annotation'].includes(el.localName)) return;
    // UI chrome, and the old version of a changed formula
    if (el.matches('.mdr-gutter, .mdr-mermaid-bar, .mdr-mermaid-caption, .mdr-mermaid-loading, .mdr-banner, .mdr-img-bar, .mdr-fold-toggle, .mdr-removed-head, .mdr-math-old')) return;
    // A formula is quoted as its TeX, not as the characters MathML spreads over many elements.
    const tex = el.getAttribute('data-tex');
    if (tex !== null && el.classList.contains('mdr-math')) {
      out.push(el.classList.contains('mdr-math-display') ? `\n$$${tex}$$\n` : `$${tex}$`);
      return;
    }
    if (el.tagName === 'IMG') return void out.push((el as HTMLImageElement).alt ? `[image: ${(el as HTMLImageElement).alt}]` : '[image]');
    if (el.tagName === 'BR') return void out.push('\n');
    if (el.tagName === 'DEL') {
      const inner: string[] = [];
      for (const c of el.childNodes) serialize(c, inCode, inner);
      out.push((inCode ? strikeUnicode : strikeMarkdown)(inner.join('')));
      return;
    }
    if (el.tagName === 'CODE' || el.tagName === 'PRE') inCode = true;
  }
  const block = el.nodeType === Node.ELEMENT_NODE && BLOCK.has(el.tagName);
  if (block) out.push('\n');
  if (el.nodeType === Node.ELEMENT_NODE && CELL.has(el.tagName) && el.previousElementSibling) out.push(' | ');
  for (const c of el.childNodes) serialize(c, inCode, out);
  if (block) out.push('\n');
}

export function rangeToQuote(range: Range): string {
  const base = elOf(range.commonAncestorContainer);
  // A selection entirely inside one <del> has no <del> in its cloned contents.
  const del = base?.closest('del');
  const inCode = !!base?.closest('code, pre');
  const parts: string[] = [];
  serialize(range.cloneContents(), inCode, parts);
  let text = parts.join('').replace(/\n{3,}/g, '\n\n').trim();
  if (del && text) text = (inCode ? strikeUnicode : strikeMarkdown)(text);
  return text;
}
