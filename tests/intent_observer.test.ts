import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDemoApp, type DemoServer } from '../demo-app/server.js';
import { BrowserController } from '../src/browser/index.js';
import { buildPageModel } from '../src/discovery/pageModel.js';
import { ActionBudget, ActionGuard } from '../src/functional/index.js';
import { classifyElementIntent } from '../src/functional/intent.js';
import { capturePreActionSnapshot, observeAction } from '../src/functional/observer.js';
import type { FunctionalContext } from '../src/functional/types.js';
import { loadConfig } from '../src/shared/config.js';
import { launchForTest } from './helpers/launch.js';

const config = loadConfig('qa.config.json');

describe('Phase 1: Semantic Intent Classifier', () => {
  it('correctly classifies SWITCH_TAB from role="tab" and tab classes', () => {
    const tab1 = classifyElementIntent({ selector: '#tab-overview', role: 'tab', text: 'Overview' });
    expect(tab1.kind).toBe('SWITCH_TAB');
    expect(tab1.confidence).toBe('HIGH');
    expect(tab1.expectedOutcome.expectedAriaSelected).toBe(true);

    const tab2 = classifyElementIntent({ selector: '.nav-tab', role: 'button', text: 'Settings' });
    expect(tab2.kind).toBe('SWITCH_TAB');
  });

  it('correctly classifies TOGGLE_ACCORDION from summary or aria-expanded', () => {
    const summary = classifyElementIntent({ selector: 'summary', tag: 'summary', text: 'FAQ Details' });
    expect(summary.kind).toBe('TOGGLE_ACCORDION');
    expect(summary.confidence).toBe('HIGH');

    const expanded = classifyElementIntent({ selector: '#acc-1', role: 'button', text: 'Section 1', aria: { expanded: 'false' } });
    expect(expanded.kind).toBe('TOGGLE_ACCORDION');
    expect(expanded.expectedOutcome.expectedAriaExpanded).toBe(true);
  });

  it('correctly classifies OPEN_MODAL and DISMISS_MODAL', () => {
    const openBtn = classifyElementIntent({ selector: '#btn-open', role: 'button', text: 'Launch Demo Modal', aria: { haspopup: true } });
    expect(openBtn.kind).toBe('OPEN_MODAL');
    expect(openBtn.expectedOutcome.expectedModalOpen).toBe(true);

    const closeBtn = classifyElementIntent({ selector: '.modal-content .btn-close', role: 'button', text: '✕', name: 'Close' });
    expect(closeBtn.kind).toBe('DISMISS_MODAL');
    expect(closeBtn.expectedOutcome.expectedModalClose).toBe(true);
  });

  it('correctly classifies SUBMIT_FORM from form context and submit type', () => {
    const submitBtn = classifyElementIntent({ selector: 'form #submit-btn', type: 'submit', text: 'Sign Up' });
    expect(submitBtn.kind).toBe('SUBMIT_FORM');
    expect(submitBtn.expectedOutcome.expectedValidation).toBe(true);
  });

  it('correctly classifies SEARCH and FILTER_OR_SORT', () => {
    const search = classifyElementIntent({ selector: '#search-submit', text: 'Search articles', role: 'button' });
    expect(search.kind).toBe('SEARCH');

    const filter = classifyElementIntent({ selector: '.filter-chip', text: 'Filter by Category' });
    expect(filter.kind).toBe('FILTER_OR_SORT');
  });

  it('correctly classifies TOGGLE from switch and checkbox', () => {
    const sw = classifyElementIntent({ selector: '#dark-mode', role: 'switch', text: 'Dark Mode' });
    expect(sw.kind).toBe('TOGGLE');
    expect(sw.expectedOutcome.expectedAriaChecked).toBe(true);
  });

  it('correctly classifies NAVIGATE for links with destination href', () => {
    const link = classifyElementIntent({ selector: 'a#nav-docs', role: 'link', href: '/documentation', text: 'Documentation' });
    expect(link.kind).toBe('NAVIGATE');
    expect(link.expectedOutcome.expectedUrlChange).toBe(true);
  });

  it('falls back to GENERAL_ACTION for generic buttons', () => {
    const generic = classifyElementIntent({ selector: '#counter-increment', text: 'Click me' });
    expect(generic.kind).toBe('GENERAL_ACTION');
    expect(generic.expectedOutcome.expectedDomMutation).toBe(true);
  });
});

describe('Phase 2: Observation Engine', () => {
  let demo: DemoServer;
  let c: BrowserController;
  let guard: ActionGuard;

  beforeAll(async () => {
    demo = await startDemoApp();
    c = await launchForTest({ baseUrl: demo.url, blockExternal: true });
  });

  afterAll(async () => {
    await c?.close();
    await demo?.close();
  });

  it('captures pre-action snapshot and performs multi-channel observation on click', async () => {
    await c.navigate(`${demo.url}/dynamic`);
    await c.settle(150);

    const model = await buildPageModel(c);
    guard = new ActionGuard({ keywords: config.dangerousActions.keywords, allowMethods: config.dangerousActions.allowMethods, origin: demo.url });
    const ctx: FunctionalContext = {
      controller: c,
      guard,
      pageUrl: c.page.url(),
      model,
      config,
      budget: new ActionBudget(50),
    };

    // 1. Capture Pre-Action Snapshot
    const pre = await capturePreActionSnapshot(c, 'body');
    expect(pre.url).toContain('/dynamic');
    expect(pre.elementCount).toBeGreaterThan(0);
    expect(pre.networkCount).toBeGreaterThanOrEqual(0);
    expect(pre.screenshot).toBeDefined();

    // 2. Perform action and observe
    const intent = classifyElementIntent({ selector: 'body', text: 'Dynamic Page' });
    const observation = await observeAction(ctx, pre, intent, { minWaitMs: 300, maxWaitMs: 800 });

    expect(observation.durationMs).toBeGreaterThanOrEqual(250);
    expect(observation.finalUrl).toBe(pre.url);
    expect(observation.urlChanged).toBe(false);
    expect(observation.domMutations).toBeDefined();
    expect(observation.network).toBeDefined();
    expect(observation.console).toBeDefined();
    expect(observation.screenshot).toBeDefined();
  });
});
