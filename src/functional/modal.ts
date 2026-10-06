import { elementOf, resetPage, targetFor } from './helpers.js';
import { classifyElementIntent, toClassifiable } from './intent.js';
import { clickAndObserve, notInteractable, prepareInteraction } from './interact.js';
import { capturePreActionSnapshot, traceOf } from './observer.js';
import type { FunctionalContext, FunctionalResult } from './types.js';
import { verifyInteraction } from './verifier.js';

const BASE = { kind: 'modal' as const };
const CLOSE_MARK = 'data-qa-modal-close';

interface DialogState { open: number; modal: boolean; closeLabel: string | null }

/** Visible open dialogs, whether any of them is modal, and (optionally) tags a close control inside the top-most one. */
const DIALOG_STATE_SCRIPT = `((mark) => {
  const shown = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const open = Array.from(document.querySelectorAll('dialog[open], [role=dialog]:not([hidden]), [role=alertdialog]:not([hidden]), [aria-modal=true]:not([hidden])')).filter(shown);
  const modal = open.some((d) => d.getAttribute('aria-modal') === 'true' || (d.tagName === 'DIALOG' && d.matches(':modal')));
  let closeLabel = null;
  document.querySelectorAll('[' + mark + ']').forEach((e) => e.removeAttribute(mark));
  const top = open[open.length - 1];
  if (top) {
    const label = (e) => (e.getAttribute('aria-label') || e.innerText || e.textContent || e.getAttribute('title') || '').replace(/\\s+/g, ' ').trim();
    const btn = Array.from(top.querySelectorAll('button, [role=button], a, input[type=button]')).filter(shown)
      .find((e) => /^(close|cancel|dismiss|done|ok|okay|got it|no thanks|×|✕|x)$/i.test(label(e)) || /close|dismiss/i.test(e.getAttribute('aria-label') || '') || /close/i.test(String(e.className)));
    if (btn) { btn.setAttribute(mark, '1'); closeLabel = label(btn) || 'close'; }
  }
  return { open: open.length, modal, closeLabel };
})`;

/**
 * Modal scenario: open -> verify visible -> close with the dialog's close control -> verify closed.
 * Opening is judged by the existing observer/verifier. "Does not open" is a defect only for a declared trigger
 * (aria-haspopup with a dialog in the DOM); a guessed trigger that opens nothing goes to review.
 */
export async function testModals(ctx: FunctionalContext): Promise<FunctionalResult[]> {
  const { controller: c, guard, model } = ctx;
  const results: FunctionalResult[] = [];
  const state = (): Promise<DialogState> => c.page.evaluate(`${DIALOG_STATE_SCRIPT}(${JSON.stringify(CLOSE_MARK)})`) as Promise<DialogState>;
  const shot = (): Promise<Buffer | undefined> => c.page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => undefined);

  for (const { trigger: b, scenario } of ctx.plan?.modals ?? []) {
    if (ctx.budget.exhausted) break;
    const el = elementOf(b);
    const label = b.name || b.text || b.selector;
    const push = (r: FunctionalResult): void => { const x = { ...r, scenario }; results.push(x); ctx.onResult?.(x); };
    const decision = guard.check({ kind: 'click', name: b.name, text: b.text, selector: b.selector, role: b.role ?? undefined });
    if (!decision.allowed) {
      push({ ...BASE, check: 'guard', status: 'skipped', severity: 'info', basis: null, element: el, expected: 'Safe modal triggers are tested', actual: `Not clicked: ${decision.reason}`, details: { guard: decision } });
      continue;
    }
    if (!(await resetPage(ctx))) break;
    if (!ctx.budget.consume(2)) break;

    const intent = { ...classifyElementIntent(toClassifiable(b), model), confidence: scenario.confidence };
    const rawBox = (await c.locate({ css: b.selector }).boundingBox().catch(() => null)) ?? b.box;
    const box = rawBox ? { ...rawBox, vpWidth: c.viewport.width, vpHeight: c.viewport.height } : null;
    ctx.onAction?.({ phase: 'TARGETED', type: 'target', target: label, ok: true, box, intent, expected: intent.expectedOutcome.description });

    // ---- open
    const ready = await prepareInteraction(ctx, targetFor(b, model.buttons), b.selector);
    if (!ready.ok) { push(notInteractable(BASE.kind, el, label, ready)); continue; }
    const before = await state();
    const pre = await capturePreActionSnapshot(c, b.selector, { captureScreenshot: true });
    const { click, observation } = await clickAndObserve(ctx, ready, b.selector, pre, intent, { minWaitMs: 200, maxWaitMs: 1200, captureScreenshot: true });
    const outcome = verifyInteraction({ intent, observation, clickResult: click, elementLabel: label, selector: b.selector });
    ctx.onAction?.({
      phase: 'RESULT', type: outcome.check, target: label, ok: outcome.verdict === 'PASS', verdict: outcome.verdict, confidence: outcome.confidence,
      expected: outcome.expected, actual: outcome.actual, detail: outcome.reason, box, buffer: observation.screenshot, durationMs: observation.durationMs,
    });
    const openProof = { before: pre.screenshot, screenshot: observation.screenshot, trace: traceOf(`click "${label}"`, observation) };
    const common = { ...BASE, element: el, expected: outcome.expected, actual: outcome.actual, confidence: outcome.confidence, durationMs: observation.durationMs };
    if (outcome.verdict === 'BLOCKED') { push({ ...common, check: outcome.check, status: 'blocked', severity: 'info', basis: null, ...openProof }); continue; }
    if (outcome.verdict === 'FAIL') { push({ ...common, check: outcome.check, status: 'fail', severity: 'major', basis: 'deterministic', details: { reason: outcome.reason, rootCause: outcome.rootCause }, ...openProof }); continue; }
    if (outcome.verdict === 'NEEDS_REVIEW') { push({ ...common, check: outcome.check, status: 'anomaly', severity: 'minor', basis: null, details: { reason: outcome.reason }, ...openProof }); continue; }
    push({ ...common, check: outcome.check, status: 'pass', severity: 'info', basis: null });

    const opened = await state();
    if (opened.open <= before.open) continue; // a menu/popup rather than a dialog: nothing to close

    // ---- close: with the dialog's own close control. Keyboard behaviour is not part of UI/UX testing: Escape is only
    // pressed afterwards, if the dialog has no close control, to leave the page clean. It never produces a result.
    const openShot = observation.screenshot;
    const closeExpected = `Dialog opened by "${label}" can be closed with its close control`;
    if (!opened.closeLabel) { await c.press('Escape').catch(() => undefined); continue; }
    const closeLabel = opened.closeLabel;
    const closeGuard = guard.check({ kind: 'click', name: closeLabel, text: closeLabel, selector: `[${CLOSE_MARK}]` });
    if (!closeGuard.allowed) {
      push({ ...BASE, check: 'guard', status: 'skipped', severity: 'info', basis: null, element: el, expected: closeExpected, actual: `Close control "${closeLabel}" not clicked: ${closeGuard.reason}`, details: { guard: closeGuard } });
      continue;
    }
    const closeClick = await c.click({ css: `[${CLOSE_MARK}="1"]` });
    await c.settle(250);
    const now = await state();
    const closedShot = await shot();
    ctx.onAction?.({ type: 'click', target: closeLabel, ok: closeClick.ok && now.open < opened.open, detail: closeClick.error, buffer: closedShot });
    if (closeClick.ok && now.open >= opened.open) {
      push({
        ...BASE, check: 'modal-close', status: 'fail', severity: 'major', basis: 'deterministic', element: el, confidence: 'HIGH', expected: closeExpected,
        actual: `Dialog stayed open after clicking its close control "${closeLabel}"`, before: openShot, screenshot: closedShot,
        details: { reason: 'The dialog offers a close control, the click on it succeeded, and the dialog is still shown' },
        trace: { action: `click "${closeLabel}"`, network: [], console: [], changes: ['dialog still open'] },
      });
      await c.press('Escape').catch(() => undefined);
    } else if (now.open < opened.open) {
      push({ ...BASE, check: 'modal-close', status: 'pass', severity: 'info', basis: null, element: el, expected: closeExpected, actual: `Dialog closed with its "${closeLabel}" control` });
    }
  }
  return results;
}
