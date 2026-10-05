import type { ScenarioRef } from '../dynamic/types.js';
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

/** `blocked`: the UI action was performed but ActionGuard stopped the workflow, so the outcome is unverified (never a pass, never a defect). */
/**
 * `inconclusive`: the element was tested, nothing shows it is broken, and nothing proves it works either (for example a
 * button of unclear purpose that changes nothing). It is counted as tested and is NOT reported.
 */
export type FunctionalStatus = 'pass' | 'fail' | 'anomaly' | 'inconclusive' | 'skipped' | 'blocked';

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
  | 'PAGINATE'
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
  /** Unredacted location.href, used only to notice that the page moved. */
  rawUrl?: string;
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
    /** aria-pressed / aria-current, class list as text, own text, and whether the control is already in its active state. */
    ariaPressed?: string | null;
    ariaCurrent?: string | null;
    text?: string;
    active?: boolean;
    /** Rendered state of the region this control governs (aria-controls target, else its next sibling). */
    controlled?: { visible: boolean; height: number } | null;
  } | null;
  /** Page-wide signatures used to notice a state change that adds/removes no elements: layout, document theme/classes, form control values. */
  signals?: { layout: string; doc: string; form: string; text?: string; attrs?: string; overlays: string[] };
  /** Native dialogs and popups already opened before the action. */
  jsDialogCount?: number;
  popupCount?: number;
  networkCount: number;
  consoleCount: number;
  /** Requests ActionGuard had already blocked before the action. */
  blockedCount?: number;
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
    /** Requests aborted by ActionGuard during the observation window. They are not application failures. */
    blockedByGuard?: string[];
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
    ariaPressed?: string | null;
    ariaCurrent?: string | null;
    active?: boolean;
    controlled?: { visible: boolean; height: number } | null;
  } | null;
  /**
   * Interaction-relevant state changes that do not show up as added/removed nodes: the control's own state, the region it
   * governs, layout, document theme, form control values. Each entry is a human-readable description.
   */
  stateChanges?: string[];
  /** Native alert/confirm/prompt dialogs and popup windows opened by the action. */
  jsDialogs?: string[];
  popups?: string[];
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

/** What one action did, scoped to that action only. Stored as evidence for the finding it produced. */
export interface ActionTrace {
  action: string;
  urlBefore?: string;
  urlAfter?: string;
  network: string[];
  console: string[];
  changes: string[];
}

/**
 * Outcome of one functional check. `fail` becomes a defect (it carries its own ground-truth basis);
 * `anomaly` goes to human review; `skipped` and `blocked` (ActionGuard) are recorded but are not findings.
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
  /** State AFTER the action (error state for failures). */
  screenshot?: Buffer;
  /** State BEFORE the action. */
  before?: Buffer;
  trace?: ActionTrace;
  /** Unique within one page run; lets a finding be tied back to exactly this result and its evidence. */
  id?: string;
  /** Why this test was selected (set when a dynamic TestPlan drives the run). */
  scenario?: ScenarioRef;
}

import type { BrowserController } from '../browser/index.js';
import type { PageModel } from '../discovery/types.js';
import type { QAConfig } from '../shared/config.js';
import type { TestPlan } from '../dynamic/types.js';
import type { ActionGuard } from './actionGuard.js';

/** Shared action budget (config.maxActions). Every navigation/click/fill performed by a test consumes one unit. */
export class ActionBudget {
  used = 0;
  constructor(public readonly max: number) {}
  /** Set when the run is being stopped: every tester loop already checks the budget, so they all wind down at once. */
  halted = false;
  halt(): void { this.halted = true; }
  get exhausted(): boolean { return this.halted || this.used >= this.max; }
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
  /** Dynamic selection: when present, only the testers and elements it names are exercised. Absent => every generic suite runs. */
  plan?: TestPlan;
  /** Called once for every finished element test, as soon as it finishes, so progress can be saved continuously. */
  onResult?: (r: FunctionalResult) => void;
  /** Real-time hook for orchestrator & simulator synchronization. */
  onAction?: (a: ActionLifecycleEvent) => void;
}
