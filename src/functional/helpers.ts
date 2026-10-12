import type { ElementTarget } from '../browser/types.js';
import type { ModelElement } from '../discovery/types.js';
import type { FunctionalContext, FunctionalResult } from './types.js';

/** Semantic target first (role+name) when the pair is unique on the page, else the stored CSS selector. */
export function targetFor(el: ModelElement, siblings: ModelElement[]): ElementTarget {
  if (el.role && el.name) {
    const same = siblings.filter((s) => s.role === el.role && s.name.toLowerCase().includes(el.name.toLowerCase()));
    if (same.length === 1) return { role: el.role, name: el.name };
  }
  return { css: el.selector };
}

export function elementOf(el: ModelElement): FunctionalResult['element'] {
  return { selector: el.selector, role: el.role ?? undefined, name: (el.name || el.text).slice(0, 80) || undefined, box: el.box };
}

/** Re-navigate to the page under test to reset UI state. Returns false when the action budget is spent. */
export async function resetPage(ctx: FunctionalContext): Promise<boolean> {
  if (!ctx.budget.consume()) return false;
  const r = await ctx.controller.navigate(ctx.pageUrl);
  ctx.onAction?.({ type: 'navigate', target: ctx.pageUrl, ok: r.ok, detail: r.error });
  // the page must have finished loading its data again before anything is clicked, or its load requests would be blamed on the click
  await ctx.controller.waitForPageLoad();
  return r.ok;
}

/** Cheap fingerprint of observable page state, to detect "something happened" after an action. */
export async function domSignature(ctx: FunctionalContext): Promise<string> {
  return ctx.controller.page.evaluate(`(() => {
    const b = document.body; if (!b) return '';
    return [location.pathname + location.search, (b.innerText || '').length, b.getElementsByTagName('*').length,
      document.querySelectorAll('[hidden]').length, document.querySelectorAll('[aria-expanded=true]').length,
      document.querySelectorAll('dialog[open],[role=dialog]:not([hidden])').length].join('|');
  })()`) as Promise<string>;
}

/** New lines of visible text that appeared after an action. */
export async function pageText(ctx: FunctionalContext): Promise<string[]> {
  const t = await ctx.controller.page.evaluate('document.body ? document.body.innerText : ""') as string;
  return t.split('\n').map((s) => s.trim()).filter(Boolean);
}

export function newLines(before: string[], after: string[]): string[] {
  const seen = new Set(before);
  return after.filter((l) => !seen.has(l));
}

export const VALIDATION_TEXT = /(required|invalid|error|must|please|enter a|not valid|too short|too long|incorrect|cannot be empty|can't be blank)/i;

/**
 * What is shown right now, reduced to a comparable value: title, visible headings and the visible text. Used to tell that
 * a navigation really brought up another view; an address that changed while the screen stayed the same is not one.
 */
export async function viewSignature(c: FunctionalContext['controller']): Promise<string> {
  return (c.page.evaluate(`(() => {
    const t = (e) => (e.innerText || e.textContent || '').replace(/\\s+/g, ' ').trim();
    const hs = Array.from(document.querySelectorAll('h1,h2,h3,[role=heading]')).filter((e) => e.getClientRects().length > 0).map(t).join('|');
    const b = document.body ? (document.body.innerText || '') : '';
    let h = 5381; for (let i = 0; i < b.length; i++) h = ((h << 5) + h + b.charCodeAt(i)) | 0;
    return document.title + '||' + hs + '||' + b.length + ':' + h;
  })()`) as Promise<string>).catch(() => '');
}

/**
 * The address still names the view the action started on: identical, or only the fragment was emptied. Activating a
 * control written as <a href="#"> turns ".../#orders" into ".../#" without going anywhere; that is not a navigation.
 */
export function sameViewUrl(now: string, before: string | undefined): boolean {
  if (!before) return false;
  if (now === before) return true;
  try {
    const a = new URL(now); const b = new URL(before);
    return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search && (a.hash === b.hash || a.hash === '' || a.hash === '#');
  } catch { return false; }
}
