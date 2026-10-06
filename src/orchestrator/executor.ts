import fs from 'node:fs';
import path from 'node:path';
import { runAxe, runKeyboardCheck } from '../accessibility/index.js';
import type { AIProvider } from '../ai/index.js';
import { analyzeFindings, buildDigest } from '../ai/index.js';
import { ReactAgent } from '../agent/index.js';
import { BrowserController, type BrowserControllerOptions } from '../browser/index.js';
import type { QADatabase } from '../database/db.js';
import type { RunRecord, RunState, RunStatus } from '../database/types.js';
import { crawl } from '../discovery/crawler.js';
import { buildPageModel } from '../discovery/pageModel.js';
import type { PageModel } from '../discovery/types.js';
import { classifyPage, classifyResult, controlKey, sameRootCause, selectTests, type TestPlan } from '../dynamic/index.js';
import { captureHighlightedElementScreenshot, capturePageEvidence, evidenceFor, type EvidenceRef, type EvidenceStore, type PageEvidence } from '../evidence/index.js';
import {
  ActionBudget,
  ActionGuard,
  findingFromResult,
  producesFinding,
  runFunctionalTests,
  type ActionPhase,
  type ConfidenceLevel,
  type FunctionalResult,
  type InferredIntent,
  type VerificationVerdict,
} from '../functional/index.js';
import { runCounts } from '../reporting/data.js';
import { generateReports } from '../reporting/index.js';
import { collectRuleContext } from '../rules/context.js';
import { buildRegistry, type RuleRegistry } from '../rules/index.js';
import type { AuthProfileResolver } from '../shared/authProfiles.js';
import type { QAConfig } from '../shared/config.js';
import type { Redactor } from '../shared/redactor.js';
import type { PersistedRunRequest } from '../shared/runRequest.js';
import type { AuthConfig, BoundingBox, Finding, Viewport } from '../shared/types.js';
import { BaselineStore, VisualTester } from '../visual/index.js';
import type { ProgressEventType, ProgressSnapshot } from './progress.js';

export interface ExecutorDeps {
  db: QADatabase;
  redactor: Redactor;
  profiles: AuthProfileResolver;
  evidence: EvidenceStore;
  baselines: BaselineStore;
  provider: AIProvider | null;
  reportsDir: string;
  /** Extra BrowserController options (e.g. executablePath, launchArgs, headless). */
  launch?: Partial<BrowserControllerOptions>;
  /** Record a Playwright trace for the whole run (default true). */
  trace?: boolean;
}

export interface ExecutorHooks {
  signal: AbortSignal;
  emit(type: ProgressEventType, message: string, data?: Record<string, unknown>): void;
  setFrame?(frame: { url: string; viewport: string; action: string; buffer?: Buffer }): void;
  snapshot: ProgressSnapshot;
  /** One-time token given with the URL. In memory only; never part of persisted run data. */
  auth?: AuthConfig;
}

class StopRun extends Error { constructor(readonly reason: string) { super(reason); } }

const errMsg = (e: unknown): string => (e instanceof Error ? e.message.split('\n')[0]! : String(e));
const SEVERITY_ORDER = { critical: 0, major: 1, minor: 2, info: 3 } as const;

/**
 * Executes one run through the lifecycle
 * CREATED -> AUTHENTICATING -> DISCOVERING -> TESTING -> ANALYZING -> REVIEW -> REPORTING -> COMPLETED
 * and persists a resumable cursor (RunState) after each unit of work.
 */
export class RunExecutor {
  private readonly db: QADatabase;
  private run!: RunRecord;
  private config!: QAConfig;
  private request!: PersistedRunRequest;
  private state!: RunState;
  private controller?: BrowserController;
  private guard!: ActionGuard;
  private registry!: RuleRegistry;
  private budget!: ActionBudget;
  private testedLinks = new Set<string>();
  private verifiedControls = new Set<string>();

  constructor(private readonly deps: ExecutorDeps, private readonly runId: string, private readonly hooks: ExecutorHooks) { this.db = deps.db; }

  // ------------------------------------------------------------------ helpers
  private get snap(): ProgressSnapshot { return this.hooks.snapshot; }
  private setStatus(status: RunStatus): void {
    this.db.setStatus(this.runId, status);
    this.state.phase = status; this.snap.status = status; this.save();
    this.hooks.emit('status', status);
  }
  private save(): void {
    this.state.actionsUsed = this.budget?.used ?? this.state.actionsUsed;
    this.state.testedLinks = [...this.testedLinks];
    this.state.verifiedControls = [...this.verifiedControls];
    this.db.saveState(this.runId, this.state);
    this.snap.actionsUsed = this.state.actionsUsed;
  }
  private check(): void {
    if (this.hooks.signal.aborted) throw new StopRun(String(this.hooks.signal.reason ?? 'aborted'));
  }
  private refreshCounts(): void {
    const f = this.db.listFindings(this.runId).filter((x) => x.reviewState !== 'dismissed');
    this.snap.findings = f.length;
    this.snap.categories = {};
    for (const x of f) this.snap.categories[x.category] = (this.snap.categories[x.category] ?? 0) + 1;
    this.snap.counts = runCounts(this.db, this.runId);
  }
  private action(
    source: string,
    type: string,
    target: string,
    ok: boolean,
    detail?: string,
    page?: string,
    viewport?: string,
    box?: (BoundingBox & { vpWidth?: number; vpHeight?: number }) | null,
    meta?: {
      phase?: ActionPhase;
      intent?: InferredIntent;
      verdict?: VerificationVerdict;
      confidence?: ConfidenceLevel;
      expected?: string;
      actual?: string;
      durationMs?: number;
    },
  ): void {
    this.db.addAction(this.runId, { pageUrl: page, viewport, source, type, target, ok, detail });
    const phasePrefix = meta?.phase ? `[${meta.phase}] ` : '';
    this.snap.currentAction = `${phasePrefix}${type} ${target}`.slice(0, 120);
    this.hooks.emit('action', `${phasePrefix}${type} ${target}`, {
      ok,
      source,
      page,
      viewport,
      target,
      detail,
      box,
      phase: meta?.phase,
      intent: meta?.intent,
      verdict: meta?.verdict,
      confidence: meta?.confidence,
      expected: meta?.expected,
      actual: meta?.actual,
      durationMs: meta?.durationMs,
    });
  }

  // ------------------------------------------------------------------ main
  async execute(): Promise<void> {
    const run = this.db.getRun(this.runId);
    if (!run) throw new Error(`Unknown run ${this.runId}`);
    this.run = run;
    this.config = run.config as QAConfig;
    this.request = run.request as PersistedRunRequest;
    this.state = run.state ?? { phase: 'CREATED', testedUnits: [], actionsUsed: 0, testedLinks: [] };
    this.testedLinks = new Set(this.state.testedLinks);
    this.verifiedControls = new Set(this.state.verifiedControls ?? []);
    this.budget = new ActionBudget(this.config.maxActions);
    this.budget.used = this.state.actionsUsed;
    this.snap.actionsUsed = this.budget.used;
    this.registry = await buildRegistry(this.config);

    let outcome: 'completed' | 'aborted' | 'error' = 'completed';
    let reason = '';
    // Stopping must not wait for the current page, click or 30s navigation to finish: end the tester loops and close the
    // browser, which makes every pending browser call reject right away. Results gathered so far are kept and reported.
    const onAbort = (): void => { this.budget.halt(); void this.controller?.close().catch(() => undefined); };
    if (this.hooks.signal.aborted) onAbort(); else this.hooks.signal.addEventListener('abort', onAbort, { once: true });
    try {
      await this.authenticate();
      await this.discover();
      await this.test();
      await this.explore();
      await this.analyze();
      this.setStatus('REVIEW');
    } catch (e) {
      if (e instanceof StopRun) { outcome = 'aborted'; reason = e.reason; }
      // errors raised because the browser was closed by a stop request are part of stopping, not a failed run
      else if (this.hooks.signal.aborted) { outcome = 'aborted'; reason = String(this.hooks.signal.reason ?? 'stopped by user'); }
      else { outcome = 'error'; reason = errMsg(e); }
    }

    await this.finish(outcome, reason);
  }

  private async finish(outcome: 'completed' | 'aborted' | 'error', reason: string): Promise<void> {
    try {
      if (this.controller) {
        const tracePath = path.join(this.deps.reportsDir, this.runId, 'trace.zip');
        if (await this.controller.stopTrace(tracePath).catch(() => false)) {
          const buf = fs.readFileSync(tracePath);
          this.db.addEvidence(this.deps.evidence.saveBinary(this.runId, 'trace', buf, 'zip', { label: 'Playwright trace (whole run)' }));
        }
      }
    } catch { /* trace is best effort */ } finally {
      await this.controller?.close();
    }
    if (outcome === 'error') {
      this.db.setStatus(this.runId, 'ERROR', { error: reason });
      this.snap.status = 'ERROR'; this.snap.errors.push(reason);
      this.hooks.emit('error', reason);
    }
    if (outcome === 'aborted') {
      this.db.setStatus(this.runId, 'ABORTED', { abortReason: reason });
      this.snap.status = 'ABORTED';
      this.hooks.emit('warning', `Run stopped: ${reason}`);
    }
    if (outcome === 'error') {
      // Still write the summary/verdict and reports, so a failed run shows FAILED with its reason instead of an empty result.
      try { this.db.saveRulesRun(this.runId, this.registry.enabled(this.config).map((r) => r.id)); generateReports(this.db, this.deps.evidence, this.runId, this.deps.reportsDir); } catch { /* best effort */ }
    }
    if (outcome !== 'error') {
      try {
        if (outcome === 'completed') { this.state.phase = 'REPORTING'; this.db.setStatus(this.runId, 'REPORTING'); this.snap.status = 'REPORTING'; this.hooks.emit('status', 'REPORTING'); }
        this.db.saveRulesRun(this.runId, this.registry.enabled(this.config).map((r) => r.id));
        const rep = generateReports(this.db, this.deps.evidence, this.runId, this.deps.reportsDir);
        if (outcome === 'completed') { this.db.setStatus(this.runId, 'COMPLETED'); this.snap.status = 'COMPLETED'; }
        this.hooks.emit('done', `Verdict: ${rep.data.run.verdict}`, { verdict: rep.data.run.verdict, incomplete: rep.data.incomplete });
      } catch (e) {
        this.db.setStatus(this.runId, 'ERROR', { error: `report generation failed: ${errMsg(e)}` });
        this.hooks.emit('error', `report generation failed: ${errMsg(e)}`);
      }
    }
    this.save();
  }

  // ------------------------------------------------------------------ 1. authenticate
  private async authenticate(): Promise<void> {
    this.check();
    this.setStatus('AUTHENTICATING');
    let auth: AuthConfig | undefined;
    let authLabel = '';
    if (this.request.authSource === 'token') {
      // The token is never persisted, so a resumed run must be given it again.
      if (!this.hooks.auth) throw new Error('This run used a one-time token, which is never stored. Provide the token again to resume it.');
      auth = this.hooks.auth;
      authLabel = `the supplied token (${auth.location})`;
    } else if (this.request.authProfile) {
      auth = this.deps.profiles.resolve(this.request.authProfile); // throws (without the secret) when unavailable
      authLabel = `auth profile "${this.request.authProfile}"`;
    }
    if (auth) this.deps.redactor.register(auth.jwt);
    const first = this.config.viewports[0]!;
    // A Playwright trace records cookies, storage and request headers, i.e. the token itself: never trace authenticated runs.
    const trace = this.deps.trace !== false && !auth;
    if (auth && this.deps.trace !== false) this.hooks.emit('log', 'Playwright trace disabled for this run because it uses credentials');
    this.controller = await BrowserController.launch({
      baseUrl: this.request.url, viewport: first, auth, redactor: this.deps.redactor, ignoredEndpoints: this.config.ignoredEndpoints,
      actionTimeoutMs: this.config.timeouts.actionMs, navigationTimeoutMs: this.config.timeouts.navigationMs,
      blockExternal: true, ...this.deps.launch, trace,
    });
    this.check(); // a stop requested while the browser was starting
    this.guard = new ActionGuard({ keywords: this.config.dangerousActions.keywords, allowMethods: this.config.dangerousActions.allowMethods, origin: this.request.url });
    this.controller.setRequestGuard(this.guard.asRequestGuard());

    const nav = await this.controller.navigate(this.request.url);
    if (!nav.ok) {
      // A run that could not open its target must read as a failure, never as "nothing found".
      this.unreachable(this.request.url, first.name, nav.error);
      throw new Error(`PAGE UNREACHABLE: ${this.request.url} could not be opened (${nav.error}). Nothing was tested.`);
    }
    if (nav.partial) this.hooks.emit('warning', `${this.request.url} is usable but did not finish loading within ${Math.round(this.config.timeouts.navigationMs / 1000)}s (a resource is still pending); continuing with the loaded document.`);
    const initBuf = await this.controller.page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => null);
    if (initBuf) {
      this.hooks.setFrame?.({ url: this.request.url, viewport: first.name, action: `loaded ${this.request.url}`, buffer: initBuf });
      this.hooks.emit('frame', `frame @ ${this.request.url} [${first.name}]`, { url: this.request.url, viewport: first.name });
    }
    if (auth && (nav.status === 401 || nav.status === 403)) {
      this.insertSimple({ ruleId: 'auth.rejected', category: 'auth', severity: 'major', classification: 'anomaly', basis: null, page: this.request.url, viewport: first.name, element: null,
        expected: 'The supplied credentials are accepted by the target', actual: `Target returned HTTP ${nav.status} for the first request using ${authLabel}`, evidence: [] });
      this.hooks.emit('warning', `Credentials rejected: ${authLabel} got HTTP ${nav.status}. The token may be expired or placed in the wrong location.`);
    }
    this.action('auth', 'navigate', this.request.url, true, `HTTP ${nav.status ?? '?'}`);
  }

  private unreachable(url: string, viewport: string, error?: string): void {
    this.insertSimple({
      ruleId: 'navigation.unreachable', category: 'network', severity: 'critical', classification: 'defect', basis: 'deterministic', page: url, viewport, element: null,
      expected: 'The page opens and its document becomes usable within the navigation timeout', actual: `PAGE UNREACHABLE: ${error ?? 'navigation failed'}. This page was not tested.`, evidence: [],
    });
    this.hooks.emit('warning', `PAGE UNREACHABLE: ${url} (${error ?? 'navigation failed'})`);
  }

  private insertSimple(f: Finding): string | null {
    const r = this.db.insertFinding(this.runId, f);
    if (r.inserted) { this.hooks.emit('finding', `${f.severity} ${f.ruleId}`, { ruleId: f.ruleId, category: f.category }); this.refreshCounts(); }
    return r.inserted ? r.id : null;
  }

  // ------------------------------------------------------------------ 2. discover
  private async discover(): Promise<void> {
    const c = this.controller!;
    if (!this.state.crawlDone) {
      this.check();
      this.setStatus('DISCOVERING');
      await crawl(c, {
        startUrl: this.request.url, maxPages: this.config.maxPages, maxDepth: this.config.maxDepth, initial: this.state.crawl,
        allowLink: (l) => this.guard.check({ kind: 'navigate', url: l.href, text: l.text, selector: l.selector }).allowed,
        shouldStop: () => this.hooks.signal.aborted,
        onPage: async (p, st) => {
          this.db.upsertPage(this.runId, { url: p.url, depth: p.depth, statusCode: p.status ?? null, title: p.model?.title ?? null, error: p.error ?? null, model: p.model ?? undefined, testStatus: p.model ? 'pending' : 'skipped' });
          this.state.crawl = st; this.save();
          this.snap.currentPage = p.url; this.snap.pagesDiscovered = st.visited.length;
          this.hooks.emit('page', `discovered ${p.url}`, { status: p.status, depth: p.depth });
          const crawlBuf = await c.page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => null);
          if (crawlBuf) {
            this.hooks.setFrame?.({ url: p.url, viewport: this.config.viewports[0]?.name || 'desktop', action: `crawling ${p.url}`, buffer: crawlBuf });
            this.hooks.emit('frame', `frame @ ${p.url}`, { url: p.url, viewport: this.config.viewports[0]?.name || 'desktop' });
          }
          this.action('crawler', 'visit', p.url, !p.error, p.error, p.url);
          if (p.depth === 0 && (p.status ?? 0) >= 400) {
            this.insertSimple({ ruleId: 'navigation.http-error', category: 'network', severity: 'major', classification: 'defect', basis: 'deterministic', page: p.url, viewport: this.config.viewports[0]!.name, element: null,
              expected: 'The start URL loads successfully', actual: `GET ${p.url} returned HTTP ${p.status}`, evidence: [] });
          }
        },
      });
      this.check();
      this.state.crawlDone = true; this.save();
    }
    this.snap.pagesDiscovered = this.db.listPages(this.runId).length;
  }

  // ------------------------------------------------------------------ 3. test
  private async test(): Promise<void> {
    const c = this.controller!;
    this.check();
    this.setStatus('TESTING');
    const pages = this.db.listPages(this.runId).filter((p) => p.model && (p.statusCode ?? 200) < 400);
    const viewports = this.config.viewports;
    this.snap.unitsTotal = pages.length * viewports.length;
    this.snap.unitsDone = this.state.testedUnits.length;
    const visual = new VisualTester(this.deps.baselines, this.config.visualThresholds);

    for (const page of pages) {
      for (const vp of viewports) {
        this.check();
        const unit = `${page.url}|${vp.name}`;
        if (this.state.testedUnits.includes(unit)) continue;
        this.snap.currentPage = page.url; this.snap.currentViewport = vp.name;
        this.hooks.emit('page', `testing ${page.url} @ ${vp.name}`);
        try { await this.testUnit(c, page.url, vp, vp === viewports[0], visual); } catch (e) {
          if (e instanceof StopRun) throw e;
          this.check(); // stopped mid-unit: leave it untested so a resume repeats it
          this.hooks.emit('warning', `Unit ${unit} failed: ${errMsg(e)}`);
          this.action('orchestrator', 'unit-error', unit, false, errMsg(e), page.url, vp.name);
        }
        this.state.testedUnits.push(unit); this.snap.unitsDone++; this.save();
      }
      this.db.setPageTested(this.runId, page.url, 'tested');
      this.snap.counts = runCounts(this.db, this.runId);
    }
  }

  private async testUnit(c: BrowserController, url: string, vp: Viewport, isFirst: boolean, visual: VisualTester): Promise<void> {
    const cfg = this.config;
    await c.setViewport(vp);
    const n0 = c.events.network.length; const k0 = c.events.console.length;
    const nav = await c.navigate(url);
    this.action('orchestrator', 'navigate', url, nav.ok, nav.error ?? (nav.partial ? 'usable, but the page did not finish loading' : undefined), url, vp.name);
    if (!nav.ok) { this.unreachable(url, vp.name, nav.error); return; }
    const unitBuf = await c.page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => null);
    if (unitBuf) {
      this.hooks.setFrame?.({ url, viewport: vp.name, action: `inspecting ${url}`, buffer: unitBuf });
      this.hooks.emit('frame', `frame @ ${url} [${vp.name}]`, { url, viewport: vp.name });
    }
    // Let page-load requests finish (bounded) so slow and failing APIs are observed with their real duration/status.
    await c.waitForIdle(cfg.network.slowRequestMs + 1000);
    const network = c.events.network.slice(n0); const consoleEv = c.events.console.slice(k0);
    const model = await buildPageModel(c, { status: nav.status });
    this.check();

    // visual first (before focus changes from the keyboard check could alter the pixels)
    const vis = await visual.check(c, { artifactDir: path.join(this.deps.reportsDir, this.runId, 'visual'), label: `${vp.name}-${path.basename(new URL(url).pathname) || 'root'}` });
    this.action('visual', vis.result.status, url, vis.result.status !== 'SKIPPED', vis.result.reason, url, vp.name);
    if (vis.currentPng && vis.currentPng.length > 0) {
      this.hooks.setFrame?.({ url, viewport: vp.name, action: `inspected ${url}`, buffer: vis.currentPng });
      this.hooks.emit('frame', `frame @ ${url} [${vp.name}]`, { url, viewport: vp.name });
    }

    let axe: Awaited<ReturnType<typeof runAxe>> = []; let keyboard = null;
    if (cfg.accessibility.enabled && (isFirst || cfg.accessibility.allViewports)) {
      try { axe = await runAxe(c); } catch (e) { this.hooks.emit('warning', `axe failed on ${url}: ${errMsg(e)}`); }
      if (cfg.accessibility.keyboard) { try { keyboard = await runKeyboardCheck(c, model); } catch (e) { this.hooks.emit('warning', `keyboard check failed: ${errMsg(e)}`); } }
    }

    // ---- 1. Checks that look at the page as loaded (layout, images, responsive, load-time network/console, visual).
    // They run BEFORE any interaction and their findings are saved immediately, so stopping later cannot lose them.
    const ctx = await collectRuleContext(c, { config: cfg, model, network, console: consoleEv, functional: [], axe, keyboard, visual: vis.result });
    const res = await this.registry.run(ctx, (r) => !r.id.startsWith('functional.'));
    for (const e of res.errors) this.hooks.emit('warning', `rule ${e.ruleId}: ${e.message}`);
    let pageEv: PageEvidence | null = null;
    if (res.findings.length > 0) {
      pageEv = await capturePageEvidence(c, this.deps.evidence, this.runId, ctx, vis);
      for (const r of pageEv.all) this.db.addEvidence(r);
    } else if (vis.result.status === 'NO_BASELINE_AVAILABLE' && vis.currentPng.length > 0) {
      this.db.addEvidence(this.deps.evidence.saveBinary(this.runId, 'visual-current', vis.currentPng, 'png', { page: url, viewport: vp.name, label: 'current screenshot (no baseline yet)' }));
    }
    let crops = 0;
    // most severe first, so the per-page limit on focused screenshots is spent on what matters
    for (const f of [...res.findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])) {
      let crop;
      if (pageEv && crops < 50 && f.element) {
        crop = await captureHighlightedElementScreenshot(c, this.deps.evidence, this.runId, f);
        if (crop) { this.db.addEvidence(crop); crops++; }
      }
      this.insertSimple({ ...f, evidence: pageEv ? evidenceFor(f, pageEv, crop).map((r) => r.id) : [] });
    }
    this.save();
    this.check();

    // ---- 2. Interactions: every element is tested once and its result is saved the moment it finishes.
    if (isFirst || cfg.functional.allViewports) {
      const plan = cfg.dynamic?.enabled ? this.planFor(url, vp.name, model) : undefined;
      const needCapture: { id: string; finding: Finding }[] = [];
      this.snap.currentAction = 'testing elements';
      const functional = await runFunctionalTests({
        controller: c, guard: this.guard, pageUrl: url, model, config: cfg, budget: this.budget, testedLinks: this.testedLinks, plan,
        onResult: (r) => this.recordResult(url, vp, r, needCapture),
        onAction: (a) => {
          if (a.buffer) {
            this.hooks.setFrame?.({ url, viewport: vp.name, action: `${a.phase ? `[${a.phase}] ` : ''}${a.type} ${a.target}`, buffer: a.buffer });
          }
          this.action('functional', a.type, a.target, a.ok, a.detail, url, vp.name, a.box, {
            phase: a.phase,
            intent: a.intent,
            verdict: a.verdict,
            confidence: a.confidence,
            expected: a.expected,
            actual: a.actual,
            durationMs: a.durationMs,
          });
        },
      });
      this.check(); // stopped: everything finished so far is already saved; the page stays "not tested"
      // A failure that carries no before/after of its own gets a capture of the element now that the page is back as loaded.
      for (const n of needCapture.slice(0, 30)) {
        const crop = await captureHighlightedElementScreenshot(c, this.deps.evidence, this.runId, n.finding).catch(() => undefined);
        if (crop) { this.db.addEvidence(crop); this.db.addFindingEvidence(n.id, [crop.id]); }
      }
      if (plan) this.reportUnrun(url, plan, functional);
    }
    for (const g of this.guard.log.splice(0)) if (!g.decision.allowed) this.action('guard', 'blocked', `${g.action.kind} ${g.action.text ?? g.action.name ?? g.action.url ?? g.action.selector ?? ''}`.trim(), false, g.decision.reason, url, vp.name);
    this.db.addNetworkEvents(this.runId, url, vp.name, c.events.network.slice(n0));
    this.db.addConsoleEvents(this.runId, url, vp.name, c.events.console.slice(k0));
    this.save();
  }

  /**
   * One finished element test: stored at once (tested-element record, and a finding with its evidence when it failed or is
   * ambiguous), counted, and announced. A test cut short by a stop request is NOT a result and is dropped.
   */
  private recordResult(url: string, vp: Viewport, r: FunctionalResult, needCapture: { id: string; finding: Finding }[]): void {
    if (this.hooks.signal.aborted) return;
    const classification = classifyResult(r);
    if (!classification) return;
    const scenario = r.scenario ?? { id: r.kind, label: `${r.kind} test`, pageType: 'UNKNOWN_GENERAL' as const, reason: 'generic suite', confidence: 'MEDIUM' as const };
    const name = r.element?.name || r.element?.selector || null;
    this.db.addTestResults(this.runId, [{
      page: url, viewport: vp.name, scenario: scenario.id, scenarioLabel: scenario.label, pageType: scenario.pageType, reason: scenario.reason,
      confidence: r.confidence ?? scenario.confidence, kind: r.kind, check: r.check, target: name, expected: r.expected, actual: r.actual, classification,
    }]);
    if (r.kind === 'button' && r.status === 'pass' && r.element && r.element.name) this.verifiedControls.add(controlKey(r.element));

    const ruleId = `functional.${r.kind}`;
    const rule = this.registry.get(ruleId);
    if (producesFinding(r) && rule && !this.config.rules.disabled.includes(ruleId)) {
      const base = findingFromResult(rule, { page: url, viewport: vp }, r);
      const override = this.config.rules.severityOverrides[ruleId];
      const finding: Finding = override ? { ...base, severity: override } : base;
      const own = this.saveActionEvidence(r, url, vp.name);
      // the same user-facing problem already reported by a page check (an overlap that makes the control unclickable): one finding
      const known = r.check === 'clickable' ? sameRootCause(finding, this.db.listFindings(this.runId)) : undefined;
      if (known) this.db.addFindingEvidence(known.id, own.map((e) => e.id));
      else {
        const id = this.insertSimple({ ...finding, evidence: own.map((e) => e.id) });
        if (id && own.length === 0) needCapture.push({ id, finding });
      }
    }
    this.snap.currentAction = `${r.kind}: ${name ?? ''}`.slice(0, 120);
    this.snap.counts = runCounts(this.db, this.runId);
    this.hooks.emit('result', `${classification} ${name ?? r.kind}`, { page: url, viewport: vp.name, kind: r.kind, element: name, check: r.check, outcome: classification, actual: r.actual.slice(0, 200) });
    this.save();
  }

  /** Detection -> selection for one page. The decision is persisted and streamed so the report and dashboard can show it. */
  private planFor(url: string, viewport: string, model: PageModel): TestPlan {
    const profile = classifyPage(model);
    const plan = selectTests(profile, model, this.config, { verified: this.verifiedControls });
    const planned = plan.buttons.length + plan.forms.length + plan.searches.length + plan.modals.length + plan.fields.length;
    const decision = { types: profile.types, selected: plan.selected, skipped: plan.skipped, planned };
    this.db.setPageDecision(this.runId, url, decision);
    const detected = profile.types.filter((t) => t.confidence !== 'LOW').map((t) => t.type).join(' + ');
    this.hooks.emit('page', `detected ${detected} on ${url}`, { decision, viewport });
    this.hooks.emit('log', `${url}: detected ${detected}; selected ${[...new Set(plan.selected.map((x) => x.label))].join(', ')}; skipped ${[...new Set(plan.skipped.map((x) => `${x.label} (${x.reason})`))].join(', ') || 'nothing'}`);
    return plan;
  }

  /** A selected test that never ran because the action budget ran out must not look as if it ran: it is moved to `skipped` with that reason. */
  private reportUnrun(url: string, plan: TestPlan, results: FunctionalResult[]): void {
    if (!this.budget.exhausted) return;
    const ran = new Set(results.map((r) => r.scenario?.id));
    const interactive = new Set([plan.links, ...plan.buttons.map((b) => b.scenario), ...plan.forms.map((f) => f.scenario), ...plan.searches.map((x) => x.scenario), ...plan.modals.map((m) => m.scenario), ...plan.fields.map((f) => f.scenario)].filter((x) => !!x).map((x) => x!.id));
    const unrun = plan.selected.filter((x) => interactive.has(x.id) && !ran.has(x.id));
    if (unrun.length === 0) return;
    const reason = `not run: the action budget (maxActions=${this.budget.max}) was used up`;
    const profile = this.db.listPages(this.runId).find((p) => p.url === url)?.decision;
    this.db.setPageDecision(this.runId, url, {
      types: profile?.types ?? [], planned: profile?.planned, selected: plan.selected.filter((x) => !unrun.includes(x)),
      skipped: [...plan.skipped, ...[...new Map(unrun.map((x) => [x.id, x])).values()].map((x) => ({ id: x.id, label: x.label, reason }))],
    });
    this.hooks.emit('warning', `${url}: ${[...new Set(unrun.map((x) => x.label))].join(', ')} ${reason}. Raise maxActions to cover every page.`);
  }

  /** BEFORE -> ACTION -> AFTER for one functional result. */
  private saveActionEvidence(r: FunctionalResult, url: string, viewport: string): EvidenceRef[] {
    const { evidence } = this.deps;
    const meta = { page: url, viewport };
    const what = r.trace?.action ?? `${r.kind} ${r.check}`;
    const refs: EvidenceRef[] = [];
    // identical frames (e.g. a request failed with no visible change) are stored once and labelled as such
    const same = !!r.before && !!r.screenshot && r.before.equals(r.screenshot);
    if (same) refs.push(evidence.saveBinary(this.runId, 'screenshot', r.screenshot!, 'png', { ...meta, label: `Before and after (no visible change): ${what}` }));
    if (r.before && !same) refs.push(evidence.saveBinary(this.runId, 'screenshot', r.before, 'png', { ...meta, label: `Before: ${what}` }));
    if (r.screenshot && !same) refs.push(evidence.saveBinary(this.runId, 'screenshot', r.screenshot, 'png', { ...meta, label: `After / error state: ${what}` }));
    if (r.trace) refs.push(evidence.saveJson(this.runId, 'action-trace', { check: r.check, expected: r.expected, actual: r.actual, ...r.trace }, { ...meta, label: `Action trace: ${what}` }));
    for (const ref of refs) this.db.addEvidence(ref);
    return refs;
  }

  // ------------------------------------------------------------------ 4. exploratory agent
  private async explore(): Promise<void> {
    if (this.request.mode !== 'exploratory' || this.state.agentDone) return;
    this.check();
    const c = this.controller!;
    if (!this.deps.provider) { this.hooks.emit('warning', 'Exploratory mode requested but no AI provider is configured (QA_AI_PROVIDER / QA_AI_API_KEY). Skipping the agent.'); this.state.agentDone = true; return; }
    await c.setViewport(this.config.viewports[0]!);
    this.snap.currentAction = 'exploratory agent';
    const agent = new ReactAgent({
      controller: c, guard: this.guard, provider: this.deps.provider, config: this.config.agent, startUrl: this.request.url, signal: this.hooks.signal,
      onStep: (s) => this.action('agent', s.action?.tool ?? 'invalid', s.detail.slice(0, 100), s.outcome === 'executed' || s.outcome === 'inspected', `${s.outcome}: ${s.thought}`.slice(0, 300), s.url),
      onScreenshot: (png, url) => this.db.addEvidence(this.deps.evidence.saveBinary(this.runId, 'screenshot', png, 'png', { page: url, label: 'agent screenshot' })),
    });
    const result = await agent.run();
    this.hooks.emit('log', `Agent stopped: ${result.stopReason} after ${result.actionsTaken} actions, ${result.pagesVisited.length} pages`);
    this.action('agent', 'summary', result.stopReason, true, `${result.actionsTaken} actions, ${result.llmCalls} LLM calls, ${result.pagesVisited.length} pages`);

    const vp = c.currentViewport.name;
    const page = c.url;
    // Deterministic signals produced while exploring are evaluated by the normal network/console rules (defects with a basis).
    const ctx = await collectRuleContext(c, {
      config: this.config, network: c.events.network.slice(...result.networkRange), console: c.events.console.slice(...result.consoleRange),
    });
    const res = await this.registry.run(ctx, (r) => r.id.startsWith('network.failed') || r.id.startsWith('console.error'));
    let ev: PageEvidence | null = null;
    if (res.findings.length || result.reports.length) { ev = await capturePageEvidence(c, this.deps.evidence, this.runId, ctx); for (const r of ev.all) this.db.addEvidence(r); }
    for (const f of res.findings) this.insertSimple({ ...f, ruleId: `agent.${f.ruleId}`, evidence: ev ? evidenceFor(f, ev).map((r) => r.id) : [] });
    // Agent suspicions are ANOMALIES with no basis; they go to human review.
    for (const rep of result.reports) {
      this.insertSimple({
        ruleId: 'agent.observation', category: 'agent', severity: 'minor', classification: 'anomaly', basis: null, page: rep.url || page, viewport: vp,
        element: rep.selector ? { selector: rep.selector, name: rep.name } : null, expected: 'Exploratory agent saw no problem', actual: rep.description, evidence: ev ? [ev.screenshot, ev.dom].filter(Boolean).map((r) => r!.id) : [],
      });
    }
    this.state.agentDone = true; this.save();
  }

  // ------------------------------------------------------------------ 5. AI analysis (advisory)
  private async analyze(): Promise<void> {
    if (this.request.mode === 'deterministic' || this.state.aiDone) return;
    this.check();
    this.setStatus('ANALYZING');
    const provider = this.deps.provider;
    if (!provider) { this.hooks.emit('warning', 'AI analysis requested but no AI provider is configured; continuing with deterministic results only.'); this.state.aiDone = true; return; }
    const { evidence } = this.deps;
    const evidenceById = new Map(this.db.listEvidence(this.runId).map((e) => [e.id, e]));
    const findings = this.db.listFindings(this.runId).filter((f) => f.reviewState === 'pending' || f.reviewState === 'defect')
      .sort((a, b) => Number(b.classification === 'anomaly') - Number(a.classification === 'anomaly'));
    if (findings.length === 0) { this.state.aiDone = true; return; }
    this.snap.currentAction = `AI analysis of ${findings.length} findings`;

    const result = await analyzeFindings({
      provider, findings, maxCalls: this.config.ai.maxCalls, maxFindingsPerCall: this.config.ai.maxFindingsPerCall, signal: this.hooks.signal,
      digest: (f) => buildDigest(evidence, f.evidence.map((id) => evidenceById.get(id)).filter((e): e is NonNullable<typeof e> => !!e), f),
      screenshot: this.config.ai.sendScreenshots ? (f) => {
        const ref = f.evidence.map((id) => evidenceById.get(id)).find((e) => e?.kind === 'element-crop' || e?.kind === 'screenshot');
        return ref && ref.bytes < 1_500_000 ? evidence.read(ref).toString('base64') : undefined;
      } : undefined,
    });
    for (const a of result.accepted) this.db.addAnalysis(this.runId, { findingId: a.findingId, provider: provider.name, model: provider.model, accepted: true, analysis: a });
    for (const r of result.rejected) for (const id of r.findingIds) this.db.addAnalysis(this.runId, { findingId: id, provider: provider.name, model: provider.model, accepted: false, rejectReason: r.reason });
    if (result.injectionSuspected.length) this.hooks.emit('warning', `${result.injectionSuspected.length} finding(s) contained instruction-like page text; it was treated as data.`);
    this.hooks.emit('log', `AI analysis: ${result.accepted.length} accepted, ${result.rejected.length} batch(es) rejected, ${result.callsUsed} call(s)`);
    this.state.aiDone = true; this.save();
  }
}
