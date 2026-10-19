export const GITHUB_COM = 'https://github.com';

export interface HostConfig {
  /** Web origin, e.g. https://github.com or https://github.acme.corp */
  origin: string;
  /** REST API base, e.g. https://api.github.com or https://github.acme.corp/api/v3 */
  apiBase: string;
  /** Personal access token (stored only in chrome.storage.local). */
  token?: string;
}

export type HostMap = Record<string, HostConfig>;

export function normalizeOrigin(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return new URL(s).origin;
}

/** Default REST API base for a GitHub web origin (github.com, GHE Cloud *.ghe.com, or GHE Server). */
export function defaultApiBase(origin: string): string {
  const u = new URL(origin);
  if (u.hostname === 'github.com') return 'https://api.github.com';
  if (u.hostname.endsWith('.ghe.com')) return `${u.protocol}//api.${u.host}`;
  return `${u.origin}/api/v3`;
}

export function graphqlUrl(apiBase: string): string {
  const base = apiBase.replace(/\/+$/, '');
  if (base.endsWith('/api/v3')) return base.slice(0, -'/api/v3'.length) + '/api/graphql';
  return base + '/graphql';
}

export function originPatterns(h: HostConfig): string[] {
  const set = new Set([`${h.origin}/*`, `${new URL(h.apiBase).origin}/*`]);
  return [...set];
}

export async function loadHosts(): Promise<HostMap> {
  const { hosts } = await chrome.storage.local.get('hosts');
  const map: HostMap = (hosts as HostMap) ?? {};
  if (!map[GITHUB_COM]) map[GITHUB_COM] = { origin: GITHUB_COM, apiBase: defaultApiBase(GITHUB_COM) };
  return map;
}

export async function saveHosts(map: HostMap): Promise<void> {
  await chrome.storage.local.set({ hosts: map });
}
