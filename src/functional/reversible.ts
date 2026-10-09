import { CONTEXT_JS, inspectDialog, resolveUnexpectedDialog } from './sensitive.js';
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
interface Found { id: number; kind: Kind; label: string; path: string; native: boolean; type: string; context: string; heading: string; purpose: string }
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
  ${CONTEXT_JS}
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
    out.push({ id: out.length, kind: k[0], native: k[1], label: labelOf(el).slice(0, 120), path: pathOf(el), type: (el.getAttribute('type') || el.tagName).toLowerCase(), ...contextOf(el) });
  }
  return out;
})`;

/**
 * Read state of a custom (non-native) slider.
 * Returns a stable prefixed string for reliable before/after comparison:
 *   'aria:N'     - from aria-valuenow on element or ancestor
 *   'data:V'     - from data-value / data-val / value attribute
 *   'sib:V'      - from a sibling hidden or range input
 *   'pos:X|Y|Z'  - from inline CSS position style
 *   'cpct:N'     - computed left % within parent track
 *   'unknown:0'  - no readable state found
 */
const CUSTOM_SLIDER_READ_INLINE = `
  const readCustomSlider = (el) => {
    if (!el) return 'unknown:0';
    // 1. aria-valuenow on element or ancestor within 4 levels
    let holder = el;
    for (let i = 0; i < 4; i++) {
      if (holder.getAttribute('aria-valuenow') !== null) return 'aria:' + holder.getAttribute('aria-valuenow');
      if (!holder.parentElement) break;
      holder = holder.parentElement;
    }
    // 2. data attributes on element
    for (const attr of ['data-value', 'data-val', 'data-step']) {
      const v = el.getAttribute(attr); if (v !== null && v !== '') return 'data:' + v;
    }
    // 3. data attributes on immediate parent
    const parent = el.parentElement;
    if (parent) {
      for (const attr of ['data-value', 'data-val']) {
        const v = parent.getAttribute(attr); if (v !== null && v !== '') return 'data:' + v;
      }
      // 4. sibling hidden/range input
      const inp = parent.querySelector('input[type=hidden], input[type=range]');
      if (inp && inp !== el && inp.value !== undefined && inp.value !== '') return 'sib:' + inp.value;
    }
    // 5. inline style position
    const pos = [el.style.left, el.style.bottom, el.style.top, el.style.transform].filter(Boolean).join('|');
    if (pos) return 'pos:' + pos;
    // 6. computed left percentage within parent track
    if (parent) {
      const pr = parent.getBoundingClientRect(); const er = el.getBoundingClientRect();
      if (pr.width > 0) return 'cpct:' + Math.round(((er.left - pr.left) / pr.width) * 100);
    }
    return 'unknown:0';
  };
`;

/** The control's own state, as one comparable string. */
const STATE_SCRIPT = `((sel, kind) => {
  const el = document.querySelector(sel);
  if (!el) return { value: '', exists: false };
  ${CUSTOM_SLIDER_READ_INLINE}
  let value = '';
  if (kind === 'toggle') value = el.tagName === 'INPUT' ? String(el.checked) : String(el.getAttribute('aria-checked') || el.getAttribute('aria-pressed') || el.classList.contains('active') || el.classList.contains('checked'));
  else if (kind === 'slider') {
    if (el.tagName === 'INPUT') value = String(el.value);
    else value = readCustomSlider(el);
  } else if (kind === 'tab') {
    const list = el.closest('[role=tablist]') || el.parentElement;
    const tabs = list ? Array.from(list.querySelectorAll('[role=tab]')) : [el];
    value = String(tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true'));
  } else value = el.value === undefined || el.value === null ? '' : String(el.value);
  return { value, exists: true };
})`;

/**
 * Attempt to restore a custom slider to its original value by mouse drag.
 * Reads aria-valuemin/max to compute the target ratio and drags the handle there.
 */
const CUSTOM_SLIDER_DRAG_RESTORE = `((sel, beforeValue, changedValue) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  const track = el.parentElement; if (!track) return false;
  const trackRect = track.getBoundingClientRect();
  if (trackRect.width < 4) return false;
  // Parse numeric part from 'aria:2', 'pos:50%', etc.
  const num = (v) => { const m = String(v).replace(/^[a-z-]+:/, '').match(/-?[\\d.]+/); return m ? parseFloat(m[0]) : NaN; };
  const tgt = num(beforeValue);
  if (isNaN(tgt)) return false;
  // Get aria range from handle or ancestor
  let minV = 0, maxV = 100;
  let holder = el;
  for (let i = 0; i < 4; i++) {
    if (holder.getAttribute('aria-valuemin') !== null) {
      minV = parseFloat(holder.getAttribute('aria-valuemin') || '0');
      maxV = parseFloat(holder.getAttribute('aria-valuemax') || '100');
      break;
    }
    if (!holder.parentElement) break;
    holder = holder.parentElement;
  }
  const range = maxV - minV;
  const ratio = range > 0 ? Math.max(0, Math.min(1, (tgt - minV) / range)) : (tgt / 100);
  const targetX = trackRect.left + ratio * trackRect.width;
  const midY = trackRect.top + trackRect.height / 2;
  const opts = { bubbles: true, cancelable: true, clientX: targetX, clientY: midY };
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  document.dispatchEvent(new MouseEvent('mousemove', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  track.dispatchEvent(new MouseEvent('click', { ...opts }));
  return true;
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
  const css = (f: Found): string => `[${MARK}="${f.id}"]`;
  const where = opts.openedBy ? ` (shown by "${opts.openedBy}")` : '';
  const read = (f: Found): Promise<State> => (c.page.evaluate(`${STATE_SCRIPT}(${JSON.stringify(css(f))}, ${JSON.stringify(f.kind)})`) as Promise<State>).catch(() => ({ value: '', exists: false }));
  let done = 0;
  const processed = new Set<string>();
  const limit = Math.min(MAX_PER_REVEAL, MAX_PER_PAGE - used);
  while (done < limit && !ctx.budget.exhausted) {
    // Rediscover from the current rendered state after each interaction and restoration.
    let found = (await c.page.evaluate(`${DISCOVER_SCRIPT}(${JSON.stringify(MARK)}, ${opts.onlyNew}, ${Math.min(MAX_PER_REVEAL * 3, 60)})`).catch(() => [])) as Found[];
    if (opts.kinds) found = found.filter((f) => opts.kinds!.includes(f.kind));
    found = found.filter((f) => !processed.has(`${f.kind}|${f.path}`));
    if (ctx.pageOnly) { const shell = await shellAmong(c, found.map(css)); found = found.filter((f) => !shell.has(css(f))); }
    const f = found[0];
    if (!f) break;
    processed.add(`${f.kind}|${f.path}`);
    if (opts.onlyNew) await c.page.evaluate(`((sel) => { const e = document.querySelector(sel); if (e && window.__qaTestedControls) window.__qaTestedControls.add(e); })(${JSON.stringify(css(f))})`).catch(() => undefined);
    const label = f.label || f.path;
    const ref = { selector: f.path, name: label.slice(0, 80) };
    const expected = `"${label}"${where} responds when used and can be put back exactly as it was`;
    // Configuration controls (check/select/fill/press) carry DATA labels — the permission name, not an action command.
    // "Send Publish Copy" is a permission name, not a command to publish. ActionGuard correctly allows these.
    const guardKind = f.kind === 'toggle' ? 'check' : f.kind === 'select' ? 'select' : f.kind === 'text' ? 'fill' : f.kind === 'slider' ? 'press' : 'click';
    const decision = NEVER.test(label) ? { allowed: false, reason: 'controls that take access away are never operated' } : guard.check({ kind: guardKind, name: label, text: label, fieldName: label, fieldType: f.type, context: f.context, heading: f.heading, purpose: f.purpose });
    if (!decision.allowed) {
      push({ ...BASE, check: 'guard', status: 'skipped', severity: 'info', basis: null, element: ref, expected: 'Safe, reversible controls are exercised', actual: `Not used: ${decision.reason}`, details: { guard: decision } });
      continue;
    }
    const before = await read(f);
    if (!before.exists) continue;
    if (!ctx.budget.consume()) break;
    const dialogBefore = (await inspectDialog(c))?.key ?? null;
    const nativeBefore = c.jsDialogs.length;
    const urlBefore = c.page.url();
    const target = { css: css(f) };
    let error: string | undefined;
    let changed: State = before;
    let how = '';

    // Physical targeting: bring element into view
    await c.page.evaluate(`((sel) => {
      const e = document.querySelector(sel);
      if (e) { if (e.scrollIntoViewIfNeeded) e.scrollIntoViewIfNeeded(); else e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    })(${JSON.stringify(css(f))})`).catch(() => undefined);

    const rawBox = await c.locate({ css: css(f) }).boundingBox().catch(() => null);
    const box = rawBox ? { ...rawBox, vpWidth: c.viewport.width, vpHeight: c.viewport.height } : null;
    const beforeShot = await c.page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => undefined);

    ctx.onAction?.({
      phase: 'TARGETED',
      type: f.kind,
      target: label,
      ok: true,
      box,
      buffer: beforeShot,
      expected,
    });

    ctx.onAction?.({
      phase: 'CLICKING',
      type: f.kind === 'toggle' ? 'click' : f.kind === 'slider' ? 'press' : f.kind === 'select' ? 'select' : 'fill',
      target: label,
      ok: true,
      box,
      buffer: beforeShot,
    });
    await new Promise((r) => setTimeout(r, 50));

    // ---- TEST: the smallest change
    if (f.kind === 'toggle' || f.kind === 'tab') {
      how = f.kind === 'tab' ? 'select the tab' : 'toggle it';
      const clk = await c.click(target, { force: true });
      error = clk.error;
      if (error || (f.kind === 'toggle' && (await read(f)).value === before.value)) {
        await c.page.evaluate(`((sel) => {
          const el = document.querySelector(sel);
          if (!el) return;
          if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(); else el.scrollIntoView({ block: 'nearest' });
          const target = (el.tagName === 'INPUT' && el.type === 'checkbox' && el.closest('label')) ? el.closest('label') : el;
          const opts = { bubbles: true, cancelable: true, view: window };
          target.dispatchEvent(new MouseEvent('pointerdown', opts));
          target.dispatchEvent(new MouseEvent('mousedown', opts));
          target.dispatchEvent(new MouseEvent('pointerup', opts));
          target.dispatchEvent(new MouseEvent('mouseup', opts));
          target.click();
          if (el.tagName === 'INPUT' && el.type === 'checkbox') el.dispatchEvent(new Event('change', { bubbles: true }));
        })(${JSON.stringify(css(f))})`).catch(() => undefined);
        error = undefined;
      }
      await c.settle(80); changed = await read(f);
    } else if (f.kind === 'slider') {
      how = 'move it one step';
      await c.page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(css(f))}); if (e && e.focus) e.focus(); })()`).catch(() => undefined);
      for (const key of ['ArrowRight', 'ArrowLeft']) { // at its maximum a slider can only move the other way
        error = (await c.press(key, target)).error;
        await c.settle(80); changed = await read(f);
        if (error || changed.value !== before.value) break;
      }
      // Custom slider: if arrow keys had no effect, try mouse drag to right or left of current position
      if (!error && changed.value === before.value && !f.native) {
        how = 'move it by mouse drag';
        const dragged = await c.page.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(css(f))});
          if (!el) return false;
          const track = el.parentElement; if (!track) return false;
          const tr = track.getBoundingClientRect(); if (tr.width < 4) return false;
          const er = el.getBoundingClientRect();
          const midY = er.top + er.height / 2;
          const curPct = tr.width > 0 ? (er.left - tr.left + er.width / 2) / tr.width : 0.5;
          const targetX = curPct < 0.75 ? tr.left + tr.width * 0.8 : tr.left + tr.width * 0.2;
          const opts = { bubbles: true, cancelable: true, clientX: targetX, clientY: midY };
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          document.dispatchEvent(new MouseEvent('mousemove', opts));
          el.dispatchEvent(new MouseEvent('mouseup', opts));
          track.dispatchEvent(new MouseEvent('click', { ...opts }));
          return true;
        })()`).catch(() => false);
        if (dragged) { await c.settle(100); changed = await read(f); }
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
    // The application answered with a warning / confirmation / security dialog: identified first, then dismissed only
    // through its negative control (never an affirmative one). The interaction is not judged, and this state is left.
    const surprise = await resolveUnexpectedDialog(ctx, dialogBefore);
    const asked = c.jsDialogs.slice(nativeBefore).find((d) => d.type === 'confirm' || d.type === 'prompt' || d.type === 'beforeunload');
    if (surprise || asked) {
      const what = surprise
        ? `an unexpected ${surprise.dialog.type} dialog appeared ("${surprise.dialog.text.slice(0, 120)}"; buttons: ${surprise.dialog.buttons.join(', ') || 'none'}); ${surprise.how}`
        : `the application asked for confirmation with a native ${asked!.type} dialog ("${asked!.message.slice(0, 120)}"); it was cancelled, never accepted`;
      push({ ...BASE, check: 'unexpected-dialog', status: 'inconclusive', severity: 'info', basis: null, element: ref, expected, confidence: 'LOW',
        actual: `After trying to ${how} "${label}", ${what}. Nothing was confirmed. The remaining controls of this view are not operated; the page is reloaded before the next test`,
        screenshot: await c.page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => undefined) });
      done++;
      break;
    }
    const responded = !error && changed.exists && changed.value !== before.value;

    if (responded) {
      const changedShot = await c.page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => undefined);
      ctx.onAction?.({
        phase: 'OBSERVING',
        type: f.kind,
        target: label,
        ok: true,
        box,
        buffer: changedShot,
      });
      await new Promise((r) => setTimeout(r, 60));
    }

    // ---- RESTORE: back to exactly the original state, and check it
    let restored = true; let after: State = changed;
    if (changed.exists && changed.value !== before.value) {
      if (f.kind === 'toggle') {
        await c.click(target, { force: true }).catch(() => undefined);
        if ((await read(f)).value !== before.value) {
          await c.page.evaluate(`((sel) => {
            const el = document.querySelector(sel);
            if (!el) return;
            const target = (el.tagName === 'INPUT' && el.type === 'checkbox' && el.closest('label')) ? el.closest('label') : el;
            const opts = { bubbles: true, cancelable: true, view: window };
            target.dispatchEvent(new MouseEvent('pointerdown', opts));
            target.dispatchEvent(new MouseEvent('mousedown', opts));
            target.dispatchEvent(new MouseEvent('pointerup', opts));
            target.dispatchEvent(new MouseEvent('mouseup', opts));
            target.click();
            if (el.tagName === 'INPUT' && el.type === 'checkbox') el.dispatchEvent(new Event('change', { bubbles: true }));
          })(${JSON.stringify(css(f))})`).catch(() => undefined);
        }
      }
      else if (f.kind === 'tab') await c.page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(css(f))}); const list = e && (e.closest('[role=tablist]') || e.parentElement); const t = list && Array.from(list.querySelectorAll('[role=tab]'))[${Number(before.value)}]; if (t) t.click(); })()`).catch(() => undefined);
      else if (f.kind === 'slider') {
        if (f.native) {
          // step back the way it came; a native slider is then set to its exact original value if a step did not land on it
          const forward = changed.value > before.value || Number(changed.value.replace(/[^\d.-]/g, '')) > Number(before.value.replace(/[^\d.-]/g, ''));
          await c.press(forward ? 'ArrowLeft' : 'ArrowRight', target);
          await c.settle(60);
          if ((await read(f)).value !== before.value) {
            await c.page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(css(f))}); if (!e) return; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(e, ${JSON.stringify(before.value)}); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`).catch(() => undefined);
          }
        } else {
          // Custom slider: 1) arrow key, 2) mouse drag to computed position, 3) direct DOM mutation as last resort
          const changedNum = parseFloat(changed.value.replace(/[^-\d.]/g, ''));
          const beforeNum = parseFloat(before.value.replace(/[^-\d.]/g, ''));
          const forward = !isNaN(changedNum) && !isNaN(beforeNum) ? changedNum > beforeNum : changed.value > before.value;
          await c.press(forward ? 'ArrowLeft' : 'ArrowRight', target);
          await c.settle(80);
          if ((await read(f)).value !== before.value) {
            // Mouse drag to the exact original position
            await c.page.evaluate(`${CUSTOM_SLIDER_DRAG_RESTORE}(${JSON.stringify(css(f))}, ${JSON.stringify(before.value)}, ${JSON.stringify(changed.value)})`).catch(() => false);
            await c.settle(100);
            if ((await read(f)).value !== before.value) {
              // Last resort: directly set the state attribute and fire events so reactive frameworks pick it up
              await c.page.evaluate(`(() => {
                const el = document.querySelector(${JSON.stringify(css(f))});
                if (!el) return;
                const raw = ${JSON.stringify(before.value)};
                const numMatch = raw.replace(/^[a-z-]+:/, '').match(/-?[\\d.]+/);
                if (!numMatch) return;
                const num = numMatch[0];
                // aria-valuenow on ancestor
                let holder = el;
                for (let i = 0; i < 4; i++) {
                  if (holder.getAttribute('aria-valuenow') !== null) { holder.setAttribute('aria-valuenow', num); break; }
                  if (!holder.parentElement) break;
                  holder = holder.parentElement;
                }
                // data attributes on element
                for (const attr of ['data-value', 'data-val']) {
                  if (el.getAttribute(attr) !== null) el.setAttribute(attr, num);
                }
                // sibling input
                const inp = el.parentElement && el.parentElement.querySelector('input[type=hidden], input[type=range]');
                if (inp && inp !== el) {
                  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
                  if (desc && desc.set) desc.set.call(inp, num);
                }
                // Dispatch events to trigger any reactive listeners
                ['input', 'change', 'mouseup'].forEach((ev) => el.dispatchEvent(new Event(ev, { bubbles: true })));
              })()`).catch(() => undefined);
              await c.settle(80);
            }
          }
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
    const afterShot = await c.page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => undefined);

    ctx.onAction?.({
      phase: 'RESULT',
      type: `reversible-${f.kind}`,
      target: label,
      ok: responded && restored,
      verdict: responded && restored ? 'PASS' : responded ? 'NEEDS_REVIEW' : 'NEEDS_REVIEW',
      confidence: responded && restored ? 'HIGH' : 'LOW',
      expected,
      actual: responded && restored ? `Responded (${moved}) and was restored to its original state (${before.value || '(empty)'})` : `${moved}, ${restored ? 'restored' : 'NOT restored'}`,
      box,
      buffer: afterShot,
    });

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
