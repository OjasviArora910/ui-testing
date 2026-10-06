import type { FunctionalResult } from '../functional/types.js';
import type { Finding } from '../shared/types.js';
import type { ResultClass } from './types.js';

/**
 * Classifies one executed test. The verifier decided WHAT happened; this only names it:
 *  BUG                - failure backed by a ground-truth basis, major/critical, and not low confidence
 *  WARNING            - real but minor failure
 *  EXPECTED           - behaviour matched the expectation (including validation correctly rejecting input)
 *  NEEDS_REVIEW       - ambiguous evidence or intent, or a failure the tester was not confident about
 *  BLOCKED_BY_SAFETY  - ActionGuard refused the action or stopped the request it sent
 * Returns null for results that are neither (not tested: invisible, external, suite error).
 */
export function classifyResult(r: Pick<FunctionalResult, 'status' | 'severity' | 'basis' | 'check' | 'confidence'>): ResultClass | null {
  switch (r.status) {
    case 'blocked': return 'BLOCKED_BY_SAFETY';
    case 'skipped': return r.check === 'guard' ? 'BLOCKED_BY_SAFETY' : null;
    case 'pass': return 'EXPECTED';
    case 'anomaly': return 'NEEDS_REVIEW';
    case 'inconclusive': return 'INCONCLUSIVE';
    case 'fail':
      if (!r.basis || r.confidence === 'LOW') return 'NEEDS_REVIEW';
      return r.severity === 'critical' || r.severity === 'major' ? 'BUG' : 'WARNING';
  }
}

/**
 * Every finding belongs to exactly one track. UI/UX is about whether the interface is broken or unusable for anyone;
 * accessibility is about whether assistive technology and keyboard users can perceive and operate it. A control can work
 * perfectly (UI/UX: fine) and still have an accessibility problem (for example an icon-only button with no accessible name).
 */
export type FindingTrack = 'uiux' | 'accessibility';
/** Label of a stored finding. An accessibility finding is never a UI/UX BUG or WARNING. */
export type FindingClass = ResultClass | 'ACCESSIBILITY';

export const isAccessibility = (f: Pick<Finding, 'category' | 'ruleId'>): boolean => f.category === 'accessibility' || f.ruleId.startsWith('a11y.');
export const trackOf = (f: Pick<Finding, 'category' | 'ruleId'>): FindingTrack => (isAccessibility(f) ? 'accessibility' : 'uiux');

/**
 * Label for a stored finding (rule findings included), honouring human review decisions:
 *  accessibility track -> ACCESSIBILITY, whatever its severity or rule basis
 *  UI/UX defect, major/critical -> BUG; minor/info -> WARNING; anomaly -> NEEDS_REVIEW
 */
export function classifyFinding(f: Pick<Finding, 'classification' | 'severity' | 'category' | 'ruleId'> & { reviewState?: string }): FindingClass {
  if (f.reviewState === 'dismissed') return 'EXPECTED';
  if (isAccessibility(f)) return 'ACCESSIBILITY';
  if (f.reviewState === 'confirmed') return 'BUG';
  if (f.classification === 'anomaly' || f.reviewState === 'investigating') return 'NEEDS_REVIEW';
  return f.severity === 'critical' || f.severity === 'major' ? 'BUG' : 'WARNING';
}

const pathOf = (page: string): string => { try { return new URL(page).pathname; } catch { return page; } };

/**
 * Identity of the underlying problem, so repeats are reported once with their occurrences:
 *  - behaviour and runtime failures (interaction, network, console): the same failure message is the same problem wherever
 *    it shows up. Ten buttons that all die on the same failing request are one problem, not ten.
 *  - visual/layout findings belong to an element on a page: the same element at three viewport sizes is one problem.
 */
export function problemKey(f: Pick<Finding, 'ruleId' | 'category' | 'actual' | 'page' | 'viewport' | 'element'>): string {
  const behavioural = f.ruleId.startsWith('functional.') || ['functional', 'network', 'console', 'performance'].includes(f.category);
  if (behavioural) {
    // drop what merely names the instance (quoted labels, the origin); keep what identifies the failure (check, path, status)
    const msg = f.actual.replace(/"[^"]*"/g, '"…"').replace(/https?:\/\/[^/\s"')]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return `${f.ruleId}|${msg}`;
  }
  const msg = f.actual.replace(/\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').trim().slice(0, 120); // sizes differ per viewport
  return `${f.ruleId}|${pathOf(f.page)}|${f.element?.selector ?? ''}|${msg}`;
}

/**
 * One user-facing problem is one finding. A control that cannot be clicked because another element covers it, and the
 * overlap of those two elements, are the same problem seen by two checks: returns the stored overlap finding that already
 * reports it, so the click result is attached to it as evidence instead of being listed again.
 */
export function sameRootCause<T extends Pick<Finding, 'ruleId' | 'classification' | 'page' | 'viewport' | 'element' | 'actual'>>(
  f: Pick<Finding, 'ruleId' | 'page' | 'viewport' | 'element' | 'actual'>, existing: T[],
): T | undefined {
  if (!f.ruleId.startsWith('functional.') || !f.actual.startsWith('[clickable]') || !f.element) return undefined;
  const sel = f.element.selector;
  return existing.find((x) => x.ruleId === 'geometry.overlap' && x.classification === 'defect' && x.viewport === f.viewport && pathOf(x.page) === pathOf(f.page)
    && (x.element?.selector === sel || x.actual.includes(`, ${sel})`)));
}

export interface ProblemGroup<T> { key: string; resultClass: FindingClass; representative: T; occurrences: T[] }
const CLASS_RANK: Record<FindingClass, number> = { BUG: 0, WARNING: 1, NEEDS_REVIEW: 2, ACCESSIBILITY: 3, BLOCKED_BY_SAFETY: 4, EXPECTED: 5, INCONCLUSIVE: 6 };
const SEVERITY_RANK = { critical: 0, major: 1, minor: 2, info: 3 } as const;

/** Groups findings into distinct problems. A group takes the label and representative of its most serious occurrence. */
export function groupProblems<T extends Pick<Finding, 'ruleId' | 'category' | 'actual' | 'page' | 'viewport' | 'element' | 'classification' | 'severity'> & { reviewState?: string }>(findings: T[]): ProblemGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const f of findings) { const k = problemKey(f); groups.set(k, [...(groups.get(k) ?? []), f]); }
  return [...groups.entries()].map(([key, list]) => {
    const sorted = [...list].sort((a, b) => CLASS_RANK[classifyFinding(a)] - CLASS_RANK[classifyFinding(b)] || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    return { key, resultClass: classifyFinding(sorted[0]!), representative: sorted[0]!, occurrences: sorted };
  }).sort((a, b) => CLASS_RANK[a.resultClass] - CLASS_RANK[b.resultClass] || SEVERITY_RANK[a.representative.severity] - SEVERITY_RANK[b.representative.severity]);
}

export interface FindingCounts {
  /** UI/UX only. DISTINCT problems, not occurrences. */
  bugs: number; warnings: number; needsReview: number;
  /** Accessibility track (only when accessibility checks are enabled). */
  accessibility: number; accessibilityNeedsReview: number;
}

/** Counts of distinct active problems per label. The single place that decides what is shown as a UI/UX bug. */
export function countFindings(findings: (Pick<Finding, 'ruleId' | 'category' | 'actual' | 'page' | 'viewport' | 'element' | 'classification' | 'severity'> & { reviewState?: string })[]): FindingCounts {
  const c: FindingCounts = { bugs: 0, warnings: 0, needsReview: 0, accessibility: 0, accessibilityNeedsReview: 0 };
  for (const g of groupProblems(findings.filter((f) => f.reviewState !== 'dismissed'))) {
    switch (g.resultClass) {
      case 'BUG': c.bugs++; break;
      case 'WARNING': c.warnings++; break;
      case 'NEEDS_REVIEW': c.needsReview++; break;
      case 'ACCESSIBILITY': if (g.representative.classification === 'anomaly' && g.representative.reviewState !== 'confirmed') c.accessibilityNeedsReview++; else c.accessibility++; break;
      default: break;
    }
  }
  return c;
}
