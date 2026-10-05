import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDemoApp, type DemoServer } from '../demo-app/server.js';
import { collectRuleContext } from '../src/rules/context.js';
import { buildRegistry, RuleRegistry, type Rule } from '../src/rules/index.js';
import { loadConfig } from '../src/shared/config.js';
import type { Finding } from '../src/shared/types.js';
import { floatingKind } from '../src/geometry/legit.js';
import { ElementIndex } from '../src/geometry/primitives.js';
import { launchForTest } from './helpers/launch.js';
import type { BrowserController } from '../src/browser/index.js';

// target size belongs to the optional accessibility category, so it is enabled here to keep that rule covered
// ...and the diagnostics that are off by default (console warnings, slow requests, zero-size nodes) are switched on for the same reason
const config = loadConfig('qa.config.json', { accessibility: { enabled: true }, rules: { disabled: [] } });

describe('rule registry (plugin architecture)', () => {
  it('registers a new rule without touching any core code, and validates its findings', async () => {
    const reg = new RuleRegistry();
    const custom: Rule = {
      id: 'custom.demo', name: 'Demo', category: 'custom', severity: 'minor', description: 'd', basis: 'configured_rule',
      async evaluate(ctx) {
        return [{ ruleId: 'custom.demo', category: 'custom', severity: 'minor', classification: 'defect', basis: 'configured_rule', page: ctx.page, viewport: ctx.viewport.name, element: null, expected: 'e', actual: 'a', evidence: [] }];
      },
    };
    reg.register(custom);
    expect(() => reg.register(custom)).toThrow(/already registered/);
    const ctx = { page: 'http://x/', viewport: { name: 'd', width: 1, height: 1 }, config } as never;
    const r = await reg.run(ctx);
    expect(r.findings).toHaveLength(1);
    expect(r.rulesRun).toEqual(['custom.demo']);
  });

  it('REJECTS a defect without basis and reports it as a rule error, not a finding', async () => {
    const reg = new RuleRegistry();
    reg.register({
      id: 'bad.rule', name: 'Bad', category: 'x', severity: 'minor', description: '', basis: 'deterministic',
      async evaluate() { return [{ ruleId: 'bad.rule', category: 'x', severity: 'minor', classification: 'defect', basis: null, page: 'p', viewport: 'v', element: null, expected: 'e', actual: 'a', evidence: [] } as Finding]; },
    });
    const r = await reg.run({ page: 'p', viewport: { name: 'v', width: 1, height: 1 }, config } as never);
    expect(r.findings).toHaveLength(0);
    expect(r.errors[0]!.message).toMatch(/basis/);
  });

  it('isolates a throwing rule, honours disabled rules and severity overrides', async () => {
    const reg = new RuleRegistry();
    const f = (id: string): Rule => ({ id, name: id, category: 'x', severity: 'minor', description: '', basis: 'deterministic',
      async evaluate(ctx) { return [{ ruleId: id, category: 'x', severity: 'minor', classification: 'defect', basis: 'deterministic', page: ctx.page, viewport: 'v', element: null, expected: 'e', actual: 'a', evidence: [] }]; } });
    reg.register({ ...f('boom'), async evaluate() { throw new Error('kaboom'); } }).register(f('a')).register(f('b'));
    const cfg = loadConfig('x.json', { rules: { disabled: ['b'], severityOverrides: { a: 'critical' } } });
    const r = await reg.run({ page: 'p', viewport: { name: 'v', width: 1, height: 1 }, config: cfg } as never);
    expect(r.errors).toEqual([{ ruleId: 'boom', message: 'kaboom' }]);
    expect(r.findings.map((x) => [x.ruleId, x.severity])).toEqual([['a', 'critical']]);
    expect(r.rulesRun).toEqual(['boom', 'a']);
  });
});

describe('built-in rules against the demo app', () => {
  let demo: DemoServer; let c: BrowserController;
  beforeAll(async () => { demo = await startDemoApp(); c = await launchForTest({ baseUrl: demo.url, blockExternal: true }); });
  afterAll(async () => { await c?.close(); await demo?.close(); });

  async function analyze(pagePath: string, vp: { name: string; width: number; height: number }, cfg = config): Promise<Finding[]> {
    await c.setViewport(vp);
    await c.navigate(`${demo.url}${pagePath}`);
    await c.settle(150);
    const reg = await buildRegistry(cfg);
    const ctx = await collectRuleContext(c, { config: cfg, network: c.events.network, console: c.events.console });
    const res = await reg.run(ctx);
    expect(res.errors).toEqual([]);
    return res.findings;
  }
  const desktop = config.viewports[0]!; const tablet = config.viewports[1]!; const mobile = config.viewports[2]!;
  const ids = (fs: Finding[]) => fs.map((f) => f.ruleId);

  it('flags overlapping text and overlapping buttons as defects', async () => {
    const f = (await analyze('/overlap', desktop)).filter((x) => x.ruleId === 'geometry.overlap');
    expect(f.length).toBeGreaterThanOrEqual(2);
    expect(f.every((x) => x.classification === 'defect' && x.basis === 'generic_rule')).toBe(true);
    expect(f.some((x) => /Primary action|Secondary action/.test(x.actual))).toBe(true);
    expect(f.some((x) => /Overlapping text/.test(x.actual))).toBe(true);
  });

  it('flags clipped text but not intentional ellipsis', async () => {
    const f = (await analyze('/clipping', desktop)).filter((x) => x.ruleId === 'geometry.text-clipping');
    expect(f.map((x) => x.element?.selector)).toEqual(expect.arrayContaining(['#clipped', '#clipped-vertical']));
    const legit = (await analyze('/legit', desktop)).filter((x) => x.ruleId === 'geometry.text-clipping');
    expect(legit).toEqual([]);
  });

  it('flags horizontal overflow, container overflow and small targets', async () => {
    const f = await analyze('/overflow', desktop);
    expect(ids(f)).toEqual(expect.arrayContaining(['geometry.horizontal-overflow', 'geometry.container-overflow', 'geometry.small-target']));
    expect(f.find((x) => x.ruleId === 'geometry.horizontal-overflow')!.basis).toBe('deterministic');
    const small = f.filter((x) => x.ruleId === 'geometry.small-target').map((x) => x.element?.selector);
    expect(small).toEqual(expect.arrayContaining(['#tiny-link', '#tiny-btn']));
    expect(f.some((x) => x.ruleId === 'geometry.container-overflow' && x.element?.selector === '#inner')).toBe(true);
  });

  it('flags responsive table/image overflow only at narrow viewports', async () => {
    expect(ids(await analyze('/responsive', desktop))).not.toContain('responsive.table-overflow');
    const t = await analyze('/responsive', tablet);
    expect(ids(t)).toContain('responsive.table-overflow');
    const m = await analyze('/responsive', mobile);
    expect(ids(m)).toEqual(expect.arrayContaining(['responsive.table-overflow', 'responsive.image-overflow', 'geometry.horizontal-overflow']));
  });

  it('flags network failures and console errors, with deterministic basis', async () => {
    c.events.network.length = 0; c.events.console.length = 0;
    await c.setViewport(desktop);
    await c.navigate(`${demo.url}/errors`); await c.settle(200);
    await c.click({ css: '#log-error' }); await c.click({ css: '#throw-error' }); await c.settle(200);
    const reg = await buildRegistry(config);
    const ctx = await collectRuleContext(c, { config, network: c.events.network, console: c.events.console });
    const f = (await reg.run(ctx)).findings;
    expect(f.some((x) => x.ruleId === 'network.failed-request' && /\/api\/fail/.test(x.actual) && x.basis === 'deterministic')).toBe(true);
    expect(f.some((x) => x.ruleId === 'network.failed-request' && /missing\.png/.test(x.actual))).toBe(true);
    expect(f.some((x) => x.ruleId === 'console.error' && /Demo console error/.test(x.actual))).toBe(true);
    expect(f.some((x) => x.ruleId === 'console.error' && /Demo uncaught exception/.test(x.actual) && x.severity === 'major')).toBe(true);
    // "Failed to load resource" console noise is not duplicated
    expect(f.some((x) => x.ruleId === 'console.error' && /Failed to load resource/.test(x.actual))).toBe(false);
  });

  it('flags a slow API as an ANOMALY (latency is environment-dependent)', async () => {
    c.events.network.length = 0;
    await c.setViewport(desktop);
    await c.navigate(`${demo.url}/slow`); await c.page.waitForResponse((r) => r.url().includes('/api/slow'));
    await c.settle(100);
    const reg = await buildRegistry(config);
    const f = (await reg.run(await collectRuleContext(c, { config, network: c.events.network }))).findings.filter((x) => x.ruleId === 'network.slow-request');
    expect(f).toHaveLength(1);
    expect(f[0]!.classification).toBe('anomaly');
    expect(f[0]!.basis).toBeNull();
  });

  it('ignored endpoints do not produce network findings', async () => {
    const cfg = loadConfig('x.json', { ignoredEndpoints: ['/api/fail'] });
    const c2 = await launchForTest({ baseUrl: demo.url, ignoredEndpoints: cfg.ignoredEndpoints });
    await c2.navigate(`${demo.url}/errors`); await c2.settle(200);
    const reg = await buildRegistry(cfg);
    const f = (await reg.run(await collectRuleContext(c2, { config: cfg, network: c2.events.network, console: c2.events.console }))).findings;
    expect(f.some((x) => x.ruleId === 'network.failed-request' && /\/api\/fail/.test(x.actual))).toBe(false);
    expect(f.some((x) => x.ruleId === 'network.failed-request' && /missing\.png/.test(x.actual))).toBe(true);
    await c2.close();
  });

  it('FALSE POSITIVES: the legit page produces no defects at any viewport', async () => {
    for (const vp of [desktop, tablet, mobile]) {
      c.events.network.length = 0; c.events.console.length = 0;
      const f = await analyze('/legit', vp);
      const defects = f.filter((x) => x.classification === 'defect');
      expect(defects.map((d) => `${vp.name}: ${d.ruleId} ${d.actual}`)).toEqual([]);
    }
  });

  it('recognises tooltip, dropdown, popover, badge and modal as legitimate overlap', async () => {
    await c.setViewport(desktop); await c.navigate(`${demo.url}/legit`);
    const els = await c.allElements(); const idx = new ElementIndex(els);
    const kind = (sel: string) => floatingKind(els.find((e) => e.selector === sel)!, idx);
    expect(kind('#tip1')).toBe('tooltip');
    expect(kind('#menu')).toBe('dropdown');
    expect(kind('#pop')).toBe('popover');
    expect(kind('#modal-open')).toBe('modal');
    expect(els.find((e) => e.className.includes('badge'))).toBeTruthy();
    expect(floatingKind(els.find((e) => e.className.includes('badge'))!, idx)).toBe('badge');
  });

  it('configured (declarative) rules produce configured_rule defects with no core change', async () => {
    const cfg = loadConfig('x.json', { rules: { custom: [
      { id: 'cfg.no-lorem', name: 'No lorem', type: 'text-absent', text: 'Legitimate UI patterns', pages: ['/legit'] },
      { id: 'cfg.needs-cta', name: 'Needs CTA', type: 'selector-exists', selector: '#buy-cta', pages: ['/legit'] },
      { id: 'cfg.other-page', name: 'Other page only', type: 'selector-exists', selector: '#nope', pages: ['/overlap'] },
    ] } });
    const f = (await analyze('/legit', desktop, cfg)).filter((x) => x.ruleId.startsWith('cfg.'));
    expect(f.map((x) => x.ruleId).sort()).toEqual(['cfg.needs-cta', 'cfg.no-lorem']);
    expect(f.every((x) => x.basis === 'configured_rule' && x.classification === 'defect')).toBe(true);
  });
});
