import type { BrowserController } from '../browser/index.js';
import type { QAConfig } from '../shared/config.js';
import type { Finding } from '../shared/types.js';
import type { RuleRegistry } from '../rules/index.js';
import { buildRegistry } from '../rules/index.js';
import { collectRuleContext } from '../rules/context.js';
import { fingerprint } from '../rules/helpers.js';
import { notConfirmedReason } from '../dynamic/resultClassifier.js';
import type { FunctionalContext, FunctionalResult } from './types.js';

interface ScrollTarget {
  selector: string;
  scrollable: boolean;
  scrollHeight: number;
  clientHeight: number;
}

const DETECT_SCROLL_CONTAINER_SCRIPT = `(() => {
  // 1. Visible dialog/modal/drawer
  const dialog = document.querySelector('dialog[open], [role="dialog"]:not([aria-hidden="true"]), .modal.show, .modal-open, .drawer.open');
  if (dialog) {
    const isScroll = dialog.scrollHeight > dialog.clientHeight + 20;
    return { selector: dialog.id ? '#' + CSS.escape(dialog.id) : '[role="dialog"]', scrollable: isScroll, scrollHeight: dialog.scrollHeight, clientHeight: dialog.clientHeight };
  }
  // 2. Active tabpanel
  const panel = document.querySelector('[role="tabpanel"]:not([hidden]):not([aria-hidden="true"]), .tab-pane.active, .tab-content > .active');
  if (panel) {
    const isScroll = panel.scrollHeight > panel.clientHeight + 20;
    if (isScroll) {
      return { selector: panel.id ? '#' + CSS.escape(panel.id) : '[role="tabpanel"]', scrollable: true, scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight };
    }
  }
  // 3. Main content or generic scrollable container
  const scrollables = Array.from(document.querySelectorAll('main, section, div, table')).filter((el) => {
    const cs = getComputedStyle(el);
    return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200;
  });
  if (scrollables.length > 0) {
    const el = scrollables[0];
    const sel = el.id ? '#' + CSS.escape(el.id) : (el.getAttribute('class') ? '.' + el.className.trim().split(/\\s+/)[0] : el.tagName.toLowerCase());
    return { selector: sel, scrollable: true, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  }
  // 4. Default window/document
  const doc = document.scrollingElement || document.documentElement;
  const isDocScroll = doc.scrollHeight > window.innerHeight + 20;
  return { selector: 'window', scrollable: isDocScroll, scrollHeight: doc.scrollHeight, clientHeight: window.innerHeight };
})()`;

/** Evaluates deterministic UI/UX rules on the current state across bounded scroll positions. */
export async function auditStateWithScrolling(
  controller: BrowserController,
  config: QAConfig,
  registry?: RuleRegistry,
  options: { maxScrollPositions?: number } = {},
): Promise<Finding[]> {
  const reg = registry ?? (await buildRegistry(config));
  const maxPos = options.maxScrollPositions ?? 3;
  const target = (await controller.page.evaluate(DETECT_SCROLL_CONTAINER_SCRIPT).catch(() => null)) as ScrollTarget | null;

  const positions = [0];
  if (target && target.scrollable && target.scrollHeight > target.clientHeight) {
    const maxScroll = Math.max(0, target.scrollHeight - target.clientHeight);
    if (maxScroll > 100) {
      if (maxPos >= 3) {
        positions.push(Math.round(maxScroll / 2));
      }
      positions.push(maxScroll);
    }
  }

  const seenFingerprints = new Set<string>();
  const confirmedFindings: Finding[] = [];

  for (const pos of positions) {
    if (pos > 0 && target) {
      await controller.page.evaluate(`((sel, top) => {
        if (sel === 'window') {
          window.scrollTo({ top, behavior: 'instant' });
        } else {
          const el = document.querySelector(sel);
          if (el) el.scrollTop = top;
          else window.scrollTo({ top, behavior: 'instant' });
        }
      })(${JSON.stringify(target.selector)}, ${pos})`).catch(() => undefined);
      await controller.settle(80);
    }

    const ruleCtx = await collectRuleContext(controller, { config });
    const res = await reg.run(ruleCtx, (r) => !r.id.startsWith('functional.') && !r.id.startsWith('network.') && !r.id.startsWith('console.'));

    for (const f of res.findings) {
      if (f.classification === 'defect') {
        const notConfirmed = notConfirmedReason({ ...f, evidence: undefined });
        if (notConfirmed === null) {
          const fp = fingerprint(f);
          if (!seenFingerprints.has(fp)) {
            seenFingerprints.add(fp);
            confirmedFindings.push(f);
          }
        }
      }
    }
  }

  // Restore scroll position back to top
  if (positions.length > 1 && target) {
    await controller.page.evaluate(`((sel) => {
      if (sel === 'window') window.scrollTo({ top: 0, behavior: 'instant' });
      else {
        const el = document.querySelector(sel);
        if (el) el.scrollTop = 0;
        else window.scrollTo({ top: 0, behavior: 'instant' });
      }
    })(${JSON.stringify(target.selector)})`).catch(() => undefined);
    await controller.settle(50);
  }

  return confirmedFindings;
}

/** Runs generic UI/UX deterministic rules on the currently rendered UI state with bounded scrolling. */
export async function inspectCurrentUI(ctx: FunctionalContext, label: string, push: (r: FunctionalResult) => void): Promise<void> {
  if (!ctx.config) return;
  try {
    const findings = await auditStateWithScrolling(ctx.controller, ctx.config, ctx.registry);
    for (const f of findings) {
      push({
        kind: 'interactive',
        check: f.ruleId,
        status: 'fail',
        severity: f.severity,
        basis: f.basis,
        element: f.element,
        expected: f.expected,
        actual: `In UI state after "${label}": ${f.actual}`,
        details: { ...(f.context ?? {}), trigger: label, originalRuleId: f.ruleId },
        confidence: 'HIGH',
      });
    }
  } catch {
    // best-effort non-blocking UI/UX inspection
  }
}
