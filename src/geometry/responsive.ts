import type { ElementInfo } from '../browser/types.js';
import { elementRef, fmtBox, makeFinding } from '../rules/helpers.js';
import type { Rule } from '../rules/types.js';
import type { Finding } from '../shared/types.js';
import { ElementIndex, right } from './primitives.js';

/** True when an ancestor provides horizontal scrolling or clipping for the element. */
function hasScrollAncestor(e: ElementInfo, idx: ElementIndex): boolean {
  return idx.chain(e).slice(1).some((a) => ['auto', 'scroll', 'hidden', 'clip'].includes(a.styles.overflowX) && a.tag !== 'body' && a.tag !== 'html');
}

export const tableOverflowRule: Rule = {
  id: 'responsive.table-overflow', name: 'Table wider than viewport', category: 'responsive', severity: 'major', basis: 'deterministic',
  description: 'A table is wider than the viewport and has no horizontally scrollable wrapper.',
  async evaluate(ctx) {
    const idx = new ElementIndex(ctx.elements);
    const w = ctx.metrics.clientWidth;
    const out: Finding[] = [];
    for (const e of ctx.elements.filter((x) => (x.tag === 'table' || x.role === 'table' || x.role === 'grid') && x.visible)) {
      if (right(e.box) <= w + 1 || hasScrollAncestor(e, idx)) continue;
      out.push(makeFinding(tableOverflowRule, ctx, {
        classification: 'defect', element: elementRef(e),
        expected: `Table fits the ${ctx.viewport.name} viewport (${w}px) or scrolls inside its own container`,
        actual: `Table is ${Math.round(e.box.width)}px wide, extending to ${Math.round(right(e.box))}px in a ${w}px viewport with no scroll wrapper`,
      }));
    }
    return out;
  },
};

export const imageOverflowRule: Rule = {
  id: 'responsive.image-overflow', name: 'Image wider than viewport', category: 'responsive', severity: 'minor', basis: 'deterministic',
  description: 'An image extends past the right edge of the viewport (fixed width instead of responsive sizing).',
  async evaluate(ctx) {
    const idx = new ElementIndex(ctx.elements);
    const w = ctx.metrics.clientWidth;
    const out: Finding[] = [];
    for (const e of ctx.elements.filter((x) => x.tag === 'img' && x.visible)) {
      if (right(e.box) <= w + 1 || hasScrollAncestor(e, idx) || e.styles.position === 'fixed') continue;
      out.push(makeFinding(imageOverflowRule, ctx, {
        classification: 'defect', element: elementRef(e),
        expected: `Images scale to the viewport (${w}px)`,
        actual: `Image is ${Math.round(e.box.width)}px wide and extends to ${Math.round(right(e.box))}px`,
      }));
    }
    return out;
  },
};

export const dialogSizeRule: Rule = {
  id: 'responsive.dialog-size', name: 'Dialog larger than viewport', category: 'responsive', severity: 'major', basis: 'deterministic',
  description: 'An open dialog is wider than the viewport, or taller than it without internal scrolling.',
  async evaluate(ctx) {
    const out: Finding[] = [];
    const { width, height } = ctx.viewport;
    for (const e of ctx.elements.filter((x) => (x.role === 'dialog' || x.role === 'alertdialog' || x.tag === 'dialog') && x.visible)) {
      const tooWide = e.box.width > width + 1;
      const tooTall = e.box.height > height + 1 && !['auto', 'scroll'].includes(e.styles.overflowY);
      if (!tooWide && !tooTall) continue;
      out.push(makeFinding(dialogSizeRule, ctx, {
        classification: 'defect', element: elementRef(e),
        expected: `Dialogs fit the ${ctx.viewport.name} viewport (${width}x${height})`,
        actual: `Dialog is ${fmtBox(e.box)}`,
      }));
    }
    return out;
  },
};

export const navigationRule: Rule = {
  id: 'responsive.navigation', name: 'Navigation unreachable at this viewport', category: 'responsive', severity: 'major', basis: 'generic_rule',
  description: 'A navigation landmark exists but none of its links are visible and no menu toggle is available.',
  async evaluate(ctx) {
    const navs = ctx.elements.filter((e) => e.tag === 'nav' || e.role === 'navigation');
    if (navs.length === 0) return [];
    const idx = new ElementIndex(ctx.elements);
    const anyVisibleLink = ctx.elements.some((e) => e.visible && (e.tag === 'a' || e.role === 'link') && idx.chain(e).some((a) => navs.some((n) => n.id === a.id)));
    if (anyVisibleLink) return [];
    const toggle = ctx.elements.some((e) => e.visible && (e.tag === 'button' || e.role === 'button') && (e.aria.expanded !== null || e.aria.haspopup || /menu|navigation|nav\b/i.test(`${e.name} ${e.className}`)));
    if (toggle) return [];
    const nav = navs[0]!;
    return [makeFinding(navigationRule, ctx, {
      classification: 'anomaly', element: elementRef(nav),
      expected: 'Navigation links or a menu toggle are visible at every viewport',
      actual: `Navigation landmark exists but no link or menu toggle is visible at ${ctx.viewport.name} (${ctx.viewport.width}x${ctx.viewport.height})`,
    })];
  },
};

export const responsiveRules: Rule[] = [tableOverflowRule, imageOverflowRule, dialogSizeRule, navigationRule];
