import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProgressEvent, Snapshot } from '../api';
import { mapBoxToDisplay } from '../liveOverlay';

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

type Kind = 'targeted' | 'clicking' | 'observing' | 'verifying' | 'pass' | 'fail' | 'review' | 'action';
type Stage = 'TARGETING' | 'CLICKING' | 'OBSERVING' | 'VERIFYING' | 'RESULT';
const STAGES: Stage[] = ['TARGETING', 'CLICKING', 'OBSERVING', 'VERIFYING', 'RESULT'];

interface ActionBox { left: number; top: number; width: number; height: number; kind: Kind; badge: string }
interface CursorPos { x: number; y: number; visible: boolean; clicking: boolean }

/** An element box exactly as measured in the tested browser, tied to the screenshot (frame) it was measured on. */
interface Overlay {
  frameId: number;
  box: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  kind: Kind;
  badge: string;
  clicking: boolean;
}

/**
 * One thing to SHOW, taken from the event stream. Steps are played one after another, each for long enough to be seen:
 * the run itself is not slowed down, the display simply does not skip ahead before a click is understandable.
 */
interface Step {
  stage: Stage | null;
  target: string;
  verb: string;
  frameId?: number;
  box?: { x: number; y: number; width: number; height: number; vpWidth?: number; vpHeight?: number };
  expected?: string;
  actual?: string;
  verdict?: string;
  ok?: boolean;
}

/** What the CURRENT ACTION panel shows. */
interface Current { target: string; verb: string; stage: Stage | null; expected?: string; actual?: string; outcome?: 'pass' | 'fail' | 'review' }

const OUTCOME_LABEL: Record<string, string> = { EXPECTED: 'PASS', BUG: 'CONFIRMED BUG', WARNING: 'CONFIRMED BUG', NEEDS_REVIEW: 'INCONCLUSIVE', BLOCKED_BY_SAFETY: 'BLOCKED', INCONCLUSIVE: 'INCONCLUSIVE' };
/** How long each kind of step stays on screen (ms). */
const DWELL = { target: 550, click: 850, state: 600, result: 1000, plain: 250 };
/** When the display falls this many steps behind the run, older steps are dropped so it catches up. */
const MAX_BACKLOG = 9;

const pathOf = (u: string | null | undefined): string => {
  if (!u) return '';
  try { const x = new URL(u); return x.pathname + x.search + x.hash; } catch { return u; }
};
const frameIdOf = (src: string): number | null => { const m = /[?&]frame=(\d+)/.exec(src); return m ? Number(m[1]) : null; };
const clock = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour12: false }); };

export function RunProgress({ runId, snapshot: s, status, url, startTime, events, stopping }: RunProgressProps) {
  const frameUrl = (id: number): string => `/api/runs/${runId}/live-preview?frame=${id}`;
  const latestUrl = (): string => `/api/runs/${runId}/live-preview?t=${Date.now()}`;

  const [elapsed, setElapsed] = useState(0);
  const [previewMode, setPreviewMode] = useState<'fit' | 'actual'>('fit');
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [wantedUrl, setWantedUrl] = useState<string>(latestUrl);
  const [shownUrl, setShownUrl] = useState<string>(latestUrl);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [activeBox, setActiveBox] = useState<ActionBox | null>(null);
  const [cursor, setCursor] = useState<CursorPos>({ x: 0, y: 0, visible: false, clicking: false });
  const [current, setCurrent] = useState<Current | null>(null);
  const [layoutTick, setLayoutTick] = useState(0);
  const [openRow, setOpenRow] = useState<number | null>(null);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const queue = useRef<Step[]>([]);
  const playing = useRef(false);
  const lastSeq = useRef<number | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const lastShownAt = useRef(0);
  /** The expected result announced for each element (it arrives with the first event of an interaction). */
  const expectedFor = useRef(new Map<string, string>());

  useEffect(() => {
    const start = startTime ? new Date(startTime).getTime() : Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, [startTime]);

  // The image on screen is only swapped once the next one has loaded (no flash of an empty frame).
  useEffect(() => {
    const img = new Image();
    img.onload = () => setShownUrl(wantedUrl);
    img.src = wantedUrl;
  }, [wantedUrl]);

  useEffect(() => {
    const img = imgRef.current;
    if (!img || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setLayoutTick((n) => n + 1));
    ro.observe(img);
    return () => ro.disconnect();
  }, []);

  // box (tested browser's viewport) -> displayed screenshot. Drawn only on the frame the box was measured on.
  useEffect(() => {
    const img = imgRef.current;
    if (!overlay || !img || frameIdOf(shownUrl) !== overlay.frameId || !img.complete || img.naturalWidth === 0) {
      setActiveBox(null);
      setCursor((p) => (p.visible ? { ...p, visible: false, clicking: false } : p));
      return;
    }
    const rect = mapBoxToDisplay({
      box: overlay.box, viewport: overlay.viewport,
      natural: { width: img.naturalWidth, height: img.naturalHeight },
      displayed: { width: img.clientWidth, height: img.clientHeight },
      offset: { left: img.offsetLeft, top: img.offsetTop },
    });
    if (!rect) { setActiveBox(null); setCursor((p) => ({ ...p, visible: false, clicking: false })); return; }
    setActiveBox({ left: rect.left, top: rect.top, width: Math.max(6, rect.width), height: Math.max(6, rect.height), kind: overlay.kind, badge: overlay.badge });
    setCursor({ x: rect.centerX, y: rect.centerY, visible: true, clicking: overlay.clicking });
  }, [overlay, shownUrl, layoutTick]);

  // ---- playback: one step at a time, each long enough to be seen
  const later = (ms: number, fn: () => void): void => { timers.current.push(setTimeout(fn, ms)); };
  const play = (): void => {
    if (playing.current) return;
    // Far behind the run: skip WHOLE interactions, so what is shown next still starts at its target and click. The cut is
    // made at the start of the most recent interaction that leaves a short backlog.
    if (queue.current.length > MAX_BACKLOG) {
      const q = queue.current;
      const starts = q.map((x, i) => ((x.stage === 'TARGETING' || x.stage === 'CLICKING') && (i === 0 || q[i - 1]!.target !== x.target) ? i : -1)).filter((i) => i > 0);
      const cut = starts.filter((i) => q.length - i >= 3).pop() ?? starts.pop();
      if (cut) q.splice(0, cut);
    }
    const step = queue.current.shift();
    if (!step) return;
    playing.current = true;
    lastShownAt.current = Date.now();
    // a little quicker while there is a backlog, never so quick that a click cannot be followed
    const pace = queue.current.length > 3 ? 0.7 : 1;
    const done = (ms: number): void => later(ms * pace, () => { playing.current = false; play(); });
    const overlayFor = (kind: Kind, badge: string, clicking: boolean): Overlay | null =>
      step.box && typeof step.frameId === 'number'
        ? { frameId: step.frameId, box: step.box, viewport: { width: step.box.vpWidth || 1440, height: step.box.vpHeight || 900 }, kind, badge, clicking }
        : null;
    if (typeof step.frameId === 'number') setWantedUrl(frameUrl(step.frameId));

    if (step.stage === 'TARGETING') {
      setCurrent({ target: step.target, verb: step.verb, stage: 'TARGETING', expected: step.expected });
      setOverlay(overlayFor('targeted', 'TARGET', false));
      done(DWELL.target);
    } else if (step.stage === 'CLICKING') {
      // target -> cursor arrives -> click: the same frame, shown in two beats
      setCurrent((c) => ({ target: step.target, verb: step.verb, stage: 'TARGETING', expected: step.expected ?? (c?.target === step.target ? c.expected : undefined) }));
      setOverlay(overlayFor('targeted', 'TARGET', false));
      later(DWELL.target * pace, () => {
        setCurrent((c) => (c ? { ...c, stage: 'CLICKING' } : c));
        setOverlay(overlayFor('clicking', step.verb.toUpperCase(), true));
      });
      done(DWELL.target + DWELL.click);
    } else if (step.stage === 'OBSERVING' || step.stage === 'VERIFYING') {
      // the resulting state of the page, when this step brings its own frame
      setCurrent((c) => ({ target: step.target, verb: step.verb, stage: step.stage, expected: step.expected ?? (c?.target === step.target ? c.expected : undefined) }));
      if (typeof step.frameId === 'number') { setOverlay(overlayFor(step.stage === 'OBSERVING' ? 'observing' : 'verifying', step.stage, false)); done(DWELL.state); } else { setOverlay((o) => (o ? { ...o, clicking: false, kind: 'observing', badge: step.stage! } : o)); done(DWELL.plain); }
    } else if (step.stage === 'RESULT') {
      const outcome: Current['outcome'] = step.verdict === 'PASS' || (step.verdict === undefined && step.ok) ? 'pass' : step.verdict === 'FAIL' ? 'fail' : 'review';
      setCurrent((c) => ({ target: step.target, verb: step.verb, stage: 'RESULT', expected: step.expected ?? (c?.target === step.target ? c.expected : undefined), actual: step.actual, outcome }));
      const badge = outcome === 'pass' ? 'PASS' : outcome === 'fail' ? 'FAIL' : 'INCONCLUSIVE';
      if (typeof step.frameId === 'number') setOverlay(overlayFor(outcome, badge, false)); else setOverlay((o) => (o ? { ...o, clicking: false, kind: outcome, badge } : o));
      done(DWELL.result);
    } else {
      // a plain frame (page loaded, crawling): no overlay
      setOverlay(null);
      if (typeof step.frameId !== 'number') setWantedUrl(latestUrl());
      done(DWELL.plain);
    }
  };

  useEffect(() => {
    if (events.length === 0) return;
    // on first sight of a run already in progress, do not replay its history: start from the last few events
    if (lastSeq.current === null) lastSeq.current = events.length > 6 ? events[events.length - 6]!.seq : 0;
    for (const e of events) {
      if (e.seq <= lastSeq.current) continue;
      lastSeq.current = e.seq;
      const d = (e.data ?? {}) as { type?: string; target?: string; phase?: string; verdict?: string; ok?: boolean; expected?: string; actual?: string; frameId?: number; box?: Step['box']; source?: string };
      if (e.type === 'frame') {
        if (!d.phase) queue.current.push({ stage: null, target: '', verb: '', frameId: d.frameId }); // action frames arrive again as the action itself
        continue;
      }
      if (e.type !== 'action' || !d.phase) continue;
      const stage: Stage | null = d.phase === 'TARGETED' || d.phase === 'MOVING' ? 'TARGETING' : (STAGES as string[]).includes(d.phase) ? (d.phase as Stage) : null;
      if (!stage) continue;
      const hasBox = !!d.box && typeof d.box.x === 'number' && typeof d.frameId === 'number';
      // targeting / observing without a frame of their own add nothing to look at: they only update the panel
      if ((stage === 'TARGETING' || stage === 'OBSERVING') && !hasBox && queue.current.length > 0 && queue.current[queue.current.length - 1]!.target === (d.target ?? '')) continue;
      if (typeof d.frameId === 'number') { const warm = new Image(); warm.src = frameUrl(d.frameId); } // loaded before its turn comes
      const verb = d.type && !/^(target|move|observe|verify)$/.test(d.type) && stage !== 'RESULT' ? d.type : stage === 'CLICKING' ? 'click' : '';
      const target = d.target ?? e.message;
      if (d.expected) { expectedFor.current.set(target, d.expected); if (expectedFor.current.size > 200) expectedFor.current.delete(expectedFor.current.keys().next().value as string); }
      queue.current.push({ stage, target, verb: verb || 'click', frameId: d.frameId, box: hasBox ? d.box : undefined, expected: d.expected ?? expectedFor.current.get(target), actual: d.actual, verdict: d.verdict, ok: d.ok });
    }
    play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  // Nothing to play for a while: show the latest frame (crawling, loading, analysing).
  useEffect(() => {
    const t = setInterval(() => {
      if (playing.current || queue.current.length > 0 || Date.now() - lastShownAt.current < 2500) return;
      setOverlay(null);
      setWantedUrl(latestUrl());
    }, 1500);
    return () => { clearInterval(t); timers.current.forEach(clearTimeout); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const mm = Math.floor(elapsed / 60);
  const ss = elapsed % 60;
  const c = s?.counts;
  const st = status.toUpperCase();
  const phase = st === 'DISCOVERING' || st === 'AUTHENTICATING' || st === 'CREATED' ? 'Finding pages' : st === 'ANALYZING' ? 'Explaining findings' : st === 'REPORTING' || st === 'REVIEW' ? 'Writing the report' : 'Testing elements';
  const results = useMemo(() => events.filter((e) => e.type === 'result').slice(-80).reverse(), [events]);
  const stageIndex = current?.stage ? STAGES.indexOf(current.stage) : -1;

  return (
    <div className={`rp ${previewExpanded ? 'rp-expanded' : ''}`}>
      {/* Fixed summary: always visible, one line */}
      <div className="rp-summary">
        <div className="rp-summary-left">
          <span className="live-pulse" />
          <strong>{stopping ? 'STOPPING' : 'RUNNING'}</strong>
          <span className="rp-summary-phase">{phase}</span>
          {s?.currentPage && <code className="rp-summary-page" title={s.currentPage}>{pathOf(s.currentPage) || '/'}</code>}
        </div>
        <div className="rp-summary-counts">
          <span className="rp-count rp-pass"><b>{c?.passed ?? 0}</b> Passed</span>
          <span className="rp-count rp-inc"><b>{(c?.inconclusive ?? 0) + (c?.blocked ?? 0)}</b> Inconclusive</span>
          <span className="rp-count rp-bug"><b>{c?.bugs ?? 0}</b> Confirmed bugs</span>
          <span className="rp-count"><b>{c?.elementsTested ?? 0}</b> tested · pages {c?.pagesTested ?? 0}/{c?.pagesCrawled ?? 0} · {mm}:{ss < 10 ? '0' : ''}{ss}</span>
        </div>
      </div>

      <div className="rp-body">
        {/* The live browser: large, and it stays in view */}
        <div className="rp-stage-col">
          <div className="rp-urlbar">
            <span className="rp-urlbar-text" title={s?.currentPage || url}>{s?.currentPage || url}</span>
            <div className="rp-preview-controls" aria-label="Preview size controls">
              <button
                type="button"
                className={previewMode === 'fit' ? 'active' : ''}
                onClick={() => setPreviewMode('fit')}
              >
                Fit to View
              </button>
              <button
                type="button"
                className={previewMode === 'actual' ? 'active' : ''}
                onClick={() => setPreviewMode('actual')}
              >
                Actual Size
              </button>
              <button type="button" onClick={() => setPreviewExpanded((v) => !v)}>
                {previewExpanded ? 'Normal' : 'Expand'}
              </button>
            </div>
          </div>
          <div className={`live-simulation-stage preview-${previewMode}`}>
            <img ref={imgRef} className="live-shot" alt="Current browser view" src={shownUrl} onLoad={() => setLayoutTick((n) => n + 1)} />
            {activeBox && (
              <div className={`sim-target-box ${activeBox.kind}`} style={{ left: `${activeBox.left}px`, top: `${activeBox.top}px`, width: `${activeBox.width}px`, height: `${activeBox.height}px` }}>
                <div className="target-bracket tl" /><div className="target-bracket tr" /><div className="target-bracket bl" /><div className="target-bracket br" />
                <div className={`sim-target-badge ${activeBox.kind}`}><span className="badge-kind">{activeBox.badge}</span></div>
              </div>
            )}
            {cursor.visible && (
              <div className={`sim-cursor-pointer ${cursor.clicking ? 'clicking' : ''}`} style={{ left: `${cursor.x}px`, top: `${cursor.y}px` }}>
                <div className="sim-cursor-crosshair" />
                <svg className="sim-cursor-svg" viewBox="0 0 24 24" width="22" height="22"><path d="M3 3l7 18 3-7 7-3L3 3z" fill="currentColor" stroke="#000" strokeWidth="1.5" strokeLinejoin="round" /></svg>
                {cursor.clicking && <div className="sim-click-ripple" />}
              </div>
            )}
          </div>
        </div>

        <div className="rp-side">
          {/* CURRENT ACTION: what the agent is doing right now */}
          <section className="rp-current" aria-live="polite">
            <div className="rp-label">Current action</div>
            {current ? (
              <>
                <div className="rp-current-target" title={current.target}>{current.target || '—'}</div>
                <ol className="rp-stages">
                  {STAGES.map((g, i) => (
                    <li key={g} className={`${i < stageIndex ? 'done' : ''} ${i === stageIndex ? `now ${g === 'RESULT' && current.outcome ? `out-${current.outcome}` : ''}` : ''}`}>
                      {g === 'CLICKING' && current.verb && current.verb !== 'click' ? current.verb.toUpperCase() : g === 'RESULT' && i === stageIndex && current.outcome ? (current.outcome === 'pass' ? 'PASS' : current.outcome === 'fail' ? 'FAIL' : 'INCONCLUSIVE') : g}
                    </li>
                  ))}
                </ol>
                <dl className="rp-facts">
                  <dt>Expected</dt><dd>{current.expected || <span className="rp-muted">—</span>}</dd>
                  <dt>Actual</dt><dd>{current.actual || <span className="rp-muted">{current.stage === 'RESULT' ? '—' : 'waiting for the result…'}</span>}</dd>
                </dl>
              </>
            ) : (
              <p className="rp-muted rp-idle">{phase}… the next element will appear here.</p>
            )}
          </section>

          {/* Timeline: one compact line per tested element, newest first; details on demand */}
          <section className="rp-timeline">
            <div className="rp-label">Timeline <span className="rp-muted">({results.length}{results.length === 80 ? '+' : ''} latest)</span></div>
            <div className="rp-timeline-list">
              {results.length === 0 ? (
                <p className="rp-muted rp-idle">Results appear here as each element is tested.</p>
              ) : results.map((e) => {
                const d = (e.data ?? {}) as { page?: string; element?: string; kind?: string; check?: string; outcome?: string; actual?: string; viewport?: string };
                const open = openRow === e.seq;
                return (
                  <div className={`rp-row ${open ? 'open' : ''}`} key={e.seq}>
                    <button type="button" className="rp-row-head" onClick={() => setOpenRow(open ? null : e.seq)} aria-expanded={open}>
                      <span className="rp-row-time">{clock(e.at)}</span>
                      <span className={`rp-dot rc-${d.outcome}`} title={OUTCOME_LABEL[d.outcome ?? ''] ?? d.outcome} />
                      <span className="rp-row-what">{d.element || d.kind}</span>
                      <span className="rp-row-out">{OUTCOME_LABEL[d.outcome ?? ''] ?? d.outcome}</span>
                    </button>
                    {open && (
                      <dl className="rp-row-detail">
                        <dt>Result</dt><dd>{d.actual || '—'}</dd>
                        <dt>Check</dt><dd>{d.kind}{d.check ? ` / ${d.check}` : ''}</dd>
                        <dt>Page</dt><dd><code>{pathOf(d.page) || '/'}</code>{d.viewport ? ` · ${d.viewport}` : ''}</dd>
                      </dl>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
