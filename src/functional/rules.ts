import { makeFinding } from '../rules/helpers.js';
import type { Rule } from '../rules/types.js';
import type { Finding } from '../shared/types.js';
import type { FunctionalKind } from './types.js';

/** Turns FunctionalResults into findings. `fail` => defect (carries its own basis); `anomaly` => review; pass/skipped => nothing. */
function functionalRule(kind: FunctionalKind, name: string, description: string): Rule {
  const rule: Rule = {
    id: `functional.${kind}`, name, category: 'functional', severity: 'major', basis: 'deterministic', description,
    async evaluate(ctx) {
      const out: Finding[] = [];
      for (const r of ctx.functional) {
        if (r.kind !== kind || r.status === 'pass' || r.status === 'skipped') continue;
        out.push(makeFinding(rule, ctx, {
          classification: r.status === 'fail' ? 'defect' : 'anomaly',
          severity: r.severity, basis: r.status === 'fail' ? (r.basis ?? 'deterministic') : null,
          element: r.element, expected: r.expected, actual: `[${r.check}] ${r.actual}`,
        }));
      }
      return out;
    },
  };
  return rule;
}

export const buttonFunctionalRule = functionalRule('button', 'Button functional failure', 'A button is not clickable, throws a JS error, or triggers failed network requests when activated.');
export const linkFunctionalRule = functionalRule('link', 'Link functional failure', 'A same-origin link navigates to an error page, is not clickable, or has no usable destination.');
export const formFunctionalRule = functionalRule('form', 'Form functional failure', 'A form accepts invalid input, ignores required fields, lacks validation feedback, or fails on valid submission.');

export const functionalRules: Rule[] = [buttonFunctionalRule, linkFunctionalRule, formFunctionalRule];
