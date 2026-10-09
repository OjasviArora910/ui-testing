import { controlContext } from './sensitive.js';
import type { RawField } from '../browser/types.js';
import type { ModelElement } from '../discovery/types.js';
import { elementOf, resetPage } from './helpers.js';
import { validValue } from './synthetic.js';
import type { FunctionalContext, FunctionalResult } from './types.js';

const BASE = { kind: 'interactive' as const };
const NOT_TYPEABLE = new Set(['file', 'hidden', 'image', 'button', 'submit', 'reset', 'range', 'color']);

interface FieldState { value: string; checked: boolean; readOnly: boolean; options: { value: string; disabled: boolean }[]; type: string }

const STATE_SCRIPT = `((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  return {
    value: el.value === undefined || el.value === null ? '' : String(el.value), checked: el.checked === true,
    readOnly: el.readOnly === true || el.getAttribute('aria-readonly') === 'true', type: (el.getAttribute('type') || el.tagName).toLowerCase(),
    options: el.tagName === 'SELECT' ? Array.from(el.options).map((o) => ({ value: o.value, disabled: o.disabled })) : [],
  };
})`;

function asField(el: ModelElement): RawField {
  const type = typeof el.meta?.inputType === 'string' && el.meta.inputType ? el.meta.inputType : el.type === 'textarea' ? 'textarea' : 'text';
  return { selector: el.selector, tag: String(el.meta?.tag ?? 'input'), type, name: el.name, label: el.name, placeholder: '', required: !!el.required, visible: el.visible, disabled: !el.enabled };
}

/**
 * Form controls are exercised one by one and each is verified on ITS OWN state: a text field must hold what was typed,
 * a select must show the chosen option, a checkbox/radio must change its checked state. Nothing is submitted.
 * A control that takes the value is silent (EXPECTED). One that demonstrably does not is a defect.
 */
export async function testFields(ctx: FunctionalContext): Promise<FunctionalResult[]> {
  const { controller: c, guard } = ctx;
  const results: FunctionalResult[] = [];
  const items = ctx.plan?.fields ?? [];
  if (items.length === 0 || !(await resetPage(ctx))) return results;
  const state = (selector: string): Promise<FieldState | null> => (c.page.evaluate(`${STATE_SCRIPT}(${JSON.stringify(selector)})`) as Promise<FieldState | null>).catch(() => null);
  const shot = (): Promise<Buffer | undefined> => c.page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => undefined);

  for (const { element: el, scenario } of items) {
    if (ctx.budget.exhausted) break;
    const label = el.name || el.selector;
    const ref = elementOf(el);
    const push = (r: FunctionalResult): void => { const x = { ...r, scenario }; results.push(x); ctx.onResult?.(x); };
    const kind = el.type === 'select' ? 'select' : el.type === 'checkbox' || el.type === 'radio' ? 'check' : 'fill';
    const decision = guard.check({ kind, selector: el.selector, name: el.name, fieldName: el.name, fieldType: String(el.meta?.inputType ?? el.type), ...(await controlContext(c, el.selector)) });
    if (!decision.allowed) {
      push({ ...BASE, check: 'guard', status: 'skipped', severity: 'info', basis: null, element: ref, expected: 'Safe form controls are exercised', actual: `Not used: ${decision.reason}`, details: { guard: decision } });
      continue;
    }
    const before = await state(el.selector);
    if (!before || !el.visible || !el.enabled) continue; // gone, hidden or disabled: nothing to operate
    if (!ctx.budget.consume()) break;
    const urlBefore = c.page.url();
    const beforeShot = await shot();
    const target = { css: el.selector };
    let action = ''; let expected = ''; let ok = false; let actual = ''; let error: string | undefined;

    if (kind === 'select') {
      const choice = before.options.find((o) => !o.disabled && o.value !== before.value && o.value !== '') ?? before.options.find((o) => !o.disabled && o.value !== before.value);
      if (!choice) continue; // a single option: nothing to choose
      action = `choose option "${choice.value}" in "${label}"`; expected = `"${label}" shows the chosen option`;
      const r = await c.select(target, choice.value); error = r.error;
      const after = await state(el.selector);
      ok = r.ok && after?.value === choice.value;
      actual = ok ? `Option "${choice.value}" is selected` : `Chose "${choice.value}" but the control shows "${after?.value ?? '(gone)'}"`;
    } else if (kind === 'check') {
      if (el.type === 'radio' && before.checked) continue; // an already-selected radio cannot be toggled by itself
      action = `${before.checked ? 'untick' : 'tick'} "${label}"`; expected = `"${label}" becomes ${before.checked ? 'unchecked' : 'checked'}`;
      const r = before.checked ? await c.uncheck(target) : await c.check(target); error = r.error;
      const after = await state(el.selector);
      ok = r.ok && !!after && after.checked !== before.checked;
      actual = ok ? `"${label}" is now ${after!.checked ? 'checked' : 'unchecked'}` : `"${label}" stayed ${before.checked ? 'checked' : 'unchecked'}`;
    } else {
      if (before.readOnly || NOT_TYPEABLE.has(before.type)) continue;
      const value = validValue(asField(el));
      action = `type into "${label}"`; expected = `"${label}" holds the text that was typed`;
      const r = await c.fill(target, value); error = r.error;
      const after = await state(el.selector);
      // masks and formatters may reshape the text; the field must simply not stay empty/unchanged
      ok = r.ok && !!after && after.value !== '' && (after.value !== before.value || before.value === value);
      actual = ok ? 'The field accepted the text' : `Typed text but the field still contains "${(after?.value ?? '').slice(0, 40)}"`;
    }
    await c.settle(80);
    const navigated = c.page.url().replace(/#.*$/, '') !== urlBefore.replace(/#.*$/, '');
    ctx.onAction?.({ type: kind, target: label, ok, detail: error ?? actual });

    if (ok) push({ ...BASE, check: `field-${kind}`, status: 'pass', severity: 'info', basis: null, element: ref, expected, actual, confidence: 'HIGH' });
    else {
      const proof = { before: beforeShot, screenshot: await shot(), trace: { action, urlBefore, urlAfter: c.page.url(), network: [], console: [], changes: [actual, ...(error ? [`browser: ${error}`] : [])] } };
      // The browser could not operate the control at all (covered, detached, custom widget): that is not proof the control is broken.
      if (error) push({ ...BASE, check: `field-${kind}`, status: 'anomaly', severity: 'minor', basis: null, element: ref, expected, actual: `Could not ${action}: ${error.slice(0, 160)}`, confidence: 'MEDIUM', ...proof });
      else push({ ...BASE, check: `field-${kind}`, status: 'fail', severity: 'major', basis: 'deterministic', element: ref, expected, actual, confidence: 'HIGH', details: { reason: 'The control was operated successfully but its own state did not change accordingly' }, ...proof });
    }
    if (navigated && !(await resetPage(ctx))) break; // e.g. a select that changes the page
  }
  return results;
}
