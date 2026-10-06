import type { BrowserController } from '../browser/index.js';
import type { PageModel } from './types.js';

/**
 * Finds the elements that belong to the application SHELL (global navigation shown on every page) rather than to the page
 * itself, so that "test this page only" does not test the whole application's menus. Generic, by structure and position:
 *  - inside header / nav / footer / aside (or the matching roles) that is not part of the main content or a dialog;
 *  - inside a bar pinned to the top of the document: (almost) full width and short;
 *  - inside a side bar pinned to the left or right edge: (almost) full height and narrow;
 *  - inside a fixed or sticky strip attached to an edge of the window;
 *  - inside a container named as navigation by its own id or class (nav, navbar, navigation, sidebar, topbar, main-menu...);
 *  - inside a cluster of route links: a strip at the top of the page, or a column at its side, holding five or more
 *    links to other places in the application.
 * Dialogs and other overlays are never shell. Pure read; nothing on the page is changed.
 */
const SHELL_SCRIPT = `((selectors) => {
  const vw = window.innerWidth, vh = window.innerHeight, sx = window.scrollX, sy = window.scrollY;
  const CONTENT = 'main,[role=main],article,dialog,[role=dialog],[aria-modal=true]';
  const NAMED = /(^|[\\s_-])(nav|navbar|navigation|sidebar|sidenav|side-nav|topbar|top-bar|topnav|main-menu|mainmenu|menubar|site-header|site-footer|app-header|global-nav)($|[\\s_-])/i;
  const here = location.href.replace(/[?#].*$/, '') + location.hash;
  const routeLinks = (a) => {
    const seen = new Set();
    for (const l of a.querySelectorAll('a[href]')) {
      const raw = (l.getAttribute('href') || '').trim();
      if (!raw || raw === '#' || /^javascript:/i.test(raw) || l.origin !== location.origin) continue;
      const to = l.href.replace(/[?#].*$/, '') + l.hash;
      if (to !== here) seen.add(to);
    }
    return seen.size;
  };
  const verdict = new Map();
  const isShell = (a) => {
    if (verdict.has(a)) return verdict.get(a);
    let v = false;
    const tag = a.tagName.toLowerCase(), role = (a.getAttribute('role') || '').toLowerCase();
    if (a.matches('dialog,[role=dialog],[aria-modal=true]')) v = false;
    else if ((['header', 'nav', 'footer', 'aside'].includes(tag) || ['banner', 'navigation', 'contentinfo', 'menubar'].includes(role)) && !a.closest(CONTENT)) v = true;
    else if (!a.closest(CONTENT)) {
      const r = a.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const top = r.top + sy, left = r.left + sx;
        const wide = r.width >= vw * 0.9, short = r.height <= Math.max(120, vh * 0.15);
        const tall = r.height >= vh * 0.7, narrow = r.width <= Math.max(80, vw * 0.3);
        const pos = getComputedStyle(a).position;
        if (wide && short && top <= 4) v = true;
        else if (tall && narrow && (left <= 4 || r.right >= vw - 4) && top <= vh * 0.3) v = true;
        else if ((pos === 'fixed' || pos === 'sticky') && ((wide && short && (r.top <= 4 || r.bottom >= vh - 4)) || (tall && narrow && (r.left <= 4 || r.right >= vw - 4)))) v = true;
        // a strip near the top, or a column at the side, that is a cluster of links to other places in the application
        else if (((r.width >= vw * 0.5 && short && top <= vh * 0.2) || (tall && narrow && (left <= 4 || r.right >= vw - 4))) && routeLinks(a) >= 5) v = true;
      }
      // named as navigation by its own id or class; in-page tab strips, pagination and breadcrumbs carry such names too and are page content
      const named = (a.id || '') + ' ' + (typeof a.className === 'string' ? a.className : '');
      if (!v && NAMED.test(named) && !/tab|pill|paginat|breadcrumb|step|wizard/i.test(named) && (a.querySelector('a[href]') || a.querySelector('button'))) v = true;
    }
    verdict.set(a, v);
    return v;
  };
  const out = [];
  for (const sel of selectors) {
    let el = null; try { el = document.querySelector(sel); } catch { el = null; }
    if (!el || el.closest('dialog,[role=dialog],[aria-modal=true]')) continue;
    for (let a = el; a && a !== document.body && a !== document.documentElement; a = a.parentElement) if (isShell(a)) { out.push(sel); break; }
  }
  return out;
})`;

const LISTS = ['buttons', 'links', 'inputs', 'selects', 'checkboxes', 'radios', 'textareas', 'tabs', 'menus', 'accordions', 'interactive'] as const;

/** Which of these selectors sit in the application shell. */
export async function shellAmong(c: BrowserController, selectors: string[]): Promise<Set<string>> {
  if (selectors.length === 0) return new Set();
  const found = await c.page.evaluate(`${SHELL_SCRIPT}(${JSON.stringify([...new Set(selectors)])})`).catch(() => []) as string[];
  return new Set(found);
}

/** Selectors of the model's interactive elements that sit in the application shell. */
export async function shellSelectors(c: BrowserController, model: PageModel): Promise<Set<string>> {
  const selectors = [...new Set([...LISTS.flatMap((k) => model[k].map((e) => e.selector)), ...model.forms.map((f) => f.selector)])];
  const found = await c.page.evaluate(`${SHELL_SCRIPT}(${JSON.stringify(selectors)})`).catch(() => []) as string[];
  return new Set(found);
}

/** The same model without the shell's interactive elements: what "this page only" tests. Static content is left as it is. */
export function withoutShell(model: PageModel, shell: Set<string>): PageModel {
  if (shell.size === 0) return model;
  const copy: PageModel = { ...model, forms: model.forms.filter((f) => !shell.has(f.selector)) };
  for (const k of LISTS) copy[k] = model[k].filter((e) => !shell.has(e.selector));
  return copy;
}
