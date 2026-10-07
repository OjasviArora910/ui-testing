import type { ElementInfo } from '../browser/types.js';
import type { ModelElement, PageModel } from '../discovery/types.js';
import type { InferredIntent, SemanticIntentKind } from './types.js';

export interface ClassifiableElement {
  selector: string;
  tag?: string;
  type?: string;
  role?: string | null;
  name?: string;
  text?: string;
  href?: string | null;
  aria?: {
    expanded?: string | null;
    haspopup?: boolean | string;
    modal?: boolean;
    disabled?: boolean;
    invalid?: boolean;
    live?: string | null;
  };
  meta?: Record<string, unknown>;
  box?: { x: number; y: number; width: number; height: number };
}

/** PageModel elements keep their tag and input type in `meta`; expose them the way the classifier reads them. */
export function toClassifiable(el: ModelElement): ClassifiableElement {
  return {
    selector: el.selector, role: el.role, name: el.name, text: el.text, href: el.href, box: el.box,
    tag: typeof el.meta?.tag === 'string' ? el.meta.tag : undefined,
    type: typeof el.meta?.inputType === 'string' ? el.meta.inputType : undefined,
    aria: el.aria,
  };
}

const MODAL_DISMISS_REGEX = /^(close|dismiss|cancel|cancelar|schlie[ßs]en|fermer|✕|×)$/i;
const MODAL_OPEN_REGEX = /\b(modal|dialog|popup|lightbox|drawer)\b/i;
const SEARCH_REGEX = /\b(search|find|lookup|query|filter-search)\b/i;
const FILTER_SORT_REGEX = /\b(filter|sort|order by|reorder|ascending|descending|view all|all categories|show only)\b/i;
const PAGINATE_NAMED = /\b(next|previous|prev|first|last) page\b|\bpage \d+\b|\bgo to page\b|\bpagination\b/i;
const PAGINATE_BARE = /^(next|previous|prev|older|newer|[«»‹›<>]|\d{1,3})$/i;
const SUBMIT_REGEX = /\b(submit|save|send|register|checkout|log in|sign in|sign up|create|update|apply changes|confirm)\b/i;

/**
 * Classifies an interactive element's semantic intent and establishes the
 * expected observable outcomes for human-like QA verification.
 */
export function classifyElementIntent(
  el: ClassifiableElement,
  model?: PageModel,
): InferredIntent {
  const label = (el.name || el.text || '').trim();
  const lowerLabel = label.toLowerCase();
  const selector = el.selector || '';
  const lowerSel = selector.toLowerCase();
  const role = (el.role || '').toLowerCase();
  const tag = (el.tag || '').toLowerCase();
  const type = (el.type || '').toLowerCase();
  const href = (el.href || '').trim();

  // 1. TABS: role="tab" or selector/aria indicating tab navigation
  if (role === 'tab' || lowerSel.includes('[role="tab"]') || lowerSel.includes('.tab') || lowerSel.includes('nav-tab')) {
    return {
      kind: 'SWITCH_TAB',
      confidence: role === 'tab' ? 'HIGH' : 'MEDIUM', // a class name that merely contains "tab" is a guess
      summary: `Switch to tab "${label}"`,
      expectedOutcome: {
        description: `Tab "${label}" should become aria-selected="true" and reveal its associated tabpanel content`,
        expectedAriaSelected: true,
        expectedDomMutation: true,
        targetSelector: selector,
      },
    };
  }

  // 2. MODAL DISMISS: Buttons inside dialogs or explicitly labeled close/dismiss/cancel
  const isInsideDialog = lowerSel.includes('dialog') || lowerSel.includes('modal') || lowerSel.includes('.popup');
  if (
    MODAL_DISMISS_REGEX.test(lowerLabel) ||
    lowerSel.includes('btn-close') ||
    lowerSel.includes('modal-close') ||
    lowerSel.includes('close-button') ||
    (isInsideDialog && /cancel|close|dismiss/i.test(lowerLabel))
  ) {
    return {
      kind: 'DISMISS_MODAL',
      confidence: isInsideDialog || MODAL_DISMISS_REGEX.test(lowerLabel) ? 'HIGH' : 'MEDIUM',
      summary: `Dismiss dialog/modal via "${label || 'close button'}"`,
      expectedOutcome: {
        description: `Open dialog or modal should close, hide, or remove from the active view`,
        expectedModalClose: true,
        expectedDomMutation: true,
        targetSelector: selector,
      },
    };
  }

  // 3. MENU / DROPDOWN / ELLIPSIS / DISCLOSURE
  const isAriaExpanded = el.aria?.expanded !== null && el.aria?.expanded !== undefined;
  const toggleAttr = (el.meta?.['data-toggle'] || el.meta?.['data-bs-toggle'] || '').toString().toLowerCase();
  const isMenu = lowerSel.includes('dropdown') || lowerSel.includes('menu') || lowerSel.includes('actions') ||
    toggleAttr === 'dropdown' || toggleAttr === 'collapse' ||
    /(\b|_|-)(dropdown|menu|ellipsis|more|kebab|overflow|actions|options)(\b|_|-)/i.test(lowerSel + ' ' + (el.name || '') + ' ' + (el.text || '')) ||
    /^(\.\.\.|…|more|actions|options)$/i.test(lowerLabel) ||
    el.aria?.haspopup === 'menu' || el.aria?.haspopup === 'listbox' || el.aria?.haspopup === 'tree' || el.aria?.haspopup === 'grid' ||
    (Boolean(el.aria?.haspopup) && (toggleAttr === 'dropdown' || lowerSel.includes('dropdown') || lowerSel.includes('menu')));

  if (isMenu) {
    const currentlyExpanded = el.aria?.expanded === 'true';
    return {
      kind: 'TOGGLE_ACCORDION',
      confidence: 'HIGH',
      summary: `Toggle dropdown/menu "${label || 'menu'}"`,
      expectedOutcome: {
        description: currentlyExpanded
          ? `Dropdown/menu "${label || 'menu'}" should close or collapse`
          : `Dropdown/menu "${label || 'menu'}" should open and reveal options`,
        expectedAriaExpanded: !currentlyExpanded,
        expectedDomMutation: true,
        targetSelector: selector,
      },
    };
  }

  // 4. OPEN MODAL: aria-haspopup="dialog", explicit modal trigger, or popup when not a menu
  const isModalTrigger = !isMenu && (el.aria?.haspopup === 'dialog' ||
    (Boolean(el.aria?.haspopup) && (model?.dialogs.length ?? 0) > 0) ||
    lowerSel.includes('modal') ||
    lowerSel.includes('dialog') ||
    lowerSel.includes('dlg') ||
    (MODAL_OPEN_REGEX.test(lowerLabel) && !href.startsWith('http')));

  if (isModalTrigger) {
    const isDeclared = el.aria?.haspopup === 'dialog' || (Boolean(el.aria?.haspopup) && (model?.dialogs.length ?? 0) > 0);
    return {
      kind: 'OPEN_MODAL',
      confidence: isDeclared || el.aria?.haspopup === 'dialog' || lowerSel.includes('modal') ? 'HIGH' : 'MEDIUM',
      summary: `Open modal/dialog via "${label}"`,
      expectedOutcome: {
        description: `A modal, dialog, or overlay should appear and become visible/active on screen`,
        expectedModalOpen: true,
        expectedDomMutation: true,
        targetSelector: selector,
      },
    };
  }

  // 5. ACCORDION / COLLAPSE / SUMMARY
  if (
    tag === 'summary' ||
    lowerSel.includes('summary') ||
    lowerSel.includes('accordion') ||
    lowerSel.includes('collapse') ||
    isAriaExpanded
  ) {
    const currentlyExpanded = el.aria?.expanded === 'true';
    return {
      kind: 'TOGGLE_ACCORDION',
      confidence: tag === 'summary' || isAriaExpanded ? 'HIGH' : 'MEDIUM',
      summary: `Toggle accordion/collapsible "${label}"`,
      expectedOutcome: {
        description: currentlyExpanded
          ? `Collapsible "${label}" should collapse and set aria-expanded="false"`
          : `Collapsible "${label}" should expand and reveal content with aria-expanded="true"`,
        expectedAriaExpanded: !currentlyExpanded,
        expectedDomMutation: true,
        targetSelector: selector,
      },
    };
  }

  // 5. SEARCH: Search submit buttons or search box triggers
  if (role === 'searchbox' || type === 'search' || SEARCH_REGEX.test(lowerLabel) || lowerSel.includes('search')) {
    return {
      kind: 'SEARCH',
      confidence: 'MEDIUM',
      summary: `Execute search for "${label || 'query'}"`,
      expectedOutcome: {
        description: `Search query should trigger results display, DOM filter, or search results navigation`,
        expectedDomMutation: true,
        targetSelector: selector,
      },
    };
  }

  // 6. FILTER OR SORT: Filter chips, sort toggles, dropdown filters
  if (FILTER_SORT_REGEX.test(lowerLabel) || lowerSel.includes('filter') || lowerSel.includes('sort')) {
    return {
      kind: 'FILTER_OR_SORT',
      confidence: 'MEDIUM',
      summary: `Apply filter/sort option "${label}"`,
      expectedOutcome: {
        description: `Filtered list, table, or grid items should re-render or update based on "${label}"`,
        expectedDomMutation: true,
        targetSelector: selector,
      },
    };
  }

  // 7. TOGGLE: Switch or checkbox
  if (role === 'switch' || role === 'checkbox' || type === 'checkbox') {
    return {
      kind: 'TOGGLE',
      confidence: 'HIGH',
      summary: `Toggle switch/checkbox "${label}"`,
      expectedOutcome: {
        description: `Checkbox/switch state should toggle (checked/aria-checked inverted)`,
        expectedAriaChecked: true,
        expectedDomMutation: true,
        targetSelector: selector,
      },
    };
  }

  // 7.5 PAGINATION: named page controls (aria-label / text naming a page) or bare next/previous/number controls
  if (type !== 'submit' && (PAGINATE_NAMED.test(label) || PAGINATE_BARE.test(label) || /pagination|pager|page-(link|item|btn)/.test(lowerSel))) {
    return {
      kind: 'PAGINATE',
      confidence: PAGINATE_NAMED.test(label) ? 'HIGH' : 'MEDIUM',
      summary: `Go to another page of results via "${label}"`,
      expectedOutcome: {
        description: `Activating "${label}" shows a different page of results (the listed data, the current-page marker or the URL changes)`,
        expectedDomMutation: true,
        targetSelector: selector,
      },
    };
  }

  // 8. FORM SUBMIT: Explicit submit buttons or submit actions inside forms
  const isSubmitType = type === 'submit';
  const isInsideForm = lowerSel.includes('form') || (model?.forms.some((f) => f.selector && selector.startsWith(f.selector)) ?? false);
  if (isSubmitType || (isInsideForm && SUBMIT_REGEX.test(lowerLabel))) {
    return {
      kind: 'SUBMIT_FORM',
      confidence: isSubmitType ? 'HIGH' : 'MEDIUM',
      summary: `Submit form via button "${label}"`,
      expectedOutcome: {
        description: `Form submission should trigger client-side validation messages, an API POST/PUT request, or a confirmation state`,
        expectedValidation: true,
        expectedNetworkWrite: true,
        expectedDomMutation: true,
        targetSelector: selector,
      },
    };
  }

  // 9. NAVIGATION: Links or destination buttons
  const scriptLink = href === '' || href === '#' || href.startsWith('javascript:') || /#$/.test(href); // an anchor used as a button
  if (!scriptLink && (role === 'link' || tag === 'a' || href)) {
    return {
      kind: 'NAVIGATE',
      confidence: 'HIGH',
      summary: `Navigate to link destination "${label}"`,
      expectedOutcome: {
        description: `Clicking link "${label}" should navigate to destination URL or change document state`,
        expectedUrlChange: true,
        targetSelector: selector,
      },
    };
  }

  // 10. GENERAL INTERACTIVE ACTION: Any other button or clickable control
  return {
    kind: 'GENERAL_ACTION',
    confidence: 'LOW',
    summary: `Trigger button "${label}"`,
    expectedOutcome: {
      description: `Action on "${label}" should produce an observable side effect (DOM change, state update, dialog, toast, or network request)`,
      expectedDomMutation: true,
      targetSelector: selector,
    },
  };
}
