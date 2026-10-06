import { elementOf, resetPage, targetFor } from './helpers.js';
import { classifyElementIntent, toClassifiable } from './intent.js';
import { clickAndObserve, notInteractable, prepareInteraction } from './interact.js';
import { capturePreActionSnapshot, traceOf } from './observer.js';
import { closeOpenedDialog } from './modal.js';
import { rememberControls, revealedContent, testReversibleControls } from './reversible.js';
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
    const decision = guard.check({ kind: 'click', name: b.name, text: b.text, selector: b.selector, role: b.role ?? undefined, href: b.href });
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
    const rawBox = (await c.locate({ css: b.selector }).boundingBox().catch(() => null)) ?? b.box ?? null;
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

    // A browser error here (timeout, interception, locator not resolving) is a test-runner event, not a result: the element's
    // real state decides whether it can be tested, is really obstructed, or cannot be judged.
    const ready = await prepareInteraction(ctx, target, b.selector);
    if (!ready.ok) {
      const result = notInteractable(BASE.kind, el, label, ready);
      ctx.onAction?.({
        phase: 'RESULT',
        type: result.check,
        target: label,
        ok: false,
        verdict: result.status === 'fail' ? 'FAIL' : result.status === 'skipped' ? 'BLOCKED' : 'NEEDS_REVIEW',
        confidence: result.confidence ?? 'MEDIUM',
        expected: result.expected,
        actual: result.actual,
        box,
      });
      push(result);
      continue;
    }

    if (!ctx.budget.consume()) break;

    const needScreenshot = Boolean(ctx.onAction || ctx.plan);

    // 3. Pre-Action Baseline Capture
    await rememberControls(c); // so the controls this click reveals can be told apart afterwards
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

    // 5. OBSERVING Phase (adaptive observation window)
    const { click: res, observation } = await clickAndObserve(ctx, ready, b.selector, pre, intent, {
      minWaitMs: 150,
      maxWaitMs: 1000,
      captureScreenshot: needScreenshot,
    });

    ctx.onAction?.({
      phase: 'OBSERVING',
      type: 'observe',
      target: label,
      ok: res.ok,
      box,
      intent,
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
    // An ENTRY control (it opens, shows or edits content) passes only on concrete proof that content was shown: a dialog,
    // newly visible fields/controls/headings, or another view. "Something changed" is not enough.
    const isEntry = typeof b.meta?.entry === 'string';
    const shown = res.ok ? await revealedContent(c) : null;
    const entryProof = observation.urlChanged ? `another view opened (${c.page.url()})`
      : shown && (shown.dialog || shown.controls + shown.headings > 0) ? `${shown.dialog ? 'a dialog' : 'new content'} was shown${shown.title ? ` ("${shown.title}")` : ''}: ${shown.controls} control(s), ${shown.headings} heading(s)`
      : observation.dialogs.opened.length > 0 ? 'a dialog opened' : null;
    if (isEntry && outcome.verdict === 'PASS' && !entryProof) {
      push({
        ...BASE, check: 'entry-open', status: 'inconclusive', severity: 'info', basis: null, element: el, confidence: 'LOW',
        expected: `"${label}" opens or shows content`, actual: `"${label}" was clicked, but no newly shown content (dialog, panel, fields or heading) could be identified`,
        details: { reason: outcome.reason, evidence: String(b.meta?.entryEvidence ?? '') }, ...proof,
      });
    } else if (isEntry && outcome.verdict === 'PASS') {
      push({
        ...BASE, check: 'entry-open', status: 'pass', severity: 'info', basis: null, element: el, confidence: 'HIGH',
        expected: `"${label}" opens or shows content`, actual: `"${label}" opened: ${entryProof}`, details: { evidence: String(b.meta?.entryEvidence ?? '') },
      });
    } else if (outcome.verdict === 'BLOCKED') {
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
      // The verifier only returns FAIL when the expected UI result did not happen: a HIGH-confidence expectation was not
      // met, a request failed, the element is obstructed, or nothing happened and the handler threw.
      push({
        ...BASE,
        check: outcome.check,
        status: 'fail',
        severity: 'major',
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
        // errors logged while the UI worked, and any recovery the click needed: diagnostics, not findings
        ...(outcome.details?.diagnostics || res.notes?.length ? { details: { ...outcome.details, reason: outcome.reason, interaction: res.notes } } : {}),
        durationMs: outcome.evidence?.durationMs,
        confidence: outcome.confidence,
      });
    }

    // 8. What the click revealed (a dialog, a panel, an editor): its safe, reversible controls are tested in place and
    // each is put back as it was. No button or link in there is clicked, so nothing is saved or confirmed.
    if (ctx.plan && res.ok && outcome.verdict !== 'BLOCKED' && outcome.verdict !== 'FAIL' && c.page.url() === pre.rawUrl) {
      const n = await testReversibleControls(ctx, push, { onlyNew: true, openedBy: label }).catch(() => 0);
      if (n > 0) pristine = false;
      // a dialog that this click opened is then closed with its own close control, and the closing is verified
      if ((shown?.dialog || observation.dialogs.opened.length > 0) && (await closeOpenedDialog(ctx, label, el, push).catch(() => false))) pristine = false;
    }
  }
  return results;
}
