import type { BrowserController } from '../browser/index.js';
import type { ActionTrace, FunctionalContext, InferredIntent, PostActionObservation, PreActionSnapshot } from './types.js';

interface RawDomState {
  title: string;
  bodyTextLength: number;
  elementCount: number;
  openDialogs: string[];
  openMenus: string[];
  ariaExpanded: string[];
  toasts: string[];
  targetState: {
    tag: string;
    classes: string[];
    ariaExpanded: string | null;
    ariaSelected: string | null;
    ariaChecked: string | null;
    ariaControls: string | null;
    disabled: boolean;
    visible: boolean;
    ariaPressed: string | null;
    ariaCurrent: string | null;
    text: string;
    active: boolean;
    controlled: { visible: boolean; height: number } | null;
  } | null;
  signals: { layout: string; doc: string; form: string; text: string; attrs: string; overlays: string[] };
}

const EXTRACT_DOM_STATE_SCRIPT = `((targetSel) => {
  const b = document.body;
  if (!b) {
    return {
      title: '', bodyTextLength: 0, elementCount: 0, openDialogs: [], openMenus: [],
      ariaExpanded: [], toasts: [], targetState: null, signals: { layout: '', doc: '', form: '', text: '', attrs: '', overlays: [] }
    };
  }

  const dialogNodes = Array.from(document.querySelectorAll('dialog[open], [role=dialog]:not([hidden]), [role=alertdialog]:not([hidden]), [aria-modal=true]:not([hidden])'));
  const openDialogs = dialogNodes.map((d, i) => d.id ? '#' + d.id : d.className ? '.' + String(d.className).trim().split(/\\s+/)[0] : 'dialog-' + i);

  const hash = (str) => { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return String(h); };
  const shown = (el) => { const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false; } return true; };
  // Modal-like layers without dialog semantics: a shown, positioned layer above the page that covers a real share of the viewport.
  const vw = innerWidth, vh = innerHeight;
  const overlays = Array.from(b.querySelectorAll('*')).filter((el) => {
    if (dialogNodes.includes(el) || dialogNodes.some((d) => d.contains(el))) return false;
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && !(cs.position === 'absolute' && parseInt(cs.zIndex) > 0)) return false;
    const r = el.getBoundingClientRect();
    const inView = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    return inView >= vw * vh * 0.12 && shown(el);
  }).slice(0, 20).map((el, i) => 'overlay:' + (el.id ? '#' + el.id : el.className ? '.' + String(el.className).trim().split(/\\s+/)[0] : el.tagName.toLowerCase() + i));

  // Layout signature: any change in what is rendered where (expanding a panel, swapping a slide, re-ordering rows).
  let layout = ''; let attrs = '';
  const STATE_ATTRS = ['class', 'hidden', 'open', 'aria-hidden', 'aria-expanded', 'aria-selected', 'aria-checked', 'aria-pressed', 'aria-current', 'aria-disabled', 'disabled', 'data-state', 'data-active'];
  const all = b.getElementsByTagName('*');
  for (let i = 0; i < all.length && i < 4000; i++) {
    // state carried by attributes: which slide/panel/item is active, shown or selected
    for (const k of STATE_ATTRS) { const v = all[i].getAttribute(k); if (v !== null) attrs += k + '=' + v + ';'; }
    // inline style in canonical form (screenshots rewrite the raw attribute on inputs without changing any style)
    const css = all[i].style ? all[i].style.cssText.replace(/caret-color:[^;]*;?\s*/g, '') : ''; if (css) attrs += 'style=' + css + ';';
    const r = all[i].getBoundingClientRect();
    layout += Math.round(r.width) + 'x' + Math.round(r.height) + '@' + Math.round(r.left + scrollX) + ',' + Math.round(r.top + scrollY) + ';';
  }
  const root = document.documentElement;
  const doc = [root.className, b.className, root.getAttribute('data-theme'), b.getAttribute('data-theme'), root.getAttribute('style'), getComputedStyle(b).backgroundColor, getComputedStyle(b).color, document.title].join('|');
  const form = Array.from(document.querySelectorAll('input,select,textarea')).slice(0, 500)
    .map((f) => [f.type, f.type === 'password' ? String(f.value).length : f.value, f.checked === true ? 1 : 0, f.selectedIndex, f.disabled ? 1 : 0, f.placeholder || ''].join(':')).join(';');
  // content, not just its length: re-sorted rows, a counter going 0 -> 1, a swapped label
  const signals = { layout: hash(layout), doc: hash(doc), form: hash(form), text: hash(b.innerText || ''), attrs: hash(attrs), overlays };

  const menuNodes = Array.from(document.querySelectorAll('[role=menu]:not([hidden]), [role=menubar]:not([hidden]), .dropdown-menu.show, .menu.open'));
  const openMenus = menuNodes.map((m, i) => m.id ? '#' + m.id : m.className ? '.' + String(m.className).trim().split(/\\s+/)[0] : 'menu-' + i);

  const expandedNodes = Array.from(document.querySelectorAll('[aria-expanded="true"]'));
  const ariaExpanded = expandedNodes.map((e) => e.id ? '#' + e.id : e.tagName.toLowerCase());

  const toastNodes = Array.from(document.querySelectorAll('[role=alert], [role=status], .toast, .alert, .notification'));
  const toasts = toastNodes.filter((t) => {
    const cs = getComputedStyle(t);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0;
  }).map((t) => (t.innerText || t.textContent || '').trim().slice(0, 100)).filter(Boolean);

  let targetState = null;
  if (targetSel) {
    try {
      const el = document.querySelector(targetSel);
      if (el) {
        const cs = getComputedStyle(el);
        targetState = {
          tag: el.tagName.toLowerCase(),
          classes: Array.from(el.classList || []),
          ariaExpanded: el.getAttribute('aria-expanded'),
          ariaSelected: el.getAttribute('aria-selected'),
          ariaChecked: el.getAttribute('aria-checked') || (el.type === 'checkbox' ? String(el.checked) : null),
          ariaControls: el.getAttribute('aria-controls'),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          visible: cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0,
          ariaPressed: el.getAttribute('aria-pressed'),
          ariaCurrent: el.getAttribute('aria-current'),
          text: (el.innerText || el.textContent || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
          active: (() => {
            const cur = el.getAttribute('aria-current');
            if ((cur && cur !== 'false') || el.getAttribute('aria-selected') === 'true') return true;
            return Array.from(el.classList || []).some((c) => /^(is-)?(active|current|selected)$/i.test(c));
          })(),
          controlled: (() => {
            const id = el.getAttribute('aria-controls');
            const region = (id && document.getElementById(id.split(/\\s+/)[0])) || el.nextElementSibling || (el.parentElement && el.parentElement.nextElementSibling);
            if (!region) return null;
            const r = region.getBoundingClientRect();
            return { visible: shown(region), height: Math.round(r.height) };
          })(),
        };
      }
    } catch {
      // ignore selector syntax errors
    }
  }

  return {
    title: document.title || '',
    bodyTextLength: (b.innerText || '').length,
    elementCount: b.getElementsByTagName('*').length,
    openDialogs,
    openMenus,
    ariaExpanded,
    toasts,
    targetState,
    signals,
  };
})`;

/**
 * Captures the pre-action baseline snapshot before an interaction occurs.
 */
export async function capturePreActionSnapshot(
  c: BrowserController,
  targetSelector?: string,
  options: { captureScreenshot?: boolean } = {},
): Promise<PreActionSnapshot> {
  // From this point on, new requests are the result of the action about to be performed, not of the page loading.
  c.beginAction();
  const url = c.url;
  const rawUrl = c.page.url();
  const netCount = c.events.network.length;
  const conCount = c.events.console.length;
  const timestamp = Date.now();

  const rawState = (await c.page.evaluate(
    `(${EXTRACT_DOM_STATE_SCRIPT})(${JSON.stringify(targetSelector || '')})`,
  )) as RawDomState;

  const buf = options.captureScreenshot !== false
    ? await c.page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => undefined)
    : undefined;

  return {
    url,
    rawUrl,
    title: rawState.title,
    domDigest: `${rawState.bodyTextLength}|${rawState.elementCount}|${rawState.openDialogs.length}|${rawState.openMenus.length}`,
    elementCount: rawState.elementCount,
    dialogsCount: rawState.openDialogs.length + rawState.signals.overlays.length,
    openDialogSelectors: [...rawState.openDialogs, ...rawState.signals.overlays],
    openMenuSelectors: rawState.openMenus,
    ariaExpandedCount: rawState.ariaExpanded.length,
    toastsCount: rawState.toasts.length,
    targetState: rawState.targetState,
    networkCount: netCount,
    consoleCount: conCount,
    blockedCount: c.blockedRequests.length,
    signals: rawState.signals,
    jsDialogCount: c.jsDialogs.length,
    popupCount: c.popups.length,
    timestamp,
    screenshot: buf,
  };
}

export interface ObservationOptions {
  minWaitMs?: number;
  maxWaitMs?: number;
  captureScreenshot?: boolean;
}

/**
 * Executes the adaptive post-action observation window:
 * - Monitors DOM mutations, network requests, console errors, and dialog/URL transitions.
 * - Minimum wait of 200ms, extending up to 1200ms when async requests are in-flight.
 * - Stops early when the expected outcome has unambiguously completed.
 */
export async function observeAction(
  ctx: FunctionalContext,
  pre: PreActionSnapshot,
  intent?: InferredIntent,
  options: ObservationOptions = {},
): Promise<PostActionObservation> {
  const c = ctx.controller;
  const minWait = options.minWaitMs ?? 200;
  const maxWait = options.maxWaitMs ?? 1200;
  const start = Date.now();

  // 1. Initial settling period
  await c.settle(minWait);

  // 2. Adaptive observation loop
  const targetSel = intent?.expectedOutcome.targetSelector;
  let elapsed = Date.now() - start;

  while (elapsed < maxWait) {
    // Check if network requests are currently in-flight
    const hasInflight = c.events.inflight() > 0;

    // Check if expected state has completed early
    let expectedMet = false;
    if (intent) {
      if (intent.kind === 'NAVIGATE' && c.page.url() !== pre.url) {
        expectedMet = true;
      } else if (intent.kind === 'OPEN_MODAL') {
        const dialogOpen = await c.page
          .evaluate("!!document.querySelector('dialog[open], [role=dialog]:not([hidden]), [aria-modal=true]:not([hidden])')")
          .catch(() => false);
        if (dialogOpen) expectedMet = true;
      } else if (intent.kind === 'SWITCH_TAB' && targetSel) {
        const isSelected = await c.page
          .evaluate(
            `((sel) => { const el = document.querySelector(sel); return el ? el.getAttribute('aria-selected') === 'true' || el.classList.contains('active') : false; })(${JSON.stringify(
              targetSel,
            )})`,
          )
          .catch(() => false);
        if (isSelected) expectedMet = true;
      }
    }

    if (expectedMet && !hasInflight) {
      break;
    }

    // Nothing in flight: stop as soon as the page has visibly responded. If it has not yet, keep watching until the window
    // closes, because many controls answer after a short delay (debounce, animation, timers) without any request.
    if (!hasInflight && elapsed >= 250) {
      const responded = await c.page
        .evaluate("(document.body ? (document.body.innerText || '').length + '|' + document.body.getElementsByTagName('*').length : '') + '|' + location.href")
        .then((now) => now !== `${pre.domDigest.split('|').slice(0, 2).join('|')}|${pre.rawUrl ?? ''}`)
        .catch(() => true);
      if (responded || elapsed >= maxWait - 60) break;
    }

    await new Promise((r) => setTimeout(r, 60));
    elapsed = Date.now() - start;
  }

  // 3. Capture post-action state
  const finalUrl = c.url;
  // following href="#" only appends an empty fragment: the page did not go anywhere
  const sameUrl = (a: string, b: string): boolean => a.replace(/#$/, '') === b.replace(/#$/, '');
  const rawPost = (await c.page.evaluate(
    `(${EXTRACT_DOM_STATE_SCRIPT})(${JSON.stringify(targetSel || '')})`,
  )) as RawDomState;

  const postBuf = options.captureScreenshot !== false
    ? await c.page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => undefined)
    : undefined;
  // Requests that belong to the page loading (including late ones still arriving) are not consequences of this action.
  const netSlice = c.events.network.slice(pre.networkCount).filter((n) => n.phase !== 'page-load' && n.startedAt >= pre.timestamp);
  const conSlice = c.events.console.slice(pre.consoleCount);

  // 4. Calculate transitions and diffs
  // dialogs with semantics plus modal-like layers without them
  const postDialogs = [...rawPost.openDialogs, ...rawPost.signals.overlays];
  const openedDialogs = postDialogs.filter((d) => !pre.openDialogSelectors.includes(d));
  const closedDialogs = pre.openDialogSelectors.filter((d) => !postDialogs.includes(d));
  const jsDialogs = c.jsDialogs.slice(pre.jsDialogCount ?? c.jsDialogs.length).map((d) => `${d.type}: ${d.message}`);
  const popups = c.popups.slice(pre.popupCount ?? c.popups.length).map((p) => p.url);

  // State changes that add or remove no nodes: the control itself, the region it governs, layout, theme, form values.
  const stateChanges: string[] = [];
  const t0 = pre.targetState; const t1 = rawPost.targetState;
  if (t0 && t1) {
    if ((t0.ariaPressed ?? null) !== t1.ariaPressed) stateChanges.push(`aria-pressed: ${t0.ariaPressed ?? null} -> ${t1.ariaPressed}`);
    if ((t0.ariaCurrent ?? null) !== t1.ariaCurrent) stateChanges.push(`aria-current: ${t0.ariaCurrent ?? null} -> ${t1.ariaCurrent}`);
    if (t0.classes.join(' ') !== t1.classes.join(' ')) stateChanges.push(`control class: "${t0.classes.join(' ')}" -> "${t1.classes.join(' ')}"`);
    if (t0.text !== undefined && t0.text !== t1.text) stateChanges.push(`control text: "${t0.text}" -> "${t1.text}"`);
    if (t0.disabled !== t1.disabled) stateChanges.push(`control ${t1.disabled ? 'became disabled' : 'became enabled'}`);
    if (t0.controlled && t1.controlled && (t0.controlled.visible !== t1.controlled.visible || Math.abs(t0.controlled.height - t1.controlled.height) > 1)) {
      stateChanges.push(`governed region: ${t0.controlled.visible ? 'shown' : 'hidden'} ${t0.controlled.height}px -> ${t1.controlled.visible ? 'shown' : 'hidden'} ${t1.controlled.height}px`);
    }
  } else if (t0 && !t1) stateChanges.push('control was removed from the page');
  if (pre.signals) {
    if (pre.signals.layout !== rawPost.signals.layout) stateChanges.push('page layout changed (content shown, hidden, moved or resized)');
    if (pre.signals.text !== undefined && pre.signals.text !== rawPost.signals.text) stateChanges.push('visible text changed');
    if (pre.signals.doc !== rawPost.signals.doc) stateChanges.push('document theme/class/title changed');
    if (pre.signals.attrs !== undefined && pre.signals.attrs !== rawPost.signals.attrs) stateChanges.push('an element changed state (class, hidden, style or ARIA state)');
    if (pre.signals.form !== rawPost.signals.form) stateChanges.push('a form control changed value, type or checked state');
  }

  const openedMenus = rawPost.openMenus.filter((m) => !pre.openMenuSelectors.includes(m));
  const closedMenus = pre.openMenuSelectors.filter((m) => !rawPost.openMenus.includes(m));

  // only status/alert regions that were not already on screen before the action
  const newToasts = rawPost.toasts.length > pre.toastsCount ? rawPost.toasts.slice(pre.toastsCount) : [];

  const domAdded = Math.max(0, rawPost.elementCount - pre.elementCount);
  const domRemoved = Math.max(0, pre.elementCount - rawPost.elementCount);
  // domDigest starts with the body text length captured before the action
  const textChanged = rawPost.bodyTextLength !== Number(pre.domDigest.split('|')[0]);

  const attrChanges: string[] = [];
  if (pre.targetState && rawPost.targetState) {
    if (pre.targetState.ariaExpanded !== rawPost.targetState.ariaExpanded) {
      attrChanges.push(`aria-expanded: ${pre.targetState.ariaExpanded} -> ${rawPost.targetState.ariaExpanded}`);
    }
    if (pre.targetState.ariaSelected !== rawPost.targetState.ariaSelected) {
      attrChanges.push(`aria-selected: ${pre.targetState.ariaSelected} -> ${rawPost.targetState.ariaSelected}`);
    }
    if (pre.targetState.ariaChecked !== rawPost.targetState.ariaChecked) {
      attrChanges.push(`aria-checked: ${pre.targetState.ariaChecked} -> ${rawPost.targetState.ariaChecked}`);
    }
  }

  // Requests stopped by ActionGuard (and cancelled/ignored ones) are not application failures.
  const blockedByGuard = c.blockedRequests.slice(pre.blockedCount ?? c.blockedRequests.length).filter((b) => b.phase === 'action' && b.at >= pre.timestamp).map((b) => `${b.method} ${b.url}`);
  const networkRequests = netSlice.filter((n) => !n.ignored && !n.blockedByGuard).map((n) => ({
    method: n.method,
    url: n.url,
    status: n.status,
    failure: n.failure ?? undefined,
    durationMs: n.durationMs ?? undefined,
  }));

  const hasWrites = networkRequests.some((n) => n.method !== 'GET' && n.method !== 'HEAD');
  const failedNet = networkRequests.filter((n) => (n.status !== null && n.status >= 400) || n.failure);
  const errorDetails = failedNet.map(
    (n) => `${n.method} ${n.url} returned ${n.status ? `HTTP ${n.status}` : n.failure || 'network error'}`,
  );

  // An error the page had already logged by itself since it loaded (same text) keeps happening with or without this action,
  // so it says nothing about the action. It is kept as a diagnostic, apart from the errors the action may have caused.
  const before = new Set(c.events.console.slice(c.consoleIndexAtLoad, pre.consoleCount).filter((x) => x.level === 'error').map((x) => x.text));
  const isError = (x: (typeof conSlice)[number]): boolean => x.kind === 'pageerror' || (x.level === 'error' && !/Failed to load resource/i.test(x.text));
  const ambient = conSlice.filter((x) => isError(x) && before.has(x.text)).map((x) => x.text);
  const caused = conSlice.filter((x) => isError(x) && !before.has(x.text));
  const consoleErrors = caused.filter((x) => x.kind === 'console').map((x) => x.text);
  const pageErrors = caused.filter((x) => x.kind === 'pageerror').map((x) => x.text);

  return {
    pre,
    finalUrl,
    urlChanged: !sameUrl(finalUrl, pre.url),
    navigated: !sameUrl(finalUrl, pre.url),
    durationMs: Date.now() - start,
    domMutations: {
      addedNodesCount: domAdded,
      removedNodesCount: domRemoved,
      textChanged,
      attributeChanges: attrChanges,
    },
    dialogs: {
      opened: openedDialogs,
      closed: closedDialogs,
      countBefore: pre.dialogsCount,
      countAfter: postDialogs.length,
    },
    menus: {
      opened: openedMenus,
      closed: closedMenus,
    },
    toasts: {
      appeared: newToasts,
    },
    ariaTransitions: {
      expandedChanged:
        pre.targetState && rawPost.targetState && pre.targetState.ariaExpanded !== rawPost.targetState.ariaExpanded
          ? { from: pre.targetState.ariaExpanded, to: rawPost.targetState.ariaExpanded }
          : undefined,
      selectedChanged:
        pre.targetState && rawPost.targetState && pre.targetState.ariaSelected !== rawPost.targetState.ariaSelected
          ? { from: pre.targetState.ariaSelected, to: rawPost.targetState.ariaSelected }
          : undefined,
      checkedChanged:
        pre.targetState && rawPost.targetState && pre.targetState.ariaChecked !== rawPost.targetState.ariaChecked
          ? { from: pre.targetState.ariaChecked, to: rawPost.targetState.ariaChecked }
          : undefined,
    },
    network: {
      requests: networkRequests,
      hasWrites,
      hasErrors: failedNet.length > 0,
      errorDetails,
      blockedByGuard,
    },
    console: {
      errors: consoleErrors,
      pageErrors,
      ambient,
    },
    targetPostState: rawPost.targetState,
    stateChanges, jsDialogs, popups,
    screenshot: postBuf,
  };
}

/** The part of an observation that explains a result: only what this one action caused. */
export function traceOf(action: string, o: PostActionObservation): ActionTrace {
  return {
    action, urlBefore: o.pre.url, urlAfter: o.finalUrl,
    network: [...o.network.requests.map((n) => `${n.method} ${n.url} -> ${n.status ?? n.failure ?? 'pending'}`), ...(o.network.blockedByGuard ?? []).map((b) => `${b} -> blocked by ActionGuard`)],
    console: [...o.console.pageErrors.map((e) => `uncaught: ${e}`), ...o.console.errors.map((e) => `console.error: ${e}`), ...(o.console.ambient ?? []).map((e) => `already logged before the action: ${e}`)],
    changes: [
      ...(o.urlChanged ? [`url: ${o.pre.url} -> ${o.finalUrl}`] : []),
      ...o.dialogs.opened.map((d) => `dialog opened: ${d}`), ...o.dialogs.closed.map((d) => `dialog closed: ${d}`),
      ...o.menus.opened.map((m) => `menu opened: ${m}`), ...o.menus.closed.map((m) => `menu closed: ${m}`),
      ...o.domMutations.attributeChanges,
      ...(o.stateChanges ?? []),
      ...(o.jsDialogs ?? []).map((d) => `native dialog shown (${d})`),
      ...(o.popups ?? []).map((p) => `popup window opened (${p || 'about:blank'})`),
      ...(o.domMutations.addedNodesCount ? [`${o.domMutations.addedNodesCount} element(s) added`] : []),
      ...(o.domMutations.removedNodesCount ? [`${o.domMutations.removedNodesCount} element(s) removed`] : []),
      ...(o.domMutations.textChanged ? ['visible text changed'] : []),
      ...o.toasts.appeared.map((t) => `status/alert text: ${t}`),
    ],
  };
}
