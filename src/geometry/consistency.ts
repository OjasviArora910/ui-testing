import type { ElementInfo } from '../browser/types.js';
import { elementRef, makeFinding } from '../rules/helpers.js';
import type { Rule, RuleContext } from '../rules/types.js';
import type { Finding } from '../shared/types.js';
import { ElementIndex, area, bottom, isVisuallyHiddenPattern, overlapRatio, right } from './primitives.js';

const MAX_PER_RULE = 10;
/** Smaller than this in either dimension an image is an icon, spacer or placeholder, not a picture whose shape matters. */
const MIN_PICTURE = 48;
const sameOrigin = (src: string, page: string): boolean => { try { return new URL(src, page).origin === new URL(page).origin; } catch { return false; } };
const isSvg = (src: string): boolean => /\.svg(\?|#|$)|^data:image\/svg/i.test(src);

// ---------------------------------------------------------------- images
export const brokenImageRule: Rule = {
  id: 'image.broken', name: 'Broken image', category: 'layout', severity: 'major', basis: 'deterministic',
  description: 'A visible same-origin image finished loading with no pixel data (missing or invalid file). Cross-origin images are not judged because the test browser blocks external hosts.',
  async evaluate(ctx) {
    const out: Finding[] = [];
    for (const img of ctx.model.images) {
      const src = String(img.meta?.src ?? '');
      if (!img.visible || !src || isSvg(src) || !sameOrigin(src, ctx.page)) continue;
      if (img.meta?.complete !== true || Number(img.meta?.naturalWidth ?? 0) > 0) continue;
      out.push(makeFinding(brokenImageRule, ctx, {
        classification: 'defect', element: { selector: img.selector, role: 'img', name: img.name || src.slice(-60), box: img.box },
        expected: 'Images load and render', actual: `Image ${src.slice(0, 160)} did not load (natural size 0x0); the page shows a broken image${img.name ? ` with alt text "${img.name.slice(0, 60)}"` : ''}`,
      }));
      if (out.length >= MAX_PER_RULE) break;
    }
    return out;
  },
};

export const distortedImageRule: Rule = {
  id: 'image.distorted', name: 'Distorted image', category: 'layout', severity: 'minor', basis: 'deterministic',
  description: 'A loaded picture is visibly stretched or squashed: both of its dimensions are forced, object-fit is the default "fill", and its shape differs from the picture by 30% or more. A size that merely differs from the natural size, a placeholder, an icon or a decorative strip is not distortion.',
  async evaluate(ctx) {
    const out: Finding[] = [];
    const bySelector = new Map(ctx.elements.map((e) => [e.selector, e]));
    for (const img of ctx.model.images) {
      const el = bySelector.get(img.selector);
      const nw = Number(img.meta?.naturalWidth ?? 0); const nh = Number(img.meta?.naturalHeight ?? 0);
      if (!el || !el.visible || nw <= 0 || nh <= 0 || isSvg(String(img.meta?.src ?? ''))) continue;
      if (img.meta?.complete !== true) continue; // still loading: what is rendered is not the picture yet
      // A real picture, not a 1px placeholder, spacer, icon or gradient strip that is meant to be stretched.
      if (nw < MIN_PICTURE || nh < MIN_PICTURE || el.box.width < MIN_PICTURE || el.box.height < MIN_PICTURE) continue;
      if (el.styles.objectFit && el.styles.objectFit !== 'fill') continue;
      const natural = nw / nh; const rendered = el.box.width / el.box.height;
      // how far the shape is from the picture's own, the same in both directions (stretched wide or squashed narrow)
      const off = Math.max(rendered, natural) / Math.min(rendered, natural) - 1;
      if (off < 0.3) continue;
      out.push(makeFinding(distortedImageRule, ctx, {
        classification: 'defect', element: elementRef(el),
        expected: 'Images keep their natural aspect ratio (or declare object-fit)',
        actual: `Image is ${nw}x${nh} (ratio ${natural.toFixed(2)}) but rendered ${Math.round(el.box.width)}x${Math.round(el.box.height)} (ratio ${rendered.toFixed(2)}): ${rendered > natural ? 'stretched wide' : 'squashed narrow'} by ${Math.round(off * 100)}%`,
      }));
      if (out.length >= MAX_PER_RULE) break;
    }
    return out;
  },
};

// ---------------------------------------------------------------- duplicate / stacked elements
export const stackedDuplicateRule: Rule = {
  id: 'layout.stacked-duplicate', name: 'Duplicate elements stacked on each other', category: 'layout', severity: 'minor', basis: 'generic_rule',
  description: 'Two visible elements with the same tag and text occupy the same place. Usually a double render; reported for review because stacked slides and transitions can look the same.',
  async evaluate(ctx) {
    if (!ctx.config.dynamic?.consistencyChecks) return []; // a geometry hint, not evidence of a defect
    const idx = new ElementIndex(ctx.elements);
    const els = ctx.elements.filter((e) => e.visible && !e.aria.hidden && e.ownText.length >= 3 && area(e.box) > 0 && !isVisuallyHiddenPattern(e)).slice(0, ctx.config.geometry.maxElements);
    const byKey = new Map<string, ElementInfo[]>();
    for (const e of els) { const k = `${e.tag}|${e.ownText}`; byKey.set(k, [...(byKey.get(k) ?? []), e]); }
    const out: Finding[] = [];
    for (const group of byKey.values()) {
      for (let i = 0; i < group.length && out.length < MAX_PER_RULE; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i]!; const b = group[j]!;
          if (idx.related(a, b) || overlapRatio(a.box, b.box) < 0.9) continue;
          out.push(makeFinding(stackedDuplicateRule, ctx, {
            classification: 'anomaly', element: elementRef(a), expected: 'Each piece of content is rendered once',
            actual: `<${a.tag}> "${a.ownText.slice(0, 50)}" is rendered twice in the same place (${a.selector} and ${b.selector})`,
          }));
          break;
        }
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------- spacing / alignment among similar siblings
interface Group { parent: ElementInfo | undefined; items: ElementInfo[]; axis: 'row' | 'column' | 'loose'; others: ElementInfo[] }
const spread = (v: number[]): number => Math.max(...v) - Math.min(...v);
const median = (v: number[]): number => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };

/** Three or more in-flow siblings of the same kind (same tag and class): cards, nav items, list rows, buttons in a toolbar. */
function siblingGroups(ctx: RuleContext): Group[] {
  const idx = new ElementIndex(ctx.elements);
  const buckets = new Map<string, ElementInfo[]>();
  for (const e of ctx.elements.slice(0, ctx.config.geometry.maxElements)) {
    if (!e.visible || e.aria.hidden || e.parentId === null || area(e.box) === 0) continue;
    if (e.styles.position === 'absolute' || e.styles.position === 'fixed' || e.styles.display === 'inline' || e.styles.display === 'contents') continue;
    if (['tr', 'td', 'th', 'option', 'br', 'script', 'style'].includes(e.tag)) continue;
    const k = `${e.parentId}|${e.tag}|${e.className}`;
    buckets.set(k, [...(buckets.get(k) ?? []), e]);
  }
  const children = new Map<number, ElementInfo[]>();
  for (const e of ctx.elements) if (e.visible && e.parentId !== null && area(e.box) > 0) children.set(e.parentId, [...(children.get(e.parentId) ?? []), e]);
  const out: Group[] = [];
  for (const items of buckets.values()) {
    if (items.length < 3 || items.length > 40) continue;
    const row = spread(items.map((e) => e.box.y)) <= 2;
    const column = spread(items.map((e) => e.box.x)) <= 2;
    out.push({ parent: idx.parent(items[0]!), items: [...items].sort((a, b) => (row ? a.box.x - b.box.x : a.box.y - b.box.y)), axis: row ? 'row' : column ? 'column' : 'loose', others: (children.get(items[0]!.parentId!) ?? []).filter((c) => !items.includes(c)) });
  }
  return out;
}

export const spacingRule: Rule = {
  id: 'consistency.spacing', name: 'Inconsistent spacing between similar elements', category: 'layout', severity: 'minor', basis: 'generic_rule',
  description: 'Similar sibling elements laid out in one row or column have clearly different gaps between them. Heuristic: always reported for review, never as a defect.',
  async evaluate(ctx) {
    if (!ctx.config.dynamic?.consistencyChecks) return []; // a geometry hint, not evidence of a defect
    const out: Finding[] = [];
    for (const g of siblingGroups(ctx)) {
      // needs at least three gaps for "one odd gap" to mean anything, and nothing else sitting between the items
      if (g.axis === 'loose' || g.items.length < 4 || out.length >= MAX_PER_RULE) continue;
      const [lo, hi] = g.axis === 'row' ? [g.items[0]!.box.x, right(g.items[g.items.length - 1]!.box)] : [g.items[0]!.box.y, bottom(g.items[g.items.length - 1]!.box)];
      if (g.others.some((o) => { const mid = g.axis === 'row' ? o.box.x + o.box.width / 2 : o.box.y + o.box.height / 2; return mid > lo && mid < hi; })) continue;
      const gaps = g.items.slice(1).map((e, i) => (g.axis === 'row' ? e.box.x - right(g.items[i]!.box) : e.box.y - bottom(g.items[i]!.box)));
      if (gaps.some((x) => x < 0)) continue; // overlapping siblings are the overlap rule's business
      const med = median(gaps);
      const worst = gaps.reduce((w, x, i) => (Math.abs(x - med) > Math.abs(gaps[w]! - med) ? i : w), 0);
      const off = Math.abs(gaps[worst]! - med);
      if (off < Math.max(6, med * 0.5)) continue;
      // a group whose gaps simply all differ (e.g. justified text-like layouts) is not "one odd gap"
      if (gaps.filter((x) => Math.abs(x - med) <= 2).length < Math.ceil(gaps.length / 2)) continue;
      const odd = g.items[worst + 1]!;
      out.push(makeFinding(spacingRule, ctx, {
        classification: 'anomaly', element: elementRef(odd),
        expected: `Similar ${g.axis === 'row' ? 'side-by-side' : 'stacked'} elements are evenly spaced (about ${Math.round(med)}px apart)`,
        actual: `${g.items.length} similar <${odd.tag}> elements are ${Math.round(med)}px apart, but the gap before "${(odd.name || odd.text).slice(0, 40)}" is ${Math.round(gaps[worst]!)}px`,
      }));
    }
    return out;
  },
};

export const alignmentRule: Rule = {
  id: 'consistency.alignment', name: 'Misaligned similar elements', category: 'layout', severity: 'minor', basis: 'generic_rule',
  description: 'One of several similar sibling elements is offset by a few pixels from the edge the others share. Heuristic: always reported for review, never as a defect.',
  async evaluate(ctx) {
    if (!ctx.config.dynamic?.consistencyChecks) return []; // a geometry hint, not evidence of a defect
    const out: Finding[] = [];
    for (const g of siblingGroups(ctx)) {
      if (g.axis !== 'loose' || out.length >= MAX_PER_RULE) continue;
      for (const [edge, size, label] of [['y', 'height', 'top'], ['x', 'width', 'left']] as const) {
        const values = g.items.map((e) => e.box[edge]);
        const med = median(values);
        const aligned = values.filter((v) => Math.abs(v - med) <= 1).length;
        const limit = Math.min(...g.items.map((e) => e.box[size])) / 2;
        const odd = g.items.filter((e) => { const d = Math.abs(e.box[edge] - med); return d >= 3 && d < limit; });
        // exactly one element slightly off an edge that all the others share
        if (odd.length !== 1 || aligned !== g.items.length - 1) continue;
        out.push(makeFinding(alignmentRule, ctx, {
          classification: 'anomaly', element: elementRef(odd[0]!),
          expected: `Similar elements share the same ${label} edge`,
          actual: `"${(odd[0]!.name || odd[0]!.text).slice(0, 40)}" is ${Math.round(Math.abs(odd[0]!.box[edge] - med))}px off the ${label} edge shared by ${aligned} similar <${odd[0]!.tag}> elements`,
        }));
        break;
      }
    }
    return out;
  },
};

export const consistencyRules: Rule[] = [brokenImageRule, distortedImageRule, stackedDuplicateRule, spacingRule, alignmentRule];
