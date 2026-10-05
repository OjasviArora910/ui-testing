import { makeFinding } from '../rules/helpers.js';
import type { Rule } from '../rules/types.js';
import type { Finding } from '../shared/types.js';
import type { Viewport } from '../shared/types.js';
import type { FunctionalKind, FunctionalResult } from './types.js';

/** `fail` => defect (carries its own basis); `anomaly` => review; pass/skipped/blocked => no finding. */
export const producesFinding = (r: FunctionalResult): boolean => r.status === 'fail' || r.status === 'anomaly';

/** The finding for one failed or ambiguous element test. Used by the rule below and by the run executor, which saves it at once. */
export function findingFromResult(rule: Pick<Rule, 'id' | 'category' | 'severity' | 'basis' | 'description'>, where: { page: string; viewport: Viewport }, r: FunctionalResult): Finding {
  return makeFinding(rule, where, {
    classification: r.status === 'fail' ? 'defect' : 'anomaly',
    severity: r.severity, basis: r.status === 'fail' ? (r.basis ?? 'deterministic') : null,
    element: r.element, expected: r.expected, actual: `[${r.check}] ${r.actual}`,
    context: r.scenario || r.id ? { resultId: r.id, scenario: r.scenario?.id, pageType: r.scenario?.pageType, reason: r.scenario?.reason, confidence: r.confidence ?? r.scenario?.confidence, why: typeof r.details?.reason === 'string' ? r.details.reason : undefined } : undefined,
  });
}

function functionalRule(kind: FunctionalKind, name: string, description: string): Rule {
  const rule: Rule = {
    id: `functional.${kind}`, name, category: 'functional', severity: 'major', basis: 'deterministic', description,
    async evaluate(ctx) {
      return ctx.functional.filter((r) => r.kind === kind && producesFinding(r)).map((r) => findingFromResult(rule, ctx, r));
    },
  };
  return rule;
}

export const buttonFunctionalRule = functionalRule('button', 'Button functional failure', 'A button is not clickable, throws a JS error, or triggers failed network requests when activated.');
export const linkFunctionalRule = functionalRule('link', 'Link functional failure', 'A same-origin link navigates to an error page, is not clickable, or has no usable destination.');
export const formFunctionalRule = functionalRule('form', 'Form functional failure', 'A form accepts invalid input, ignores required fields, lacks validation feedback, or fails on valid submission.');

export const searchFunctionalRule = functionalRule('search', 'Search functional failure', 'A search input throws an error or triggers a failed request when a safe query is submitted.');
export const modalFunctionalRule = functionalRule('modal', 'Modal functional failure', 'A declared modal trigger opens nothing, or an opened dialog cannot be closed.');

export const fieldFunctionalRule = functionalRule('interactive', 'Form control failure', 'A form control was operated successfully but did not take the value: typed text is not held, the chosen option is not shown, or the checked state does not change.');

export const functionalRules: Rule[] = [buttonFunctionalRule, linkFunctionalRule, formFunctionalRule, searchFunctionalRule, modalFunctionalRule, fieldFunctionalRule];
