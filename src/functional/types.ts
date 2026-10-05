import type { BoundingBox, Basis, Severity } from '../shared/types.js';

export type FunctionalKind =
  | 'button'
  | 'link'
  | 'form'
  | 'tab'
  | 'accordion'
  | 'modal'
  | 'dropdown'
  | 'search'
  | 'interactive';

export type FunctionalStatus = 'pass' | 'fail' | 'anomaly' | 'skipped';

export type ActionPhase = 'TARGETED' | 'MOVING' | 'CLICKING' | 'OBSERVING' | 'VERIFYING' | 'RESULT';
export type VerificationVerdict = 'PASS' | 'FAIL' | 'NEEDS_REVIEW' | 'BLOCKED';
export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export type SemanticIntentKind =
  | 'NAVIGATE'
  | 'SUBMIT_FORM'
  | 'OPEN_MODAL'
  | 'DISMISS_MODAL'
  | 'SWITCH_TAB'
  | 'TOGGLE_ACCORDION'
  | 'FILTER_OR_SORT'
  | 'TOGGLE'
  | 'SEARCH'
  | 'GENERAL_ACTION';

export interface InferredIntent {
  kind: SemanticIntentKind;
  confidence: ConfidenceLevel;
  summary: string;
  expectedOutcome: {
    description: string;
    expectedUrlChange?: boolean;
    expectedModalOpen?: boolean;
    expectedModalClose?: boolean;
    expectedAriaExpanded?: boolean;
    expectedAriaSelected?: boolean;
    expectedAriaChecked?: boolean;
    expectedDomMutation?: boolean;
    expectedNetworkWrite?: boolean;
    expectedValidation?: boolean;
    targetSelector?: string;
    controlledSelector?: string;
  };
}

export interface PreActionSnapshot {
  url: string;
  title: string;
  domDigest: string;
  elementCount: number;
  dialogsCount: number;
  openDialogSelectors: string[];
  openMenuSelectors: string[];
  ariaExpandedCount: number;
  toastsCount: number;
  targetState?: {
    tag: string;
    classes: string[];
    ariaExpanded: string | null;
    ariaSelected: string | null;
    ariaChecked: string | null;
    ariaControls: string | null;
    disabled: boolean;
    visible: boolean;
  } | null;
  networkCount: number;
  consoleCount: number;
  timestamp: number;
  screenshot?: Buffer;
}

export interface PostActionObservation {
  pre: PreActionSnapshot;
  finalUrl: string;
  urlChanged: boolean;
  navigated: boolean;
  durationMs: number;
  domMutations: {
    addedNodesCount: number;
    removedNodesCount: number;
    textChanged: boolean;
    attributeChanges: string[];
    newTextSnippet?: string;
  };
  dialogs: {
    opened: string[];
    closed: string[];
    countBefore: number;
    countAfter: number;
  };
  menus: {
    opened: string[];
    closed: string[];
  };
  toasts: {
    appeared: string[];
  };
  ariaTransitions: {
    expandedChanged?: { from: string | null; to: string | null };
    selectedChanged?: { from: string | null; to: string | null };
    checkedChanged?: { from: string | null; to: string | null };
  };
  network: {
    requests: { method: string; url: string; status: number | null; failure?: string; durationMs?: number }[];
    hasWrites: boolean;
    hasErrors: boolean;
    errorDetails: string[];
  };
  console: {
    errors: string[];
    pageErrors: string[];
  };
  targetPostState?: {
    ariaExpanded: string | null;
    ariaSelected: string | null;
    ariaChecked: string | null;
    classes: string[];
    visible: boolean;
  } | null;
  screenshot?: Buffer;
}

export interface VerificationOutcome {
  verdict: VerificationVerdict;
  confidence: ConfidenceLevel;
  check: string;
  expected: string;
  actual: string;
  reason: string;
  rootCause?: string;
  details?: Record<string, unknown>;
  evidence?: {
    beforeScreenshot?: Buffer;
    afterScreenshot?: Buffer;
    domMutations?: string[];
    networkCalls?: { method: string; url: string; status: number | null; durationMs?: number }[];
    consoleErrors?: string[];
    durationMs: number;
  };
}

export interface ActionLifecycleEvent {
  phase?: ActionPhase;
  type: string;
  target: string;
  ok: boolean;
  detail?: string;
  box?: (BoundingBox & { vpWidth?: number; vpHeight?: number }) | null;
  buffer?: Buffer;
  intent?: InferredIntent;
  verdict?: VerificationVerdict;
  confidence?: ConfidenceLevel;
  expected?: string;
  actual?: string;
  durationMs?: number;
}

/**
 * Outcome of one functional check. `fail` becomes a defect (it carries its own ground-truth basis);
 * `anomaly` goes to human review; `skipped` (e.g. blocked by ActionGuard) is recorded but is not a finding.
 */
export interface FunctionalResult {
  kind: FunctionalKind;
  /** Stable check name, e.g. "clickable", "navigation", "empty-submission", "tab-switch", etc. */
  check: string;
  status: FunctionalStatus;
  severity: Severity;
  basis: Basis | null;
  element: { selector: string; role?: string; name?: string; box?: BoundingBox } | null;
  expected: string;
  actual: string;
  details?: Record<string, unknown>;
  durationMs?: number;
  confidence?: ConfidenceLevel;
  screenshot?: Buffer;
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
  /** Real-time hook for orchestrator & simulator synchronization. */
  onAction?: (a: ActionLifecycleEvent) => void;
}
