import type { BrowserController } from '../browser/index.js';
import { inspectCurrentUI } from './buttons.js';
import { testReversibleControls } from './reversible.js';
import type { FunctionalContext, FunctionalResult } from './types.js';

/**
 * GENERIC UI-STATE EXPLORATION.
 *
 * A page is not one static DOM. When a safe interaction reveals content (an editor, a dialog, a panel), that content is a
 * UI STATE: it is described, its reversible controls are tested and restored, and the controls that lead to further
 * states are followed, one at a time:
 *
 *    describe state -> test its reversible controls -> for each state-changing control:
 *        safety check -> click -> verify the expected change -> describe the new state -> explore it -> restore -> verify
 *
 * State-changing controls ("navigators") are recognised from structure and semantics only, never from names:
 *    tab         one of a group of sibling choices of which exactly one is marked active (ARIA tabs, or any list whose
 *                items carry an active/selected/current marker)
 *    step        the same, inside something that presents itself as a wizard / stepper
 *    disclosure  a control that declares it expands something (aria-expanded, summary, dropdown / collapse toggles)
 *    next / back wizard movement (followed only by the controlled creation workflow, which drives the wizard itself)
 *
 * Bounded: a maximum depth, a maximum number of states, a maximum number of navigators per state, and every state is
 * identified by a fingerprint of what is visibly there (kinds and labels of controls, active choices, dialogs, headings),
 * so the same state is never explored twice. Nothing here clicks a plain button or link: nothing is saved, confirmed,
 * created or deleted. Every click goes through ActionGuard first.
 */
const MARK = 'data-qa-nav';

/**
 * Verifies that the tab switch has real evidence:
 * A. The clicked tab is marked active (aria-selected, active class, aria-current).
 * B. A panel associated with the tab is visible (via aria-controls, data-pane, or positional relationship).
 * C. A previous panel is no longer the active one.
 * Returns { tabActive, panelVisible, panelId, previousPanelHidden } for the reporting message.
 */
const TAB_VERIFY_SCRIPT = `((navMark, navId) => {
  const el = document.querySelector('[' + navMark + '="' + navId + '"]');
  if (!el) return { tabActive: false, panelVisible: false, panelId: null, evidence: 'no element' };
  const ACTIVE_CLASS = /(^|[\\s_-])(active|selected|current|is-active|ui-tabs-active|ui-state-active)($|[\\s_-])/i;
  const cls = (e) => (typeof e.className === 'string' ? e.className : '');
  const tabActive = el.getAttribute('aria-selected') === 'true' ||
    (el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') ||
    ACTIVE_CLASS.test(cls(el)) ||
    (el.parentElement && ACTIVE_CLASS.test(cls(el.parentElement)));
  // Find associated panel: aria-controls, href=#id, data-pane, data-tab, data-target
  const visible = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const s = getComputedStyle(e); return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || '1') > 0.05; };
  let panelId = null; let panelVisible = false;
  // 1. aria-controls
  const ctrl = el.getAttribute('aria-controls'); if (ctrl) { const p = document.getElementById(ctrl); if (p) { panelId = '#' + ctrl; panelVisible = visible(p); } }
  // 2. href=#id
  if (!panelId) { const href = el.getAttribute('href') || ''; const m = href.match(/^#(.+)$/); if (m) { const p = document.getElementById(m[1]); if (p) { panelId = href; panelVisible = visible(p); } } }
  // 3. data-pane / data-tab / data-target / data-panel / data-target-pane
  if (!panelId) { for (const attr of ['data-pane', 'data-tab', 'data-target', 'data-panel', 'data-target-pane', 'data-tab-target']) { const v = el.getAttribute(attr); if (v) { const p = document.getElementById(v.replace(/^#/, '')); if (p) { panelId = '#' + v.replace(/^#/, ''); panelVisible = visible(p); break; } } } }
  // 4. Panel identified by matching active class inside tab-content or sibling panels
  if (!panelId) {
    const SEL = '[role=tabpanel], .tab-pane, .pane, .panel, .tab-content > div, [data-panel]';
    const activePanels = Array.from(document.querySelectorAll(SEL)).filter((p) => visible(p) && ACTIVE_CLASS.test(cls(p)));
    if (activePanels.length === 1) {
      panelId = activePanels[0].id ? '#' + activePanels[0].id : (activePanels[0].className || 'active-panel');
      panelVisible = true;
    }
  }
  // 5. positional: next sibling or parent's next sibling matching [role=tabpanel], .tab-pane, .pane, .panel
  if (!panelId) {
    const SEL = '[role=tabpanel], .tab-pane, .pane, .panel, .tab-content > div, [data-panel]';
    const list = el.closest('[role=tablist]') || el.parentElement;
    const tabs = list ? Array.from(list.querySelectorAll('[role=tab], a[data-pane], a[href^="#"], li, button')) : [];
    const idx = tabs.indexOf(el) >= 0 ? tabs.indexOf(el) : (el.parentElement ? tabs.indexOf(el.parentElement) : -1);
    if (idx >= 0) {
      const container = list ? (list.nextElementSibling?.matches('.tab-content, .panes, .panels') ? list.nextElementSibling : null) : null;
      const panels = container ? Array.from(container.children) : (list && list.nextElementSibling ? Array.from(list.nextElementSibling.querySelectorAll(':scope > *')) : []);
      if (panels.length === 0 && list && list.parentElement) {
        const sibs = Array.from(list.parentElement.children);
        const listIdx = sibs.indexOf(list);
        const candidatePanels = sibs.slice(listIdx + 1).filter((e) => e.matches(SEL) || e.getAttribute('data-panel') !== null);
        if (candidatePanels.length > 0 && idx < candidatePanels.length) { panelId = 'sibling:' + idx; panelVisible = visible(candidatePanels[idx]); }
      } else if (panels.length > 0 && idx < panels.length) {
        panelId = 'panel:' + idx; panelVisible = visible(panels[idx]);
      }
    }
  }
  return { tabActive, panelVisible, panelId, evidence: tabActive ? (panelVisible ? 'tab+panel' : panelId ? 'tab-only' : 'tab-no-panel-found') : 'not-active' };
})`;

const BASE = { kind: 'button' as const };

export interface ExploreLimits { maxDepth: number; maxStates: number; maxNavigatorsPerState: number }
export const DEFAULT_LIMITS: ExploreLimits = { maxDepth: 3, maxStates: 14, maxNavigatorsPerState: 10 };

export interface Navigator { id: number; kind: 'tab' | 'step' | 'disclosure' | 'next' | 'back'; label: string; group: string; active: boolean; expanded: boolean }
export interface StateSnapshot {
  fingerprint: string;
  /** Visible, in-scope controls: how many of each kind. */
  controls: number; headings: string[]; dialogs: number;
  /** Labels of the choices currently active (tabs, steps). */
  active: string[];
  navigators: Navigator[];
  /** Labels of every clickable thing in scope: what a menu or panel offers, for the record. */
  options: string[];
  /** Validation-looking messages currently shown. */
  messages: string[];
}

const DISCLOSURE_OPTIONS_SCRIPT = `((mark, navId) => {
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || '1') > 0.05;
  };
  const text = (e) => (e ? (e.innerText || e.textContent || '') : '').replace(/\\s+/g, ' ').trim();
  const word = (s) => (/^(\\S\\s)+\\S$/.test(s) ? s.replace(/\\s/g, '') : s);
  const labelOf = (el) => word(el.getAttribute('aria-label') || text(el) || el.getAttribute('title') || el.getAttribute('value') || '').slice(0, 60);

  const trigger = document.querySelector('[' + mark + '="' + navId + '"]');
  const containers = [];
  const MENU_CONTAINER_SEL = '.dropdown-menu, .menu, [role=menu], [role=listbox], .popover, .dropdown-content, .select-options';
  if (trigger) {
    const ctrl = trigger.getAttribute('aria-controls');
    if (ctrl) { const p = document.getElementById(ctrl); if (p && visible(p)) containers.push(p); }
    if (trigger.parentElement) {
      const menus = Array.from(trigger.parentElement.querySelectorAll(MENU_CONTAINER_SEL)).filter((m) => visible(m) && !m.closest('[role=tablist], .tabs, .nav-tabs'));
      containers.push(...menus);
    }
    if (trigger.nextElementSibling && visible(trigger.nextElementSibling) && trigger.nextElementSibling.matches(MENU_CONTAINER_SEL)) {
      containers.push(trigger.nextElementSibling);
    }
  }
  const globalMenus = Array.from(document.querySelectorAll('.dropdown-menu.show, .dropdown-menu.open, .menu.show, .menu.open, [role=menu], [role=listbox], .popover.show, .popover.open')).filter((m) => visible(m) && !m.closest('[role=tablist], .tabs, .nav-tabs'));
  containers.push(...globalMenus);

  const OPT_SEL = 'a, button, [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=option], .dropdown-item, .menu-item';
  const out = [];
  const seen = new Set();
  for (const c of containers) {
    const items = c.matches(OPT_SEL) ? [c] : Array.from(c.querySelectorAll(OPT_SEL));
    for (const item of items) {
      if (!visible(item) || item.disabled || item.getAttribute('aria-disabled') === 'true' || seen.has(item)) continue;
      if (item.closest('[role=tablist], .tabs, .nav-tabs') || item.matches('[role=tab]')) continue;
      const l = labelOf(item);
      if (!l || /^(close|cancel|dismiss)$/i.test(l)) continue;
      seen.add(item);
      const optId = 'opt_' + out.length;
      item.setAttribute('data-qa-opt', optId);
      out.push({ id: optId, label: l });
    }
  }
  return out;
})`;

/**
 * Describes the current state of the REVEALED UI: everything visible that was not on the page when rememberControls()
 * ran (the root baseline). Marks the navigators so they can be clicked. Read-only apart from that marker attribute.
 */
const SNAPSHOT_SCRIPT = `((mark) => {
  const root = window.__qaRootSeen; if (!root) return null;
  const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || '1') > 0.05; };
  const text = (e) => (e ? (e.innerText || e.textContent || '') : '').replace(/\\s+/g, ' ').trim();
  const word = (s) => (/^(\\S\\s)+\\S$/.test(s) ? s.replace(/\\s/g, '') : s);
  const labelOf = (el) => word(el.getAttribute('aria-label') || text(el) || el.getAttribute('title') || el.getAttribute('value') || '').slice(0, 60);
  const norm = (s) => s.toLowerCase().replace(/\\d+/g, '#').replace(/\\s+/g, ' ').trim().slice(0, 40);
  const inScope = (el) => visible(el) && !root.has(el);
  const cls = (el) => (typeof el.className === 'string' ? el.className : '');
  const ACTIVE = /(^|[\\s_-])(active|selected|current|is-active|ui-tabs-active|ui-state-active)($|[\\s_-])/i;
  const isActive = (el) => el.getAttribute('aria-selected') === 'true' || (el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') || ACTIVE.test(cls(el));
  const CLICK = 'a, button, [role=tab], [role=button]';
  document.querySelectorAll('[' + mark + ']').forEach((e) => e.removeAttribute(mark));

  const navs = []; const taken = new Set();
  const add = (el, kind, group, active, expanded) => {
    if (taken.has(el) || navs.length >= 40) return; const l = labelOf(el); if (!l) return;
    taken.add(el); el.setAttribute(mark, String(navs.length));
    navs.push({ id: navs.length, kind, label: l, group, active: !!active, expanded: !!expanded });
  };
  // ---- choice groups: siblings of which exactly one is active (tabs, steps)
  let g = 0;
  const groups = [];
  for (const list of document.querySelectorAll('[role=tablist]')) {
    const tabs = Array.from(list.querySelectorAll('[role=tab]')).filter(inScope);
    if (tabs.length >= 2) groups.push({ list, items: tabs.map((t) => ({ item: t, c: t })) });
  }
  for (const list of document.querySelectorAll('ul, ol, nav, div')) {
    if (list.closest('[role=tablist]') || list.getAttribute('role') === 'tablist') continue;
    // Exclude menus, listboxes, dropdowns, popovers from tab groups
    const isMenuOrDropdown = list.closest('[role=menu], [role=menubar], [role=listbox], .dropdown-menu, .menu, .dropdown, .popover, .dropdown-content, .select-menu, .options-menu') ||
      list.matches('[role=menu], [role=menubar], [role=listbox], .dropdown-menu, .menu, .dropdown, .popover, .dropdown-content, .select-menu, .options-menu') ||
      list.querySelector('[role=menuitem], [role=option], .dropdown-item, .menu-item');
    if (isMenuOrDropdown) continue;

    const kids = Array.from(list.children);
    if (kids.length < 2 || kids.length > 12) continue;
    const items = [];
    for (const k of kids) { const c = k.matches(CLICK) ? k : k.querySelector(CLICK); if (!c || !inScope(c)) { items.length = 0; break; } items.push({ item: k, c }); }
    if (items.length < 2) continue;
    if (items.filter((x) => isActive(x.item) || isActive(x.c)).length !== 1) continue;
    if (/paginat/i.test(cls(list)) || items.every((x) => /^[\\d«»‹›<>]+$/.test(labelOf(x.c)))) continue; // page numbers are not tabs
    // links that lead to other pages are navigation, not choices within this state
    const leaves = items.some((x) => { const h = (x.c.getAttribute('href') || '').trim(); return x.c.tagName === 'A' && h && !h.startsWith('#') && !/^javascript:/i.test(h) && !x.c.getAttribute('data-toggle'); });
    if (leaves) continue;
    groups.push({ list, items });
  }
  for (const grp of groups) {
    if (grp.items.some((x) => taken.has(x.c))) continue;
    const stepper = /wizard|stepper|steps?\\b|progress/i.test(cls(grp.list) + ' ' + cls(grp.list.parentElement || grp.list) + ' ' + (grp.list.getAttribute('aria-label') || ''));
    const name = 'g' + (g++);
    for (const x of grp.items) add(x.c, stepper ? 'step' : 'tab', name, isActive(x.item) || isActive(x.c), false);
  }
  // ---- wizard movement and disclosures / dropdowns / ellipsis / menus / sort
  for (const el of document.querySelectorAll('button, a, [role=button], input[type=button], summary, [aria-expanded], [data-toggle], [data-bs-toggle], [aria-haspopup], .dropdown-toggle, .menu-toggle, [role=combobox]')) {
    if (!inScope(el) || taken.has(el) || el.disabled) continue;
    const l = labelOf(el);
    if (/^(next|continue|proceed|go|start|begin|get started)\\b/i.test(l)) { add(el, 'next', 'wizard', false, false); continue; }
    if (/^(back|prev|previous)\\b/i.test(l)) { add(el, 'back', 'wizard', false, false); continue; }
    const toggle = (el.getAttribute('data-toggle') || el.getAttribute('data-bs-toggle') || '').toLowerCase();
    const expandedAttr = el.getAttribute('aria-expanded');
    const hasPopup = el.getAttribute('aria-haspopup');
    const isMoreOrMenu = /(\\b|_|-)(dropdown|menu|ellipsis|more|kebab|overflow|actions|sort|filter)(\\b|_|-)/i.test(cls(el) + ' ' + (el.id || '') + ' ' + (el.getAttribute('aria-label') || '')) || /^(((\\.\\.\\.|…)|more(\\s+actions|\\s+options)?|actions|menu|options|sort(\\s+by)?|filter))\\b/i.test(l);
    if (el.tagName === 'SUMMARY') add(el, 'disclosure', 'd', false, !!(el.parentElement && el.parentElement.open));
    else if (toggle === 'dropdown' || toggle === 'collapse' || (expandedAttr !== null && (el.getAttribute('aria-controls') || hasPopup)) || (hasPopup && hasPopup !== 'false') || isMoreOrMenu) {
      add(el, 'disclosure', 'd', false, expandedAttr === 'true');
    }
  }

  // ---- what is visibly there, for the fingerprint and the record
  const parts = []; const options = []; const headings = []; let controls = 0;
  for (const el of document.querySelectorAll('input:not([type=hidden]), select, textarea, button, a, [role=button], [role=tab], [role=checkbox], [role=switch], [role=slider], [role=menuitem], [role=option]')) {
    if (!inScope(el)) continue;
    controls++;
    const kind = el.getAttribute('role') || (el.tagName === 'INPUT' ? 'input:' + (el.getAttribute('type') || 'text') : el.tagName.toLowerCase());
    const fieldLabel = el.labels && el.labels.length ? text(el.labels[0]) : '';
    parts.push(kind + '|' + norm(labelOf(el) || fieldLabel || el.getAttribute('name') || ''));
    if (el.matches('a, button, [role=button], [role=menuitem], [role=option], .dropdown-item, .menu-item') && labelOf(el) && options.length < 40) options.push(labelOf(el));
  }
  for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading],legend')) if (inScope(el) && headings.length < 12) headings.push(text(el).slice(0, 60));
  const dialogs = Array.from(document.querySelectorAll('dialog[open],[role=dialog],[aria-modal=true]')).filter(inScope).length;
  const active = navs.filter((n) => n.active).map((n) => n.label);
  const expanded = navs.filter((n) => n.expanded).map((n) => n.label);
  const messages = [];
  for (const el of document.querySelectorAll('[role=alert], [aria-invalid=true], .error, .invalid-feedback, .validation-message, .field-error, .help-block, .has-error')) {
    if (!inScope(el)) continue; const t = text(el).slice(0, 100); if (t && messages.length < 5 && !messages.includes(t)) messages.push(t);
  }
  parts.sort();
  const raw = parts.join(';') + '||' + headings.map(norm).join(';') + '||' + active.map(norm).join(';') + '||' + expanded.map(norm).join(';') + '||' + dialogs;
  let h = 5381; for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) | 0;
  return { fingerprint: (h >>> 0).toString(36) + ':' + parts.length, controls, headings, dialogs, active, navigators: navs, options: Array.from(new Set(options)), messages };
})`;

export async function snapshotState(c: BrowserController): Promise<StateSnapshot | null> {
  return (await c.page.evaluate(`${SNAPSHOT_SCRIPT}(${JSON.stringify(MARK)})`).catch(() => null)) as StateSnapshot | null;
}

interface Run { visited: Set<string>; limits: ExploreLimits; states: string[] }

/** One exploration (the UI revealed by one entry). Create it once and pass it down. */
export const newExploration = (limits: Partial<ExploreLimits> = {}): Run => ({ visited: new Set(), limits: { ...DEFAULT_LIMITS, ...limits }, states: [] });

const same = (a: Navigator, b: Navigator): boolean => a.kind === b.kind && a.label === b.label;

/**
 * Explores the state the revealed UI is in now. `path` is how it was reached (for the record). Returns false when the UI
 * could not be put back the way it was found, so the caller knows the page must be reloaded before anything else.
 */
export async function exploreState(ctx: FunctionalContext, push: (r: FunctionalResult) => void, run: Run, path: string[], depth = 1, known: ReadonlySet<string> = new Set()): Promise<boolean> {
  const { controller: c, guard } = ctx;
  const here = await snapshotState(c);
  if (!here || here.controls === 0) return true;
  if (run.visited.has(here.fingerprint) || run.visited.size >= run.limits.maxStates) return true; // seen before, or the bound is reached
  run.visited.add(here.fingerprint);
  const where = path.join(' > ');
  run.states.push(`${where} [${here.controls} control(s)${here.active.length ? `; active: ${here.active.join(', ')}` : ''}${here.headings[0] ? `; "${here.headings[0]}"` : ''}]`);
  ctx.onAction?.({ type: 'state', target: where, ok: true, detail: `state ${run.visited.size}: ${here.controls} control(s), ${here.navigators.length} state-changing control(s)${here.active.length ? `, active: ${here.active.join(', ')}` : ''}` });
  await inspectCurrentUI(ctx, where, push);

  const key = (n: Navigator): string => `${n.kind}|${n.label}`;
  const inherited = new Set([...known, ...here.navigators.map(key)]);

  // 1. the reversible controls of this state: changed by one step, verified, put back, verified
  await testReversibleControls(ctx, push, { onlyNew: true, openedBy: where, kinds: ['toggle', 'select', 'tab', 'text'] }).catch(() => 0);

  // 1b. If this state reveals options in an open dropdown/menu container: enumerate and exercise them
  const openMenuOptions = (await c.page.evaluate(`(() => {
    const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || '1') > 0.05; };
    const text = (e) => (e ? (e.innerText || e.textContent || '') : '').replace(/\\s+/g, ' ').trim();
    const word = (s) => (/^(\\S\\s)+\\S$/.test(s) ? s.replace(/\\s/g, '') : s);
    const labelOf = (el) => word(el.getAttribute('aria-label') || text(el) || el.getAttribute('title') || el.getAttribute('value') || '').slice(0, 60);
    const MENU_SEL = '.dropdown-menu, .menu, [role=menu], [role=listbox], .popover, .dropdown-content, .select-options';
    const menus = Array.from(document.querySelectorAll(MENU_SEL)).filter((m) => visible(m) && !m.closest('[role=tablist], .tabs, .nav-tabs'));
    const OPT_SEL = 'a, button, [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=option], .dropdown-item, .menu-item';
    const out = [];
    const seen = new Set();
    for (const m of menus) {
      for (const item of m.querySelectorAll(OPT_SEL)) {
        if (!visible(item) || item.disabled || item.getAttribute('aria-disabled') === 'true' || seen.has(item)) continue;
        if (item.closest('[role=tablist], .tabs, .nav-tabs') || item.matches('[role=tab]')) continue;
        const l = labelOf(item);
        if (!l || /^(close|cancel|dismiss)$/i.test(l)) continue;
        seen.add(item);
        const optId = 'menu_opt_' + out.length;
        item.setAttribute('data-qa-menu-opt', optId);
        out.push({ id: optId, label: l });
      }
    }
    return out;
  })()`).catch(() => [])) as { id: string; label: string }[];

  const safeMenuOpts = openMenuOptions.filter((o) => guard.check({ kind: 'click', name: o.label, text: o.label }).allowed);
  for (const opt of safeMenuOpts) {
    if (ctx.budget.exhausted) break;
    const optRef = { selector: `${where} > ${opt.label}`, name: opt.label };
    const optExpected = `Option "${opt.label}" in "${where}" is selected and UI state updates`;

    // Ensure menu is open if it closed from a previous option click
    const isMenuOpen = await c.page.evaluate(`(() => {
      const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || '1') > 0.05; };
      return Array.from(document.querySelectorAll('.dropdown-menu, .menu, [role=menu], [role=listbox], .popover')).some(visible);
    })()`).catch(() => false);

    if (!isMenuOpen) {
      await c.page.evaluate(`((lastLabel) => {
        const btn = Array.from(document.querySelectorAll('button, a, [role=button], [data-toggle=dropdown], [aria-haspopup]')).find(e => {
          const t = (e.innerText || e.textContent || e.getAttribute('aria-label') || '').trim();
          return t === lastLabel || t.startsWith(lastLabel);
        });
        if (btn && btn.getAttribute('aria-expanded') !== 'true') btn.click();
      })(${JSON.stringify(path[path.length - 1] ?? '')})`).catch(() => undefined);
      await c.settle(150);
    }

    if (!ctx.budget.consume()) break;
    const optRawBox = (await c.page.evaluate(`((optId, optLabel) => {
      let el = document.querySelector('[data-qa-menu-opt="' + optId + '"]') || document.querySelector('[data-qa-opt="' + optId + '"]');
      if (!el) {
        const all = Array.from(document.querySelectorAll('a, button, [role=menuitem], [role=option], .dropdown-item, .menu-item, li'));
        el = all.find(e => {
          const t = (e.innerText || e.textContent || e.getAttribute('aria-label') || '').trim();
          return t === optLabel || t.startsWith(optLabel);
        });
      }
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })(${JSON.stringify(opt.id)}, ${JSON.stringify(opt.label)})`).catch(() => null)) as { x: number; y: number; width: number; height: number } | null;
    const optBox = optRawBox ? { ...optRawBox, vpWidth: c.viewport.width, vpHeight: c.viewport.height } : null;

    const optBeforeShot = await c.page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => undefined);
    ctx.onAction?.({
      phase: 'TARGETED',
      type: 'disclosure-option',
      target: `${where} > ${opt.label}`,
      ok: true,
      box: optBox,
      buffer: optBeforeShot,
      expected: optExpected,
    });
    ctx.onAction?.({
      phase: 'CLICKING',
      type: 'click',
      target: `${where} > ${opt.label}`,
      ok: true,
      box: optBox,
      buffer: optBeforeShot,
    });
    await new Promise((r) => setTimeout(r, 50));
    const clickedOpt = (await c.page.evaluate(`((optId, optLabel) => {
      let el = document.querySelector('[data-qa-menu-opt="' + optId + '"]') || document.querySelector('[data-qa-opt="' + optId + '"]');
      if (!el) {
        const all = Array.from(document.querySelectorAll('a, button, [role=menuitem], [role=option], .dropdown-item, .menu-item, li'));
        el = all.find(e => {
          const t = (e.innerText || e.textContent || e.getAttribute('aria-label') || '').trim();
          return t === optLabel || t.startsWith(optLabel);
        });
      }
      if (!el) return { ok: false, error: 'Option element not found' };
      if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(); else el.scrollIntoView({ block: 'nearest' });
      const opts = { bubbles: true, cancelable: true, view: window };
      el.dispatchEvent(new MouseEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new MouseEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.click();
      return { ok: true };
    })(${JSON.stringify(opt.id)}, ${JSON.stringify(opt.label)})`).catch((e) => ({ ok: false, error: String(e) }))) as { ok: boolean; error?: string };

    await c.settle(250); await c.waitForIdle(2000);
    const optPost = await snapshotState(c);
    const optPostShot = await c.page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => undefined);
    const optProof = { before: optBeforeShot, screenshot: optPostShot, trace: { action: `click option "${opt.label}" in "${where}"`, network: [], console: [], changes: [`controls: ${optPost?.controls ?? 0}`] } };

    if (clickedOpt.ok) {
      const optActual = `Option "${opt.label}" was selected in "${where}" (${optPost?.controls ?? 0} control(s) present)`;
      push({ ...BASE, check: 'disclosure-option', status: 'pass', severity: 'info', basis: null, element: optRef, expected: optExpected, actual: optActual, confidence: 'HIGH', ...optProof });
      ctx.onAction?.({
        phase: 'RESULT',
        type: 'disclosure-option',
        target: `${where} > ${opt.label}`,
        ok: true,
        verdict: 'PASS',
        confidence: 'HIGH',
        expected: optExpected,
        actual: optActual,
        buffer: optPostShot,
      });
      await inspectCurrentUI(ctx, `${where} > ${opt.label}`, push);
      if (optPost && optPost.fingerprint !== here.fingerprint) {
        await exploreState(ctx, push, run, [...path, opt.label], depth + 1, inherited);
      }
    } else {
      const optActual = `Option "${opt.label}" could not be selected: ${clickedOpt.error || 'element not found'}`;
      push({ ...BASE, check: 'disclosure-option', status: 'inconclusive', severity: 'info', basis: null, element: optRef, expected: optExpected, actual: optActual, confidence: 'LOW', ...optProof });
    }
  }

  if (depth >= run.limits.maxDepth || ctx.budget.exhausted) return true;

  // 2. the controls that lead to other states. next/back belong to a wizard, which only the creation workflow drives.
  // Only what is NEW in this state is followed from here: the sibling tabs and menus of the state it was reached from
  // belong to that state and are followed there. That keeps the exploration a tree instead of every path between tabs.
  const targets = here.navigators.filter((n) => !known.has(key(n)) && ((n.kind === 'tab' && !n.active) || (n.kind === 'disclosure' && !n.expanded))).slice(0, run.limits.maxNavigatorsPerState);
  for (const want of targets) {
    if (ctx.budget.exhausted || run.visited.size >= run.limits.maxStates) break;
    const now = await snapshotState(c); // marks are refreshed: the DOM may have been re-rendered since
    const nav = now?.navigators.find((n) => same(n, want));
    if (!now || !nav) continue;
    const ref = { selector: `${where} > ${nav.label}`, name: nav.label };
    const expected = nav.kind === 'tab' ? `"${nav.label}" becomes the active tab and its content is shown` : `"${nav.label}" expands and shows its content or options`;
    const decision = guard.check({ kind: 'click', name: nav.label, text: nav.label });
    if (!decision.allowed) {
      push({ ...BASE, check: 'guard', status: 'skipped', severity: 'info', basis: null, element: ref, expected: 'Safe state-changing controls are followed', actual: `Not clicked: ${decision.reason}`, details: { guard: decision } });
      continue;
    }
    if (!ctx.budget.consume()) break;

    // Physical targeting: bring into view
    await c.page.evaluate(`((mark, id) => {
      const el = document.querySelector('[' + mark + '="' + id + '"]');
      if (el) { if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(); else el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    })(${JSON.stringify(MARK)}, ${JSON.stringify(nav.id)})`).catch(() => undefined);

    const rawBox = await c.locate({ css: `[${MARK}="${nav.id}"]` }).boundingBox().catch(() => null);
    const box = rawBox ? { ...rawBox, vpWidth: c.viewport.width, vpHeight: c.viewport.height } : null;
    const before = await c.page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => undefined);

    ctx.onAction?.({
      phase: 'TARGETED',
      type: nav.kind,
      target: nav.label,
      ok: true,
      box,
      buffer: before,
      expected,
    });

    ctx.onAction?.({
      phase: 'CLICKING',
      type: 'click',
      target: nav.label,
      ok: true,
      box,
      buffer: before,
    });

    c.beginAction();
    const click = await c.click({ css: `[${MARK}="${nav.id}"]` });
    await c.settle(250); await c.waitForIdle(2500);
    const after = await snapshotState(c);
    const landed = after?.navigators.find((n) => same(n, nav));
    const changed = !!after && after.fingerprint !== now.fingerprint;
    const afterScreenshot = await c.page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => undefined);
    const proof = { before, screenshot: afterScreenshot, trace: { action: `click "${nav.label}" (${where})`, network: [], console: [], changes: [`state ${now.fingerprint} -> ${after?.fingerprint ?? '(gone)'}`, `active: ${after?.active.join(', ') || 'none'}`] } };

    let entered = false;
    let actualMsg = '';
    if (!click.ok || !after) {
      actualMsg = `"${nav.label}" could not be clicked${click.error ? `: ${click.error.slice(0, 140)}` : ''}`;
      push({ ...BASE, check: nav.kind === 'tab' ? 'tab-switch' : 'disclosure-open', status: 'inconclusive', severity: 'info', basis: null, element: ref, expected, actual: actualMsg, confidence: 'LOW', ...proof });
    } else if (nav.kind === 'tab') {
      const wasActive = now.navigators.filter((n) => n.group === nav.group && n.active).map((n) => n.label);
      // Verify from actual DOM: tab active marker AND corresponding panel visible
      const tabEvidence = (await c.page.evaluate(`${TAB_VERIFY_SCRIPT}(${JSON.stringify(MARK)}, ${JSON.stringify(nav.id)})`).catch(() => null)) as { tabActive: boolean; panelVisible: boolean; panelId: string | null; evidence: string } | null;
      const activeBySnapshot = landed?.active ?? false;
      const tabActive = tabEvidence?.tabActive ?? activeBySnapshot;
      const panelVisible = tabEvidence?.panelVisible ?? false;
      const panelId = tabEvidence?.panelId ?? null;
      const domEvidence = tabEvidence?.evidence ?? (activeBySnapshot ? 'tab-only' : 'not-active');
      if (tabActive && panelVisible) {
        // PASS: tab is marked active AND its associated panel is visible
        entered = true;
        actualMsg = `"${nav.label}" is now the active tab (was: ${wasActive.join(', ') || 'none'}); its panel (${panelId}) is displayed with ${after.controls} control(s)${after.headings[0] ? `, "${after.headings[0]}"` : ''}`;
        push({ ...BASE, check: 'tab-switch', status: 'pass', severity: 'info', basis: null, element: ref, expected, confidence: 'HIGH', actual: actualMsg, ...proof });
      } else if (tabActive && !panelId && changed) {
        // Tab is marked active and content visibly changed, though no distinct panel ID found
        entered = true;
        actualMsg = `"${nav.label}" is now the active tab (was: ${wasActive.join(', ') || 'none'}); content changed (${after.controls} control(s)${after.headings[0] ? `, "${after.headings[0]}"` : ''})`;
        push({ ...BASE, check: 'tab-switch', status: 'pass', severity: 'info', basis: null, element: ref, expected, confidence: 'MEDIUM', actual: actualMsg, ...proof });
      } else {
        // Visual state verification failed: tab not active or panel not visible. NEVER descend into unverified state!
        entered = false;
        actualMsg = !tabActive
          ? `"${nav.label}" was clicked but is not marked active afterwards (dom evidence: ${domEvidence}; active: ${after.active.join(', ') || 'none'}); ${changed ? 'the content did change' : 'nothing else changed'}`
          : `"${nav.label}" is marked active but its panel (${panelId || 'unknown'}) is not visible; ${changed ? 'the content fingerprint changed' : 'nothing else changed'}`;
        push({ ...BASE, check: 'tab-switch', status: 'inconclusive', severity: 'info', basis: null, element: ref, expected, confidence: 'LOW', actual: actualMsg, ...proof });
      }
    } else {
      const fresh = after.options.filter((o) => !now.options.includes(o));
      const hasFresh = fresh.length > 0;
      const isOpen = landed?.expanded || hasFresh || after.controls > now.controls;
      if (isOpen) {
        entered = true;
        const discoveredOptions = (await c.page.evaluate(`${DISCLOSURE_OPTIONS_SCRIPT}(${JSON.stringify(MARK)}, ${JSON.stringify(nav.id)})`).catch(() => [])) as { id: string; label: string }[];
        const optionList = discoveredOptions.length > 0 ? discoveredOptions : fresh.map((l, i) => ({ id: `fresh_${i}`, label: l }));
        const refused = optionList.filter((o) => !guard.check({ kind: 'click', name: o.label, text: o.label }).allowed);
        const safe = optionList.filter((o) => guard.check({ kind: 'click', name: o.label, text: o.label }).allowed);

        actualMsg = `"${nav.label}" opened${optionList.length ? ` and shows: ${optionList.map((o) => o.label).slice(0, 12).join(', ')}` : ` (${after.controls - now.controls} more control(s) shown)`}${refused.length ? `. Not selected, for safety: ${refused.map((o) => o.label).join(', ')}` : ''}`;
        push({ ...BASE, check: 'disclosure-open', status: 'pass', severity: 'info', basis: null, element: ref, expected, confidence: 'HIGH', actual: actualMsg, ...proof });

        // Enumerate and exercise every safe non-destructive option
        for (const opt of safe) {
          if (ctx.budget.exhausted) break;
          const optRef = { selector: `${where} > ${nav.label} > ${opt.label}`, name: opt.label };
          const optExpected = `Option "${opt.label}" in "${nav.label}" is selected and UI state updates`;

          // Re-ensure parent disclosure is open if it closed from a previous option click
          const isOpenNow = await c.page.evaluate(`((navLabel) => {
            const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || '1') > 0.05; };
            const anyOpen = Array.from(document.querySelectorAll('.dropdown-menu.show, .dropdown-menu.open, .menu.show, .menu.open, [role=menu], [role=listbox]')).some(visible);
            if (anyOpen) return true;
            const all = Array.from(document.querySelectorAll('button, a, [role=button], [data-toggle=dropdown], [data-bs-toggle=dropdown], [aria-haspopup], summary'));
            const trigger = all.find(e => {
              const t = (e.innerText || e.textContent || e.getAttribute('aria-label') || '').trim();
              return t === navLabel || t.startsWith(navLabel);
            });
            if (trigger) {
              if (trigger.getAttribute('aria-expanded') === 'true') return true;
              if (trigger.scrollIntoViewIfNeeded) trigger.scrollIntoViewIfNeeded(); else trigger.scrollIntoView({ block: 'nearest' });
              const opts = { bubbles: true, cancelable: true, view: window };
              trigger.dispatchEvent(new MouseEvent('pointerdown', opts));
              trigger.dispatchEvent(new MouseEvent('mousedown', opts));
              trigger.dispatchEvent(new MouseEvent('pointerup', opts));
              trigger.dispatchEvent(new MouseEvent('mouseup', opts));
              trigger.click();
              return false;
            }
            return false;
          })(${JSON.stringify(nav.label)})`).catch(() => false);

          if (!isOpenNow) {
            await c.settle(150);
          }
          await c.page.evaluate(`${DISCLOSURE_OPTIONS_SCRIPT}(${JSON.stringify(MARK)}, ${JSON.stringify(nav.id)})`).catch(() => []);

          if (!ctx.budget.consume()) break;
          const optRawBox = (await c.page.evaluate(`((optId, optLabel) => {
            let el = document.querySelector('[data-qa-opt="' + optId + '"]') || document.querySelector('[data-qa-menu-opt="' + optId + '"]');
            if (!el) {
              const all = Array.from(document.querySelectorAll('a, button, [role=menuitem], [role=option], .dropdown-item, .menu-item, li'));
              el = all.find(e => {
                const t = (e.innerText || e.textContent || e.getAttribute('aria-label') || '').trim();
                return t === optLabel || t.startsWith(optLabel);
              });
            }
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          })(${JSON.stringify(opt.id)}, ${JSON.stringify(opt.label)})`).catch(() => null)) as { x: number; y: number; width: number; height: number } | null;
          const optBox = optRawBox ? { ...optRawBox, vpWidth: c.viewport.width, vpHeight: c.viewport.height } : null;

          const optBeforeShot = await c.page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => undefined);

          ctx.onAction?.({
            phase: 'TARGETED',
            type: 'disclosure-option',
            target: `${nav.label} > ${opt.label}`,
            ok: true,
            box: optBox,
            buffer: optBeforeShot,
            expected: optExpected,
          });
          ctx.onAction?.({
            phase: 'CLICKING',
            type: 'click',
            target: `${nav.label} > ${opt.label}`,
            ok: true,
            box: optBox,
            buffer: optBeforeShot,
          });
          await new Promise((r) => setTimeout(r, 50));

          const clickedOpt = (await c.page.evaluate(`((optId, optLabel) => {
            let el = document.querySelector('[data-qa-opt="' + optId + '"]') || document.querySelector('[data-qa-menu-opt="' + optId + '"]');
            if (!el) {
              const all = Array.from(document.querySelectorAll('a, button, [role=menuitem], [role=option], .dropdown-item, .menu-item, li'));
              el = all.find(e => {
                const t = (e.innerText || e.textContent || e.getAttribute('aria-label') || '').trim();
                return t === optLabel || t.startsWith(optLabel);
              });
            }
            if (!el) return { ok: false, error: 'Option element not found' };
            if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(); else el.scrollIntoView({ block: 'nearest' });
            const opts = { bubbles: true, cancelable: true, view: window };
            el.dispatchEvent(new MouseEvent('pointerdown', opts));
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new MouseEvent('pointerup', opts));
            el.dispatchEvent(new MouseEvent('mouseup', opts));
            el.click();
            return { ok: true };
          })(${JSON.stringify(opt.id)}, ${JSON.stringify(opt.label)})`).catch((e) => ({ ok: false, error: String(e) }))) as { ok: boolean; error?: string };

          await c.settle(250); await c.waitForIdle(2000);
          const optPost = await snapshotState(c);
          const optPostShot = await c.page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => undefined);
          const optProof = { before: optBeforeShot, screenshot: optPostShot, trace: { action: `click option "${opt.label}" in "${nav.label}"`, network: [], console: [], changes: [`controls: ${optPost?.controls ?? 0}`] } };

          if (clickedOpt.ok) {
            const optActual = `Option "${opt.label}" was selected in "${nav.label}" (${optPost?.controls ?? 0} control(s) present)`;
            push({ ...BASE, check: 'disclosure-option', status: 'pass', severity: 'info', basis: null, element: optRef, expected: optExpected, actual: optActual, confidence: 'HIGH', ...optProof });
            ctx.onAction?.({
              phase: 'RESULT',
              type: 'disclosure-option',
              target: `${nav.label} > ${opt.label}`,
              ok: true,
              verdict: 'PASS',
              confidence: 'HIGH',
              expected: optExpected,
              actual: optActual,
              buffer: optPostShot,
            });
            await inspectCurrentUI(ctx, `${nav.label} > ${opt.label}`, push);
            if (optPost && optPost.fingerprint !== now.fingerprint) {
              await exploreState(ctx, push, run, [...path, nav.label, opt.label], depth + 1, inherited);
            }
          } else {
            const optActual = `Option "${opt.label}" could not be selected: ${clickedOpt.error || 'element not found'}`;
            push({ ...BASE, check: 'disclosure-option', status: 'inconclusive', severity: 'info', basis: null, element: optRef, expected: optExpected, actual: optActual, confidence: 'LOW', ...optProof });
          }
        }
      } else {
        entered = false;
        actualMsg = `"${nav.label}" was clicked but no open menu or visible options could be identified on screen`;
        push({ ...BASE, check: 'disclosure-open', status: 'inconclusive', severity: 'info', basis: null, element: ref, expected, confidence: 'LOW', actual: actualMsg, ...proof });
      }
    }

    // Live dashboard event with post-action screenshot
    ctx.onAction?.({
      phase: 'RESULT',
      type: nav.kind === 'tab' ? 'tab-switch' : 'disclosure-open',
      target: nav.label,
      ok: entered,
      verdict: entered ? 'PASS' : 'NEEDS_REVIEW',
      confidence: entered ? 'HIGH' : 'LOW',
      expected,
      actual: actualMsg,
      box,
      buffer: afterScreenshot,
    });

    if (entered) {
      await inspectCurrentUI(ctx, nav.label, push);
    }

    // 3. the state that was reached is explored in turn, then this state is restored and the restoration verified
    if (entered && changed) { if (!(await exploreState(ctx, push, run, [...path, nav.label], depth + 1, inherited))) return false; }
    if (!after || after.fingerprint === now.fingerprint) continue;
    const cur = await snapshotState(c);
    if (nav.kind === 'tab') {
      const home = now.navigators.find((n) => n.group === nav.group && n.active);
      const back = home && cur?.navigators.find((n) => same(n, home));
      if (back && !back.active && guard.check({ kind: 'click', name: back.label, text: back.label }).allowed) {
        await c.page.evaluate(`((mark, id) => {
          const el = document.querySelector('[' + mark + '="' + id + '"]');
          if (el) { if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(); else el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
        })(${JSON.stringify(MARK)}, ${JSON.stringify(back.id)})`).catch(() => undefined);
        await c.click({ css: `[${MARK}="${back.id}"]` });
      }
    } else {
      const again = cur?.navigators.find((n) => same(n, nav));
      if (again?.expanded || (again && !landed?.expanded)) await c.click({ css: `[${MARK}="${again.id}"]` }).catch(() => undefined);
      else await c.press('Escape').catch(() => undefined);
    }
    await c.settle(200); await c.waitForIdle(2000);
    const restored = await snapshotState(c);
    if (!restored || restored.fingerprint !== now.fingerprint) {
      if (nav.kind === 'disclosure') { await c.press('Escape').catch(() => undefined); await c.settle(150); }
      const retry = await snapshotState(c);
      if (!retry || retry.fingerprint !== now.fingerprint) {
        ctx.onAction?.({ type: 'restore', target: nav.label, ok: false, detail: `the state before "${nav.label}" could not be restored; exploration of "${where}" stops here and the page is reloaded` });
        return false;
      }
    }
  }
  return true;
}

/** Closes what was revealed, when it offers an unmistakable close control (never anything that confirms or saves). */
export async function closeRevealed(ctx: FunctionalContext): Promise<boolean> {
  const { controller: c, guard } = ctx;
  const found = (await c.page.evaluate(`(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity || '1') > 0.05; };
    document.querySelectorAll('[data-qa-close]').forEach((e) => e.removeAttribute('data-qa-close'));
    const isClose = (l) => /^(close|cancel|dismiss|no thanks|not now|×|✕|x)$/i.test(l);
    // 1. Look for close button inside any visible overlay, modal, sheet, popup, drawer, dialog or active pane
    const containers = Array.from(document.querySelectorAll('.show, .open, [aria-modal=true], dialog[open], [role=dialog], .modal, .sheet, .popup, .drawer, .pane.active, [data-qa-revealed]')).filter(visible);
    for (const cont of containers) {
      for (const el of cont.querySelectorAll('button, a, [role=button], input[type=button]')) {
        if (!visible(el)) continue;
        const l = (el.getAttribute('aria-label') || el.innerText || el.textContent || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim();
        if (isClose(l) || /close|dismiss/i.test(el.className)) {
          el.setAttribute('data-qa-close', '1');
          return l || 'close';
        }
      }
    }
    // 2. Look for any visible close/cancel buttons on page
    for (const el of document.querySelectorAll('button, a, [role=button], input[type=button]')) {
      if (!visible(el)) continue;
      const l = (el.getAttribute('aria-label') || el.innerText || el.textContent || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim();
      if (isClose(l) || /close|dismiss/i.test(el.className)) {
        el.setAttribute('data-qa-close', '1');
        return l || 'close';
      }
    }
    return null;
  })()`).catch(() => null)) as string | null;
  if (!found || !guard.check({ kind: 'click', name: found, text: found }).allowed) return false;
  const r = await c.click({ css: '[data-qa-close="1"]' });
  await c.settle(200);
  return r.ok;
}
