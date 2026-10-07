import type { InferredIntent, InteractionResult, PostActionObservation, VerificationOutcome } from './types.js';

export interface VerifyInput {
  intent: InferredIntent;
  observation: PostActionObservation;
  clickResult: InteractionResult;
  elementLabel: string;
  selector: string;
}

/** Failures proven by the runtime itself; they stand regardless of how sure we are about the element's intent. */
const HARD_CHECKS = new Set(['click-executable', 'javascript-error', 'network-failure']);

/**
 * Verifies whether the observed application behavior matches the expected semantic intent.
 * The verdict comes from what the UI observably did. Incidental technical signals never decide it by themselves:
 *  - a console error or uncaught exception is supporting evidence. The UI did what was expected => PASS, with the error kept
 *    as a diagnostic. It contributes to a FAIL only when the expected result did not happen;
 *  - a browser-automation error (timeout, interception, element not ready) is a test-runner event. The expected result was
 *    observed anyway => PASS. It is a FAIL only when the element is really obstructed; an undetermined cause => NEEDS_REVIEW;
 *  - a request stopped by ActionGuard yields BLOCKED (the workflow is unverified, neither pass nor failure);
 *  - "the expected change did not happen" is a FAIL only when the intent itself is HIGH confidence. A guessed
 *    intent (label or selector wording) that is not met goes to NEEDS_REVIEW instead of being called a bug.
 */
export function verifyInteraction(input: VerifyInput): VerificationOutcome {
  const outcome = decide(input);
  if (outcome.verdict === 'FAIL' && !HARD_CHECKS.has(outcome.check) && input.intent.confidence !== 'HIGH') {
    return {
      ...outcome, verdict: 'NEEDS_REVIEW', confidence: input.intent.confidence, rootCause: undefined,
      reason: `${outcome.reason}. The intent was inferred with ${input.intent.confidence} confidence, so this is not treated as a defect`,
    };
  }
  return outcome;
}

/** True when the action had any observable effect on the page (state, content, dialogs, navigation or network). */
export function observedChange(observation: PostActionObservation): boolean {
  return (observation.stateChanges ?? []).length > 0 || (observation.jsDialogs ?? []).length > 0 || (observation.popups ?? []).length > 0 || observation.urlChanged ||
    observation.domMutations.addedNodesCount > 0 || observation.domMutations.removedNodesCount > 0 || observation.domMutations.textChanged ||
    observation.domMutations.attributeChanges.length > 0 || observation.dialogs.opened.length > 0 || observation.dialogs.closed.length > 0 ||
    observation.menus.opened.length > 0 || observation.menus.closed.length > 0 || observation.toasts.appeared.length > 0 || observation.network.requests.length > 0;
}

/** True when the page itself visibly responded. A request being sent is not a response the user sees. */
export function uiChanged(observation: PostActionObservation): boolean {
  return observedChange({ ...observation, network: { ...observation.network, requests: [] } });
}

type Evidence = NonNullable<VerificationOutcome['evidence']>;

function decide(input: VerifyInput): VerificationOutcome {
  const { intent, observation, clickResult, elementLabel } = input;
  const { expectedOutcome } = intent;

  const evidence: Evidence = {
    beforeScreenshot: observation.pre.screenshot,
    afterScreenshot: observation.screenshot,
    domMutations: observation.domMutations.attributeChanges,
    networkCalls: observation.network.requests,
    consoleErrors: [...observation.console.pageErrors, ...observation.console.errors],
    durationMs: observation.durationMs,
  };

  // 1. The test runner reported an error while acting. That is not a verdict: the observed UI state is.
  if (!clickResult.ok) {
    const err = clickResult.error ?? 'unknown error';
    const seen = decideBehaviour(input, evidence);
    if (seen.verdict === 'PASS' && observedChange(observation)) {
      return {
        ...seen,
        reason: `${seen.reason}. The browser automation reported an error while acting (${err}), but the expected result was observed`,
        details: { ...seen.details, diagnostics: [`interaction: ${err}`] },
      };
    }
    if (clickResult.cause === 'obstructed') {
      return {
        verdict: 'FAIL',
        confidence: 'HIGH',
        check: 'click-executable',
        expected: `"${elementLabel}" can be clicked`,
        actual: `Click failed: ${err}`,
        reason: `Another element sits on top of "${elementLabel}", so it cannot be clicked, and the expected result did not happen`,
        rootCause: err,
        evidence,
      };
    }
    return {
      verdict: 'NEEDS_REVIEW',
      confidence: 'MEDIUM',
      check: 'click-executable',
      expected: expectedOutcome.description,
      actual: `The test runner could not perform the action on "${elementLabel}" (${err}) and the expected result was not observed`,
      reason: `A browser-automation error is not evidence of a website defect, and the cause could not be established (${clickResult.cause ?? 'unknown'})`,
      evidence,
    };
  }

  // 2. SAFETY: ActionGuard stopped a request this action tried to send. The UI responded, the workflow is unverified.
  const blocked = observation.network.blockedByGuard ?? [];
  if (blocked.length > 0) {
    return {
      verdict: 'BLOCKED',
      confidence: 'HIGH',
      check: 'blocked-by-safety',
      expected: expectedOutcome.description,
      actual: `The UI interaction was performed, but the QA safety policy blocked the request it sent (${blocked[0]!.slice(0, 160)})`,
      reason: `The workflow could not be fully verified because ActionGuard blocked ${blocked.length} request(s)`,
      evidence,
    };
  }

  // 3. A request the action sent failed AND the page showed nothing for it: the action did not do its job.
  //    When the page did respond, the failed request is supporting evidence only (step 4).
  if (observation.network.hasErrors && !uiChanged(observation)) {
    const isServerError = observation.network.requests.some(
      (n) => n.status !== null && n.status >= 500,
    );
    const firstErr = observation.network.errorDetails[0] ?? 'Request failed';
    return {
      verdict: 'FAIL',
      confidence: 'HIGH',
      check: 'network-failure',
      expected: `Activating "${elementLabel}" has a visible result, and the requests it sends succeed (HTTP < 400)`,
      actual: `Network failure: ${firstErr}. Nothing on the page changed in response`,
      reason: `The request sent by the action failed (${firstErr}) and the page showed no result for it`,
      rootCause: isServerError ? 'HTTP 5xx Server Error' : 'HTTP 4xx Client Error',
      evidence,
    };
  }

  // 4. What the UI did decides the verdict; errors and failed requests during the action are weighed against that result.
  return withRuntimeErrors(decideBehaviour(input, evidence), input);
}

/**
 * Console errors, uncaught exceptions and failed requests are secondary evidence:
 *  UI did what was expected                       -> PASS, error kept as a diagnostic
 *  nothing happened at all + uncaught exception   -> FAIL: the handler crashed instead of doing its job
 *  expected result failed (+ any error)           -> FAIL on the behavioural check, error named as supporting evidence
 *  UI result unclear + any error                  -> NEEDS_REVIEW
 * Errors the page already logged on its own before the action are excluded by the observer and never reach this point.
 */
function withRuntimeErrors(seen: VerificationOutcome, input: VerifyInput): VerificationOutcome {
  const { observation, elementLabel } = input;
  const thrown = observation.console.pageErrors;
  const logged = observation.console.errors;
  const failed = observation.network.hasErrors ? observation.network.errorDetails : [];
  if (thrown.length === 0 && logged.length === 0 && failed.length === 0) return seen;

  const first = (thrown[0] ?? logged[0] ?? failed[0]!).slice(0, 200);
  const what = thrown.length > 0 ? 'Uncaught exception' : logged.length > 0 ? 'console.error' : 'Failed request';
  const details = { ...seen.details, diagnostics: [...thrown.map((e) => `uncaught: ${e}`), ...logged.map((e) => `console.error: ${e}`), ...failed.map((e) => `request: ${e}`)] };

  if (seen.verdict === 'PASS') {
    return { ...seen, details, reason: `${seen.reason}. An error was logged during the action (${what}: ${first}); it is recorded as a diagnostic because the UI did what was expected` };
  }
  if (thrown.length > 0 && !observedChange(observation)) {
    return {
      verdict: 'FAIL',
      confidence: 'HIGH',
      check: 'javascript-error',
      expected: seen.expected,
      actual: `Nothing on the page changed after activating "${elementLabel}", and the page raised an uncaught exception while handling it: ${first}`,
      reason: `The action had no observable effect and its handler threw an uncaught JavaScript exception`,
      rootCause: thrown[0],
      details,
      evidence: seen.evidence,
    };
  }
  if (seen.verdict === 'FAIL') {
    return { ...seen, details, rootCause: `${seen.rootCause ?? seen.reason}. ${what} during the action: ${first}` };
  }
  return {
    ...seen, details,
    check: thrown.length > 0 ? 'javascript-error' : logged.length > 0 ? 'console-error' : 'network-failure',
    actual: `${seen.actual}. ${what} during the action: ${first}`,
    reason: `${seen.reason}. An error was logged, but an error alone does not show that the interaction is broken`,
  };
}

/** Intent-specific verification of the observed UI result. Looks only at what the page did, never at console output. */
function decideBehaviour(input: VerifyInput, evidence: Evidence): VerificationOutcome {
  const { intent, observation, elementLabel } = input;
  const { expectedOutcome } = intent;

  // A state change after an interaction is the normal, expected outcome. `stateChanges` covers what node counts miss:
  // the control's own state, the region it governs, layout, theme and form values.
  const stateChanges = observation.stateChanges ?? [];
  const stateChanged = stateChanges.length > 0;
  const stateNote = stateChanges.slice(0, 2).join('; ');
  const jsDialogs = observation.jsDialogs ?? [];
  const popups = observation.popups ?? [];
  const anyChange = observedChange(observation);

  // 5.0 A native dialog or a popup window is a complete, observable response whatever the control was guessed to be.
  if (jsDialogs.length > 0 || popups.length > 0) {
    const what = jsDialogs.length > 0 ? `a native ${jsDialogs[0]!.split(':')[0]} dialog ("${jsDialogs[0]!.split(': ').slice(1).join(': ').slice(0, 80)}")` : `a popup window (${popups[0] || 'about:blank'})`;
    return {
      verdict: 'PASS', confidence: 'HIGH', check: jsDialogs.length > 0 ? 'native-dialog' : 'popup-window',
      expected: expectedOutcome.description, actual: `"${elementLabel}" opened ${what}`, reason: 'The action produced its dialog/window', evidence,
    };
  }

  // 5.0b A control that is already in its active state (current page, selected tab, applied filter) is not expected to change anything.
  if (!anyChange && observation.pre.targetState?.active) {
    return {
      verdict: 'PASS', confidence: 'MEDIUM', check: 'already-active',
      expected: `"${elementLabel}" is already the active/current item, so activating it again changes nothing`,
      actual: `"${elementLabel}" was already active and stayed active; no change occurred`, reason: 'Re-activating the current item is a no-op by design', evidence,
    };
  }

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

    if (isSelected || hasActiveClass || domChanged || stateChanged) {
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

    if (expandedChange || domMutated || stateChanged || observation.menus.opened.length > 0 || observation.menus.closed.length > 0) {
      const stateNow = targetPost?.ariaExpanded ?? (stateNote || 'toggled');
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

    // A control that DECLARED itself collapsed (aria-expanded="false", or a closed <details>) and stays collapsed after a
    // successful click, with nothing else changing, did not do its one job.
    if (observation.pre.targetState?.ariaExpanded === 'false' && !anyChange) {
      return {
        verdict: 'FAIL',
        confidence: 'HIGH',
        check: 'expand-collapse',
        expected: expectedOutcome.description,
        actual: `"${elementLabel}" is declared collapsed (aria-expanded="false") and stayed collapsed after a successful click: no region opened and nothing on the page changed`,
        reason: `The control announces an expandable region but activating it does not expand anything`,
        rootCause: 'Expandable control does not expand',
        evidence,
      };
    }

    // Already expanded and not collapsing, or expandable only by a guess from its markup: not enough to call it broken.
    return {
      verdict: 'NEEDS_REVIEW',
      confidence: 'MEDIUM',
      check: 'accordion-toggle',
      expected: expectedOutcome.description,
      actual: `Expandable "${elementLabel}" produced no state change or content expansion`,
      reason: `Clicking the trigger did not toggle aria-expanded or change the content`,
      evidence,
    };
  }

  // 5.3 OPEN_MODAL
  if (intent.kind === 'OPEN_MODAL') {
    const dialogOpened = observation.dialogs.opened.length > 0;
    const hasMoreDialogs = observation.dialogs.countAfter > observation.dialogs.countBefore;
    const hasToasts = observation.toasts.appeared.length > 0;

    if (observation.menus.opened.length > 0 || observation.ariaTransitions.expandedChanged?.to === 'true') {
      return {
        verdict: 'PASS',
        confidence: 'HIGH',
        check: 'popup-open',
        expected: expectedOutcome.description,
        actual: `Popup/menu opened by "${elementLabel}"`,
        reason: `The trigger opened its popup (menu or expandable region)`,
        evidence,
      };
    }

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

    if (anyChange) {
      // Something did respond, but nothing recognisable as a dialog: not proof that the trigger is broken.
      return {
        verdict: 'NEEDS_REVIEW',
        confidence: 'MEDIUM',
        check: 'modal-open',
        expected: expectedOutcome.description,
        actual: `"${elementLabel}" changed the page (${stateNote || 'content or network activity'}) but no dialog or overlay could be identified`,
        reason: `The page responded to the click; whether a dialog was shown could not be established`,
        evidence,
      };
    }

    return {
      verdict: 'FAIL',
      confidence: 'HIGH',
      check: 'modal-open',
      expected: expectedOutcome.description,
      actual: `No dialog or modal appeared after clicking "${elementLabel}", and nothing else on the page changed`,
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

    if (dialogClosed || countDecreased || countIsZero || stateChanged) {
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

    if (hasNetWrite || hasValidationFeedback || urlChanged || domMutated || stateChanged) {
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

    if (observation.domMutations.addedNodesCount > 0 || observation.domMutations.textChanged || stateChanged) {
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
    if (checkedChanged || stateChanged) {
      return {
        verdict: 'PASS',
        confidence: 'HIGH',
        check: 'toggle',
        expected: expectedOutcome.description,
        actual: checkedChanged ? `Toggle state changed to ${targetPost?.ariaChecked ?? 'checked'}` : `Toggle changed state (${stateNote})`,
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

  // 5.75 PAGINATE: the listed data, the current-page marker or the URL must change
  if (intent.kind === 'PAGINATE') {
    const pageChanged = stateChanged || observation.urlChanged || observation.domMutations.textChanged ||
      observation.domMutations.addedNodesCount > 0 || observation.domMutations.removedNodesCount > 0 || observation.network.requests.length > 0;
    if (pageChanged) {
      return {
        verdict: 'PASS', confidence: 'HIGH', check: 'pagination', expected: expectedOutcome.description,
        actual: observation.urlChanged ? `Moved to ${observation.finalUrl}` : `The page of results changed (${stateNote || 'content updated'})`,
        reason: 'The pagination control showed a different page', evidence,
      };
    }
    // A numbered page that is not the current one must become current. Next/Previous may legitimately be at the end.
    const numbered = /\d/.test(elementLabel) && !/next|prev|first|last/i.test(elementLabel);
    if (numbered && observation.targetPostState && !observation.targetPostState.active) {
      return {
        verdict: 'FAIL', confidence: 'HIGH', check: 'pagination', expected: expectedOutcome.description,
        actual: `Page control "${elementLabel}" was clicked but the listed data, the current-page marker and the URL all stayed the same`,
        reason: 'Selecting a different page number did not change the page', rootCause: 'Pagination does not move to the selected page', evidence,
      };
    }
    return {
      verdict: 'NEEDS_REVIEW', confidence: 'MEDIUM', check: 'pagination', expected: expectedOutcome.description,
      actual: `"${elementLabel}" changed nothing; it may already be at the first or last page`,
      reason: 'No page change was observed, which is correct at either end of the list', evidence,
    };
  }

  // 5.8 FILTER_OR_SORT & SEARCH
  if (intent.kind === 'FILTER_OR_SORT' || intent.kind === 'SEARCH') {
    const hasDomChange =
      observation.domMutations.addedNodesCount > 0 ||
      observation.domMutations.removedNodesCount > 0 ||
      observation.domMutations.textChanged ||
      observation.domMutations.attributeChanges.length > 0 ||
      stateChanged ||
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
  const hasObservableChange = anyChange;

  if (hasObservableChange) {
    return {
      verdict: 'PASS',
      confidence: 'HIGH',
      check: 'observable-result',
      expected: `Button "${elementLabel}" has an observable effect on the application`,
      actual: `Action produced an observable change${stateNote ? `: ${stateNote}` : ' (DOM, network, or UI transition)'}`,
      reason: `Application responded to button interaction with observable change`,
      evidence,
    };
  }

  // Nothing observable happened. Without a structural expectation this is not evidence of a defect.
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
