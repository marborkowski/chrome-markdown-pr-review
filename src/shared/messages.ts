export interface ApiRequest {
  type: 'api';
  /** Web origin of the GitHub instance the request is for. */
  origin: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path relative to the REST API base (e.g. /repos/o/r/pulls/1) or the literal "graphql". */
  path: string;
  body?: unknown;
  /** Accept header; use "raw" for file contents. */
  accept?: 'json' | 'raw';
  /** Follow Link rel="next" and concatenate array results. */
  paginate?: boolean;
}

export type ApiResponse =
  | { ok: true; status: number; data: any }
  | { ok: false; status: number; error: string; needsToken?: boolean };

/** Loads the draft comments of a pull request, or replaces them when `list` is given. */
export interface DraftsRequest {
  type: 'drafts';
  /** prKey(): starts with the web origin of the GitHub instance. */
  key: string;
  list?: unknown[];
}

export type RuntimeMessage =
  | ApiRequest
  | DraftsRequest
  | { type: 'openOptions'; addOrigin?: string }
  | { type: 'toggle' };
