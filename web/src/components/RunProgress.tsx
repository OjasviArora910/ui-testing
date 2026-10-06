import { useEffect, useMemo, useState } from 'react';
import type { Finding, ProgressEvent, ResultClass, Snapshot } from '../api';

interface RunProgressProps {
  runId: string;
  snapshot: Snapshot | null;
  status: string;
  url: string;
  startTime?: string;
  events: ProgressEvent[];
  findings?: Finding[];
  onStop?: () => void;
  stopping?: boolean;
}

type EventData = {
  page?: string;
  viewport?: string;
  kind?: string;
  element?: string;
  check?: string;
  outcome?: ResultClass | string;
  actual?: string;
  type?: string;
  target?: string;
  phase?: string;
  ok?: boolean;
  detail?: string | null;
  expected?: string;
  box?: { x: number; y: number; width: number; height: number; vpWidth?: number; vpHeight?: number } | null;
};

const OUTCOME_LABEL: Record<string, string> = {
  EXPECTED: 'PASS',
  BUG: 'BUG',
  WARNING: 'WARNING',
  NEEDS_REVIEW: 'REVIEW',
  BLOCKED_BY_SAFETY: 'BLOCKED',
  INCONCLUSIVE: 'NO EFFECT',
};

const pathOf = (u: string | null | undefined): string => {
  if (!u) return '';
  try {
    const x = new URL(u);
    return x.pathname + x.search || '/';
  } catch {
    return u;
  }
};

const eventData = (event: ProgressEvent | undefined): EventData => (event?.data ?? {}) as EventData;

const labelFor = (event: ProgressEvent | undefined): string => {
  const data = eventData(event);
  return data.element || data.target || data.kind || event?.message || 'Waiting for next element';
};

const resultTone = (outcome: string | undefined, ok?: boolean) => {
  if (outcome === 'BUG') return 'bug';
  if (outcome === 'WARNING' || outcome === 'NEEDS_REVIEW') return 'review';
  if (outcome === 'EXPECTED' || ok === true) return 'pass';
  return 'active';
};

/** Live execution view: a passive Playwright preview plus the exact current event/check stream from the backend. */
export function RunProgress({
  runId,
  snapshot: s,
  status,
  url,
  startTime,
  events,
  findings = [],
  onStop,
  stopping,
}: RunProgressProps) {
  const [elapsed, setElapsed] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const start = startTime ? new Date(startTime).getTime() : Date.now();
    const interval = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
      setTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  const relevantEvents = useMemo(
    () => events.filter((event) => event.type === 'action' || event.type === 'result'),
    [events]
  );
  const latest = relevantEvents.at(-1);
  const latestAction = [...events].reverse().find((event) => event.type === 'action' && eventData(event).box);
  const latestResult = [...events].reverse().find((event) => event.type === 'result');
  const currentData = eventData(latest);
  const currentLabel = labelFor(latest);
  const currentKind = currentData.kind || currentData.type || (latest?.type === 'result' ? 'result' : 'element');
  const currentCheck = currentData.check || currentData.phase || latest?.message || s?.currentAction || status;
  const outcome = currentData.outcome || (currentData.ok === false ? 'BUG' : undefined);
  const tone = resultTone(outcome, currentData.ok);

  const checksForCurrentElement = useMemo(() => {
    const current = currentLabel;
    return relevantEvents
      .filter((event) => labelFor(event) === current)
      .slice(-6)
      .map((event) => {
        const data = eventData(event);
        const eventOutcome = data.outcome || (data.ok === false ? 'BUG' : data.ok === true ? 'EXPECTED' : undefined);
        return {
          seq: event.seq,
          label: data.check || data.phase || data.type || event.type,
          detail: data.actual || data.detail || data.expected || event.message,
          tone: resultTone(eventOutcome, data.ok),
          outcome: eventOutcome,
        };
      });
  }, [currentLabel, relevantEvents]);

  const recentResults = useMemo(
    () => events.filter((event) => event.type === 'result').slice(-5).reverse(),
    [events]
  );

  const compactFindings = findings
    .filter((finding) => finding.track !== 'accessibility' && finding.category !== 'accessibility')
    .slice(0, 4);

  const box = eventData(latestAction).box;
  const overlay = box && box.width > 0 && box.height > 0
    ? {
        left: `${Math.max(0, Math.min(100, (box.x / (box.vpWidth || 1440)) * 100))}%`,
        top: `${Math.max(0, Math.min(100, (box.y / (box.vpHeight || 900)) * 100))}%`,
        width: `${Math.max(1, Math.min(100, (box.width / (box.vpWidth || 1440)) * 100))}%`,
        height: `${Math.max(1, Math.min(100, (box.height / (box.vpHeight || 900)) * 100))}%`,
      }
    : null;

  const mm = Math.floor(elapsed / 60);
  const ss = elapsed % 60;
  const counts = s?.counts;
  const previewUrl = `/api/runs/${runId}/live-preview?t=${Math.floor(tick / 2)}`;
  const page = currentData.page || s?.currentPage || url;
  const viewport = currentData.viewport || s?.currentViewport;
  const phase =
    status.toUpperCase() === 'ANALYZING'
      ? 'Analyzing findings'
      : status.toUpperCase() === 'REPORTING' || status.toUpperCase() === 'REVIEW'
        ? 'Writing report'
        : status.toUpperCase() === 'DISCOVERING' || status.toUpperCase() === 'AUTHENTICATING'
          ? 'Finding pages'
          : 'Testing elements';

  return (
    <section className="live-execution-panel" aria-label="Live test execution">
      <header className="live-execution-header">
        <div>
          <div className="live-indicator-wrapper">
            <span className="live-pulse" />
            <span className="live-text">{stopping ? 'STOPPING' : 'RUNNING'}</span>
            <span className="live-phase-label">{phase}</span>
          </div>
          <h2 className="progress-target-url" title={url}>{url}</h2>
        </div>
        <div className="progress-meta-actions">
          <div className="elapsed-badge">
            <span className="elapsed-label">Elapsed</span>
            <span className="elapsed-time">{mm}:{ss < 10 ? '0' : ''}{ss}</span>
          </div>
          {onStop && (
            <button type="button" className="btn btn-danger btn-sm" onClick={onStop} disabled={stopping}>
              {stopping ? 'Stopping...' : 'Stop'}
            </button>
          )}
        </div>
      </header>

      <div className="execution-counters" aria-label="Run counters">
        <div><span>Tested</span><strong>{counts?.elementsTested ?? 0}</strong></div>
        <div><span>Passed</span><strong>{counts?.passed ?? 0}</strong></div>
        <div><span>Bugs</span><strong className="counter-danger">{counts?.bugs ?? 0}</strong></div>
        <div><span>Review</span><strong className="counter-review">{counts?.needsReview ?? 0}</strong></div>
      </div>

      <div className="execution-primary-grid">
        <div className="live-preview-shell">
          <div className="live-preview-toolbar">
            <span className="preview-dot" />
            <span className="preview-url" title={page}>{pathOf(page) || '/'}</span>
            {viewport && <span className="preview-viewport">{viewport}</span>}
          </div>
          <div className="live-preview-stage">
            <img className="live-preview-image" alt="Live Playwright test preview" src={previewUrl} />
            {overlay && (
              <div className={`preview-target-box target-${tone}`} style={overlay}>
                <span>{OUTCOME_LABEL[outcome ?? ''] || currentData.phase || currentData.type || 'CHECKING'}</span>
              </div>
            )}
          </div>
        </div>

        <aside className="currently-testing-panel" aria-live="polite">
          <div className="panel-kicker">Currently Testing</div>
          <h3 title={currentLabel}>{currentLabel}</h3>
          <div className="current-meta-row">
            <span>{currentKind}</span>
            {viewport && <span>{viewport}</span>}
          </div>

          <div className={`current-result-card result-${tone}`}>
            <span>{OUTCOME_LABEL[outcome ?? ''] || currentData.phase || latest?.type || status}</span>
            <strong>{currentCheck}</strong>
            {(currentData.actual || currentData.detail) && <p>{currentData.actual || currentData.detail}</p>}
          </div>

          <div className="dynamic-check-list">
            {checksForCurrentElement.length === 0 ? (
              <p className="live-log-empty">Waiting for the backend to emit the next check.</p>
            ) : (
              checksForCurrentElement.map((check) => (
                <div className={`dynamic-check-row check-${check.tone}`} key={check.seq}>
                  <span className="check-state-dot" />
                  <div>
                    <strong>{check.label}</strong>
                    <p>{check.detail}</p>
                  </div>
                </div>
              ))
            )}
          </div>

          {latestResult && (
            <div className="last-result-line">
              Last result: <strong>{labelFor(latestResult)}</strong>
            </div>
          )}
        </aside>
      </div>

      <div className="execution-bottom-grid">
        <section className="compact-findings-panel">
          <div className="compact-panel-header">
            <h3>Findings</h3>
            <span>{compactFindings.length ? `${compactFindings.length} shown` : 'None yet'}</span>
          </div>
          {compactFindings.length === 0 ? (
            <p className="compact-empty">Confirmed findings will appear here as the run produces evidence.</p>
          ) : (
            <div className="compact-findings-list">
              {compactFindings.map((finding) => (
                <article className={`compact-finding finding-${finding.resultClass ?? finding.classification}`} key={finding.id}>
                  <span className="compact-finding-badge">{finding.resultClass || finding.classification}</span>
                  <div>
                    <strong>{finding.actual}</strong>
                    <p>
                      {finding.element?.name || finding.element?.selector || finding.ruleId}
                      <span>{pathOf(finding.page)}</span>
                    </p>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="recent-results-panel">
          <div className="compact-panel-header">
            <h3>Recent Results</h3>
            <span>{recentResults.length}</span>
          </div>
          {recentResults.length === 0 ? (
            <p className="compact-empty">Element results will stream in during execution.</p>
          ) : (
            <div className="recent-results-list">
              {recentResults.map((event) => {
                const data = eventData(event);
                return (
                  <div className="recent-result-row" key={event.seq}>
                    <span className={`result-class rc-${data.outcome}`}>{OUTCOME_LABEL[data.outcome ?? ''] ?? data.outcome}</span>
                    <strong>{data.element || data.kind || event.message}</strong>
                    <span>{data.check || data.actual}</span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
