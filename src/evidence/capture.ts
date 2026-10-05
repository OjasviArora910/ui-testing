import type { BrowserController } from '../browser/index.js';
import type { RuleContext } from '../rules/types.js';
import type { Finding } from '../shared/types.js';
import type { VisualCheckOutput } from '../visual/index.js';
import type { EvidenceRef, EvidenceStore } from './store.js';

/** Page-level evidence captured once per (page, viewport) and shared by every finding on it. */
export interface PageEvidence {
  screenshot?: EvidenceRef;
  dom?: EvidenceRef;
  aria?: EvidenceRef;
  geometry?: EvidenceRef;
  network?: EvidenceRef;
  console?: EvidenceRef;
  metadata?: EvidenceRef;
  visualCurrent?: EvidenceRef;
  visualBaseline?: EvidenceRef;
  visualDiff?: EvidenceRef;
  all: EvidenceRef[];
}

/** Capture the evidence set for a page at its current state. Each piece is best-effort: failure never aborts a run. */
export async function capturePageEvidence(controller: BrowserController, store: EvidenceStore, runId: string, ctx: RuleContext, visual?: VisualCheckOutput): Promise<PageEvidence> {
  const meta = { page: ctx.page, viewport: ctx.viewport.name };
  const out: PageEvidence = { all: [] };
  const keep = (k: keyof Omit<PageEvidence, 'all'>, ref: EvidenceRef | undefined) => { if (ref) { out[k] = ref; out.all.push(ref); } };
  const attempt = async (fn: () => Promise<EvidenceRef | undefined> | EvidenceRef | undefined): Promise<EvidenceRef | undefined> => {
    try { return await fn(); } catch { return undefined; }
  };

  keep('screenshot', await attempt(async () => store.saveBinary(runId, 'screenshot', await controller.screenshot({ fullPage: true }), 'png', { ...meta, label: `${ctx.viewport.name} full page` })));
  keep('dom', await attempt(async () => store.saveText(runId, 'dom', await controller.dom(), 'html', { ...meta, label: 'DOM snapshot' })));
  keep('aria', await attempt(async () => store.saveText(runId, 'aria', await controller.aria(), 'yaml', { ...meta, label: 'ARIA snapshot' })));
  keep('geometry', await attempt(() => store.saveJson(runId, 'geometry', {
    viewport: ctx.viewport, metrics: ctx.metrics,
    elements: ctx.elements.filter((e) => e.visible).slice(0, 800).map((e) => ({ selector: e.selector, role: e.role, name: e.name.slice(0, 60), box: e.box, position: e.styles.position, overflowX: e.styles.overflowX, zIndex: e.styles.zIndex })),
  }, { ...meta, label: 'geometry' })));
  keep('network', await attempt(() => store.saveJson(runId, 'network', ctx.network, { ...meta, label: `network (${ctx.network.length} events)` })));
  keep('console', await attempt(() => store.saveJson(runId, 'console', ctx.console, { ...meta, label: `console (${ctx.console.length} events)` })));
  keep('metadata', await attempt(() => store.saveJson(runId, 'metadata', { page: ctx.page, viewport: ctx.viewport, title: ctx.metrics.title, capturedAt: new Date().toISOString(), counts: ctx.model.counts, status: ctx.model.status }, { ...meta, label: 'metadata' })));
  if (visual) {
    if (visual.currentPng.length > 0) keep('visualCurrent', await attempt(() => store.saveBinary(runId, 'visual-current', visual.currentPng, 'png', { ...meta, label: 'current screenshot' })));
    if (visual.baselinePng) keep('visualBaseline', await attempt(() => store.saveBinary(runId, 'visual-baseline', visual.baselinePng!, 'png', { ...meta, label: 'baseline' })));
    if (visual.diffPng) keep('visualDiff', await attempt(() => store.saveBinary(runId, 'visual-diff', visual.diffPng!, 'png', { ...meta, label: 'visual diff' })));
  }
  return out;
}

/**
 * Captures a screenshot of the failing element highlighted with a clear red bounding box and tag in the surrounding UI context.
 * Scrolls the element into the center of the viewport, applies high-visibility red outline/badge, captures the screenshot,
 * cleans up the DOM, and returns an EvidenceRef.
 */
export async function captureHighlightedElementScreenshot(
  controller: BrowserController,
  store: EvidenceStore,
  runId: string,
  finding: Finding
): Promise<EvidenceRef | undefined> {
  const sel = finding.element?.selector;
  if (!sel || sel.length > 800) return undefined;

  try {
    const highlighted = await controller.page.evaluate(
      (payload: { selector: string; ruleId: string }) => {
        const selectors = payload.selector.split(',').map((s) => s.trim()).filter(Boolean);
        const elements: HTMLElement[] = [];
        for (const s of selectors) {
          try {
            const matched = Array.from(document.querySelectorAll<HTMLElement>(s));
            elements.push(...matched);
          } catch {
            // invalid selector syntax fallback
          }
        }

        if (elements.length === 0) return false;

        // Scroll the primary element to the center of the viewport
        elements[0]!.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });

        // Apply high-contrast red outline and glow to all matched elements
        for (const el of elements) {
          el.setAttribute('data-qa-prev-outline', el.style.outline || '');
          el.setAttribute('data-qa-prev-boxshadow', el.style.boxShadow || '');
          el.style.setProperty('outline', '3px solid #ef4444', 'important');
          el.style.setProperty('outline-offset', '3px', 'important');
          el.style.setProperty('box-shadow', '0 0 0 5px rgba(239, 68, 68, 0.35), 0 0 16px rgba(239, 68, 68, 0.8)', 'important');
        }

        // Add a high-visibility badge tag next to the primary element
        const firstRect = elements[0]!.getBoundingClientRect();
        const badge = document.createElement('div');
        badge.id = '__qa_highlight_tag__';
        badge.style.position = 'fixed';
        badge.style.left = `${Math.max(4, firstRect.left)}px`;
        badge.style.top = `${Math.max(4, firstRect.top - 24)}px`;
        badge.style.backgroundColor = '#ef4444';
        badge.style.color = '#ffffff';
        badge.style.fontSize = '12px';
        badge.style.fontWeight = 'bold';
        badge.style.fontFamily = 'monospace, sans-serif';
        badge.style.padding = '3px 8px';
        badge.style.borderRadius = '4px';
        badge.style.zIndex = '2147483647';
        badge.style.pointerEvents = 'none';
        badge.style.boxShadow = '0 2px 8px rgba(0,0,0,0.6)';
        badge.textContent = `⚠ ${payload.ruleId}`;
        document.body.appendChild(badge);

        return true;
      },
      { selector: sel, ruleId: finding.ruleId }
    );

    if (!highlighted) {
      return captureElementCrop(controller, store, runId, finding);
    }

    await controller.page.waitForTimeout(60);
    const png = await controller.page.screenshot({ type: 'png' });

    // Clean up DOM modifications
    await controller.page.evaluate(() => {
      const tagged = document.querySelectorAll<HTMLElement>('[data-qa-prev-outline]');
      for (const el of Array.from(tagged)) {
        const prevOutline = el.getAttribute('data-qa-prev-outline') || '';
        const prevShadow = el.getAttribute('data-qa-prev-boxshadow') || '';
        if (prevOutline) el.style.outline = prevOutline; else el.style.removeProperty('outline');
        if (prevShadow) el.style.boxShadow = prevShadow; else el.style.removeProperty('box-shadow');
        el.style.removeProperty('outline-offset');
        el.removeAttribute('data-qa-prev-outline');
        el.removeAttribute('data-qa-prev-boxshadow');
      }
      document.getElementById('__qa_highlight_tag__')?.remove();
    }).catch(() => undefined);

    return store.saveBinary(runId, 'element-crop', png, 'png', {
      page: finding.page,
      viewport: finding.viewport,
      label: `Highlighted element (${finding.ruleId}) in context`,
    });
  } catch {
    return captureElementCrop(controller, store, runId, finding);
  }
}

/** Element crop for one finding (tight bounding box fallback). */
export async function captureElementCrop(controller: BrowserController, store: EvidenceStore, runId: string, finding: Finding): Promise<EvidenceRef | undefined> {
  const sel = finding.element?.selector;
  if (!sel || sel.length > 400) return undefined;
  try {
    const loc = controller.page.locator(sel).first();
    const png = await loc.screenshot({ timeout: 1500, animations: 'disabled' });
    return store.saveBinary(runId, 'element-crop', png, 'png', { page: finding.page, viewport: finding.viewport, label: `crop ${sel.slice(0, 60)}` });
  } catch { return undefined; }
}

/**
 * Evidence for one finding. When the finding has its OWN proof (before/after/trace of the action that produced it), only
 * that proof, the element highlight and the metadata are attached: page-wide dumps taken after the page was reset would not
 * show the failure. Otherwise: the page-level evidence relevant to the finding's category, plus screenshot + metadata.
 */
export function evidenceFor(finding: Finding, ev: PageEvidence, crop?: EvidenceRef, own: EvidenceRef[] = []): EvidenceRef[] {
  const pick = (...ks: (keyof Omit<PageEvidence, 'all'>)[]): EvidenceRef[] => ks.map((k) => ev[k]).filter((x): x is EvidenceRef => !!x);
  const byCategory: Record<string, (keyof Omit<PageEvidence, 'all'>)[]> = {
    layout: ['geometry', 'dom'], responsive: ['geometry', 'dom'], usability: ['geometry', 'dom'],
    network: ['network'], performance: ['network'], console: ['console', 'network'],
    functional: ['network', 'console', 'dom'], accessibility: ['dom', 'aria'],
    visual: ['visualCurrent', 'visualBaseline', 'visualDiff'],
  };
  if (own.length > 0) return [...new Map([...own, ...(crop ? [crop] : []), ...pick('metadata')].map((r) => [r.id, r])).values()];
  const refs = [...(crop ? [crop] : []), ...pick('screenshot'), ...pick(...(byCategory[finding.category] ?? ['dom'])), ...pick('metadata')];
  return [...new Map(refs.map((r) => [r.id, r])).values()];
}
