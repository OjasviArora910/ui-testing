import type { BrowserController } from '../browser/index.js';
import type { RawField } from '../browser/types.js';
import { domSignature, newLines, pageText, resetPage, VALIDATION_TEXT } from './helpers.js';
import { invalidValue, isPaymentField, validValue } from './synthetic.js';
import type { ActionTrace, FunctionalContext, FunctionalResult } from './types.js';
import type { RawForm } from '../browser/types.js';

const BASE = { kind: 'form' as const };

interface SubmitObservation {
  /** A network write (or navigation) was attempted by the page. */
  attempted: boolean;
  navigated: boolean;
  nativeBlocked: boolean;
  validationMessages: string[];
  feedbackText: string[];
  invalidAria: number;
  jsErrors: string[];
  consoleErrors: string[];
  failedRequests: string[];
  errorPage: number | null;
  domChanged: boolean;
  /** Requests this submission tried to send that ActionGuard aborted. */
  blockedByGuard: string[];
  screenshot?: Buffer;
  before?: Buffer;
  trace: ActionTrace;
}

async function fillField(c: BrowserController, f: RawField, value: string): Promise<boolean> {
  if (f.disabled || !f.visible) return false;
  const t = { css: f.selector };
  const r = f.type === 'checkbox' || f.type === 'radio' ? await c.check(t)
    : f.tag === 'select' ? await c.select(t, f.options?.find((o) => o !== '') ?? value)
    : f.type === 'file' ? { ok: true } : await c.fill(t, value);
  return r.ok;
}

/** Fills every visible field (valid synthetic data), optionally overriding one field with an invalid value. */
async function fillForm(ctx: FunctionalContext, form: RawForm, override?: { selector: string; value: string }): Promise<void> {
  for (const f of form.fields) {
    if (!ctx.budget.consume()) return;
    const value = override?.selector === f.selector ? override.value : validValue(f);
    const loc = ctx.controller.locate({ css: f.selector });
    const rawBox = await loc.boundingBox().catch(() => null);
    const box = rawBox ? { ...rawBox, vpWidth: ctx.controller.viewport.width, vpHeight: ctx.controller.viewport.height } : null;
    const ok = await fillField(ctx.controller, f, value);
    const buf = await ctx.controller.page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => undefined);
    ctx.onAction?.({ type: 'fill', target: f.name || f.selector, ok, box, buffer: buf });
  }
}

async function submitAndObserve(ctx: FunctionalContext, form: RawForm): Promise<SubmitObservation | null> {
  const c = ctx.controller;
  if (!ctx.budget.consume()) return null;
  const n0 = c.events.network.length; const k0 = c.events.console.length; const b0 = c.blockedRequests.length;
  const textBefore = await pageText(ctx); const sigBefore = await domSignature(ctx);
  const urlBefore = c.page.url();
  const before = ctx.onAction || ctx.plan ? await c.page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => undefined) : undefined;
  const submitSel = form.submit?.selector;
  const rawBox = submitSel ? await c.locate({ css: submitSel }).boundingBox().catch(() => null) : null;
  const box = rawBox ? { ...rawBox, vpWidth: c.viewport.width, vpHeight: c.viewport.height } : null;
  const res = submitSel ? await c.click({ css: submitSel }) : await c.press('Enter', { css: form.fields[0]?.selector ?? form.selector });
  await c.settle(250);
  const buf = await c.page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => undefined);
  ctx.onAction?.({ type: 'submit', target: form.name || form.selector, ok: res.ok, detail: res.error, box, buffer: buf });

  const info = await c.page.evaluate(`((sel) => {
    const f = document.querySelector(sel);
    if (!f) return { gone: true, invalid: false, messages: [], aria: 0 };
    const bad = Array.from(f.elements).filter(e => e.willValidate && !e.validity.valid);
    return { gone: false, invalid: !f.noValidate && bad.length > 0, messages: bad.map(e => e.validationMessage).filter(Boolean), aria: f.querySelectorAll('[aria-invalid="true"]').length + document.querySelectorAll('[role=alert]').length };
  })(${JSON.stringify(form.selector)})`) as { gone: boolean; invalid: boolean; messages: string[]; aria: number };

  const net = c.events.network.slice(n0); const con = c.events.console.slice(k0);
  const doc = net.filter((n) => n.resourceType === 'document').pop();
  const navigated = c.page.url() !== urlBefore;
  const blockedByGuard = c.blockedRequests.slice(b0).map((b) => `${b.method} ${b.url}`);
  const feedbackText = newLines(textBefore, await pageText(ctx)).filter((l) => VALIDATION_TEXT.test(l));
  const trace: ActionTrace = {
    action: `submit form "${form.name || form.selector}"`, urlBefore, urlAfter: c.page.url(),
    network: [...net.filter((n) => !n.ignored && !n.blockedByGuard && n.resourceType !== 'image').slice(0, 20).map((n) => `${n.method} ${n.url} -> ${n.status ?? n.failure ?? 'pending'}`), ...blockedByGuard.map((b) => `${b} -> blocked by ActionGuard`)],
    console: con.filter((x) => x.kind === 'pageerror' || x.level === 'error').map((x) => `${x.kind === 'pageerror' ? 'uncaught' : 'console.error'}: ${x.text}`),
    changes: [...(navigated ? [`url: ${urlBefore} -> ${c.page.url()}`] : []), ...info.messages.map((m) => `validation: ${m}`), ...feedbackText.map((t) => `feedback text: ${t}`)],
  };
  return {
    attempted: c.blockedRequests.length > b0 || net.some((n) => n.method !== 'GET') || navigated,
    navigated, nativeBlocked: info.invalid, validationMessages: info.messages,
    feedbackText,
    invalidAria: info.aria,
    jsErrors: con.filter((x) => x.kind === 'pageerror').map((x) => x.text),
    consoleErrors: con.filter((x) => x.level === 'error' && x.kind === 'console' && !/Failed to load resource/i.test(x.text)).map((x) => x.text),
    failedRequests: net.filter((n) => !n.ok && !n.ignored && !n.blockedByGuard).map((n) => `${n.method} ${n.url} ${n.status ?? n.failure}`),
    errorPage: doc?.status && doc.status >= 400 ? doc.status : null,
    domChanged: sigBefore !== (await domSignature(ctx)),
    blockedByGuard, screenshot: buf, before, trace,
  };
}

const hasFeedback = (o: SubmitObservation): boolean => o.nativeBlocked || o.feedbackText.length > 0 || o.invalidAria > 0;

export async function testForms(ctx: FunctionalContext): Promise<FunctionalResult[]> {
  const { controller: c, guard, model, config } = ctx;
  const results: FunctionalResult[] = [];
  // With a TestPlan only forms it classified as login/submission forms are submitted (search boxes and loose inputs are not).
  const planned = ctx.plan ? new Map(ctx.plan.forms.map((f) => [f.selector, f])) : null;
  const forms = model.forms.filter((f) => f.visible && f.form.fields.length > 0 && (!planned || planned.has(f.form.selector))).slice(0, config.functional.maxFormsPerPage);

  for (const fm of forms) {
    if (ctx.budget.exhausted) break;
    const form = fm.form;
    const entry = planned?.get(form.selector);
    const login = entry?.mode === 'login';
    const push = (r: FunctionalResult): void => { const x = entry ? { ...r, scenario: entry.scenario } : r; results.push(x); ctx.onResult?.(x); };
    const proof = (o: SubmitObservation): Pick<FunctionalResult, 'screenshot' | 'before' | 'trace'> => ({ screenshot: o.screenshot, before: o.before, trace: o.trace });
    const label = form.name || form.selector;
    const el = { selector: form.selector, role: 'form', name: label.slice(0, 80), box: fm.box };
    const gd = guard.check({ kind: 'submit', selector: form.selector, name: form.name, text: form.submit?.text, formAction: form.action, method: form.method });
    const paymentField = form.fields.find(isPaymentField);
    if (!gd.allowed || paymentField) {
      push({ ...BASE, check: 'guard', status: 'skipped', severity: 'info', basis: null, element: el, expected: 'Safe forms are tested', actual: `Form "${label}" not submitted: ${gd.allowed ? 'payment-related field' : gd.reason}`, details: { guard: gd } });
      continue;
    }

    // ---- empty submission
    const required = form.fields.filter((f) => f.required && f.visible && !f.disabled);
    if (required.length > 0) {
      if (!(await resetPage(ctx))) break;
      const o = await submitAndObserve(ctx, form);
      if (!o) break;
      if (hasFeedback(o)) {
        push({ ...BASE, check: 'empty-submission', status: 'pass', severity: 'info', basis: null, element: el, expected: 'Empty required fields are rejected with feedback', actual: `Empty submission rejected (${o.nativeBlocked ? `native validation: ${o.validationMessages.slice(0, 2).join(' / ') || 'blocked'}` : `feedback: ${o.feedbackText.slice(0, 2).join(' / ') || 'aria-invalid'}`})` });
      } else if (o.attempted) {
        push({
          ...BASE, check: 'required-not-enforced', status: 'fail', severity: 'major', basis: 'generic_rule', element: el,
          expected: `Required fields (${required.map((f) => f.name || f.label).join(', ')}) block an empty submission and show a message`,
          actual: `Form "${label}" has ${required.length} required field(s) but an empty submission was sent with no validation feedback`,
          details: { required: required.map((f) => f.selector), noValidate: form.noValidate }, ...proof(o),
        });
      } else {
        push({ ...BASE, check: 'empty-submission', status: 'anomaly', severity: 'minor', basis: null, element: el, expected: 'Empty submission shows a validation message', actual: `Submitting "${label}" empty produced no request and no visible validation message` });
      }
    }

    // ---- invalid input, per constrained field
    // A login form is not probed field by field: one credential attempt is enough and passwords declare no testable format.
    const constrained = login ? [] : form.fields.filter((f) => f.visible && !f.disabled && invalidValue(f) !== null).slice(0, 3);
    for (const f of constrained) {
      if (ctx.budget.exhausted) break;
      if (!(await resetPage(ctx))) break;
      const bad = invalidValue(f)!;
      await fillForm(ctx, form, { selector: f.selector, value: bad });
      const o = await submitAndObserve(ctx, form);
      if (!o) break;
      const fieldEl = { selector: f.selector, role: f.type, name: (f.label || f.name || f.placeholder).slice(0, 80) };
      const fieldLabel = f.label || f.name || f.type;
      if (hasFeedback(o)) {
        push({ ...BASE, check: 'invalid-input', status: 'pass', severity: 'info', basis: null, element: fieldEl, expected: 'Invalid input is rejected with a message', actual: `"${fieldLabel}" rejected "${bad}"${o.validationMessages[0] ? `: ${o.validationMessages[0]}` : ''}` });
      } else if (o.attempted) {
        push({
          ...BASE, check: 'invalid-input-accepted', status: 'fail', severity: 'major', basis: 'generic_rule', element: fieldEl,
          expected: `Field "${fieldLabel}" (type=${f.type}${f.min ? ` min=${f.min}` : ''}${f.pattern ? ` pattern=${f.pattern}` : ''}) rejects "${bad}" with a validation message`,
          actual: `Form submitted with invalid value "${bad}" in "${fieldLabel}" and showed no validation message${form.noValidate ? ' (form has novalidate)' : ''}`,
          ...proof(o),
        });
      } else {
        push({ ...BASE, check: 'validation-message', status: 'anomaly', severity: 'minor', basis: null, element: fieldEl, expected: 'Invalid input shows a validation message', actual: `Invalid "${bad}" in "${fieldLabel}" produced no request and no visible message`, screenshot: o.screenshot });
      }
    }

    // ---- safe valid submission
    if (ctx.budget.exhausted) break;
    if (!(await resetPage(ctx))) break;
    await fillForm(ctx, form);
    guard.setAllowWrites(config.functional.submitValidForms);
    let o: SubmitObservation | null;
    try { o = await submitAndObserve(ctx, form); } finally { guard.setAllowWrites(false); }
    if (!o) break;
    const problems: string[] = [];
    if (o.jsErrors.length) problems.push(`uncaught exception: ${o.jsErrors[0]!.slice(0, 150)}`);
    if (o.errorPage) problems.push(`result page returned HTTP ${o.errorPage}`);
    if (config.functional.submitValidForms && o.failedRequests.length) problems.push(`failed request: ${o.failedRequests[0]!.slice(0, 150)}`);
    if (o.consoleErrors.length) problems.push(`console error: ${o.consoleErrors[0]!.slice(0, 150)}`);
    const check = login ? 'login-attempt' : 'valid-submission';
    const what = login ? `Login attempt on "${label}" with synthetic credentials` : `Valid submission of "${label}"`;
    if (problems.length) {
      push({ ...BASE, check, status: 'fail', severity: 'major', basis: 'deterministic', element: el, expected: login ? 'A login attempt is handled without errors' : 'A valid synthetic submission succeeds without errors', actual: `${what} caused ${problems.join('; ')}`, ...proof(o) });
    } else if (o.nativeBlocked) {
      push({ ...BASE, check, status: 'anomaly', severity: 'minor', basis: null, element: el, expected: 'Valid synthetic data is accepted', actual: `Form "${label}" rejected synthetic data via validation (${o.validationMessages.slice(0, 2).join(' / ')}); the generated value may not match an undeclared rule`, ...proof(o) });
    } else if (o.blockedByGuard.length > 0) {
      // The UI did its part, but the request never left the browser: the workflow is unverified, neither a pass nor a bug.
      push({
        ...BASE, check, status: 'blocked', severity: 'info', basis: null, element: el, confidence: 'HIGH',
        expected: login ? 'Submitting credentials produces an authentication outcome' : 'A valid submission is accepted by the application',
        actual: `The form was filled and submitted in the UI, but the workflow could not be fully verified because the QA safety policy blocked the request (${o.blockedByGuard[0]!.slice(0, 140)})`,
        details: { blocked: o.blockedByGuard }, ...proof(o),
      });
    } else if (!o.attempted && !o.domChanged && o.feedbackText.length === 0) {
      push({ ...BASE, check, status: 'anomaly', severity: 'minor', basis: null, element: el, expected: 'Submitting a valid form has an observable result', actual: `${what} produced no request, navigation or visible change`, ...proof(o) });
    } else if (login && o.feedbackText.length > 0) {
      push({ ...BASE, check, status: 'pass', severity: 'info', basis: null, element: el, expected: 'Unknown credentials are rejected with a message', actual: `Synthetic credentials were rejected: ${o.feedbackText[0]!.slice(0, 120)}` });
    } else if (login) {
      push({ ...BASE, check, status: 'anomaly', severity: 'minor', basis: null, element: el, confidence: 'LOW', expected: 'Unknown credentials are rejected with a message', actual: `${what} was sent and no rejection message was shown${o.navigated ? ` (navigated to ${c.page.url()})` : ''}; the authentication outcome needs a human`, ...proof(o) });
    } else {
      push({ ...BASE, check, status: 'pass', severity: 'info', basis: null, element: el, expected: 'Valid submission works', actual: `Valid submission was sent and handled without errors${o.navigated ? ` (navigated to ${c.page.url()})` : ''}` });
    }
  }
  return results;
}

