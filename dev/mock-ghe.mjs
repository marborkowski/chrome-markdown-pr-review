// Minimal fake GitHub Enterprise Server (web page + REST + GraphQL) for testing the real
// extension end-to-end:  node dev/mock-ghe.mjs  → http://localhost:8766/acme/payments/pull/42/files
import http from 'node:http';
import { readFileSync } from 'node:fs';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const head = fx('head.md');
const calls = [];
const comments = [];
const files = [
  { filename: 'docs/architecture.md', status: 'modified', additions: 22, deletions: 14, changes: 36, sha: 'a', patch: fx('modified.patch') },
  { filename: 'README.md', status: 'added', additions: 14, deletions: 0, changes: 14, sha: 'b', patch: fx('readme.patch') },
  { filename: 'app.ts', status: 'modified', additions: 1, deletions: 1, changes: 2, sha: 'c', patch: '@@ -1 +1 @@\n-a\n+b' },
];

const page = `<!doctype html><html><head><meta charset="utf-8"><title>PR #42 · acme/payments</title></head>
<body style="font-family:sans-serif"><header style="height:60px;background:#24292f;color:#fff;padding:18px">GitHub Enterprise (mock)</header>
<main style="padding:24px"><h1>Payments: async provider adapter #42</h1><p>Files changed</p></main></body></html>`;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const json = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.method !== 'GET') calls.push({ method: req.method, path: p, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });

    if (p === '/__calls') return json(200, calls);
    if (p.startsWith('/acme/payments/pull/42')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(page);
    }
    if (p === '/api/graphql') {
      return json(200, { data: { repository: { pullRequest: { files: { pageInfo: { hasNextPage: false }, nodes: files.map((f) => ({ path: f.filename, viewerViewedState: 'UNVIEWED' })) } } } } });
    }
    if (p === '/api/v3/user') {
      return req.headers.authorization ? json(200, { login: 'tester' }) : json(401, { message: 'Requires authentication' });
    }
    const api = '/api/v3/repos/acme/payments';
    if (p === `${api}/pulls/42`) {
      return json(200, { number: 42, title: 'Payments: async provider adapter', node_id: 'PR_1', html_url: 'http://localhost:8766/acme/payments/pull/42', head: { sha: 'headsha', ref: 'f' }, base: { sha: 'basesha', ref: 'main' }, user: { login: 'marek' } });
    }
    if (p === `${api}/pulls/42/files`) {
      if (url.searchParams.get('per_page') !== '100') return json(400, { message: 'expected per_page' });
      return json(200, files);
    }
    if (p.startsWith(`${api}/contents/`)) {
      if (req.headers.accept !== 'application/vnd.github.raw') return json(415, { message: 'expected raw accept' });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(p.includes('architecture') ? head : fx('readme-head.md'));
    }
    if (p === `${api}/pulls/42/comments`) {
      if (req.method === 'POST') {
        const b = JSON.parse(body);
        const c = { id: comments.length + 1, path: b.path, side: 'RIGHT', line: b.line, start_line: b.start_line ?? null, body: b.body, user: { login: 'tester', avatar_url: '' }, created_at: new Date().toISOString(), html_url: '#', subject_type: b.subject_type ?? 'line' };
        comments.push(c);
        return json(201, c);
      }
      return json(200, comments);
    }
    json(404, { message: `Not Found: ${p}` });
  });
});
server.listen(8766, () => console.log('mock GHE on http://localhost:8766'));
