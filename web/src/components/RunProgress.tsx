import { useEffect, useState } from 'react';
import type { Snapshot } from '../api';
import { IconCheck, IconExternalLink, IconSparkles } from './Icons';
import { LiveSimulation } from './LiveSimulation';

interface RunProgressProps {
  runId: string;
  snapshot: Snapshot | null;
  status: string;
  url: string;
  startTime?: string;
  onStop?: () => void;
}

interface Stage {
  id: string;
  title: string;
  description: string;
}

const STAGES: Stage[] = [
  { id: 'auth', title: 'Authentication', description: 'Applying credentials & initializing browser context' },
  { id: 'discovery', title: 'Page Discovery', description: 'Crawling same-origin routes & building PageModel' },
  { id: 'geometry', title: 'Responsive & Geometry', description: 'Checking overlaps, clipping, container overflow & small targets' },
  { id: 'accessibility', title: 'Accessibility Audit', description: 'Running axe-core, ARIA validation & keyboard traversal' },
  { id: 'functional', title: 'Functional Testing', description: 'Safely testing buttons, links, and forms with ActionGuard' },
  { id: 'ai', title: 'AI Analysis', description: 'Synthesizing evidence, prioritizing root causes & detecting false positives' },
  { id: 'reporting', title: 'Final Report & Verdict', description: 'Generating self-contained HTML, JSON, and JUnit XML artifacts' },
];

export function RunProgress({ runId, snapshot, status, url, startTime, onStop }: RunProgressProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = startTime ? new Date(startTime).getTime() : Date.now();
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  const formatElapsed = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const s = snapshot;
  const pct = s && s.unitsTotal > 0 ? Math.min(100, Math.round((s.unitsDone / s.unitsTotal) * 100)) : 10;

  // Determine active stage based on status or current action
  const getStageState = (stageId: string): 'done' | 'active' | 'pending' => {
    const st = status.toUpperCase();
    if (st === 'COMPLETED') return 'done';

    if (stageId === 'auth') {
      if (st === 'AUTHENTICATING') return 'active';
      return 'done';
    }

    if (stageId === 'discovery') {
      if (st === 'AUTHENTICATING') return 'pending';
      if (st === 'DISCOVERING') return 'active';
      return 'done';
    }

    if (stageId === 'geometry' || stageId === 'accessibility' || stageId === 'functional') {
      if (st === 'AUTHENTICATING' || st === 'DISCOVERING') return 'pending';
      if (st === 'TESTING') {
        const action = (s?.currentAction || '').toLowerCase();
        if (stageId === 'functional' && action.includes('functional')) return 'active';
        if (stageId === 'accessibility' && action.includes('axe')) return 'active';
        if (stageId === 'geometry' && (action.includes('visual') || action.includes('layout'))) return 'active';
        return 'active';
      }
      return 'done';
    }

    if (stageId === 'ai') {
      if (st === 'ANALYZING') return 'active';
      if (st === 'REPORTING' || st === 'COMPLETED' || st === 'REVIEW') return 'done';
      return 'pending';
    }

    if (stageId === 'reporting') {
      if (st === 'REPORTING') return 'active';
      if (st === 'COMPLETED') return 'done';
      return 'pending';
    }

    return 'pending';
  };

  const isAiPhase = (s?.currentAction || '').toLowerCase().includes('ai analysis');

  return (
    <div className="progress-panel">
      <div className="progress-header">
        <div className="progress-title-group">
          <div className="live-indicator-wrapper">
            <span className="live-pulse" />
            <span className="live-text">{isAiPhase ? 'AI SYNTHESIS IN PROGRESS' : 'TEST IN PROGRESS'}</span>
          </div>
          <h2 className="progress-target-url">
            {url}
            <a href={url} target="_blank" rel="noreferrer" className="external-link" title="Open target app in new window">
              <IconExternalLink style={{ width: 14, height: 14 }} />
            </a>
          </h2>
        </div>

        <div className="progress-meta-actions">
          <div className="elapsed-badge">
            <span className="elapsed-label">Elapsed Time:</span>
            <span className="elapsed-time">{formatElapsed(elapsed)}</span>
          </div>
          {onStop && (
            <button type="button" className="btn btn-danger btn-sm" onClick={onStop}>
              Stop Run
            </button>
          )}
        </div>
      </div>

      {/* Primary Animated Progress Bar */}
      <div className="progress-bar-container">
        <div className="progress-bar-track">
          <div
            className="progress-bar-fill animated-shimmer"
            style={{ width: `${Math.max(8, pct)}%` }}
          />
        </div>
        <div className="progress-bar-stats">
          <span className="progress-stat-unit">
            Progress: <strong>{pct}%</strong> ({s?.unitsDone ?? 0} of {s?.unitsTotal ?? 0} units tested){isAiPhase ? ' · Browser testing complete' : ''}
          </span>
          <span className="progress-stat-findings">
            Discovered: <strong>{s?.pagesDiscovered ?? 0}</strong> pages · <strong>{s?.findings ?? 0}</strong> issues found so far
          </span>
        </div>
      </div>

      {/* Current Active Activity Banner */}
      <div className="current-activity-banner">
        <div className="activity-icon">
          <IconSparkles style={{ width: 16, height: 16 }} />
        </div>
        <div className="activity-details">
          <div className="activity-label">CURRENT ACTIVE PHASE</div>
          <div className="activity-text">
            {s?.currentAction || 'Initializing browser engine & starting crawler...'}
          </div>
          {s?.currentPage && (
            <div className="activity-sub">
              Target: <code>{s.currentPage}</code> {s.currentViewport && `@ ${s.currentViewport}`}
            </div>
          )}
        </div>
      </div>

      {/* Live Simulation Sandbox */}
      <LiveSimulation runId={runId} targetUrl={url} compact={true} currentAction={s?.currentAction ?? undefined} />

      {/* Multi-stage pipeline checklist */}
      <div className="pipeline-stages">
        <div className="pipeline-title">Autonomous Execution Pipeline</div>
        <div className="stages-list">
          {STAGES.map((stage, idx) => {
            const state = getStageState(stage.id);
            return (
              <div key={stage.id} className={`stage-item stage-${state}`}>
                <div className="stage-node">
                  {state === 'done' ? (
                    <span className="node-done"><IconCheck style={{ width: 12, height: 12 }} /></span>
                  ) : state === 'active' ? (
                    <span className="node-active"><span className="node-pulse" /></span>
                  ) : (
                    <span className="node-pending">{idx + 1}</span>
                  )}
                </div>
                <div className="stage-info">
                  <div className="stage-name">
                    {stage.title}
                    {state === 'active' && <span className="stage-tag-active">Active</span>}
                  </div>
                  <div className="stage-desc">{stage.description}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
