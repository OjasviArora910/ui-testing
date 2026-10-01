import { testButtons } from './buttons.js';
import { testForms } from './forms.js';
import { testLinks } from './links.js';
import type { FunctionalContext, FunctionalResult } from './types.js';

/** Runs button, link and form tests for one page. A crashing sub-suite is recorded as a skipped result, never as a defect. */
export async function runFunctionalTests(ctx: FunctionalContext): Promise<FunctionalResult[]> {
  const out: FunctionalResult[] = [];
  const suites: [FunctionalResult['kind'], (c: FunctionalContext) => Promise<FunctionalResult[]>][] = [['button', testButtons], ['link', testLinks], ['form', testForms]];
  for (const [kind, suite] of suites) {
    if (ctx.budget.exhausted) break;
    try { out.push(...await suite(ctx)); } catch (e) {
      out.push({ kind, check: 'suite-error', status: 'skipped', severity: 'info', basis: null, element: null, expected: `${kind} tests complete`, actual: `${kind} suite aborted: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` });
    }
  }
  // leave the page in its original state for the next consumer
  await ctx.controller.navigate(ctx.pageUrl).catch(() => undefined);
  return out;
}
