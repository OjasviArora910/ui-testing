import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { AIAnalysis } from '../ai/schema.js';
import type { EvidenceRef } from '../evidence/store.js';
import type { ConsoleEvent, NetworkEvent } from '../browser/types.js';
import { classifyFinding, problemKey, trackOf } from '../dynamic/resultClassifier.js';
import type { PageDecision } from '../dynamic/types.js';
import { fingerprint } from '../rules/helpers.js';
import type { Redactor } from '../shared/redactor.js';
import { FindingSchema, type Finding } from '../shared/types.js';
import { MIGRATIONS } from './schema.js';
import { reviewStateOf } from './review.js';
import type { ActionRecord, Decision, DecisionRecord, FindingView, PageRecord, RunRecord, RunState, RunStatus, RunSummary, StoredFinding, TestResultRecord, Verdict } from './types.js';

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();
const parse = <T>(s: unknown): T | null => (typeof s === 'string' && s ? JSON.parse(s) as T : null);

/**
 * SQLite persistence. EVERY string that enters the database passes through the central Redactor first, so raw JWTs,
 * Authorization/Cookie headers, API keys and secret query parameters cannot be stored. URLs additionally go through redactUrl.
 */
export class QADatabase {
  private constructor(private readonly db: Database.Database, private readonly redactor: Redactor) {}

  static open(file: string, redactor: Redactor): QADatabase {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const v = db.pragma('user_version', { simple: true }) as number;
    for (let i = v; i < MIGRATIONS.length; i++) {
      db.transaction(() => { db.exec(MIGRATIONS[i]!); db.pragma(`user_version = ${i + 1}`); })();
    }
    return new QADatabase(db, redactor);
  }
  close(): void { this.db.close(); }
  get raw(): Database.Database { return this.db; }

  private s(v: string | null | undefined): string | null { return v == null ? null : this.redactor.redact(v); }
  private u(v: string | null | undefined): string | null { return v == null ? null : this.redactor.redactUrl(v); }
  private j(v: unknown): string { return JSON.stringify(this.redactor.redactDeep(v)); }

  // ------------------------------------------------------------------ runs
  createRun(input: { id?: string; url: string; authProfile?: string | null; mode: string; request: unknown; config: unknown }): RunRecord {
    const id = input.id ?? `run_${crypto.randomBytes(6).toString('hex')}`;
    const t = now();
    this.db.prepare(`INSERT INTO runs (id, url, auth_profile, mode, status, request_json, config_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, this.u(input.url), input.authProfile ?? null, input.mode, 'CREATED', this.j(input.request), this.j(input.config), t, t);
    return this.getRun(id)!;
  }

  private mapRun(r: Row): RunRecord {
    return {
      id: r.id as string, url: r.url as string, authProfile: (r.auth_profile as string) ?? null, mode: r.mode as string, status: r.status as RunStatus,
      verdict: (r.verdict as Verdict) ?? null, request: parse(r.request_json), config: parse(r.config_json), state: parse<RunState>(r.state_json),
      summary: parse<RunSummary>(r.summary_json), rulesRun: parse<string[]>(r.rules_run_json) ?? [], error: (r.error as string) ?? null,
      abortReason: (r.abort_reason as string) ?? null, createdAt: r.created_at as string, startedAt: (r.started_at as string) ?? null,
      finishedAt: (r.finished_at as string) ?? null, updatedAt: r.updated_at as string,
    };
  }
  getRun(id: string): RunRecord | null {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return r ? this.mapRun(r) : null;
  }
  listRuns(limit = 50): RunRecord[] {
    return (this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?').all(limit) as Row[]).map((r) => this.mapRun(r));
  }
  /** Runs left in a non-terminal state (e.g. the process died). Candidates for resume. */
  listIncompleteRuns(): RunRecord[] {
    return (this.db.prepare(`SELECT * FROM runs WHERE status NOT IN ('COMPLETED','ABORTED','ERROR','REVIEW') ORDER BY created_at`).all() as Row[]).map((r) => this.mapRun(r));
  }
  setStatus(id: string, status: RunStatus, extra: { error?: string | null; abortReason?: string | null } = {}): void {
    const t = now();
    const terminal = status === 'COMPLETED' || status === 'ABORTED' || status === 'ERROR';
    this.db.prepare(`UPDATE runs SET status = ?, error = COALESCE(?, error), abort_reason = COALESCE(?, abort_reason), updated_at = ?,
      started_at = COALESCE(started_at, CASE WHEN ? <> 'CREATED' THEN ? END), finished_at = CASE WHEN ? THEN ? ELSE finished_at END WHERE id = ?`)
      .run(status, this.s(extra.error), this.s(extra.abortReason), t, status, t, terminal ? 1 : 0, t, id);
  }
  saveState(id: string, state: RunState): void { this.db.prepare('UPDATE runs SET state_json = ?, updated_at = ? WHERE id = ?').run(this.j(state), now(), id); }
  saveSummary(id: string, summary: RunSummary, verdict: Verdict): void {
    this.db.prepare('UPDATE runs SET summary_json = ?, verdict = ?, updated_at = ? WHERE id = ?').run(this.j(summary), verdict, now(), id);
  }
  saveRulesRun(id: string, rules: string[]): void { this.db.prepare('UPDATE runs SET rules_run_json = ? WHERE id = ?').run(JSON.stringify(rules), id); }

  // ------------------------------------------------------------------ pages
  upsertPage(runId: string, p: { url: string; depth: number; statusCode?: number | null; title?: string | null; error?: string | null; model?: unknown; testStatus?: PageRecord['testStatus'] }): void {
    this.db.prepare(`INSERT INTO pages (run_id, url, depth, status_code, title, error, model_json, test_status, discovered_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(run_id, url) DO UPDATE SET depth = excluded.depth, status_code = excluded.status_code, title = excluded.title, error = excluded.error,
      model_json = COALESCE(excluded.model_json, model_json), test_status = excluded.test_status`)
      .run(runId, this.u(p.url), p.depth, p.statusCode ?? null, this.s(p.title), this.s(p.error), p.model ? this.j(p.model) : null, p.testStatus ?? 'pending', now());
  }
  setPageTested(runId: string, url: string, status: PageRecord['testStatus'] = 'tested'): void {
    this.db.prepare('UPDATE pages SET test_status = ? WHERE run_id = ? AND url = ?').run(status, runId, this.u(url));
  }
  listPages(runId: string): PageRecord[] {
    return (this.db.prepare('SELECT * FROM pages WHERE run_id = ? ORDER BY id').all(runId) as Row[]).map((r) => ({
      id: r.id as number, runId: r.run_id as string, url: r.url as string, depth: r.depth as number, statusCode: (r.status_code as number) ?? null,
      title: (r.title as string) ?? null, error: (r.error as string) ?? null, testStatus: r.test_status as PageRecord['testStatus'], model: parse(r.model_json), discoveredAt: r.discovered_at as string,
      decision: parse<PageDecision>(r.decision_json),
    }));
  }
  setPageDecision(runId: string, url: string, decision: PageDecision): void {
    this.db.prepare('UPDATE pages SET decision_json = ? WHERE run_id = ? AND url = ?').run(this.j(decision), runId, this.u(url));
  }

  // ------------------------------------------------------------------ dynamic test results
  addTestResults(runId: string, rows: Omit<TestResultRecord, 'id' | 'runId' | 'createdAt'>[]): void {
    const st = this.db.prepare(`INSERT INTO test_results (run_id, page, viewport, scenario, scenario_label, page_type, reason, confidence, kind, check_name, target, expected, actual, classification, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    this.db.transaction(() => {
      for (const r of rows) st.run(runId, this.u(r.page), r.viewport, r.scenario, r.scenarioLabel, r.pageType, this.s(r.reason), r.confidence, r.kind, r.check, this.s(r.target), this.s(r.expected), this.s(r.actual), r.classification, now());
    })();
  }
  listTestResults(runId: string): TestResultRecord[] {
    return (this.db.prepare('SELECT * FROM test_results WHERE run_id = ? ORDER BY id').all(runId) as Row[]).map((r) => ({
      id: r.id as number, runId: r.run_id as string, page: r.page as string, viewport: r.viewport as string, scenario: r.scenario as string, scenarioLabel: r.scenario_label as string,
      pageType: r.page_type as string, reason: r.reason as string, confidence: r.confidence as TestResultRecord['confidence'], kind: r.kind as string, check: r.check_name as string,
      target: (r.target as string) ?? null, expected: r.expected as string, actual: r.actual as string, classification: r.classification as TestResultRecord['classification'], createdAt: r.created_at as string,
    }));
  }

  // ------------------------------------------------------------------ actions
  addAction(runId: string, a: { pageUrl?: string; viewport?: string; source: string; type: string; target?: string; ok: boolean; detail?: string }): void {
    this.db.prepare('INSERT INTO actions (run_id, page_url, viewport, source, type, target, ok, detail, at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(runId, this.u(a.pageUrl), a.viewport ?? null, a.source, a.type, this.s(a.target), a.ok ? 1 : 0, this.s(a.detail), now());
  }
  listActions(runId: string): ActionRecord[] {
    return (this.db.prepare('SELECT * FROM actions WHERE run_id = ? ORDER BY id').all(runId) as Row[]).map((r) => ({
      id: r.id as number, runId: r.run_id as string, pageUrl: (r.page_url as string) ?? null, viewport: (r.viewport as string) ?? null, source: r.source as string,
      type: r.type as string, target: (r.target as string) ?? null, ok: r.ok === 1, detail: (r.detail as string) ?? null, at: r.at as string,
    }));
  }
  countActions(runId: string): number { return (this.db.prepare('SELECT COUNT(*) c FROM actions WHERE run_id = ?').get(runId) as { c: number }).c; }

  // ------------------------------------------------------------------ findings
  /**
   * Inserts a finding after re-validating it (a defect without basis is rejected here too, and by a CHECK constraint).
   * Returns the existing id when the same fingerprint already exists in the run (dedupe).
   */
  insertFinding(runId: string, finding: Finding): { id: string; inserted: boolean } {
    const f = FindingSchema.parse(finding);
    const fp = fingerprint(f);
    const existing = this.db.prepare('SELECT id FROM findings WHERE run_id = ? AND fingerprint = ?').get(runId, fp) as { id: string } | undefined;
    if (existing) return { id: existing.id, inserted: false };
    const id = `fnd_${crypto.randomBytes(6).toString('hex')}`;
    this.db.prepare(`INSERT INTO findings (id, run_id, fingerprint, rule_id, category, severity, classification, basis, page, viewport, element_json, expected, actual, evidence_json, context_json, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, runId, fp, f.ruleId, f.category, f.severity, f.classification, f.basis, this.u(f.page), f.viewport, f.element ? this.j(f.element) : null, this.s(f.expected), this.s(f.actual), JSON.stringify(f.evidence), f.context ? this.j(f.context) : null, now());
    return { id, inserted: true };
  }
  addFindingEvidence(findingId: string, ids: string[]): void {
    const row = this.db.prepare('SELECT evidence_json FROM findings WHERE id = ?').get(findingId) as { evidence_json: string } | undefined;
    if (!row) return;
    const merged = [...new Set([...(JSON.parse(row.evidence_json) as string[]), ...ids])];
    this.db.prepare('UPDATE findings SET evidence_json = ? WHERE id = ?').run(JSON.stringify(merged), findingId);
  }

  private mapFinding(r: Row): StoredFinding {
    return {
      id: r.id as string, runId: r.run_id as string, fingerprint: r.fingerprint as string, ruleId: r.rule_id as string, category: r.category as string,
      severity: r.severity as Finding['severity'], classification: r.classification as Finding['classification'], basis: (r.basis as Finding['basis']) ?? null,
      page: r.page as string, viewport: r.viewport as string, element: parse(r.element_json), expected: r.expected as string, actual: r.actual as string,
      evidence: parse<string[]>(r.evidence_json) ?? [], createdAt: r.created_at as string,
      ...(r.context_json ? { context: parse<NonNullable<Finding['context']>>(r.context_json)! } : {}),
    };
  }
  getFinding(id: string): StoredFinding | null {
    const r = this.db.prepare('SELECT * FROM findings WHERE id = ?').get(id) as Row | undefined;
    return r ? this.mapFinding(r) : null;
  }
  /** Findings with their derived review state (latest human decision wins). */
  listFindings(runId: string): FindingView[] {
    const rows = this.db.prepare('SELECT * FROM findings WHERE run_id = ? ORDER BY created_at, id').all(runId) as Row[];
    const decisions = new Map<string, DecisionRecord>();
    for (const d of this.listDecisions(runId)) decisions.set(d.findingId, d); // ascending => last wins
    return rows.map((r) => {
      const f = this.mapFinding(r);
      const decision = decisions.get(f.id) ?? null;
      const reviewState = reviewStateOf(f.classification, decision);
      return { ...f, decision, reviewState, resultClass: classifyFinding({ ...f, reviewState }), track: trackOf(f), problemKey: problemKey(f) };
    });
  }
  getFindingView(id: string): FindingView | null {
    const f = this.getFinding(id);
    return f ? this.listFindings(f.runId).find((x) => x.id === id) ?? null : null;
  }

  // ------------------------------------------------------------------ evidence
  addEvidence(ref: EvidenceRef): void {
    this.db.prepare('INSERT OR IGNORE INTO evidence (id, run_id, kind, path, sha256, bytes, mime, label, page, viewport, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(ref.id, ref.runId, ref.kind, ref.path, ref.sha256, ref.bytes, ref.mime, this.s(ref.label), this.u(ref.page), ref.viewport ?? null, ref.createdAt);
  }
  listEvidence(runId: string): EvidenceRef[] {
    return (this.db.prepare('SELECT * FROM evidence WHERE run_id = ? ORDER BY created_at').all(runId) as Row[]).map((r) => this.mapEvidence(r));
  }
  getEvidence(id: string, runId?: string): EvidenceRef | null {
    const r = (runId ? this.db.prepare('SELECT * FROM evidence WHERE id = ? AND run_id = ?').get(id, runId) : this.db.prepare('SELECT * FROM evidence WHERE id = ?').get(id)) as Row | undefined;
    return r ? this.mapEvidence(r) : null;
  }
  private mapEvidence(r: Row): EvidenceRef {
    return { id: r.id as string, runId: r.run_id as string, kind: r.kind as EvidenceRef['kind'], path: r.path as string, sha256: r.sha256 as string, bytes: r.bytes as number, mime: r.mime as string, label: (r.label as string) ?? '', page: (r.page as string) ?? undefined, viewport: (r.viewport as string) ?? undefined, createdAt: r.created_at as string };
  }

  // ------------------------------------------------------------------ events
  addNetworkEvents(runId: string, page: string, viewport: string, events: NetworkEvent[]): void {
    const st = this.db.prepare('INSERT INTO network_events (run_id, page, viewport, method, url, resource_type, status, ok, failure, duration_ms, ignored, at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    this.db.transaction(() => { for (const e of events) st.run(runId, this.u(page), viewport, e.method, this.u(e.url), e.resourceType, e.status, e.ok ? 1 : 0, this.s(e.failure), e.durationMs, e.ignored ? 1 : 0, e.startedAt); })();
  }
  addConsoleEvents(runId: string, page: string, viewport: string, events: ConsoleEvent[]): void {
    const st = this.db.prepare('INSERT INTO console_events (run_id, page, viewport, kind, level, text, location, at) VALUES (?,?,?,?,?,?,?,?)');
    this.db.transaction(() => { for (const e of events) st.run(runId, this.u(page), viewport, e.kind, e.level, this.s(e.text), this.u(e.location), e.at); })();
  }
  countEvents(runId: string): { network: number; console: number } {
    return {
      network: (this.db.prepare('SELECT COUNT(*) c FROM network_events WHERE run_id = ?').get(runId) as { c: number }).c,
      console: (this.db.prepare('SELECT COUNT(*) c FROM console_events WHERE run_id = ?').get(runId) as { c: number }).c,
    };
  }

  // ------------------------------------------------------------------ AI analyses (advisory only)
  addAnalysis(runId: string, a: { findingId: string | null; provider: string; model: string; accepted: boolean; analysis?: AIAnalysis; rejectReason?: string }): void {
    this.db.prepare('INSERT INTO ai_analyses (run_id, finding_id, provider, model, status, analysis_json, reject_reason, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(runId, a.findingId, a.provider, a.model, a.accepted ? 'accepted' : 'rejected', a.analysis ? this.j(a.analysis) : null, this.s(a.rejectReason?.slice(0, 500)), now());
  }
  /** Latest accepted analysis per finding. */
  analysesByFinding(runId: string): Map<string, AIAnalysis> {
    const rows = this.db.prepare(`SELECT finding_id, analysis_json FROM ai_analyses WHERE run_id = ? AND status = 'accepted' AND finding_id IS NOT NULL ORDER BY id`).all(runId) as { finding_id: string; analysis_json: string }[];
    return new Map(rows.map((r) => [r.finding_id, JSON.parse(r.analysis_json) as AIAnalysis]));
  }
  /** Latest rejection reason per finding (for quota, rate limits, or validation errors). */
  aiErrorsByFinding(runId: string): Map<string, string> {
    const rows = this.db.prepare(`SELECT finding_id, reject_reason FROM ai_analyses WHERE run_id = ? AND status = 'rejected' AND finding_id IS NOT NULL ORDER BY id`).all(runId) as { finding_id: string; reject_reason: string | null }[];
    return new Map(rows.map((r) => [r.finding_id, r.reject_reason || 'AI analysis unavailable']));
  }
  listAnalyses(runId: string): { findingId: string | null; provider: string; model: string; status: string; rejectReason: string | null; analysis: AIAnalysis | null }[] {
    return (this.db.prepare('SELECT * FROM ai_analyses WHERE run_id = ? ORDER BY id').all(runId) as Row[]).map((r) => ({
      findingId: (r.finding_id as string) ?? null, provider: r.provider as string, model: r.model as string, status: r.status as string, rejectReason: (r.reject_reason as string) ?? null, analysis: parse<AIAnalysis>(r.analysis_json),
    }));
  }

  // ------------------------------------------------------------------ human decisions
  /** The ONLY write path to a "confirmed" outcome. Append-only history; the latest row wins. */
  addDecision(d: { findingId: string; decision: Decision; note?: string; decidedBy: string }): DecisionRecord {
    const f = this.getFinding(d.findingId);
    if (!f) throw new Error(`Unknown finding ${d.findingId}`);
    const at = now();
    const info = this.db.prepare('INSERT INTO human_decisions (finding_id, run_id, decision, note, decided_by, decided_at) VALUES (?,?,?,?,?,?)')
      .run(d.findingId, f.runId, d.decision, this.s(d.note?.slice(0, 2000)), this.s(d.decidedBy) ?? 'human', at);
    return { id: Number(info.lastInsertRowid), findingId: d.findingId, runId: f.runId, decision: d.decision, note: d.note ?? null, decidedBy: d.decidedBy, decidedAt: at };
  }
  listDecisions(runId: string): DecisionRecord[] {
    return (this.db.prepare('SELECT * FROM human_decisions WHERE run_id = ? ORDER BY id').all(runId) as Row[]).map((r) => ({
      id: r.id as number, findingId: r.finding_id as string, runId: r.run_id as string, decision: r.decision as Decision, note: (r.note as string) ?? null, decidedBy: r.decided_by as string, decidedAt: r.decided_at as string,
    }));
  }

  // ------------------------------------------------------------------ baselines
  addBaseline(b: { url: string; viewport: string; file: string; sha256: string; maskSelectors?: string[]; runId?: string; approvedBy: string }): void {
    this.db.prepare('INSERT INTO baselines (url, viewport, file, sha256, mask_json, run_id, approved_by, approved_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(this.u(b.url), b.viewport, b.file, b.sha256, JSON.stringify(b.maskSelectors ?? []), b.runId ?? null, this.s(b.approvedBy), now());
  }
  listBaselines(): { url: string; viewport: string; file: string; sha256: string; approvedBy: string; approvedAt: string }[] {
    return (this.db.prepare('SELECT * FROM baselines ORDER BY id DESC').all() as Row[]).map((r) => ({ url: r.url as string, viewport: r.viewport as string, file: r.file as string, sha256: r.sha256 as string, approvedBy: r.approved_by as string, approvedAt: r.approved_at as string }));
  }
}
