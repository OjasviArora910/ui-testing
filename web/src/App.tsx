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

export function App() {
  const [config, setConfig] = useState<PlatformConfig | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sidebarTab, setSidebarTab] = useState<'new' | 'history'>('new');

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
              className={`nav-link-btn ${sidebarTab === 'new' ? 'nav-link-active' : ''}`}
              onClick={() => setSidebarTab('new')}
            >
              <IconPlay style={{ width: 14, height: 14 }} />
              <span>New Test</span>
            </button>
            <button
              type="button"
              className={`nav-link-btn ${sidebarTab === 'history' ? 'nav-link-active' : ''}`}
              onClick={() => setSidebarTab('history')}
            >
              <IconLayers style={{ width: 14, height: 14 }} />
              <span>Test Runs</span>
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

      {/* Main SaaS Workspace Layout */}
      <div className="app-workspace">
        <aside className="workspace-sidebar">
          {/* Sidebar Tab Toggle for Mobile/Tablet or quick switching */}
          <div className="sidebar-tab-switcher">
            <button
              type="button"
              className={`sidebar-tab-btn ${sidebarTab === 'new' ? 'active' : ''}`}
              onClick={() => setSidebarTab('new')}
            >
              New Test Config
            </button>
            <button
              type="button"
              className={`sidebar-tab-btn ${sidebarTab === 'history' ? 'active' : ''}`}
              onClick={() => setSidebarTab('history')}
            >
              History ({runs.length})
            </button>
          </div>

          {sidebarTab === 'new' && config && (
            <div className="sidebar-card-wrap animated-reveal">
              <RunForm
                config={config}
                onStarted={(id) => {
                  setSelected(id);
                  refreshRuns();
                }}
              />
            </div>
          )}

          {sidebarTab === 'history' && (
            <div className="sidebar-card-wrap animated-reveal">
              <RunList
                runs={runs}
                selected={selected}
                onSelect={(id) => setSelected(id)}
                onRefresh={refreshRuns}
              />
            </div>
          )}

          {/* Desktop persistent secondary history panel if on new tab */}
          {sidebarTab === 'new' && runs.length > 0 && (
            <div className="desktop-history-preview">
              <RunList
                runs={runs.slice(0, 5)}
                selected={selected}
                onSelect={(id) => setSelected(id)}
                onRefresh={refreshRuns}
              />
            </div>
          )}
        </aside>

        <main className="workspace-main">
          {selected ? (
            <RunView key={selected} runId={selected} onChange={refreshRuns} />
          ) : (
            <div className="welcome-empty-state">
              <div className="welcome-icon-box">
                <IconShield style={{ width: 44, height: 44 }} />
              </div>
              <h2 className="welcome-title">Autonomous UI/UX QA Platform</h2>
              <p className="welcome-subtitle">
                Enter your web application URL on the left panel, pick your viewports, and launch an autonomous test to
                discover layout regressions, accessibility flaws, and functional bugs.
              </p>
              <div className="welcome-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setSidebarTab('new')}
                >
                  <IconPlay style={{ width: 14, height: 14 }} />
                  Start a Test Run
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
