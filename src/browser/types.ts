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
  | 'webkitLineClamp' | 'clip' | 'clipPath' | 'width' | 'height' | 'flexWrap';
