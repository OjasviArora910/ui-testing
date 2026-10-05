import { resetPage } from './helpers.js';
import { capturePreActionSnapshot, observeAction, traceOf } from './observer.js';
import type { FunctionalContext, FunctionalResult, InferredIntent } from './types.js';
import { verifyInteraction } from './verifier.js';

const BASE = { kind: 'search' as const };
const QUERY = 'test';

/**
 * Search scenario: type a harmless query, trigger the search, and let the existing observer/verifier decide whether
 * anything meaningful happened. A search box is never run through required/invalid-value form validation.
 */
export async function testSearch(ctx: FunctionalContext): Promise<FunctionalResult[]> {
  const { controller: c, guard } = ctx;
  const results: FunctionalResult[] = [];

  for (const { target, scenario } of ctx.plan?.searches ?? []) {
    if (ctx.budget.exhausted) break;
    const el = { selector: target.input, role: 'searchbox', name: target.label.slice(0, 80) };
    const push = (r: FunctionalResult): void => { const x = { ...r, scenario }; results.push(x); ctx.onResult?.(x); };
    const decision = guard.check({ kind: 'fill', selector: target.input, name: target.label, fieldName: target.label, fieldType: 'search' });
    if (!decision.allowed) {
      push({ ...BASE, check: 'guard', status: 'skipped', severity: 'info', basis: null, element: el, expected: 'Safe search inputs are exercised', actual: `Not used: ${decision.reason}`, details: { guard: decision } });
      continue;
    }
    if (!(await resetPage(ctx))) break;
    if (!ctx.budget.consume(2)) break;

    const intent: InferredIntent = {
      kind: 'SEARCH', confidence: scenario.confidence, summary: `Search for "${QUERY}"`,
      expectedOutcome: { description: `Searching for "${QUERY}" updates the results, the page content or the URL`, expectedDomMutation: true, targetSelector: target.input },
    };
    const loc = c.locate({ css: target.input });
    const rawBox = await loc.boundingBox().catch(() => null);
    const box = rawBox ? { ...rawBox, vpWidth: c.viewport.width, vpHeight: c.viewport.height } : null;
    ctx.onAction?.({ phase: 'TARGETED', type: 'target', target: target.label, ok: true, box, intent, expected: intent.expectedOutcome.description });

    // Snapshot BEFORE typing: live filters react to the input event, not to Enter.
    const pre = await capturePreActionSnapshot(c, target.input, { captureScreenshot: true });
    const fill = await c.fill({ css: target.input }, QUERY);
    ctx.onAction?.({ phase: 'CLICKING', type: 'fill', target: target.label, ok: fill.ok, detail: fill.error, box, intent });
    const trigger = !fill.ok ? fill : target.submit ? await c.click({ css: target.submit }) : await c.press('Enter', { css: target.input });
    const observation = await observeAction(ctx, pre, intent, { minWaitMs: 200, maxWaitMs: 1500, captureScreenshot: true });
    const outcome = verifyInteraction({ intent, observation, clickResult: trigger, elementLabel: target.label, selector: target.input });
    ctx.onAction?.({
      phase: 'RESULT', type: outcome.check, target: target.label, ok: outcome.verdict === 'PASS', verdict: outcome.verdict, confidence: outcome.confidence,
      expected: outcome.expected, actual: outcome.actual, detail: outcome.reason, box, buffer: observation.screenshot, durationMs: observation.durationMs,
    });

    const proof = { before: pre.screenshot, screenshot: observation.screenshot, trace: traceOf(`search for "${QUERY}" in "${target.label}"`, observation) };
    const common = { ...BASE, element: el, expected: outcome.expected, actual: outcome.actual, confidence: outcome.confidence, durationMs: observation.durationMs };
    if (outcome.verdict === 'PASS') push({ ...common, check: 'search', status: 'pass', severity: 'info', basis: null });
    else if (outcome.verdict === 'BLOCKED') push({ ...common, check: outcome.check, status: 'blocked', severity: 'info', basis: null, ...proof });
    else if (outcome.verdict === 'FAIL') {
      const runtime = outcome.check === 'javascript-error' || outcome.check === 'network-failure';
      push({ ...common, check: outcome.check, status: 'fail', severity: runtime ? 'major' : 'minor', basis: 'deterministic', details: { reason: outcome.reason, rootCause: outcome.rootCause }, ...proof });
    } else push({ ...common, check: outcome.check, status: 'anomaly', severity: 'minor', basis: null, details: { reason: outcome.reason }, ...proof });
  }
  return results;
}
