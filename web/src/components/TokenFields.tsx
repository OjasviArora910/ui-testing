import type { DirectAuth, JwtLocation } from '../api';
import { IconLock, IconShield } from './Icons';

export interface TokenState {
  token: string;
  location: JwtLocation;
  key: string;
  scheme: string;
}

export const emptyToken = (): TokenState => ({ token: '', location: 'cookie', key: '', scheme: 'Bearer' });

const KEY_HINT: Record<JwtLocation, string> = {
  cookie: 'Cookie name (default: token)',
  localStorage: 'Storage key (default: token)',
  sessionStorage: 'Storage key (default: token)',
  header: 'Header name (default: Authorization)',
};

export function toDirectAuth(t: TokenState): DirectAuth | undefined {
  const token = t.token.trim();
  if (!token) return undefined;
  return {
    token,
    location: t.location,
    ...(t.key.trim() ? { key: t.key.trim() } : {}),
    ...(t.location === 'header' && t.scheme.trim() ? { scheme: t.scheme.trim() } : {}),
  };
}

export function TokenFields({
  value,
  onChange,
  idPrefix,
}: {
  value: TokenState;
  onChange: (v: TokenState) => void;
  idPrefix: string;
}) {
  return (
    <div className="token-card">
      <div className="token-card-header">
        <div className="row gap">
          <IconLock style={{ width: 14, height: 14 }} className="text-brand" />
          <span className="token-card-title">Access Token Configuration</span>
        </div>
        <span className="badge badge-subtle">
          <IconShield style={{ width: 10, height: 10 }} />
          Zero Persistence
        </span>
      </div>

      <div className="form-group">
        <label htmlFor={`${idPrefix}-token`} className="form-label">
          JWT / Bearer Token
        </label>
        <input
          id={`${idPrefix}-token`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="Paste access token (e.g. eyJhbGci...)"
          value={value.token}
          onChange={(e) => onChange({ ...value, token: e.target.value })}
          className="form-input form-input-mono"
          data-lpignore="true"
          data-1p-ignore="true"
        />
      </div>

      <div className="form-group">
        <label htmlFor={`${idPrefix}-loc`} className="form-label">
          Token Injection Location
        </label>
        <select
          id={`${idPrefix}-loc`}
          value={value.location}
          onChange={(e) => onChange({ ...value, location: e.target.value as JwtLocation })}
          className="form-select"
        >
          <option value="cookie">Cookie (Sets auth cookie before page load)</option>
          <option value="localStorage">localStorage (Injected before client scripts)</option>
          <option value="sessionStorage">sessionStorage (Injected before client scripts)</option>
          <option value="header">Authorization header (Attached to same-origin requests)</option>
        </select>
      </div>

      <div className={value.location === 'header' ? 'form-grid-2' : ''}>
        <div className="form-group">
          <label className="form-label">{KEY_HINT[value.location]}</label>
          <input
            value={value.key}
            onChange={(e) => onChange({ ...value, key: e.target.value })}
            placeholder="Optional (uses default)"
            autoComplete="off"
            className="form-input"
          />
        </div>
        {value.location === 'header' && (
          <div className="form-group">
            <label className="form-label">Header Scheme</label>
            <input
              value={value.scheme}
              onChange={(e) => onChange({ ...value, scheme: e.target.value })}
              placeholder="Bearer"
              autoComplete="off"
              className="form-input"
            />
          </div>
        )}
      </div>

      <p className="token-security-hint">
        <IconShield style={{ width: 12, height: 12, flexShrink: 0 }} />
        <span>
          <strong>Encrypted in memory only.</strong> Automatically stripped from logs, traces, reports, and SQLite storage.
        </span>
      </p>
    </div>
  );
}
