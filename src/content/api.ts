import type { ApiRequest, ApiResponse } from '../shared/messages';
import type { PendingComment, PrContext, PrFile, PullRequest, ReviewComment } from './types';

export class ApiError extends Error {
  constructor(public status: number, message: string, public needsToken = false) {
    super(message);
  }
}

type Transport = (req: ApiRequest) => Promise<ApiResponse>;

let transport: Transport = async (req) => {
  try {
    const res = (await chrome.runtime.sendMessage(req)) as ApiResponse | undefined;
    if (!res) return { ok: false, status: 0, error: 'No response from the extension background worker.' };
    return res;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes('Extension context invalidated')) {
      return { ok: false, status: 0, error: 'The extension was updated. Reload this page to continue.' };
    }
    return { ok: false, status: 0, error: msg };
  }
};

/** Used by the dev harness to plug in a mock backend. */
export function setTransport(t: Transport) {
  transport = t;
}

async function call<T = any>(ctx: Pick<PrContext, 'origin'>, req: Omit<ApiRequest, 'type' | 'origin'>): Promise<T> {
  const res = await transport({ type: 'api', origin: ctx.origin, ...req });
  if (!res.ok) throw new ApiError(res.status, res.error, res.needsToken);
  return res.data as T;
}

const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');
const repoPath = (c: PrContext) => `/repos/${enc(c.owner)}/${enc(c.repo)}`;

export interface LineCommentInput {
  path: string;
  body: string;
  line: number;
  start_line?: number;
}

export const gh = {
  pr: (c: PrContext) => call<PullRequest>(c, { path: `${repoPath(c)}/pulls/${c.number}` }),

  files: (c: PrContext) => call<PrFile[]>(c, { path: `${repoPath(c)}/pulls/${c.number}/files`, paginate: true }),

  raw: (c: PrContext, path: string, ref: string) =>
    call<string>(c, { path: `${repoPath(c)}/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`, accept: 'raw' }),

  comments: (c: PrContext) =>
    call<ReviewComment[]>(c, { path: `${repoPath(c)}/pulls/${c.number}/comments`, paginate: true }),

  createLineComment: (c: PrContext, commitId: string, x: LineCommentInput) =>
    call<ReviewComment>(c, {
      method: 'POST',
      path: `${repoPath(c)}/pulls/${c.number}/comments`,
      body: {
        body: x.body,
        commit_id: commitId,
        path: x.path,
        line: x.line,
        side: 'RIGHT',
        ...(x.start_line && x.start_line < x.line ? { start_line: x.start_line, start_side: 'RIGHT' } : {}),
      },
    }),

  /** File-level comment; falls back to a regular PR conversation comment on older GHE servers. */
  createFileComment: async (c: PrContext, commitId: string, path: string, body: string) => {
    try {
      return await call<ReviewComment>(c, {
        method: 'POST',
        path: `${repoPath(c)}/pulls/${c.number}/comments`,
        body: { body, commit_id: commitId, path, subject_type: 'file' },
      });
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 422) throw e;
      return call(c, {
        method: 'POST',
        path: `${repoPath(c)}/issues/${c.number}/comments`,
        body: { body: `**\`${path}\`**\n\n${body}` },
      });
    }
  },

  reply: (c: PrContext, commentId: number, body: string) =>
    call<ReviewComment>(c, {
      method: 'POST',
      path: `${repoPath(c)}/pulls/${c.number}/comments/${commentId}/replies`,
      body: { body },
    }),

  createReview: (
    c: PrContext,
    commitId: string,
    event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES',
    body: string,
    comments: LineCommentInput[],
  ) =>
    call(c, {
      method: 'POST',
      path: `${repoPath(c)}/pulls/${c.number}/reviews`,
      body: {
        commit_id: commitId,
        event,
        ...(body ? { body } : {}),
        comments: comments.map((x) => ({
          path: x.path,
          body: x.body,
          line: x.line,
          side: 'RIGHT',
          ...(x.start_line && x.start_line < x.line ? { start_line: x.start_line, start_side: 'RIGHT' } : {}),
        })),
      },
    }),

  /** Map of path → viewed, via GraphQL (not available on very old GHE servers). */
  viewedStates: async (c: PrContext): Promise<Record<string, boolean>> => {
    const out: Record<string, boolean> = {};
    let after: string | null = null;
    for (let i = 0; i < 40; i++) {
      const data: any = await call(c, {
        method: 'POST',
        path: 'graphql',
        body: {
          query: `query($o:String!,$r:String!,$n:Int!,$a:String){repository(owner:$o,name:$r){pullRequest(number:$n){files(first:100,after:$a){pageInfo{hasNextPage endCursor} nodes{path viewerViewedState}}}}}`,
          variables: { o: c.owner, r: c.repo, n: c.number, a: after },
        },
      });
      const files = data?.data?.repository?.pullRequest?.files;
      if (!files) break;
      for (const f of files.nodes) out[f.path] = f.viewerViewedState === 'VIEWED';
      if (!files.pageInfo.hasNextPage) break;
      after = files.pageInfo.endCursor;
    }
    return out;
  },

  setViewed: (c: PrContext, prNodeId: string, path: string, viewed: boolean) =>
    call(c, {
      method: 'POST',
      path: 'graphql',
      body: {
        query: viewed
          ? `mutation($id:ID!,$p:String!){markFileAsViewed(input:{pullRequestId:$id,path:$p}){clientMutationId}}`
          : `mutation($id:ID!,$p:String!){unmarkFileAsViewed(input:{pullRequestId:$id,path:$p}){clientMutationId}}`,
        variables: { id: prNodeId, p: path },
      },
    }),
};

export function openOptions(addOrigin?: string) {
  try {
    chrome.runtime.sendMessage({ type: 'openOptions', addOrigin });
  } catch { /* harness */ }
}

// ---------------------------------------------------------------------------
// Draft (pending) review comments, kept locally until the review is submitted.
// ---------------------------------------------------------------------------

const hasChromeStorage = () => typeof chrome !== 'undefined' && !!chrome.storage?.local;

export const drafts = {
  async load(key: string): Promise<PendingComment[]> {
    const k = `pending:${key}`;
    try {
      if (hasChromeStorage()) return ((await chrome.storage.local.get(k))[k] as PendingComment[]) ?? [];
      return JSON.parse(localStorage.getItem(k) ?? '[]');
    } catch {
      return [];
    }
  },
  async save(key: string, list: PendingComment[]) {
    const k = `pending:${key}`;
    try {
      if (hasChromeStorage()) {
        if (list.length) await chrome.storage.local.set({ [k]: list });
        else await chrome.storage.local.remove(k);
      } else localStorage.setItem(k, JSON.stringify(list));
    } catch { /* ignore */ }
  },
};
