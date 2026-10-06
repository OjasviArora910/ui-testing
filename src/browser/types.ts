import type { BoundingBox } from '../shared/types.js';

export interface ElementInfo {
  /** Index within one collection call (stable only inside that call). */
  id: number;
  /** id of the parent element in the same collection, or null (direct children of <body>). */
  parentId: number | null;
  /** Text from this element's own text nodes only (not descendants). */
  ownText: string;
  className: string;
  /** Relevant semantic attributes. */
  aria: { modal: boolean; hidden: boolean; haspopup: boolean; expanded: string | null; disabled: boolean; invalid: boolean; live: string | null };
  tag: string;
  type?: string;
  role: string | null;
  name: string;
  text: string;
  selector: string;
  visible: boolean;
  enabled: boolean;
  /** Document-relative box (includes scroll offset). */
  box: BoundingBox;
  styles: Record<StyleKey, string>;
  scroll: { scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number };
  href?: string | null;
  /** Set on a non-semantic element recognised as a safe entry control (opens, shows or edits content), with the evidence for it. */
  entry?: { kind: 'labelled' | 'row'; evidence: string[] };
  required?: boolean;
}

/** Semantic target. Resolved in priority order: role+name, label, text, testId, attribute, css. */
export interface ElementTarget {
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  testId?: string;
  /** Semantic attribute such as placeholder / title / alt */
  attr?: { name: 'placeholder' | 'title' | 'alt'; value: string };
  css?: string;
  /** Pick the n-th match (0-based) when several match. */
  nth?: number;
}

export type RequestPhase = 'page-load' | 'action';

export interface NetworkEvent {
  id: number;
  url: string; // redacted
  method: string;
  resourceType: string;
  status: number | null;
  ok: boolean;
  failure?: string;
  durationMs: number | null;
  startedAt: number;
  pageUrl: string; // redacted
  ignored: boolean;
  /** Aborted by the platform's own request guard / external-origin blocking; never an app defect. */
  blockedByGuard?: boolean;
  /** Which of the platform's rules stopped the request, and why (set only when the platform blocked it). */
  blockedBy?: 'safety-guard' | 'external-host';
  blockReason?: string;
  /** Whether the request belongs to loading the page, or was caused by an action the tester performed. */
  phase?: RequestPhase;
  /** NAMES of the credentials the browser attached (cookies) or the page set (headers). Never values. */
  auth?: { cookieNames: string[]; headerNames: string[] };
  /** Shape of an API response, without its content: was there any data in it? */
  response?: { contentType?: string; bytes?: number; body: 'data' | 'empty' | 'unknown'; items?: number };
}

export interface ConsoleEvent {
  kind: 'console' | 'pageerror';
  level: 'error' | 'warning' | 'info' | 'log' | 'debug';
  text: string; // redacted
  location?: string;
  pageUrl: string; // redacted
  at: number;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** HTTP status of the main document for navigate/reload/back/forward. */
  status?: number;
  /** Navigation only: the document is usable but the page never finished loading (some resource is still pending). */
  partial?: boolean;
  durationMs: number;
  urlBefore: string;
  urlAfter: string;
  newNetworkEvents: number;
  newConsoleErrors: number;
}

export interface RawField {
  selector: string; tag: string; type: string; name: string; label: string; placeholder: string; required: boolean;
  pattern?: string; min?: string; max?: string; minLength?: number; maxLength?: number; options?: string[]; visible: boolean; disabled: boolean;
}
export interface RawForm {
  selector: string; name: string; action: string; method: string; noValidate: boolean; visible: boolean;
  fields: RawField[]; submit: { selector: string; text: string } | null;
}
/** Output of the in-page structure collector (all strings redacted by the controller). */
export interface RawStructure {
  title: string; lang: string; forms: RawForm[];
  images: { selector: string; src: string; alt: string | null; complete: boolean; naturalWidth: number; naturalHeight: number; visible: boolean }[];
  tables: { selector: string; rows: number; headers: number; caption: string; visible: boolean }[];
  headings: { selector: string; level: number; text: string; visible: boolean }[];
  dialogs: { selector: string; name: string; open: boolean; modal: boolean }[];
  menus: { selector: string; role: string; items: number; visible: boolean }[];
  tabs: { selector: string; tabs: { selector: string; name: string; selected: boolean }[] }[];
  accordions: { selector: string; name: string; expanded: boolean }[];
  links: { selector: string; href: string; resolved: string; text: string; target: string; visible: boolean; inNav: boolean }[];
}

/** Computed-style keys captured for every element by the in-page collector. */
export type StyleKey =
  | 'display' | 'position' | 'visibility' | 'opacity' | 'overflow' | 'overflowX' | 'overflowY' | 'zIndex' | 'color'
  | 'backgroundColor' | 'fontSize' | 'fontWeight' | 'textOverflow' | 'whiteSpace' | 'pointerEvents' | 'cursor'
  | 'webkitLineClamp' | 'clip' | 'clipPath' | 'width' | 'height' | 'flexWrap' | 'objectFit';

/** One clickable-looking element inside a table row, the evidence found for it and what was decided (diagnostic record). */
export interface RowCandidate { row: string; tag: string; className: string; text: string; visible: boolean; evidence: string[]; decision: string }
