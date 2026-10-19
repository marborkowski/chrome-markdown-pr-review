import type { ElementContent, Root } from 'hast';
import { Diff } from 'diff';
import { SKIP, visit } from 'unist-util-visit';
import type { Removal } from './patch';

/**
 * Old and new source of the head-file lines [start, end] of a block: every change that
 * begins inside the range is swapped back to its removed lines in the old version, so
 * unchanged lines of the block are kept on both sides.
 */
export function blockDiffSource(lines: string[], removals: Removal[], start: number, end: number) {
  const replacedAt = new Map<number, number>();
  const removedBefore = new Map<number, number[]>();
  removals.forEach((r, i) => {
    if (r.replacedBy) {
      if (r.replacedBy.start >= start && r.replacedBy.start <= end) replacedAt.set(r.replacedBy.start, i);
    } else if (r.anchor > start && r.anchor <= end) {
      removedBefore.set(r.anchor, [...(removedBefore.get(r.anchor) ?? []), i]);
    }
  });
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const used = new Set<number>();
  for (let ln = start; ln <= end; ) {
    for (const i of removedBefore.get(ln) ?? []) {
      oldLines.push(...removals[i].lines);
      used.add(i);
    }
    const i = replacedAt.get(ln);
    if (i === undefined) {
      oldLines.push(lines[ln - 1] ?? '');
      newLines.push(lines[ln - 1] ?? '');
      ln++;
      continue;
    }
    oldLines.push(...removals[i].lines);
    used.add(i);
    for (const stop = Math.min(removals[i].replacedBy!.end, end); ln <= stop; ln++) newLines.push(lines[ln - 1] ?? '');
  }
  return { oldText: oldLines.join('\n'), newText: newLines.join('\n'), used };
}

// ---------------------------------------------------------------------------
// Word diff rendered as Markdown: the diff is computed on source text, ins/del regions are
// marked with sentinel characters, the merged text is rendered as Markdown and the sentinels
// are turned into <ins>/<del> afterwards. Formatting (code, emphasis, links) survives.
// ---------------------------------------------------------------------------

// Rare Unicode punctuation: Markdown treats them like punctuation, so emphasis next to them still works.
const INS_START = '⸛';
const INS_END = '⸞';
const DEL_START = '⸟';
const DEL_END = '⸪';
const SENTINELS = /([⸛⸞⸟⸪])/;
const SENTINELS_ALL = /[⸛⸞⸟⸪]/g;

/** Words, whitespace and punctuation, but code spans and links are kept whole so the diff never splits their syntax. */
const MD_TOKEN = /`+[^`\n]+?`+|!?\[[^\]\n]*\](?:\([^)\n]*\)|\[[^\]\n]*\])|<https?:[^>\s]+>|[\p{L}\p{M}\p{N}_]+|\s+|[^\s]/gu;

class MarkdownTokenDiff extends Diff<string, string> {
  tokenize(value: string) {
    return value.match(MD_TOKEN) ?? [];
  }
}
const tokenDiff = new MarkdownTokenDiff();

export function diffMarkdownWords(oldText: string, newText: string) {
  return tokenDiff.diff(oldText.replace(SENTINELS_ALL, ''), newText.replace(SENTINELS_ALL, ''));
}

/** Merged Markdown source with sentinel-marked insertions and deletions. */
export function markdownDiffSource(oldText: string, newText: string): string {
  return diffMarkdownWords(oldText, newText)
    .map((p) => (p.added ? INS_START + p.value + INS_END : p.removed ? DEL_START + p.value + DEL_END : p.value))
    .join('');
}

/** rehype plugin: keep paragraphs apart once unwrapped, and turn sentinel regions into <ins>/<del>. */
export function rehypeDiffMarks() {
  return (tree: Root) => {
    const blocks = tree.children.filter((n) => n.type !== 'text' || n.value.trim());
    tree.children = blocks.flatMap((n, i) => (i ? [{ type: 'text' as const, value: '\n\n' }, n] : [n]));

    let state: 'ins' | 'del' | null = null;
    visit(tree, 'text', (node, index, parent) => {
      if (!parent || index === undefined) return;
      if (!state && !SENTINELS.test(node.value)) return;
      const out: ElementContent[] = [];
      for (const s of node.value.split(SENTINELS)) {
        if (s === INS_START) state = 'ins';
        else if (s === DEL_START) state = 'del';
        else if (s === INS_END || s === DEL_END) state = null;
        else if (s) {
          out.push(
            state
              ? { type: 'element', tagName: state, properties: { className: [`mdr-d-${state}`] }, children: [{ type: 'text', value: s }] }
              : { type: 'text', value: s },
          );
        }
      }
      parent.children.splice(index, 1, ...(out as any[]));
      return [SKIP, index + out.length];
    });
  };
}
