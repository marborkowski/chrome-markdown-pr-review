import type { Heading, Html, Image, Link, Nodes, Root, Text } from 'mdast';
import { visit, SKIP } from 'unist-util-visit';
import { sanitizeSchema, slugger } from './gfm';
import { mdText } from './outline';
import type { DiffInfo } from './patch';

/**
 * Review checks: things a docs reviewer would otherwise have to catch by eye. Each is precise
 * enough to be worth a look; by default only findings on lines this PR touched are shown.
 */

export type CheckKind = 'anchor' | 'file' | 'image' | 'alt' | 'heading' | 'repeat' | 'syntax' | 'html' | 'todo';

export interface Finding {
  kind: CheckKind;
  line: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
  /** On a line added or changed in this PR. */
  changed: boolean;
  /** The link or image target, as written (for marking it in the document). */
  url?: string;
}

/** A relative link resolved against the file's folder: a repository path (and #fragment), or null for absolute URLs and in-page anchors. */
export function repoTarget(filePath: string, url: string): { path: string; hash: string } | null {
  if (!url || url.startsWith('#') || url.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  const [pathPart, hash = ''] = url.split('#');
  let clean = pathPart.split('?')[0];
  try {
    clean = decodeURIComponent(clean);
  } catch { /* keep as written */ }
  const parts = clean.startsWith('/') ? [] : filePath.split('/').slice(0, -1);
  for (const seg of clean.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return { path: parts.join('/'), hash };
}

/** Ids a #fragment can point at in a document: GitHub heading slugs, footnotes, and ids / names in its HTML. */
export function anchorsOf(tree: Root): Set<string> {
  const ids = new Set<string>();
  const slug = slugger();
  visit(tree, (n: Nodes) => {
    if (n.type === 'heading') ids.add(slug(mdText(n as Heading).trim()));
    else if (n.type === 'footnoteDefinition') {
      ids.add(`fn-${n.identifier}`);
      ids.add(`user-content-fn-${n.identifier}`);
    } else if (n.type === 'html') {
      for (const m of n.value.matchAll(/\s(?:id|name)\s*=\s*["']?([^"'\s>]+)/gi)) ids.add(m[1]);
    }
  });
  return ids;
}

const ALLOWED = new Set(sanitizeSchema.tagNames ?? []);
const ATTRS = new Set(
  Object.values(sanitizeSchema.attributes ?? {})
    .flat()
    .map((a) => String(Array.isArray(a) ? a[0] : a))
    // hast property names → HTML attribute names
    .map((a) => (a === 'htmlFor' ? 'for' : a === 'acceptCharset' ? 'accept-charset' : a.startsWith('data') ? a.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()) : a.toLowerCase())),
);
const IGNORED_ATTRS = new Set(['class', 'style']);
const REPEAT_OK = new Set(['that', 'had', 'bye', 'no', 'very', 'so', 'ha', 'la']);

export interface CheckInput {
  tree: Root;
  path: string;
  diff: DiffInfo | null;
  /** Repository paths (files and folders) of the head commit; undefined while unknown. */
  paths?: Set<string>;
  /** Anchors of other Markdown files of the PR that are loaded, by path. */
  anchorsIn?: Map<string, Set<string>>;
}

export function runChecks({ tree, path, diff, paths, anchorsIn }: CheckInput): Finding[] {
  const out: Finding[] = [];
  const changedLines = new Set(diff?.added ?? []);
  const changed = (line: number) => changedLines.has(line);
  const add = (kind: CheckKind, node: Nodes, severity: Finding['severity'], message: string, url?: string) => {
    const line = node.position?.start.line ?? 0;
    const end = node.position?.end.line ?? line;
    let touched = false;
    for (let l = line; l <= end && !touched; l++) touched = changed(l);
    out.push({ kind, line, message, severity, changed: touched, url });
  };
  const ids = anchorsOf(tree);

  const checkTarget = (node: Link | Image, isImage: boolean) => {
    const url = node.url;
    if (url.startsWith('#')) {
      const frag = url.slice(1);
      let id = frag;
      try {
        id = decodeURIComponent(frag);
      } catch { /* keep */ }
      if (frag && !ids.has(id) && !ids.has(id.replace(/^user-content-/, ''))) add('anchor', node, 'error', `No heading or anchor “#${id}” in this document`, url);
      return;
    }
    const t = repoTarget(path, url);
    if (!t) return;
    if (paths && t.path && !paths.has(t.path) && !paths.has(t.path.replace(/\/$/, ''))) {
      add(isImage ? 'image' : 'file', node, 'error', `${isImage ? 'Image' : 'Link target'} “${t.path}” doesn't exist in this branch`, url);
      return;
    }
    const other = anchorsIn?.get(t.path);
    if (t.hash && other && !other.has(t.hash) && !other.has(t.hash.replace(/^user-content-/, ''))) {
      add('anchor', node, 'error', `No heading “#${t.hash}” in ${t.path}`, url);
    }
  };

  let lastDepth = 0;
  visit(tree, (node: Nodes) => {
    switch (node.type) {
      case 'code':
      case 'inlineCode':
      case 'yaml':
        return SKIP;
      case 'link':
        checkTarget(node, false);
        break;
      case 'image':
        checkTarget(node, true);
        if (!node.alt?.trim()) add('alt', node, 'warning', 'Image has no alt text (screen readers announce just the file name)');
        break;
      case 'heading':
        if (lastDepth && node.depth > lastDepth + 1) add('heading', node, 'warning', `Heading level jumps from H${lastDepth} to H${node.depth}`);
        lastDepth = node.depth;
        break;
      case 'text': {
        const t = (node as Text).value;
        for (const m of t.matchAll(/(?<![\p{L}\p{N}])(\p{L}+)\s+\1(?![\p{L}\p{N}])/giu)) {
          if (!REPEAT_OK.has(m[1].toLowerCase())) add('repeat', node, 'warning', `Repeated word “${m[0].replace(/\s+/g, ' ')}”`);
        }
        if (/\]\(/.test(t)) add('syntax', node, 'warning', 'Link syntax that didn’t render as a link (check brackets, parentheses and spaces in the URL)');
        else if (/\*\*/.test(t)) add('syntax', node, 'warning', 'Unrendered “**”: bold markers that don’t pair up');
        if (/\b(?:TODO|FIXME|TBD|XXX)\b/.test(t)) add('todo', node, 'info', `Placeholder left in the text: “${/\b(?:TODO|FIXME|TBD|XXX)\b/.exec(t)![0]}”`);
        break;
      }
      case 'html': {
        const v = (node as Html).value;
        for (const m of v.matchAll(/<([a-zA-Z][\w-]*)([^>]*)>/g)) {
          const tag = m[1].toLowerCase();
          if (!ALLOWED.has(tag)) add('html', node, 'warning', `GitHub doesn't render <${tag}> (it is stripped from the page)`);
          for (const a of m[2].matchAll(/\s([a-zA-Z][\w-:]*)\s*=/g)) {
            const name = a[1].toLowerCase();
            if (IGNORED_ATTRS.has(name) || (!ATTRS.has(name) && !name.startsWith('aria-'))) {
              add('html', node, 'info', `GitHub drops the ${name}="…" attribute of <${tag}>`);
            }
          }
        }
        break;
      }
    }
    return undefined;
  });
  return out.sort((a, b) => a.line - b.line);
}
