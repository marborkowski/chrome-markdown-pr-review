import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { defaultApiBase, GITHUB_COM, loadHosts, normalizeOrigin, originPatterns, saveHosts, type HostConfig, type HostMap } from '../shared/hosts';
import type { ApiResponse } from '../shared/messages';
import css from './options.css';

type Status = { kind: 'ok' | 'err' | 'info'; text: string } | null;

async function testHost(origin: string): Promise<Status> {
  const res = (await chrome.runtime.sendMessage({ type: 'api', origin, path: '/user' })) as ApiResponse;
  if (res.ok) return { kind: 'ok', text: `Connected as @${res.data.login}` };
  return { kind: 'err', text: res.status === 401 ? 'Token rejected (401). Check it and its SSO authorization.' : res.error };
}

/** GitHub (and GHE) prefill the "new classic token" form from these query parameters. */
function newTokenUrl(origin: string) {
  return `${origin}/settings/tokens/new?scopes=repo&description=${encodeURIComponent('Markdown PR Review')}`;
}

function HostCard({ host, onSave, onRemove }: { host: HostConfig; onSave: (h: HostConfig) => Promise<void>; onRemove?: () => void }) {
  const [token, setToken] = useState(host.token ?? '');
  const [apiBase, setApiBase] = useState(host.apiBase);
  const [granted, setGranted] = useState<boolean | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const isCom = host.origin === GITHUB_COM;

  useEffect(() => {
    chrome.permissions.contains({ origins: originPatterns({ ...host, apiBase }) }).then(setGranted);
  }, [host, apiBase]);

  const save = async () => {
    if (token.trim().startsWith('github_pat_')) {
      setStatus({ kind: 'err', text: 'This is a fine-grained token. Use a classic token (ghp_…) with the repo scope.' });
      return;
    }
    const next = { ...host, token: token.trim() || undefined, apiBase: apiBase.trim().replace(/\/+$/, '') };
    if (!isCom) {
      // Must run in the click handler (user gesture).
      const ok = await chrome.permissions.request({ origins: originPatterns(next) });
      setGranted(ok);
      if (!ok) {
        setStatus({ kind: 'err', text: 'Chrome permission for this host was not granted.' });
        return;
      }
    }
    await onSave(next);
    setStatus({ kind: 'info', text: 'Saved. Testing…' });
    setStatus(await testHost(next.origin));
  };

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h3>{isCom ? 'GitHub.com' : new URL(host.origin).host}</h3>
          <div className="muted mono">{host.origin}</div>
        </div>
        {!isCom && (
          <span className={`chip ${granted ? 'chip-ok' : 'chip-warn'}`}>{granted ? 'Access granted' : 'Access not granted'}</span>
        )}
      </div>
      {!isCom && (
        <label>
          API URL
          <input value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder={defaultApiBase(host.origin)} />
        </label>
      )}
      <label>
        <span className="label-row">
          Personal access token (classic)
          <a className="token-link" href={newTokenUrl(host.origin)} target="_blank" rel="noreferrer">
            Generate a classic token with the <code>repo</code> scope →
          </a>
        </span>
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={isCom ? 'ghp_… (optional for reading public repositories)' : 'ghp_…'} autoComplete="off" />
      </label>
      <div className="row">
        <button className="primary" onClick={save}>{isCom ? 'Save' : granted ? 'Save' : 'Save & grant access'}</button>
        {onRemove && <button className="danger" onClick={onRemove}>Remove</button>}
        {status && <span className={`status status-${status.kind}`}>{status.text}</span>}
      </div>
    </section>
  );
}

function Options() {
  const [hosts, setHosts] = useState<HostMap | null>(null);
  const [newUrl, setNewUrl] = useState(() => {
    const m = /#add=(.+)$/.exec(location.hash);
    return m ? decodeURIComponent(m[1]) : '';
  });
  const [addErr, setAddErr] = useState('');

  useEffect(() => {
    loadHosts().then(setHosts);
  }, []);
  if (!hosts) return null;

  const update = async (h: HostConfig) => {
    const next = { ...hosts, [h.origin]: h };
    await saveHosts(next);
    setHosts(next);
  };

  const remove = async (origin: string) => {
    const h = hosts[origin];
    const next = { ...hosts };
    delete next[origin];
    await saveHosts(next);
    setHosts(next);
    try { await chrome.permissions.remove({ origins: originPatterns(h) }); } catch { /* ignore */ }
  };

  const add = async () => {
    setAddErr('');
    let origin: string;
    try {
      origin = normalizeOrigin(newUrl);
    } catch {
      setAddErr('Enter a valid URL, e.g. https://github.example.com');
      return;
    }
    if (origin === GITHUB_COM) {
      setAddErr('GitHub.com is already configured above.');
      return;
    }
    const h: HostConfig = hosts[origin] ?? { origin, apiBase: defaultApiBase(origin) };
    const ok = await chrome.permissions.request({ origins: originPatterns(h) });
    if (!ok) {
      setAddErr('Chrome permission was not granted – the extension needs it to run on this host.');
      return;
    }
    await update(h);
    setNewUrl('');
    history.replaceState(null, '', location.pathname);
  };

  const enterprise = Object.values(hosts).filter((h) => h.origin !== GITHUB_COM);

  return (
    <main>
      <header>
        <div className="logo">M↓</div>
        <div>
          <h1>Markdown PR Review</h1>
          <p className="muted">Review Markdown in pull requests as rendered documents and comment on selected text.</p>
        </div>
      </header>

      <HostCard host={hosts[GITHUB_COM]} onSave={update} />

      <h2>GitHub Enterprise</h2>
      <p className="muted">
        Add each GitHub Enterprise Server (or GHE.com) instance you use. Chrome will ask for permission to run on that host;
        reload open tabs of the instance afterwards.
      </p>
      {enterprise.map((h) => (
        <HostCard key={h.origin} host={h} onSave={update} onRemove={() => remove(h.origin)} />
      ))}
      <section className="card add">
        <label>
          Enterprise URL
          <input value={newUrl} onChange={(e) => setNewUrl(e.target.value)} placeholder="https://github.example.com" onKeyDown={(e) => e.key === 'Enter' && add()} />
        </label>
        <div className="row">
          <button className="primary" onClick={add} disabled={!newUrl.trim()}>Add instance</button>
          {addErr && <span className="status status-err">{addErr}</span>}
        </div>
      </section>

      <h2>Creating the token</h2>
      <p className="muted">
        The extension uses a <b>classic</b> personal access token. Create a separate one for each GitHub instance
        (GitHub.com and every Enterprise server).
      </p>
      <ol className="help">
        <li>
          Click <b>Generate a classic token</b> next to the instance above. Or open <i>Settings → Developer settings → Personal access
          tokens → Tokens (classic) → Generate new token (classic)</i> on that instance.
        </li>
        <li>
          Select <b>only the <code>repo</code> scope</b>. This is enough to read pull requests and files, post comments and
          reviews, and mark files as viewed. No other scopes are needed.
          <br />
          <span className="muted">Only review public repositories? <code>public_repo</code> is enough.</span>
        </li>
        <li>Set an expiration date, generate the token and copy it (<code>ghp_…</code>).</li>
        <li>
          If your organization uses SAML single sign-on, click <b>Configure SSO</b> next to the token and <b>Authorize</b> it for
          that organization. Without this, GitHub hides the organization's repositories from the token.
        </li>
        <li>Paste the token above and click <b>Save</b>. You should see “Connected as @your-login”.</li>
      </ol>
      <p className="note">
        Fine-grained tokens (<code>github_pat_…</code>) are not supported. Organizations often restrict them, and comments then fail
        with “Resource not accessible by personal access token”.
      </p>
      <p className="muted">
        Tokens are stored only in this browser's extension storage (<code>chrome.storage.local</code>) and are sent only to the
        API URL of their own GitHub instance.
      </p>

      <h2>Using it</h2>
      <ul className="help">
        <li>Open a pull request and click <b>Review Markdown</b> (bottom-right), the toolbar icon, or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd>.</li>
        <li>Select any text in the rendered document → <b>Comment</b> or <b>Suggest</b>. Comments map to the right source lines automatically.</li>
        <li>Collect comments as a draft review and submit them together with <b>Finish review</b>.</li>
      </ul>
    </main>
  );
}

const style = document.createElement('style');
style.textContent = css;
document.head.appendChild(style);
createRoot(document.getElementById('root')!).render(<Options />);
