import type { AIAnalysis } from '../ai/schema.js';
import type { QADatabase } from '../database/db.js';
import { computeVerdict } from '../database/review.js';
import type { FindingView, RunCounts, RunSummary, TestResultRecord, Verdict } from '../database/types.js';
import { countFindings } from '../dynamic/resultClassifier.js';
import type { PageReadiness } from '../browser/readiness.js';
import type { PageDecision } from '../dynamic/types.js';
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
  pages: { url: string; statusCode: number | null; title: string | null; testStatus: string; error: string | null; decision: PageDecision | null; readiness: PageReadiness | null }[];
  /** Every dynamically selected test that ran, including EXPECTED and BLOCKED_BY_SAFETY outcomes. */
  testResults: TestResultRecord[];
  accessibility: { enabled: boolean; failRun: boolean };
  findings: ReportFinding[];
  rulesRun: string[];
  guard: { blockedActions: number };
  disclaimers: string[];
}

export const DISCLAIMERS = [
  'Accessibility (axe-core, keyboard, target size) is outside the scope of UI/UX QA and is not run unless explicitly enabled. When enabled it is reported as its own category and is not a WCAG conformance certification.',
  'Interactions that work are not listed as findings. The "Dynamic test selection" section shows everything that was tested and how it ended.',
  'Visual regression is only evaluated where an approved baseline exists. Pages reported as NO_BASELINE_AVAILABLE were not compared and are not considered passed or failed visually.',
  'Accessibility findings are reported in their own category. Unless accessibility is set as a required category for the run, they do not affect the verdict.',
  'Tests are selected per page from what was detected on it. A test listed as BLOCKED_BY_SAFETY performed the UI interaction, but the safety policy stopped its request, so the workflow is unverified.',
  'A finding is a "defect" only when backed by a ground-truth basis (deterministic measurement, generic rule, configured rule, baseline, or human decision). Everything else is an "anomaly" awaiting human review.',
  'AI explanations are advisory. They cannot confirm, reject or re-classify findings; only human decisions can.',
  'Screenshots may contain sensitive on-screen data; text evidence (DOM, network, console) is redacted of known secrets before storage.',
];

/** Pages, elements tested/passed, problems found and work left undone, from what is stored right now. */
export function runCounts(db: QADatabase, runId: string): RunCounts {
  const pages = db.listPages(runId);
  const results = db.listTestResults(runId);
  const uiux = db.listFindings(runId).filter((f) => f.reviewState !== 'dismissed' && f.track === 'uiux');
  // the stored label already went through the finding gate (with what is known about the page): count from it
  const distinct = (cls: string): number => new Set(uiux.filter((f) => f.resultClass === cls).map((f) => f.problemKey)).size;
  const problems = { bugs: distinct('BUG'), warnings: 0, needsReview: distinct('INCONCLUSIVE') };
  const testable = pages.filter((p) => p.model && (p.statusCode ?? 200) < 400);
  let notTestedElements = 0;
  for (const p of testable) {
    // only a page that was started and not finished has elements left over; a finished page has none
    if (p.testStatus === 'tested' || p.decision?.planned === undefined) continue;
    const done = results.filter((r) => r.page === p.url && r.scenario !== 'links').length;
    notTestedElements += Math.max(0, p.decision.planned - done);
  }
  return {
    pagesCrawled: pages.length, pagesTested: pages.filter((p) => p.testStatus === 'tested').length,
    elementsTested: results.length, passed: results.filter((r) => r.classification === 'EXPECTED').length, blocked: results.filter((r) => r.classification === 'BLOCKED_BY_SAFETY').length,
    inconclusive: results.filter((r) => r.classification === 'INCONCLUSIVE').length,
    bugs: problems.bugs, warnings: problems.warnings, needsReview: problems.needsReview,
    notTestedPages: testable.filter((p) => p.testStatus !== 'tested').length, notTestedElements,
  };
}

/** Computes the run summary + verdict from persisted findings (single source of truth for UI, reports and CI). */
export function summarizeRun(db: QADatabase, runId: string, opts: { incomplete?: boolean } = {}): { summary: RunSummary; verdict: Verdict } {
  const findings = db.listFindings(runId);
  const active = findings.filter((f) => f.reviewState !== 'dismissed');
  const byCategory: Record<string, number> = {}; const bySeverity: Record<string, number> = {};
  // Accessibility is its own track: it has its own category and count and is not mixed into UI/UX defects or severities.
  const uiux = active.filter((f) => f.track === 'uiux');
  for (const f of active) byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
  for (const f of uiux) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  const actions = db.listActions(runId);
  const visual = { pass: 0, fail: 0, noBaseline: 0 };
  for (const a of actions) if (a.source === 'visual') { if (a.type === 'PASS') visual.pass++; else if (a.type === 'FAIL') visual.fail++; else if (a.type === 'NO_BASELINE_AVAILABLE') visual.noBaseline++; }
  const summary: RunSummary = {
    pages: db.listPages(runId).filter((p) => p.testStatus === 'tested').length,
    findings: active.length,
    defects: uiux.filter((f) => f.resultClass === 'BUG').length,
    anomalies: uiux.filter((f) => f.resultClass === 'INCONCLUSIVE').length,
    counts: { ...countFindings(active), bugs: new Set(uiux.filter((f) => f.resultClass === 'BUG').map((f) => f.problemKey)).size, warnings: 0, needsReview: new Set(uiux.filter((f) => f.resultClass === 'INCONCLUSIVE').map((f) => f.problemKey)).size },
    coverage: runCounts(db, runId),
    byCategory, bySeverity,
    pendingReview: uiux.filter((f) => f.reviewState === 'pending' || f.reviewState === 'investigating').length,
    actions: actions.filter((a) => a.source !== 'visual' && a.source !== 'guard').length,
    guardBlocked: actions.filter((a) => a.source === 'guard').length,
    visual, incomplete: opts.incomplete,
  };
  const a11y = (db.getRun(runId)?.config as { accessibility?: { failRun?: boolean } } | null)?.accessibility;
  // A run that failed to run (target unreachable, authentication required) has not passed anything.
  if (db.getRun(runId)?.status === 'ERROR') return { summary, verdict: 'FAILED' };
  // Only CONFIRMED bugs (and, when required, accessibility findings) decide the verdict. Observations never fail a run.
  const decisive = findings.filter((f) => f.resultClass === 'BUG' || f.track === 'accessibility');
  return { summary, verdict: computeVerdict(decisive, { accessibilityFailRun: a11y?.failRun === true }) };
}

export function buildReportData(db: QADatabase, runId: string): ReportData {
  const run = db.getRun(runId);
  if (!run) throw new Error(`Unknown run ${runId}`);
  const incomplete = run.status === 'ABORTED' || run.status === 'ERROR' || !!run.summary?.incomplete;
  const { summary, verdict } = summarizeRun(db, runId, { incomplete });
  const evidence = new Map(db.listEvidence(runId).map((e) => [e.id, e]));
  const analyses = db.analysesByFinding(runId);
  const cfg = run.config as { viewports?: { name: string }[]; maxPages?: number; maxActions?: number; maxDepth?: number; accessibility?: { enabled?: boolean; failRun?: boolean } };
  const findings: ReportFinding[] = db.listFindings(runId).map((f) => ({
    ...f, ai: analyses.get(f.id) ?? null, evidenceRefs: f.evidence.map((id) => evidence.get(id)).filter((e): e is EvidenceRef => !!e),
  }));
  return {
    generatedAt: new Date().toISOString(),
    run: { id: run.id, url: run.url, mode: run.mode, status: run.status, verdict, createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt, authProfile: run.authProfile, abortReason: run.abortReason, error: run.error },
    incomplete, summary,
    limits: { viewports: (cfg.viewports ?? []).map((v) => v.name), maxPages: cfg.maxPages ?? 0, maxActions: cfg.maxActions ?? 0, maxDepth: cfg.maxDepth ?? 0 },
    pages: db.listPages(runId).map((p) => ({ url: p.url, statusCode: p.statusCode, title: p.title, testStatus: p.testStatus, error: p.error, decision: p.decision, readiness: p.readiness })),
    testResults: db.listTestResults(runId),
    accessibility: { enabled: cfg.accessibility?.enabled !== false, failRun: cfg.accessibility?.failRun === true },
    findings, rulesRun: run.rulesRun, guard: { blockedActions: summary.guardBlocked }, disclaimers: DISCLAIMERS,
  };
}
