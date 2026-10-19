import type { BlockContent, Blockquote, Code, Paragraph, Parent, Root, RootContent, Text } from 'mdast';
import type { Point, Position } from 'unist';

/**
 * Admonitions of documentation sites, which GitHub shows as plain text but a docs reviewer wants
 * to see the way the site renders them:
 *
 *   :::warning[Optional title]        (Docusaurus, also `:::warning Optional title`)
 *   Content
 *   :::
 *
 *   !!! warning "Optional title"      (MkDocs Material / Python-Markdown; ??? and ???+ collapsible)
 *       Content, indented four spaces
 *
 * They become callouts (rendered like GitHub alerts). Positions are kept exact, so comments and
 * change markers inside an admonition land on the right source lines.
 */

/** Admonition types → the GitHub alert colour that matches them best. */
const KINDS: Record<string, string> = {
  note: 'note', info: 'note', abstract: 'note', summary: 'note', tldr: 'note', todo: 'note', example: 'note', quote: 'note', cite: 'note', seealso: 'note',
  tip: 'tip', hint: 'tip', success: 'tip', check: 'tip', done: 'tip',
  important: 'important', question: 'important', help: 'important', faq: 'important', attention: 'important',
  warning: 'warning', caution: 'warning',
  danger: 'caution', error: 'caution', failure: 'caution', fail: 'caution', missing: 'caution', bug: 'caution',
};

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const DOCUSAURUS_OPEN = /^(:{3,})([a-zA-Z]+)(?:\[([^\]\n]*)\]| +([^\n{]*?))?(?:\{[^}\n]*\})?[ \t]*$/;
const MKDOCS_OPEN = /^(?:!!!|\?\?\?\+?)[ \t]+([a-zA-Z][\w-]*)(?:[ \t]+"([^"\n]*)")?[ \t]*$/;

/** The plain text of a paragraph's first line, when it is plain text (the only thing these syntaxes start with). */
function firstLine(p: RootContent | undefined): string | null {
  if (p?.type !== 'paragraph') return null;
  const t = p.children[0];
  if (t?.type !== 'text') return null;
  const nl = t.value.indexOf('\n');
  if (nl < 0 && p.children.length > 1) return null;
  return nl < 0 ? t.value : t.value.slice(0, nl);
}

function lastLine(p: RootContent | undefined): string | null {
  if (p?.type !== 'paragraph') return null;
  const t = p.children[p.children.length - 1];
  if (t?.type !== 'text') return null;
  const nl = t.value.lastIndexOf('\n');
  if (nl < 0 && p.children.length > 1) return null;
  return nl < 0 ? t.value : t.value.slice(nl + 1);
}

/** Points by line, with the offsets unified's tools expect. */
interface Points {
  start: (line: number) => Point;
  end: (line: number) => Point;
}

/** The paragraph without its first line; null when nothing is left. */
function dropFirstLine(p: Paragraph, at: Points): Paragraph | null {
  const t = p.children[0] as Text;
  const nl = t.value.indexOf('\n');
  if (nl < 0) return null;
  const rest: Text = { ...t, value: t.value.slice(nl + 1) };
  if (!p.position) return { ...p, children: [rest, ...p.children.slice(1)] };
  const start = at.start(p.position.start.line + 1);
  if (rest.position) rest.position = { ...rest.position, start };
  return { ...p, children: [rest, ...p.children.slice(1)], position: { ...p.position, start } };
}

/** The paragraph without its last line; null when nothing is left. */
function dropLastLine(p: Paragraph, at: Points): Paragraph | null {
  const t = p.children[p.children.length - 1] as Text;
  const nl = t.value.lastIndexOf('\n');
  if (nl < 0) return null;
  const rest: Text = { ...t, value: t.value.slice(0, nl) };
  if (!p.position) return { ...p, children: [...p.children.slice(0, -1), rest] };
  const end = at.end(p.position.end.line - 1);
  if (rest.position) rest.position = { ...rest.position, end };
  return { ...p, children: [...p.children.slice(0, -1), rest], position: { ...p.position, end } };
}

function callout(kind: string, title: string | undefined, children: RootContent[], position: Position | undefined): Blockquote {
  return {
    type: 'blockquote',
    children: children as BlockContent[],
    position,
    data: { hName: 'div', hProperties: { dataCallout: KINDS[kind.toLowerCase()], dataCalloutTitle: title?.trim() || titleCase(kind) } },
  };
}

const span = (a: RootContent | undefined, b: RootContent | undefined): Position | undefined =>
  a?.position && b?.position ? { start: a.position.start, end: b.position.end } : undefined;

/** Offsets of each line start, to recompute offsets of re-parsed content. */
function lineStarts(src: string) {
  const out = [0, 0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') out.push(i + 1);
  return out;
}

export function remarkAdmonitions(this: any) {
  const parse = (text: string) => this.parse(text) as Root;
  return (tree: Root, file: { value?: unknown }) => {
    const src = String(file.value ?? '');
    const starts = lineStarts(src);
    const at: Points = {
      start: (line) => ({ line, column: 1, offset: starts[line] ?? src.length }),
      end: (line) => {
        const offset = Math.max(starts[line] ?? 0, (starts[line + 1] ?? src.length + 1) - 1);
        return { line, column: offset - (starts[line] ?? 0) + 1, offset };
      },
    };

    /** Re-parse the indented body of a MkDocs admonition and move its positions to where it sits in the file. */
    const body = (code: Code): RootContent[] => {
      const root = parse(code.value);
      const dl = (code.position?.start.line ?? 1) - 1;
      const shift = (pt: Point): Point => {
        const line = pt.line + dl;
        const column = pt.column + 4;
        return { line, column, offset: (starts[line] ?? 0) + column - 1 };
      };
      const walk = (n: any) => {
        if (n.position) n.position = { start: shift(n.position.start), end: shift(n.position.end) };
        n.children?.forEach(walk);
      };
      root.children.forEach(walk);
      transform(root);
      return root.children;
    };

    /** An indented (not fenced) code block: how Markdown parses an admonition's body after a blank line. */
    const isIndented = (n: RootContent | undefined): n is Code => {
      if (n?.type !== 'code' || n.lang || !n.position) return false;
      const line = n.position.start.line;
      return /^(?: {4}|\t)/.test(src.slice(starts[line] ?? 0, starts[line + 1] ?? src.length));
    };

    function transform(parent: Parent) {
      const kids = parent.children as RootContent[];
      for (let i = 0; i < kids.length; i++) {
        const head = firstLine(kids[i]);
        if (head === null) continue;

        const d = DOCUSAURUS_OPEN.exec(head);
        if (d && KINDS[d[2].toLowerCase()]) {
          const colons = d[1].length;
          const closes = (l: string | null) => l !== null && new RegExp(`^:{${colons}}[ \\t]*$`).test(l);
          const open = kids[i] as Paragraph;
          const rest = dropFirstLine(open, at);
          // `:::note\ntext\n:::` without blank lines is a single paragraph.
          if (rest && closes(lastLine(rest))) {
            const inner = dropLastLine(rest, at);
            kids.splice(i, 1, callout(d[2], d[3] ?? d[4], inner ? [inner] : [], open.position));
            continue;
          }
          let j = i + 1;
          while (j < kids.length && !closes(lastLine(kids[j]))) j++;
          if (j >= kids.length) continue; // never closed: leave it as text
          const close = kids[j] as Paragraph;
          const before = firstLine(close) === lastLine(close) ? null : dropLastLine(close, at);
          const inner = [...(rest ? [rest] : []), ...kids.slice(i + 1, j), ...(before ? [before] : [])];
          const node = callout(d[2], d[3] ?? d[4], inner, span(open, close));
          transform(node);
          kids.splice(i, j - i + 1, node);
          continue;
        }

        const m = MKDOCS_OPEN.exec(head);
        if (m && KINDS[m[1].toLowerCase()]) {
          const open = kids[i] as Paragraph;
          const rest = dropFirstLine(open, at);
          const inner: RootContent[] = rest ? [rest] : [];
          let last: RootContent = open;
          let n = 1;
          if (isIndented(kids[i + 1])) {
            last = kids[i + 1];
            inner.push(...body(kids[i + 1] as Code));
            n = 2;
          }
          if (!inner.length) continue;
          kids.splice(i, n, callout(m[1], m[2], inner, span(open, last)));
          continue;
        }
      }
      for (const k of kids) if ('children' in k && k.type !== 'paragraph') transform(k as Parent);
    }

    transform(tree);
  };
}

/**
 * MDX files start with `import` / `export` lines that the site build consumes; as Markdown they
 * would read as a paragraph of code-ish prose. Show them as a dimmed code block instead, like
 * front matter. (JSX components inside the document render as their text content.)
 */
const ESM = /^\s*(?:import\s+(?:[\w$*{}\s,]+\s+from\s+)?['"{]|import\s+[\w$]+\s*,|export\s+(?:const|let|var|function|class|default|async|\{|\*))/;

export function remarkMdxEsm() {
  return (tree: Root, file: { value?: unknown }) => {
    const src = String(file.value ?? '');
    tree.children = tree.children.map((n) => {
      if (n.type !== 'paragraph' || !n.position) return n;
      const raw = src.slice(n.position.start.offset ?? 0, n.position.end.offset ?? 0);
      const ls = raw.split('\n');
      // ESM statements, possibly spread over lines (`import {\n  a,\n} from 'x';`).
      if (!ESM.test(ls[0]) || !ls.every((l) => ESM.test(l) || /^\s*(?:[\w$]+(?:\s+as\s+[\w$]+)?,?|\}.*)\s*$/.test(l) || !l.trim())) return n;
      // Rendered by the `esm` handler of remark-rehype (like front matter).
      return { type: 'esm', value: raw, position: n.position } as unknown as RootContent;
    });
  };
}
