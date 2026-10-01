import type { AIAnalysis } from '../ai/schema.js';
import type { QADatabase } from '../database/db.js';
import { computeVerdict } from '../database/review.js';
import type { FindingView, RunSummary, Verdict } from '../database/types.js';
import type { EvidenceRef } from '../evidence/store.js';

export interface ReportFinding extends FindingView {
  ai: AIAnalysis | null;
  evidenceRefs: EvidenceRef[];
}

export interface ReportData {
  generatedAt: string;
  run: { id: string; url: string; mode: string; status: string; verdict: Verdict; createdAt: string; startedAt: string | null; finishedAt: string | null; authProfile: string | null; abortReason: string | null; error: string | null };
  incomplete: boolean;
  summary: RunSummary;
  limits: { viewports: string[]; maxPages: number; maxActions: number; maxDepth: number };
  pages: { url: string; statusCode: number | null; title: string | null; testStatus: string; error: string | null }[];
  findings: ReportFinding[];
  rulesRun: string[];
  guard: { blockedActions: number };
  disclaimers: string[];
}

export const DISCLAIMERS = [
  'Automated accessibility checks (axe-core and keyboard heuristics) detect only a subset of accessibility problems. This report is not a WCAG conformance certification.',
  'Visual regression is only evaluated where an approved baseline exists. Pages reported as NO_BASELINE_AVAILABLE were not compared and are not considered passed or failed visually.',
  'A finding is a "defect" only when backed by a ground-truth basis (deterministic measurement, generic rule, configured rule, baseline, or human decision). Everything else is an "anomaly" awaiting human review.',
  'AI explanations are advisory. They cannot confirm, reject or re-classify findings; only human decisions can.',
  'Screenshots may contain sensitive on-screen data; text evidence (DOM, network, console) is redacted of known secrets before storage.',
];

/** Computes the run summary + verdict from persisted findings (single source of truth for UI, reports and CI). */
export function summarizeRun(db: QADatabase, runId: string, opts: { incomplete?: boolean } = {}): { summary: RunSummary; verdict: Verdict } {
  const findings = db.listFindings(runId);
  const active = findings.filter((f) => f.reviewState !== 'dismissed');
  const byCategory: Record<string, number> = {}; const bySeverity: Record<string, number> = {};
  for (const f of active) { byCategory[f.category] = (byCategory[f.category] ?? 0) + 1; bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1; }
  const actions = db.listActions(runId);
  const visual = { pass: 0, fail: 0, noBaseline: 0 };
  for (const a of actions) if (a.source === 'visual') { if (a.type === 'PASS') visual.pass++; else if (a.type === 'FAIL') visual.fail++; else if (a.type === 'NO_BASELINE_AVAILABLE') visual.noBaseline++; }
  const summary: RunSummary = {
    pages: db.listPages(runId).filter((p) => p.testStatus === 'tested').length,
    findings: active.length,
    defects: active.filter((f) => f.reviewState === 'defect' || f.reviewState === 'confirmed').length,
    anomalies: active.filter((f) => f.reviewState === 'pending' || f.reviewState === 'investigating').length,
    byCategory, bySeverity,
    pendingReview: active.filter((f) => f.reviewState === 'pending' || f.reviewState === 'investigating').length,
    actions: actions.filter((a) => a.source !== 'visual' && a.source !== 'guard').length,
    guardBlocked: actions.filter((a) => a.source === 'guard').length,
    visual, incomplete: opts.incomplete,
  };
  return { summary, verdict: computeVerdict(findings) };
}

export function buildReportData(db: QADatabase, runId: string): ReportData {
  const run = db.getRun(runId);
  if (!run) throw new Error(`Unknown run ${runId}`);
  const incomplete = run.status === 'ABORTED' || run.status === 'ERROR' || !!run.summary?.incomplete;
  const { summary, verdict } = summarizeRun(db, runId, { incomplete });
  const evidence = new Map(db.listEvidence(runId).map((e) => [e.id, e]));
  const analyses = db.analysesByFinding(runId);
  const cfg = run.config as { viewports?: { name: string }[]; maxPages?: number; maxActions?: number; maxDepth?: number };
  const findings: ReportFinding[] = db.listFindings(runId).map((f) => ({
    ...f, ai: analyses.get(f.id) ?? null, evidenceRefs: f.evidence.map((id) => evidence.get(id)).filter((e): e is EvidenceRef => !!e),
  }));
  return {
    generatedAt: new Date().toISOString(),
    run: { id: run.id, url: run.url, mode: run.mode, status: run.status, verdict, createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt, authProfile: run.authProfile, abortReason: run.abortReason, error: run.error },
    incomplete, summary,
    limits: { viewports: (cfg.viewports ?? []).map((v) => v.name), maxPages: cfg.maxPages ?? 0, maxActions: cfg.maxActions ?? 0, maxDepth: cfg.maxDepth ?? 0 },
    pages: db.listPages(runId).map((p) => ({ url: p.url, statusCode: p.statusCode, title: p.title, testStatus: p.testStatus, error: p.error })),
    findings, rulesRun: run.rulesRun, guard: { blockedActions: summary.guardBlocked }, disclaimers: DISCLAIMERS,
  };
}
