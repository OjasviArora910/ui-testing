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
    // ambiguous evidence, or a failure the tester was not sure of: it could not be decided, so it is not a bug
    case 'anomaly': return 'INCONCLUSIVE';
    case 'inconclusive': return 'INCONCLUSIVE';
    case 'fail': return !r.basis || r.confidence === 'LOW' ? 'INCONCLUSIVE' : 'BUG';
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
 * Checks that only MEASURE the page (box sizes and positions). A measurement that is off by some pixels is an observation:
 * it does not show that a user sees anything wrong, so on its own it can never be a confirmed bug.
 */
const MEASUREMENT_ONLY = new Set(['geometry.container-overflow', 'geometry.zero-size', 'geometry.off-screen', 'geometry.small-target', 'consistency.spacing', 'consistency.alignment', 'layout.stacked-duplicate']);

export interface GateInput {
  classification: Finding['classification']; severity: Finding['severity']; category: string; ruleId: string;
  basis?: Finding['basis']; expected?: string; actual?: string; evidence?: string[]; context?: Finding['context'];
  reviewState?: string;
  /** The page's own data requests were blocked or failed, so what the page looked like is not reliable. */
  pageDataNotLoaded?: boolean;
}

/**
 * THE FINDING GATE. A finding is a CONFIRMED BUG only when every condition holds; otherwise it is an observation and is
 * never counted or listed as a bug. Returns the reason it is not confirmed, or null when it is.
 *  1. the check itself concluded "this contradicts the expected behaviour" (not "something looks unusual");
 *  2. that conclusion rests on a ground-truth basis, and the tester was not unsure of it;
 *  3. there is a concrete expected behaviour and an observed actual result;
 *  4. there is evidence attached to this finding;
 *  5. nothing about it comes from the QA platform's own blocking (a blocked request is never an application bug);
 *  6. it is visible or functionally meaningful to a user, not only a measurement;
 *  7. the page it was seen on had loaded its data (interactions carry their own evidence and are exempt).
 */
export function notConfirmedReason(f: GateInput): string | null {
  if (f.classification !== 'defect') return 'the check could not decide: something looked unusual, which is not proof of a bug';
  if (f.basis === null) return 'no ground-truth basis for calling this a failure';
  if ((f.context as { confidence?: string } | null | undefined)?.confidence === 'LOW') return 'the tester was not confident in this result';
  if (f.expected !== undefined && f.actual !== undefined && (!f.expected.trim() || !f.actual.trim())) return 'no concrete expected behaviour or observed result';
  if (f.evidence !== undefined && f.evidence.length === 0) return 'no evidence attached';
  if (/blocked by (the )?(safety|qa)|safety guard|BLOCKED_BY_CLIENT/i.test(f.actual ?? '')) return 'caused by a request the QA platform itself blocked';
  if (MEASUREMENT_ONLY.has(f.ruleId)) return 'a measurement of the layout, with no proof that a user sees anything wrong';
  if (f.pageDataNotLoaded && !f.ruleId.startsWith('functional.') && !f.ruleId.startsWith('navigation.')) return 'the page had not loaded all of its data, so its appearance is not reliable';
  return null;
}

/**
 * Label for a stored finding (rule findings included). There are only two outcomes for a UI/UX finding:
 *  BUG           it passed the finding gate (or a human confirmed it)
 *  INCONCLUSIVE  anything else: an observation, kept as a record, never counted or listed as a bug
 * Accessibility findings are their own track.
 */
export function classifyFinding(f: GateInput): FindingClass {
  if (f.reviewState === 'dismissed') return 'EXPECTED';
  if (isAccessibility(f)) return 'ACCESSIBILITY';
  if (f.reviewState === 'confirmed') return 'BUG';
  if (f.reviewState === 'investigating') return 'INCONCLUSIVE';
  return notConfirmedReason(f) === null ? 'BUG' : 'INCONCLUSIVE';
}

const pathOf = (page: string): string => { try { const u = new URL(page); return u.pathname + u.hash; } catch { return page; } };

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
export function groupProblems<T extends Pick<Finding, 'ruleId' | 'category' | 'actual' | 'page' | 'viewport' | 'element' | 'classification' | 'severity'> & Partial<GateInput>>(findings: T[]): ProblemGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const f of findings) { const k = problemKey(f); groups.set(k, [...(groups.get(k) ?? []), f]); }
  return [...groups.entries()].map(([key, list]) => {
    const sorted = [...list].sort((a, b) => CLASS_RANK[classifyFinding(a)] - CLASS_RANK[classifyFinding(b)] || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    return { key, resultClass: classifyFinding(sorted[0]!), representative: sorted[0]!, occurrences: sorted };
  }).sort((a, b) => CLASS_RANK[a.resultClass] - CLASS_RANK[b.resultClass] || SEVERITY_RANK[a.representative.severity] - SEVERITY_RANK[b.representative.severity]);
}

export interface FindingCounts {
  /** UI/UX only. DISTINCT problems, not occurrences. `bugs` are CONFIRMED bugs; `needsReview` are observations that are not bugs. */
  bugs: number; warnings: number; needsReview: number;
  /** Accessibility track (only when accessibility checks are enabled). */
  accessibility: number; accessibilityNeedsReview: number;
}

/** Counts of distinct active problems per label. The single place that decides what is shown as a UI/UX bug. */
export function countFindings(findings: (Pick<Finding, 'ruleId' | 'category' | 'actual' | 'page' | 'viewport' | 'element' | 'classification' | 'severity'> & Partial<GateInput>)[]): FindingCounts {
  const c: FindingCounts = { bugs: 0, warnings: 0, needsReview: 0, accessibility: 0, accessibilityNeedsReview: 0 };
  for (const g of groupProblems(findings.filter((f) => f.reviewState !== 'dismissed'))) {
    switch (g.resultClass) {
      case 'BUG': c.bugs++; break;
      case 'WARNING': c.warnings++; break;
      case 'NEEDS_REVIEW': case 'INCONCLUSIVE': c.needsReview++; break; // observations that did not pass the finding gate: not bugs
      case 'ACCESSIBILITY': if (g.representative.classification === 'anomaly' && g.representative.reviewState !== 'confirmed') c.accessibilityNeedsReview++; else c.accessibility++; break;
      default: break;
    }
  }
  return c;
}
