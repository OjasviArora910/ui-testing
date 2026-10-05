import type { Run } from '../api';
import { IconChevronRight, IconRefresh } from './Icons';
import { VerdictBadge } from './VerdictBadge';

export function RunList({
  runs,
  selected,
  onSelect,
  onRefresh,
}: {
  runs: Run[];
  selected: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}) {
  const formatTime = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  const getCleanUrl = (raw: string) => {
    try {
      const u = new URL(raw);
      return u.host + (u.pathname === '/' ? '' : u.pathname);
    } catch {
      return raw;
    }
  };

  return (
    <div className="history-panel">
      <div className="history-header">
        <div>
          <h3 className="history-title">Recent Test Runs</h3>
          <span className="history-count">{runs.length} test records</span>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-icon"
          onClick={onRefresh}
          title="Refresh run history"
        >
          <IconRefresh style={{ width: 14, height: 14 }} />
        </button>
      </div>

      {runs.length === 0 ? (
        <div className="history-empty">
          <p className="muted small">No test runs recorded yet.</p>
        </div>
      ) : (
        <div className="history-list">
          {runs.map((r) => {
            const isSelected = selected === r.id;
            const findingsCount = r.summary ? (r.summary.defects + r.summary.anomalies) : (r.progress?.findings ?? 0); // UI/UX findings; accessibility is counted separately
            const pagesCount = r.summary?.pages ?? r.progress?.pagesDiscovered ?? 0;

            return (
              <button
                key={r.id}
                type="button"
                className={`history-card ${isSelected ? 'history-card-active' : ''}`}
                onClick={() => onSelect(r.id)}
              >
                <div className="history-card-top">
                  <span className="history-url" title={r.url}>
                    {getCleanUrl(r.url)}
                  </span>
                  <span className="history-chevron">
                    <IconChevronRight style={{ width: 14, height: 14 }} />
                  </span>
                </div>

                <div className="history-card-middle">
                  {r.verdict ? (
                    <VerdictBadge verdict={r.verdict} small />
                  ) : (
                    <span className={`status-pill status-${(r.state ?? r.status).toLowerCase()}`}>
                      {r.state ?? r.status}
                    </span>
                  )}
                  <span className="history-findings-pill">
                    <strong>{findingsCount}</strong> findings
                  </span>
                </div>

                <div className="history-card-bottom">
                  <span className="history-meta">{formatTime(r.createdAt)}</span>
                  {pagesCount > 0 && (
                    <span className="history-meta">{pagesCount} pages</span>
                  )}
                  <span className="history-mode-tag">{r.mode.replace('_', ' ')}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
