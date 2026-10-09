import { useMemo, useState, type FormEvent } from 'react';
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
type WizardStep = 0 | 1 | 2 | 3;
const LAST_STEP: WizardStep = 3;

const QUICK_URLS = [
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3000/legit',
  'http://127.0.0.1:3000/a11y',
  'http://127.0.0.1:3000/errors',
];

const STEPS = [
  { title: 'Target Website', desc: 'Choose the URL and crawl scope.' },
  { title: 'Authentication', desc: 'Select public or token-based access.' },
  { title: 'Testing Mode', desc: 'Choose deterministic or AI-assisted analysis.' },
  { title: 'Viewport & Limits', desc: 'Confirm viewport and crawler limits.' },
] as const;

export function RunForm({
  config,
  onStarted,
}: {
  config: PlatformConfig;
  onStarted: (runId: string) => void;
}) {
  const [step, setStep] = useState<WizardStep>(0);
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
  const [url, setUrl] = useState('http://127.0.0.1:3000');
  const [authChoice, setAuthChoice] = useState<AuthChoice>('none');
  const [token, setToken] = useState<TokenState>(emptyToken);
  const [profile, setProfile] = useState(config.authProfiles[0]?.name ?? '');
  const [mode, setMode] = useState<Mode>(config.aiConfigured ? 'ai_assisted' : 'deterministic');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [limits, setLimits] = useState({ maxPages: '', maxDepth: '', maxActions: '' });
  const [pageOnly, setPageOnly] = useState(false);
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

  const trimmedUrl = url.trim();
  const urlError = url && !isValidUrl(trimmedUrl) ? 'Enter a valid URL starting with http:// or https://' : null;
  const tokenReady = authChoice !== 'token' || !!toDirectAuth(token);
  const canGoNext = step === 0 ? isValidUrl(trimmedUrl) : step === 1 ? tokenReady : true;

  const stepClass = useMemo(
    () => `wizard-step-panel wizard-${direction}`,
    [direction, step],
  );

  const validateCurrentStep = () => {
    setError(null);
    if (step === 0 && !isValidUrl(trimmedUrl)) {
      setError('Please provide a valid URL starting with http:// or https://');
      return false;
    }
    if (step === 1 && authChoice === 'token' && !toDirectAuth(token)) {
      setError('Please paste a token or switch back to Public Pages.');
      return false;
    }
    return true;
  };

  const goBack = () => {
    setError(null);
    setDirection('back');
    setStep((s) => Math.max(0, s - 1) as WizardStep);
  };

  const goToStep = (target: WizardStep) => {
    if (target === step) return;
    if (target > step && !validateCurrentStep()) return;
    setDirection(target > step ? 'forward' : 'back');
    setStep(target);
  };

  const goNext = () => {
    if (!validateCurrentStep()) return;
    setDirection('forward');
    setStep((current) => Math.min(LAST_STEP, current + 1) as WizardStep);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (step !== 3) {
      goNext();
      return;
    }

    if (!isValidUrl(trimmedUrl)) {
      setError('Please provide a valid URL starting with http:// or https://');
      setStep(0);
      return;
    }

    const auth = authChoice === 'token' ? toDirectAuth(token) : undefined;
    if (authChoice === 'token' && !auth) {
      setError('Please paste a token or switch back to Public Pages.');
      setStep(1);
      return;
    }

    if (busy) return;
    setBusy(true);
    try {
      const overrides: Record<string, unknown> = Object.fromEntries(
        Object.entries(limits)
          .filter(([, v]) => v !== '')
          .map(([k, v]) => [k, Number(v)])
      );

      const { runId } = await api.start({
        url: trimmedUrl,
        scope: pageOnly ? 'page' : 'site',
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
      setToken((t) => ({ ...t, token: '' }));
      setBusy(false);
    }
  }

  return (
    <form className="config-panel wizard-panel" onSubmit={submit} autoComplete="off">
      <div className="panel-header wizard-header">
        <div className="panel-badge">
          <IconPlay style={{ width: 10, height: 10 }} />
          Configuration
        </div>
        <h2 className="panel-title">Start Autonomous QA Test</h2>
        <p className="panel-subtitle">Configure the test in four focused steps. Nothing starts until the final button.</p>
      </div>

      <ol className="wizard-progress" aria-label="Configuration steps">
        {STEPS.map((item, index) => {
          const complete = index < step;
          const active = index === step;
          const target = index as WizardStep;
          return (
            <li key={item.title} className={`${active ? 'active' : ''} ${complete ? 'complete' : ''}`}>
              <button type="button" onClick={() => goToStep(target)} aria-current={active ? 'step' : undefined}>
                <span className="wizard-step-dot">{complete ? <IconCheck style={{ width: 12, height: 12 }} /> : index + 1}</span>
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.desc}</small>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {error && <div className="banner banner-error wizard-error">{error}</div>}

      <div className="wizard-stage" key={step}>
        {step === 0 && (
          <section className={stepClass}>
            <div className="wizard-step-copy">
              <h3>Target Website</h3>
              <p>Point the runner at the site or exact page you want to inspect.</p>
            </div>

            <div className="config-section">
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
                  onChange={(e) => {
                    setUrl(e.target.value);
                    if (error) setError(null);
                  }}
                  className={`form-input url-input ${urlError ? 'input-error' : ''}`}
                />
                {url && isValidUrl(trimmedUrl) && (
                  <span className="url-valid-badge" title="Valid URL protocol">
                    <IconCheck style={{ width: 12, height: 12 }} />
                  </span>
                )}
              </div>
              {urlError && <p className="field-error">{urlError}</p>}

              <label className="scope-toggle" htmlFor="page-only">
                <input id="page-only" type="checkbox" checked={pageOnly} onChange={(e) => setPageOnly(e.target.checked)} />
                <span>
                  <strong>Test this page only</strong>
                  <span className="scope-toggle-hint">
                    {pageOnly ? 'Only the exact URL above is tested. No other page is crawled or tested.' : 'Unchecked: the site is crawled from this URL and every page found is tested.'}
                  </span>
                </span>
              </label>

              <div className="quick-chips">
                <span className="chips-label">Quick fill:</span>
                {QUICK_URLS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    className={`chip-btn ${url === q ? 'chip-active' : ''}`}
                    onClick={() => {
                      setUrl(q);
                      setError(null);
                    }}
                  >
                    {q.replace('http://127.0.0.1:3000', 'demo')}
                  </button>
                ))}
              </div>
            </div>
          </section>
        )}

        {step === 1 && (
          <section className={stepClass}>
            <div className="wizard-step-copy">
              <h3>Authentication</h3>
              <p>Run as a public visitor, inject a one-time token, or use an existing server profile.</p>
            </div>

            <div className="config-section">
              <label className="section-label">Authentication Method</label>
              <div className="choice-grid wizard-choice-grid">
                <button
                  type="button"
                  className={`choice-card ${authChoice === 'none' ? 'choice-card-active' : ''}`}
                  onClick={() => {
                    setAuthChoice('none');
                    setError(null);
                  }}
                >
                  <div className="choice-card-radio">
                    {authChoice === 'none' && <div className="choice-card-radio-dot" />}
                  </div>
                  <div className="choice-card-content">
                    <div className="choice-card-title">Public Pages</div>
                    <div className="choice-card-desc">No login required; tests unauthenticated UI and login forms.</div>
                  </div>
                </button>

                <button
                  type="button"
                  className={`choice-card ${authChoice === 'token' ? 'choice-card-active' : ''}`}
                  onClick={() => {
                    setAuthChoice('token');
                    setError(null);
                  }}
                >
                  <div className="choice-card-radio">
                    {authChoice === 'token' && <div className="choice-card-radio-dot" />}
                  </div>
                  <div className="choice-card-content">
                    <div className="choice-card-title">JWT / Access Token</div>
                    <div className="choice-card-desc">Supply token in memory using cookie, storage, or request header injection.</div>
                  </div>
                </button>

                {config.authProfiles.length > 0 && (
                  <button
                    type="button"
                    className={`choice-card ${authChoice === 'profile' ? 'choice-card-active' : ''}`}
                    onClick={() => {
                      setAuthChoice('profile');
                      setError(null);
                    }}
                  >
                    <div className="choice-card-radio">
                      {authChoice === 'profile' && <div className="choice-card-radio-dot" />}
                    </div>
                    <div className="choice-card-content">
                      <div className="choice-card-title">Server Auth Profile</div>
                      <div className="choice-card-desc">Uses pre-configured server secret from qa.auth.json.</div>
                    </div>
                  </button>
                )}
              </div>

              {authChoice === 'token' && (
                <div className="animated-reveal">
                  <TokenFields
                    value={token}
                    onChange={(next) => {
                      setToken(next);
                      if (error) setError(null);
                    }}
                    idPrefix="new"
                  />
                  {!tokenReady && <p className="field-error">Paste a token before continuing, or choose Public Pages.</p>}
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
            </div>
          </section>
        )}

        {step === 2 && (
          <section className={stepClass}>
            <div className="wizard-step-copy">
              <h3>Testing Intelligence Mode</h3>
              <p>Choose how much reasoning the platform should add on top of deterministic browser checks.</p>
            </div>

            <div className="config-section">
              <label className="section-label">Testing Intelligence Mode</label>
              <div className="choice-grid wizard-choice-grid">
                <button
                  type="button"
                  className={`choice-card wizard-mode-card ${mode === 'deterministic' ? 'choice-card-active' : ''}`}
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
                    <div className="choice-card-desc">
                      Deterministic rules, crawler, geometry, accessibility where enabled, and functional tests.
                    </div>
                  </div>
                </button>

                <button
                  type="button"
                  className={`choice-card wizard-mode-card ${mode === 'ai_assisted' ? 'choice-card-active' : ''} ${!config.aiConfigured ? 'choice-disabled' : ''}`}
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
                    <div className="choice-card-desc">
                      Adds optional LLM root cause analysis, false-positive assessment, and priority ranking.
                    </div>
                  </div>
                </button>
              </div>
            </div>
          </section>
        )}

        {step === 3 && (
          <section className={stepClass}>
            <div className="wizard-step-copy">
              <h3>Target Viewport & Advanced Settings</h3>
              <p>Confirm the browser size and optional crawler limits before starting the run.</p>
            </div>

            <section className="config-section">
              <label className="section-label mb-2">Target Viewport</label>
              <div className="viewports-grid wizard-viewport-grid">
                <div className="viewport-card viewport-card-active" style={{ cursor: 'default' }}>
                  <div className="viewport-header">
                    <span className="viewport-icon"><IconDesktop style={{ width: 16, height: 16 }} /></span>
                    <div className="viewport-checkbox checked">
                      <IconCheck style={{ width: 10, height: 10 }} />
                    </div>
                  </div>
                  <div className="viewport-name">Desktop Only</div>
                  <div className="viewport-dims">1440 x 900</div>
                </div>
              </div>
            </section>

            <div className="advanced-toggle-wrapper">
              <button
                type="button"
                className="btn-text wizard-advanced-toggle"
                onClick={() => setShowAdvanced(!showAdvanced)}
              >
                {showAdvanced ? '- Hide Crawler Limits' : '+ Advanced Crawler Limits (Pages, Depth, Budget)'}
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

            <div className="cta-guarantee wizard-actionguard">
              <IconShield style={{ width: 12, height: 12 }} />
              <span>Gated by ActionGuard: No destructive writes or payments</span>
            </div>
          </section>
        )}
      </div>

      <div className="wizard-actions">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={(e) => {
            e.preventDefault();
            goBack();
          }}
          disabled={step === 0 || busy}
        >
          ← Back
        </button>

        {step < 3 ? (
          <button
            key="wizard-next"
            type="button"
            className="btn btn-primary"
            onClick={(e) => {
              e.preventDefault();
              goNext();
            }}
            disabled={!canGoNext || busy}
          >
            Next →
          </button>
        ) : (
          <button
            key="wizard-start"
            type="submit"
            disabled={busy}
            className={`btn btn-primary btn-cta wizard-start ${busy ? 'btn-busy' : ''}`}
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
                <span>Start Autonomous QA Test →</span>
              </>
            )}
          </button>
        )}
      </div>
    </form>
  );
}
