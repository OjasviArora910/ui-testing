import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { QADatabase } from '../database/db.js';
import type { Decision, FindingView, RunRecord } from '../database/types.js';
import { reviewQueue } from '../database/review.js';
import { generateReports } from '../reporting/index.js';
import { ConfigSchema, deepMerge, type QAConfig } from '../shared/config.js';
import { directAuthToConfig, toPersisted, type AuthSource, type DirectAuth, type PersistedRunRequest, type RunRequest } from '../shared/runRequest.js';
import { AuthConfigSchema, type AuthConfig } from '../shared/types.js';
import { RunExecutor, type ExecutorDeps } from './executor.js';
import { emptySnapshot, type ProgressEvent, type ProgressEventType, type ProgressSnapshot } from './progress.js';

export interface OrchestratorOptions extends ExecutorDeps {
  baseConfig: QAConfig;
  /** Parallel runs allowed (default 1: one browser-driven run at a time). */
  maxConcurrentRuns?: number;
}

interface ActiveRun { abort: AbortController; done: Promise<void>; snapshot: ProgressSnapshot; timer: NodeJS.Timeout }

const BUFFER = 300;

/**
 * Central run lifecycle manager: start / resume / abort / timeout / budgets / cleanup, progress events, and the
 * human-review entry points. All run state lives in SQLite, so any non-terminal run can be resumed after a restart.
 */
export class Orchestrator {
  readonly events = new EventEmitter();
  private readonly active = new Map<string, ActiveRun>();
  private readonly buffers = new Map<string, ProgressEvent[]>();
  private readonly seq = new Map<string, number>();
  private readonly latestFrames = new Map<string, { url: string; viewport: string; action: string; buffer?: Buffer; at: number }>();

  constructor(readonly opts: OrchestratorOptions) { this.events.setMaxListeners(100); }

  get db(): QADatabase { return this.opts.db; }

  // ------------------------------------------------------------------ lifecycle
  /**
   * Validates the request, persists the run WITHOUT any credential, and starts executing in the background.
   * A one-time token (`request.auth`) is registered with the Redactor immediately and handed to the executor in memory only.
   */
  start(request: RunRequest): RunRecord {
    const auth = request.auth ? directAuthToConfig(request.auth) : undefined;
    if (auth) { this.opts.redactor.register(auth.jwt); AuthConfigSchema.parse(auth); }
    if (this.active.size >= (this.opts.maxConcurrentRuns ?? 1)) throw new Error('Another run is already in progress');
    if (request.authProfile && !this.opts.profiles.has(request.authProfile)) throw new Error(`Unknown auth profile "${request.authProfile}"`);
    const overrides: Record<string, unknown> = { ...(request.overrides ?? {}) };
    if (request.viewports) overrides.viewports = request.viewports;
    const config = ConfigSchema.parse(deepMerge(this.opts.baseConfig, overrides));
    const persisted = toPersisted(request);
    const run = this.db.createRun({ url: request.url, authProfile: request.authProfile ?? null, mode: request.mode, request: persisted, config });
    this.launch(run.id, auth);
    return run;
  }

  /** Resume a non-terminal run from its persisted cursor. Runs that used a one-time token need it supplied again. */
  resume(runId: string, directAuth?: DirectAuth): RunRecord {
    const run = this.db.getRun(runId);
    if (!run) throw new Error(`Unknown run ${runId}`);
    if (this.active.has(runId)) throw new Error('Run is already executing');
    if (['COMPLETED'].includes(run.status)) throw new Error('Run already completed');
    if (this.active.size >= (this.opts.maxConcurrentRuns ?? 1)) throw new Error('Another run is already in progress');
    const persisted = run.request as PersistedRunRequest;
    const auth = directAuth ? directAuthToConfig(directAuth) : undefined;
    if (auth) this.opts.redactor.register(auth.jwt);
    if (persisted.authSource === 'token' && !auth) throw new Error('This run used a one-time token, which is never stored. Provide the token again to resume it.');
    this.launch(runId, auth);
    return run;
  }

  /** How a run authenticates (never the secret). */
  authInfo(runId: string): { source: AuthSource; location?: string; profile?: string } {
    const r = this.db.getRun(runId)?.request as PersistedRunRequest | undefined;
    return { source: r?.authSource ?? (r?.authProfile ? 'profile' : 'none'), location: r?.authLocation, profile: r?.authProfile };
  }

  /** Runs found in a non-terminal state (process died mid-run). */
  interruptedRuns(): RunRecord[] { return this.db.listIncompleteRuns().filter((r) => !this.active.has(r.id)); }

  private launch(runId: string, auth?: AuthConfig): void {
    const run = this.db.getRun(runId)!;
    const cfg = run.config as QAConfig;
    const abort = new AbortController();
    const snapshot = emptySnapshot(runId, run.status);
    const timer = setTimeout(() => abort.abort('timeout'), cfg.timeouts.runMs);
    // `auth` is captured only by this closure/executor and released when the run ends (the executor is not retained).
    const hooks = {
      signal: abort.signal,
      snapshot,
      auth,
      emit: (type: ProgressEventType, message: string, data?: Record<string, unknown>) => this.emit(runId, type, message, data),
      setFrame: (frame: { url: string; viewport: string; action: string; buffer?: Buffer }) => this.setFrame(runId, frame),
    };
    const executor = new RunExecutor(this.opts, runId, hooks);
    const done = executor.execute().catch((e) => {
      this.db.setStatus(runId, 'ERROR', { error: e instanceof Error ? e.message : String(e) });
      this.emit(runId, 'error', e instanceof Error ? e.message : String(e));
    }).finally(() => { clearTimeout(timer); this.active.delete(runId); });
    this.active.set(runId, { abort, done, snapshot, timer });
    this.emit(runId, 'log', run.status === 'CREATED' ? 'run started' : `run resumed from ${run.status}`);
  }

  /** Stop a run. The run keeps everything found so far and still produces a (partial) report. */
  abort(runId: string, reason = 'stopped by user'): boolean {
    const a = this.active.get(runId);
    if (!a) return false;
    a.abort.abort(reason);
    return true;
  }

  isActive(runId: string): boolean { return this.active.has(runId); }
  async whenDone(runId: string): Promise<RunRecord> {
    await this.active.get(runId)?.done;
    return this.db.getRun(runId)!;
  }
  /** Abort everything and wait (graceful shutdown). */
  async shutdown(): Promise<void> {
    for (const [id, a] of this.active) a.abort.abort('server shutdown');
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
  }

  // ------------------------------------------------------------------ progress
  private emit(runId: string, type: ProgressEventType, message: string, data?: Record<string, unknown>): void {
    const seq = (this.seq.get(runId) ?? 0) + 1;
    this.seq.set(runId, seq);
    const ev: ProgressEvent = { runId, seq, at: new Date().toISOString(), type, message, data };
    const buf = this.buffers.get(runId) ?? [];
    buf.push(ev); if (buf.length > BUFFER) buf.shift();
    this.buffers.set(runId, buf);
    this.events.emit('event', ev);
  }
  /** Events with seq > after (for late SSE subscribers). */
  replay(runId: string, after = 0): ProgressEvent[] { return (this.buffers.get(runId) ?? []).filter((e) => e.seq > after); }

  /** Live snapshot for an active run; derived from the database for finished/idle runs. */
  snapshot(runId: string): ProgressSnapshot | null {
    const live = this.active.get(runId)?.snapshot;
    if (live) return { ...live };
    const run = this.db.getRun(runId);
    if (!run) return null;
    const findings = this.db.listFindings(runId).filter((f) => f.reviewState !== 'dismissed');
    const categories: Record<string, number> = {};
    for (const f of findings) categories[f.category] = (categories[f.category] ?? 0) + 1;
    const pages = this.db.listPages(runId);
    const vps = (run.config as QAConfig).viewports.length;
    return {
      ...emptySnapshot(runId, run.status), pagesDiscovered: pages.length, unitsDone: run.state?.testedUnits.length ?? 0,
      unitsTotal: pages.filter((p) => p.model).length * vps, actionsUsed: run.state?.actionsUsed ?? 0, findings: findings.length, categories,
      errors: run.error ? [run.error] : [],
    };
  }

  // ------------------------------------------------------------------ human review
  reviewQueue(runId: string): FindingView[] {
    const analyses = this.db.analysesByFinding(runId);
    return reviewQueue(this.db.listFindings(runId)).sort((a, b) => (analyses.get(a.id)?.priority ?? 3) - (analyses.get(b.id)?.priority ?? 3));
  }

  /** Persist a human decision and regenerate the reports/verdict. This is the only path to "confirmed". */
  decide(findingId: string, decision: Decision, note: string | undefined, decidedBy: string): FindingView {
    this.db.addDecision({ findingId, decision, note, decidedBy });
    const f = this.db.getFinding(findingId)!;
    this.refreshReport(f.runId);
    return this.db.getFindingView(findingId)!;
  }

  refreshReport(runId: string): void {
    const run = this.db.getRun(runId);
    if (!run || this.active.has(runId) || !['COMPLETED', 'ABORTED', 'REVIEW'].includes(run.status)) return;
    generateReports(this.db, this.opts.evidence, runId, this.opts.reportsDir);
  }

  /** Human-initiated: approve the stored current screenshot of a page/viewport as the new visual baseline. */
  approveBaseline(runId: string, pageUrl: string, viewport: string, approvedBy: string): { file: string; sha256: string } {
    const ev = this.db.listEvidence(runId).reverse().find((e) => e.kind === 'visual-current' && e.page === this.opts.redactor.redactUrl(pageUrl) && e.viewport === viewport);
    if (!ev) throw new Error('No current screenshot is stored for that page/viewport in this run');
    const png = this.opts.evidence.read(ev);
    const cfg = this.db.getRun(runId)!.config as QAConfig;
    const meta = this.opts.baselines.save(pageUrl, viewport, png, cfg.visualThresholds.maskSelectors);
    this.db.addBaseline({ url: pageUrl, viewport, file: path.relative(process.cwd(), meta.file), sha256: meta.sha256, maskSelectors: meta.maskSelectors, runId, approvedBy });
    return { file: meta.file, sha256: meta.sha256 };
  }

  reportPath(runId: string, kind: 'html' | 'json' | 'xml'): string | null {
    const f = path.join(this.opts.reportsDir, runId, `report.${kind}`);
    return fs.existsSync(f) ? f : null;
  }

  setFrame(runId: string, frame: { url: string; viewport: string; action: string; buffer?: Buffer }): void {
    this.latestFrames.set(runId, { ...frame, at: Date.now() });
  }

  getFrame(runId: string): { url: string; viewport: string; action: string; buffer?: Buffer; at: number } | undefined {
    return this.latestFrames.get(runId);
  }

  buildSimulation(runId: string) {
    const actions = this.db.listActions(runId);
    const evidence = this.db.listEvidence(runId);
    const findings = this.db.listFindings(runId);
    const run = this.db.getRun(runId);
    const defaultUrl = run?.url ?? '';

    const screenshotMap = new Map<string, string>();
    const pageScreenshotMap = new Map<string, string>();
    for (const e of evidence) {
      if ((e.kind === 'visual-current' || e.kind === 'screenshot') && e.page) {
        if (!pageScreenshotMap.has(e.page)) pageScreenshotMap.set(e.page, `/api/runs/${runId}/evidence/${e.id}`);
        if (e.viewport) {
          const vpKey = `${e.page}|${e.viewport}`;
          if (!screenshotMap.has(vpKey)) screenshotMap.set(vpKey, `/api/runs/${runId}/evidence/${e.id}`);
        }
      }
    }

    return actions.map((a, idx) => {
      const pageUrl = a.pageUrl || defaultUrl;
      const vp = a.viewport || 'desktop';
      const screenshotUrl = screenshotMap.get(`${pageUrl}|${vp}`) || pageScreenshotMap.get(pageUrl) || null;
      const stepFindings = findings.filter((f) => f.page === pageUrl && (!a.viewport || f.viewport === a.viewport));

      return {
        id: a.id ?? idx + 1,
        url: pageUrl,
        viewport: vp,
        source: a.source,
        action: a.type,
        target: a.target,
        ok: !!a.ok,
        detail: a.detail || null,
        at: a.at,
        screenshotUrl,
        findingsCount: stepFindings.length,
        findings: stepFindings.slice(0, 3).map((f) => ({
          id: f.id,
          ruleId: f.ruleId,
          severity: f.severity,
          actual: f.actual,
        })),
      };
    });
  }
}

