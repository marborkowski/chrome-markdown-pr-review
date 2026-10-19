export interface PrContext {
  origin: string;
  owner: string;
  repo: string;
  number: number;
}

export const prKey = (c: PrContext) => `${c.origin}/${c.owner}/${c.repo}#${c.number}`;

export interface PullRequest {
  number: number;
  title: string;
  node_id: string;
  html_url: string;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
  user: { login: string };
}

export interface PrFile {
  filename: string;
  previous_filename?: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  sha: string;
}

export interface ReviewComment {
  id: number;
  node_id: string;
  path: string;
  body: string;
  user: { login: string; avatar_url: string };
  created_at: string;
  html_url: string;
  line: number | null;
  start_line: number | null;
  original_line: number | null;
  side: 'LEFT' | 'RIGHT';
  subject_type?: 'line' | 'file';
  in_reply_to_id?: number;
  commit_id: string;
}

export interface Thread {
  root: ReviewComment;
  replies: ReviewComment[];
  kind: 'line' | 'file' | 'outdated' | 'left';
  start: number | null;
  end: number | null;
  resolved: boolean;
  /** GraphQL id of the review thread; unknown when GraphQL isn't available. */
  threadId?: string;
}

/** Resolution state of a review thread, keyed by its first comment's id. */
export interface ThreadState {
  id: string;
  resolved: boolean;
}

export interface PendingComment {
  id: string;
  path: string;
  kind: 'line' | 'file';
  start: number;
  end: number;
  body: string;
  quote: string;
  createdAt: number;
  /** Head commit the draft was written against (line numbers refer to it). */
  sha?: string;
}

export const isMarkdown = (path: string) => /\.(md|markdown|mdown|mkd|mdx)$/i.test(path);
