import type { Heading, Nodes, Root } from 'mdast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGemoji from 'remark-gemoji';
import { visit } from 'unist-util-visit';
import { slugger } from './gfm';
import type { DiffInfo } from './patch';

/** Parses Markdown the way the document view does (without the HTML step), for outline and checks. */
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml', 'toml']).use(remarkGemoji);

export function parseMarkdown(source: string): Root {
  return parser.runSync(parser.parse(source)) as Root;
}

export const mdText = (n: Nodes): string =>
  'value' in n && typeof n.value === 'string' && n.type !== 'html' ? n.value : 'children' in n ? (n.children as Nodes[]).map(mdText).join('') : '';

export interface OutlineItem {
  depth: number;
  text: string;
  /** GitHub heading id (what #fragment links use). */
  id: string;
  line: number;
  /** Last line of the heading's own content (up to the next heading of any level). */
  end: number;
  /** What happened in that content in this PR. */
  change: 'added' | 'changed' | 'moved' | null;
  /** Unresolved conversations and drafts in that content. */
  comments: number;
}

/** The headings of a document, with the changes and comments of each section. */
export function outlineOf(tree: Root, lines: string[], diff: DiffInfo | null, commentLines: number[]): OutlineItem[] {
  const lineCount = lines.length;
  const slug = slugger();
  const heads: { depth: number; text: string; id: string; line: number }[] = [];
  visit(tree, 'heading', (h: Heading) => {
    const text = mdText(h).trim();
    if (!h.position) return;
    heads.push({ depth: h.depth, text, id: slug(text), line: h.position.start.line });
  });
  return heads.map((h, i) => {
    const end = (heads[i + 1]?.line ?? lineCount + 1) - 1;
    const inside = (l: number) => l >= h.line && l <= end;
    let change: OutlineItem['change'] = null;
    if (diff) {
      const added = [...diff.added].filter((l) => inside(l) && (lines[l - 1] ?? '').trim());
      // Lines really deleted here (a pure deletion sits right after the line before it), not moved away.
      const removed = diff.removals.some((r) => {
        if (!inside(r.replacedBy ? r.replacedBy.start : r.anchor - 1)) return false;
        const moved = (r.moved ?? []).reduce((n, m) => n + m.to - m.from, 0);
        return r.lines.filter((x) => x.trim()).length > moved;
      });
      if (diff.added.has(h.line) && !diff.moved.has(h.line) && !removed) change = 'added';
      else if (removed || added.some((l) => !diff.moved.has(l))) change = 'changed';
      else if (added.length) change = 'moved';
    }
    return { ...h, end, change, comments: commentLines.filter(inside).length };
  });
}
