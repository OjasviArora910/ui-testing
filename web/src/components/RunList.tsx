import type { Run } from '../api';
import { VerdictBadge } from './VerdictBadge';

export function RunList({ runs, selected, onSelect, onRefresh }: { runs: Run[]; selected: string | null; onSelect: (id: string) => void; onRefresh: () => void }) {
  return (
    <div className="panel">
      <div className="row between"><h2>Recent runs</h2><button className="link" onClick={onRefresh}>Refresh</button></div>
      {runs.length === 0 && <p className="muted">No runs yet.</p>}
      <ul className="runs">
        {runs.map((r) => (
          <li key={r.id}>
            <button className={`run-item ${selected === r.id ? 'active' : ''}`} onClick={() => onSelect(r.id)}>
              <span className="run-url">{r.url}</span>
              <span className="row gap">
                <span className="muted">{new Date(r.createdAt).toLocaleString()}</span>
                {r.verdict ? <VerdictBadge verdict={r.verdict} small /> : <span className="tag">{r.interrupted ? 'interrupted' : r.status}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
