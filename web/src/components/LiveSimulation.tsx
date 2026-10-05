import { useEffect, useRef, useState } from 'react';
import {
  IconDesktop,
  IconExternalLink,
  IconRefresh,
  IconSparkles,
  IconTerminal,
  IconCheck,
  IconAlertCircle,
} from './Icons';

interface LiveSimulationProps {
  runId: string;
  targetUrl?: string;
  compact?: boolean;
  currentAction?: string;
}

interface ActionBox {
  left: number;
  top: number;
  width: number;
  height: number;
  label: string;
  kind: 'targeted' | 'moving' | 'clicking' | 'observing' | 'verifying' | 'pass' | 'fail' | 'review' | 'checking' | 'click' | 'fill' | 'navigate';
  phase?: string;
  badgeTitle: string;
  badgeDetail?: string;
  timestamp: number;
}

interface ActionItem {
  id: string;
  type: string;
  target: string;
  ok: boolean;
  phase?: string;
  verdict?: 'PASS' | 'FAIL' | 'NEEDS_REVIEW' | 'BLOCKED';
  confidence?: 'HIGH' | 'MEDIUM' | 'LOW';
  expected?: string;
  actual?: string;
  durationMs?: number;
  time: string;
}

interface StepItem {
  id: string;
  title: string;
  code: string;
  status: 'done' | 'active' | 'failed' | 'pending';
}

export function LiveSimulation({ runId, targetUrl = '', compact = false, currentAction = '' }: LiveSimulationProps) {
  const [liveUrl, setLiveUrl] = useState<string>(targetUrl);
  const [liveViewport, setLiveViewport] = useState<string>('desktop');
  const [liveAction, setLiveAction] = useState<string>('Connecting to Playwright browser context...');
  const [liveTarget, setLiveTarget] = useState<string>('');
  const [livePhase, setLivePhase] = useState<string>('');
  const [liveVerdict, setLiveVerdict] = useState<string>('');
  const [liveConfidence, setLiveConfidence] = useState<string>('');
  const [liveExpected, setLiveExpected] = useState<string>('');
  const [liveActual, setLiveActual] = useState<string>('');
  const [liveScreenshotUrl, setLiveScreenshotUrl] = useState<string>(`/api/runs/${runId}/live-preview?t=${Date.now()}`);
  const [displayScreenshotUrl, setDisplayScreenshotUrl] = useState<string>(`/api/runs/${runId}/live-preview?t=${Date.now()}`);
  const [imageLoaded, setImageLoaded] = useState<boolean>(false);
  const [isScanning, setIsScanning] = useState<boolean>(true);
  const [activeButton, setActiveButton] = useState<ActionBox | null>(null);
  const [recentActions, setRecentActions] = useState<ActionItem[]>([]);
  const [lastResult, setLastResult] = useState<ActionItem | null>(null);
  const [previewModalOpen, setPreviewModalOpen] = useState<boolean>(false);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number; visible: boolean; clicking: boolean }>({
    x: 50,
    y: 50,
    visible: true,
    clicking: false,
  });

  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Smooth image double-buffering preloader
  useEffect(() => {
    const img = new Image();
    img.src = liveScreenshotUrl;
    img.onload = () => {
      setDisplayScreenshotUrl(liveScreenshotUrl);
      setImageLoaded(true);
    };
    img.onerror = () => {
      handleImageError();
    };
  }, [liveScreenshotUrl]);

  // Poll screenshot continuously while simulation is active
  useEffect(() => {
    const timer = setInterval(() => {
      setLiveScreenshotUrl(`/api/runs/${runId}/live-preview?t=${Date.now()}`);
    }, 1500);
    return () => clearInterval(timer);
  }, [runId]);

  // Handle Real-Time SSE Event Stream
  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource(`/api/runs/${runId}/events`);
      es.addEventListener('progress', (e) => {
        try {
          const data = JSON.parse(e.data);
          const nowTime = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

          if (data.type === 'action') {
            const rawType = String(data.data?.type || 'action');
            const target = String(data.data?.target || data.message || '');
            const ok = data.data?.ok !== false;
            const phase = (data.data?.phase as string) || '';
            const verdict = data.data?.verdict as 'PASS' | 'FAIL' | 'NEEDS_REVIEW' | 'BLOCKED' | undefined;
            const confidence = data.data?.confidence as 'HIGH' | 'MEDIUM' | 'LOW' | undefined;
            const expected = (data.data?.expected as string) || '';
            const actual = (data.data?.actual as string) || '';
            const durationMs = data.data?.durationMs as number | undefined;

            setLivePhase(phase);
            if (expected) setLiveExpected(expected);
            if (actual) setLiveActual(actual);
            if (verdict) setLiveVerdict(verdict);
            if (confidence) setLiveConfidence(confidence);

            setLiveAction(`${data.data?.source || 'action'}: ${data.message}`);
            if (target) setLiveTarget(target);
            if (data.data?.page) setLiveUrl(String(data.data.page));
            if (data.data?.viewport) setLiveViewport(String(data.data.viewport));

            // Record into recent actions reel and store lastResult for the bottom card
            if (target && (phase === 'RESULT' || !phase)) {
              const resItem: ActionItem = {
                id: `${Date.now()}-${Math.random()}`,
                type: rawType,
                target,
                ok: verdict === 'PASS' || (verdict !== 'FAIL' && ok),
                phase,
                verdict: verdict || (ok ? 'PASS' : 'FAIL'),
                confidence,
                expected,
                actual,
                durationMs,
                time: nowTime,
              };
              setLastResult(resItem);
              setRecentActions((prev) => [resItem, ...prev.slice(0, 5)]);
            }

            // Immediately pull fresh frame when action occurs
            setLiveScreenshotUrl(`/api/runs/${runId}/live-preview?t=${Date.now()}`);

            // Determine Phase 4 lifecycle state for box and cursor
            let kind: ActionBox['kind'] = 'checking';
            let badgeTitle = 'CHECKING';
            let badgeDetail = target;
            let isClick = false;

            if (phase === 'TARGETED') {
              kind = 'targeted';
              badgeTitle = '🎯 TARGETING';
              badgeDetail = target;
            } else if (phase === 'MOVING') {
              kind = 'moving';
              badgeTitle = '🎯 MOVING';
              badgeDetail = target;
            } else if (phase === 'CLICKING') {
              kind = 'clicking';
              badgeTitle = '👆 CLICKING';
              badgeDetail = target;
              isClick = true;
            } else if (phase === 'OBSERVING') {
              kind = 'observing';
              badgeTitle = '🔍 OBSERVING';
              badgeDetail = target;
            } else if (phase === 'VERIFYING') {
              kind = 'verifying';
              badgeTitle = '🧠 VERIFYING';
              badgeDetail = target;
            } else if (phase === 'RESULT') {
              if (verdict === 'PASS') {
                kind = 'pass';
                if (/modal|dialog/i.test(expected) || /modal|dialog/i.test(actual)) {
                  badgeTitle = 'dialog visible ✓';
                } else if (/tab/i.test(expected) || /tab/i.test(actual)) {
                  badgeTitle = 'tab active ✓';
                } else {
                  badgeTitle = 'verified ✓';
                }
                badgeDetail = actual || 'Verified successfully';
              } else if (verdict === 'FAIL') {
                kind = 'fail';
                badgeTitle = '🔴 FAIL';
                badgeDetail = actual || 'Expected behavior did not occur';
              } else {
                kind = 'review';
                badgeTitle = '⚠ REVIEW';
                badgeDetail = actual || 'Needs Review';
              }
            } else {
              isClick = rawType === 'click' || data.message.includes('click');
              const isChecking = rawType === 'checking';
              kind = isClick ? 'click' : isChecking ? 'checking' : rawType === 'fill' ? 'fill' : 'navigate';
              badgeTitle = isClick ? '👆 CLICKING' : isChecking ? '🎯 CHECKING' : 'TESTING';
            }

            // Calculate element target box if bounding box was received
            const box = data.data?.box;
            if (box && typeof box.x === 'number' && typeof box.width === 'number') {
              const vpW = box.vpWidth || 1440;
              const vpH = box.vpHeight || 900;

              const left = Math.max(0, Math.min(100, (box.x / vpW) * 100));
              const top = Math.max(0, Math.min(100, (box.y / vpH) * 100));
              const width = Math.max(1.5, Math.min(100, (box.width / vpW) * 100));
              const height = Math.max(1.5, Math.min(100, (box.height / vpH) * 100));
              const cx = left + width / 2;
              const cy = top + height / 2;

              setActiveButton({
                left,
                top,
                width,
                height,
                label: target,
                kind,
                phase,
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
                setTimeout(() => setCursorPos((p) => ({ ...p, clicking: false })), 600);
              }
            } else {
              // Smooth wander towards interaction area
              const rx = 35 + Math.floor(Math.random() * 30);
              const ry = 25 + Math.floor(Math.random() * 35);
              setCursorPos({ x: rx, y: ry, visible: true, clicking: isClick });
              if (isClick) setTimeout(() => setCursorPos((p) => ({ ...p, clicking: false })), 500);
            }
          } else if (data.type === 'page' || data.type === 'frame') {
            if (data.data?.url) setLiveUrl(String(data.data?.url));
            if (data.data?.viewport) setLiveViewport(String(data.data?.viewport));
            setLiveScreenshotUrl(`/api/runs/${runId}/live-preview?t=${Date.now()}`);
            setIsScanning(true);
            setTimeout(() => setIsScanning(false), 2000);
          }
        } catch {
          // ignore parse errors
        }
      });
    } catch {
      // EventSource fallback
    }

    return () => {
      es?.close();
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    };
  }, [runId, liveViewport]);

  // Keep target box visible for 3.5s after interaction
  useEffect(() => {
    if (!activeButton) return;
    const t = setTimeout(() => setActiveButton(null), 3500);
    return () => clearTimeout(t);
  }, [activeButton]);

  const handleImageError = () => {
    if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    retryTimeoutRef.current = setTimeout(() => {
      setLiveScreenshotUrl(`/api/runs/${runId}/live-preview?t=${Date.now()}`);
    }, 800);
  };

  const viewportIcon = () => {
    return <IconDesktop style={{ width: 14, height: 14 }} />;
  };

  const getViewportDimensions = () => {
    return '1440 × 900';
  };

  const isAiPhase =
    (currentAction || '').toLowerCase().includes('ai analysis') ||
    (liveAction || '').toLowerCase().includes('ai analysis');

  const formatTargetInfo = (target: string) => {
    if (!target || target === 'element') {
      return {
        label: 'element',
        kind: 'button' as const,
        snippet: "locator('button, a, input')",
      };
    }

    if (target.startsWith('http://') || target.startsWith('https://')) {
      try {
        const u = new URL(target);
        const path = u.pathname + (u.search ? u.search : '');
        return {
          label: path || '/',
          kind: 'link' as const,
          snippet: `locator('a[href*="${path || '/'}"]')`,
        };
      } catch {
        return {
          label: target,
          kind: 'link' as const,
          snippet: `locator('a[href="${target}"]')`,
        };
      }
    }

    if (target.startsWith('/')) {
      return {
        label: target,
        kind: 'link' as const,
        snippet: `locator('a[href="${target}"]')`,
      };
    }

    if (target.startsWith('#') || target.startsWith('.')) {
      return {
        label: target,
        kind: 'element' as const,
        snippet: `locator('${target}')`,
      };
    }

    return {
      label: `"${target}"`,
      kind: 'button' as const,
      snippet: `getByRole('button', { name: '${target}' })`,
    };
  };

  // Derive execution steps matching the reference UI exactly
  const getExecutionSteps = (): StepItem[] => {
    if (isAiPhase) {
      return [
        {
          id: '1',
          title: 'Launch Chromium',
          code: 'chromium.launch()',
          status: 'done',
        },
        {
          id: '2',
          title: 'Execute Test Units',
          code: 'All page-viewport units tested',
          status: 'done',
        },
        {
          id: '3',
          title: 'Locate & Verify Elements',
          code: 'Phase 3 Semantic Verifier',
          status: 'done',
        },
        {
          id: '4',
          title: 'Aggregate Findings',
          code: 'Issues flagged for root-cause synthesis',
          status: 'done',
        },
        {
          id: '5',
          title: 'AI Root-Cause Analysis',
          code: 'Gemini 2.5 Flash batch reasoning',
          status: 'active',
        },
        {
          id: '6',
          title: 'Compile Final Verdict & Report',
          code: 'HTML / JSON / JUnit outputs',
          status: 'pending',
        },
      ];
    }

    const targetInfo = formatTargetInfo(liveTarget);
    const targetName = targetInfo.label;
    const isLink = targetInfo.kind === 'link';
    const targetType = isLink ? 'link' : 'button';

    const isAfter = (checkPhase: string) => {
      const order = ['TARGETED', 'MOVING', 'CLICKING', 'OBSERVING', 'VERIFYING', 'RESULT'];
      const curIdx = order.indexOf(livePhase);
      const chkIdx = order.indexOf(checkPhase);
      if (curIdx === -1) return false;
      return curIdx >= chkIdx;
    };

    return [
      {
        id: '1',
        title: 'Launch Chromium',
        code: 'chromium.launch()',
        status: 'done',
      },
      {
        id: '2',
        title: 'Open Page',
        code: `page.goto('${liveUrl || targetUrl || 'http://127.0.0.1:3000'}')`,
        status: 'done',
      },
      {
        id: '3',
        title: `Locate ${targetName} ${targetType}`,
        code: targetInfo.snippet,
        status: isAfter('MOVING') ? 'done' : livePhase === 'TARGETED' ? 'active' : 'pending',
      },
      {
        id: '4',
        title: `Move to ${targetName}`,
        code: '.scrollIntoViewIfNeeded()',
        status: isAfter('CLICKING') ? 'done' : livePhase === 'MOVING' ? 'active' : 'pending',
      },
      {
        id: '5',
        title: `Click ${targetName} ${targetType}`,
        code: '.click()',
        status: isAfter('OBSERVING') ? 'done' : livePhase === 'CLICKING' ? 'active' : 'pending',
      },
      {
        id: '6',
        title: liveExpected ? `Wait for outcome` : `Wait for result`,
        code: liveExpected ? `expect(${liveExpected.slice(0, 36)})` : 'expect(state).toChange()',
        status: isAfter('VERIFYING') ? 'done' : livePhase === 'OBSERVING' ? 'active' : 'pending',
      },
      {
        id: '7',
        title: 'Verify behavior',
        code: 'verifyInteraction(intent, observation)',
        status: isAfter('RESULT') ? 'done' : livePhase === 'VERIFYING' ? 'active' : 'pending',
      },
      {
        id: '8',
        title: 'Assertion',
        code: liveVerdict ? `verdict: ${liveVerdict}` : 'expected vs actual',
        status: livePhase === 'RESULT'
          ? (liveVerdict === 'PASS' ? 'done' : 'failed')
          : 'pending',
      },
    ];
  };

  const execSteps = getExecutionSteps();

  return (
    <div className={`simulation-card ${compact ? 'simulation-compact' : ''}`}>
      {/* Simulation Top Bar */}
      <div className="simulation-top-bar">
        <div className="simulation-status-pill">
          <span className="sim-beacon live" />
          <span className="sim-status-title">
            {isAiPhase ? 'AI ANALYSIS IN PROGRESS' : 'LIVE BROWSER SIMULATION'}
          </span>
          <span className="sim-badge-tag">
            {isAiPhase ? 'GEMINI 2.5 FLASH ACTIVE' : 'PLAYWRIGHT CDP ACTIVE'}
          </span>
        </div>

        <div className="simulation-device-indicator">
          {viewportIcon()}
          <span>{liveViewport}</span>
          <span className="dim-text">({getViewportDimensions()})</span>
        </div>
      </div>

      {/* Two-Column Main Layout: Browser Simulation (Left) + Execution Panel (Right) */}
      <div className="simulation-layout-grid">
        {/* Left Column: Virtual Browser Device Frame */}
        <div className="simulation-browser-pane">
          <div className="virtual-browser-frame">
            {/* Browser Chrome Window Bar */}
            <div className="browser-chrome-bar">
              <div className="window-dots">
                <span className="dot dot-close" />
                <span className="dot dot-min" />
                <span className="dot dot-expand" />
              </div>

              <div className="browser-address-bar">
                <span className="address-ssl-icon" title="Secure automated Playwright session">
                  🔒
                </span>
                <span className="address-url" title={liveUrl || targetUrl}>
                  {liveUrl || targetUrl || 'http://127.0.0.1:3000'}
                </span>
                <span className={`browser-engine-badge ${isAiPhase ? 'badge-ai' : ''}`}>
                  {isAiPhase ? 'GEMINI 2.5' : 'CHROMIUM'}
                </span>
                <a
                  href={liveUrl || targetUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="address-external"
                  title="Open current page in new tab"
                >
                  <IconExternalLink style={{ width: 12, height: 12 }} />
                </a>
              </div>

              <div className="browser-actions-slot">
                <button
                  type="button"
                  className="btn-chrome-icon"
                  title="Force refresh live frame"
                  onClick={() => setLiveScreenshotUrl(`/api/runs/${runId}/live-preview?t=${Date.now()}`)}
                >
                  <IconRefresh style={{ width: 12, height: 12 }} />
                </button>
              </div>
            </div>

            {/* Viewport Canvas Screen */}
            <div className="browser-canvas-screen">
              <div className="browser-stage-viewport viewport-desktop">
                {/* Live Playwright Screenshot (Double Buffered) */}
                <img
                  src={displayScreenshotUrl}
                  alt="Live browser testing simulation"
                  className={`browser-viewport-image ${imageLoaded ? 'loaded' : 'loading'}`}
                  onLoad={() => setImageLoaded(true)}
                  onError={handleImageError}
                />

                {/* AI Analysis Overlay Banner when browser testing is complete */}
                {isAiPhase && (
                  <div className="ai-phase-overlay-banner">
                    <span className="ai-phase-sparkle">✨</span>
                    <div className="ai-phase-text">
                      <strong>Browser Testing Complete (100%)</strong>
                      <span>Synthesizing root causes for findings with Gemini AI...</span>
                    </div>
                  </div>
                )}

                {/* Connecting placeholder overlay while waiting for first frame */}
                {!imageLoaded && (
                  <div className="browser-canvas-placeholder">
                    <div className="canvas-placeholder-content">
                      <div className="canvas-pulse-icon">
                        <IconSparkles style={{ width: 36, height: 36 }} />
                      </div>
                      <h3>Connecting to {liveUrl || targetUrl || 'target'}...</h3>
                      <p>Playwright browser context active · Executing real autonomous QA interactions</p>
                      <div className="canvas-tags">
                        <span className="canvas-tag">Viewport: {liveViewport}</span>
                        <span className="canvas-tag">Resolution: {getViewportDimensions()}</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Animated Laser Scanline */}
                <div className={`scanline-laser ${isScanning ? 'active' : ''}`} />

                {/* Active Element Target Highlight Frame */}
                {activeButton && (
                  <div
                    className={`sim-target-box ${activeButton.kind}`}
                    style={{
                      left: `${activeButton.left}%`,
                      top: `${activeButton.top}%`,
                      width: `${activeButton.width}%`,
                      height: `${activeButton.height}%`,
                    }}
                  >
                    <div className="target-bracket tl" />
                    <div className="target-bracket tr" />
                    <div className="target-bracket bl" />
                    <div className="target-bracket br" />
                    <div className={`sim-target-badge ${activeButton.kind}`}>
                      <span className="badge-pulse" />
                      <span className="badge-kind">{activeButton.badgeTitle}</span>
                      <span className="badge-name">
                        {activeButton.badgeDetail ? activeButton.badgeDetail.slice(0, 48) : activeButton.label.slice(0, 36)}
                      </span>
                    </div>
                  </div>
                )}

                {/* Interactive Simulated Cursor Pointer Crosshair */}
                {cursorPos.visible && (
                  <div
                    className={`sim-cursor-pointer ${cursorPos.clicking ? 'clicking' : ''} ${activeButton ? activeButton.kind : ''}`}
                    style={{
                      left: `${cursorPos.x}%`,
                      top: `${cursorPos.y}%`,
                    }}
                  >
                    <div className="cursor-dot" />
                    <div className="cursor-ring" />
                    {activeButton?.badgeTitle ? (
                      <div className={`cursor-label ${activeButton.kind}`}>
                        <span>{activeButton.badgeTitle}</span>: {activeButton.label.slice(0, 24)}
                      </div>
                    ) : liveTarget ? (
                      <div className="cursor-label">
                        {cursorPos.clicking ? '👆 CLICK: ' : '🎯 TARGET: '}
                        {liveTarget.slice(0, 24)}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            </div>

            {/* Live Action Ticker Footer */}
            <div className="browser-ticker-bar">
              <div className="ticker-icon">
                <IconTerminal style={{ width: 14, height: 14 }} />
              </div>
              <div className="ticker-text">
                <div className="ticker-headline">
                  {livePhase && (
                    <span className={`ticker-phase-tag phase-${livePhase.toLowerCase()} ${liveVerdict ? `verdict-${liveVerdict.toLowerCase()}` : ''}`}>
                      {livePhase === 'TARGETED' ? '🎯 TARGETING' :
                       livePhase === 'MOVING' ? '🎯 MOVING' :
                       livePhase === 'CLICKING' ? '👆 CLICKING' :
                       livePhase === 'OBSERVING' ? '🔍 OBSERVING' :
                       livePhase === 'VERIFYING' ? '🧠 VERIFYING' :
                       livePhase === 'RESULT' ? (liveVerdict === 'PASS' ? '✓ PASS' : liveVerdict === 'FAIL' ? '🔴 FAIL' : '⚠ REVIEW') :
                       livePhase}
                    </span>
                  )}
                  {liveTarget && (
                    <span className="ticker-target" title={liveTarget}>
                      <code>{liveTarget}</code>
                    </span>
                  )}
                  {liveConfidence && (
                    <span className={`ticker-conf-tag conf-${liveConfidence.toLowerCase()}`}>
                      {liveConfidence} CONFIDENCE
                    </span>
                  )}
                </div>

                {/* Decision Layer Details: Expected vs Actual */}
                {(liveExpected || liveActual) ? (
                  <div className="ticker-decision-details">
                    {liveExpected && (
                      <div className="ticker-decision-row">
                        <span className="ticker-decision-k">EXPECTED:</span>
                        <span className="ticker-decision-v">{liveExpected}</span>
                      </div>
                    )}
                    {liveActual && (
                      <div className="ticker-decision-row">
                        <span className="ticker-decision-k">ACTUAL:</span>
                        <span className="ticker-decision-v">{liveActual}</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <span className="ticker-msg">{liveAction.split(':').slice(1).join(':') || liveAction}</span>
                )}
              </div>
              <div className="ticker-state-badge">
                <span className={`ticker-pulse ${isAiPhase ? 'pulse-ai' : ''}`} />
                <span>{isAiPhase ? 'AI ANALYSIS RUNNING' : 'PLAYWRIGHT RUNNING'}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Execution Step-by-Step Activity Panel */}
        <div className="simulation-execution-pane">
          <div className="execution-panel-card">
            <div className="execution-header">
              <span className="execution-title">{isAiPhase ? 'AI SYNTHESIS' : 'EXECUTION'}</span>
              <span className={`execution-badge ${isAiPhase ? 'badge-ai' : ''}`}>
                {isAiPhase ? 'GEMINI REASONING' : 'PLAYWRIGHT RUNNER'}
              </span>
            </div>

            <div className="execution-steps-list">
              {execSteps.map((s) => (
                <div key={s.id} className={`exec-step step-${s.status}`}>
                  <div className={`exec-icon ${s.status}`}>
                    {s.status === 'done' ? (
                      <IconCheck style={{ width: 11, height: 11 }} />
                    ) : s.status === 'active' ? (
                      <span className="exec-pulse-dot" />
                    ) : s.status === 'failed' ? (
                      '✕'
                    ) : (
                      '•'
                    )}
                  </div>
                  <div className="exec-content">
                    <span className="exec-name">{s.title}</span>
                    <span className="exec-code" title={s.code}>{s.code}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Recent Tested Elements Stream Reel at bottom of execution card */}
            {recentActions.length > 0 && (
              <div className="execution-actions-stream">
                <div className="stream-header">RECENT VERIFIED ACTIONS:</div>
                <div className="stream-pills-col">
                  {recentActions.slice(0, 4).map((act) => {
                    const verdictClass = act.verdict ? act.verdict.toLowerCase().replace('_', '-') : (act.ok ? 'pass' : 'fail');
                    return (
                      <div
                        key={act.id}
                        className={`stream-pill ${verdictClass}`}
                        title={act.expected ? `Expected: ${act.expected}\nActual: ${act.actual || act.type}` : act.target}
                      >
                        {act.verdict === 'PASS' || (!act.verdict && act.ok) ? (
                          <IconCheck style={{ width: 10, height: 10 }} />
                        ) : (
                          <IconAlertCircle style={{ width: 10, height: 10 }} />
                        )}
                        <span className="pill-type">{act.verdict || (act.ok ? 'PASS' : 'FAIL')}</span>
                        <span className="pill-target" title={act.target}>
                          {act.target.slice(0, 20)}
                        </span>
                        {act.durationMs != null && (
                          <span className="pill-duration">{act.durationMs}ms</span>
                        )}
                        <span className="pill-time">{act.time}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Panel: Structured Test Result Card matching Reference UI */}
      {lastResult && (
        <div className={`sim-result-card ${lastResult.verdict ? lastResult.verdict.toLowerCase().replace('_', '-') : (lastResult.ok ? 'pass' : 'fail')}`}>
          <div className="sim-result-banner">
            <div className="sim-result-status">
              {lastResult.verdict === 'PASS' || (!lastResult.verdict && lastResult.ok) ? (
                <>
                  <span className="banner-icon-badge pass"><IconCheck style={{ width: 14, height: 14 }} /></span>
                  <span className="banner-text">✓ TEST PASSED</span>
                </>
              ) : lastResult.verdict === 'FAIL' ? (
                <>
                  <span className="banner-icon-badge fail"><IconAlertCircle style={{ width: 14, height: 14 }} /></span>
                  <span className="banner-text">🔴 TEST FAILED</span>
                </>
              ) : (
                <>
                  <span className="banner-icon-badge review"><IconAlertCircle style={{ width: 14, height: 14 }} /></span>
                  <span className="banner-text">⚠ NEEDS REVIEW</span>
                </>
              )}
              <span className="banner-sub">{lastResult.target}</span>
            </div>
            <div className="banner-duration">
              {lastResult.durationMs ? `${(lastResult.durationMs / 1000).toFixed(2)}s` : '0.35s'}
            </div>
          </div>

          <div className="sim-result-grid">
            <div className="result-col">
              <span className="col-label">TEST</span>
              <span className="col-value">{lastResult.type || 'Button Functionality'}</span>
            </div>
            <div className="result-col">
              <span className="col-label">TARGET</span>
              <span className="col-value highlight">{lastResult.target}</span>
            </div>
            <div className="result-col">
              <span className="col-label">EXPECTED</span>
              <span className="col-value">{lastResult.expected || 'Observable UI response'}</span>
            </div>
            <div className="result-col">
              <span className="col-label">ACTUAL</span>
              <span className="col-value">{lastResult.actual || 'Interaction verified'}</span>
            </div>
            <div className="result-col">
              <span className="col-label">DURATION</span>
              <span className="col-value mono">{lastResult.durationMs ? `${(lastResult.durationMs / 1000).toFixed(2)}s` : '0.35s'}</span>
            </div>
          </div>

          <div className="sim-result-actions">
            <button
              type="button"
              className="btn-result-action"
              onClick={() => setPreviewModalOpen(true)}
            >
              VIEW FULL FRAME
            </button>
            <button
              type="button"
              className="btn-result-action secondary"
              onClick={() => setLiveScreenshotUrl(`/api/runs/${runId}/live-preview?t=${Date.now()}`)}
            >
              REFRESH FRAME
            </button>
          </div>
        </div>
      )}

      {/* Full Preview Modal */}
      {previewModalOpen && (
        <div className="modal-backdrop" onClick={() => setPreviewModalOpen(false)}>
          <div className="modal-dialog-large" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Live Playwright Screenshot · {liveUrl || targetUrl}</h3>
              <button type="button" className="btn-icon" onClick={() => setPreviewModalOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <img src={displayScreenshotUrl} alt="Full browser frame" style={{ width: '100%', borderRadius: 6 }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
