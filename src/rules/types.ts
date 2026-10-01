import type { ConsoleEvent, ElementInfo, NetworkEvent } from '../browser/types.js';
import type { PageModel } from '../discovery/types.js';
import type { AxeFinding, KeyboardResult } from '../accessibility/types.js';
import type { FunctionalResult } from '../functional/types.js';
import type { QAConfig } from '../shared/config.js';
import type { Basis, Finding, Severity, Viewport } from '../shared/types.js';
import type { VisualResult } from '../visual/types.js';

export interface PageMetrics { scrollWidth: number; clientWidth: number; scrollHeight: number; viewportHeight: number; title: string }

/** Everything a rule may look at. Collected once per (page, viewport) so rules stay pure and cheap. */
export interface RuleContext {
  page: string;
  viewport: Viewport;
  model: PageModel;
  /** Every element on the page (document-relative boxes). */
  elements: ElementInfo[];
  metrics: PageMetrics;
  /** Visible text of the page. */
  text: string;
  network: NetworkEvent[];
  console: ConsoleEvent[];
  functional: FunctionalResult[];
  axe: AxeFinding[];
  keyboard: KeyboardResult | null;
  visual: VisualResult | null;
  config: QAConfig;
  /** Live DOM queries for declarative (configured) rules. */
  queries?: { count(selector: string): Promise<number> };
}

/** Plugin contract. Adding a rule = register an object implementing this; the orchestrator never changes. */
export interface Rule {
  id: string;
  name: string;
  category: string;
  severity: Severity;
  description: string;
  basis: Basis;
  evaluate(context: RuleContext): Promise<Finding[]>;
}

export interface RuleRunResult {
  findings: Finding[];
  /** Rules that threw; reported, never turned into findings. */
  errors: { ruleId: string; message: string }[];
  rulesRun: string[];
}
