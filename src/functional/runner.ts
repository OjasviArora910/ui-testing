import { testButtons } from './buttons.js';
import { testFields } from './fields.js';
import { testForms } from './forms.js';
import { testLinks } from './links.js';
import { testModals } from './modal.js';
import { testSearch } from './search.js';
import type { FunctionalContext, FunctionalResult } from './types.js';

/** Checks whose ambiguous outcome is still a concrete suspected problem worth a person's look. */
const REVIEWABLE = new Set(['soft-error-page', 'clickable', 'destination']);

type Suite = [FunctionalResult['kind'], (c: FunctionalContext) => Promise<FunctionalResult[]>];

/** Without a plan every generic suite runs (legacy). With a plan only the testers it selected run, on the elements it named. */
function suitesFor(ctx: FunctionalContext): Suite[] {
  const plan = ctx.plan;
  if (!plan) return [['button', testButtons], ['link', testLinks], ['form', testForms]];
  const suites: Suite[] = [];
  if (plan.buttons.length > 0) suites.push(['button', testButtons]);
  if (plan.links) suites.push(['link', testLinks]);
  if (plan.forms.length > 0) suites.push(['form', testForms]);
  if (plan.searches.length > 0) suites.push(['search', testSearch]);
  if (plan.modals.length > 0) suites.push(['modal', testModals]);
  if (plan.fields.length > 0) suites.push(['interactive', testFields]);
  return suites;
}

/** Runs the selected functional suites for one page. A crashing sub-suite is recorded as a skipped result, never as a defect. */
export async function runFunctionalTests(ctx: FunctionalContext): Promise<FunctionalResult[]> {
  const out: FunctionalResult[] = [];
  let n = 0;
  // Every result is finalised and handed on the moment its test ends, so a run that is stopped keeps all finished work.
  const finalize = (r: FunctionalResult): void => {
    if (r.id) return;
    r.id = `r${n++}`;
    if (r.kind === 'link' && !r.scenario && ctx.plan?.links) r.scenario = ctx.plan.links;
    // A failure the tester itself was unsure about is not evidence of a defect.
    if (r.status === 'fail' && r.confidence === 'LOW') { r.status = 'inconclusive'; r.basis = null; r.severity = 'info'; }
    // Review is for a meaningful suspected problem (a link that lands on an error-looking page, a control covered by an
    // overlay). "Nothing observable happened and the purpose is unclear" is not one: it is recorded, not reported.
    if (r.status === 'anomaly' && !REVIEWABLE.has(r.check)) { r.status = 'inconclusive'; r.severity = 'info'; }
    ctx.onResult?.(r);
  };
  const inner: FunctionalContext = { ...ctx, onResult: finalize };
  for (const [kind, suite] of suitesFor(ctx)) {
    if (ctx.budget.exhausted) break;
    try { out.push(...await suite(inner)); } catch (e) {
      out.push({ kind, check: 'suite-error', status: 'skipped', severity: 'info', basis: null, element: null, expected: `${kind} tests complete`, actual: `${kind} suite aborted: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` });
    }
  }
  out.forEach(finalize);
  // leave the page in its original state for the next consumer
  await ctx.controller.navigate(ctx.pageUrl).catch(() => undefined);
  return out;
}
