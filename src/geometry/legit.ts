import type { ElementInfo } from '../browser/types.js';
import { ElementIndex } from './primitives.js';

const FLOATING_ROLES = new Set(['tooltip', 'dialog', 'alertdialog', 'menu', 'listbox', 'popover', 'combobox-popup', 'status', 'alert']);
const FLOATING_CLASS = /(tooltip|popover|popup|dropdown|drop-down|menu|modal|overlay|toast|snackbar|backdrop|badge|dialog|flyout|floating|sticky)/i;

export type LegitKind = 'tooltip' | 'dropdown' | 'modal' | 'popover' | 'badge' | 'floating-ui';

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

/** A pair overlaps legitimately when either side is floating UI, or one contains the other. */
export function isLegitimateOverlap(a: ElementInfo, b: ElementInfo, idx: ElementIndex): LegitKind | 'nested' | null {
  if (idx.related(a, b)) return 'nested';
  return floatingKind(a, idx) ?? floatingKind(b, idx);
}
