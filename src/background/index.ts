import { GITHUB_COM, graphqlUrl, loadHosts, originPatterns, type HostConfig } from '../shared/hosts';
import type { ApiRequest, ApiResponse, RuntimeMessage } from '../shared/messages';

// ---------------------------------------------------------------------------
// GitHub API proxy. Tokens never leave the service worker / extension storage.
// ---------------------------------------------------------------------------

async function handleApi(req: ApiRequest): Promise<ApiResponse> {
  const hosts = await loadHosts();
  const host: HostConfig | undefined = hosts[req.origin];
  if (!host) {
    return { ok: false, status: 0, error: `${req.origin} is not configured in Markdown PR Review options.`, needsToken: true };
  }

  const isGraphql = req.path === 'graphql';
  let url = isGraphql ? graphqlUrl(host.apiBase) : host.apiBase.replace(/\/+$/, '') + req.path;
  const headers: Record<string, string> = {
    Accept: req.accept === 'raw' ? 'application/vnd.github.raw' : 'application/vnd.github+json',
  };
  if (host.token) headers.Authorization = `Bearer ${host.token}`;
  if (req.body !== undefined) headers['Content-Type'] = 'application/json';

  if (req.paginate) {
    url += (url.includes('?') ? '&' : '?') + 'per_page=100';
  }

  const out: any[] = [];
  for (let page = 0; page < 50; page++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: req.method ?? 'GET',
        headers,
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (e: any) {
      return { ok: false, status: 0, error: `Network error contacting ${new URL(url).host}: ${e?.message ?? e}` };
    }

    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const j = await res.json();
        if (j?.message) message = j.message;
        if (Array.isArray(j?.errors) && j.errors.length) {
          message += ': ' + j.errors.map((x: any) => (typeof x === 'string' ? x : x.message ?? x.code)).join('; ');
        }
      } catch { /* not json */ }
      const needsToken = (res.status === 401 || res.status === 404 || res.status === 403) && !host.token;
      return { ok: false, status: res.status, error: message, needsToken };
    }

    if (res.status === 204) return { ok: true, status: 204, data: null };
    const data = req.accept === 'raw' ? await res.text() : await res.json();

    if (isGraphql && data?.errors?.length) {
      return { ok: false, status: res.status, error: data.errors.map((e: any) => e.message).join('; ') };
    }

    if (!req.paginate) return { ok: true, status: res.status, data };
    out.push(...(Array.isArray(data) ? data : [data]));
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('Link') ?? '')?.[1];
    if (!next) break;
    url = next;
  }
  return { ok: true, status: 200, data: out };
}

// ---------------------------------------------------------------------------
// Dynamic content scripts for GitHub Enterprise hosts (github.com is static).
// ---------------------------------------------------------------------------

function scriptId(origin: string) {
  return 'ghe-' + origin.replace(/[^a-z0-9]/gi, '_');
}

async function syncContentScripts() {
  const hosts = await loadHosts();
  const registered = await chrome.scripting.getRegisteredContentScripts();
  if (registered.length) {
    await chrome.scripting.unregisterContentScripts({ ids: registered.map((s) => s.id) });
  }
  const scripts: chrome.scripting.RegisteredContentScript[] = [];
  for (const h of Object.values(hosts)) {
    if (h.origin === GITHUB_COM) continue;
    const granted = await chrome.permissions.contains({ origins: originPatterns(h) });
    if (!granted) continue;
    scripts.push({
      id: scriptId(h.origin),
      matches: [`${h.origin}/*`],
      js: ['content.js'],
      runAt: 'document_idle',
      persistAcrossSessions: true,
    });
  }
  if (scripts.length) await chrome.scripting.registerContentScripts(scripts);
}

let syncing: Promise<void> = Promise.resolve();
function scheduleSync() {
  syncing = syncing.then(syncContentScripts).catch((e) => console.warn('[md-review] sync failed', e));
}

chrome.runtime.onInstalled.addListener(scheduleSync);
chrome.runtime.onStartup.addListener(scheduleSync);
chrome.permissions.onAdded.addListener(scheduleSync);
chrome.permissions.onRemoved.addListener(scheduleSync);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.hosts) scheduleSync();
});

// ---------------------------------------------------------------------------
// Messaging, toolbar button & keyboard shortcut.
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  if (msg.type === 'api') {
    handleApi(msg).then(sendResponse);
    return true;
  }
  if (msg.type === 'openOptions') {
    const url = chrome.runtime.getURL('options.html') + (msg.addOrigin ? `#add=${encodeURIComponent(msg.addOrigin)}` : '');
    chrome.tabs.create({ url });
  }
  return false;
});

async function toggleInTab(tab?: chrome.tabs.Tab) {
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' } satisfies RuntimeMessage);
  } catch {
    // No content script in this tab: probably a GitHub Enterprise host that is not configured yet.
    let origin: string | undefined;
    try {
      const u = new URL(tab.url ?? '');
      if (u.protocol === 'https:' || u.protocol === 'http:') origin = u.origin;
    } catch { /* ignore */ }
    const url = chrome.runtime.getURL('options.html') + (origin ? `#add=${encodeURIComponent(origin)}` : '');
    chrome.tabs.create({ url });
  }
}

chrome.action.onClicked.addListener((tab) => toggleInTab(tab));
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-review') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  toggleInTab(tab);
});
