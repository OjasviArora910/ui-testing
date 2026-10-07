import type { RawForm } from '../browser/types.js';
import type { ModelElement, PageModel } from '../discovery/types.js';
import { classifyElementIntent, toClassifiable } from '../functional/intent.js';
import type { ConfidenceLevel } from '../functional/types.js';
import type { DetectedType, FormProfile, PageProfile, PageType } from './types.js';

const LOGIN_TEXT = /\b(log ?in|sign ?in|authenticate|sso)\b/i;
const SEARCH_HINT = /\b(search|query|find|lookup)\b|^q$/i;
const DASHBOARD_TEXT = /\b(dashboard|admin|analytics|overview|reports?|console|metrics)\b/i;
const NOT_FILLABLE = new Set(['checkbox', 'radio', 'file']);

const pathOf = (url: string): string => { try { return new URL(url).pathname; } catch { return url; } };
const fieldHint = (f: RawForm['fields'][number]): string => `${f.name} ${f.label} ${f.placeholder}`.trim();

/** What a form is for, from its own fields and controls only. */
export function classifyForm(form: RawForm): FormProfile {
  const fields = form.fields.filter((f) => f.visible && !f.disabled);
  const base = { selector: form.selector };
  if (fields.length === 0) return { ...base, role: 'none', confidence: 'HIGH', reason: 'no visible fields' };

  const passwords = fields.filter((f) => f.type === 'password');
  if (passwords.length === 1 && fields.length <= 3) {
    return { ...base, role: 'login', confidence: 'HIGH', reason: `one password field and ${fields.length} field(s) in total` };
  }
  const searchField = fields.find((f) => f.type === 'search') ?? (fields.filter((f) => !NOT_FILLABLE.has(f.type) && f.tag !== 'select').length === 1
    ? fields.find((f) => SEARCH_HINT.test(fieldHint(f)) || SEARCH_HINT.test(form.name)) : undefined);
  if (searchField && passwords.length === 0) {
    return { ...base, role: 'search', confidence: searchField.type === 'search' ? 'HIGH' : 'MEDIUM', reason: `search field "${fieldHint(searchField) || searchField.selector}"` };
  }
  if (!form.submit) return { ...base, role: 'none', confidence: 'MEDIUM', reason: 'inputs without a submit control' };
  return { ...base, role: 'submission', confidence: 'HIGH', reason: `${fields.length} field(s) and a submit control "${form.submit.text || 'submit'}"` };
}

/** Search inputs that are not inside a search <form> (live filters, header search boxes). */
export function looseSearchInputs(model: PageModel): ModelElement[] {
  const inForms = new Set(model.forms.flatMap((f) => f.form.fields.map((x) => x.selector)));
  return model.inputs.filter((i) => i.visible && i.enabled && !inForms.has(i.selector)
    && (i.meta?.inputType === 'search' || i.role === 'searchbox' || SEARCH_HINT.test(i.name)));
}

/** Buttons that open a dialog: declared with aria-haspopup, or named as a modal trigger while a dialog exists in the DOM. */
export function modalTriggers(model: PageModel): { element: ModelElement; confidence: ConfidenceLevel }[] {
  const out: { element: ModelElement; confidence: ConfidenceLevel }[] = [];
  for (const b of model.buttons) {
    if (!b.visible || !b.enabled) continue;
    const intent = classifyElementIntent(toClassifiable(b), model);
    if (intent.kind !== 'OPEN_MODAL') continue;
    // aria-haspopup="dialog" or aria-haspopup with dialog in DOM makes the dialog reading certain.
    const declared = (b.aria?.haspopup === 'dialog' || Boolean(b.aria?.haspopup)) && model.dialogs.length > 0;
    out.push({ element: b, confidence: declared || intent.confidence === 'HIGH' ? 'HIGH' : model.dialogs.length > 0 ? 'MEDIUM' : 'LOW' });
  }
  return out;
}

/**
 * DETECTION only: infers every page/component type the PageModel supports with at least MEDIUM confidence.
 * Pure and deterministic; no page type is exclusive.
 */
export function classifyPage(model: PageModel): PageProfile {
  const types: DetectedType[] = [];
  const add = (type: PageType, confidence: ConfidenceLevel, signals: string[]): void => { types.push({ type, confidence, signals }); };
  const path = pathOf(model.url);
  const headline = `${model.title} ${model.headings.filter((h) => h.visible).slice(0, 3).map((h) => h.name).join(' ')}`;
  const forms = model.forms.filter((f) => f.visible).map((f) => classifyForm(f.form));

  const login = forms.filter((f) => f.role === 'login');
  if (login.length > 0) add('LOGIN_AUTH', 'HIGH', login.map((f) => `form ${f.selector}: ${f.reason}`));

  const searchForms = forms.filter((f) => f.role === 'search');
  const loose = looseSearchInputs(model);
  if (searchForms.length + loose.length > 0) {
    const high = searchForms.some((f) => f.confidence === 'HIGH') || loose.some((i) => i.meta?.inputType === 'search' || i.role === 'searchbox');
    add('SEARCH', high ? 'HIGH' : 'MEDIUM', [...searchForms.map((f) => `form ${f.selector}: ${f.reason}`), ...loose.map((i) => `search input "${i.name || i.selector}"`)]);
  }

  const submission = forms.filter((f) => f.role === 'submission');
  if (submission.length > 0) add('FORM', 'HIGH', submission.map((f) => `form ${f.selector}: ${f.reason}`));

  const tables = model.tables.filter((t) => t.visible && Number(t.meta?.rows ?? 0) >= 2);
  if (tables.length > 0) add('TABLE_LIST', 'HIGH', tables.map((t) => `table with ${t.meta?.rows} rows`));

  const triggers = modalTriggers(model).filter((t) => t.confidence !== 'LOW');
  if (model.dialogs.length > 0 || triggers.length > 0) {
    const high = triggers.some((t) => t.confidence === 'HIGH');
    add('MODAL_DIALOG', high ? 'HIGH' : 'MEDIUM', [
      ...(model.dialogs.length ? [`${model.dialogs.length} dialog element(s) in the DOM`] : []),
      ...triggers.map((t) => `trigger "${t.element.name || t.element.text || t.element.selector}"`),
    ]);
  }

  const controls = model.buttons.filter((b) => b.visible).map((b) => classifyElementIntent(toClassifiable(b), model).kind);
  const filters = controls.filter((k) => k === 'FILTER_OR_SORT').length;
  const dashSignals: string[] = [];
  if (DASHBOARD_TEXT.test(path)) dashSignals.push(`path "${path}"`);
  if (DASHBOARD_TEXT.test(headline)) dashSignals.push('title/heading mentions a dashboard');
  if (tables.length > 0 && (filters > 0 || model.tabs.length > 0)) dashSignals.push(`table with ${filters} filter/sort control(s) and ${model.tabs.length} tab(s)`);
  if (dashSignals.length > 0 && (tables.length > 0 || filters > 0 || model.tabs.length > 0)) add('DASHBOARD', dashSignals.length > 1 ? 'HIGH' : 'MEDIUM', dashSignals);

  const navs = model.menus.filter((m) => m.visible && Number(m.meta?.items ?? 0) >= 3);
  if (navs.length > 0) add('NAVIGATION', 'HIGH', navs.map((m) => `${m.meta?.role ?? 'navigation'} with ${m.meta?.items} items`));

  const interactiveTypes = types.some((t) => ['LOGIN_AUTH', 'FORM', 'DASHBOARD', 'TABLE_LIST'].includes(t.type));
  const content = model.headings.filter((h) => h.visible).length;
  if (!interactiveTypes && content >= 2 && model.links.length + model.images.length >= 3) {
    add('MARKETING_CONTENT', 'MEDIUM', [`${content} headings, ${model.links.length} links, ${model.images.length} images, no submission form or data table`]);
  }

  // Login path with no login form is only a weak hint: recorded, never acted on.
  if (login.length === 0 && (LOGIN_TEXT.test(path.replace(/[-_/]/g, ' ')) || LOGIN_TEXT.test(headline))) add('LOGIN_AUTH', 'LOW', ['path/heading mentions login but no login form was found']);

  if (!types.some((t) => t.confidence !== 'LOW' && t.type !== 'NAVIGATION')) add('UNKNOWN_GENERAL', 'HIGH', ['no specific page/component type reached medium confidence']);
  return { url: model.url, types, forms };
}

export function hasType(profile: PageProfile, type: PageType): DetectedType | undefined {
  return profile.types.find((t) => t.type === type && t.confidence !== 'LOW');
}
