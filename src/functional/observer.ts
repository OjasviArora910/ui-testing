import type { BrowserController } from '../browser/index.js';
import type { FunctionalContext, InferredIntent, PostActionObservation, PreActionSnapshot } from './types.js';

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
  } | null;
}

const EXTRACT_DOM_STATE_SCRIPT = `((targetSel) => {
  const b = document.body;
  if (!b) {
    return {
      title: '', bodyTextLength: 0, elementCount: 0, openDialogs: [], openMenus: [],
      ariaExpanded: [], toasts: [], targetState: null
    };
  }

  const dialogNodes = Array.from(document.querySelectorAll('dialog[open], [role=dialog]:not([hidden]), [role=alertdialog]:not([hidden]), [aria-modal=true]:not([hidden])'));
  const openDialogs = dialogNodes.map((d, i) => d.id ? '#' + d.id : d.className ? '.' + String(d.className).trim().split(/\\s+/)[0] : 'dialog-' + i);

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
  const url = c.url;
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
    title: rawState.title,
    domDigest: `${rawState.bodyTextLength}|${rawState.elementCount}|${rawState.openDialogs.length}|${rawState.openMenus.length}`,
    elementCount: rawState.elementCount,
    dialogsCount: rawState.openDialogs.length,
    openDialogSelectors: rawState.openDialogs,
    openMenuSelectors: rawState.openMenus,
    ariaExpandedCount: rawState.ariaExpanded.length,
    toastsCount: rawState.toasts.length,
    targetState: rawState.targetState,
    networkCount: netCount,
    consoleCount: conCount,
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

    if (!hasInflight && elapsed >= 250) {
      break;
    }

    await new Promise((r) => setTimeout(r, 60));
    elapsed = Date.now() - start;
  }

  // 3. Capture post-action state
  const finalUrl = c.url;
  const rawPost = (await c.page.evaluate(
    `(${EXTRACT_DOM_STATE_SCRIPT})(${JSON.stringify(targetSel || '')})`,
  )) as RawDomState;

  const postBuf = options.captureScreenshot !== false
    ? await c.page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => undefined)
    : undefined;
  const netSlice = c.events.network.slice(pre.networkCount);
  const conSlice = c.events.console.slice(pre.consoleCount);

  // 4. Calculate transitions and diffs
  const openedDialogs = rawPost.openDialogs.filter((d) => !pre.openDialogSelectors.includes(d));
  const closedDialogs = pre.openDialogSelectors.filter((d) => !rawPost.openDialogs.includes(d));

  const openedMenus = rawPost.openMenus.filter((m) => !pre.openMenuSelectors.includes(m));
  const closedMenus = pre.openMenuSelectors.filter((m) => !rawPost.openMenus.includes(m));

  const newToasts = rawPost.toasts;

  const domAdded = Math.max(0, rawPost.elementCount - pre.elementCount);
  const domRemoved = Math.max(0, pre.elementCount - rawPost.elementCount);
  const textChanged = rawPost.bodyTextLength !== pre.domDigest.length;

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

  const networkRequests = netSlice.map((n) => ({
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

  const consoleErrors = conSlice
    .filter((x) => x.level === 'error' && x.kind === 'console')
    .map((x) => x.text);
  const pageErrors = conSlice.filter((x) => x.kind === 'pageerror').map((x) => x.text);

  return {
    pre,
    finalUrl,
    urlChanged: finalUrl !== pre.url,
    navigated: finalUrl !== pre.url || c.page.url() !== pre.url,
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
      countAfter: rawPost.openDialogs.length,
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
    },
    console: {
      errors: consoleErrors,
      pageErrors,
    },
    targetPostState: rawPost.targetState,
    screenshot: postBuf,
  };
}
