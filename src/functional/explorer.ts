import type { BrowserController } from '../browser/index.js';
import { normalizeUrl, sameOrigin, samePage } from '../discovery/crawler.js';
import { buildPageModel } from '../discovery/pageModel.js';
import { inspectCurrentUI } from './buttons.js';
import { sameViewUrl, viewSignature } from './helpers.js';
import { testReversibleControls } from './reversible.js';
import { inspectDialog, resolveUnexpectedDialog } from './sensitive.js';
import type { FunctionalContext, FunctionalResult } from './types.js';

/**
 * The element of THIS document that a control names as what it shows: the target of a fragment link (href="#pane-id"),
 * or of aria-controls / data-target. Such a control switches a panel in place. Its href is not an address of the
 * application, even where the application's own routes are fragments too (#section/page), so the browser staying at the
 * same address after a click on it is the expected outcome, not a navigation that failed.
 */
const IN_PAGE_JS = `const inPageTarget = (el) => {
    if (!el || !el.getAttribute) return null;
    const ids = [];
    const h = el.tagName === 'A' ? (el.getAttribute('href') || '') : '';
    if (h.length > 1 && h.charAt(0) === '#') ids.push(h.slice(1));
    for (const a of ['aria-controls', 'data-target', 'data-bs-target']) { const v = (el.getAttribute(a) || '').replace(/^#/, ''); if (v) ids.push(v); }
    for (const id of ids) {
      let found = null;
      try { found = document.getElementById(decodeURIComponent(id)); } catch (e) { found = document.getElementById(id); }
      if (found && found !== el && !found.contains(el)) return found;
    }
    return null;
  };`;

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
  /** What the revealed UI shows (its visible text), reduced to a comparable value. Two views with the same controls but different content are different states. */
  content: string;
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

  ${IN_PAGE_JS}
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
      const link = item.tagName === 'A';
      out.push({ id: optId, label: l, href: link ? item.getAttribute('href') : null, url: link ? item.href : null, inPage: !!inPageTarget(item) });
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
    // An item INSIDE a menu is a choice, not something that opens a menu, unless it declares so itself (a nested submenu).
    // Its class often contains "dropdown" or "menu" (dropdown-item, menu-item): that wording alone does not make it a trigger.
    const isChoice = !!el.closest('.dropdown-menu, [role=menu], [role=listbox], .dropdown-content, .select-options') || el.matches('[role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=option]');
    if (el.tagName === 'SUMMARY') add(el, 'disclosure', 'd', false, !!(el.parentElement && el.parentElement.open));
    else if (toggle === 'dropdown' || toggle === 'collapse' || (expandedAttr !== null && (el.getAttribute('aria-controls') || hasPopup)) || (hasPopup && hasPopup !== 'false') || (isMoreOrMenu && !isChoice)) {
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
  // the text the revealed UI shows (leaf elements only, bounded)
  let ch = 5381; let cn = 0; let looked = 0;
  for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,h6,legend,label,th,td,p,li,dt,dd,span,a,button,strong,em,b,[role=heading]')) {
    if (cn >= 400 || looked >= 1500) break;
    // membership first (a set lookup); "is it displayed" needs layout and is asked only for what the interaction revealed
    if (el.children.length > 0 || root.has(el)) continue;
    looked++;
    if (!visible(el)) continue;
    const t = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80); if (!t) continue;
    cn++; for (let i = 0; i < t.length; i++) ch = ((ch << 5) + ch + t.charCodeAt(i)) | 0;
  }
  return { fingerprint: (h >>> 0).toString(36) + ':' + parts.length, controls, headings, dialogs, active, navigators: navs, content: (ch >>> 0).toString(36) + ':' + cn, options: Array.from(new Set(options)), messages };
})`;

export async function snapshotState(c: BrowserController): Promise<StateSnapshot | null> {
  return (await c.page.evaluate(`${SNAPSHOT_SCRIPT}(${JSON.stringify(MARK)})`).catch(() => null)) as StateSnapshot | null;
}

interface Run {
  visited: Set<string>; limits: ExploreLimits; states: string[];
  /** Options already executed in this exploration. A menu reached by two mechanisms is still gone through once. */
  done: Set<string>;
  /** Menu items with a destination that were followed (bounded per exploration). */
  followed: number;
  /** Opens the control this exploration started from again, when following one of its items closed it. */
  reopen?: () => Promise<void>;
}

/** A menu item. `href`/`url`: its raw and resolved destination when it is a link. */
interface MenuOption { id: string; label: string; href?: string | null; url?: string | null; /** it names an element of this document as what it shows (a panel switched in place) */ inPage?: boolean }
const optionKey = (o: MenuOption): string => `${o.label}|${o.href ?? ''}`;
const MAX_FOLLOWED_LINKS = 40;

/**
 * Where a menu item leads, when it is a link to another view of this application: a same-origin address that is not the
 * view we are on. null for an item that acts in place (href="#", javascript:, a button), which is exercised as an option.
 */
function destinationOf(o: MenuOption, current: string): string | null {
  const raw = (o.href ?? '').trim();
  if (!raw || raw === '#' || /^javascript:/i.test(raw) || !o.url) return null;
  if (o.inPage) return null; // href="#pane": a panel of this document, whatever the application's routes look like
  const n = normalizeUrl(o.url, current, { hashRouted: true });
  if (!n || !sameOrigin(n, current) || samePage(n, current)) return null;
  // an anchor inside this same document (#section) is not another view
  try { const a = new URL(n); const b = new URL(current); if (a.pathname === b.pathname && a.search === b.search && a.hash.length > 1 && !a.hash.includes('/') && !/^#!/.test(a.hash) && b.hash.length <= 1) return null; } catch { return null; }
  return n;
}

const CLICK_OPTION_SCRIPT = `((optId, optLabel, href) => {
  const text = (e) => (e ? (e.innerText || e.textContent || '') : '').replace(/\\s+/g, ' ').trim();
  const word = (x) => (/^(\\S\\s)+\\S$/.test(x) ? x.replace(/\\s/g, '') : x);
  const labelOf = (e) => word(e.getAttribute('aria-label') || text(e) || e.getAttribute('title') || e.getAttribute('value') || '').slice(0, 60);
  // A mark left by an earlier look at ANOTHER menu can carry the same id: the element is the option only if it also has
  // the option's label. Otherwise the option is looked up by what it is called.
  const byMark = [document.querySelector('[data-qa-menu-opt="' + optId + '"]'), document.querySelector('[data-qa-opt="' + optId + '"]')].find((e) => e && labelOf(e) === optLabel) || null;
  let el = byMark;
  // by destination only when it is one: "#" and javascript: are shared by every in-place control of the page
  if (!el && href && href !== '#' && !/^javascript:/i.test(href)) el = Array.from(document.querySelectorAll('a')).find((a) => a.getAttribute('href') === href) || null;
  if (!el) {
    // the control itself before any wrapper around it: a click on the <li> does not reach a handler on its <a>
    const controls = Array.from(document.querySelectorAll('a, button, [role=menuitem], [role=menuitemradio], [role=option], .dropdown-item, .menu-item'));
    el = controls.find((e) => labelOf(e) === optLabel) || Array.from(document.querySelectorAll('li')).find((e) => labelOf(e) === optLabel) || null;
  }
  if (!el) return { ok: false, error: 'Option element not found' };
  if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(); else el.scrollIntoView({ block: 'nearest' });
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, view: window };
  el.dispatchEvent(new MouseEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new MouseEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.click();
  return { ok: true, box: { x: r.x, y: r.y, width: r.width, height: r.height } };
})`;

/**
 * A menu item that leads to another view: it is followed ONCE per run (the same destination offered by the menu of every
 * page is not followed again), and it passes only when the browser is at the destination and another view is shown.
 * The destination becomes a page of the run, so its own controls are tested there, in its own time share. Then the view
 * the menu belongs to is restored. Returns false when that view could not be restored (the caller reloads the page).
 */
async function followMenuLink(ctx: FunctionalContext, push: (r: FunctionalResult) => void, run: Run, where: string, opt: MenuOption, dest: string): Promise<boolean> {
  const c = ctx.controller;
  if (ctx.testedLinks?.has(dest)) return true;
  // the destination itself goes through the safety guard, exactly as a link the crawler would follow
  const decision = ctx.guard.check({ kind: 'click', name: opt.label, text: opt.label, href: dest, role: 'link' });
  if (!decision.allowed) {
    push({ kind: 'link', check: 'guard', status: 'skipped', severity: 'info', basis: null, element: { selector: `${where} > ${opt.label}`, name: opt.label, role: 'link' }, expected: 'Safe menu items are followed', actual: `Not followed: ${decision.reason}`, details: { guard: decision } });
    return true;
  }
  if (run.followed >= MAX_FOLLOWED_LINKS || !ctx.budget.consume()) return true;
  ctx.testedLinks?.add(dest);
  run.followed++;
  const ref = { selector: `${where} > ${opt.label}`, name: opt.label, role: 'link' };
  const expected = `"${opt.label}" in "${where}" opens ${dest}`;
  const home = c.page.url();
  const viewBefore = await viewSignature(c);
  const before = await c.page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => undefined);
  ctx.onAction?.({ phase: 'TARGETED', type: 'menu-navigation', target: `${where} > ${opt.label}`, ok: true, buffer: before, expected });
  c.beginAction();
  const clicked = (await c.page.evaluate(`${CLICK_OPTION_SCRIPT}(${JSON.stringify(opt.id)}, ${JSON.stringify(opt.label)}, ${JSON.stringify(opt.href ?? '')})`).catch((e) => ({ ok: false, error: String(e) }))) as { ok: boolean; error?: string };
  await c.settle(250); await c.waitForIdle(2500);
  const landed = c.page.url();
  const reached = samePage(landed, dest);
  const changed = (await viewSignature(c)) !== viewBefore;
  const after = await c.page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => undefined);
  const proof = { before, screenshot: after, trace: { action: `click menu item "${opt.label}" in "${where}"`, urlBefore: home, urlAfter: landed, network: [], console: [], changes: [`address: ${home} -> ${landed}`, changed ? 'the view shown changed' : 'the view shown did not change'] } };

  let actual: string; let ok = false;
  if (!clicked.ok) {
    actual = `"${opt.label}" could not be clicked: ${clicked.error ?? 'element not found'}`;
    push({ kind: 'link', check: 'menu-navigation', status: 'inconclusive', severity: 'info', basis: null, element: ref, expected, actual, confidence: 'LOW', ...proof });
  } else if (reached && changed) {
    ok = true;
    const title = ((await c.page.evaluate("((document.querySelector('h1,h2,[role=heading]') || {}).textContent || document.title || '').replace(/\\s+/g, ' ').trim().slice(0, 80)").catch(() => '')) as string);
    const model = await buildPageModel(c).catch(() => null);
    const scheduled = model ? ctx.onDiscoveredPage?.({ url: dest, label: opt.label, title, model }) : undefined;
    actual = `"${opt.label}" opened ${dest}${title ? ` ("${title}")` : ''}: the destination view was shown${scheduled ? '; it is tested as a page of its own' : ''}`;
    push({ kind: 'link', check: 'menu-navigation', status: 'pass', severity: 'info', basis: null, element: ref, expected, actual, confidence: 'HIGH' });
  } else {
    // Not a verified navigation: the address or the view did not follow. Never reported as a pass.
    actual = `"${opt.label}" -> ${dest} could not be verified: ${reached ? 'the address changed, but the view shown did not' : `the browser is at ${c.url}, not at the destination${changed ? ' (the content did change)' : ''}`}`;
    push({ kind: 'link', check: 'menu-navigation', status: 'inconclusive', severity: 'info', basis: null, element: ref, expected, actual, confidence: 'LOW', ...proof });
  }
  ctx.onAction?.({ phase: 'RESULT', type: 'menu-navigation', target: `${where} > ${opt.label}`, ok, verdict: ok ? 'PASS' : 'NEEDS_REVIEW', confidence: ok ? 'HIGH' : 'LOW', expected, actual, buffer: after });

  // back to the view the menu belongs to
  if (c.page.url() !== home) { await c.page.goBack().catch(() => null); await c.settle(250); await c.waitForIdle(2500); }
  if (!sameViewUrl(c.page.url(), home)) {
    ctx.onAction?.({ type: 'restore', target: opt.label, ok: false, detail: `the view before "${opt.label}" could not be restored by going back; the page is reloaded` });
    return false;
  }
  await run.reopen?.().catch(() => undefined);
  return true;
}

/** One exploration (the UI revealed by one entry). Create it once and pass it down. */
/**
 * The PLAIN controls of a revealed view that switch what it shows: a list of links ("Users / Groups / Organizations"),
 * a row of buttons that each show another section, a tree. They carry no tab role, no active marker and no menu, so
 * nothing else in the explorer follows them; without this the view would be opened, described and left.
 *
 * Structure only, never names: the control is new in this state (it was not on the page before the entry interaction),
 * it acts in place or leads to another view of this application, it is not a tab / menu trigger / menu item already
 * handled, and it is either a link or one of at least two sibling controls of the same kind. Submit buttons, field
 * controls and close / cancel / wizard movement are left out. Whether it may be CLICKED is decided afterwards by
 * ActionGuard and the action-verb rule; here it is only found.
 */
const VIEW_CONTROLS_SCRIPT = `((navMark, max) => {
  const root = window.__qaRootSeen; if (!root) return [];
  const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || '1') > 0.05; };
  const text = (e) => (e ? (e.innerText || e.textContent || '') : '').replace(/\\s+/g, ' ').trim();
  const word = (s) => (/^(\\S\\s)+\\S$/.test(s) ? s.replace(/\\s/g, '') : s);
  const labelOf = (el) => word(el.getAttribute('aria-label') || text(el) || el.getAttribute('title') || el.getAttribute('value') || '').slice(0, 60);
  const SEL = 'a, button, [role=button], [role=link], [role=treeitem]';
  const MENU = '.dropdown-menu, .menu, [role=menu], [role=listbox], .popover, .dropdown-content, .select-options';
  const eligible = (el) => {
    if (!visible(el) || root.has(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    if (el.hasAttribute(navMark) || el.hasAttribute('data-qa-menu-opt')) return false; // a tab, a menu trigger or a menu item: followed elsewhere
    if (el.matches('[role=tab]') || el.closest('[role=tablist]') || el.closest(MENU)) return false;
    if (el.matches('[data-toggle=dropdown], [data-bs-toggle=dropdown], [aria-haspopup], summary')) return false;
    if (el.tagName === 'BUTTON' && (el.getAttribute('type') || '').toLowerCase() === 'submit') return false;
    if (el.querySelector('input, select, textarea')) return false;
    const l = labelOf(el);
    if (!l || l.length > 60) return false;
    return !/^(close|cancel|dismiss|back|prev|previous|next|continue|×|✕|x)$/i.test(l);
  };
  const all = Array.from(document.querySelectorAll(SEL)).filter(eligible);
  ${IN_PAGE_JS}
  const out = []; const batch = 'view_' + Date.now().toString(36) + '_';
  for (const el of all) {
    // its peers: the controls of the same kind that share its list / row / group
    const item = el.closest('li, [role=treeitem], [role=listitem]') || el;
    const box = item.parentElement;
    const peers = box ? all.filter((o) => { const i = o.closest('li, [role=treeitem], [role=listitem]') || o; return i.parentElement === box; }) : [el];
    const link = el.tagName === 'A' || ['link', 'treeitem'].includes(el.getAttribute('role') || '');
    if (!link && peers.length < 2) continue; // a lone button: its purpose is not established by structure
    const id = batch + out.length;
    el.setAttribute('data-qa-menu-opt', id);
    out.push({ id, label: labelOf(el), href: el.tagName === 'A' ? el.getAttribute('href') : null, url: el.tagName === 'A' ? el.href : null, peers: peers.length, inPage: !!inPageTarget(el) });
    if (out.length >= max) break;
  }
  return out;
})`;

/**
 * Labels that name a COMMAND rather than a place: pressing such a plain button or link inside an opened view could start
 * an operation even where nothing is sent to the server. They are recorded as not pressed. (Create, save, delete and the
 * like are refused by ActionGuard itself; this covers the commands that are not dangerous enough to be on its list.)
 */
const COMMAND_LABEL = /^(add|apply|send|import|export|download|print|enable|disable|reset|approve|reject|upload|invite|generate|run|execute|start|stop|sync|ok|okay|done|finish|grant|revoke|lock|unlock|activate|deactivate|archive|restore|merge|move|rename|post|new|clear|select all|deselect all|check all|uncheck all)\b/i;

export const newExploration = (limits: Partial<ExploreLimits> = {}): Run => ({ visited: new Set(), limits: { ...DEFAULT_LIMITS, ...limits }, states: [], done: new Set(), followed: 0 });

const same = (a: Navigator, b: Navigator): boolean => a.kind === b.kind && a.label === b.label;

interface Exercised { opt: MenuOption; wasActive: boolean }

/** What a menu option looks at before and after it is selected: the page OUTSIDE its menu, and the option's own marking. */
interface OptionView { found: boolean; active: boolean; sig: string; url: string; dialogs: number; /** every visible heading, joined */ heading: string; headings: string[]; box: { x: number; y: number; width: number; height: number } | null; /** the panel of this document the option names, and whether it is displayed */ target: { id: string; shown: boolean } | null }

/**
 * Evidence for "selecting this option did something". The menu closing after a choice is not evidence, so the text and
 * form values are read everywhere EXCEPT inside the menu the option belongs to. Also: where the browser is, how many
 * dialogs are shown, the first heading, and whether the option itself is marked as the selected choice.
 */
const OPTION_VIEW_SCRIPT = `((optId, optLabel, href) => {
  const text = (e) => (e ? (e.innerText || e.textContent || '') : '').replace(/\\s+/g, ' ').trim();
  const word = (x) => (/^(\\S\\s)+\\S$/.test(x) ? x.replace(/\\s/g, '') : x);
  const labelOf = (e) => word(e.getAttribute('aria-label') || text(e) || e.getAttribute('title') || e.getAttribute('value') || '').slice(0, 60);
  // A mark left by an earlier look at ANOTHER menu can carry the same id: the element is the option only if it also has
  // the option's label. Otherwise the option is looked up by what it is called.
  const byMark = [document.querySelector('[data-qa-menu-opt="' + optId + '"]'), document.querySelector('[data-qa-opt="' + optId + '"]')].find((e) => e && labelOf(e) === optLabel) || null;
  let el = byMark;
  if (!el && href && href !== '#' && !/^javascript:/i.test(href)) el = Array.from(document.querySelectorAll('a')).find((a) => a.getAttribute('href') === href) || null;
  if (!el) el = Array.from(document.querySelectorAll('a, button, [role=menuitem], [role=menuitemradio], [role=option], .dropdown-item, .menu-item')).find((e) => labelOf(e) === optLabel) || null;
  document.querySelectorAll('[data-qa-menu-root]').forEach((e) => e.removeAttribute('data-qa-menu-root'));
  const menu = el ? el.closest('ul, ol, menu, [role=menu], [role=listbox], .dropdown-menu, .menu, .popover, .dropdown-content, .select-options') : null;
  if (menu) menu.setAttribute('data-qa-menu-root', '1');
  const ACTIVE = /(^|[\\s_-])(active|selected|current|is-active|checked)($|[\\s_-])/i;
  const marked = (e) => !!e && (e.getAttribute('aria-selected') === 'true' || e.getAttribute('aria-checked') === 'true' || (!!e.getAttribute('aria-current') && e.getAttribute('aria-current') !== 'false') || ACTIVE.test(typeof e.className === 'string' ? e.className : ''));
  const shown = (e) => (e.checkVisibility ? e.checkVisibility({ visibilityProperty: true }) : e.getClientRects().length > 0);
  let h = 5381; let n = 0;
  const add = (t) => { n++; for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode()) && n < 20000) {
    const t = node.nodeValue.trim(); if (!t) continue;
    const parent = node.parentElement;
    if (!parent || parent.closest('[data-qa-menu-root], script, style, noscript, template') || !shown(parent)) continue;
    add(t);
  }
  let fields = 0;
  for (const f of document.querySelectorAll('input:not([type=hidden]):not([type=password]), select, textarea')) {
    if (fields >= 300) break;
    if (f.closest('[data-qa-menu-root]') || !shown(f)) continue;
    fields++; add('|' + (f.type === 'checkbox' || f.type === 'radio' ? (f.checked ? '1' : '0') : String(f.value || '').slice(0, 60)));
  }
  // which panels and tabs are shown also counts when their text happens to be equal. (Not aria-expanded or "open"
  // classes: the menu's own trigger changes those when the menu closes, which says nothing about the option.)
  for (const e of document.querySelectorAll('[role=tabpanel], [role=tab], .tab-pane')) { if (!e.closest('[data-qa-menu-root]')) add((e.id || '') + ':' + (shown(e) ? 1 : 0) + ':' + (e.getAttribute('aria-selected') || '')); }
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,legend,[role=heading]')).filter((e) => !e.closest('[data-qa-menu-root]') && shown(e)).slice(0, 20)
    .map((e) => (e.innerText || e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60)).filter(Boolean);
  const r = el ? el.getBoundingClientRect() : null;
  ${IN_PAGE_JS}
  const named = el ? inPageTarget(el) : null;
  return {
    target: named ? { id: named.id || '', shown: shown(named) && named.getClientRects().length > 0 } : null,
    found: !!el, active: !!el && (marked(el) || marked(el.parentElement)), sig: n + ':' + (h >>> 0).toString(36), url: location.href,
    dialogs: Array.from(document.querySelectorAll('dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]')).filter(shown).length,
    heading: headings.join(' | '), headings,
    box: r && r.width > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
  };
})`;

const viewOf = (c: BrowserController, o: MenuOption): Promise<OptionView | null> =>
  (c.page.evaluate(`${OPTION_VIEW_SCRIPT}(${JSON.stringify(o.id)}, ${JSON.stringify(o.label)}, ${JSON.stringify(o.href ?? '')})`) as Promise<OptionView>).catch(() => null);

const REOPEN_SCRIPT = `((label) => {
  const all = Array.from(document.querySelectorAll('button, a, [role=button], [data-toggle=dropdown], [data-bs-toggle=dropdown], [aria-haspopup], summary'));
  const trigger = all.find((e) => { const t = (e.innerText || e.textContent || e.getAttribute('aria-label') || '').trim(); return t === label || t.startsWith(label); });
  if (!trigger || trigger.getAttribute('aria-expanded') === 'true') return false;
  if (trigger.scrollIntoViewIfNeeded) trigger.scrollIntoViewIfNeeded(); else trigger.scrollIntoView({ block: 'nearest' });
  const opts = { bubbles: true, cancelable: true, view: window };
  trigger.dispatchEvent(new MouseEvent('pointerdown', opts));
  trigger.dispatchEvent(new MouseEvent('mousedown', opts));
  trigger.dispatchEvent(new MouseEvent('pointerup', opts));
  trigger.dispatchEvent(new MouseEvent('mouseup', opts));
  trigger.click();
  return true;
})`;

/** Selecting one option usually closes the menu: open it again (through its trigger) when the next option is not on screen. */
async function ensureOptionVisible(ctx: FunctionalContext, opt: MenuOption, triggerLabel: string, remark?: () => Promise<void>): Promise<void> {
  const c = ctx.controller;
  const open = await c.page.evaluate(`((id, label) => {
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const s = getComputedStyle(e); return s.visibility !== 'hidden' && s.display !== 'none'; };
    const called = (e) => !!e && (e.getAttribute('aria-label') || e.innerText || e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60) === label;
    // the option itself is on screen (a mark with the same id on another menu's item does not count)
    if ([document.querySelector('[data-qa-menu-opt="' + id + '"]'), document.querySelector('[data-qa-opt="' + id + '"]')].some((e) => called(e) && vis(e))) return true;
    return Array.from(document.querySelectorAll('a, button, [role=menuitem], [role=menuitemradio], [role=option], .dropdown-item, .menu-item')).some((e) => called(e) && vis(e));
  })(${JSON.stringify(opt.id)}, ${JSON.stringify(opt.label)})`).catch(() => false);
  if (open) return;
  if (!triggerLabel) return;
  await c.page.evaluate(`${REOPEN_SCRIPT}(${JSON.stringify(triggerLabel)})`).catch(() => false);
  await c.settle(150);
  await remark?.();
}

/** What is left unexplored, and why, is said: a limit that was reached must not read as complete coverage. */
function notExplored(ctx: FunctionalContext, where: string, reason: string, labels: string[]): void {
  if (labels.length === 0) return;
  ctx.onAction?.({ type: 'not-explored', target: where, ok: false, detail: `NOT EXPLORED (${reason}): ${[...new Set(labels)].slice(0, 20).join(', ')}${labels.length > 20 ? `, and ${labels.length - 20} more` : ''}` });
}

/**
 * ONE option of an open menu: a recorded action of its own, with its own verification. Seeing the option in the menu proves
 * nothing about it, and neither does a click that did not throw. It passes when selecting it is SEEN to do something
 * outside the menu (content, form values, shown panels, a dialog, the address) or to become the marked choice; an option
 * that is already the marked choice and changes nothing is verified as that. Anything else is inconclusive, never a pass.
 */
async function exerciseOption(
  ctx: FunctionalContext, push: (r: FunctionalResult) => void, run: Run,
  a: { opt: MenuOption; menu: string; target: string; ensureOpen: () => Promise<void>; check?: string },
): Promise<{ verified: boolean; changed: boolean; stopped?: boolean; pre: OptionView | null }> {
  const c = ctx.controller;
  const { opt } = a;
  const ref = { selector: a.target, name: opt.label };
  const expected = `Selecting "${opt.label}" in "${a.menu}" shows its view or changes what is selected`;
  await a.ensureOpen();
  if (!ctx.budget.consume()) { run.done.delete(optionKey(opt)); return { verified: false, changed: false, stopped: true, pre: null }; }
  const pre = await viewOf(c, opt);
  const blockedBefore = c.blockedRequests.length;
  const dialogBefore = (await inspectDialog(c))?.key ?? null;
  const box = pre?.box ? { ...pre.box, vpWidth: c.viewport.width, vpHeight: c.viewport.height } : null;
  const before = await c.page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => undefined);
  ctx.onAction?.({ phase: 'TARGETED', type: 'disclosure-option', target: a.target, ok: true, box, buffer: before, expected });
  ctx.onAction?.({ phase: 'CLICKING', type: 'click', target: a.target, ok: true, box, buffer: before });
  c.beginAction();
  const clicked = (await c.page.evaluate(`${CLICK_OPTION_SCRIPT}(${JSON.stringify(opt.id)}, ${JSON.stringify(opt.label)}, ${JSON.stringify(opt.href ?? '')})`).catch((e) => ({ ok: false, error: String(e) }))) as { ok: boolean; error?: string };
  await c.settle(250); await c.waitForIdle(2000);
  // a warning / confirmation that the application raised is identified and declined, never accepted; nothing is judged
  const surprise = clicked.ok ? await resolveUnexpectedDialog(ctx, dialogBefore).catch(() => null) : null;
  if (surprise) {
    const shot = await c.page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => undefined);
    const said = `After selecting "${opt.label}" in "${a.menu}", an unexpected ${surprise.dialog.type} dialog appeared ("${surprise.dialog.text.slice(0, 120)}"); ${surprise.how}. Nothing was confirmed, so what "${opt.label}" shows is not verified`;
    push({ ...BASE, check: 'unexpected-dialog', status: 'inconclusive', severity: 'info', basis: null, element: ref, expected, actual: said, confidence: 'LOW', before, screenshot: shot });
    ctx.onAction?.({ phase: 'RESULT', type: 'unexpected-dialog', target: a.target, ok: false, verdict: 'NEEDS_REVIEW', confidence: 'LOW', expected, actual: said, buffer: shot });
    return { verified: false, changed: false, pre };
  }
  const post = await viewOf(c, opt);
  const after = await c.page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => undefined);

  const changes: string[] = [];
  if (pre && post) {
    if (post.url !== pre.url) changes.push(`the address changed (${c.redactor.redactUrl(pre.url)} -> ${c.redactor.redactUrl(post.url)})`);
    const shownNow = post.headings.find((h) => !pre.headings.includes(h));
    if (post.sig !== pre.sig) changes.push(`the content shown outside the menu changed${shownNow ? ` (now showing "${shownNow}")` : ''}`);
    if (post.dialogs > pre.dialogs) changes.push('a dialog opened');
    if (!pre.active && post.active) changes.push(`"${opt.label}" is now marked as the selected choice`);
    if (pre.target && post.target && !pre.target.shown && post.target.shown) changes.push(`the panel it names (#${post.target.id}) is now displayed`);
  }
  // Requests of THIS action that the safety policy stopped. An endpoint that was already stopped while the page loaded
  // (the application shell asking for its own data, a poll that repeats) is not this action's request.
  const endpoint = (b: { method: string; url: string }): string => { try { return `${b.method} ${new URL(b.url).pathname}`; } catch { return `${b.method} ${b.url}`; } };
  const atLoad = new Set(c.blockedRequests.filter((b) => b.phase === 'page-load').map(endpoint));
  const stopped = [...new Set(c.blockedRequests.slice(blockedBefore).filter((b) => b.phase === 'action' && !atLoad.has(endpoint(b))).map(endpoint))];
  const proof = { before, screenshot: after, trace: { action: `select "${opt.label}" in "${a.menu}"`, urlBefore: pre?.url, urlAfter: post?.url, network: [], console: [], changes: changes.length > 0 ? changes : ['nothing changed outside the menu'] } };

  let status: 'pass' | 'inconclusive' | 'blocked'; let actual: string; let confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  if (!clicked.ok || !pre || !post) {
    status = 'inconclusive'; confidence = 'LOW';
    actual = `Option "${opt.label}" could not be selected: ${clicked.error || 'the page could not be read before and after'}`;
  } else if (stopped.length > 0) {
    // The control responded, but what it shows depends on data the platform did not let through: not a pass.
    status = 'blocked'; confidence = 'HIGH';
    actual = `Option "${opt.label}" was selected in "${a.menu}"${changes.length > 0 ? ` (${changes.join('; ')})` : ''}, but the QA safety policy blocked the request it sent (${stopped.slice(0, 3).join(', ')}), so the data of this view did not load and its content is not verified`;
  } else if (changes.length > 0) {
    status = 'pass'; confidence = 'HIGH';
    actual = `Option "${opt.label}" was selected in "${a.menu}": ${changes.join('; ')}`;
  } else if (pre.active) {
    status = 'pass'; confidence = 'MEDIUM';
    actual = `Option "${opt.label}" is already the selected choice in "${a.menu}" (it is marked active): selecting it again changed nothing, as expected`;
  } else if (pre.target?.shown && post.target?.shown) {
    status = 'pass'; confidence = 'MEDIUM';
    actual = `The panel "${opt.label}" names (#${post.target.id}) is already the one displayed in "${a.menu}": selecting it again changed nothing, as expected`;
  } else {
    status = 'inconclusive'; confidence = 'LOW';
    actual = `Option "${opt.label}" was clicked in "${a.menu}", but nothing could be verified to change: not the content, a selection, a dialog or the address`;
  }
  const check = status === 'blocked' ? 'blocked-by-safety' : a.check ?? 'disclosure-option';
  push({ ...BASE, check, status, severity: 'info', basis: null, element: ref, expected, actual, confidence, ...proof, ...(stopped.length > 0 ? { details: { blockedRequests: stopped } } : {}) });
  ctx.onAction?.({ phase: 'RESULT', type: check, target: a.target, ok: status === 'pass', verdict: status === 'pass' ? 'PASS' : status === 'blocked' ? 'BLOCKED' : 'NEEDS_REVIEW', confidence, expected, actual, buffer: after });
  if (status === 'pass') await inspectCurrentUI(ctx, a.target, push);
  // a view that was shown is explored either way: its controls are there even when its data was not let through
  return { verified: status === 'pass' || (status === 'blocked' && changes.length > 0), changed: changes.length > 0, pre };
}

/**
 * After options were selected, the view may be another one than the menu was opened in. It is brought back by selecting
 * again the option that shows it: the one that was marked as the choice at the start, or the one the view's heading names.
 * Nothing is guessed and no other option is selected a second time; when no option is known to lead back, the caller
 * reloads the page instead.
 */
async function restoreViewByOptions(ctx: FunctionalContext, exercised: Exercised[], home: { sig: string; heading: string }, ensureOpen: (o: MenuOption) => Promise<void>): Promise<'unchanged' | 'restored' | 'failed'> {
  const c = ctx.controller;
  const probe = exercised[0]!.opt;
  await ensureOpen(probe);
  if ((await viewOf(c, probe))?.sig === home.sig) return 'unchanged';
  const names = (o: MenuOption): boolean => o.label.length > 2 && home.heading.toLowerCase().includes(o.label.toLowerCase());
  const candidates = [...exercised.filter((x) => x.wasActive), ...exercised.filter((x) => !x.wasActive && names(x.opt))].slice(0, 2);
  if (candidates.length === 0) return 'unchanged'; // its options act on the view (sort, layout, filter); they do not switch between views
  for (const { opt } of candidates) {
    if (ctx.budget.exhausted) return 'failed';
    await ensureOpen(opt);
    await c.page.evaluate(`${CLICK_OPTION_SCRIPT}(${JSON.stringify(opt.id)}, ${JSON.stringify(opt.label)}, ${JSON.stringify(opt.href ?? '')})`).catch(() => null);
    await c.settle(250); await c.waitForIdle(2000);
    if ((await viewOf(c, opt))?.sig === home.sig) return 'restored';
  }
  return 'failed';
}

/**
 * Explores the state the revealed UI is in now. `path` is how it was reached (for the record). Returns false when the UI
 * could not be put back the way it was found, so the caller knows the page must be reloaded before anything else.
 */
export async function exploreState(ctx: FunctionalContext, push: (r: FunctionalResult) => void, run: Run, path: string[], depth = 1, known: ReadonlySet<string> = new Set()): Promise<boolean> {
  const { controller: c, guard } = ctx;
  const here = await snapshotState(c);
  if (!here || here.controls === 0) return true;
  // A state is its controls AND what it shows: two sections with the same kinds of controls are not the same state.
  const stateKey = `${here.fingerprint}|${here.content}`;
  if (run.visited.has(stateKey)) return true; // seen before
  if (run.visited.size >= run.limits.maxStates) { notExplored(ctx, path.join(' > '), `the limit of ${run.limits.maxStates} UI states per entry was reached`, [`the view reached through "${path[path.length - 1] ?? ''}" (${here.controls} control(s))`]); return true; }
  run.visited.add(stateKey);
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
    const named = Array.from(document.querySelectorAll(MENU_SEL)).filter((m) => visible(m) && !m.closest('[role=tablist], .tabs, .nav-tabs'));
    // A list that was not on screen before the interaction and is now: a submenu, whatever its markup. Many applications
    // build menus from plain <ul><li><a> with no class or role that says "menu".
    const root = window.__qaRootSeen;
    const revealed = root ? Array.from(document.querySelectorAll('ul, ol, menu')).filter((l) => visible(l) && !root.has(l) && !l.closest('[role=tablist], .tabs, .nav-tabs')) : [];
    const menus = Array.from(new Set(named.concat(revealed)));
    const OPT_SEL = 'a, button, [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=option], .dropdown-item, .menu-item';
    ${IN_PAGE_JS}
    const out = [];
    const seen = new Set();
    const batch = 'menu_' + Date.now().toString(36) + '_'; // marks of an earlier look at the menu stay valid for the loop that made them
    for (const m of menus) {
      for (const item of m.querySelectorAll(OPT_SEL)) {
        if (!visible(item) || item.disabled || item.getAttribute('aria-disabled') === 'true' || seen.has(item)) continue;
        if (item.closest('[role=tablist], .tabs, .nav-tabs') || item.matches('[role=tab]')) continue;
        const l = labelOf(item);
        if (!l || /^(close|cancel|dismiss)$/i.test(l)) continue;
        seen.add(item);
        const optId = batch + out.length;
        item.setAttribute('data-qa-menu-opt', optId);
        const link = item.tagName === 'A';
        out.push({ id: optId, label: l, href: link ? item.getAttribute('href') : null, url: link ? item.href : null, inPage: !!inPageTarget(item) });
        if (out.length >= 60) return out;
      }
    }
    return out;
  })()`).catch(() => [])) as MenuOption[];

  const safeMenuOpts = openMenuOptions.filter((o) => guard.check({ kind: 'click', name: o.label, text: o.label, ...(destinationOf(o, c.page.url()) ? { href: o.url ?? undefined } : {}) }).allowed);
  const exercised: Exercised[] = []; let homeView: { sig: string; heading: string } | undefined;
  for (const opt of safeMenuOpts) {
    if (ctx.budget.exhausted) break;
    // an option is gone through once per exploration, however many ways lead to the menu it is in
    if (run.done.has(optionKey(opt))) continue;
    run.done.add(optionKey(opt));
    const dest = destinationOf(opt, c.page.url());
    if (dest) {
      if (!(await followMenuLink(ctx, push, run, where, opt, dest))) return false;
      continue;
    }
    const done = await exerciseOption(ctx, push, run, {
      opt, menu: where, target: `${where} > ${opt.label}`,
      ensureOpen: () => ensureOptionVisible(ctx, opt, path[path.length - 1] ?? ''),
    });
    if (done.stopped) break;
    exercised.push({ opt, wasActive: !!done.pre?.active });
    if (!homeView && done.pre) homeView = { sig: done.pre.sig, heading: done.pre.heading };
    if (done.verified && done.changed) await exploreState(ctx, push, run, [...path, opt.label], depth + 1, inherited);
  }
  {
    const waiting = safeMenuOpts.filter((o) => !run.done.has(optionKey(o)));
    if (waiting.length > 0) notExplored(ctx, where, ctx.budget.timedOut ? "this page's share of the run time was used up" : 'the action budget was used up', waiting.map((o) => o.label));
    if (homeView && exercised.length > 0) {
      const back = await restoreViewByOptions(ctx, exercised, homeView, (o) => ensureOptionVisible(ctx, o, path[path.length - 1] ?? ''));
      if (back !== 'unchanged') ctx.onAction?.({ type: 'restore', target: where, ok: back === 'restored', detail: back === 'restored' ? 'the view this menu was opened in was shown again by selecting its option' : 'no option of this menu brings back the view it was opened in' });
    }
  }

  // 1c. The plain controls that switch what this view shows (a list of links, a row of section buttons). Each one is
  // a recorded interaction of its own: safety check -> click -> verify what changed outside its list -> explore the
  // view it shows -> next. Its siblings stay on screen, so nothing is closed or restored in between; a control that
  // went out of view is brought back through the control this state was reached by.
  const viewControls = (await c.page.evaluate(`${VIEW_CONTROLS_SCRIPT}(${JSON.stringify(MARK)}, ${run.limits.maxNavigatorsPerState + 6})`).catch(() => [])) as (MenuOption & { peers: number })[];
  // Once per exploration, however many states show it. The whole group is claimed by THIS state before any of it is
  // followed: its members stay on screen in the views they show, and would otherwise be picked up one level deeper each
  // time, recorded under a path they do not belong to and cut off by the nesting limit.
  const unclaimed = viewControls.filter((o) => !run.done.has(optionKey(o)));
  // at the nesting limit nothing more is followed; what was found is named as not explored, never silently dropped
  const mine = depth < run.limits.maxDepth ? unclaimed : [];
  if (mine.length === 0 && unclaimed.length > 0) notExplored(ctx, where, `the nesting limit of ${run.limits.maxDepth} levels was reached`, unclaimed.map((o) => o.label));
  for (const o of mine) run.done.add(optionKey(o));
  const reached = new Set<string>();
  for (const opt of mine) {
    if (ctx.budget.exhausted || run.visited.size >= run.limits.maxStates) break;
    reached.add(optionKey(opt));
    const ref = { selector: `${where} > ${opt.label}`, name: opt.label };
    const dest = destinationOf(opt, c.page.url());
    const decision = guard.check({ kind: 'click', name: opt.label, text: opt.label, ...(dest ? { href: opt.url ?? undefined } : {}) });
    const command = decision.allowed && COMMAND_LABEL.test(opt.label);
    if (!decision.allowed || command) {
      const why = !decision.allowed ? decision.reason : `its label names a command ("${opt.label}"); command buttons inside an opened view are not pressed while exploring`;
      push({ ...BASE, check: 'guard', status: 'skipped', severity: 'info', basis: null, element: ref, expected: 'Safe controls of an opened view are followed', actual: `Not clicked: ${why}`, details: { guard: decision } });
      continue;
    }
    if (dest) {
      if (!(await followMenuLink(ctx, push, run, where, opt, dest))) return false;
      continue;
    }
    const done = await exerciseOption(ctx, push, run, {
      opt, menu: where, target: `${where} > ${opt.label}`, check: 'view-control',
      ensureOpen: () => ensureOptionVisible(ctx, opt, path[path.length - 1] ?? ''),
    });
    if (done.stopped) break;
    // what it shows is a state of its own: its controls are tested and its own navigation followed, before moving on
    if (done.verified && done.changed) { if (!(await exploreState(ctx, push, run, [...path, opt.label], depth + 1, inherited))) return false; }
  }
  {
    const waiting = mine.filter((o) => !reached.has(optionKey(o)));
    if (waiting.length > 0) notExplored(ctx, where, ctx.budget.exhausted ? (ctx.budget.timedOut ? "this page's share of the run time was used up" : 'the action budget was used up') : `the limit of ${run.limits.maxStates} UI states per entry was reached`, waiting.map((o) => o.label));
  }

  {
    // What this state contains but nothing here operates: lone plain buttons whose purpose structure does not establish
    // are left as found. They are named, so the record does not read as if everything was exercised.
    const handled = new Set([...here.navigators.map((n) => n.label), ...openMenuOptions.map((o) => o.label), ...viewControls.map((o) => o.label)]);
    const left = here.options.filter((l) => !handled.has(l));
    if (left.length > 0) ctx.onAction?.({ type: 'state-coverage', target: where, ok: true, detail: `${here.controls} control(s) in this view. Reversible controls (fields, selects, toggles, tabs) and menus are exercised; left as found (plain buttons and links, which may save or submit): ${left.slice(0, 15).join(', ')}${left.length > 15 ? `, and ${left.length - 15} more` : ''}` });
  }
  if (depth >= run.limits.maxDepth || ctx.budget.exhausted) {
    const next = here.navigators.filter((n) => !known.has(key(n)) && ((n.kind === 'tab' && !n.active) || (n.kind === 'disclosure' && !n.expanded)));
    notExplored(ctx, where, ctx.budget.exhausted ? (ctx.budget.timedOut ? "this page's share of the run time was used up" : 'the action budget was used up') : `the nesting limit of ${run.limits.maxDepth} levels was reached`, next.map((n) => n.label));
    return true;
  }

  // 2. the controls that lead to other states. next/back belong to a wizard, which only the creation workflow drives.
  // Only what is NEW in this state is followed from here: the sibling tabs and menus of the state it was reached from
  // belong to that state and are followed there. That keeps the exploration a tree instead of every path between tabs.
  // an option that was already selected as an option of its menu is not followed again as if it opened something
  const selected = new Set([...run.done].map((k) => k.split('|')[0]));
  const targets = here.navigators.filter((n) => !known.has(key(n)) && !(n.kind === 'disclosure' && selected.has(n.label)) && ((n.kind === 'tab' && !n.active) || (n.kind === 'disclosure' && !n.expanded))).slice(0, run.limits.maxNavigatorsPerState);
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
        const discoveredOptions = (await c.page.evaluate(`${DISCLOSURE_OPTIONS_SCRIPT}(${JSON.stringify(MARK)}, ${JSON.stringify(nav.id)})`).catch(() => [])) as MenuOption[];
        const optionList: MenuOption[] = discoveredOptions.length > 0 ? discoveredOptions : fresh.map((l, i) => ({ id: `fresh_${i}`, label: l }));
        const refused = optionList.filter((o) => !guard.check({ kind: 'click', name: o.label, text: o.label }).allowed);
        const safe = optionList.filter((o) => guard.check({ kind: 'click', name: o.label, text: o.label }).allowed);

        actualMsg = `"${nav.label}" opened${optionList.length ? ` and shows: ${optionList.map((o) => o.label).slice(0, 12).join(', ')}` : ` (${after.controls - now.controls} more control(s) shown)`}${refused.length ? `. Not selected, for safety: ${refused.map((o) => o.label).join(', ')}` : ''}`;
        push({ ...BASE, check: 'disclosure-open', status: 'pass', severity: 'info', basis: null, element: ref, expected, confidence: 'HIGH', actual: actualMsg, ...proof });

        // Enumerate and exercise every safe non-destructive option
        const exercised: Exercised[] = []; let homeView: { sig: string; heading: string } | undefined;
        for (const opt of safe) {
          if (ctx.budget.exhausted) break;
          // already gone through when this menu was first seen open: not a second time
          if (run.done.has(optionKey(opt))) continue;
          run.done.add(optionKey(opt));
          const dest = destinationOf(opt, c.page.url());
          if (dest) {
            if (!(await followMenuLink(ctx, push, run, `${where} > ${nav.label}`, opt, dest))) return false;
            continue;
          }
          const done = await exerciseOption(ctx, push, run, {
            opt, menu: nav.label, target: `${where} > ${nav.label} > ${opt.label}`,
            ensureOpen: () => ensureOptionVisible(ctx, opt, nav.label, async () => { await c.page.evaluate(`${DISCLOSURE_OPTIONS_SCRIPT}(${JSON.stringify(MARK)}, ${JSON.stringify(nav.id)})`).catch(() => []); }),
          });
          if (done.stopped) break;
          exercised.push({ opt, wasActive: !!done.pre?.active });
          if (!homeView && done.pre) homeView = { sig: done.pre.sig, heading: done.pre.heading };
          // The option was verified to change the view: what it shows is a state of its own, explored like any other
          // (its controls tested, its own menus and tabs followed), whether or not its controls look like another view's.
          if (done.verified && done.changed) await exploreState(ctx, push, run, [...path, nav.label, opt.label], depth + 1, inherited);
        }
        const waiting = safe.filter((o) => !run.done.has(optionKey(o)));
        if (waiting.length > 0) notExplored(ctx, `${where} > ${nav.label}`, ctx.budget.timedOut ? "this page's share of the run time was used up" : 'the action budget was used up', waiting.map((o) => o.label));
        // Selecting options moved the view away from the one this menu was opened in. Put it back by selecting again the
        // option that shows that view, so the sibling controls of this state can still be explored.
        if (homeView && exercised.length > 0) {
          const back = await restoreViewByOptions(ctx, exercised, homeView, (o) => ensureOptionVisible(ctx, o, nav.label, async () => { await c.page.evaluate(`${DISCLOSURE_OPTIONS_SCRIPT}(${JSON.stringify(MARK)}, ${JSON.stringify(nav.id)})`).catch(() => []); }));
          if (back !== 'unchanged') ctx.onAction?.({ type: 'restore', target: nav.label, ok: back === 'restored', detail: back === 'restored' ? `the view "${nav.label}" was opened in was shown again by selecting its option` : `no option of "${nav.label}" brings back the view it was opened in` });
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
