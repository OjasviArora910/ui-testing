import type { ModelElement } from '../discovery/types.js';
import type { ConfidenceLevel } from '../functional/types.js';

export const PAGE_TYPES = ['LOGIN_AUTH', 'FORM', 'SEARCH', 'DASHBOARD', 'TABLE_LIST', 'MODAL_DIALOG', 'NAVIGATION', 'MARKETING_CONTENT', 'UNKNOWN_GENERAL'] as const;
export type PageType = (typeof PAGE_TYPES)[number];

/** Outcome of one selected test, as shown to the user. Accessibility findings are reported on their own track. */
/** INCONCLUSIVE: tested, not provably working or broken; counted, never reported as a finding. */
export const RESULT_CLASSES = ['BUG', 'WARNING', 'EXPECTED', 'NEEDS_REVIEW', 'BLOCKED_BY_SAFETY', 'INCONCLUSIVE'] as const;
export type ResultClass = (typeof RESULT_CLASSES)[number];

export interface DetectedType {
  type: PageType;
  confidence: ConfidenceLevel;
  /** Deterministic signals that fired, in plain words. */
  signals: string[];
}

/** What a <form> is for. Only `submission` and `login` forms are ever submitted. */
export type FormRole = 'login' | 'search' | 'submission' | 'none';
export interface FormProfile { selector: string; role: FormRole; confidence: ConfidenceLevel; reason: string }

/** DETECTION output: what is on the page. Says nothing about what will be tested. */
export interface PageProfile {
  url: string;
  types: DetectedType[];
  forms: FormProfile[];
}

/** Why a test runs. Carried on every result and finding it produces. */
export interface ScenarioRef {
  id: string;
  label: string;
  pageType: PageType;
  reason: string;
  confidence: ConfidenceLevel;
}

export interface SkippedScenario { id: string; label: string; reason: string }

export type FormMode = 'full' | 'login';
export interface SearchTarget { input: string; form?: string; submit?: string; label: string }

/** SELECTION output: which existing testers run, on which elements, and why. */
export interface TestPlan {
  selected: ScenarioRef[];
  skipped: SkippedScenario[];
  links: ScenarioRef | null;
  /** Clickable controls handed to the existing button tester. */
  buttons: { element: ModelElement; scenario: ScenarioRef }[];
  forms: { selector: string; mode: FormMode; scenario: ScenarioRef }[];
  searches: { target: SearchTarget; scenario: ScenarioRef }[];
  modals: { trigger: ModelElement; scenario: ScenarioRef }[];
  /** Form controls operated one by one (never submitted): selects, checkboxes, radios, text fields. */
  fields: { element: ModelElement; scenario: ScenarioRef }[];
  /** Rule ids that must not run for this page (static rules gate themselves on content otherwise). */
  disabledRules: string[];
}

/** Persisted per page so the report and dashboard can show the dynamic decision. */
export interface PageDecision {
  types: DetectedType[];
  selected: ScenarioRef[];
  skipped: SkippedScenario[];
  /** Number of elements selected for interaction testing on the page (links are counted as they are followed). */
  planned?: number;
}
