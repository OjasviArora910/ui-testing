import type { BoundingBox, Basis, Severity } from '../shared/types.js';

export type FunctionalKind = 'button' | 'link' | 'form';
export type FunctionalStatus = 'pass' | 'fail' | 'anomaly' | 'skipped';

/**
 * Outcome of one functional check. `fail` becomes a defect (it carries its own ground-truth basis);
 * `anomaly` goes to human review; `skipped` (e.g. blocked by ActionGuard) is recorded but is not a finding.
 */
export interface FunctionalResult {
  kind: FunctionalKind;
  /** Stable check name, e.g. "clickable", "navigation", "empty-submission". */
  check: string;
  status: FunctionalStatus;
  severity: Severity;
  basis: Basis | null;
  element: { selector: string; role?: string; name?: string; box?: BoundingBox } | null;
  expected: string;
  actual: string;
  details?: Record<string, unknown>;
  durationMs?: number;
}

import type { BrowserController } from '../browser/index.js';
import type { PageModel } from '../discovery/types.js';
import type { QAConfig } from '../shared/config.js';
import type { ActionGuard } from './actionGuard.js';

/** Shared action budget (config.maxActions). Every navigation/click/fill performed by a test consumes one unit. */
export class ActionBudget {
  used = 0;
  constructor(public readonly max: number) {}
  get exhausted(): boolean { return this.used >= this.max; }
  get remaining(): number { return Math.max(0, this.max - this.used); }
  /** Returns false when the budget is already spent (the caller must stop). */
  consume(n = 1): boolean { if (this.exhausted) return false; this.used += n; return true; }
}

export interface FunctionalContext {
  controller: BrowserController;
  guard: ActionGuard;
  /** URL of the page under test (tests re-navigate here to reset state between actions). */
  pageUrl: string;
  model: PageModel;
  config: QAConfig;
  budget: ActionBudget;
  /** Link targets already tested during this run (site-wide nav links are only followed once). */
  testedLinks?: Set<string>;
  /** Optional hook so the orchestrator can persist each action. */
  onAction?: (a: { type: string; target: string; ok: boolean; detail?: string }) => void;
}
