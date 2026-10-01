import type { BrowserController } from '../browser/index.js';
import type { PageModel } from '../discovery/types.js';
import type { KeyboardIssue, KeyboardResult } from './types.js';

/** Runs in the page after each Tab: identifies the focused element and whether the previously focused one showed a focus style. */
const STEP_SCRIPT = `(() => {
  const sel = (el) => {
    if (el.id) return '#' + el.id;
    const parts = []; let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      const tag = cur.tagName.toLowerCase(); const parent = cur.parentElement;
      if (cur === document.body) { parts.unshift('body'); break; }
      const same = parent ? Array.from(parent.children).filter(c => c.tagName === cur.tagName) : [];
      parts.unshift(same.length > 1 ? tag + ':nth-of-type(' + (same.indexOf(cur) + 1) + ')' : tag);
      cur = parent;
    }
    return parts.join(' > ');
  };
  const sig = (e) => { const cs = getComputedStyle(e); return [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow, cs.backgroundColor, cs.borderColor, cs.color, cs.textDecorationLine].join('|'); };
  const el = document.activeElement;
  const prev = window.__qaPrev; const prevFocusSig = window.__qaPrevSig;
  let prevChanged = null; let prevSel = null; let prevName = '';
  if (prev && prev !== el && document.contains(prev) && prevFocusSig) {
    prevChanged = sig(prev) !== prevFocusSig; prevSel = sel(prev); prevName = (prev.getAttribute('aria-label') || prev.innerText || prev.value || '').trim().slice(0, 60);
  }
  const isBody = !el || el === document.body || el === document.documentElement;
  window.__qaPrev = isBody ? null : el; window.__qaPrevSig = isBody ? null : sig(el);
  return { isBody, selector: isBody ? '' : sel(el), prevChanged, prevSel, prevName };
})()`;

/** Tab-key traversal: reachability, focus traps, visible focus indicators. Heuristic by nature: results are anomalies. */
export async function runKeyboardCheck(controller: BrowserController, model: PageModel, opts: { maxTabs?: number } = {}): Promise<KeyboardResult> {
  const page = controller.page;
  const expected = model.interactive.filter((e) => e.visible && e.enabled && e.type !== 'radio' && e.box.width > 2 && e.box.height > 2);
  const maxTabs = Math.min(opts.maxTabs ?? 80, expected.length * 2 + 8);
  await page.evaluate('(() => { window.__qaPrev = null; window.__qaPrevSig = null; if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()');

  const visited: string[] = [];
  const issues: KeyboardIssue[] = [];
  const flaggedIndicator = new Set<string>();
  let repeatedBeforeCoverage: string | null = null;

  for (let i = 0; i < maxTabs; i++) {
    await controller.press('Tab');
    const s = await page.evaluate(STEP_SCRIPT) as { isBody: boolean; selector: string; prevChanged: boolean | null; prevSel: string | null; prevName: string };
    if (s.prevChanged === false && s.prevSel && !flaggedIndicator.has(s.prevSel)) {
      flaggedIndicator.add(s.prevSel);
      issues.push({ type: 'no-focus-indicator', selector: s.prevSel, name: controller.redactor.redact(s.prevName), detail: 'Element receives keyboard focus but no visible style change (outline, shadow, colour) was detected (WCAG 2.4.7)' });
    }
    if (s.isBody) { if (visited.length > 0) break; continue; } // focus left the document: one full cycle finished
    if (visited.includes(s.selector)) {
      if (visited.length < Math.max(4, Math.floor(expected.length * 0.7))) repeatedBeforeCoverage = s.selector;
      break;
    }
    visited.push(s.selector);
  }

  if (repeatedBeforeCoverage) {
    issues.push({ type: 'focus-trap', selector: repeatedBeforeCoverage, name: '', detail: `Keyboard focus cycled back to ${repeatedBeforeCoverage} after only ${visited.length} stops while ${expected.length} interactive elements are visible (possible focus trap)` });
  } else {
    const reached = new Set(visited);
    for (const e of expected) {
      if (reached.has(e.selector) || reached.has(`#${e.selector.replace(/^#/, '')}`)) continue;
      if (e.meta?.inputType === 'hidden') continue;
      issues.push({ type: 'unreachable', selector: e.selector, name: controller.redactor.redact((e.name || e.text).slice(0, 60)), detail: `Interactive ${e.role ?? e.type} "${(e.name || e.text).slice(0, 40)}" cannot be reached with the Tab key` });
    }
  }
  return { tabStops: visited.length, issues };
}
