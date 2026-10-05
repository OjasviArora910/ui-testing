import { coveredBy, elementOf, resetPage, targetFor } from './helpers.js';
import { classifyElementIntent, toClassifiable } from './intent.js';
import { capturePreActionSnapshot, observeAction, traceOf } from './observer.js';
import type { FunctionalContext, FunctionalResult } from './types.js';
import { verifyInteraction } from './verifier.js';

const BASE = { kind: 'button' as const };

/** Tests visibility, enabled state, clickability and real behavioral outcome of each safe button. */
export async function testButtons(ctx: FunctionalContext): Promise<FunctionalResult[]> {
  const { controller: c, guard, model, config } = ctx;
  const results: FunctionalResult[] = [];
  const submitSelectors = new Set(model.forms.map((f) => f.form.submit?.selector).filter(Boolean));
  // With a TestPlan only the controls it selected are exercised; without one, the first N buttons (legacy behaviour).
  const items = ctx.plan
    ? ctx.plan.buttons
    : model.buttons.filter((b) => !submitSelectors.has(b.selector)).slice(0, config.functional.maxButtonsPerPage).map((element) => ({ element, scenario: undefined }));

  let pristine = false; // true while the page is exactly as loaded
  for (const { element: b, scenario } of items) {
    if (ctx.budget.exhausted) break;
    const push = (r: FunctionalResult): void => { const x = scenario ? { ...r, scenario } : r; results.push(x); ctx.onResult?.(x); };
    const el = elementOf(b);
    const label = b.name || b.text || b.selector;
    const intent = classifyElementIntent(toClassifiable(b), model);

    // 0. Safety Guard check
    const decision = guard.check({ kind: 'click', name: b.name, text: b.text, selector: b.selector, role: b.role ?? undefined });
    if (!decision.allowed) {
      ctx.onAction?.({
        phase: 'RESULT',
        type: 'guard',
        target: label,
        ok: false,
        verdict: 'BLOCKED',
        confidence: 'HIGH',
        expected: 'Safe actions are tested',
        actual: `Action blocked by safety guard: ${decision.reason}`,
        detail: decision.reason,
        intent,
      });
      push({
        ...BASE,
        check: 'guard',
        status: 'skipped',
        severity: 'info',
        basis: null,
        element: el,
        expected: 'Safe buttons are tested',
        actual: `Not clicked: ${decision.reason}`,
        details: { guard: decision },
      });
      continue;
    }

    if (!b.visible) {
      push({ ...BASE, check: 'visibility', status: 'skipped', severity: 'info', basis: null, element: el, expected: 'Visible', actual: 'Not visible; not tested' });
      continue;
    }
    if (!b.enabled) {
      push({ ...BASE, check: 'enabled-state', status: 'pass', severity: 'info', basis: null, element: el, expected: 'Disabled button is exposed as disabled', actual: 'Button is disabled' });
      continue;
    }
    if (!pristine && !(await resetPage(ctx))) break;
    pristine = false;

    const target = targetFor(b, [...model.buttons, ...model.tabs, ...model.checkboxes]);
    const loc = c.locate(target);
    const rawBox = (await loc.boundingBox().catch(() => null)) ?? b.box ?? null;
    const box = rawBox ? { ...rawBox, vpWidth: c.viewport.width, vpHeight: c.viewport.height } : null;

    // 1. TARGETED Phase
    ctx.onAction?.({
      phase: 'TARGETED',
      type: 'target',
      target: label,
      ok: true,
      box,
      intent,
      expected: intent.expectedOutcome.description,
    });

    // 2. MOVING Phase (scroll & trial click)
    ctx.onAction?.({
      phase: 'MOVING',
      type: 'move',
      target: label,
      ok: true,
      box,
      intent,
    });

    try {
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
      await loc.click({ trial: true, timeout: 3000 });
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).split('\n')[0]!;
      const covered = /intercepts pointer events/i.test(msg);
      const cover = covered ? await coveredBy(ctx, b.selector) : null;
      const hard = covered && !cover?.floating;
      const actualDesc = c.redactor.redact(
        covered
          ? `${cover ? `<${cover.description}>` : 'Another element'} covers the button${cover?.floating ? ' (floating/overlay UI, needs review)' : ''}: ${msg.slice(0, 160)}`
          : `Not clickable: ${msg.slice(0, 200)}`,
      );

      ctx.onAction?.({
        phase: 'RESULT',
        type: 'clickable',
        target: label,
        ok: false,
        verdict: hard ? 'FAIL' : 'NEEDS_REVIEW',
        confidence: 'HIGH',
        expected: `Button "${label}" can be clicked`,
        actual: actualDesc,
        box,
      });

      push({
        ...BASE,
        check: 'clickable',
        status: hard ? 'fail' : 'anomaly',
        severity: hard ? 'major' : 'minor',
        basis: hard ? 'deterministic' : null,
        element: el,
        expected: `Button "${label}" can be clicked`,
        actual: actualDesc,
      });
      continue;
    }

    if (!ctx.budget.consume()) break;

    const needScreenshot = Boolean(ctx.onAction || ctx.plan);

    // 3. Pre-Action Baseline Capture
    const pre = await capturePreActionSnapshot(c, b.selector, { captureScreenshot: needScreenshot });

    // 4. CLICKING Phase
    ctx.onAction?.({
      phase: 'CLICKING',
      type: 'click',
      target: label,
      ok: true,
      box,
      intent,
      buffer: pre.screenshot,
    });

    const res = await c.click(target);

    // 5. OBSERVING Phase (adaptive observation window)
    ctx.onAction?.({
      phase: 'OBSERVING',
      type: 'observe',
      target: label,
      ok: res.ok,
      box,
      intent,
    });

    const observation = await observeAction(ctx, pre, intent, {
      minWaitMs: 150,
      maxWaitMs: 1000,
      captureScreenshot: needScreenshot,
    });

    // 6. VERIFYING Phase
    ctx.onAction?.({
      phase: 'VERIFYING',
      type: 'verify',
      target: label,
      ok: true,
      box,
      intent,
      buffer: observation.screenshot,
    });

    const outcome = verifyInteraction({
      intent,
      observation,
      clickResult: res,
      elementLabel: label,
      selector: b.selector,
    });

    // 7. RESULT Phase
    ctx.onAction?.({
      phase: 'RESULT',
      type: outcome.check,
      target: label,
      ok: outcome.verdict === 'PASS',
      verdict: outcome.verdict,
      confidence: outcome.confidence,
      expected: outcome.expected,
      actual: outcome.actual,
      detail: outcome.reason,
      box,
      buffer: observation.screenshot,
      durationMs: outcome.evidence?.durationMs,
    });

    // Nothing at all happened: the page is still as loaded and the next control can be tested without reloading.
    pristine = outcome.verdict === 'NEEDS_REVIEW' && !observation.urlChanged && (observation.stateChanges ?? []).length === 0 && observation.dialogs.opened.length === 0 && observation.network.requests.length === 0;

    // Translate verification outcome into functional result
    const proof = { before: pre.screenshot, screenshot: observation.screenshot, trace: traceOf(`click "${label}"`, observation) };
    if (outcome.verdict === 'BLOCKED') {
      push({
        ...BASE,
        check: outcome.check,
        status: 'blocked',
        severity: 'info',
        basis: null,
        element: el,
        expected: outcome.expected,
        actual: outcome.actual,
        details: { reason: outcome.reason },
        confidence: outcome.confidence,
        ...proof,
      });
    } else if (outcome.verdict === 'FAIL') {
      // The verifier only returns FAIL on hard runtime evidence or when a HIGH-confidence expectation was not met.
      // A console.error line alone is a warning-level signal.
      const isMajor = outcome.check !== 'console-error';
      push({
        ...BASE,
        check: outcome.check,
        status: 'fail',
        severity: isMajor ? 'major' : 'minor',
        basis: 'deterministic',
        element: el,
        expected: outcome.expected,
        actual: outcome.actual,
        details: { reason: outcome.reason, rootCause: outcome.rootCause, confidence: outcome.confidence },
        durationMs: outcome.evidence?.durationMs,
        confidence: outcome.confidence,
        ...proof,
      });
    } else if (outcome.verdict === 'NEEDS_REVIEW') {
      push({
        ...BASE,
        check: outcome.check,
        status: 'anomaly',
        severity: 'minor',
        basis: null,
        element: el,
        expected: outcome.expected,
        actual: outcome.actual,
        details: { reason: outcome.reason, confidence: outcome.confidence },
        durationMs: outcome.evidence?.durationMs,
        confidence: outcome.confidence,
        ...proof,
      });
    } else {
      push({
        ...BASE,
        check: outcome.check,
        status: 'pass',
        severity: 'info',
        basis: null,
        element: el,
        expected: outcome.expected,
        actual: outcome.actual,
        durationMs: outcome.evidence?.durationMs,
        confidence: outcome.confidence,
      });
    }
  }
  return results;
}
