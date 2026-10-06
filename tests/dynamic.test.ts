import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DYNAMIC_TRUTH } from '../demo-app/pages.js';
import { startDemoApp, type DemoServer } from '../demo-app/server.js';
import type { BrowserController } from '../src/browser/index.js';
import type { RawField, RawForm } from '../src/browser/types.js';
import { computeVerdict } from '../src/database/review.js';
import { buildPageModel } from '../src/discovery/pageModel.js';
import { classifyFinding, classifyForm, classifyPage, classifyResult, selectTests, type PageProfile, type TestPlan } from '../src/dynamic/index.js';
import { ActionBudget, ActionGuard, producesFinding, runFunctionalTests, verifyInteraction, type FunctionalResult, type InferredIntent, type PostActionObservation } from '../src/functional/index.js';
import { validValue } from '../src/functional/synthetic.js';
import { collectRuleContext } from '../src/rules/context.js';
import { buildRegistry } from '../src/rules/index.js';
import { loadConfig } from '../src/shared/config.js';
import { launchForTest } from './helpers/launch.js';

const config = loadConfig('qa.config.json');

const field = (o: Partial<RawField>): RawField => ({ selector: '#f', tag: 'input', type: 'text', name: '', label: '', placeholder: '', required: false, visible: true, disabled: false, ...o });
const form = (fields: RawField[], submit: RawForm['submit'] = { selector: '#go', text: 'Send' }, name = ''): RawForm => ({ selector: '#form', name, action: '', method: 'POST', noValidate: false, visible: true, fields, submit });

describe('detection: what a form is for', () => {
  it('login = one password field in a small form', () => {
    expect(classifyForm(form([field({ type: 'email', name: 'email' }), field({ type: 'password', name: 'password' })])).role).toBe('login');
  });
  it('a sign-up form with a password is a submission form, not a login', () => {
    const f = form([field({ name: 'name' }), field({ type: 'email' }), field({ name: 'company' }), field({ type: 'password' })]);
    expect(classifyForm(f).role).toBe('submission');
  });
  it('search = a search-typed field, or a single field named like a search', () => {
    expect(classifyForm(form([field({ type: 'search', name: 'q' })]))).toMatchObject({ role: 'search', confidence: 'HIGH' });
    expect(classifyForm(form([field({ name: 'q', placeholder: 'Search products' })]))).toMatchObject({ role: 'search', confidence: 'MEDIUM' });
  });
  it('inputs without a submit control are NOT a submission form', () => {
    expect(classifyForm(form([field({ name: 'quantity', type: 'number' })], null)).role).toBe('none');
  });
});

describe('context-aware synthetic values', () => {
  it('uses the label/name to pick plausible values', () => {
    expect(validValue(field({ label: 'Name' }))).toBe('Demo User');
    expect(validValue(field({ type: 'email' }))).toBe('john@maildrop.cc');
    expect(validValue(field({ label: 'Company' }))).toBe('Example Corp');
    expect(validValue(field({ type: 'number', label: 'Age', min: '18' }))).toBe('25');
    expect(Number(validValue(field({ type: 'number', label: 'Age', min: '30', max: '40' })))).toBeGreaterThanOrEqual(30);
  });
});

describe('result classification', () => {
  const r = (o: Partial<FunctionalResult>): FunctionalResult => ({ kind: 'button', check: 'x', status: 'pass', severity: 'info', basis: null, element: null, expected: 'e', actual: 'a', ...o });
  it('maps outcomes to BUG / EXPECTED / INCONCLUSIVE / BLOCKED_BY_SAFETY', () => {
    expect(classifyResult(r({ status: 'fail', severity: 'major', basis: 'deterministic', confidence: 'HIGH' }))).toBe('BUG');
    expect(classifyResult(r({ status: 'fail', severity: 'minor', basis: 'generic_rule' }))).toBe('BUG');
    expect(classifyResult(r({ status: 'pass' }))).toBe('EXPECTED');
    expect(classifyResult(r({ status: 'anomaly' }))).toBe('INCONCLUSIVE');
    expect(classifyResult(r({ status: 'blocked' }))).toBe('BLOCKED_BY_SAFETY');
    expect(classifyResult(r({ status: 'skipped', check: 'guard' }))).toBe('BLOCKED_BY_SAFETY');
    expect(classifyResult(r({ status: 'skipped', check: 'visibility' }))).toBeNull();
  });
  it('a low-confidence or basis-less failure is never a BUG', () => {
    expect(classifyResult(r({ status: 'fail', severity: 'major', basis: 'deterministic', confidence: 'LOW' }))).toBe('INCONCLUSIVE');
    expect(classifyResult(r({ status: 'fail', severity: 'major', basis: null }))).toBe('INCONCLUSIVE');
  });
  it('labels stored findings the same way and honours human decisions', () => {
    const ui = { category: 'layout', ruleId: 'geometry.overlap' };
    expect(classifyFinding({ classification: 'defect', severity: 'major', ...ui })).toBe('BUG');
    expect(classifyFinding({ classification: 'defect', severity: 'minor', ...ui })).toBe('BUG');
    expect(classifyFinding({ classification: 'anomaly', severity: 'major', ...ui })).toBe('INCONCLUSIVE');
    expect(classifyFinding({ classification: 'anomaly', severity: 'minor', reviewState: 'confirmed', ...ui })).toBe('BUG');
    expect(classifyFinding({ classification: 'defect', severity: 'major', reviewState: 'dismissed', ...ui })).toBe('EXPECTED');
  });
});

describe('accessibility is a separate category', () => {
  const a11y = { reviewState: 'defect' as const, severity: 'critical' as const, category: 'accessibility', ruleId: 'a11y.color-contrast' };
  it('does not fail or block a run by default', () => {
    expect(computeVerdict([a11y])).toBe('PASS');
    expect(computeVerdict([{ ...a11y, reviewState: 'pending' }])).toBe('PASS');
    expect(computeVerdict([a11y, { reviewState: 'defect', severity: 'minor', category: 'layout', ruleId: 'geometry.off-screen' }])).toBe('PASS_WITH_WARNINGS');
  });
  it('fails the run when accessibility is a required category, or when a human confirms the finding', () => {
    expect(computeVerdict([a11y], { accessibilityFailRun: true })).toBe('FAILED');
    expect(computeVerdict([{ ...a11y, reviewState: 'confirmed' }])).toBe('FAILED');
  });
});

describe('verifier: safety blocks and weak evidence', () => {
  const obs = (o: Partial<PostActionObservation> = {}): PostActionObservation => ({
    pre: { url: 'http://x/', title: '', domDigest: '100|20|0|0', elementCount: 20, dialogsCount: 0, openDialogSelectors: [], openMenuSelectors: [], ariaExpandedCount: 0, toastsCount: 0, targetState: null, networkCount: 0, consoleCount: 0, timestamp: 0 },
    finalUrl: 'http://x/', urlChanged: false, navigated: false, durationMs: 300,
    domMutations: { addedNodesCount: 0, removedNodesCount: 0, textChanged: false, attributeChanges: [] },
    dialogs: { opened: [], closed: [], countBefore: 0, countAfter: 0 }, menus: { opened: [], closed: [] }, toasts: { appeared: [] }, ariaTransitions: {},
    network: { requests: [], hasWrites: false, hasErrors: false, errorDetails: [] }, console: { errors: [], pageErrors: [] }, targetPostState: null, ...o,
  });
  const intent = (kind: InferredIntent['kind'], confidence: InferredIntent['confidence']): InferredIntent => ({ kind, confidence, summary: '', expectedOutcome: { description: 'expected', targetSelector: '#b' } });
  const verify = (i: InferredIntent, o: PostActionObservation, label = 'Open') => verifyInteraction({ intent: i, observation: o, clickResult: { ok: true }, elementLabel: label, selector: '#b' });

  it('a request stopped by ActionGuard is BLOCKED: not a pass, not a failure', () => {
    const out = verify(intent('SUBMIT_FORM', 'HIGH'), obs({ network: { requests: [], hasWrites: false, hasErrors: false, errorDetails: [], blockedByGuard: ['POST http://x/api/save'] } }), 'Save');
    expect(out.verdict).toBe('BLOCKED');
    expect(out.actual).toMatch(/safety policy blocked/);
  });
  it('a declared modal trigger that opens nothing is a FAIL; a guessed one goes to review', () => {
    expect(verify(intent('OPEN_MODAL', 'HIGH'), obs()).verdict).toBe('FAIL');
    expect(verify(intent('OPEN_MODAL', 'MEDIUM'), obs()).verdict).toBe('NEEDS_REVIEW');
  });
  it('"nothing visibly happened" alone is never a failure, whatever the button is called', () => {
    for (const label of ['Save', 'Delete', 'Apply', 'Do something']) expect(verify(intent('GENERAL_ACTION', 'LOW'), obs(), label).verdict).toBe('NEEDS_REVIEW');
  });
  it('strong runtime evidence is a FAIL even when the intent is unclear', () => {
    const out = verify(intent('GENERAL_ACTION', 'LOW'), obs({ network: { requests: [{ method: 'POST', url: 'http://x/save', status: 500 }], hasWrites: true, hasErrors: true, errorDetails: ['POST http://x/save returned HTTP 500'] } }), 'Save');
    expect(out).toMatchObject({ verdict: 'FAIL', check: 'network-failure' });
  });
});

describe('the same engine chooses different tests per page (demo app)', () => {
  let demo: DemoServer; let c: BrowserController;
  beforeAll(async () => { demo = await startDemoApp(); c = await launchForTest({ baseUrl: demo.url, blockExternal: true }); });
  afterAll(async () => { await c?.close(); await demo?.close(); });

  async function plan(path: string): Promise<{ profile: PageProfile; plan: TestPlan; run(): Promise<FunctionalResult[]> }> {
    const guard = new ActionGuard({ keywords: config.dangerousActions.keywords, allowMethods: config.dangerousActions.allowMethods, origin: demo.url });
    c.setRequestGuard(guard.asRequestGuard());
    await c.navigate(`${demo.url}${path}`); await c.settle(150);
    const model = await buildPageModel(c);
    const profile = classifyPage(model);
    const p = selectTests(profile, model, config);
    return { profile, plan: p, run: () => runFunctionalTests({ controller: c, guard, pageUrl: c.page.url(), model, config, budget: new ActionBudget(300), plan: p }) };
  }
  const kinds = (r: FunctionalResult[]) => [...new Set(r.map((x) => x.kind))].sort();
  const cls = (r: FunctionalResult[], check: string) => r.filter((x) => x.check === check).map((x) => classifyResult(x));

  it('detects the documented page types and selects/skips the documented scenarios', async () => {
    for (const [path, truth] of Object.entries(DYNAMIC_TRUTH)) {
      const { profile, plan: p } = await plan(path);
      const types = profile.types.filter((t) => t.confidence !== 'LOW').map((t) => t.type);
      const selected = p.selected.map((s) => s.id);
      for (const t of truth.types) expect(types, `${t} on ${path}`).toContain(t);
      for (const s of truth.selected) expect(selected, `${s} selected on ${path}`).toContain(s);
      for (const s of truth.notSelected) expect(selected, `${s} NOT selected on ${path}`).not.toContain(s);
      // every decision is explained
      expect(p.selected.every((s) => s.reason && s.pageType && s.confidence)).toBe(true);
      expect(p.skipped.every((s) => s.reason)).toBe(true);
    }
  });

  it('marketing page: links only; no form, search or modal test; the skip is explained', async () => {
    const { plan: p, run } = await plan('/marketing');
    expect(p.skipped.find((s) => s.id === 'form-validation')?.reason).toMatch(/no submission form detected/);
    const r = await run();
    expect(kinds(r)).toEqual(['link']);
    expect(r.some((x) => x.status === 'fail' && /pricing-2019.*HTTP 404/.test(x.actual))).toBe(true);
  });

  it('marketing page: stretched image and uneven card spacing are reported, the latter for review only', async () => {
    await c.navigate(`${demo.url}/marketing`); await c.settle(150);
    const hints = loadConfig('qa.config.json', { dynamic: { consistencyChecks: true } }); // spacing/alignment hints are opt-in
    const f = (await (await buildRegistry(hints)).run(await collectRuleContext(c, { config: hints }))).findings;
    expect((await (await buildRegistry(config)).run(await collectRuleContext(c, { config }))).findings.some((x) => x.ruleId.startsWith('consistency.'))).toBe(false);
    expect(f.find((x) => x.ruleId === 'image.distorted')).toMatchObject({ classification: 'defect', severity: 'minor' });
    expect(f.find((x) => x.ruleId === 'consistency.spacing')).toMatchObject({ classification: 'anomaly', basis: null });
    expect(f.some((x) => x.ruleId === 'image.broken')).toBe(false);
  });

  it('form page: constraint tests run; the blocked submit is BLOCKED_BY_SAFETY and nothing is sent', async () => {
    const { run } = await plan('/forms');
    const r = (await run()).filter((x) => x.kind === 'form');
    expect(r.filter((x) => x.status === 'fail').map((x) => x.check)).toEqual(expect.arrayContaining(['required-not-enforced', 'invalid-input-accepted']));
    expect(cls(r, 'valid-submission')).toEqual(['BLOCKED_BY_SAFETY']);
    expect(r.find((x) => x.check === 'valid-submission')!.actual).toMatch(/could not be fully verified because the QA safety policy blocked/);
    expect(r.every((x) => x.scenario?.id === 'form-validation' && x.scenario.pageType === 'FORM')).toBe(true);
    expect(demo.hits.subscribe).toBe(0);
  });

  it('login page: correct validation is EXPECTED, the attempt is BLOCKED_BY_SAFETY, no per-field probing', async () => {
    const { run } = await plan('/login');
    const r = (await run()).filter((x) => x.kind === 'form');
    expect(cls(r, 'empty-submission')).toEqual(['EXPECTED']);
    expect(cls(r, 'login-attempt')).toEqual(['BLOCKED_BY_SAFETY']);
    expect(r.some((x) => x.check === 'invalid-input' || x.check === 'invalid-input-accepted')).toBe(false);
    expect(r.filter((x) => x.status === 'fail')).toEqual([]);
    expect(demo.hits.login).toBe(0);
  });

  it('dashboard: search, filters, tabs and pagination run; no form validation; a failing request is a BUG with its own evidence', async () => {
    const { run } = await plan('/dashboard');
    const r = await run();
    expect(kinds(r)).toEqual(expect.arrayContaining(['button', 'search']));
    expect(kinds(r)).not.toContain('form');
    expect(cls(r.filter((x) => x.kind === 'search'), 'search')).toEqual(['EXPECTED']);
    const by = (id: string) => r.filter((x) => x.scenario?.id === id);
    expect(by('filters').length).toBe(2);
    expect(by('filters').every((x) => x.status === 'pass')).toBe(true);
    expect(by('tabs').every((x) => x.status === 'pass')).toBe(true);
    // "Next" changes the rows; "Previous" on page 1 changes nothing: tested, not a pass, not a bug, and not reported
    expect(by('pagination').map((x) => classifyResult(x)).sort()).toEqual(['EXPECTED', 'INCONCLUSIVE']);
    expect(by('pagination').filter(producesFinding)).toEqual([]);
    const bug = r.find((x) => x.check === 'network-failure')!;
    expect(classifyResult(bug)).toBe('BUG');
    expect(bug.element?.name).toMatch(/Export CSV/);
    expect(bug.before && bug.screenshot).toBeTruthy();
    expect(bug.trace?.network.join(' ')).toMatch(/\/api\/fail -> 500/);
    expect(r.filter((x) => x.status === 'fail')).toEqual([bug]);
  }, 180_000);

  it('modal page: opening and closing with the close control are verified; Escape is never tested or reported', async () => {
    const { run } = await plan('/modal');
    const r = (await run()).filter((x) => x.kind === 'modal');
    expect(cls(r, 'modal-open')).toEqual(['EXPECTED']);
    expect(cls(r, 'modal-close')).toEqual(['EXPECTED']);
    expect(r.find((x) => x.check === 'modal-close')!.actual).toMatch(/closed with its "Close" control/);
    // this dialog ignores the Escape key: that is keyboard behaviour, out of scope, and must not surface anywhere
    expect(r.some((x) => /escape/i.test(`${x.check} ${x.expected} ${x.actual}`))).toBe(false);
    expect(r.filter((x) => x.status !== 'pass')).toEqual([]);
  });

  it('unknown page: every button is still clicked, and hard runtime failures are caught', async () => {
    const { profile, plan: p, run } = await plan('/errors');
    expect(profile.types.map((t) => t.type)).toContain('UNKNOWN_GENERAL');
    expect(p.buttons.every((b) => b.scenario.id === 'generic-buttons')).toBe(true);
    expect(p.buttons.length).toBe(3); // all of them, not a sample
    const failed = (await run()).filter((x) => x.status === 'fail');
    expect(failed.map((x) => x.check)).toEqual(expect.arrayContaining(['javascript-error', 'network-failure']));
  });

  it('legitimate UI: no failure of any kind (false-positive check)', async () => {
    const { run } = await plan('/legit');
    const r = await run();
    expect(r.filter((x) => x.status === 'fail').map((x) => `${x.kind}/${x.check}: ${x.actual}`)).toEqual([]);
    expect(cls(r, 'empty-submission')).toEqual(['EXPECTED']);
    expect(cls(r, 'invalid-input')).toContain('EXPECTED');
  });
});
