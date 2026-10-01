import type { CustomRule } from '../shared/config.js';
import { makeFinding } from './helpers.js';
import type { Rule } from './types.js';

function pageMatches(globs: string[], page: string): boolean {
  let p = page;
  try { p = new URL(page).pathname; } catch { /* already a path */ }
  return globs.some((g) => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(p));
}

/**
 * Compiles a declarative rule from qa.config.json into a Rule. Application-specific expectations live in config,
 * not in core code. Findings are always `configured_rule` defects: the user wrote the expectation.
 */
export function compileCustomRule(def: CustomRule): Rule {
  const rule: Rule = {
    id: def.id, name: def.name, category: def.category, severity: def.severity, description: def.description || def.name, basis: 'configured_rule',
    async evaluate(ctx) {
      if (!pageMatches(def.pages, ctx.page)) return [];
      const fail = (expected: string, actual: string) => [makeFinding(rule, ctx, { classification: 'defect', element: def.selector ? { selector: def.selector } : null, expected, actual })];
      const q = ctx.queries;
      switch (def.type) {
        case 'text-present': return def.text && !ctx.text.includes(def.text) ? fail(`Page text contains "${def.text}"`, 'Text not found on page') : [];
        case 'text-absent': return def.text && ctx.text.includes(def.text) ? fail(`Page text does not contain "${def.text}"`, 'Forbidden text found on page') : [];
        default: {
          if (!def.selector || !q) return [];
          const n = await q.count(def.selector);
          if (def.type === 'selector-exists' && n === 0) return fail(`Selector ${def.selector} matches at least one element`, 'No matching element');
          if (def.type === 'selector-absent' && n > 0) return fail(`Selector ${def.selector} matches nothing`, `${n} matching element(s) found`);
          if (def.type === 'min-count' && def.count !== undefined && n < def.count) return fail(`At least ${def.count} elements match ${def.selector}`, `${n} found`);
          if (def.type === 'max-count' && def.count !== undefined && n > def.count) return fail(`At most ${def.count} elements match ${def.selector}`, `${n} found`);
          return [];
        }
      }
    },
  };
  return rule;
}
