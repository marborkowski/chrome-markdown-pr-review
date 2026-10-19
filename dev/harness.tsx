// Dev playground: runs the content-script UI against a mocked GitHub API.
// Build with `npm run harness`, then open dev/harness.html via a local web server.
import { setTransport } from '../src/content/api';
import { mount } from '../src/content/index';
import type { ApiRequest, ApiResponse } from '../src/shared/messages';
import head from './fixtures/head.md';
import modifiedPatch from './fixtures/modified.patch';
import readme from './fixtures/readme-head.md';
import readmePatch from './fixtures/readme.patch';
import legacyPatch from './fixtures/legacy.patch';

declare global {
  interface Window {
    __calls: { method: string; path: string; body: unknown }[];
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
  { filename: 'README.md', status: 'added', additions: 14, deletions: 0, changes: 14, sha: 'b', patch: readmePatch },
  { filename: 'docs/legacy-export.md', status: 'removed', additions: 0, deletions: 3, changes: 3, sha: 'c', patch: legacyPatch },
  { filename: 'src/payments/adapter.ts', status: 'modified', additions: 40, deletions: 12, changes: 52, sha: 'd', patch: '@@ -1 +1 @@\n-a\n+b' },
];

const viewed: Record<string, boolean> = { 'README.md': true };

window.__calls = [];

async function mock(req: ApiRequest): Promise<ApiResponse> {
  await new Promise((r) => setTimeout(r, 120));
  const { path, method = 'GET', body } = req;
  if (method !== 'GET') window.__calls.push({ method, path, body });
  const ok = (data: any) => ({ ok: true as const, status: 200, data });

  if (path === 'graphql') {
    const q = (body as any).query as string;
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
  if (path.includes('/contents/')) {
    if (path.includes('architecture')) return ok(head);
    if (path.includes('README')) return ok(readme);
    return { ok: false, status: 404, error: 'Not Found' };
  }
  if (path.endsWith('/pulls/42/comments') && method === 'GET') return ok(comments);
  if (path.endsWith('/pulls/42/comments') && method === 'POST') {
    const b = body as any;
    const c = { id: nextId++, node_id: 'n', path: b.path, side: 'RIGHT', subject_type: b.subject_type ?? 'line', line: b.line ?? null, start_line: b.start_line ?? null, original_line: b.line, commit_id: b.commit_id, body: b.body, user: user('you', 210), created_at: new Date().toISOString(), html_url: '#' };
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
      comments.push({ id: nextId++, node_id: 'n', path: x.path, side: 'RIGHT', subject_type: 'line', line: x.line, start_line: x.start_line ?? null, original_line: x.line, commit_id: b.commit_id, body: x.body, user: user('you', 210), created_at: new Date().toISOString(), html_url: '#' });
    }
    return ok({ id: 1 });
  }
  return { ok: false, status: 404, error: `mock: unhandled ${method} ${path}` };
}

setTransport(mock);
window.__MDR_DEV_CTX__ = { origin: 'https://github.com', owner: 'acme', repo: 'payments', number: 42 };
mount();
