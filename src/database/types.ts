import { z } from 'zod';
import type { FindingClass, FindingCounts, FindingTrack } from '../dynamic/resultClassifier.js';
import type { PageReadiness } from '../browser/readiness.js';
import type { PageDecision, ResultClass } from '../dynamic/types.js';
import type { ConfidenceLevel } from '../functional/types.js';
import type { Finding } from '../shared/types.js';

export const RunStatusSchema = z.enum(['CREATED', 'AUTHENTICATING', 'DISCOVERING', 'TESTING', 'ANALYZING', 'REVIEW', 'REPORTING', 'COMPLETED', 'ABORTED', 'ERROR']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const VerdictSchema = z.enum(['PASS', 'PASS_WITH_WARNINGS', 'FAILED', 'BLOCKED_PENDING_REVIEW']);
export type Verdict = z.infer<typeof VerdictSchema>;

export const DecisionSchema = z.enum(['CONFIRM_BUG', 'NOT_A_BUG', 'EXPECTED_BEHAVIOR', 'NEEDS_INVESTIGATION']);
export type Decision = z.infer<typeof DecisionSchema>;

/**
 * Derived (never stored) review state of a finding:
 *  - defect:        engine-confirmed by a ground-truth basis, no human decision yet
 *  - pending:       anomaly waiting for a human
 *  - confirmed:     human CONFIRM_BUG
 *  - dismissed:     human NOT_A_BUG / EXPECTED_BEHAVIOR
 *  - investigating: human NEEDS_INVESTIGATION
 */
export type ReviewState = 'defect' | 'pending' | 'confirmed' | 'dismissed' | 'investigating';

export interface RunRecord {
  id: string;
  url: string;
  authProfile: string | null;
  mode: string;
  status: RunStatus;
  verdict: Verdict | null;
  request: unknown;
  config: unknown;
  state: RunState | null;
  summary: RunSummary | null;
  rulesRun: string[];
  error: string | null;
  abortReason: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

/** Persisted orchestrator cursor: enough to resume a run after a crash/restart. */
export interface RunState {
  phase: RunStatus;
  crawl?: { visited: string[]; queue: { url: string; depth: number }[] };
  crawlDone?: boolean;
  /** "<page>|<viewport>" units already tested. */
  testedUnits: string[];
  actionsUsed: number;
  testedLinks: string[];
  /** Shared controls (same selector and name) already verified on an earlier page: tested once per run. */
  verifiedControls?: string[];
  agentDone?: boolean;
  aiDone?: boolean;
}

/** The numbers a person needs about a run, always computed from what is stored, so they are right for a stopped run too. */
export interface RunCounts {
  pagesCrawled: number; pagesTested: number;
  elementsTested: number; passed: number; blocked: number;
  /** Tested with no proof either way (unclear purpose, nothing observable). Not reported. */
  inconclusive: number;
  /** Distinct UI/UX problems. */
  bugs: number; warnings: number; needsReview: number;
  /** Work that was planned but not done (the run was stopped, or a safety limit was reached). */
  notTestedPages: number; notTestedElements: number;
}

export interface RunSummary {
  pages: number;
  /** All active findings, both tracks. */
  findings: number;
  /** UI/UX track only: rule- or human-confirmed defects, and anomalies awaiting review. Accessibility is counted in `counts`. */
  defects: number;
  anomalies: number;
  /** Per-track breakdown (absent on runs summarised before the tracks were separated). */
  counts?: FindingCounts;
  coverage?: RunCounts;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
  pendingReview: number;
  actions: number;
  guardBlocked: number;
  visual: { pass: number; fail: number; noBaseline: number };
  incomplete?: boolean;
}

export interface PageRecord {
  id: number; runId: string; url: string; depth: number; statusCode: number | null; title: string | null; error: string | null;
  testStatus: 'pending' | 'tested' | 'skipped'; model: unknown | null; discoveredAt: string;
  /** What was detected on the page and which tests were selected/skipped (dynamic selection). */
  decision: PageDecision | null;
  /** What happened while the page loaded: requests made, blocked, failed; whether its data arrived. */
  readiness: PageReadiness | null;
}

export interface ActionRecord { id: number; runId: string; pageUrl: string | null; viewport: string | null; source: string; type: string; target: string | null; ok: boolean; detail: string | null; at: string }

export interface StoredFinding extends Finding {
  id: string;
  runId: string;
  fingerprint: string;
  createdAt: string;
}

export interface DecisionRecord { id: number; findingId: string; runId: string; decision: Decision; note: string | null; decidedBy: string; decidedAt: string }

export interface FindingView extends StoredFinding {
  reviewState: ReviewState;
  decision: DecisionRecord | null;
  /** Derived label: BUG / WARNING / NEEDS_REVIEW for UI/UX findings, ACCESSIBILITY for the accessibility track, EXPECTED when dismissed. */
  resultClass: FindingClass;
  /** Accessibility findings are reported on their own track, separate from general UI/UX. */
  track: FindingTrack;
  /** Identity of the underlying problem: findings sharing it are occurrences of one problem. */
  problemKey: string;
}

/** One executed dynamic test, including the ones that are not findings (EXPECTED, BLOCKED_BY_SAFETY). */
export interface TestResultRecord {
  id: number; runId: string; page: string; viewport: string;
  scenario: string; scenarioLabel: string; pageType: string; reason: string; confidence: ConfidenceLevel;
  kind: string; check: string; target: string | null; expected: string; actual: string; classification: ResultClass; createdAt: string;
}
