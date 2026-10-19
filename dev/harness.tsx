// Dev playground: runs the content-script UI against a mocked GitHub API.
// Build with `npm run harness`, then open dev/harness.html via a local web server.
import { mount } from '../src/content/index';
import type { ApiRequest, ApiResponse } from '../src/shared/messages';
import head from './fixtures/head.md';
import modifiedPatch from './fixtures/modified.patch';
import readme from './fixtures/readme-head.md';
import readmePatch from './fixtures/readme.patch';
import legacyPatch from './fixtures/legacy.patch';
import flow from './fixtures/flow-head.md';
import flowPatch from './fixtures/flow.patch';
import guide from './fixtures/guide-head.md';
import guidePatch from './fixtures/guide.patch';
import guideSinceReview from './fixtures/guide-since-review.patch';
import { hardenSvg } from '../src/content/lib/svgHarden';

declare global {
  interface Window {
    __calls: { method: string; path: string; body: unknown }[];
    /** Exposed for dev/e2e.mjs: the DOM pass over diagram markup (vitest has no DOM to test it in). */
    __hardenSvg: typeof hardenSvg;
  }
}

const lineOf = (needle: string) => head.split('\n').findIndex((l) => l.includes(needle)) + 1;
const user = (login: string, hue: number) => ({
  login,
  avatar_url: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="hsl(${hue},55%,55%)"/><text x="10" y="14" font-size="11" text-anchor="middle" fill="white" font-family="sans-serif">${login[0].toUpperCase()}</text></svg>`)}`,
});
const now = Date.now();
let nextId = 1000;

const comments: any[] = [
  {
    id: 1, node_id: 'c1', path: 'docs/architecture.md', side: 'RIGHT', subject_type: 'line',
    line: lineOf('fraud service scores'), start_line: null, original_line: 22, commit_id: 'head',
    body: 'What is the SLA of the fraud service? This sits on the hot path now.',
    user: user('kasia-nowak', 280), created_at: new Date(now - 3 * 3600e3).toISOString(), html_url: '#',
  },
  {
    id: 2, node_id: 'c2', path: 'docs/architecture.md', side: 'RIGHT', subject_type: 'line', in_reply_to_id: 1,
    line: lineOf('fraud service scores'), start_line: null, original_line: 22, commit_id: 'head',
    body: 'p99 is ~40 ms, I will add it to the doc.', user: user('marek', 140),
    created_at: new Date(now - 2 * 3600e3).toISOString(), html_url: '#',
  },
  {
    id: 3, node_id: 'c3', path: 'docs/architecture.md', side: 'RIGHT', subject_type: 'line',
    line: null, start_line: null, original_line: 9, commit_id: 'old',
    body: 'Typo: "intergrates".', user: user('kasia-nowak', 280),
    created_at: new Date(now - 26 * 3600e3).toISOString(), html_url: '#',
  },
];

const files = [
  { filename: 'docs/architecture.md', status: 'modified', additions: 22, deletions: 14, changes: 36, sha: 'a', patch: modifiedPatch },
  { filename: 'README.md', status: 'added', additions: 21, deletions: 0, changes: 21, sha: 'b', patch: readmePatch },
  { filename: 'docs/legacy-export.md', status: 'removed', additions: 0, deletions: 3, changes: 3, sha: 'c', patch: legacyPatch },
  { filename: 'src/payments/adapter.ts', status: 'modified', additions: 40, deletions: 12, changes: 52, sha: 'd', patch: '@@ -1 +1 @@\n-a\n+b' },
  { filename: 'docs/flow.md', status: 'modified', additions: 5, deletions: 5, changes: 10, sha: 'e', patch: flowPatch },
  { filename: 'docs/guide.md', status: 'modified', additions: 30, deletions: 14, changes: 44, sha: 'f', patch: guidePatch },
  { filename: 'docs/img/flow.png', status: 'modified', additions: 0, deletions: 0, changes: 0, sha: 'g' },
];

const commits = [
  { sha: 'c1sha', commit: { message: 'Draft the operator guide', author: { name: 'Marek', date: new Date(now - 72 * 3600e3).toISOString() } }, author: { login: 'marek' } },
  { sha: 'c2sha', commit: { message: 'Move setup below usage', author: { name: 'Marek', date: new Date(now - 30 * 3600e3).toISOString() } }, author: { login: 'marek' } },
  { sha: 'headsha', commit: { message: 'Address review comments', author: { name: 'Marek', date: new Date(now - 2 * 3600e3).toISOString() } }, author: { login: 'marek' } },
];
const reviews = [{ id: 7, user: { login: 'you' }, state: 'COMMENTED', commit_id: 'c2sha', html_url: '#' }];
const treePaths = ['README.md', 'docs', 'docs/architecture.md', 'docs/flow.md', 'docs/guide.md', 'docs/img', 'docs/img/flow.png', 'docs/img/logo.png', 'src', 'src/payments', 'src/payments/adapter.ts'];

const viewed: Record<string, boolean> = { 'README.md': true };
const resolved = new Set<number>();

window.__calls = [];
window.__hardenSvg = hardenSvg;

async function mock(req: ApiRequest): Promise<ApiResponse> {
  await new Promise((r) => setTimeout(r, 120));
  const { path, method = 'GET', body } = req;
  if (method !== 'GET') window.__calls.push({ method, path, body });
  const ok = (data: any) => ({ ok: true as const, status: 200, data });

  if (path === 'graphql') {
    const q = (body as any).query as string;
    if (q.includes('reviewThreads')) {
      const nodes = comments.filter((c) => !c.in_reply_to_id).map((c) => ({ id: `T${c.id}`, isResolved: resolved.has(c.id), comments: { nodes: [{ databaseId: c.id }] } }));
      return ok({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes } } } } });
    }
    if (q.includes('ReviewThread')) {
      const id = Number(String((body as any).variables.id).slice(1));
      if (q.includes('unresolve')) resolved.delete(id);
      else resolved.add(id);
      return ok({ data: {} });
    }
    if (q.startsWith('query')) {
      return ok({ data: { repository: { pullRequest: { files: { pageInfo: { hasNextPage: false }, nodes: files.map((f) => ({ path: f.filename, viewerViewedState: viewed[f.filename] ? 'VIEWED' : 'UNVIEWED' })) } } } } });
    }
    const p = (body as any).variables.p;
    viewed[p] = q.includes('markFileAsViewed') && !q.includes('unmark');
    return ok({ data: {} });
  }
  if (/\/pulls\/42$/.test(path)) {
    return ok({ number: 42, title: 'Payments: async provider adapter + fraud scoring', node_id: 'PR_1', html_url: '#', head: { sha: 'headsha', ref: 'feature' }, base: { sha: 'basesha', ref: 'main' }, user: { login: 'marek' } });
  }
  if (path.endsWith('/pulls/42/files')) return ok(files);
  if (path.endsWith('/pulls/42/commits')) return ok(commits);
  if (path.endsWith('/pulls/42/reviews') && method === 'GET') return ok(reviews);
  if (path === '/user') return ok({ login: 'you' });
  if (path.includes('/git/trees/headsha')) return ok({ truncated: false, tree: treePaths.map((p) => ({ path: p, type: p.includes('.') ? 'blob' : 'tree' })) });
  if (path.includes('/compare/c2sha...headsha')) {
    return ok({ status: 'ahead', merge_base_commit: { sha: 'c2sha' }, files: [{ filename: 'docs/guide.md', status: 'modified', additions: 3, deletions: 2, changes: 5, sha: 'f', patch: guideSinceReview }] });
  }
  if (path.includes('/compare/')) return ok({ status: 'ahead', merge_base_commit: { sha: 'basesha' }, files: [] });
  const editM = /\/pulls\/comments\/(\d+)$/.exec(path);
  if (editM && method === 'PATCH') {
    const c = comments.find((x) => x.id === Number(editM[1]));
    c.body = (body as any).body;
    return ok(c);
  }
  if (editM && method === 'DELETE') {
    comments.splice(comments.findIndex((x) => x.id === Number(editM[1])), 1);
    return { ok: true as const, status: 204, data: null };
  }
  if (path.includes('/contents/')) {
    if (path.includes('architecture')) return ok(head);
    if (path.includes('README')) return ok(readme);
    if (path.includes('flow')) return ok(flow);
    if (path.includes('guide')) return ok(guide);
    return { ok: false, status: 404, error: 'Not Found' };
  }
  if (path.endsWith('/pulls/42/comments') && method === 'GET') return ok(comments);
  if (path.endsWith('/pulls/42/comments') && method === 'POST') {
    const b = body as any;
    const c = { id: nextId++, node_id: 'n', path: b.path, side: b.side ?? 'RIGHT', subject_type: b.subject_type ?? 'line', line: b.line ?? null, start_line: b.start_line ?? null, original_line: b.line, commit_id: b.commit_id, body: b.body, user: user('you', 210), created_at: new Date().toISOString(), html_url: '#' };
    comments.push(c);
    return ok(c);
  }
  const replyM = /\/comments\/(\d+)\/replies$/.exec(path);
  if (replyM) {
    const parent = comments.find((c) => c.id === Number(replyM[1]));
    const c = { ...parent, id: nextId++, in_reply_to_id: parent.id, body: (body as any).body, user: user('you', 210), created_at: new Date().toISOString() };
    comments.push(c);
    return ok(c);
  }
  if (path.endsWith('/pulls/42/reviews')) {
    const b = body as any;
    for (const x of b.comments) {
      comments.push({ id: nextId++, node_id: 'n', path: x.path, side: x.side ?? 'RIGHT', subject_type: 'line', line: x.line, start_line: x.start_line ?? null, original_line: x.line, commit_id: b.commit_id, body: x.body, user: user('you', 210), created_at: new Date().toISOString(), html_url: '#' });
    }
    return ok({ id: 1 });
  }
  return { ok: false, status: 404, error: `mock: unhandled ${method} ${path}` };
}

window.__MDR_TRANSPORT__ = mock;
window.__MDR_DEV_CTX__ = { origin: 'https://github.com', owner: 'acme', repo: 'payments', number: 42 };
mount();
