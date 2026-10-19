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
  /** Number of review comments (used to notice new ones without reloading them all). */
  review_comments?: number;
  updated_at?: string;
}

export interface Commit {
  sha: string;
  commit: { message: string; author: { name: string; date: string } | null };
  author: { login: string } | null;
}

export interface Review {
  id: number;
  user: { login: string } | null;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  commit_id: string;
  submitted_at?: string;
  html_url?: string;
}

export interface Compare {
  status: 'diverged' | 'ahead' | 'behind' | 'identical';
  merge_base_commit: { sha: string };
  files?: PrFile[];
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
  original_start_line?: number | null;
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
  /** LEFT: a comment on removed text, `start`/`end` are base-file lines. */
  side?: 'LEFT' | 'RIGHT';
  body: string;
  quote: string;
  createdAt: number;
  /** Head commit the draft was written against (line numbers refer to it). */
  sha?: string;
}

export const isMarkdown = (path: string) => /\.(md|markdown|mdown|mkd|mdx)$/i.test(path);
