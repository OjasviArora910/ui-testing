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

/** Element crop for one finding (best effort, short timeout). */
export async function captureElementCrop(controller: BrowserController, store: EvidenceStore, runId: string, finding: Finding): Promise<EvidenceRef | undefined> {
  const sel = finding.element?.selector;
  if (!sel || sel.length > 400) return undefined;
  try {
    const loc = controller.page.locator(sel).first();
    const png = await loc.screenshot({ timeout: 1500, animations: 'disabled' });
    return store.saveBinary(runId, 'element-crop', png, 'png', { page: finding.page, viewport: finding.viewport, label: `crop ${sel.slice(0, 60)}` });
  } catch { return undefined; }
}

/** Which page-level evidence is relevant for a finding category. Always includes the screenshot + metadata. */
export function evidenceFor(finding: Finding, ev: PageEvidence, crop?: EvidenceRef): EvidenceRef[] {
  const pick = (...ks: (keyof Omit<PageEvidence, 'all'>)[]): EvidenceRef[] => ks.map((k) => ev[k]).filter((x): x is EvidenceRef => !!x);
  const byCategory: Record<string, (keyof Omit<PageEvidence, 'all'>)[]> = {
    layout: ['geometry', 'dom'], responsive: ['geometry', 'dom'], usability: ['geometry', 'dom'],
    network: ['network'], performance: ['network'], console: ['console', 'network'],
    functional: ['network', 'console', 'dom'], accessibility: ['dom', 'aria'],
    visual: ['visualCurrent', 'visualBaseline', 'visualDiff'],
  };
  const refs = [...pick('screenshot'), ...(crop ? [crop] : []), ...pick(...(byCategory[finding.category] ?? ['dom'])), ...pick('metadata')];
  return [...new Map(refs.map((r) => [r.id, r])).values()];
}
