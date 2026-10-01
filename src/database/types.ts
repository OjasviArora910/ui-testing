import { z } from 'zod';
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
  agentDone?: boolean;
  aiDone?: boolean;
}

export interface RunSummary {
  pages: number;
  findings: number;
  defects: number;
  anomalies: number;
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
}
