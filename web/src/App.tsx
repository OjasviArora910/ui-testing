import { useCallback, useEffect, useState } from 'react';
import { api, type PlatformConfig, type Run } from './api';
import {
  IconExternalLink,
  IconLayers,
  IconLogo,
  IconPlay,
  IconRefresh,
  IconShield,
  IconSparkles,
} from './components/Icons';
import { RunForm } from './components/RunForm';
import { RunList } from './components/RunList';
import { RunView } from './components/RunView';
import { ToastContainer } from './components/Toast';

type AppScreen = 'new' | 'live' | 'results';

export function App() {
  const [config, setConfig] = useState<PlatformConfig | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [screen, setScreen] = useState<AppScreen>('new');

  const refreshRuns = useCallback(() => {
    api
      .runs()
      .then(setRuns)
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    api
      .config()
      .then(setConfig)
      .catch((e: Error) => setError(`Cannot reach QA platform API: ${e.message}`));
    refreshRuns();
  }, [refreshRuns]);

  useEffect(() => {
    if (!selected && runs[0]) setSelected(runs[0].id);
  }, [runs, selected]);

  const activeRunCount = runs.filter((r) => r.active).length;
  const selectedRun = runs.find((r) => r.id === selected) ?? null;

  useEffect(() => {
    if (screen === 'new' && selectedRun?.active) {
      setScreen('live');
    }
  }, [screen, selectedRun?.active]);

  return (
    <div className="app-shell">
      <ToastContainer />

      {/* Modern SaaS Top Navigation Header */}
      <header className="navbar">
        <div className="navbar-container">
          <div className="navbar-brand-group">
            <div className="navbar-logo-badge">
              <IconLogo style={{ width: 20, height: 20 }} className="brand-logo-icon" />
            </div>
            <div className="navbar-title-group">
              <span className="navbar-product-name">Autonomous UI/UX QA</span>
              <span className="navbar-product-tag">Platform 2.0</span>
            </div>
          </div>

          {/* Center Navigation Links */}
          <nav className="navbar-links" aria-label="Main Navigation">
            <button
              type="button"
              className={`nav-link-btn ${screen === 'new' ? 'nav-link-active' : ''}`}
              onClick={() => setScreen('new')}
            >
              <IconPlay style={{ width: 14, height: 14 }} />
              <span>New Test</span>
            </button>
            <button
              type="button"
              className={`nav-link-btn ${screen === 'live' ? 'nav-link-active' : ''}`}
              onClick={() => setScreen('live')}
              disabled={!selected}
            >
              <span className="live-dot" />
              <span>Live Execution</span>
            </button>
            <button
              type="button"
              className={`nav-link-btn ${screen === 'results' ? 'nav-link-active' : ''}`}
              onClick={() => setScreen('results')}
              disabled={runs.length === 0}
            >
              <IconLayers style={{ width: 14, height: 14 }} />
              <span>Results Dashboard</span>
              {runs.length > 0 && <span className="nav-badge">{runs.length}</span>}
            </button>
            <a
              href="http://127.0.0.1:3000"
              target="_blank"
              rel="noreferrer"
              className="nav-link-btn"
              title="Open the local Demo Target App"
            >
              <span>Demo App (:3000)</span>
              <IconExternalLink style={{ width: 12, height: 12 }} />
            </a>
          </nav>

          {/* Right Status Group */}
          <div className="navbar-status-group">
            {activeRunCount > 0 && (
              <div className="active-runs-badge" title="Tests currently running">
                <span className="live-dot" />
                <span>{activeRunCount} Active Run</span>
              </div>
            )}

            {config && (
              <div
                className={`ai-indicator-pill ${config.aiConfigured ? 'ai-online' : 'ai-offline'}`}
                title={
                  config.aiConfigured
                    ? `AI Connected: ${config.aiProvider?.name} (${config.aiProvider?.model})`
                    : 'AI provider not configured in .env'
                }
              >
                <IconSparkles style={{ width: 13, height: 13 }} />
                <span>
                  {config.aiConfigured
                    ? `${config.aiProvider?.name || 'AI'}: ${config.aiProvider?.model || 'Ready'}`
                    : 'AI: Deterministic Only'}
                </span>
              </div>
            )}

            <div className="user-profile-badge" title="Local QA Environment">
              <span className="profile-avatar">QA</span>
              <span className="profile-name">Workspace Admin</span>
            </div>
          </div>
        </div>
      </header>

      {error && (
        <div className="global-error-banner" role="alert">
          <div className="error-content">
            <strong>Connection Error:</strong> {error}
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={refreshRuns}>
            <IconRefresh style={{ width: 14, height: 14 }} />
            Retry
          </button>
        </div>
      )}

      <div className={`app-workspace app-screen-${screen}`}>
        {screen === 'new' && (
          <main className="workspace-main new-test-main">
            {config ? (
              <div className="new-test-panel animated-reveal">
                <RunForm
                  config={config}
                  onStarted={(id) => {
                    setSelected(id);
                    setScreen('live');
                    refreshRuns();
                  }}
                />
              </div>
            ) : (
              <div className="loading-state-wrapper">
                <div className="spinner-lg" />
                <p className="loading-text">Loading platform configuration...</p>
              </div>
            )}
          </main>
        )}

        {screen === 'live' && (
          <main className="workspace-main live-test-main">
            {selected ? (
              <RunView
                key={selected}
                runId={selected}
                mode="live"
                onChange={refreshRuns}
                onViewResults={() => setScreen('results')}
              />
            ) : (
              <div className="welcome-empty-state">
                <div className="welcome-icon-box">
                  <IconShield style={{ width: 44, height: 44 }} />
                </div>
                <h2 className="welcome-title">No active run selected</h2>
                <p className="welcome-subtitle">Start a new test to watch live execution here.</p>
                <div className="welcome-actions">
                  <button type="button" className="btn btn-primary" onClick={() => setScreen('new')}>
                    <IconPlay style={{ width: 14, height: 14 }} />
                    New Test
                  </button>
                </div>
              </div>
            )}
          </main>
        )}

        {screen === 'results' && (
          <>
            <aside className="workspace-sidebar results-sidebar">
              <RunList
                runs={runs}
                selected={selected}
                onSelect={(id) => {
                  setSelected(id);
                  setScreen('results');
                }}
                onRefresh={refreshRuns}
              />
            </aside>
            <main className="workspace-main results-main">
              {selectedRun ? (
                <RunView key={selectedRun.id} runId={selectedRun.id} mode="results" onChange={refreshRuns} />
              ) : (
                <div className="welcome-empty-state">
                  <div className="welcome-icon-box">
                    <IconShield style={{ width: 44, height: 44 }} />
                  </div>
                  <h2 className="welcome-title">No completed run selected</h2>
                  <p className="welcome-subtitle">Completed and historical runs will appear in this dashboard.</p>
                  <div className="welcome-actions">
                    <button type="button" className="btn btn-primary" onClick={() => setScreen('new')}>
                      <IconPlay style={{ width: 14, height: 14 }} />
                      Start a Test Run
                    </button>
                  </div>
                </div>
              )}
            </main>
          </>
        )}
      </div>
    </div>
  );
}
