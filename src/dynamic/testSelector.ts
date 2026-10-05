import type { ModelElement, PageModel } from '../discovery/types.js';
import { classifyElementIntent, toClassifiable } from '../functional/intent.js';
import type { ConfidenceLevel, SemanticIntentKind } from '../functional/types.js';
import type { QAConfig } from '../shared/config.js';
import { hasType, looseSearchInputs, modalTriggers } from './pageClassifier.js';
import type { PageProfile, PageType, ScenarioRef, TestPlan } from './types.js';

const PAGINATION = /^(next|prev(ious)?|older|newer|load more|show more|page \d+|\d+|[«»‹›<>])$|\b(next|previous) page\b/i;

type ControlGroup = 'tabs' | 'filters' | 'toggles' | 'pagination' | 'generic-buttons';
// 'generic-buttons' = purpose could not be inferred; they are still exercised and judged on what observably happens.
const GROUP_LABEL: Record<ControlGroup, string> = {
  tabs: 'Tab interaction', filters: 'Filter / sort interaction', toggles: 'Dropdown / expandable interaction',
  pagination: 'Pagination interaction', 'generic-buttons': 'Button interaction',
};

function groupOf(kind: SemanticIntentKind, label: string, hasTable: boolean): ControlGroup {
  if (kind === 'SWITCH_TAB') return 'tabs';
  if (kind === 'FILTER_OR_SORT') return 'filters';
  if (kind === 'TOGGLE_ACCORDION' || kind === 'TOGGLE') return 'toggles';
  if (kind === 'PAGINATE' || (hasTable && PAGINATION.test(label.trim()))) return 'pagination';
  return 'generic-buttons';
}

/**
 * SELECTION: decides which existing testers are relevant for a detected profile and records why.
 * Detecting a component never selects a test by itself: low-confidence components and unsafe shapes are listed under `skipped`.
 */
/** Identity of a control across pages: the same selector with the same name is the same shared control (header, navigation, footer). */
export const controlKey = (el: { selector: string; name?: string; text?: string }): string => `${el.selector}|${(el.name || el.text || '').slice(0, 80)}`;

export interface SelectOptions {
  /** Controls already verified on an earlier page of this run. They are tested once, not again on every page. */
  verified?: ReadonlySet<string>;
}

export function selectTests(profile: PageProfile, model: PageModel, config: QAConfig, opts: SelectOptions = {}): TestPlan {
  const plan: TestPlan = { selected: [], skipped: [], links: null, buttons: [], forms: [], searches: [], modals: [], fields: [], disabledRules: [] };
  const primary: PageType = (profile.types.find((t) => t.confidence !== 'LOW' && t.type !== 'NAVIGATION') ?? profile.types[0])?.type ?? 'UNKNOWN_GENERAL';
  const select = (id: string, label: string, pageType: PageType, reason: string, confidence: ConfidenceLevel = 'HIGH'): ScenarioRef => {
    const s: ScenarioRef = { id, label, pageType, reason, confidence };
    plan.selected.push(s);
    return s;
  };
  const skip = (id: string, label: string, reason: string): void => { plan.skipped.push({ id, label, reason }); };

  // ---- universal deterministic checks (static rules; they produce nothing when their subject is absent)
  select('layout', 'Layout, overlap, clipping and overflow checks', primary, 'universal deterministic check');
  select('responsive', 'Responsive checks per viewport', primary, 'universal deterministic check');
  select('runtime', 'Network and console error checks', primary, 'universal deterministic check');
  const images = model.images.filter((i) => i.visible).length;
  if (images > 0) select('images', 'Image checks (broken, distorted)', primary, `${images} visible image(s)`);
  else skip('images', 'Image checks', 'no visible images on the page');

  const table = hasType(profile, 'TABLE_LIST');
  if (table) select('table', 'Table rendering and overflow checks', 'TABLE_LIST', table.signals.join('; '), table.confidence);
  else skip('table', 'Table checks', 'no data table detected');

  // ---- links
  if (model.links.some((l) => l.visible)) {
    const content = hasType(profile, 'MARKETING_CONTENT') ?? hasType(profile, 'NAVIGATION');
    plan.links = select('links', 'Link and navigation checks', content?.type ?? primary, content ? `${content.type === 'NAVIGATION' ? 'navigation' : 'content'} page: ${content.signals[0]}` : 'broken links are a universal check');
  } else skip('links', 'Link checks', 'no visible links');

  // ---- forms: only login and real submission forms are ever submitted
  for (const f of profile.forms) {
    if (f.role === 'submission') {
      plan.forms.push({ selector: f.selector, mode: 'full', scenario: select('form-validation', 'Form validation and submission', 'FORM', f.reason, f.confidence) });
    } else if (f.role === 'login') {
      plan.forms.push({ selector: f.selector, mode: 'login', scenario: select('login', 'Login form checks', 'LOGIN_AUTH', f.reason, f.confidence) });
    } else if (f.role === 'none' && f.reason !== 'no visible fields') {
      skip('form-validation', 'Form submission', `${f.selector}: ${f.reason}, not treated as a submission form`);
    }
  }
  if (!profile.forms.some((f) => f.role === 'submission') && !plan.skipped.some((s) => s.id === 'form-validation')) skip('form-validation', 'Form submission', 'no submission form detected');
  if (!profile.forms.some((f) => f.role === 'login')) {
    const hint = profile.types.find((t) => t.type === 'LOGIN_AUTH');
    if (hint) skip('login', 'Login form checks', hint.signals[0] ?? 'no login form found');
  }

  // ---- search
  for (const f of profile.forms.filter((x) => x.role === 'search')) {
    const form = model.forms.find((m) => m.form.selector === f.selector)!.form;
    const input = form.fields.find((x) => x.visible && !x.disabled && x.type === 'search') ?? form.fields.find((x) => x.visible && !x.disabled && x.tag === 'input')!;
    plan.searches.push({
      target: { input: input.selector, form: form.selector, submit: form.submit?.selector, label: input.label || input.placeholder || input.name || 'search' },
      scenario: select('search', 'Search interaction', 'SEARCH', f.reason, f.confidence),
    });
  }
  for (const i of looseSearchInputs(model)) {
    const high = i.meta?.inputType === 'search' || i.role === 'searchbox';
    plan.searches.push({ target: { input: i.selector, label: i.name || 'search' }, scenario: select('search', 'Search interaction', 'SEARCH', `search input "${i.name || i.selector}"`, high ? 'HIGH' : 'MEDIUM') });
  }
  if (plan.searches.length === 0) skip('search', 'Search interaction', 'no search input detected');

  // ---- modals
  const triggers = modalTriggers(model);
  for (const t of triggers) {
    const name = t.element.name || t.element.text || t.element.selector;
    if (t.confidence === 'LOW') { skip('modal', 'Modal open/close', `"${name}" looks like a modal trigger but no dialog exists in the DOM (low confidence)`); continue; }
    plan.modals.push({ trigger: t.element, scenario: select('modal', 'Modal open/close', 'MODAL_DIALOG', `trigger "${name}"${t.element.aria?.haspopup ? ' declares aria-haspopup' : ''} and a dialog exists`, t.confidence) });
  }
  if (triggers.length === 0) skip('modal', 'Modal open/close', model.dialogs.length > 0 ? 'a dialog exists but no trigger for it was identified' : 'no modal/dialog detected');

  // ---- remaining clickable controls, grouped by inferred intent
  const taken = new Set<string>([
    ...model.forms.map((f) => f.form.submit?.selector).filter((s): s is string => !!s),
    ...triggers.map((t) => t.element.selector),
    ...plan.searches.map((s) => s.target.submit).filter((s): s is string => !!s),
  ]);
  const hasTable = !!table;
  const dashboard = hasType(profile, 'DASHBOARD');
  const groups = new Map<ControlGroup, ModelElement[]>();
  const seen = new Set<string>();
  let shared = 0;
  // custom toggles (role=switch/checkbox on a non-input) are controls to click; native checkboxes are form fields
  const customToggles = model.checkboxes.filter((x) => x.meta?.tag !== 'input');
  // anchors used as buttons (href="#" or javascript:) have no destination to check: they are controls to click
  const scriptLinks = model.links.filter((l) => { const h = (l.href ?? '').trim(); return h === '' || /#$/.test(h) || /^javascript:/i.test(h); });
  for (const el of [...model.buttons, ...model.tabs, ...customToggles, ...scriptLinks]) {
    if (taken.has(el.selector) || seen.has(el.selector) || !el.visible) continue;
    seen.add(el.selector);
    if ((el.name || el.text) && opts.verified?.has(controlKey(el))) { shared++; continue; }
    const intent = classifyElementIntent(toClassifiable(el), model);
    if (intent.kind === 'SEARCH' && plan.searches.length > 0) continue; // exercised by the search scenario
    const g = groupOf(intent.kind, el.name || el.text, hasTable);
    groups.set(g, [...(groups.get(g) ?? []), el]);
  }
  if (shared > 0) skip('shared-controls', 'Shared controls', `${shared} control(s) that also appear on an earlier page were already tested there and passed`);
  let room = config.functional.maxButtonsPerPage;
  for (const g of ['tabs', 'filters', 'toggles', 'pagination', 'generic-buttons'] as const) {
    const all = groups.get(g) ?? [];
    if (all.length === 0) {
      if (g === 'filters' && dashboard) skip(g, GROUP_LABEL[g], 'no filter or sort control detected');
      if (g === 'pagination' && hasTable) skip(g, GROUP_LABEL[g], 'table has no pagination control');
      continue;
    }
    const generic = g === 'generic-buttons';
    const cap = Math.max(0, Math.min(room, generic ? config.dynamic.maxGenericButtons : room));
    const chosen = all.slice(0, cap);
    if (chosen.length > 0) {
      const scenario = select(g, GROUP_LABEL[g], generic ? primary : g === 'pagination' ? 'TABLE_LIST' : dashboard ? 'DASHBOARD' : primary,
        generic ? `${chosen.length} control(s) whose purpose could not be inferred from the markup; each is clicked and judged on what observably happens` : `${chosen.length} control(s) detected`,
        generic ? 'LOW' : 'MEDIUM');
      for (const element of chosen) plan.buttons.push({ element, scenario });
      room -= chosen.length;
    }
    if (all.length > chosen.length) skip(g, GROUP_LABEL[g], `${all.length - chosen.length} more control(s) NOT TESTED: the per-page safety limit (functional.maxButtonsPerPage) was reached`);
  }

  // ---- form controls: operated one by one and verified on their own state (nothing is submitted)
  const inSearch = new Set(plan.searches.map((x) => x.target.input));
  const typeable = model.inputs.filter((i) => !['hidden', 'file', 'range', 'color', 'image'].includes(String(i.meta?.inputType ?? '')));
  const natives = model.checkboxes.filter((x) => x.meta?.tag === 'input');
  const fieldEls = [...model.selects, ...natives, ...model.radios, ...typeable, ...model.textareas].filter((f) => f.visible && f.enabled && !inSearch.has(f.selector));
  if (fieldEls.length > 0) {
    const chosen = fieldEls.slice(0, config.functional.maxFieldsPerPage);
    const scenario = select('fields', 'Form control interaction', hasType(profile, 'FORM')?.type ?? hasType(profile, 'LOGIN_AUTH')?.type ?? primary, `${chosen.length} form control(s): each must take a value (typed text, chosen option, checked state)`);
    for (const element of chosen) plan.fields.push({ element, scenario });
    if (fieldEls.length > chosen.length) skip('fields', 'Form control interaction', `${fieldEls.length - chosen.length} more control(s) NOT TESTED: the per-page safety limit (functional.maxFieldsPerPage) was reached`);
  } else skip('fields', 'Form control interaction', 'no form controls on the page');

  // ---- accessibility is out of scope for UI/UX QA; it runs only when explicitly enabled, as its own category
  if (config.accessibility.enabled) select('accessibility', `Accessibility checks (${config.accessibility.failRun ? 'required' : 'report only'})`, primary, 'explicitly enabled; separate ACCESSIBILITY category');

  return plan;
}
