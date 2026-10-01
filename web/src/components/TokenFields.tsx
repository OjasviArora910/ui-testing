import type { DirectAuth, JwtLocation } from '../api';

export interface TokenState { token: string; location: JwtLocation; key: string; scheme: string }
export const emptyToken = (): TokenState => ({ token: '', location: 'cookie', key: '', scheme: 'Bearer' });

const KEY_HINT: Record<JwtLocation, string> = { cookie: 'Cookie name (default: token)', localStorage: 'Storage key (default: token)', sessionStorage: 'Storage key (default: token)', header: 'Header name (default: Authorization)' };

export function toDirectAuth(t: TokenState): DirectAuth | undefined {
  const token = t.token.trim();
  if (!token) return undefined;
  return { token, location: t.location, ...(t.key.trim() ? { key: t.key.trim() } : {}), ...(t.location === 'header' && t.scheme.trim() ? { scheme: t.scheme.trim() } : {}) };
}

/** Token entry. The value lives in React state only; it is cleared by the parent right after use and never written to storage. */
export function TokenFields({ value, onChange, idPrefix }: { value: TokenState; onChange: (v: TokenState) => void; idPrefix: string }) {
  return (
    <div className="token-box">
      <label htmlFor={`${idPrefix}-token`}>JWT / access token</label>
      <input
        id={`${idPrefix}-token`} type="password" autoComplete="off" spellCheck={false} placeholder="Paste token"
        value={value.token} onChange={(e) => onChange({ ...value, token: e.target.value })}
        data-lpignore="true" data-1p-ignore="true"
      />
      <label htmlFor={`${idPrefix}-loc`}>Where the app expects it</label>
      <select id={`${idPrefix}-loc`} value={value.location} onChange={(e) => onChange({ ...value, location: e.target.value as JwtLocation })}>
        <option value="cookie">Cookie</option>
        <option value="localStorage">localStorage</option>
        <option value="sessionStorage">sessionStorage</option>
        <option value="header">Authorization header</option>
      </select>
      <div className={value.location === 'header' ? 'grid2' : ''}>
        <label>{KEY_HINT[value.location]}<input value={value.key} onChange={(e) => onChange({ ...value, key: e.target.value })} placeholder="optional" autoComplete="off" /></label>
        {value.location === 'header' && <label>Scheme<input value={value.scheme} onChange={(e) => onChange({ ...value, scheme: e.target.value })} autoComplete="off" /></label>}
      </div>
      <p className="hint">🔒 Used only in server memory for this run. It is never saved (no database, logs, reports or traces) and is cleared from this form after you start. Resuming an interrupted run requires pasting it again.</p>
    </div>
  );
}
