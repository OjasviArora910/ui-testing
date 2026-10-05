import type { DecisionRecord, FindingView, ReviewState, Verdict } from './types.js';
import type { Finding } from '../shared/types.js';

/**
 * Review state is DERIVED. `confirmed` can only come from a human decision row; the AI layer has no write path to it.
 */
export function reviewStateOf(classification: Finding['classification'], decision: DecisionRecord | null): ReviewState {
  if (decision) {
    switch (decision.decision) {
      case 'CONFIRM_BUG': return 'confirmed';
      case 'NOT_A_BUG':
      case 'EXPECTED_BEHAVIOR': return 'dismissed';
      case 'NEEDS_INVESTIGATION': return 'investigating';
    }
  }
  return classification === 'defect' ? 'defect' : 'pending';
}

export interface VerdictInput { reviewState: ReviewState; severity: Finding['severity']; category?: string; ruleId?: string }
export interface VerdictOptions {
  /** When false (default) accessibility findings are reported but never decide the verdict. A human-confirmed bug always counts. */
  accessibilityFailRun?: boolean;
}

/**
 * Run verdict:
 *  FAILED                  - a human-confirmed bug, or an engine-confirmed defect of severity critical/major
 *  BLOCKED_PENDING_REVIEW  - no failing defect, but anomalies still await a human (or are under investigation)
 *  PASS_WITH_WARNINGS      - only minor/info defects remain
 *  PASS                    - nothing active
 * Accessibility findings take part only when accessibility is a required category (accessibility.failRun).
 */
export function computeVerdict(all: VerdictInput[], opts: VerdictOptions = {}): Verdict {
  const findings = opts.accessibilityFailRun ? all : all.filter((f) => f.reviewState === 'confirmed' || !(f.category === 'accessibility' || f.ruleId?.startsWith('a11y.')));
  const failing = findings.some((f) => f.reviewState === 'confirmed' || (f.reviewState === 'defect' && (f.severity === 'critical' || f.severity === 'major')));
  if (failing) return 'FAILED';
  if (findings.some((f) => f.reviewState === 'pending' || f.reviewState === 'investigating')) return 'BLOCKED_PENDING_REVIEW';
  if (findings.some((f) => f.reviewState === 'defect')) return 'PASS_WITH_WARNINGS';
  return 'PASS';
}

const SEVERITY_ORDER = { critical: 0, major: 1, minor: 2, info: 3 } as const;

/** Findings that need a person: pending anomalies and ones under investigation, most severe first. */
export function reviewQueue(findings: FindingView[]): FindingView[] {
  return findings
    .filter((f) => f.reviewState === 'pending' || f.reviewState === 'investigating')
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.page.localeCompare(b.page));
}
