import type { BrowserController } from '../browser/index.js';
import type { ConsoleEvent, NetworkEvent } from '../browser/types.js';
import { buildPageModel } from '../discovery/pageModel.js';
import { OVERLAP_PROBE_SCRIPT, type OverlapProbe } from '../geometry/probe.js';
import type { PageModel } from '../discovery/types.js';
import type { QAConfig } from '../shared/config.js';
import type { RuleContext } from './types.js';

export interface ContextInit {
  config: QAConfig;
  model?: PageModel;
  network?: NetworkEvent[];
  console?: ConsoleEvent[];
  functional?: RuleContext['functional'];
  axe?: RuleContext['axe'];
  keyboard?: RuleContext['keyboard'];
  visual?: RuleContext['visual'];
}

/** Snapshot of the current page + collected signals, in the shape rules consume. Read-only: performs no actions. */
export async function collectRuleContext(controller: BrowserController, init: ContextInit): Promise<RuleContext> {
  const [elements, metrics, text, model] = await Promise.all([
    controller.allElements(),
    controller.pageMetrics(),
    controller.page.evaluate('document.body ? document.body.innerText : ""') as Promise<string>,
    init.model ? Promise.resolve(init.model) : buildPageModel(controller),
  ]);
  return {
    page: controller.url, viewport: controller.currentViewport, model, elements, metrics,
    text: controller.redactor.redact(text), network: init.network ?? [], console: init.console ?? [],
    functional: init.functional ?? [], axe: init.axe ?? [], keyboard: init.keyboard ?? null, visual: init.visual ?? null,
    config: init.config,
    queries: {
      count: (selector) => controller.page.locator(selector).count().catch(() => 0),
      overlap: (a, b) => (controller.page.evaluate(`${OVERLAP_PROBE_SCRIPT}(${JSON.stringify(a)}, ${JSON.stringify(b)})`) as Promise<OverlapProbe | null>).catch(() => null),
    },
  };
}
