import { makeFinding } from '../rules/helpers.js';
import type { Rule } from '../rules/types.js';
import type { Finding, Severity } from '../shared/types.js';
import type { AxeFinding } from './types.js';

const IMPACT: Record<NonNullable<AxeFinding['impact']>, Severity> = { critical: 'critical', serious: 'major', moderate: 'minor', minor: 'minor' };
const MAX_NODES_PER_RULE = 10;

/**
 * axe-core results. Violations are codified checks (basis generic_rule). "Incomplete" results (e.g. contrast over
 * images) cannot be decided automatically, so they are anomalies for human review. This is NOT a WCAG conformance claim.
 */
export const axeRule: Rule = {
  id: 'a11y.axe', name: 'Accessibility (axe-core)', category: 'accessibility', severity: 'major', basis: 'generic_rule',
  description: 'Automated accessibility checks via axe-core: labels, accessible names, ARIA validity, contrast, duplicate ids, heading structure, form labels. Automated testing covers only part of WCAG.',
  async evaluate(ctx) {
    const out: Finding[] = [];
    for (const f of ctx.axe) {
      if (!f.nodes || f.nodes.length === 0) continue;
      const severity = f.impact ? IMPACT[f.impact] : 'minor';
      const nodes = f.nodes.slice(0, MAX_NODES_PER_RULE);
      const isButtonName = f.axeRuleId === 'button-name';
      const emptyPrefix = isButtonName ? 'Accessible name: EMPTY. ' : '';
      const countPrefix = f.nodes.length > 1 ? `(${f.nodes.length} affected elements: ${nodes.map((n) => n.selector).join(', ')}) ` : '';

      out.push(makeFinding(axeRule, ctx, {
        ruleId: `a11y.${f.axeRuleId}`,
        severity: f.kind === 'incomplete' ? 'info' : severity,
        classification: f.kind === 'violation' ? 'defect' : 'anomaly',
        element: {
          selector: nodes.map((n) => n.selector).join(', '),
          name: isButtonName ? 'Accessible name: EMPTY' : nodes[0]!.html.slice(0, 80),
        },
        expected: f.help,
        actual: `${emptyPrefix}${countPrefix}${nodes[0]!.summary || f.description}`.slice(0, 500) +
          ` [${f.tags.filter((t) => /^wcag|^best/.test(t)).slice(0, 3).join(', ')}] ${f.helpUrl}`,
      }));
    }
    return out;
  },
};

export const keyboardRule: Rule = {
  id: 'a11y.keyboard', name: 'Keyboard accessibility', category: 'accessibility', severity: 'minor', basis: 'generic_rule',
  description: 'Tab-key traversal: interactive elements unreachable by keyboard, focus traps, and missing focus indicators. Heuristic, so findings are anomalies for review.',
  async evaluate(ctx) {
    if (!ctx.keyboard) return [];
    return ctx.keyboard.issues.map((i) => makeFinding(keyboardRule, ctx, {
      ruleId: `a11y.keyboard.${i.type}`, classification: 'anomaly', severity: i.type === 'focus-trap' ? 'major' : 'minor',
      element: { selector: i.selector, name: i.name }, expected: 'All interactive elements are keyboard reachable with a visible focus indicator and no focus trap', actual: i.detail,
    }));
  },
};

export const accessibilityRules: Rule[] = [axeRule, keyboardRule];
