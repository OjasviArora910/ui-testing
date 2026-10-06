import type { BrowserController } from '../browser/index.js';
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
  // ---- wizard movement and disclosures
  for (const el of document.querySelectorAll('button, a, [role=button], input[type=button], summary, [aria-expanded], [data-toggle], [data-bs-toggle]')) {
    if (!inScope(el) || taken.has(el) || el.disabled) continue;
    const l = labelOf(el);
    if (/^(next|continue|proceed|go|start|begin|get started)\\b/i.test(l)) { add(el, 'next', 'wizard', false, false); continue; }
    if (/^(back|prev|previous)\\b/i.test(l)) { add(el, 'back', 'wizard', false, false); continue; }
    const toggle = (el.getAttribute('data-toggle') || el.getAttribute('data-bs-toggle') || '').toLowerCase();
    const expandedAttr = el.getAttribute('aria-expanded');
    if (el.tagName === 'SUMMARY') add(el, 'disclosure', 'd', false, !!(el.parentElement && el.parentElement.open));
    else if (toggle === 'dropdown' || toggle === 'collapse' || (expandedAttr !== null && (el.getAttribute('aria-controls') || el.getAttribute('aria-haspopup')))) add(el, 'disclosure', 'd', false, expandedAttr === 'true');
  }

  // ---- what is visibly there, for the fingerprint and the record
  const parts = []; const options = []; const headings = []; let controls = 0;
  for (const el of document.querySelectorAll('input:not([type=hidden]), select, textarea, button, a, [role=button], [role=tab], [role=checkbox], [role=switch], [role=slider], [role=menuitem], [role=option]')) {
    if (!inScope(el)) continue;
    controls++;
    const kind = el.getAttribute('role') || (el.tagName === 'INPUT' ? 'input:' + (el.getAttribute('type') || 'text') : el.tagName.toLowerCase());
    const fieldLabel = el.labels && el.labels.length ? text(el.labels[0]) : '';
    parts.push(kind + '|' + norm(labelOf(el) || fieldLabel || el.getAttribute('name') || ''));
    if (el.matches('a, button, [role=button], [role=menuitem], [role=option]') && labelOf(el) && options.length < 40) options.push(labelOf(el));
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

  // 1. the reversible controls of this state: changed by one step, verified, put back, verified
  await testReversibleControls(ctx, push, { onlyNew: true, openedBy: where }).catch(() => 0);
  if (depth >= run.limits.maxDepth || ctx.budget.exhausted) return true;

  // 2. the controls that lead to other states. next/back belong to a wizard, which only the creation workflow drives.
  // Only what is NEW in this state is followed from here: the sibling tabs and menus of the state it was reached from
  // belong to that state and are followed there. That keeps the exploration a tree instead of every path between tabs.
  const key = (n: Navigator): string => `${n.kind}|${n.label}`;
  const targets = here.navigators.filter((n) => !known.has(key(n)) && ((n.kind === 'tab' && !n.active) || (n.kind === 'disclosure' && !n.expanded))).slice(0, run.limits.maxNavigatorsPerState);
  const inherited = new Set([...known, ...here.navigators.map(key)]);
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
    const before = await c.page.screenshot({ type: 'jpeg', quality: 55 }).catch(() => undefined);
    c.beginAction();
    const click = await c.click({ css: `[${MARK}="${nav.id}"]` });
    await c.settle(250); await c.waitForIdle(2500);
    const after = await snapshotState(c);
    const landed = after?.navigators.find((n) => same(n, nav));
    const changed = !!after && after.fingerprint !== now.fingerprint;
    ctx.onAction?.({ type: nav.kind, target: nav.label, ok: click.ok, detail: click.error });
    const proof = { before, screenshot: await c.page.screenshot({ type: 'jpeg', quality: 55 }).catch(() => undefined), trace: { action: `click "${nav.label}" (${where})`, network: [], console: [], changes: [`state ${now.fingerprint} -> ${after?.fingerprint ?? '(gone)'}`, `active: ${after?.active.join(', ') || 'none'}`] } };

    let entered = false;
    if (!click.ok || !after) {
      push({ ...BASE, check: nav.kind === 'tab' ? 'tab-switch' : 'disclosure-open', status: 'inconclusive', severity: 'info', basis: null, element: ref, expected, actual: `"${nav.label}" could not be clicked${click.error ? `: ${click.error.slice(0, 140)}` : ''}`, confidence: 'LOW', ...proof });
    } else if (nav.kind === 'tab') {
      const wasActive = now.navigators.filter((n) => n.group === nav.group && n.active).map((n) => n.label);
      if (landed?.active) {
        entered = true;
        push({ ...BASE, check: 'tab-switch', status: 'pass', severity: 'info', basis: null, element: ref, expected, confidence: 'HIGH',
          actual: `"${nav.label}" is now the active tab (was: ${wasActive.join(', ') || 'none'}); ${changed ? `its content is shown: ${after.controls} control(s)${after.headings[0] ? `, "${after.headings[0]}"` : ''}` : 'the visible controls are the same as before'}` });
      } else {
        // the control was clicked and is not marked active: without an active marker the outcome cannot be established
        push({ ...BASE, check: 'tab-switch', status: 'inconclusive', severity: 'info', basis: null, element: ref, expected, confidence: 'LOW',
          actual: `"${nav.label}" was clicked but is not marked active afterwards (active: ${after.active.join(', ') || 'none'}); ${changed ? 'the content did change' : 'nothing else changed'}`, ...proof });
        entered = changed;
      }
    } else {
      const fresh = after.options.filter((o) => !now.options.includes(o));
      if (landed?.expanded || fresh.length > 0 || after.controls > now.controls) {
        entered = true;
        const refused = fresh.filter((o) => !guard.check({ kind: 'click', name: o, text: o }).allowed);
        push({ ...BASE, check: 'disclosure-open', status: 'pass', severity: 'info', basis: null, element: ref, expected, confidence: 'HIGH',
          actual: `"${nav.label}" opened${fresh.length ? ` and shows: ${fresh.slice(0, 12).join(', ')}` : ` (${after.controls - now.controls} more control(s) shown)`}${refused.length ? `. Not selected, for safety: ${refused.join(', ')}` : ''}` });
      } else {
        push({ ...BASE, check: 'disclosure-open', status: 'inconclusive', severity: 'info', basis: null, element: ref, expected, confidence: 'LOW', actual: `"${nav.label}" was clicked but nothing it would show could be identified`, ...proof });
      }
    }

    // 3. the state that was reached is explored in turn, then this state is restored and the restoration verified
    if (entered && changed) { if (!(await exploreState(ctx, push, run, [...path, nav.label], depth + 1, inherited))) return false; }
    if (!after || after.fingerprint === now.fingerprint) continue;
    const cur = await snapshotState(c);
    if (nav.kind === 'tab') {
      const home = now.navigators.find((n) => n.group === nav.group && n.active);
      const back = home && cur?.navigators.find((n) => same(n, home));
      if (back && !back.active && guard.check({ kind: 'click', name: back.label, text: back.label }).allowed) await c.click({ css: `[${MARK}="${back.id}"]` });
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
    const root = window.__qaRootSeen; if (!root) return null;
    const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; };
    document.querySelectorAll('[data-qa-close]').forEach((e) => e.removeAttribute('data-qa-close'));
    for (const el of document.querySelectorAll('button, a, [role=button]')) {
      if (!visible(el) || root.has(el)) continue;
      const l = (el.getAttribute('aria-label') || el.innerText || el.textContent || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim();
      if (/^(close|cancel|dismiss|×|✕|x)$/i.test(l)) { el.setAttribute('data-qa-close', '1'); return l; }
    }
    return null;
  })()`).catch(() => null)) as string | null;
  if (!found || !guard.check({ kind: 'click', name: found, text: found }).allowed) return false;
  const r = await c.click({ css: '[data-qa-close="1"]' });
  await c.settle(200);
  return r.ok;
}
