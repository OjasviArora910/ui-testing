import type { ElementInfo } from '../browser/types.js';
import type { Basis, Finding, Severity } from '../shared/types.js';
import type { Rule, RuleContext } from './types.js';

export interface FindingInit {
  /** Overrides the rule id (used by rules that emit several sub-checks, e.g. "a11y.color-contrast"). */
  ruleId?: string;
  category?: string;
  severity?: Severity;
  classification: 'defect' | 'anomaly';
  basis?: Basis | null;
  element?: Finding['element'];
  expected: string;
  actual: string;
  evidence?: string[];
}

/** Builds a Finding with the rule's defaults. The schema (not this helper) is what enforces "defect needs basis". */
export function makeFinding(rule: Pick<Rule, 'id' | 'category' | 'severity' | 'basis'>, ctx: Pick<RuleContext, 'page' | 'viewport'>, init: FindingInit): Finding {
  return {
    ruleId: init.ruleId ?? rule.id,
    category: init.category ?? rule.category,
    severity: init.severity ?? rule.severity,
    classification: init.classification,
    basis: init.basis === undefined ? (init.classification === 'defect' ? rule.basis : null) : init.basis,
    page: ctx.page,
    viewport: ctx.viewport.name,
    element: init.element ?? null,
    expected: init.expected,
    actual: init.actual,
    evidence: init.evidence ?? [],
  };
}

export function elementRef(e: ElementInfo): NonNullable<Finding['element']> {
  return { selector: e.selector, role: e.role ?? undefined, name: (e.name || e.text || '').slice(0, 80) || undefined, box: e.box };
}

export function fmtBox(b: { x: number; y: number; width: number; height: number }): string {
  return `${Math.round(b.width)}x${Math.round(b.height)} at (${Math.round(b.x)},${Math.round(b.y)})`;
}

/** Stable identity of a finding across runs; used for dedupe and baselines of "known" issues. */
export function fingerprint(f: Finding): string {
  const sel = f.element?.selector ?? '';
  const path = (() => { try { const u = new URL(f.page); return u.pathname; } catch { return f.page; } })();
  return [f.ruleId, path, f.viewport, sel, f.actual.replace(/\d+/g, '#').slice(0, 80)].join('|');
}
