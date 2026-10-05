import type { ElementInfo } from '../browser/types.js';
import { ElementIndex, area, intersection, overlapRatio } from './primitives.js';

const FLOATING_ROLES = new Set(['tooltip', 'dialog', 'alertdialog', 'menu', 'listbox', 'popover', 'combobox-popup', 'status', 'alert']);
const FLOATING_CLASS = /(tooltip|popover|popup|dropdown|drop-down|menu|modal|overlay|toast|snackbar|backdrop|badge|dialog|flyout|floating|sticky)/i;

export type LegitKind = 'tooltip' | 'dropdown' | 'modal' | 'popover' | 'badge' | 'floating-ui' | 'embedded-control' | 'stacked-layers';

/**
 * Recognises layered UI that is SUPPOSED to overlap other content. Returns the kind (for reporting/tests) or null.
 * Checks the element and its ancestors, because the visible text is usually in a child of the floating container.
 */
export function floatingKind(e: ElementInfo, idx: ElementIndex): LegitKind | null {
  for (const x of idx.chain(e)) {
    if (x.tag === 'dialog' || x.aria.modal) return 'modal';
    if (x.role === 'tooltip') return 'tooltip';
    if (x.role === 'menu' || x.role === 'listbox') return 'dropdown';
    if (x.role === 'dialog' || x.role === 'alertdialog') return x.styles.position === 'fixed' ? 'modal' : 'popover';
    if (x.role && FLOATING_ROLES.has(x.role) && x.styles.position !== 'static') return 'floating-ui';
    const pos = x.styles.position;
    if (pos === 'fixed' || pos === 'sticky') return 'floating-ui';
    if (FLOATING_CLASS.test(x.className) && pos !== 'static') return /badge/i.test(x.className) ? 'badge' : 'floating-ui';
    // Explicitly layered (absolute + numeric z-index) AND semantically linked to a popup trigger.
    if (pos === 'absolute' && /^\d+$/.test(x.styles.zIndex) && Number(x.styles.zIndex) > 0) {
      const p = idx.parent(x);
      if (p && (p.aria.haspopup || p.aria.expanded !== null || p.tag === 'button')) return 'floating-ui';
      if (x.role === 'tooltip' || x.role === 'dialog' || x.role === 'menu') return 'floating-ui';
    }
  }
  // Badge: a small absolutely-positioned child sitting on its interactive parent.
  const p = idx.parent(e);
  if (p && e.styles.position === 'absolute' && e.box.width <= 32 && e.box.height <= 32 && (p.tag === 'button' || p.tag === 'a' || p.role === 'button' || p.role === 'link')) return 'badge';
  return null;
}

const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'listbox']);
const isField = (e: ElementInfo): boolean => e.tag === 'textarea' || e.tag === 'select' || (e.tag === 'input' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'range', 'file', 'color'].includes(e.type ?? 'text')) || (e.role !== null && FIELD_ROLES.has(e.role));
const isControl = (e: ElementInfo): boolean => ['button', 'a', 'summary'].includes(e.tag) || e.role === 'button' || e.role === 'link';

/**
 * Intentional composition: a small element placed entirely INSIDE a larger field or control (a visibility toggle or clear
 * button in an input, an icon or floating label in a field, an action on a clickable card). Containment is what separates
 * this from a collision, where two boxes cross each other's edges.
 */
export function isEmbeddedControl(a: ElementInfo, b: ElementInfo): boolean {
  const [small, large] = area(a.box) <= area(b.box) ? [a, b] : [b, a];
  const i = intersection(small.box, large.box);
  if (!i || area(small.box) === 0 || area(i) / area(small.box) < 0.9) return false; // must lie inside, not across an edge
  if (area(small.box) > area(large.box) * 0.4) return false; // two similar-sized things on top of each other are not composition
  return isField(large) || (isControl(large) && isControl(small));
}

/**
 * Layers that are meant to share one place and be shown one at a time (carousel slides, tab panels, stacked cards): the
 * two elements sit in different branches whose roots are siblings occupying the same box.
 */
export function isStackedLayers(a: ElementInfo, b: ElementInfo, idx: ElementIndex): boolean {
  const chainA = idx.chain(a); const chainB = idx.chain(b);
  const idsB = new Map(chainB.map((x, i) => [x.id, i]));
  const ia = chainA.findIndex((x) => idsB.has(x.id));
  if (ia < 1) return false; // no common ancestor, or one contains the other
  const ib = idsB.get(chainA[ia]!.id)!;
  if (ib < 1) return false;
  const rootA = chainA[ia - 1]!; const rootB = chainB[ib - 1]!; // the two sibling branches under the common ancestor
  if (rootA.id === a.id && rootB.id === b.id) return false; // the elements themselves are the siblings: judge them directly
  if (area(rootA.box) === 0 || area(rootB.box) === 0) return false;
  const sameSize = Math.min(area(rootA.box), area(rootB.box)) / Math.max(area(rootA.box), area(rootB.box)) >= 0.8;
  return sameSize && overlapRatio(rootA.box, rootB.box) >= 0.9;
}

/** A pair overlaps legitimately when either side is floating UI, one contains the other, or the two are composed/layered by design. */
export function isLegitimateOverlap(a: ElementInfo, b: ElementInfo, idx: ElementIndex): LegitKind | 'nested' | null {
  if (idx.related(a, b)) return 'nested';
  if (isEmbeddedControl(a, b)) return 'embedded-control';
  if (isStackedLayers(a, b, idx)) return 'stacked-layers';
  return floatingKind(a, idx) ?? floatingKind(b, idx);
}
