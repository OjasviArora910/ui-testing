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
export const overlapRule: Rule = {
  id: 'geometry.overlap', name: 'Overlapping content', category: 'layout', severity: 'major', basis: 'generic_rule',
  description: 'Two visible text-bearing or interactive elements occupy the same area and neither is layered UI (tooltip, dropdown, modal, popover, badge).',
  async evaluate(ctx) {
    const idx = new ElementIndex(ctx.elements);
    const els = candidates(ctx).filter((e) => (textBearing(e) && !inline(e)) || isInteractive(e));
    const out: Finding[] = [];
    for (let i = 0; i < els.length && out.length < MAX_PER_RULE; i++) {
      for (let j = i + 1; j < els.length && out.length < MAX_PER_RULE; j++) {
        const a = els[i]!; const b = els[j]!;
        const ratio = overlapRatio(a.box, b.box);
        if (ratio < ctx.config.geometry.overlapMinRatio) continue;
        if (isLegitimateOverlap(a, b, idx)) continue;
        const bothInteractive = isInteractive(a) && isInteractive(b);
        const strong = bothInteractive ? ratio >= ctx.config.geometry.overlapMinRatio : ratio >= 0.3;
        out.push(makeFinding(overlapRule, ctx, {
          classification: strong ? 'defect' : 'anomaly',
          severity: bothInteractive ? 'major' : 'minor',
          element: elementRef(a),
          expected: 'Visible elements should not cover each other unless they are layered UI such as a tooltip, dropdown, modal or popover',
          actual: `"${(a.name || a.text).slice(0, 40)}" (${fmtBox(a.box)}) overlaps "${(b.name || b.text).slice(0, 40)}" (${fmtBox(b.box)}) by ${Math.round(ratio * 100)}% of the smaller element (${b.selector})`,
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
export const smallTargetRule: Rule = {
  id: 'geometry.small-target', name: 'Small interactive target', category: 'usability', severity: 'minor', basis: 'generic_rule',
  description: 'Interactive element smaller than the minimum target size (WCAG 2.2 SC 2.5.8: 24x24 CSS px). Inline text links and native checkboxes/radios are exempt.',
  async evaluate(ctx) {
    const min = ctx.config.geometry.minTargetSize;
    const out: Finding[] = [];
    for (const e of candidates(ctx)) {
      if (out.length >= MAX_PER_RULE) break;
      if (!isInteractive(e) || isVisuallyHiddenPattern(e)) continue;
      if (e.tag === 'a' && inline(e)) continue; // inline exception
      if (e.tag === 'input' && ['checkbox', 'radio', 'hidden'].includes(e.type ?? '')) continue; // user-agent controls
      if (floatingKind(e, new ElementIndex(ctx.elements)) === 'badge') continue;
      if (e.box.width >= min && e.box.height >= min) continue;
      out.push(makeFinding(smallTargetRule, ctx, {
        classification: 'defect', element: elementRef(e),
        expected: `Interactive targets are at least ${min}x${min} CSS px`,
        actual: `"${(e.name || e.text).slice(0, 40)}" is ${Math.round(e.box.width)}x${Math.round(e.box.height)} px`,
      }));
    }
    return out;
  },
};

export const geometryRules: Rule[] = [overlapRule, textClippingRule, offScreenRule, horizontalOverflowRule, containerOverflowRule, zeroSizeRule, smallTargetRule];
