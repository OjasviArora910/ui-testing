import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Finding, type ProgressEvent, type Run, type Snapshot } from '../api';
import { FindingCard } from './FindingCard';
import { emptyToken, toDirectAuth, TokenFields, type TokenState } from './TokenFields';

function authLabel(run: Run): string {
  if (run.auth.source === 'token') return `login: one-time token (${run.auth.location ?? 'unknown location'})`;
  if (run.auth.source === 'profile') return `login: profile "${run.auth.profile}"`;
  return 'no login';
}
import { VerdictBadge } from './VerdictBadge';

type Tab = 'review' | 'findings' | 'log';
const TERMINAL = ['COMPLETED', 'ABORTED', 'ERROR', 'REVIEW'];

export function RunView({ runId, onChange }: { runId: string; onChange: () => void }) {
  const [run, setRun] = useState<Run | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [queue, setQueue] = useState<Finding[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [tab, setTab] = useState<Tab>('review');
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeToken, setResumeToken] = useState<TokenState>(emptyToken);
  const loadedFinal = useRef(false);

  const reload = useCallback(async () => {
    try {
      const r = await api.run(runId); setRun(r); if (r.progress) setSnap(r.progress);
      const [q, f] = await Promise.all([api.queue(runId), api.findings(runId)]);
      setQueue(q); setFindings(f);
    } catch (e) { setError((e as Error).message); }
  }, [runId]);

  useEffect(() => { void reload(); }, [reload]);

  // Live progress over SSE
  useEffect(() => {
    const es = new EventSource(`/api/runs/${runId}/events`);
    es.addEventListener('snapshot', (e) => setSnap(JSON.parse((e as MessageEvent).data) as Snapshot));
    es.addEventListener('progress', (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as ProgressEvent;
      setEvents((prev) => (prev.some((p) => p.seq === ev.seq) ? prev : [...prev.slice(-400), ev]));
      if (ev.type === 'done' || ev.type === 'error' || (ev.type === 'status' && ev.message === 'REPORTING')) { void reload(); onChange(); }
    });
    return () => es.close();
  }, [runId, reload, onChange]);

  // When the run finishes, load final data once.
  useEffect(() => {
    if (snap && TERMINAL.includes(snap.status) && !loadedFinal.current) { loadedFinal.current = true; void reload(); }
  }, [snap, reload]);

  if (!run) return <p className="muted">{error ?? 'Loading…'}</p>;
  const s = snap ?? run.progress;
  const active = run.active || (s ? !TERMINAL.includes(s.status) && !run.interrupted : false);
  const pct = s && s.unitsTotal > 0 ? Math.round((s.unitsDone / s.unitsTotal) * 100) : 0;
  const problems = events.filter((e) => e.type === 'error' || e.type === 'warning');
  const shown = findings.filter((f) => !filter || f.reviewState === filter || f.category === filter);
  const categories = Object.entries(s?.categories ?? {}).sort((a, b) => b[1] - a[1]);

  async function act(fn: () => Promise<unknown>) { try { setError(null); await fn(); await reload(); onChange(); } catch (e) { setError((e as Error).message); } }

  return (
    <div>
      <div className="panel">
        <div className="row between wrap">
          <div>
            <h1 className="run-title">{run.url}</h1>
            <p className="muted">{run.id} · {run.mode} · {authLabel(run)} · {new Date(run.createdAt).toLocaleString()}</p>
          </div>
          <div className="row gap">
            {run.verdict && !active && <VerdictBadge verdict={run.verdict} />}
            {active && <button className="danger" onClick={() => act(() => api.stop(runId))}>STOP TEST</button>}
            {run.interrupted && !run.active && run.auth.source !== 'token' && <button onClick={() => act(() => api.resume(runId))}>Resume</button>}
            {run.interrupted && !run.active && run.auth.source === 'token' && !resumeOpen && <button onClick={() => { setResumeToken({ ...emptyToken(), location: (run.auth.location as TokenState['location']) ?? 'cookie' }); setResumeOpen(true); }}>Resume…</button>}
          </div>
        </div>

        {resumeOpen && (
          <form className="resume-box" autoComplete="off" onSubmit={(e) => {
            e.preventDefault();
            const auth = toDirectAuth(resumeToken);
            setResumeToken((t) => ({ ...t, token: '' }));
            if (!auth) { setError('Paste the token to resume.'); return; }
            void act(() => api.resume(runId, auth)).then(() => setResumeOpen(false));
          }}>
            <p className="small">This run logged in with a one-time token, which was never stored. Paste it again to resume.</p>
            <TokenFields value={resumeToken} onChange={setResumeToken} idPrefix="resume" />
            <div className="row gap"><button type="submit">Resume run</button><button type="button" onClick={() => { setResumeOpen(false); setResumeToken(emptyToken()); }}>Cancel</button></div>
          </form>
        )}

        <div className="stats">
          <Stat label="Status" value={s?.status ?? run.status} />
          <Stat label="Pages discovered" value={s?.pagesDiscovered ?? 0} />
          <Stat label="Page × viewport tested" value={`${s?.unitsDone ?? 0}/${s?.unitsTotal ?? 0}`} />
          <Stat label="Actions" value={s?.actionsUsed ?? 0} />
          <Stat label="Findings" value={s?.findings ?? 0} />
          <Stat label="To review" value={queue.length} />
        </div>
        {active && (
          <>
            <div className="progress"><div style={{ width: `${pct}%` }} /></div>
            <p className="muted small">Current page: <code>{s?.currentPage ?? '–'}</code> {s?.currentViewport ? `@ ${s.currentViewport}` : ''}<br />Current action: {s?.currentAction ?? '–'}</p>
          </>
        )}
        {categories.length > 0 && <p className="row gap wrap">{categories.map(([k, v]) => <button key={k} className={`tag clickable ${filter === k ? 'on' : ''}`} onClick={() => { setTab('findings'); setFilter(filter === k ? '' : k); }}>{k}: {v}</button>)}</p>}
        {run.summary && !active && (
          <p className="muted small">Defects {run.summary.defects} · awaiting review {run.summary.pendingReview} · blocked by safety guard {run.summary.guardBlocked} · visual: {run.summary.visual.pass} pass / {run.summary.visual.fail} fail / {run.summary.visual.noBaseline} no baseline</p>
        )}
        {(run.error || run.abortReason) && <div className="banner error">{run.error ?? `Stopped: ${run.abortReason}`}</div>}
        {error && <div className="banner error">{error}</div>}
        {(run.reports.html || run.reports.json || run.reports.junit) && (
          <p className="row gap">Reports:
            {run.reports.html && <a href={`/api/runs/${runId}/report.html`} target="_blank" rel="noreferrer">HTML</a>}
            {run.reports.json && <a href={`/api/runs/${runId}/report.json`}>JSON</a>}
            {run.reports.junit && <a href={`/api/runs/${runId}/report.xml`}>JUnit XML</a>}
          </p>
        )}
      </div>

      <div className="tabs">
        <button className={tab === 'review' ? 'on' : ''} onClick={() => setTab('review')}>Review queue ({queue.length})</button>
        <button className={tab === 'findings' ? 'on' : ''} onClick={() => setTab('findings')}>All findings ({findings.length})</button>
        <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>Activity {problems.length ? `(${problems.length} warnings)` : ''}</button>
      </div>

      {tab === 'review' && (
        queue.length === 0
          ? <p className="muted">{active ? 'Findings that need a human decision will appear here.' : 'Nothing awaiting review.'}</p>
          : queue.map((f) => <FindingCard key={f.id} finding={f} onDecide={(d, note) => act(() => api.decide(f.id, d, note))} onApproveBaseline={(p, v) => act(() => api.approveBaseline(runId, p, v))} />)
      )}
      {tab === 'findings' && (
        <>
          <div className="row gap wrap">
            {['', 'defect', 'pending', 'confirmed', 'dismissed', 'investigating'].map((st) => (
              <button key={st || 'all'} className={`tag clickable ${filter === st ? 'on' : ''}`} onClick={() => setFilter(st)}>{st || 'all'}</button>
            ))}
          </div>
          {shown.map((f) => <FindingCard key={f.id} finding={f} onDecide={(d, note) => act(() => api.decide(f.id, d, note))} onApproveBaseline={(p, v) => act(() => api.approveBaseline(runId, p, v))} />)}
        </>
      )}
      {tab === 'log' && (
        <div className="panel log">
          {events.length === 0 && <p className="muted">No live events in this session.</p>}
          {events.slice().reverse().map((e) => <div key={e.seq} className={`log-line t-${e.type}`}><span className="muted">{new Date(e.at).toLocaleTimeString()}</span> <b>{e.type}</b> {e.message}</div>)}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return <div className="stat"><span className="muted small">{label}</span><b>{value}</b></div>;
}
