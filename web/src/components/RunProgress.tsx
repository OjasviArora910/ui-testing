import { useEffect, useState } from 'react';
import type { ProgressEvent, Snapshot } from '../api';

interface RunProgressProps {
  runId: string;
  snapshot: Snapshot | null;
  status: string;
  url: string;
  startTime?: string;
  events: ProgressEvent[];
  onStop?: () => void;
  stopping?: boolean;
}

const OUTCOME_LABEL: Record<string, string> = { EXPECTED: 'PASS', BUG: 'BUG', WARNING: 'WARNING', NEEDS_REVIEW: 'NEEDS REVIEW', BLOCKED_BY_SAFETY: 'BLOCKED', INCONCLUSIVE: 'NO EFFECT' };
const pathOf = (u: string | null | undefined): string => {
  if (!u) return '';
  try {
    const x = new URL(u);
    return x.pathname + x.search;
  } catch {
    return u;
  }
};

/** Live view of a running test: where it is, the numbers so far, and a plain log of each element tested and its result. */
export function RunProgress({ runId, snapshot: s, status, url, startTime, events, onStop, stopping }: RunProgressProps) {
  const [elapsed, setElapsed] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const start = startTime ? new Date(startTime).getTime() : Date.now();
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
      setTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  const mm = Math.floor(elapsed / 60);
  const ss = elapsed % 60;
  const c = s?.counts;
  const st = status.toUpperCase();
  const phase = st === 'DISCOVERING' || st === 'AUTHENTICATING' || st === 'CREATED' ? 'Finding pages' : st === 'ANALYZING' ? 'Explaining findings' : st === 'REPORTING' || st === 'REVIEW' ? 'Writing the report' : 'Testing elements';
  const results = events.filter((e) => e.type === 'result').slice(-40).reverse();

  return (
    <div className="progress-panel">
      <div className="progress-header">
        <div className="progress-title-group">
          <div className="live-indicator-wrapper">
            <span className="live-pulse" />
            <span className="live-text">{stopping ? 'STOPPING' : 'RUNNING'}</span>
          </div>
          <h2 className="progress-target-url">{url}</h2>
        </div>
        <div className="progress-meta-actions">
          <div className="elapsed-badge">
            <span className="elapsed-label">Elapsed:</span>
            <span className="elapsed-time">{mm}:{ss < 10 ? '0' : ''}{ss}</span>
          </div>
          {onStop && (
            <button type="button" className="btn btn-danger btn-sm" onClick={onStop} disabled={stopping}>
              {stopping ? 'Stopping…' : 'Stop Run'}
            </button>
          )}
        </div>
      </div>

      <div className="live-now">
        <span className="live-now-phase">{phase}</span>
        {s?.currentPage && <span className="live-now-page">Page: <code>{pathOf(s.currentPage) || '/'}</code></span>}
        {c && <span className="live-now-page">Pages {c.pagesTested}/{c.pagesCrawled}</span>}
      </div>

      <div className="live-split">
        <div className="live-log" aria-live="polite">
          {results.length === 0 ? (
            <p className="live-log-empty">Element results will appear here as each one is tested.</p>
          ) : (
            results.map((e) => {
              const d = (e.data ?? {}) as { page?: string; element?: string; kind?: string; outcome?: string; actual?: string };
              return (
                <div className="live-log-row" key={e.seq}>
                  <span className={`result-class rc-${d.outcome}`}>{OUTCOME_LABEL[d.outcome ?? ''] ?? d.outcome}</span>
                  <span className="live-log-what">
                    <strong>{d.element || d.kind}</strong>
                    <span className="live-log-detail"> — {d.actual}</span>
                  </span>
                  <code className="live-log-page">{pathOf(d.page)}</code>
                </div>
              );
            })
          )}
        </div>
        <img className="live-shot" alt="Current browser view" src={`/api/runs/${runId}/live-preview?t=${Math.floor(tick / 2)}`} />
      </div>
    </div>
  );
}
