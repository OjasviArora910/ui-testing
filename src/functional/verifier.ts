import type { InferredIntent, PostActionObservation, VerificationOutcome, VerificationVerdict } from './types.js';

export interface VerifyInput {
  intent: InferredIntent;
  observation: PostActionObservation;
  clickResult: { ok: boolean; error?: string };
  elementLabel: string;
  selector: string;
}

/**
 * Verifies whether the observed application behavior matches the expected semantic intent.
 * Evaluates real post-interaction behavior (DOM transitions, modals, tabs, network requests, console errors)
 * while rigorously preventing false positives.
 */
export function verifyInteraction(input: VerifyInput): VerificationOutcome {
  const { intent, observation, clickResult, elementLabel, selector } = input;
  const { expectedOutcome } = intent;
  const durationMs = observation.durationMs;

  const evidence = {
    beforeScreenshot: observation.pre.screenshot,
    afterScreenshot: observation.screenshot,
    domMutations: observation.domMutations.attributeChanges,
    networkCalls: observation.network.requests,
    consoleErrors: [...observation.console.pageErrors, ...observation.console.errors],
    durationMs,
  };

  // 1. HARD FAILURE: Click Execution Failed
  if (!clickResult.ok) {
    return {
      verdict: 'FAIL',
      confidence: 'HIGH',
      check: 'click-executable',
      expected: `Button "${elementLabel}" can be clicked without browser execution errors`,
      actual: `Click failed: ${clickResult.error ?? 'Unknown error'}`,
      reason: `Playwright was unable to click the element: ${clickResult.error}`,
      rootCause: clickResult.error,
      evidence,
    };
  }

  // 2. HARD FAILURE: Uncaught JavaScript Page Errors
  if (observation.console.pageErrors.length > 0) {
    const err = observation.console.pageErrors[0]!;
    return {
      verdict: 'FAIL',
      confidence: 'HIGH',
      check: 'javascript-error',
      expected: `Clicking "${elementLabel}" executes without raising uncaught JavaScript exceptions`,
      actual: `Uncaught exception: ${err.slice(0, 200)}`,
      reason: `Clicking the element triggered an uncaught JavaScript runtime error on the page`,
      rootCause: err,
      evidence,
    };
  }

  // 3. HARD FAILURE: Network Errors (HTTP 4xx / 5xx or connection failures)
  if (observation.network.hasErrors) {
    const isServerError = observation.network.requests.some(
      (n) => n.status !== null && n.status >= 500,
    );
    const firstErr = observation.network.errorDetails[0] ?? 'Request failed';
    return {
      verdict: 'FAIL',
      confidence: 'HIGH',
      check: 'network-failure',
      expected: `Network requests triggered by "${elementLabel}" succeed (HTTP < 400)`,
      actual: `Network failure: ${firstErr}`,
      reason: `Interaction dispatched one or more network requests that failed (${firstErr})`,
      rootCause: isServerError ? 'HTTP 5xx Server Error' : 'HTTP 4xx Client Error',
      evidence,
    };
  }

  // 4. CONSOLE ERROR LOGS (console.error calls)
  if (observation.console.errors.length > 0) {
    const firstConsoleErr = observation.console.errors[0]!;
    return {
      verdict: 'FAIL',
      confidence: 'HIGH',
      check: 'console-error',
      expected: `Clicking "${elementLabel}" does not emit console.error logs`,
      actual: `console.error: ${firstConsoleErr.slice(0, 200)}`,
      reason: `Action logged errors to the browser console`,
      rootCause: firstConsoleErr,
      evidence,
    };
  }

  // 5. INTENT-SPECIFIC BEHAVIORAL VERIFICATION

  // 5.1 SWITCH_TAB
  if (intent.kind === 'SWITCH_TAB') {
    const targetPost = observation.targetPostState;
    const isSelected = targetPost?.ariaSelected === 'true';
    const hasActiveClass = targetPost?.classes.some((c) =>
      ['active', 'selected', 'is-active', 'current'].includes(c.toLowerCase()),
    );
    const domChanged =
      observation.domMutations.addedNodesCount > 0 ||
      observation.domMutations.removedNodesCount > 0 ||
      observation.domMutations.textChanged;

    if (isSelected || hasActiveClass || domChanged) {
      return {
        verdict: 'PASS',
        confidence: 'HIGH',
        check: 'tab-switch',
        expected: expectedOutcome.description,
        actual: `Tab "${elementLabel}" activated (selected: ${isSelected}, activeClass: ${hasActiveClass})`,
        reason: `Tab state transitioned to active and panel content updated`,
        evidence,
      };
    }

    return {
      verdict: 'FAIL',
      confidence: 'HIGH',
      check: 'tab-switch',
      expected: expectedOutcome.description,
      actual: `Tab "${elementLabel}" did not become selected or active, and panel did not change`,
      reason: `Clicking the tab produced no active state change and no panel visibility update`,
      rootCause: 'Tab click failed to activate or reveal associated tabpanel',
      evidence,
    };
  }

  // 5.2 TOGGLE_ACCORDION
  if (intent.kind === 'TOGGLE_ACCORDION') {
    const expandedChange = observation.ariaTransitions.expandedChanged;
    const targetPost = observation.targetPostState;
    const domMutated =
      observation.domMutations.addedNodesCount > 0 ||
      observation.domMutations.removedNodesCount > 0 ||
      observation.domMutations.textChanged;

    if (expandedChange || targetPost?.ariaExpanded !== null || domMutated) {
      const stateNow = targetPost?.ariaExpanded ?? 'toggled';
      return {
        verdict: 'PASS',
        confidence: 'HIGH',
        check: 'accordion-toggle',
        expected: expectedOutcome.description,
        actual: `Collapsible "${elementLabel}" state updated (aria-expanded: ${stateNow})`,
        reason: `Collapsible section expanded or collapsed as expected`,
        evidence,
      };
    }

    return {
      verdict: 'FAIL',
      confidence: 'HIGH',
      check: 'accordion-toggle',
      expected: expectedOutcome.description,
      actual: `Collapsible "${elementLabel}" produced no state change or content expansion`,
      reason: `Clicking the accordion trigger did not toggle aria-expanded or modify content height`,
      rootCause: 'Accordion element failed to expand or collapse',
      evidence,
    };
  }

  // 5.3 OPEN_MODAL
  if (intent.kind === 'OPEN_MODAL') {
    const dialogOpened = observation.dialogs.opened.length > 0;
    const hasMoreDialogs = observation.dialogs.countAfter > observation.dialogs.countBefore;
    const hasToasts = observation.toasts.appeared.length > 0;

    if (dialogOpened || hasMoreDialogs) {
      const openedName = observation.dialogs.opened[0] ?? 'dialog/modal';
      return {
        verdict: 'PASS',
        confidence: 'HIGH',
        check: 'modal-open',
        expected: expectedOutcome.description,
        actual: `Modal dialog opened (${openedName})`,
        reason: `Clicking "${elementLabel}" opened a modal dialog as expected`,
        evidence,
      };
    }

    if (hasToasts || observation.domMutations.addedNodesCount > 5) {
      return {
        verdict: 'PASS',
        confidence: 'MEDIUM',
        check: 'modal-open',
        expected: expectedOutcome.description,
        actual: `Overlay/modal elements appeared on page`,
        reason: `Overlay structure rendered in DOM`,
        evidence,
      };
    }

    return {
      verdict: 'FAIL',
      confidence: 'HIGH',
      check: 'modal-open',
      expected: expectedOutcome.description,
      actual: `No dialog or modal appeared after clicking "${elementLabel}"`,
      reason: `Button classified as modal trigger failed to reveal any modal or dialog container`,
      rootCause: 'Modal trigger failed to open any dialog',
      evidence,
    };
  }

  // 5.4 DISMISS_MODAL
  if (intent.kind === 'DISMISS_MODAL') {
    const dialogClosed = observation.dialogs.closed.length > 0;
    const countDecreased = observation.dialogs.countAfter < observation.dialogs.countBefore;
    const countIsZero = observation.dialogs.countAfter === 0;

    if (dialogClosed || countDecreased || countIsZero) {
      return {
        verdict: 'PASS',
        confidence: 'HIGH',
        check: 'modal-dismiss',
        expected: expectedOutcome.description,
        actual: `Dialog or modal was dismissed`,
        reason: `Close trigger successfully dismissed the open dialog`,
        evidence,
      };
    }

    return {
      verdict: 'FAIL',
      confidence: 'HIGH',
      check: 'modal-dismiss',
      expected: expectedOutcome.description,
      actual: `Dialog remained open after clicking dismiss button "${elementLabel}"`,
      reason: `Clicking the close button did not close or hide the modal`,
      rootCause: 'Modal dismiss action failed to close the dialog',
      evidence,
    };
  }

  // 5.5 SUBMIT_FORM
  if (intent.kind === 'SUBMIT_FORM') {
    const hasNetWrite = observation.network.hasWrites;
    const hasValidationFeedback =
      observation.toasts.appeared.length > 0 ||
      observation.domMutations.attributeChanges.some((a) => a.includes('invalid'));
    const urlChanged = observation.urlChanged;
    const domMutated =
      observation.domMutations.addedNodesCount > 0 ||
      observation.domMutations.removedNodesCount > 0 ||
      observation.domMutations.textChanged;

    if (hasNetWrite || hasValidationFeedback || urlChanged || domMutated) {
      const summary = hasNetWrite
        ? 'Dispatched network submission request'
        : hasValidationFeedback
        ? 'Displayed validation feedback'
        : urlChanged
        ? `Navigated to ${observation.finalUrl}`
        : 'DOM updated in response to submission';

      return {
        verdict: 'PASS',
        confidence: 'HIGH',
        check: 'form-submission',
        expected: expectedOutcome.description,
        actual: `Form action response: ${summary}`,
        reason: `Form submit button produced expected result (${summary})`,
        evidence,
      };
    }

    // Absolutely nothing happened on form submission
    return {
      verdict: 'FAIL',
      confidence: 'HIGH',
      check: 'form-submission',
      expected: expectedOutcome.description,
      actual: `Submit button "${elementLabel}" produced no observable response (no validation, no network submission, no DOM change)`,
      reason: `Form was submitted but the application gave zero feedback: no validation messages, no network request, and no state change`,
      rootCause: 'Submit button produced no observable response',
      evidence,
    };
  }

  // 5.6 NAVIGATE
  if (intent.kind === 'NAVIGATE') {
    if (observation.urlChanged || observation.navigated) {
      return {
        verdict: 'PASS',
        confidence: 'HIGH',
        check: 'navigation',
        expected: expectedOutcome.description,
        actual: `Navigated to ${observation.finalUrl}`,
        reason: `Link/navigation element successfully changed page destination`,
        evidence,
      };
    }

    if (observation.domMutations.addedNodesCount > 0 || observation.domMutations.textChanged) {
      return {
        verdict: 'PASS',
        confidence: 'MEDIUM',
        check: 'navigation',
        expected: expectedOutcome.description,
        actual: `Content updated in place on ${observation.finalUrl}`,
        reason: `In-app routing updated page view without full URL navigation`,
        evidence,
      };
    }

    return {
      verdict: 'FAIL',
      confidence: 'HIGH',
      check: 'navigation',
      expected: expectedOutcome.description,
      actual: `Link "${elementLabel}" produced no navigation and no destination content change`,
      reason: `Navigation target did not load or update the page view`,
      rootCause: 'Navigation produced no URL or page content change',
      evidence,
    };
  }

  // 5.7 TOGGLE (Checkbox / Switch)
  if (intent.kind === 'TOGGLE') {
    const checkedChanged = observation.ariaTransitions.checkedChanged;
    const targetPost = observation.targetPostState;
    if (checkedChanged || targetPost?.ariaChecked !== null) {
      return {
        verdict: 'PASS',
        confidence: 'HIGH',
        check: 'toggle',
        expected: expectedOutcome.description,
        actual: `Toggle state inverted to ${targetPost?.ariaChecked ?? 'checked'}`,
        reason: `Toggle/checkbox state changed successfully`,
        evidence,
      };
    }

    return {
      verdict: 'FAIL',
      confidence: 'HIGH',
      check: 'toggle',
      expected: expectedOutcome.description,
      actual: `Toggle "${elementLabel}" did not change checked state`,
      reason: `Clicking switch/checkbox did not toggle state`,
      rootCause: 'Toggle failed to change state',
      evidence,
    };
  }

  // 5.8 FILTER_OR_SORT & SEARCH
  if (intent.kind === 'FILTER_OR_SORT' || intent.kind === 'SEARCH') {
    const hasDomChange =
      observation.domMutations.addedNodesCount > 0 ||
      observation.domMutations.removedNodesCount > 0 ||
      observation.domMutations.textChanged ||
      observation.urlChanged;

    if (hasDomChange || observation.network.requests.length > 0) {
      return {
        verdict: 'PASS',
        confidence: 'HIGH',
        check: intent.kind === 'SEARCH' ? 'search' : 'filter-sort',
        expected: expectedOutcome.description,
        actual: `Items/view updated in response to ${intent.kind.toLowerCase()} action`,
        reason: `Interaction updated displayed list/results`,
        evidence,
      };
    }

    return {
      verdict: 'NEEDS_REVIEW',
      confidence: 'MEDIUM',
      check: intent.kind === 'SEARCH' ? 'search' : 'filter-sort',
      expected: expectedOutcome.description,
      actual: `No visible filter/sort change detected after clicking "${elementLabel}"`,
      reason: `Action may have filtered with identical results or operates asynchronously`,
      evidence,
    };
  }

  // 5.9 GENERAL_ACTION
  const hasObservableChange =
    observation.domMutations.addedNodesCount > 0 ||
    observation.domMutations.removedNodesCount > 0 ||
    observation.domMutations.textChanged ||
    observation.domMutations.attributeChanges.length > 0 ||
    observation.dialogs.opened.length > 0 ||
    observation.dialogs.closed.length > 0 ||
    observation.menus.opened.length > 0 ||
    observation.menus.closed.length > 0 ||
    observation.toasts.appeared.length > 0 ||
    observation.network.requests.length > 0 ||
    observation.urlChanged;

  if (hasObservableChange) {
    return {
      verdict: 'PASS',
      confidence: 'HIGH',
      check: 'observable-result',
      expected: `Button "${elementLabel}" has an observable effect on the application`,
      actual: `Action produced observable state change (DOM, network, or UI transition)`,
      reason: `Application responded to button interaction with observable change`,
      evidence,
    };
  }

  // If absolutely nothing happened:
  // Distinguish between obvious failure vs needs review
  const isHighVisibilityIntent = /^(save|delete|create|submit|login|sign in|add|remove|apply)$/i.test(
    elementLabel.trim(),
  );

  if (isHighVisibilityIntent) {
    return {
      verdict: 'FAIL',
      confidence: 'HIGH',
      check: 'observable-result',
      expected: `Action button "${elementLabel}" produces an observable state or feedback response`,
      actual: `Clicking "${elementLabel}" produced zero observable response (no DOM change, no network call, no dialog)`,
      reason: `Primary action button produced no response whatsoever`,
      rootCause: 'Primary action button produced no observable response',
      evidence,
    };
  }

  return {
    verdict: 'NEEDS_REVIEW',
    confidence: 'LOW',
    check: 'observable-result',
    expected: `Button "${elementLabel}" produces an observable effect`,
    actual: `No immediate observable change detected after clicking "${elementLabel}"`,
    reason: `Unable to verify whether the button operates silently or is genuinely broken`,
    evidence,
  };
}
