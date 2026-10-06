import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDemoApp, type DemoServer } from '../demo-app/server.js';
import { buildPageModel } from '../src/discovery/pageModel.js';
import { classifyPage, selectTests } from '../src/dynamic/index.js';
import { ActionGuard, ActionBudget, runFunctionalTests, type FunctionalResult } from '../src/functional/index.js';
import { loadConfig } from '../src/shared/config.js';
import { validValue, invalidValue } from '../src/functional/synthetic.js';
import { launchForTest } from './helpers/launch.js';
import type { BrowserController } from '../src/browser/index.js';

const config = loadConfig('qa.config.json');
const mkGuard = (origin = 'http://app.test', allowWrites = false) => new ActionGuard({ keywords: config.dangerousActions.keywords, allowMethods: config.dangerousActions.allowMethods, origin, allowWrites });

describe('ActionGuard', () => {
  const g = mkGuard();
  it('blocks destructive intent from visible text, accessible name, selector or URL', () => {
    expect(g.check({ kind: 'click', text: 'Delete account' }).allowed).toBe(false);
    expect(g.check({ kind: 'click', text: 'Create' }).allowed).toBe(false);
    expect(g.check({ kind: 'click', text: 'C r e a t e', href: 'http://app.test/#' }).allowed).toBe(false);
    expect(g.check({ kind: 'click', text: 'Save' }).allowed).toBe(false);
    expect(g.check({ kind: 'click', text: 'Update' }).allowed).toBe(false);
    expect(g.check({ kind: 'click', text: 'Remove' }).allowed).toBe(false);
    expect(g.check({ kind: 'click', text: 'Assign' }).allowed).toBe(false);
    expect(g.check({ kind: 'click', text: 'Publish' }).allowed).toBe(false);
    expect(g.check({ kind: 'click', text: 'Submit' }).allowed).toBe(false);
    expect(g.check({ kind: 'click', text: 'Lock Out' }).allowed).toBe(false);
    expect(g.check({ kind: 'click', text: 'Lockout' }).allowed).toBe(false);
    expect(g.check({ kind: 'click', text: 'Confirm' }).allowed).toBe(false);
    expect(g.check({ kind: 'click', text: 'Yes' }).allowed).toBe(false);
    expect(g.check({ kind: 'click', name: 'Buy now' }).allowed).toBe(false);
    expect(g.check({ kind: 'click', text: 'Pay' }).allowed).toBe(false);
    expect(g.check({ kind: 'click', text: 'Continue', selector: '#delete-account' }).allowed).toBe(false);
    expect(g.check({ kind: 'click', href: 'http://app.test/api/delete-account-link' }).allowed).toBe(false);
    expect(g.check({ kind: 'click', text: 'Log out' }).allowed).toBe(false);
    expect(g.check({ kind: 'submit', formAction: '/checkout' }).allowed).toBe(false);
  });
  it('does not over-block benign words', () => {
    expect(g.check({ kind: 'click', text: 'Display settings' }).allowed).toBe(true);
    expect(g.check({ kind: 'click', text: 'Deleted items' }).allowed).toBe(true);
    expect(g.check({ kind: 'click', text: 'Payment history' }).allowed).toBe(true);
    expect(g.check({ kind: 'click', text: 'View details' }).allowed).toBe(true);
  });
  it('blocks cross-origin and non-http navigation', () => {
    expect(g.check({ kind: 'navigate', url: 'https://evil.test/' }).allowed).toBe(false);
    expect(g.check({ kind: 'navigate', url: 'javascript:alert(1)' }).allowed).toBe(false);
    expect(g.check({ kind: 'navigate', url: 'http://app.test/about' }).allowed).toBe(true);
  });
  it('blocks payment-looking fields', () => {
    expect(g.check({ kind: 'fill', fieldName: 'card_number' }).allowed).toBe(false);
    expect(g.check({ kind: 'fill', fieldName: 'email' }).allowed).toBe(true);
  });
  it('network-level: write methods blocked unless explicitly allowed; logs every refusal', () => {
    const a = mkGuard();
    expect(a.checkRequest({ method: 'GET', url: 'http://app.test/x' })).toBe(true);
    expect(a.checkRequest({ method: 'POST', url: 'http://app.test/x' })).toBe(false);
    expect(a.checkRequest({ method: 'DELETE', url: 'http://app.test/x' })).toBe(false);
    expect(a.checkRequest({ method: 'GET', url: 'http://app.test/api/delete-account' })).toBe(false);
    expect(a.blockedCount).toBe(3);
    const w = mkGuard('http://app.test', true);
    expect(w.checkRequest({ method: 'POST', url: 'http://app.test/x' })).toBe(true);
    expect(w.checkRequest({ method: 'POST', url: 'http://app.test/api/purchases-history' })).toBe(true); // 'purchase' keyword needs a word match
    expect(w.checkRequest({ method: 'POST', url: 'http://app.test/api/purchase' })).toBe(false); // dangerous path stays blocked even with writes on
  });
});

describe('synthetic data', () => {
  it('generates valid and invalid values from field constraints', () => {
    const f = (o: object) => ({ selector: '#x', tag: 'input', type: 'text', name: '', label: '', placeholder: '', required: false, visible: true, disabled: false, ...o });
    expect(validValue(f({ type: 'email' }))).toBe('john@maildrop.cc');
    expect(Number(validValue(f({ type: 'number', min: '18', max: '120' })))).toBeGreaterThanOrEqual(18);
    expect(invalidValue(f({ type: 'number', min: '18' }))).toBe('17');
    expect(invalidValue(f({ type: 'email' }))).toBe('not-an-email');
    expect(invalidValue(f({ type: 'text' }))).toBeNull();
  });
});

describe('functional safety gate for discovered mutation controls', () => {
  let site: http.Server;
  let siteUrl: string;
  let c: BrowserController;
  const hits = { create: 0, spaced: 0, safe: 0 };

  beforeAll(async () => {
    site = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.pathname === '/clicked-create') { hits.create++; res.end('ok'); return; }
      if (u.pathname === '/clicked-spaced') { hits.spaced++; res.end('ok'); return; }
      if (u.pathname === '/clicked-safe') { hits.safe++; res.end('ok'); return; }
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><html lang="en"><head><title>Actions</title></head><body><main>
<h1>Actions</h1>
<a id="create" href="#" onclick="fetch('/clicked-create'); document.body.dataset.create='1'">Create</a>
<a id="spaced" href="#" onclick="fetch('/clicked-spaced'); document.body.dataset.spaced='1'"><span>C</span><span>r</span><span>e</span><span>a</span><span>t</span><span>e</span></a>
<a id="safe" href="#" onclick="fetch('/clicked-safe'); document.getElementById('panel').hidden=false">View details</a>
<section id="panel" hidden>Details</section>
</main></body></html>`);
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    c = await launchForTest({ baseUrl: siteUrl, blockExternal: true });
  });

  afterAll(async () => {
    await c?.close();
    site?.closeAllConnections?.();
    await new Promise((resolve) => site.close(() => resolve(undefined)));
  });

  it('discovers Create hash links but ActionGuard blocks them before any click is executed', async () => {
    const guard = mkGuard(siteUrl);
    c.setRequestGuard(guard.asRequestGuard());
    await c.navigate(siteUrl);
    await c.settle(100);
    const model = await buildPageModel(c);
    const profile = classifyPage(model);
    const plan = selectTests(profile, model, config);

    expect(model.links.find((l) => l.selector === '#create')).toMatchObject({ name: 'Create', visible: true });
    expect(model.links.find((l) => l.selector === '#spaced')?.name).toBe('Create'); // letter-spaced text is normalised by the page model
    expect(plan.buttons.map((b) => b.element.selector)).toEqual(expect.arrayContaining(['#create', '#spaced', '#safe']));

    const actions: { type: string; target: string; ok: boolean }[] = [];
    const results = await runFunctionalTests({
      controller: c,
      guard,
      pageUrl: c.page.url(),
      model,
      config,
      budget: new ActionBudget(30),
      plan,
      onAction: (a) => actions.push({ type: a.type, target: a.target, ok: a.ok }),
    });

    expect(hits.create).toBe(0);
    expect(hits.spaced).toBe(0);
    expect(hits.safe).toBe(1);
    expect(actions.some((a) => a.type === 'click' && /Create|C r e a t e/.test(a.target))).toBe(false);
    expect(results.filter((r) => r.check === 'guard').map((r) => r.element?.name)).toEqual(expect.arrayContaining(['Create', 'Create']));
    expect(results.find((r) => r.element?.name === 'View details')?.status).toBe('pass');
  });
});

describe('functional tests against the demo app', () => {
  let demo: DemoServer; let c: BrowserController; let guard: ActionGuard;
  beforeAll(async () => { demo = await startDemoApp(); c = await launchForTest({ baseUrl: demo.url, blockExternal: true }); });
  afterAll(async () => { await c?.close(); await demo?.close(); });

  async function run(path: string, cfg = config): Promise<FunctionalResult[]> {
    guard = mkGuard(demo.url);
    c.setRequestGuard(guard.asRequestGuard());
    await c.navigate(`${demo.url}${path}`); await c.settle(150);
    const model = await buildPageModel(c);
    return runFunctionalTests({ controller: c, guard, pageUrl: c.page.url(), model, config: cfg, budget: new ActionBudget(200) });
  }
  const failed = (r: FunctionalResult[]) => r.filter((x) => x.status === 'fail');

  it('NEVER performs destructive actions on the danger page', async () => {
    const r = await run('/danger');
    expect(demo.hits.deleteAccount).toBe(0);
    expect(demo.hits.purchase).toBe(0);
    expect(demo.hits.deleteLink).toBe(0);
    expect(r.filter((x) => x.status === 'skipped' && x.check === 'guard').length).toBeGreaterThanOrEqual(3);
    expect(failed(r)).toEqual([]);
    expect(guard.blockedCount).toBeGreaterThanOrEqual(3);
  });

  it('detects JS exceptions and failed requests triggered by buttons; a console.error line alone is not a finding', async () => {
    const r = await run('/errors');
    const checks = failed(r).map((x) => x.check);
    expect(checks).toEqual(expect.arrayContaining(['javascript-error', 'network-failure']));
    expect(checks).not.toContain('console-error');
    expect(failed(r).every((x) => x.basis === 'deterministic')).toBe(true);
    // the button does nothing visible and logs an error: unclear and no strong evidence, so it is recorded, not reported
    expect(r.filter((x) => x.check === 'console-error').map((x) => [x.status, x.basis])).toEqual([['inconclusive', null]]);
  });

  it('detects broken links (404/500), placeholder links; passes working ones', async () => {
    const r = await run('/links').then((x) => x.filter((y) => y.kind === 'link'));
    expect(failed(r).map((x) => x.actual).join('\n')).toMatch(/does-not-exist.*HTTP 404/);
    expect(failed(r).map((x) => x.actual).join('\n')).toMatch(/error-500.*HTTP 500/);
    expect(r.some((x) => x.check === 'destination' && x.status === 'anomaly')).toBe(true);
    expect(r.some((x) => x.check === 'navigation' && x.status === 'pass' && /legit/.test(x.actual))).toBe(true);
  });

  it('form tests: required not enforced + invalid input accepted; writes are blocked, never sent', async () => {
    const r = (await run('/forms')).filter((x) => x.kind === 'form');
    const f = failed(r).map((x) => x.check);
    expect(f).toEqual(expect.arrayContaining(['required-not-enforced', 'invalid-input-accepted']));
    expect(failed(r).every((x) => x.basis === 'generic_rule')).toBe(true);
    expect(demo.hits.subscribe).toBe(0);
  });

  it('LEGIT page: no functional failures (false-positive check)', async () => {
    const r = await run('/legit');
    expect(failed(r).map((x) => `${x.kind}/${x.check}: ${x.actual}`)).toEqual([]);
    const form = r.filter((x) => x.kind === 'form');
    expect(form.some((x) => x.check === 'empty-submission' && x.status === 'pass')).toBe(true);
    expect(form.some((x) => x.check === 'invalid-input' && x.status === 'pass')).toBe(true);
  });

  it('respects the action budget', async () => {
    guard = mkGuard(demo.url); c.setRequestGuard(guard.asRequestGuard());
    await c.navigate(`${demo.url}/legit`); await c.settle(100);
    const model = await buildPageModel(c);
    const budget = new ActionBudget(4);
    await runFunctionalTests({ controller: c, guard, pageUrl: c.page.url(), model, config, budget });
    expect(budget.used).toBeLessThanOrEqual(4);
    expect(budget.exhausted).toBe(true);
  });
});
