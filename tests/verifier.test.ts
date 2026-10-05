import { describe, expect, it } from 'vitest';
import type { InferredIntent, PostActionObservation } from '../src/functional/types.js';
import { verifyInteraction } from '../src/functional/verifier.js';

function createMockObservation(overrides: Partial<PostActionObservation> = {}): PostActionObservation {
  return {
    pre: {
      url: 'http://localhost:3000',
      title: 'Mock Page',
      domDigest: '100|20|0|0',
      elementCount: 20,
      dialogsCount: 0,
      openDialogSelectors: [],
      openMenuSelectors: [],
      ariaExpandedCount: 0,
      toastsCount: 0,
      targetState: null,
      networkCount: 0,
      consoleCount: 0,
      timestamp: Date.now(),
      screenshot: Buffer.from('mock-pre'),
    },
    finalUrl: 'http://localhost:3000',
    urlChanged: false,
    navigated: false,
    durationMs: 400,
    domMutations: {
      addedNodesCount: 0,
      removedNodesCount: 0,
      textChanged: false,
      attributeChanges: [],
    },
    dialogs: {
      countBefore: 0,
      countAfter: 0,
      opened: [],
      closed: [],
    },
    menus: {
      opened: [],
      closed: [],
    },
    toasts: {
      appeared: [],
    },
    ariaTransitions: {},
    targetPostState: null,
    network: {
      requests: [],
      hasWrites: false,
      hasErrors: false,
      errorDetails: [],
    },
    console: {
      errors: [],
      pageErrors: [],
    },
    screenshot: Buffer.from('mock-post'),
    ...overrides,
  };
}

describe('Phase 3: Verification Decision Layer', () => {
  describe('Hard Failures', () => {
    it('fails when Playwright click execution fails', () => {
      const intent: InferredIntent = {
        kind: 'GENERAL_ACTION',
        confidence: 'HIGH',
        summary: 'Button',
        expectedOutcome: { description: 'Action completes' },
      };
      const obs = createMockObservation();
      const outcome = verifyInteraction({
        intent,
        observation: obs,
        clickResult: { ok: false, error: 'Element is covered by another modal' },
        elementLabel: 'Submit Order',
        selector: '#btn-submit',
      });

      expect(outcome.verdict).toBe('FAIL');
      expect(outcome.confidence).toBe('HIGH');
      expect(outcome.check).toBe('click-executable');
      expect(outcome.actual).toContain('Element is covered');
      expect(outcome.rootCause).toContain('Element is covered');
    });

    it('fails when uncaught JavaScript page error occurs', () => {
      const intent: InferredIntent = {
        kind: 'SWITCH_TAB',
        confidence: 'HIGH',
        summary: 'Tab',
        expectedOutcome: { description: 'Tab switches' },
      };
      const obs = createMockObservation({
        console: {
          errors: [],
          pageErrors: ['TypeError: Cannot read properties of undefined (reading "classList")'],
        },
      });
      const outcome = verifyInteraction({
        intent,
        observation: obs,
        clickResult: { ok: true },
        elementLabel: 'Settings Tab',
        selector: '#tab-settings',
      });

      expect(outcome.verdict).toBe('FAIL');
      expect(outcome.check).toBe('javascript-error');
      expect(outcome.actual).toContain('Cannot read properties of undefined');
    });

    it('fails when interaction causes network 4xx/5xx failure', () => {
      const intent: InferredIntent = {
        kind: 'SUBMIT_FORM',
        confidence: 'HIGH',
        summary: 'Form submit',
        expectedOutcome: { description: 'Submits form' },
      };
      const obs = createMockObservation({
        network: {
          requests: [{ url: '/api/checkout', method: 'POST', status: 500, durationMs: 120 }],
          hasWrites: true,
          hasErrors: true,
          errorDetails: ['POST /api/checkout -> 500 Internal Server Error'],
        },
      });
      const outcome = verifyInteraction({
        intent,
        observation: obs,
        clickResult: { ok: true },
        elementLabel: 'Checkout',
        selector: '#btn-checkout',
      });

      expect(outcome.verdict).toBe('FAIL');
      expect(outcome.check).toBe('network-failure');
      expect(outcome.rootCause).toBe('HTTP 5xx Server Error');
      expect(outcome.actual).toContain('500 Internal Server Error');
    });
  });

  describe('Intent: SWITCH_TAB', () => {
    const tabIntent: InferredIntent = {
      kind: 'SWITCH_TAB',
      confidence: 'HIGH',
      summary: 'Role is tab',
      expectedOutcome: {
        description: 'Selected tab changes and associated tabpanel is revealed',
        expectedAriaSelected: true,
      },
    };

    it('passes when tab becomes aria-selected or active class is applied', () => {
      const obs = createMockObservation({
        targetPostState: {
          ariaSelected: 'true',
          ariaExpanded: null,
          ariaChecked: null,
          classes: ['nav-item', 'active'],
          visible: true,
        },
        domMutations: {
          addedNodesCount: 2,
          removedNodesCount: 1,
          textChanged: true,
          attributeChanges: ['aria-selected'],
        },
      });
      const outcome = verifyInteraction({
        intent: tabIntent,
        observation: obs,
        clickResult: { ok: true },
        elementLabel: 'Profile Tab',
        selector: '#tab-profile',
      });

      expect(outcome.verdict).toBe('PASS');
      expect(outcome.confidence).toBe('HIGH');
      expect(outcome.check).toBe('tab-switch');
      expect(outcome.actual).toContain('activated');
    });

    it('fails when clicking tab produces zero active state change or panel update', () => {
      const obs = createMockObservation({
        targetPostState: {
          ariaSelected: 'false',
          ariaExpanded: null,
          ariaChecked: null,
          classes: ['nav-item'],
          visible: true,
        },
      });
      const outcome = verifyInteraction({
        intent: tabIntent,
        observation: obs,
        clickResult: { ok: true },
        elementLabel: 'Broken Tab',
        selector: '#tab-broken',
      });

      expect(outcome.verdict).toBe('FAIL');
      expect(outcome.check).toBe('tab-switch');
      expect(outcome.rootCause).toContain('Tab click failed to activate');
    });
  });

  describe('Intent: OPEN_MODAL & DISMISS_MODAL', () => {
    it('passes when OPEN_MODAL causes dialog to open', () => {
      const openIntent: InferredIntent = {
        kind: 'OPEN_MODAL',
        confidence: 'HIGH',
        summary: 'Button text has modal trigger keywords',
        expectedOutcome: {
          description: 'A modal dialog or overlay appears on screen',
          expectedModalOpen: true,
        },
      };
      const obs = createMockObservation({
        dialogs: {
          countBefore: 0,
          countAfter: 1,
          opened: ['dialog[role="dialog"]'],
          closed: [],
        },
      });
      const outcome = verifyInteraction({
        intent: openIntent,
        observation: obs,
        clickResult: { ok: true },
        elementLabel: 'Open Dialog',
        selector: '#btn-dialog',
      });

      expect(outcome.verdict).toBe('PASS');
      expect(outcome.check).toBe('modal-open');
      expect(outcome.actual).toContain('Modal dialog opened');
    });

    it('fails when OPEN_MODAL button is clicked but no modal appears', () => {
      const openIntent: InferredIntent = {
        kind: 'OPEN_MODAL',
        confidence: 'HIGH',
        summary: 'Button text has modal trigger keywords',
        expectedOutcome: {
          description: 'A modal dialog or overlay appears on screen',
          expectedModalOpen: true,
        },
      };
      const obs = createMockObservation();
      const outcome = verifyInteraction({
        intent: openIntent,
        observation: obs,
        clickResult: { ok: true },
        elementLabel: 'Open Broken Dialog',
        selector: '#btn-broken-modal',
      });

      expect(outcome.verdict).toBe('FAIL');
      expect(outcome.check).toBe('modal-open');
      expect(outcome.rootCause).toContain('Modal trigger failed to open any dialog');
    });

    it('passes when DISMISS_MODAL closes the modal', () => {
      const dismissIntent: InferredIntent = {
        kind: 'DISMISS_MODAL',
        confidence: 'HIGH',
        summary: 'Close button inside modal',
        expectedOutcome: {
          description: 'The active modal dialog is dismissed or hidden',
          expectedModalClose: true,
        },
      };
      const obs = createMockObservation({
        dialogs: {
          countBefore: 1,
          countAfter: 0,
          opened: [],
          closed: ['dialog[role="dialog"]'],
        },
      });
      const outcome = verifyInteraction({
        intent: dismissIntent,
        observation: obs,
        clickResult: { ok: true },
        elementLabel: 'Close',
        selector: '.btn-close',
      });

      expect(outcome.verdict).toBe('PASS');
      expect(outcome.check).toBe('modal-dismiss');
    });
  });

  describe('Intent: SUBMIT_FORM (Avoiding False Positives)', () => {
    const submitIntent: InferredIntent = {
      kind: 'SUBMIT_FORM',
      confidence: 'HIGH',
      summary: 'type="submit"',
      expectedOutcome: {
        description: 'Submits form or triggers client/server validation feedback',
        expectedValidation: true,
      },
    };

    it('passes when validation errors or toast messages appear', () => {
      const obs = createMockObservation({
        toasts: { appeared: ['Please fill in required fields'] },
      });
      const outcome = verifyInteraction({
        intent: submitIntent,
        observation: obs,
        clickResult: { ok: true },
        elementLabel: 'Submit',
        selector: 'button[type="submit"]',
      });

      expect(outcome.verdict).toBe('PASS');
      expect(outcome.check).toBe('form-submission');
      expect(outcome.actual).toContain('validation feedback');
    });

    it('fails when clicking submit gives ZERO feedback, zero network requests, and zero DOM changes', () => {
      const obs = createMockObservation();
      const outcome = verifyInteraction({
        intent: submitIntent,
        observation: obs,
        clickResult: { ok: true },
        elementLabel: 'Broken Submit',
        selector: '#broken-submit',
      });

      expect(outcome.verdict).toBe('FAIL');
      expect(outcome.check).toBe('form-submission');
      expect(outcome.rootCause).toBe('Submit button produced no observable response');
    });
  });

  describe('Intent: GENERAL_ACTION and Ambiguity Handling', () => {
    it('returns NEEDS_REVIEW for generic button when no observable change occurs', () => {
      const intent: InferredIntent = {
        kind: 'GENERAL_ACTION',
        confidence: 'LOW',
        summary: 'Generic button without specific role or text cues',
        expectedOutcome: {
          description: 'State updates or visual response occurs',
          expectedDomMutation: true,
        },
      };
      const obs = createMockObservation();
      const outcome = verifyInteraction({
        intent,
        observation: obs,
        clickResult: { ok: true },
        elementLabel: 'Info Tooltip Trigger',
        selector: '#info-trigger',
      });

      expect(outcome.verdict).toBe('NEEDS_REVIEW');
      expect(outcome.confidence).toBe('LOW');
      expect(outcome.actual).toContain('No immediate observable change detected');
    });

    it('sends a silent action button (like "Save") to review: no observable change alone is not proof of a bug', () => {
      const intent: InferredIntent = {
        kind: 'GENERAL_ACTION',
        confidence: 'HIGH',
        summary: 'Action button',
        expectedOutcome: {
          description: 'State updates or visual response occurs',
          expectedDomMutation: true,
        },
      };
      const obs = createMockObservation();
      const outcome = verifyInteraction({
        intent,
        observation: obs,
        clickResult: { ok: true },
        elementLabel: 'Save',
        selector: '#save-button',
      });

      expect(outcome.verdict).toBe('NEEDS_REVIEW');
      expect(outcome.actual).toContain('No immediate observable change detected');
    });
  });
});
