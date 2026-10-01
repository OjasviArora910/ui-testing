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
  await ctx.controller.settle(120);
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

export interface Coverer { description: string; floating: boolean }

/**
 * Who is on top of the element's centre? `floating` = the coverer is fixed/sticky or a dialog/overlay, which is
 * legitimate layered UI (cookie banners, modals) and therefore needs a human, not an automatic defect.
 */
export async function coveredBy(ctx: FunctionalContext, selector: string): Promise<Coverer | null> {
  return ctx.controller.page.evaluate(`((sel) => {
    const el = document.querySelector(sel); if (!el) return null;
    const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) return null;
    const top = document.elementFromPoint(Math.min(Math.max(r.x + r.width / 2, 0), innerWidth - 1), Math.min(Math.max(r.y + r.height / 2, 0), innerHeight - 1));
    if (!top || top === el || el.contains(top) || top.contains(el)) return null;
    let floating = false;
    for (let n = top; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.position === 'fixed' || cs.position === 'sticky' || n.getAttribute('role') === 'dialog' || n.getAttribute('aria-modal') === 'true' || n.tagName === 'DIALOG') { floating = true; break; }
    }
    return { description: top.tagName.toLowerCase() + (top.id ? '#' + top.id : ''), floating };
  })(${JSON.stringify(selector)})`) as Promise<Coverer | null>;
}
