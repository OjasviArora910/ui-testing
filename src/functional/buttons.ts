import { inspectDialog, resolveUnexpectedDialog } from './sensitive.js';
import { elementOf, resetPage, targetFor } from './helpers.js';
import { classifyElementIntent, toClassifiable } from './intent.js';
import { clickAndObserve, notInteractable, prepareInteraction } from './interact.js';
import { capturePreActionSnapshot, traceOf } from './observer.js';
import { closeRevealed, exploreState, newExploration } from './explorer.js';
import { closeOpenedDialog } from './modal.js';
import { rememberControls, revealedContent } from './reversible.js';
import { buildPageModel } from '../discovery/pageModel.js';
import { collectRuleContext } from '../rules/context.js';
import { buildRegistry } from '../rules/index.js';
import type { FunctionalContext, FunctionalResult } from './types.js';
import { verifyInteraction } from './verifier.js';

import { inspectCurrentUI } from './audit.js';
export { inspectCurrentUI };

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

  let needsReset = false;
  for (const { element: planned, scenario } of items) {
    if (ctx.budget.exhausted) break;
    const push = (r: FunctionalResult): void => { const x = scenario ? { ...r, scenario } : r; results.push(x); ctx.onResult?.(x); };
    // Re-read the rendered page before every target. A previous action may have replaced,
    // hidden, or moved controls; the original page model is only a planning hint.
    const current = await buildPageModel(c).catch(() => null);
    const live = current?.interactive.find((x) => x.selector === planned.selector);
    if (current && !live) {
      push({ ...BASE, check: 'visibility', status: 'skipped', severity: 'info', basis: null, element: elementOf(planned), expected: 'Current-page controls are tested', actual: 'Control is no longer in the rendered DOM; not tested' });
      continue;
    }
    const b = live ?? planned;
    const el = elementOf(b);
    const label = b.name || b.text || b.selector;
    const intent = classifyElementIntent(toClassifiable(b), model);

    // 0. Safety Guard check
    const entryAction = typeof b.meta?.entryAction === 'string' ? b.meta.entryAction : null;
    const decision = entryAction
      ? guard.check({ kind: 'click', name: entryAction, role: 'entry' })
      : guard.check({ kind: 'click', name: b.name, text: b.text, selector: b.selector, role: b.role ?? undefined, href: b.href });
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

    if (!b.visible || !b.enabled) {
      push({ ...BASE, check: 'visibility', status: 'skipped', severity: 'info', basis: null, element: el, expected: 'Visible', actual: 'Not visible; not tested' });
      continue;
    }
    if (!b.enabled) {
      push({ ...BASE, check: 'enabled-state', status: 'pass', severity: 'info', basis: null, element: el, expected: 'Disabled button is exposed as disabled', actual: 'Button is disabled' });
      continue;
    }
    if (needsReset) {
      if (!(await resetPage(ctx))) break;
      needsReset = false;
    }

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
    const postScrollRawBox = (await c.locate({ css: b.selector }).boundingBox().catch(() => null)) ?? rawBox;
    const activeBox = postScrollRawBox ? { ...postScrollRawBox, vpWidth: c.viewport.width, vpHeight: c.viewport.height } : box;

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
        box: activeBox,
      });
      push(result);
      continue;
    }

    if (!ctx.budget.consume()) break;

    const needScreenshot = Boolean(ctx.onAction || ctx.plan);

    // 3. Pre-Action Baseline Capture
    await rememberControls(c); // so the controls this click reveals can be told apart afterwards
    const dialogBefore = (await inspectDialog(c))?.key ?? null;
    const pre = await capturePreActionSnapshot(c, b.selector, { captureScreenshot: needScreenshot });

    // 4. CLICKING Phase
    ctx.onAction?.({
      phase: 'CLICKING',
      type: 'click',
      target: label,
      ok: true,
      box: activeBox,
      intent,
      buffer: pre.screenshot,
    });

    // Brief settling pause allowing UI simulation to reflect the click state in real time
    await new Promise((r) => setTimeout(r, 50));

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
      box: activeBox,
      intent,
      buffer: observation.screenshot,
    });

    // 6. VERIFYING Phase
    ctx.onAction?.({
      phase: 'VERIFYING',
      type: 'verify',
      target: label,
      ok: true,
      box: activeBox,
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
      box: activeBox,
      buffer: observation.screenshot,
      durationMs: outcome.evidence?.durationMs,
    });

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
      // 7b. Run generic UI/UX inspection on the verified rendered state
      await inspectCurrentUI(ctx, label, push);
    }

    // A warning / confirmation / security dialog that this click brought up is not a state to explore: it is identified,
    // dismissed only through its negative control (nothing affirmative is ever clicked), and recorded.
    const surprise = res.ok ? await resolveUnexpectedDialog(ctx, dialogBefore).catch(() => null) : null;
    if (surprise) {
      push({ ...BASE, check: 'unexpected-dialog', status: 'inconclusive', severity: 'info', basis: null, element: el, confidence: 'LOW',
        expected: `Activating "${label}" does not require confirming a sensitive operation`,
        actual: `After clicking "${label}", an unexpected ${surprise.dialog.type} dialog appeared ("${surprise.dialog.text.slice(0, 120)}"; buttons: ${surprise.dialog.buttons.join(', ') || 'none'}); ${surprise.how}. Nothing was confirmed`,
        screenshot: observation.screenshot });
      continue;
    }

    // 8. What the click revealed (a dialog, a panel, an editor): its safe, reversible controls are tested in place and
    // each is put back as it was. No button or link in there is clicked, so nothing is saved or confirmed.
    if (ctx.plan && res.ok && outcome.verdict !== 'BLOCKED' && outcome.verdict !== 'FAIL' && c.page.url() === pre.rawUrl) {
      // The revealed UI is a state: its reversible controls are tested and restored, and its tabs, expandable sections and
      // menus are followed to the states they lead to (bounded, de-duplicated), each restored afterwards.
      const run = newExploration();
      await exploreState(ctx, push, run, [label]).catch(() => false);
      if (run.visited.size > 0) {
        ctx.onAction?.({ type: 'explored', target: label, ok: true, detail: `${run.visited.size} state(s): ${run.states.join(' | ').slice(0, 600)}` });
      }
      // a dialog that this click opened is then closed with its own close control, and the closing is verified
      let closed = false;
      if (shown?.dialog || observation.dialogs.opened.length > 0) {
        closed = await closeOpenedDialog(ctx, label, el, push).catch(() => false);
      } else if (run.visited.size > 0) {
        closed = await closeRevealed(ctx).catch(() => false);
      }
      if (!closed && (shown?.dialog || run.visited.size > 0 || (shown && (shown.controls > 0 || shown.headings > 0)))) {
        await c.press('Escape').catch(() => undefined);
        await c.settle(150);
        const stillShown = await revealedContent(c).catch(() => null);
        if (stillShown && (stillShown.dialog || stillShown.controls > 0 || stillShown.headings > 0)) {
          needsReset = true;
        }
      }
    } else if (c.page.url() !== pre.rawUrl) {
      const back = await c.page.goBack().catch(() => null);
      await c.settle(200);
      if (c.page.url() !== pre.rawUrl) {
        needsReset = true;
      }
    }
    if ((intent.kind === 'PAGINATE' || intent.kind === 'SWITCH_TAB') && outcome.verdict === 'PASS' && outcome.check !== 'already-active') {
      needsReset = true;
    }
  }
  return results;
}
