import type { ElementInfo } from '../browser/types.js';
import { elementRef, fmtBox, makeFinding } from '../rules/helpers.js';
import type { Rule, RuleContext } from '../rules/types.js';
import type { Finding } from '../shared/types.js';
import { floatingKind, isLegitimateOverlap } from './legit.js';
import { ElementIndex, area, bottom, isInteractive, isVisuallyHiddenPattern, overlapRatio, right } from './primitives.js';

const MAX_PER_RULE = 25;
const SKIP_TAGS = new Set(['html', 'body', 'svg', 'path', 'g', 'br', 'hr', 'option', 'optgroup', 'tr', 'tbody', 'thead', 'tfoot', 'colgroup', 'col']);

function textBearing(e: ElementInfo): boolean { return e.ownText.length > 0; }
function inline(e: ElementInfo): boolean { return e.styles.display === 'inline'; }

/** Elements that are rendered, non-trivial and not marked decorative. */
function candidates(ctx: RuleContext): ElementInfo[] {
  return ctx.elements.filter((e) => e.visible && !e.aria.hidden && !SKIP_TAGS.has(e.tag) && area(e.box) > 0).slice(0, ctx.config.geometry.maxElements);
}

// ---------------------------------------------------------------- overlap
const MAX_OVERLAP_PROBES = 80;

/**
 * Intersecting bounding boxes are only a CANDIDATE. A finding needs proof that content is really obscured:
 *  1. the pair is not intentional composition or layering (nested, embedded control, floating UI, stacked layers);
 *  2. in the live page, the actual content of both (text line boxes, control/media boxes, after ancestor clipping and
 *     opacity) is rendered at the same place.
 * Only a material, hit-test-confirmed obstruction is a defect. Anything that cannot be confirmed goes to review, and
 * boxes that merely touch or intersect without obscuring content are not reported at all.
 */
export const overlapRule: Rule = {
  id: 'geometry.overlap', name: 'Overlapping content', category: 'layout', severity: 'major', basis: 'generic_rule',
  description: 'The content of two unrelated visible elements is rendered on top of each other (verified in the page, not from bounding boxes alone), and neither is layered or composed UI such as a tooltip, dropdown, modal, popover, badge, control inside a field, or stacked slides.',
  async evaluate(ctx) {
    const idx = new ElementIndex(ctx.elements);
    const els = candidates(ctx).filter((e) => (textBearing(e) && !inline(e)) || isInteractive(e));
    const out: Finding[] = [];
    let probes = 0;
    for (let i = 0; i < els.length && out.length < MAX_PER_RULE; i++) {
      for (let j = i + 1; j < els.length && out.length < MAX_PER_RULE; j++) {
        const a = els[i]!; const b = els[j]!;
        const boxRatio = overlapRatio(a.box, b.box);
        if (boxRatio < ctx.config.geometry.overlapMinRatio) continue;
        if (isLegitimateOverlap(a, b, idx)) continue;
        const bothInteractive = isInteractive(a) && isInteractive(b);
        const names = `"${(a.name || a.text).slice(0, 40)}" (${fmtBox(a.box)}) and "${(b.name || b.text).slice(0, 40)}" (${fmtBox(b.box)}, ${b.selector})`;
        const expected = 'The content of unrelated visible elements does not cover each other (layered UI such as tooltips, dropdowns, modals and controls placed inside a field are fine)';

        const probe = ctx.queries?.overlap && probes < MAX_OVERLAP_PROBES ? (probes++, await ctx.queries.overlap(a.selector, b.selector)) : undefined;
        if (!probe) {
          // No way to look at the rendered result: box geometry alone never proves a defect.
          out.push(makeFinding(overlapRule, ctx, {
            classification: 'anomaly', severity: 'minor', element: elementRef(a), expected,
            actual: `The boxes of ${names} intersect by ${Math.round(boxRatio * 100)}% of the smaller one; whether content is actually obscured could not be verified`,
          }));
          continue;
        }
        if (probe.opacityA < 0.05 || probe.opacityB < 0.05) continue; // one of them is not rendered
        const smaller = Math.min(probe.contentA, probe.contentB);
        if (smaller <= 0) continue; // clipped away or no content of its own
        const ratio = probe.covered / smaller;
        if (ratio < 0.1) continue; // boxes intersect (padding, line spacing, proximity) but no content is obscured
        const confirmed = probe.verified >= probe.covered * 0.5;
        const strong = confirmed && (bothInteractive ? ratio >= ctx.config.geometry.overlapMinRatio : ratio >= 0.3);
        out.push(makeFinding(overlapRule, ctx, {
          classification: strong ? 'defect' : 'anomaly',
          severity: strong && bothInteractive ? 'major' : 'minor',
          element: elementRef(a), expected,
          actual: `${names} are rendered on top of each other: ${Math.round(probe.covered)}px² of content is covered, ${Math.round(ratio * 100)}% of the smaller element's content${confirmed ? ' (both confirmed at the same point by hit-testing)' : ' (not confirmed by hit-testing)'}`,
        }));
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------- text clipping
export const textClippingRule: Rule = {
  id: 'geometry.text-clipping', name: 'Clipped text', category: 'layout', severity: 'major', basis: 'deterministic',
  description: 'Text is cut off by overflow:hidden/clip without an ellipsis, so part of the content cannot be read.',
  async evaluate(ctx) {
    const out: Finding[] = [];
    for (const e of candidates(ctx)) {
      if (out.length >= MAX_PER_RULE) break;
      if (!textBearing(e) || isVisuallyHiddenPattern(e) || e.styles.webkitLineClamp && e.styles.webkitLineClamp !== 'none') continue;
      const hClip = ['hidden', 'clip'].includes(e.styles.overflowX) && e.scroll.scrollWidth > e.scroll.clientWidth + 1;
      const vClip = ['hidden', 'clip'].includes(e.styles.overflowY) && e.scroll.scrollHeight > e.scroll.clientHeight + 1;
      if (hClip && e.styles.textOverflow === 'ellipsis') continue; // intentional truncation
      if (!hClip && !vClip) continue;
      const dims = hClip ? `${e.scroll.scrollWidth}px of content in ${e.scroll.clientWidth}px` : `${e.scroll.scrollHeight}px of content in ${e.scroll.clientHeight}px`;
      out.push(makeFinding(textClippingRule, ctx, {
        classification: 'defect', element: elementRef(e),
        expected: 'All text is fully visible, or truncation is explicit (text-overflow: ellipsis)',
        actual: `Text "${e.ownText.slice(0, 50)}" is clipped (${dims}) with overflow:${hClip ? e.styles.overflowX : e.styles.overflowY} and no ellipsis`,
      }));
    }
    return out;
  },
};

// ---------------------------------------------------------------- off-screen
export const offScreenRule: Rule = {
  id: 'geometry.off-screen', name: 'Off-screen element', category: 'layout', severity: 'minor', basis: 'generic_rule',
  description: 'A rendered text-bearing or interactive element lies entirely outside the left/top edge of the page and cannot be scrolled to.',
  async evaluate(ctx) {
    const out: Finding[] = [];
    for (const e of candidates(ctx)) {
      if (out.length >= MAX_PER_RULE) break;
      if (!(textBearing(e) || isInteractive(e)) || isVisuallyHiddenPattern(e)) continue;
      const off = right(e.box) <= 0 || bottom(e.box) <= 0;
      if (!off) continue;
      // Positioned off-screen on purpose is common (off-canvas menus), so this needs a human: anomaly, not defect.
      out.push(makeFinding(offScreenRule, ctx, {
        classification: 'anomaly', element: elementRef(e),
        expected: 'Rendered content is reachable within the page bounds',
        actual: `Element ${fmtBox(e.box)} lies entirely outside the visible page area`,
      }));
    }
    return out;
  },
};

// ---------------------------------------------------------------- horizontal overflow
export const horizontalOverflowRule: Rule = {
  id: 'geometry.horizontal-overflow', name: 'Horizontal page overflow', category: 'layout', severity: 'major', basis: 'deterministic',
  description: 'The page is wider than the viewport, forcing horizontal scrolling.',
  async evaluate(ctx) {
    const { scrollWidth, clientWidth } = ctx.metrics;
    if (scrollWidth <= clientWidth + 1) return [];
    const culprits = candidates(ctx).filter((e) => right(e.box) > clientWidth + 1 && e.styles.position !== 'fixed')
      .sort((a, b) => right(b.box) - right(a.box)).slice(0, 3);
    const top = culprits[0];
    return [makeFinding(horizontalOverflowRule, ctx, {
      classification: 'defect', element: top ? elementRef(top) : null,
      expected: `Page width fits the ${ctx.viewport.name} viewport (${clientWidth}px) without horizontal scrolling`,
      actual: `Document is ${scrollWidth}px wide in a ${clientWidth}px viewport (+${scrollWidth - clientWidth}px)${culprits.length ? `; widest: ${culprits.map((c) => c.selector).join(', ')}` : ''}`,
    })];
  },
};

// ---------------------------------------------------------------- container overflow
export const containerOverflowRule: Rule = {
  id: 'geometry.container-overflow', name: 'Content overflows its container', category: 'layout', severity: 'minor', basis: 'deterministic',
  description: 'A normal-flow element extends past the edge of its non-scrolling parent container.',
  async evaluate(ctx) {
    const idx = new ElementIndex(ctx.elements);
    const out: Finding[] = [];
    for (const e of candidates(ctx)) {
      if (out.length >= MAX_PER_RULE) break;
      if (['img', 'table', 'video', 'canvas', 'iframe'].includes(e.tag) || inline(e)) continue; // handled by responsive rules
      if (['absolute', 'fixed', 'sticky'].includes(e.styles.position)) continue;
      const p = idx.parent(e);
      if (!p || p.tag === 'body' || p.tag === 'html' || area(p.box) === 0) continue;
      if (p.styles.overflowX !== 'visible' || p.styles.display === 'contents' || p.styles.display.includes('flex') && p.styles.flexWrap === 'wrap') continue;
      if (p.styles.display === 'table-cell' || p.styles.display === 'table-row') continue;
      const over = right(e.box) - right(p.box);
      const overLeft = p.box.x - e.box.x;
      if (over <= 2 && overLeft <= 2) continue;
      out.push(makeFinding(containerOverflowRule, ctx, {
        classification: 'defect', element: elementRef(e),
        expected: 'Child content stays inside its parent container, or the container scrolls',
        actual: `${e.selector} (${fmtBox(e.box)}) extends ${Math.round(Math.max(over, overLeft))}px beyond its parent ${p.selector} (${fmtBox(p.box)})`,
      }));
    }
    return out;
  },
};

// ---------------------------------------------------------------- zero size
export const zeroSizeRule: Rule = {
  id: 'geometry.zero-size', name: 'Zero-size interactive element', category: 'layout', severity: 'minor', basis: 'deterministic',
  description: 'An interactive element is rendered (display/visibility/opacity say visible) but has zero width or height, so users cannot see or click it.',
  async evaluate(ctx) {
    const idx = new ElementIndex(ctx.elements);
    const out: Finding[] = [];
    for (const e of ctx.elements) {
      if (out.length >= MAX_PER_RULE) break;
      if (e.visible || !isInteractive(e) || e.aria.hidden) continue;
      if (e.styles.display === 'none' || e.styles.visibility === 'hidden' || parseFloat(e.styles.opacity) === 0 || e.type === 'hidden') continue;
      const chain = idx.chain(e).slice(1);
      if (chain.some((a) => a.styles.display === 'none' || a.tag === 'details' || a.tag === 'dialog' || area(a.box) === 0)) continue; // hidden by an ancestor
      out.push(makeFinding(zeroSizeRule, ctx, {
        classification: 'defect', element: elementRef(e),
        expected: 'An element that is displayed has a non-zero size',
        actual: `Interactive element "${(e.name || e.text).slice(0, 40)}" renders at ${Math.round(e.box.width)}x${Math.round(e.box.height)} although display:${e.styles.display}, visibility:${e.styles.visibility}`,
      }));
    }
    return out;
  },
};

// ---------------------------------------------------------------- small targets
/** Controls whose rendered size is decided by the browser or by their text, not by a pointer target the author sized. */
function sizedByBrowser(e: ElementInfo): boolean {
  if (e.tag === 'select' || e.tag === 'textarea') return true;
  return e.tag === 'input' && !['button', 'submit', 'reset', 'image'].includes(e.type ?? 'text');
}

export const smallTargetRule: Rule = {
  id: 'geometry.small-target', name: 'Small interactive target', category: 'accessibility', severity: 'minor', basis: 'generic_rule',
  description: 'A custom pointer target is clearly smaller than the minimum target size in BOTH dimensions (WCAG 2.2 SC 2.5.8: 24x24 CSS px). Inline text links, native form controls and targets that are small in one dimension only are not defects.',
  async evaluate(ctx) {
    if (!ctx.config.accessibility.enabled) return []; // target size is an accessibility criterion (WCAG 2.5.8): out of scope unless enabled
    const min = ctx.config.geometry.minTargetSize;
    const tolerance = 2; // sub-pixel rounding and 1px borders are not a usability problem
    const idx = new ElementIndex(ctx.elements);
    const out: Finding[] = [];
    for (const e of candidates(ctx)) {
      if (out.length >= MAX_PER_RULE) break;
      if (!isInteractive(e) || isVisuallyHiddenPattern(e)) continue;
      if (e.tag === 'a' && inline(e)) continue; // inline exception
      if (sizedByBrowser(e)) continue; // user-agent controls (text fields, sliders, checkboxes, selects)
      if (floatingKind(e, idx) === 'badge') continue;
      const w = e.box.width; const h = e.box.height;
      if (w >= min - tolerance && h >= min - tolerance) continue;
      // Small in one dimension only (a wide text link, a thin bar): reachable, so at most worth a look.
      const bothSmall = w < min - tolerance && h < min - tolerance;
      if (!bothSmall && Math.min(w, h) >= min * 0.75) continue;
      out.push(makeFinding(smallTargetRule, ctx, {
        classification: bothSmall ? 'defect' : 'anomaly', element: elementRef(e),
        expected: `Interactive targets are at least ${min}x${min} CSS px`,
        actual: `"${(e.name || e.text).slice(0, 40)}" is ${Math.round(w)}x${Math.round(h)} px${bothSmall ? '' : ' (small in one dimension only)'}`,
      }));
    }
    return out;
  },
};

export const geometryRules: Rule[] = [overlapRule, textClippingRule, offScreenRule, horizontalOverflowRule, containerOverflowRule, zeroSizeRule, smallTargetRule];
