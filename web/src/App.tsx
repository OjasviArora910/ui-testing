import { useCallback, useEffect, useState } from 'react';
import { api, type PlatformConfig, type Run } from './api';
import { RunForm } from './components/RunForm';
import { RunList } from './components/RunList';
import { RunView } from './components/RunView';

export function App() {
  const [config, setConfig] = useState<PlatformConfig | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshRuns = useCallback(() => { api.runs().then(setRuns).catch((e: Error) => setError(e.message)); }, []);
  useEffect(() => {
    api.config().then(setConfig).catch((e: Error) => setError(`Cannot reach the API: ${e.message}`));
    refreshRuns();
  }, [refreshRuns]);
  useEffect(() => { if (!selected && runs[0]) setSelected(runs[0].id); }, [runs, selected]);

  return (
    <div className="app">
      <header className="topbar">
        <strong>Autonomous UI/UX QA</strong>
        <span className="muted">
          {config ? (config.aiConfigured ? `AI: ${config.aiProvider?.name} / ${config.aiProvider?.model}` : 'AI not configured (deterministic only)') : ''}
        </span>
      </header>
      {error && <div className="banner error">{error}</div>}
      <div className="layout">
        <aside className="sidebar">
          {config && <RunForm config={config} onStarted={(id) => { setSelected(id); refreshRuns(); }} />}
          <RunList runs={runs} selected={selected} onSelect={setSelected} onRefresh={refreshRuns} />
        </aside>
        <main className="content">
          {selected ? <RunView key={selected} runId={selected} onChange={refreshRuns} /> : <p className="muted">Start a test to see live progress here.</p>}
        </main>
      </div>
    </div>
  );
}
