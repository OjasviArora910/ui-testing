import { useState, type FormEvent } from 'react';
import { api, type Mode, type PlatformConfig } from '../api';
import { emptyToken, toDirectAuth, TokenFields, type TokenState } from './TokenFields';

const MODE_LABEL: Record<Mode, string> = {
  deterministic: 'Deterministic (rules + functional tests)',
  ai_assisted: 'AI-assisted (adds AI explanations)',
  exploratory: 'Exploratory (adds AI agent exploration)',
};

type AuthChoice = 'none' | 'token' | 'profile';

export function RunForm({ config, onStarted }: { config: PlatformConfig; onStarted: (runId: string) => void }) {
  const [url, setUrl] = useState('');
  const [authChoice, setAuthChoice] = useState<AuthChoice>('none');
  const [token, setToken] = useState<TokenState>(emptyToken);
  const [profile, setProfile] = useState(config.authProfiles[0]?.name ?? '');
  const [mode, setMode] = useState<Mode>('deterministic');
  const [vps, setVps] = useState<string[]>(config.viewports.map((v) => v.name));
  const [advanced, setAdvanced] = useState(false);
  const [limits, setLimits] = useState({ maxPages: '', maxDepth: '', maxActions: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null);
    const auth = authChoice === 'token' ? toDirectAuth(token) : undefined;
    if (authChoice === 'token' && !auth) { setError('Paste the token, or choose "No login".'); return; }
    setBusy(true);
    try {
      const overrides = Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)]));
      const { runId } = await api.start({
        url, mode, viewports: config.viewports.filter((v) => vps.includes(v.name)),
        ...(auth ? { auth } : {}), ...(authChoice === 'profile' && profile ? { authProfile: profile } : {}),
        ...(Object.keys(overrides).length ? { overrides } : {}),
      });
      onStarted(runId);
    } catch (err) { setError((err as Error).message); } finally {
      setToken((t) => ({ ...t, token: '' })); // never keep the secret around in the UI
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={submit} autoComplete="off">
      <h2>New test</h2>
      <label htmlFor="url">Application URL</label>
      <input id="url" type="url" required placeholder="https://staging.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />

      <fieldset>
        <legend>Login</legend>
        <label className="check"><input type="radio" name="auth" checked={authChoice === 'none'} onChange={() => setAuthChoice('none')} /> No login (public pages)</label>
        <label className="check"><input type="radio" name="auth" checked={authChoice === 'token'} onChange={() => setAuthChoice('token')} /> Use a JWT / access token</label>
        {config.authProfiles.length > 0 && <label className="check"><input type="radio" name="auth" checked={authChoice === 'profile'} onChange={() => setAuthChoice('profile')} /> Server auth profile</label>}
        {authChoice === 'token' && <TokenFields value={token} onChange={setToken} idPrefix="new" />}
        {authChoice === 'profile' && (
          <select aria-label="Auth profile" value={profile} onChange={(e) => setProfile(e.target.value)}>
            {config.authProfiles.map((p) => <option key={p.name} value={p.name}>{p.name} ({p.location})</option>)}
          </select>
        )}
      </fieldset>

      <label htmlFor="mode">Testing mode</label>
      <select id="mode" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
        {config.modes.map((m) => <option key={m} value={m} disabled={m !== 'deterministic' && !config.aiConfigured}>{MODE_LABEL[m]}{m !== 'deterministic' && !config.aiConfigured ? ' (AI not configured)' : ''}</option>)}
      </select>

      <fieldset>
        <legend>Viewports</legend>
        {config.viewports.map((v) => (
          <label key={v.name} className="check">
            <input type="checkbox" checked={vps.includes(v.name)} onChange={(e) => setVps(e.target.checked ? [...vps, v.name] : vps.filter((x) => x !== v.name))} />
            {v.name} <span className="muted">{v.width}x{v.height}</span>
          </label>
        ))}
      </fieldset>

      <button type="button" className="link" onClick={() => setAdvanced(!advanced)}>{advanced ? 'Hide' : 'Show'} limits</button>
      {advanced && (
        <div className="grid3">
          {(['maxPages', 'maxDepth', 'maxActions'] as const).map((k) => (
            <label key={k}>{k}<input type="number" min={k === 'maxDepth' ? 0 : 1} placeholder={String(config.limits[k])} value={limits[k]} onChange={(e) => setLimits({ ...limits, [k]: e.target.value })} /></label>
          ))}
        </div>
      )}

      {error && <p className="error-text">{error}</p>}
      <button type="submit" className="primary" disabled={busy || vps.length === 0}>{busy ? 'Starting…' : 'START TEST'}</button>
    </form>
  );
}
