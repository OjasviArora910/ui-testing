import { useState, type FormEvent } from 'react';
import { api, type Mode, type PlatformConfig } from '../api';
import {
  IconCheck,
  IconDesktop,
  IconPlay,
  IconShield,
  IconSparkles,
} from './Icons';
import { emptyToken, toDirectAuth, TokenFields, type TokenState } from './TokenFields';

type AuthChoice = 'none' | 'token' | 'profile';

const QUICK_URLS = [
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3000/legit',
  'http://127.0.0.1:3000/a11y',
  'http://127.0.0.1:3000/errors',
];

export function RunForm({
  config,
  onStarted,
}: {
  config: PlatformConfig;
  onStarted: (runId: string) => void;
}) {
  const [url, setUrl] = useState('http://127.0.0.1:3000');
  const [authChoice, setAuthChoice] = useState<AuthChoice>('none');
  const [token, setToken] = useState<TokenState>(emptyToken);
  const [profile, setProfile] = useState(config.authProfiles[0]?.name ?? '');
  const [mode, setMode] = useState<Mode>(config.aiConfigured ? 'ai_assisted' : 'deterministic');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [limits, setLimits] = useState({ maxPages: '', maxDepth: '', maxActions: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isValidUrl = (val: string) => {
    try {
      const u = new URL(val);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmed = url.trim();
    if (!isValidUrl(trimmed)) {
      setError('Please provide a valid URL starting with http:// or https://');
      return;
    }


    const auth = authChoice === 'token' ? toDirectAuth(token) : undefined;
    if (authChoice === 'token' && !auth) {
      setError('Please paste a token or switch back to "Public pages".');
      return;
    }

    setBusy(true);
    try {
      const overrides = Object.fromEntries(
        Object.entries(limits)
          .filter(([, v]) => v !== '')
          .map(([k, v]) => [k, Number(v)])
      );

      const { runId } = await api.start({
        url: trimmed,
        mode,
        viewports: [{ name: 'desktop', width: 1440, height: 900 }],
        ...(auth ? { auth } : {}),
        ...(authChoice === 'profile' && profile ? { authProfile: profile } : {}),
        ...(Object.keys(overrides).length ? { overrides } : {}),
      });

      onStarted(runId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setToken((t) => ({ ...t, token: '' })); // clear secret from memory
      setBusy(false);
    }
  }

  return (
    <form className="config-panel" onSubmit={submit} autoComplete="off">
      <div className="panel-header">
        <div className="panel-badge">
          <IconPlay style={{ width: 10, height: 10 }} />
          Configuration
        </div>
        <h2 className="panel-title">Start Autonomous QA Test</h2>
        <p className="panel-subtitle">Point the bot at any URL for automated functional, responsive, and a11y inspection.</p>
      </div>

      {error && <div className="banner banner-error">{error}</div>}

      {/* Target URL */}
      <section className="config-section">
        <label htmlFor="target-url" className="section-label">
          Target Web Application URL
        </label>
        <div className="url-input-wrapper">
          <input
            id="target-url"
            type="url"
            required
            placeholder="https://example.com or http://127.0.0.1:3000"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className={`form-input url-input ${url && !isValidUrl(url) ? 'input-error' : ''}`}
          />
          {url && isValidUrl(url) && (
            <span className="url-valid-badge" title="Valid URL protocol">
              <IconCheck style={{ width: 12, height: 12 }} />
            </span>
          )}
        </div>

        {/* Quick URL Chips */}
        <div className="quick-chips">
          <span className="chips-label">Quick fill:</span>
          {QUICK_URLS.map((q) => (
            <button
              key={q}
              type="button"
              className={`chip-btn ${url === q ? 'chip-active' : ''}`}
              onClick={() => setUrl(q)}
            >
              {q.replace('http://127.0.0.1:3000', 'demo')}
            </button>
          ))}
        </div>
      </section>

      {/* Authentication */}
      <section className="config-section">
        <label className="section-label">Authentication Method</label>
        <div className="choice-grid">
          <button
            type="button"
            className={`choice-card ${authChoice === 'none' ? 'choice-card-active' : ''}`}
            onClick={() => setAuthChoice('none')}
          >
            <div className="choice-card-radio">
              {authChoice === 'none' && <div className="choice-card-radio-dot" />}
            </div>
            <div className="choice-card-content">
              <div className="choice-card-title">Public Pages</div>
              <div className="choice-card-desc">No login required; tests unauthenticated UI and login forms</div>
            </div>
          </button>

          <button
            type="button"
            className={`choice-card ${authChoice === 'token' ? 'choice-card-active' : ''}`}
            onClick={() => setAuthChoice('token')}
          >
            <div className="choice-card-radio">
              {authChoice === 'token' && <div className="choice-card-radio-dot" />}
            </div>
            <div className="choice-card-content">
              <div className="choice-card-title">JWT / Access Token</div>
              <div className="choice-card-desc">Supply token in memory (cookie, storage, or header)</div>
            </div>
          </button>

          {config.authProfiles.length > 0 && (
            <button
              type="button"
              className={`choice-card ${authChoice === 'profile' ? 'choice-card-active' : ''}`}
              onClick={() => setAuthChoice('profile')}
            >
              <div className="choice-card-radio">
                {authChoice === 'profile' && <div className="choice-card-radio-dot" />}
              </div>
              <div className="choice-card-content">
                <div className="choice-card-title">Server Auth Profile</div>
                <div className="choice-card-desc">Uses pre-configured server secret from qa.auth.json</div>
              </div>
            </button>
          )}
        </div>

        {authChoice === 'token' && (
          <div className="animated-reveal">
            <TokenFields value={token} onChange={setToken} idPrefix="new" />
          </div>
        )}

        {authChoice === 'profile' && config.authProfiles.length > 0 && (
          <div className="animated-reveal profile-select-wrapper">
            <label className="form-label">Select Server Profile</label>
            <select
              aria-label="Auth profile"
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
              className="form-select"
            >
              {config.authProfiles.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} ({p.location})
                </option>
              ))}
            </select>
          </div>
        )}
      </section>

      {/* Testing Mode */}
      <section className="config-section">
        <label className="section-label">Testing Intelligence Mode</label>
        <div className="choice-grid">
          <button
            type="button"
            className={`choice-card ${mode === 'deterministic' ? 'choice-card-active' : ''}`}
            onClick={() => setMode('deterministic')}
          >
            <div className="choice-card-radio">
              {mode === 'deterministic' && <div className="choice-card-radio-dot" />}
            </div>
            <div className="choice-card-content">
              <div className="choice-card-title">
                Deterministic Engine
                <span className="badge badge-neutral">Standard</span>
              </div>
              <div className="choice-card-desc">Deterministic rules, crawler, geometry, a11y, and functional tests (fastest)</div>
            </div>
          </button>

          <button
            type="button"
            className={`choice-card ${mode === 'ai_assisted' ? 'choice-card-active' : ''} ${!config.aiConfigured ? 'choice-disabled' : ''}`}
            onClick={() => config.aiConfigured && setMode('ai_assisted')}
            disabled={!config.aiConfigured}
          >
            <div className="choice-card-radio">
              {mode === 'ai_assisted' && <div className="choice-card-radio-dot" />}
            </div>
            <div className="choice-card-content">
              <div className="choice-card-title">
                AI-Assisted Analysis
                <span className="badge badge-brand">
                  <IconSparkles style={{ width: 10, height: 10 }} />
                  {config.aiConfigured ? 'Recommended' : 'Requires AI Key'}
                </span>
              </div>
              <div className="choice-card-desc">Adds LLM root cause analysis, false-positive detection & priority ranking</div>
            </div>
          </button>

          <button
            type="button"
            className={`choice-card ${mode === 'exploratory' ? 'choice-card-active' : ''} ${!config.aiConfigured ? 'choice-disabled' : ''}`}
            onClick={() => config.aiConfigured && setMode('exploratory')}
            disabled={!config.aiConfigured}
          >
            <div className="choice-card-radio">
              {mode === 'exploratory' && <div className="choice-card-radio-dot" />}
            </div>
            <div className="choice-card-content">
              <div className="choice-card-title">
                Exploratory ReAct Agent
                <span className="badge badge-purple">Autonomous</span>
              </div>
              <div className="choice-card-desc">AI agent explores UI autonomously, tries alternative paths & inspects edge cases</div>
            </div>
          </button>
        </div>
      </section>

      {/* Viewport */}
      <section className="config-section">
        <label className="section-label mb-2">Target Viewport</label>
        <div className="viewports-grid" style={{ gridTemplateColumns: '1fr' }}>
          <div className="viewport-card viewport-card-active" style={{ cursor: 'default' }}>
            <div className="viewport-header">
              <span className="viewport-icon"><IconDesktop style={{ width: 16, height: 16 }} /></span>
              <div className="viewport-checkbox checked">
                <IconCheck style={{ width: 10, height: 10 }} />
              </div>
            </div>
            <div className="viewport-name">Desktop Only</div>
            <div className="viewport-dims">1440 × 900</div>
          </div>
        </div>
      </section>

      {/* Advanced Limits Toggle */}
      <div className="advanced-toggle-wrapper">
        <button
          type="button"
          className="btn-text"
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          {showAdvanced ? '− Hide Crawler Limits' : '+ Advanced Crawler Limits (Pages, Depth, Budget)'}
        </button>

        {showAdvanced && (
          <div className="advanced-drawer animated-reveal">
            <div className="form-grid-3">
              <div className="form-group">
                <label className="form-label">Max Pages</label>
                <input
                  type="number"
                  placeholder={String(config.limits.maxPages)}
                  value={limits.maxPages}
                  onChange={(e) => setLimits({ ...limits, maxPages: e.target.value })}
                  className="form-input form-input-sm"
                  min="1"
                  max="100"
                />
              </div>
              <div className="form-group">
                <label className="form-label">Max Depth</label>
                <input
                  type="number"
                  placeholder={String(config.limits.maxDepth)}
                  value={limits.maxDepth}
                  onChange={(e) => setLimits({ ...limits, maxDepth: e.target.value })}
                  className="form-input form-input-sm"
                  min="1"
                  max="10"
                />
              </div>
              <div className="form-group">
                <label className="form-label">Action Budget</label>
                <input
                  type="number"
                  placeholder={String(config.limits.maxActions)}
                  value={limits.maxActions}
                  onChange={(e) => setLimits({ ...limits, maxActions: e.target.value })}
                  className="form-input form-input-sm"
                  min="10"
                  max="500"
                />
              </div>
            </div>
            <p className="hint mt-1">Leaves empty to use standard defaults from qa.config.json.</p>
          </div>
        )}
      </div>

      {/* Primary CTA */}
      <div className="cta-wrapper">
        <button
          type="submit"
          disabled={busy}
          className={`btn btn-primary btn-cta ${busy ? 'btn-busy' : ''}`}
        >
          {busy ? (
            <>
              <div className="spinner-dots">
                <span /><span /><span />
              </div>
              <span>Launching Orchestrator...</span>
            </>
          ) : (
            <>
              <IconPlay style={{ width: 16, height: 16 }} />
              <span>START AUTONOMOUS QA TEST</span>
            </>
          )}
        </button>
        <div className="cta-guarantee">
          <IconShield style={{ width: 12, height: 12 }} />
          <span>Gated by ActionGuard: No destructive writes or payments</span>
        </div>
      </div>
    </form>
  );
}
