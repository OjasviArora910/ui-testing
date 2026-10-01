import type { BrowserController } from '../browser/index.js';
import type { ElementInfo } from '../browser/types.js';
import type { ModelElement, ModelElementType, PageModel } from './types.js';

const ZERO_BOX = { x: 0, y: 0, width: 0, height: 0 };

function fromInfo(type: ModelElementType, e: ElementInfo, meta?: ModelElement['meta']): ModelElement {
  return {
    type, role: e.role, name: e.name, text: e.text, selector: e.selector, visible: e.visible, enabled: e.enabled,
    box: e.box, href: e.href ?? undefined, required: e.required, ...(meta ? { meta } : {}),
  };
}

/** Classify one interactive element into a PageModel bucket. */
export function classifyInteractive(e: ElementInfo): ModelElementType {
  const t = (e.type ?? '').toLowerCase();
  if (e.tag === 'select' || e.role === 'combobox') return 'select';
  if (e.tag === 'textarea') return 'textarea';
  if (e.tag === 'input') {
    if (t === 'checkbox') return 'checkbox';
    if (t === 'radio') return 'radio';
    if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
    return 'input';
  }
  if (e.role === 'checkbox' || e.role === 'switch') return 'checkbox';
  if (e.role === 'radio') return 'radio';
  if (e.role === 'tab') return 'tab';
  if (e.role === 'link' || (e.tag === 'a' && e.href !== undefined)) return 'link';
  if (e.role === 'button' || e.tag === 'button' || e.tag === 'summary') return 'button';
  return 'interactive';
}

/** Builds the structured PageModel from the live page. Pure read; performs no actions on the page. */
export async function buildPageModel(controller: BrowserController, opts: { status?: number } = {}): Promise<PageModel> {
  const [all, structure] = await Promise.all([controller.allElements(), controller.structure()]);
  const bySelector = new Map<string, ElementInfo>();
  for (const e of all) if (!bySelector.has(e.selector)) bySelector.set(e.selector, e);
  const look = (selector: string, type: ModelElementType, name: string, meta?: ModelElement['meta'], visibleHint?: boolean): ModelElement => {
    const e = bySelector.get(selector);
    return {
      type, role: e?.role ?? null, name: name || e?.name || '', text: e?.text ?? '', selector, visible: visibleHint ?? e?.visible ?? false,
      enabled: e?.enabled ?? true, box: e?.box ?? ZERO_BOX, meta,
    };
  };

  const model: PageModel = {
    url: controller.url, title: structure.title, lang: structure.lang, status: opts.status, viewport: controller.currentViewport,
    capturedAt: new Date().toISOString(),
    headings: structure.headings.map((h) => look(h.selector, 'heading', h.text, { level: h.level }, h.visible)),
    buttons: [], links: [], inputs: [], selects: [], checkboxes: [], radios: [], textareas: [],
    forms: structure.forms.map((f) => ({ ...look(f.selector, 'form', f.name, { fields: f.fields.length, method: f.method, action: f.action }, f.visible), form: f })),
    dialogs: structure.dialogs.map((d) => look(d.selector, 'dialog', d.name, { open: d.open, modal: d.modal }, d.open)),
    menus: structure.menus.map((m) => look(m.selector, 'menu', '', { role: m.role, items: m.items }, m.visible)),
    tabs: structure.tabs.flatMap((t) => t.tabs.map((x) => look(x.selector, 'tab', x.name, { selected: x.selected }))),
    accordions: structure.accordions.map((a) => look(a.selector, 'accordion', a.name, { expanded: a.expanded })),
    tables: structure.tables.map((t) => look(t.selector, 'table', t.caption, { rows: t.rows, headers: t.headers }, t.visible)),
    images: structure.images.map((i) => look(i.selector, 'image', i.alt ?? '', { src: i.src, alt: i.alt, complete: i.complete, naturalWidth: i.naturalWidth }, i.visible)),
    interactive: [], counts: {},
  };

  const interactive = await controller.interactiveElements();
  for (const e of interactive) {
    const type = classifyInteractive(e);
    const me = fromInfo(type, e, { tag: e.tag, inputType: e.type ?? null });
    model.interactive.push(me);
    const bucket = ({ button: model.buttons, link: model.links, input: model.inputs, select: model.selects, checkbox: model.checkboxes, radio: model.radios, textarea: model.textareas } as Record<string, ModelElement[] | undefined>)[type];
    bucket?.push(me);
  }

  for (const k of ['headings', 'buttons', 'links', 'inputs', 'selects', 'checkboxes', 'radios', 'textareas', 'forms', 'dialogs', 'menus', 'tabs', 'accordions', 'tables', 'images', 'interactive'] as const) {
    model.counts[k] = model[k].length;
  }
  return model;
}

export function interactiveSummary(model: PageModel): string {
  return Object.entries(model.counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(' ');
}
