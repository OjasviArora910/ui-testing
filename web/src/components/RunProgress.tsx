import { useEffect, useRef, useState } from 'react';
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

interface ActionBox {
  left: number;
  top: number;
  width: number;
  height: number;
  label: string;
  kind: 'targeted' | 'moving' | 'clicking' | 'observing' | 'verifying' | 'pass' | 'fail' | 'review' | 'action';
  badgeTitle: string;
  badgeDetail?: string;
  timestamp: number;
}

interface CursorPos {
  x: number;
  y: number;
  visible: boolean;
  clicking: boolean;
}

const OUTCOME_LABEL: Record<string, string> = {
  EXPECTED: 'PASS',
  BUG: 'CONFIRMED BUG',
  WARNING: 'CONFIRMED BUG',
  NEEDS_REVIEW: 'INCONCLUSIVE',
  BLOCKED_BY_SAFETY: 'BLOCKED',
  INCONCLUSIVE: 'INCONCLUSIVE',
};

const pathOf = (u: string | null | undefined): string => {
  if (!u) return '';
  try {
    const x = new URL(u);
    return x.pathname + x.search + x.hash;
  } catch {
    return u;
  }
};

export function RunProgress({ runId, snapshot: s, status, url, startTime, events, onStop, stopping }: RunProgressProps) {
  const [elapsed, setElapsed] = useState(0);
  const [liveScreenshotUrl, setLiveScreenshotUrl] = useState<string>(`/api/runs/${runId}/live-preview?t=${Date.now()}`);
  const [displayScreenshotUrl, setDisplayScreenshotUrl] = useState<string>(`/api/runs/${runId}/live-preview?t=${Date.now()}`);
  const [activeBox, setActiveBox] = useState<ActionBox | null>(null);
  const [cursorPos, setCursorPos] = useState<CursorPos>({ x: 50, y: 50, visible: false, clicking: false });
  const [activePhase, setActivePhase] = useState<string>('');
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const start = startTime ? new Date(startTime).getTime() : Date.now();
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  // Smooth image preloader double-buffering
  useEffect(() => {
    const img = new Image();
    img.src = liveScreenshotUrl;
    img.onload = () => {
      setDisplayScreenshotUrl(liveScreenshotUrl);
    };
  }, [liveScreenshotUrl]);

  // Process newest events to update overlays and frame
  useEffect(() => {
    if (events.length === 0) return;
    const latest = events[events.length - 1];
    if (!latest) return;

    if (latest.type === 'action' || latest.type === 'frame') {
      // Trigger instant frame refresh
      setLiveScreenshotUrl(`/api/runs/${runId}/live-preview?t=${Date.now()}`);

      const data = (latest.data ?? {}) as {
        type?: string;
        target?: string;
        phase?: string;
        verdict?: string;
        ok?: boolean;
        expected?: string;
        actual?: string;
        box?: { x: number; y: number; width: number; height: number; vpWidth?: number; vpHeight?: number };
      };

      const phase = data.phase || (latest.type === 'frame' ? 'FRAME' : '');
      setActivePhase(phase);
      const isClick = phase === 'CLICKING' || data.type === 'click';

      let kind: ActionBox['kind'] = 'action';
      let badgeTitle = 'ACTION';
      let badgeDetail = data.target || latest.message;

      if (phase === 'TARGETED') {
        kind = 'targeted';
        badgeTitle = '🎯 TARGETING';
      } else if (phase === 'MOVING') {
        kind = 'moving';
        badgeTitle = '🎯 MOVING';
      } else if (phase === 'CLICKING') {
        kind = 'clicking';
        badgeTitle = '👆 CLICKING';
      } else if (phase === 'OBSERVING') {
        kind = 'observing';
        badgeTitle = '🔍 OBSERVING';
      } else if (phase === 'VERIFYING') {
        kind = 'verifying';
        badgeTitle = '🧠 VERIFYING';
      } else if (phase === 'RESULT') {
        if (data.verdict === 'PASS' || data.ok) {
          kind = 'pass';
          badgeTitle = '✓ PASS';
          badgeDetail = data.actual || 'Verified';
        } else if (data.verdict === 'FAIL' || data.ok === false) {
          kind = 'fail';
          badgeTitle = '🔴 FAIL';
          badgeDetail = data.actual || 'Defect';
        } else {
          kind = 'review';
          badgeTitle = '⚠ REVIEW';
        }
      }

      const box = data.box;
      if (box && typeof box.x === 'number' && typeof box.width === 'number') {
        const vpW = box.vpWidth || 1440;
        const vpH = box.vpHeight || 900;
        const left = Math.max(0, Math.min(100, (box.x / vpW) * 100));
        const top = Math.max(0, Math.min(100, (box.y / vpH) * 100));
        const width = Math.max(1.5, Math.min(100, (box.width / vpW) * 100));
        const height = Math.max(1.5, Math.min(100, (box.height / vpH) * 100));
        const cx = left + width / 2;
        const cy = top + height / 2;

        setActiveBox({
          left,
          top,
          width,
          height,
          label: data.target || latest.message,
          kind,
          badgeTitle,
          badgeDetail,
          timestamp: Date.now(),
        });

        setCursorPos({
          x: cx,
          y: cy,
          visible: true,
          clicking: isClick,
        });

        if (isClick) {
          if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
          clickTimerRef.current = setTimeout(() => {
            setCursorPos((p) => ({ ...p, clicking: false }));
          }, 650);
        }
      } else if (isClick) {
        setCursorPos((p) => ({ ...p, visible: true, clicking: true }));
        if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
        clickTimerRef.current = setTimeout(() => {
          setCursorPos((p) => ({ ...p, clicking: false }));
        }, 650);
      }
    } else if (latest.type === 'page' || latest.type === 'result') {
      setLiveScreenshotUrl(`/api/runs/${runId}/live-preview?t=${Date.now()}`);
    }
  }, [events, runId]);

  // Periodic fallback refresh every 1.5s while active
  useEffect(() => {
    const timer = setInterval(() => {
      setLiveScreenshotUrl(`/api/runs/${runId}/live-preview?t=${Date.now()}`);
    }, 1500);
    return () => clearInterval(timer);
  }, [runId]);

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

        <div className="live-simulation-frame">
          <div className="live-simulation-header">
            <div className="live-sim-dots">
              <span className="live-sim-dot dot-red" />
              <span className="live-sim-dot dot-yellow" />
              <span className="live-sim-dot dot-green" />
            </div>
            <div className="live-sim-url-bar" title={s?.currentPage || url}>
              🔒 {s?.currentPage || url}
            </div>
            <div className="live-sim-actions-slot">
              {activePhase && (
                <span className={`live-sim-phase-pill phase-${activePhase.toLowerCase()}`}>
                  {activePhase}
                </span>
              )}
            </div>
          </div>

          <div className="live-simulation-stage">
            <img
              className="live-shot"
              alt="Current browser view"
              src={displayScreenshotUrl}
            />

            {/* Target Bounding Box Overlay */}
            {activeBox && (
              <div
                className={`sim-target-box ${activeBox.kind}`}
                style={{
                  left: `${activeBox.left}%`,
                  top: `${activeBox.top}%`,
                  width: `${activeBox.width}%`,
                  height: `${activeBox.height}%`,
                }}
              >
                <div className="target-bracket tl" />
                <div className="target-bracket tr" />
                <div className="target-bracket bl" />
                <div className="target-bracket br" />
                <div className={`sim-target-badge ${activeBox.kind}`}>
                  <span className="badge-pulse" />
                  <span className="badge-kind">{activeBox.badgeTitle}</span>
                  <span className="badge-name">{activeBox.badgeDetail || activeBox.label}</span>
                </div>
              </div>
            )}

            {/* Simulated Cursor Crosshair & Click Indicator */}
            {cursorPos.visible && (
              <div
                className={`sim-cursor-pointer ${cursorPos.clicking ? 'clicking' : ''} ${activeBox ? activeBox.kind : ''}`}
                style={{
                  left: `${cursorPos.x}%`,
                  top: `${cursorPos.y}%`,
                }}
              >
                <div className="sim-cursor-crosshair" />
                <svg className="sim-cursor-svg" viewBox="0 0 24 24" width="22" height="22">
                  <path
                    d="M3 3l7 18 3-7 7-3L3 3z"
                    fill="currentColor"
                    stroke="#000"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                  />
                </svg>
                {cursorPos.clicking && (
                  <div className="sim-click-ripple" />
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
