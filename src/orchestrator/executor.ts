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
import { captureElementCrop, capturePageEvidence, evidenceFor, type EvidenceStore, type PageEvidence } from '../evidence/index.js';
import { ActionBudget, ActionGuard, runFunctionalTests, type FunctionalResult } from '../functional/index.js';
import { generateReports } from '../reporting/index.js';
import { collectRuleContext } from '../rules/context.js';
import { buildRegistry, type RuleRegistry } from '../rules/index.js';
import type { AuthProfileResolver } from '../shared/authProfiles.js';
import type { QAConfig } from '../shared/config.js';
import type { Redactor } from '../shared/redactor.js';
import type { RunRequest } from '../shared/runRequest.js';
import type { AuthConfig, Finding, Viewport } from '../shared/types.js';
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
  snapshot: ProgressSnapshot;
}

class StopRun extends Error { constructor(readonly reason: string) { super(reason); } }

const errMsg = (e: unknown): string => (e instanceof Error ? e.message.split('\n')[0]! : String(e));

/**
 * Executes one run through the lifecycle
 * CREATED -> AUTHENTICATING -> DISCOVERING -> TESTING -> ANALYZING -> REVIEW -> REPORTING -> COMPLETED
 * and persists a resumable cursor (RunState) after each unit of work.
 */
export class RunExecutor {
  private readonly db: QADatabase;
  private run!: RunRecord;
  private config!: QAConfig;
  private request!: RunRequest;
  private state!: RunState;
  private controller?: BrowserController;
  private guard!: ActionGuard;
  private registry!: RuleRegistry;
  private budget!: ActionBudget;
  private testedLinks = new Set<string>();

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
  }
  private action(source: string, type: string, target: string, ok: boolean, detail?: string, page?: string, viewport?: string): void {
    this.db.addAction(this.runId, { pageUrl: page, viewport, source, type, target, ok, detail });
    this.snap.currentAction = `${type} ${target}`.slice(0, 120);
    this.hooks.emit('action', `${type} ${target}`, { ok, source });
  }

  // ------------------------------------------------------------------ main
  async execute(): Promise<void> {
    const run = this.db.getRun(this.runId);
    if (!run) throw new Error(`Unknown run ${this.runId}`);
    this.run = run;
    this.config = run.config as QAConfig;
    this.request = run.request as RunRequest;
    this.state = run.state ?? { phase: 'CREATED', testedUnits: [], actionsUsed: 0, testedLinks: [] };
    this.testedLinks = new Set(this.state.testedLinks);
    this.budget = new ActionBudget(this.config.maxActions);
    this.budget.used = this.state.actionsUsed;
    this.snap.actionsUsed = this.budget.used;
    this.registry = await buildRegistry(this.config);

    let outcome: 'completed' | 'aborted' | 'error' = 'completed';
    let reason = '';
    try {
      await this.authenticate();
      await this.discover();
      await this.test();
      await this.explore();
      await this.analyze();
      this.setStatus('REVIEW');
    } catch (e) {
      if (e instanceof StopRun) { outcome = 'aborted'; reason = e.reason; } else { outcome = 'error'; reason = errMsg(e); }
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
    if (this.request.authProfile) {
      auth = this.deps.profiles.resolve(this.request.authProfile); // throws (without the secret) when unavailable
      this.deps.redactor.register(auth.jwt);
    }
    const first = this.config.viewports[0]!;
    this.controller = await BrowserController.launch({
      baseUrl: this.request.url, viewport: first, auth, redactor: this.deps.redactor, ignoredEndpoints: this.config.ignoredEndpoints,
      actionTimeoutMs: this.config.timeouts.actionMs, navigationTimeoutMs: this.config.timeouts.navigationMs,
      blockExternal: true, trace: this.deps.trace !== false, ...this.deps.launch,
    });
    this.guard = new ActionGuard({ keywords: this.config.dangerousActions.keywords, allowMethods: this.config.dangerousActions.allowMethods, origin: this.request.url });
    this.controller.setRequestGuard(this.guard.asRequestGuard());

    const nav = await this.controller.navigate(this.request.url);
    if (!nav.ok) throw new Error(`Target unreachable: ${nav.error}`);
    if (auth && (nav.status === 401 || nav.status === 403)) {
      this.insertSimple({ ruleId: 'auth.rejected', category: 'auth', severity: 'major', classification: 'anomaly', basis: null, page: this.request.url, viewport: first.name, element: null,
        expected: 'The configured credentials are accepted by the target', actual: `Target returned HTTP ${nav.status} for the first request using auth profile "${this.request.authProfile}"`, evidence: [] });
      this.hooks.emit('warning', `Auth profile "${this.request.authProfile}" was rejected (HTTP ${nav.status})`);
    }
    this.action('auth', 'navigate', this.request.url, true, `HTTP ${nav.status ?? '?'}`);
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
        onPage: (p, st) => {
          this.db.upsertPage(this.runId, { url: p.url, depth: p.depth, statusCode: p.status ?? null, title: p.model?.title ?? null, error: p.error ?? null, model: p.model ?? undefined, testStatus: p.model ? 'pending' : 'skipped' });
          this.state.crawl = st; this.save();
          this.snap.currentPage = p.url; this.snap.pagesDiscovered = st.visited.length;
          this.hooks.emit('page', `discovered ${p.url}`, { status: p.status, depth: p.depth });
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
          this.hooks.emit('warning', `Unit ${unit} failed: ${errMsg(e)}`);
          this.action('orchestrator', 'unit-error', unit, false, errMsg(e), page.url, vp.name);
        }
        this.state.testedUnits.push(unit); this.snap.unitsDone++; this.save();
      }
      this.db.setPageTested(this.runId, page.url, 'tested');
    }
  }

  private async testUnit(c: BrowserController, url: string, vp: Viewport, isFirst: boolean, visual: VisualTester): Promise<void> {
    const cfg = this.config;
    await c.setViewport(vp);
    const n0 = c.events.network.length; const k0 = c.events.console.length;
    const nav = await c.navigate(url);
    this.action('orchestrator', 'navigate', url, nav.ok, nav.error, url, vp.name);
    if (!nav.ok) return;
    // Let page-load requests finish (bounded) so slow and failing APIs are observed with their real duration/status.
    await c.waitForIdle(cfg.network.slowRequestMs + 1000);
    const network = c.events.network.slice(n0); const consoleEv = c.events.console.slice(k0);
    const model = await buildPageModel(c, { status: nav.status });

    // visual first (before focus changes from the keyboard check could alter the pixels)
    const vis = await visual.check(c, { artifactDir: path.join(this.deps.reportsDir, this.runId, 'visual'), label: `${vp.name}-${path.basename(new URL(url).pathname) || 'root'}` });
    this.action('visual', vis.result.status, url, vis.result.status !== 'SKIPPED', vis.result.reason, url, vp.name);

    let axe: Awaited<ReturnType<typeof runAxe>> = []; let keyboard = null;
    if (cfg.accessibility.enabled && (isFirst || cfg.accessibility.allViewports)) {
      try { axe = await runAxe(c); } catch (e) { this.hooks.emit('warning', `axe failed on ${url}: ${errMsg(e)}`); }
      if (cfg.accessibility.keyboard) { try { keyboard = await runKeyboardCheck(c, model); } catch (e) { this.hooks.emit('warning', `keyboard check failed: ${errMsg(e)}`); } }
    }

    let functional: FunctionalResult[] = [];
    if (isFirst || cfg.functional.allViewports) {
      this.snap.currentAction = 'functional tests';
      functional = await runFunctionalTests({
        controller: c, guard: this.guard, pageUrl: url, model, config: cfg, budget: this.budget, testedLinks: this.testedLinks,
        onAction: (a) => { this.action('functional', a.type, a.target, a.ok, a.detail, url, vp.name); this.save(); },
      });
      await c.settle(150);
    }
    for (const g of this.guard.log.splice(0)) if (!g.decision.allowed) this.action('guard', 'blocked', `${g.action.kind} ${g.action.text ?? g.action.name ?? g.action.url ?? g.action.selector ?? ''}`.trim(), false, g.decision.reason, url, vp.name);

    const ctx = await collectRuleContext(c, { config: cfg, model, network, console: consoleEv, functional, axe, keyboard, visual: vis.result });
    const res = await this.registry.run(ctx);
    for (const e of res.errors) this.hooks.emit('warning', `rule ${e.ruleId}: ${e.message}`);

    this.db.addNetworkEvents(this.runId, url, vp.name, c.events.network.slice(n0));
    this.db.addConsoleEvents(this.runId, url, vp.name, c.events.console.slice(k0));

    let pageEv: PageEvidence | null = null;
    if (res.findings.length > 0) {
      pageEv = await capturePageEvidence(c, this.deps.evidence, this.runId, ctx, vis);
      for (const r of pageEv.all) this.db.addEvidence(r);
    } else if (vis.result.status === 'NO_BASELINE_AVAILABLE' && vis.currentPng.length > 0) {
      this.db.addEvidence(this.deps.evidence.saveBinary(this.runId, 'visual-current', vis.currentPng, 'png', { page: url, viewport: vp.name, label: 'current screenshot (no baseline yet)' }));
    }
    let crops = 0;
    for (const f of res.findings) {
      let crop;
      if (pageEv && crops < 12 && f.element) {
        crop = await captureElementCrop(c, this.deps.evidence, this.runId, f);
        if (crop) { this.db.addEvidence(crop); crops++; }
      }
      const withEvidence: Finding = { ...f, evidence: pageEv ? evidenceFor(f, pageEv, crop).map((r) => r.id) : [] };
      this.insertSimple(withEvidence);
    }
    this.save();
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
