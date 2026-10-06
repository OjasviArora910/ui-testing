import type { BrowserController } from '../browser/index.js';
import { shellAmong } from '../discovery/shell.js';
import type { FunctionalContext, FunctionalResult } from './types.js';

/**
 * TEST -> VERIFY -> RESTORE -> CONTINUE for controls that hold a state and can be put back exactly as they were:
 * checkboxes and switches, sliders, selects, tabs and text fields. Used on the controls a click has just revealed (a
 * dialog, a panel, an editor) and on the sliders of the page itself.
 *
 * Nothing here ever clicks a button or a link, so nothing is saved, confirmed or submitted: each control is changed by
 * the smallest step, its own state is checked, and its original state is put back and checked again. A control whose
 * change could not be undone is not touched at all (radio groups, file inputs, passwords, anything the safety guard or
 * the access-control pattern below refuses).
 */
const MARK = 'data-qa-rc';
const BASE = { kind: 'interactive' as const };
const MAX_PER_REVEAL = 25;
const MAX_PER_PAGE = 150;
/** Controls that take access away from someone are never operated, even reversibly. */
const NEVER = /\b(lock(ed)?[\s-]?out|lockout|suspend|revoke|deactivate|terminate|ban(ned)?|block (user|account|access)|disable (user|account|login|access))\b/i;

type Kind = 'toggle' | 'slider' | 'select' | 'tab' | 'text';
interface Found { id: number; kind: Kind; label: string; path: string; native: boolean; type: string }
interface State { value: string; exists: boolean }

const COMMON = `
  const CANDIDATES = 'input, select, textarea, [role=checkbox], [role=switch], [role=slider], [role=tab], .ui-slider-handle, .noUi-handle, .rc-slider-handle, .MuiSlider-thumb, .slider-handle';
  const visible = (el) => {
    const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || '1') > 0.05;
  };
`;

const DISCOVER_SCRIPT = `((mark, onlyNew, max) => {
  ${COMMON}
  const seen = window.__qaSeenControls;
  if (onlyNew && !seen) return [];
  document.querySelectorAll('[' + mark + ']').forEach((e) => e.removeAttribute(mark));
  const text = (e) => (e ? (e.innerText || e.textContent || '') : '').replace(/\\s+/g, ' ').trim();
  const labelOf = (el) => {
    const aria = el.getAttribute('aria-label'); if (aria) return aria;
    const by = el.getAttribute('aria-labelledby'); if (by) { const t = by.split(/\\s+/).map((i) => text(document.getElementById(i))).join(' ').trim(); if (t) return t; }
    if (el.labels && el.labels.length) { const t = text(el.labels[0]); if (t) return t; }
    if (el.tagName !== 'INPUT' && el.tagName !== 'SELECT' && el.tagName !== 'TEXTAREA') { const t = text(el); if (t) return t; }
    const row = el.closest('tr, li, [role=row], .row, .form-group, fieldset, label'); if (row) { const t = text(row); if (t) return t; }
    return el.getAttribute('placeholder') || el.getAttribute('name') || el.id || el.tagName.toLowerCase();
  };
  const pathOf = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 6; e = e.parentElement) {
      const same = e.parentElement ? Array.from(e.parentElement.children).filter((x) => x.tagName === e.tagName) : [e];
      parts.unshift(e.tagName.toLowerCase() + (same.length > 1 ? ':nth-of-type(' + (same.indexOf(e) + 1) + ')' : ''));
    }
    return parts.join(' > ');
  };
  const kindOf = (el) => {
    const tag = el.tagName.toLowerCase(), type = (el.getAttribute('type') || '').toLowerCase(), role = (el.getAttribute('role') || '').toLowerCase();
    if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.readOnly || el.getAttribute('aria-readonly') === 'true') return null;
    if (tag === 'input' && type === 'checkbox') return ['toggle', true];
    if (role === 'checkbox' || role === 'switch') return ['toggle', false];
    if (tag === 'input' && type === 'range') return ['slider', true];
    if (role === 'slider' || /(^|\\s)(ui-slider-handle|noUi-handle|rc-slider-handle|MuiSlider-thumb|slider-handle)(\\s|$)/.test(String(el.className))) return ['slider', false];
    if (tag === 'select') return el.multiple ? null : ['select', true];
    if (role === 'tab') return onlyNew ? null : (el.getAttribute('aria-selected') === 'true' ? null : ['tab', false]);
    if (tag === 'textarea') return ['text', true];
    if (tag === 'input' && ['', 'text', 'search', 'email', 'number', 'tel', 'url'].includes(type)) return ['text', true];
    return null; // radios, files, passwords, dates, colours, hidden inputs, buttons: not operated
  };
  const out = [];
  for (const el of document.querySelectorAll(CANDIDATES)) {
    if (out.length >= max) break;
    if (!visible(el) || (onlyNew && (seen.has(el) || (window.__qaTestedControls && window.__qaTestedControls.has(el))))) continue;
    const k = kindOf(el); if (!k) continue;
    el.setAttribute(mark, String(out.length));
    if (onlyNew && window.__qaTestedControls) window.__qaTestedControls.add(el); // a control is tested once, however many states show it
    out.push({ id: out.length, kind: k[0], native: k[1], label: labelOf(el).slice(0, 120), path: pathOf(el), type: (el.getAttribute('type') || el.tagName).toLowerCase() });
  }
  return out;
})`;

/** The control's own state, as one comparable string. */
const STATE_SCRIPT = `((sel, kind) => {
  const el = document.querySelector(sel);
  if (!el) return { value: '', exists: false };
  let value = '';
  if (kind === 'toggle') value = el.tagName === 'INPUT' ? String(el.checked) : String(el.getAttribute('aria-checked') || el.getAttribute('aria-pressed') || el.classList.contains('active') || el.classList.contains('checked'));
  else if (kind === 'slider') {
    if (el.tagName === 'INPUT') value = String(el.value);
    else {
      const holder = el.getAttribute('aria-valuenow') !== null ? el : el.closest('[aria-valuenow]');
      value = holder ? 'value ' + holder.getAttribute('aria-valuenow') : 'position ' + [el.style.left, el.style.bottom, el.style.top, el.style.transform].join('|');
    }
  } else if (kind === 'tab') {
    const list = el.closest('[role=tablist]') || el.parentElement;
    const tabs = list ? Array.from(list.querySelectorAll('[role=tab]')) : [el];
    value = String(tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true'));
  } else value = el.value === undefined || el.value === null ? '' : String(el.value);
  return { value, exists: true };
})`;

const pageCount = new WeakMap<object, number>();

/** Call just before a click: notes which state controls are already on screen, so that what the click reveals can be told apart. */
export async function rememberControls(c: BrowserController): Promise<void> {
  // kept in the page's memory; the DOM is not touched, so the observation of the click is not disturbed
  await c.page.evaluate(`(() => { ${COMMON} window.__qaSeenControls = new WeakSet(Array.from(document.querySelectorAll(CANDIDATES)).filter(visible)); window.__qaRootSeen = new WeakSet(Array.from(document.querySelectorAll('body *')).filter(visible)); window.__qaTestedControls = new WeakSet(); window.__qaSeenContent = new WeakSet(Array.from(document.querySelectorAll(${JSON.stringify(REVEAL_SEL)})).filter(visible)); })()`).catch(() => undefined);
}

/** Content a user would recognise as "something opened": headings, labelled fields, controls, a dialog. */
const REVEAL_SEL = 'h1,h2,h3,h4,h5,h6,[role=heading],legend,label,button,[role=button],input:not([type=hidden]),select,textarea,[role=tab],dialog,[role=dialog],[aria-modal=true]';

export interface Revealed { controls: number; headings: number; dialog: boolean; title: string }

/**
 * What became visible since rememberControls() ran: the concrete proof that a control opened or showed content.
 * null when the page was reloaded or replaced in between (nothing can be compared).
 */
export async function revealedContent(c: BrowserController): Promise<Revealed | null> {
  return (await c.page.evaluate(`(() => { ${COMMON}
    const seen = window.__qaSeenContent; if (!seen) return null;
    const fresh = Array.from(document.querySelectorAll(${JSON.stringify(REVEAL_SEL)})).filter((e) => visible(e) && !seen.has(e));
    const isHeading = (e) => /^H[1-6]$/.test(e.tagName) || e.getAttribute('role') === 'heading' || e.tagName === 'LEGEND';
    const isDialog = (e) => e.tagName === 'DIALOG' || e.getAttribute('role') === 'dialog' || e.getAttribute('aria-modal') === 'true';
    const h = fresh.find(isHeading);
    return { controls: fresh.filter((e) => !isHeading(e) && !isDialog(e) && e.tagName !== 'LABEL').length, headings: fresh.filter(isHeading).length, dialog: fresh.some(isDialog),
      title: h ? (h.innerText || h.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60) : '' };
  })()`).catch(() => null)) as Revealed | null;
}

/**
 * Tests the state controls that are on screen now. `onlyNew`: only those that were not there when rememberControls() ran
 * (what a click revealed). `kinds`: restrict to some kinds. Returns how many controls were operated.
 */
export async function testReversibleControls(
  ctx: FunctionalContext, push: (r: FunctionalResult) => void, opts: { onlyNew: boolean; kinds?: Kind[]; openedBy?: string },
): Promise<number> {
  const { controller: c, guard } = ctx;
  const used = pageCount.get(ctx.budget) ?? 0;
  if (used >= MAX_PER_PAGE) return 0;
  let found = (await c.page.evaluate(`${DISCOVER_SCRIPT}(${JSON.stringify(MARK)}, ${opts.onlyNew}, ${Math.min(MAX_PER_REVEAL * 3, 60)})`).catch(() => [])) as Found[];
  if (opts.kinds) found = found.filter((f) => opts.kinds!.includes(f.kind));
  if (found.length === 0) return 0;
  const css = (f: Found): string => `[${MARK}="${f.id}"]`;
  if (ctx.pageOnly) { const shell = await shellAmong(c, found.map(css)); found = found.filter((f) => !shell.has(css(f))); }
  found = found.slice(0, Math.min(MAX_PER_REVEAL, MAX_PER_PAGE - used));
  const where = opts.openedBy ? ` (shown by "${opts.openedBy}")` : '';
  const read = (f: Found): Promise<State> => (c.page.evaluate(`${STATE_SCRIPT}(${JSON.stringify(css(f))}, ${JSON.stringify(f.kind)})`) as Promise<State>).catch(() => ({ value: '', exists: false }));
  let done = 0;

  for (const f of found) {
    if (ctx.budget.exhausted) break;
    const label = f.label || f.path;
    const ref = { selector: f.path, name: label.slice(0, 80) };
    const expected = `"${label}"${where} responds when used and can be put back exactly as it was`;
    const guardKind = f.kind === 'toggle' ? 'check' : f.kind === 'select' ? 'select' : f.kind === 'text' ? 'fill' : 'click';
    const decision = NEVER.test(label) ? { allowed: false, reason: 'controls that take access away are never operated' } : guard.check({ kind: guardKind, name: label, text: label, fieldName: label, fieldType: f.type });
    if (!decision.allowed) {
      push({ ...BASE, check: 'guard', status: 'skipped', severity: 'info', basis: null, element: ref, expected: 'Safe, reversible controls are exercised', actual: `Not used: ${decision.reason}`, details: { guard: decision } });
      continue;
    }
    const before = await read(f);
    if (!before.exists) continue;
    if (!ctx.budget.consume()) break;
    const urlBefore = c.page.url();
    const target = { css: css(f) };
    let error: string | undefined;
    let changed: State = before;
    let how = '';

    // ---- TEST: the smallest change
    if (f.kind === 'toggle' || f.kind === 'tab') {
      how = f.kind === 'tab' ? 'select the tab' : 'toggle it';
      error = (await c.click(target)).error;
      await c.settle(80); changed = await read(f);
    } else if (f.kind === 'slider') {
      how = 'move it one step';
      await c.page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(css(f))}); if (e && e.focus) e.focus(); })()`).catch(() => undefined);
      for (const key of ['ArrowRight', 'ArrowLeft']) { // at its maximum a slider can only move the other way
        error = (await c.press(key, target)).error;
        await c.settle(60); changed = await read(f);
        if (error || changed.value !== before.value) break;
      }
    } else if (f.kind === 'select') {
      how = 'choose another option';
      const other = (await c.page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(css(f))}); if (!e) return null; const o = Array.from(e.options).find((x) => !x.disabled && x.value !== e.value && x.value !== '') || Array.from(e.options).find((x) => !x.disabled && x.value !== e.value); return o ? o.value : null; })()`).catch(() => null)) as string | null;
      if (other === null) continue; // a single option: nothing to choose
      error = (await c.select(target, other)).error;
      await c.settle(80); changed = await read(f);
    } else {
      how = 'type a test value';
      const value = f.type === 'number' ? (before.value === '1' ? '2' : '1') : f.type === 'email' ? 'john@maildrop.cc' : f.type === 'tel' ? '5550100' : f.type === 'url' ? 'https://example.com' : before.value === 'test' ? 'test 2' : 'test';
      error = (await c.fill(target, value)).error;
      await c.settle(80); changed = await read(f);
    }
    const responded = !error && changed.exists && changed.value !== before.value;

    // ---- RESTORE: back to exactly the original state, and check it
    let restored = true; let after: State = changed;
    if (changed.exists && changed.value !== before.value) {
      if (f.kind === 'toggle') await c.click(target);
      else if (f.kind === 'tab') await c.page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(css(f))}); const list = e && (e.closest('[role=tablist]') || e.parentElement); const t = list && Array.from(list.querySelectorAll('[role=tab]'))[${Number(before.value)}]; if (t) t.click(); })()`).catch(() => undefined);
      else if (f.kind === 'slider') {
        // step back the way it came; a native slider is then set to its exact original value if a step did not land on it
        const forward = changed.value > before.value || Number(changed.value.replace(/[^\d.-]/g, '')) > Number(before.value.replace(/[^\d.-]/g, ''));
        await c.press(forward ? 'ArrowLeft' : 'ArrowRight', target);
        await c.settle(60);
        if (f.native && (await read(f)).value !== before.value) {
          await c.page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(css(f))}); if (!e) return; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(e, ${JSON.stringify(before.value)}); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`).catch(() => undefined);
        }
      } else if (f.kind === 'select') await c.select(target, before.value);
      else await c.fill(target, before.value);
      await c.settle(80);
      after = await read(f);
      restored = after.exists && after.value === before.value;
    }
    done++;
    pageCount.set(ctx.budget, (pageCount.get(ctx.budget) ?? 0) + 1);
    const moved = `${before.value || '(empty)'} -> ${changed.value || '(empty)'}`;
    ctx.onAction?.({ type: `restore-${f.kind}`, target: label, ok: responded && restored, detail: responded ? `${moved}, ${restored ? 'restored' : 'NOT restored'}` : error ?? 'no response' });

    const trace = { action: `${how}: "${label}"`, urlBefore, urlAfter: c.page.url(), network: [], console: [], changes: [`state ${moved}`, restored ? `restored to ${after.value || '(empty)'}` : `after restoring: ${after.value || '(gone)'}`, ...(error ? [`browser: ${error}`] : [])] };
    if (responded && restored) {
      push({ ...BASE, check: `reversible-${f.kind}`, status: 'pass', severity: 'info', basis: null, element: ref, expected, actual: `Responded (${moved}) and was restored to its original state (${before.value || '(empty)'})`, confidence: 'HIGH' });
    } else if (responded) {
      // it works; only putting it back did not land exactly. Not a bug of the page, and the page is reloaded afterwards.
      push({ ...BASE, check: `reversible-${f.kind}`, status: 'inconclusive', severity: 'info', basis: null, element: ref, expected, actual: `Responded (${moved}) but could not be put back to ${before.value || '(empty)'} (now ${after.value || '(gone)'}); nothing was saved and the page is reloaded before the next test`, confidence: 'MEDIUM', trace });
    } else if (error || !f.native || !changed.exists) {
      // the browser could not operate it, or it is a custom widget whose state cannot be read reliably: no proof either way
      push({ ...BASE, check: `reversible-${f.kind}`, status: 'inconclusive', severity: 'info', basis: null, element: ref, expected, actual: error ? `Could not ${how}: ${error.slice(0, 160)}` : `No change could be observed after trying to ${how}`, confidence: 'LOW', trace });
    } else {
      const proof = { screenshot: await c.page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => undefined), trace };
      push({ ...BASE, check: `reversible-${f.kind}`, status: 'fail', severity: 'major', basis: 'deterministic', element: ref, expected, actual: `"${label}" was operated (${how}) but its state stayed ${before.value || '(empty)'}`, confidence: 'HIGH', details: { reason: 'The control was operated successfully but its own state did not change' }, ...proof });
    }
    if (c.page.url() !== urlBefore) break; // the control changed the page: stop here, the caller reloads
  }
  await c.page.evaluate(`document.querySelectorAll('[${MARK}]').forEach((e) => e.removeAttribute('${MARK}'))`).catch(() => undefined);
  return done;
}
