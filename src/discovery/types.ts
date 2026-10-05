import type { BoundingBox, Viewport } from '../shared/types.js';
import type { RawForm } from '../browser/types.js';

export type ModelElementType =
  | 'button' | 'link' | 'input' | 'select' | 'checkbox' | 'radio' | 'textarea' | 'heading' | 'image'
  | 'dialog' | 'menu' | 'tab' | 'accordion' | 'table' | 'form' | 'interactive';

/** One discovered UI element. */
export interface ModelElement {
  type: ModelElementType;
  role: string | null;
  /** Accessible name (approximation; axe is authoritative). */
  name: string;
  text: string;
  selector: string;
  visible: boolean;
  enabled: boolean;
  box: BoundingBox;
  href?: string;
  required?: boolean;
  /** State attributes used to infer intent (dialog/menu trigger, expandable). */
  aria?: { haspopup: boolean; expanded: string | null };
  /** Extra type-specific facts (heading level, image alt, table size, ...). */
  meta?: Record<string, string | number | boolean | null>;
}

export interface PageModel {
  url: string;
  title: string;
  lang: string;
  status?: number;
  viewport: Viewport;
  capturedAt: string;
  headings: ModelElement[];
  buttons: ModelElement[];
  links: ModelElement[];
  inputs: ModelElement[];
  selects: ModelElement[];
  checkboxes: ModelElement[];
  radios: ModelElement[];
  textareas: ModelElement[];
  forms: (ModelElement & { form: RawForm })[];
  dialogs: ModelElement[];
  menus: ModelElement[];
  tabs: ModelElement[];
  accordions: ModelElement[];
  tables: ModelElement[];
  images: ModelElement[];
  /** Every interactive element, regardless of type. */
  interactive: ModelElement[];
  counts: Record<string, number>;
}

export interface CrawlQueueItem { url: string; depth: number }
export interface CrawlState { visited: string[]; queue: CrawlQueueItem[] }

export interface CrawledPage {
  url: string;
  depth: number;
  status?: number;
  model: PageModel | null;
  error?: string;
  /** Same-origin links discovered on this page (normalised). */
  outgoing: string[];
}
