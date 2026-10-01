import type { ElementInfo } from '../browser/types.js';
import type { BoundingBox } from '../shared/types.js';

export function right(b: BoundingBox): number { return b.x + b.width; }
export function bottom(b: BoundingBox): number { return b.y + b.height; }
export function area(b: BoundingBox): number { return Math.max(0, b.width) * Math.max(0, b.height); }

export function intersection(a: BoundingBox, b: BoundingBox): BoundingBox | null {
  const x = Math.max(a.x, b.x); const y = Math.max(a.y, b.y);
  const w = Math.min(right(a), right(b)) - x; const h = Math.min(bottom(a), bottom(b)) - y;
  return w > 0 && h > 0 ? { x, y, width: w, height: h } : null;
}

/** Intersection area divided by the SMALLER box's area: 1 means one box is fully covered by the other. */
export function overlapRatio(a: BoundingBox, b: BoundingBox): number {
  const i = intersection(a, b);
  if (!i) return 0;
  const m = Math.min(area(a), area(b));
  return m === 0 ? 0 : area(i) / m;
}

export class ElementIndex {
  private readonly byId = new Map<number, ElementInfo>();
  constructor(public readonly elements: ElementInfo[]) { for (const e of elements) this.byId.set(e.id, e); }
  get(id: number | null): ElementInfo | undefined { return id === null ? undefined : this.byId.get(id); }
  parent(e: ElementInfo): ElementInfo | undefined { return this.get(e.parentId); }
  /** Self first, then parents up to <body>. */
  chain(e: ElementInfo): ElementInfo[] {
    const out: ElementInfo[] = []; let cur: ElementInfo | undefined = e;
    while (cur && out.length < 60) { out.push(cur); cur = this.parent(cur); }
    return out;
  }
  isAncestor(a: ElementInfo, of: ElementInfo): boolean { return this.chain(of).slice(1).some((x) => x.id === a.id); }
  related(a: ElementInfo, b: ElementInfo): boolean { return this.isAncestor(a, b) || this.isAncestor(b, a); }
}

const INTERACTIVE_ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'tab', 'menuitem', 'option']);
export function isInteractive(e: ElementInfo): boolean {
  if (['button', 'select', 'textarea', 'summary'].includes(e.tag)) return true;
  if (e.tag === 'a') return e.href !== undefined && e.href !== null;
  if (e.tag === 'input') return e.type !== 'hidden';
  return e.role !== null && INTERACTIVE_ROLES.has(e.role);
}

/** Visually-hidden helper patterns (sr-only, skip links) that are intentionally tiny or off-screen. */
export function isVisuallyHiddenPattern(e: ElementInfo): boolean {
  const w = e.box.width; const h = e.box.height;
  if (w <= 2 || h <= 2) return true;
  if (/(sr-only|visually-hidden|screen-reader|skip)/i.test(e.className)) return true;
  if (e.styles.clip && e.styles.clip !== 'auto') return true;
  if (/^(skip|jump)\b/i.test(e.text) && /link|button/.test(e.role ?? '')) return true;
  return false;
}
