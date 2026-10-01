import { coveredBy, domSignature, elementOf, resetPage, targetFor } from './helpers.js';
import type { FunctionalContext, FunctionalResult } from './types.js';

const BASE = { kind: 'button' as const };

/** Tests visibility, enabled state, clickability and the observable result of each safe button. */
export async function testButtons(ctx: FunctionalContext): Promise<FunctionalResult[]> {
  const { controller: c, guard, model, config } = ctx;
  const results: FunctionalResult[] = [];
  const submitSelectors = new Set(model.forms.map((f) => f.form.submit?.selector).filter(Boolean));
  const buttons = model.buttons.filter((b) => !submitSelectors.has(b.selector)).slice(0, config.functional.maxButtonsPerPage);

  for (const b of buttons) {
    if (ctx.budget.exhausted) break;
    const el = elementOf(b);
    const label = b.name || b.text || b.selector;
    const decision = guard.check({ kind: 'click', name: b.name, text: b.text, selector: b.selector, role: b.role ?? undefined });
    if (!decision.allowed) {
      results.push({ ...BASE, check: 'guard', status: 'skipped', severity: 'info', basis: null, element: el, expected: 'Safe buttons are tested', actual: `Not clicked: ${decision.reason}`, details: { guard: decision } });
      continue;
    }
    if (!b.visible) { results.push({ ...BASE, check: 'visibility', status: 'skipped', severity: 'info', basis: null, element: el, expected: 'Visible', actual: 'Not visible; not tested' }); continue; }
    if (!b.enabled) { results.push({ ...BASE, check: 'enabled-state', status: 'pass', severity: 'info', basis: null, element: el, expected: 'Disabled button is exposed as disabled', actual: 'Button is disabled' }); continue; }
    if (!(await resetPage(ctx))) break;

    const target = targetFor(b, model.buttons);
    const loc = c.locate(target);
    // 1) clickability without side effects
    try {
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
      await loc.click({ trial: true, timeout: 3000 });
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).split('\n')[0]!;
      const covered = /intercepts pointer events/i.test(msg);
      const cover = covered ? await coveredBy(ctx, b.selector) : null;
      const hard = covered && !cover?.floating; // covered by a non-floating element = real defect
      results.push({
        ...BASE, check: 'clickable', status: hard ? 'fail' : 'anomaly', severity: hard ? 'major' : 'minor', basis: hard ? 'deterministic' : null, element: el,
        expected: `Button "${label}" can be clicked`,
        actual: c.redactor.redact(covered ? `${cover ? `<${cover.description}>` : 'Another element'} covers the button${cover?.floating ? ' (floating/overlay UI, needs review)' : ''}: ${msg.slice(0, 160)}` : `Not clickable: ${msg.slice(0, 200)}`),
      });
      continue;
    }

    // 2) real click and observation
    if (!ctx.budget.consume()) break;
    const n0 = c.events.network.length; const k0 = c.events.console.length; const blocked0 = c.blockedRequests.length;
    const before = await domSignature(ctx);
    const res = await c.click(target);
    await c.settle(250);
    ctx.onAction?.({ type: 'click', target: label, ok: res.ok, detail: res.error });
    const after = await domSignature(ctx);
    const net = c.events.network.slice(n0); const con = c.events.console.slice(k0);
    const pageErrors = con.filter((x) => x.kind === 'pageerror');
    const consoleErrors = con.filter((x) => x.level === 'error' && x.kind === 'console' && !/Failed to load resource/i.test(x.text));
    const failedNet = net.filter((x) => !x.ok && !x.ignored && !x.blockedByGuard);

    let reported = false;
    if (!res.ok) { results.push({ ...BASE, check: 'click', status: 'anomaly', severity: 'minor', basis: null, element: el, expected: 'Click succeeds', actual: `Click failed: ${res.error}` }); reported = true; }
    for (const pe of pageErrors) { results.push({ ...BASE, check: 'javascript-error', status: 'fail', severity: 'major', basis: 'deterministic', element: el, expected: 'Clicking does not raise uncaught JavaScript exceptions', actual: `Uncaught exception after clicking "${label}": ${pe.text.slice(0, 200)}` }); reported = true; }
    for (const ce of consoleErrors) { results.push({ ...BASE, check: 'console-error', status: 'fail', severity: 'minor', basis: 'deterministic', element: el, expected: 'Clicking does not log console errors', actual: `console.error after clicking "${label}": ${ce.text.slice(0, 200)}` }); reported = true; }
    for (const fn of failedNet) { results.push({ ...BASE, check: 'network-failure', status: 'fail', severity: fn.status !== null && fn.status < 500 ? 'minor' : 'major', basis: 'deterministic', element: el, expected: 'Requests triggered by the button succeed', actual: `After clicking "${label}": ${fn.method} ${fn.url} ${fn.status === null ? `failed (${fn.failure})` : `returned HTTP ${fn.status}`}` }); reported = true; }
    const observable = before !== after || net.length > 0 || con.length > 0 || c.blockedRequests.length > blocked0;
    if (!observable && !reported) {
      results.push({ ...BASE, check: 'observable-result', status: 'anomaly', severity: 'minor', basis: null, element: el, expected: 'Clicking a button has an observable effect (navigation, DOM change, network request, dialog)', actual: `Clicking "${label}" produced no observable change` });
    } else if (!reported) {
      results.push({ ...BASE, check: 'click', status: 'pass', severity: 'info', basis: null, element: el, expected: 'Button works', actual: `Clicking "${label}" had an observable result` });
    }
  }
  return results;
}
