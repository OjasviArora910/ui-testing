import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDemoApp, type DemoServer } from '../demo-app/server.js';
import { runAxe, runKeyboardCheck } from '../src/accessibility/index.js';
import { buildPageModel } from '../src/discovery/pageModel.js';
import { collectRuleContext } from '../src/rules/context.js';
import { buildRegistry } from '../src/rules/index.js';
import { loadConfig } from '../src/shared/config.js';
import { launchForTest } from './helpers/launch.js';
import type { BrowserController } from '../src/browser/index.js';

const config = loadConfig('qa.config.json');

describe('accessibility against the demo app', () => {
  let demo: DemoServer; let c: BrowserController;
  beforeAll(async () => { demo = await startDemoApp(); c = await launchForTest({ baseUrl: demo.url }); });
  afterAll(async () => { await c?.close(); await demo?.close(); });

  async function analyze(path: string) {
    await c.navigate(`${demo.url}${path}`); await c.settle(150);
    const model = await buildPageModel(c);
    const axe = await runAxe(c);
    const keyboard = await runKeyboardCheck(c, model);
    const ctx = await collectRuleContext(c, { config, model, axe, keyboard });
    const res = await (await buildRegistry(config)).run(ctx);
    expect(res.errors).toEqual([]);
    return { axe, keyboard, findings: res.findings.filter((f) => f.category === 'accessibility') };
  }

  it('axe finds planted problems: image alt, contrast, button name, duplicate ids, invalid role, heading order', async () => {
    const { findings } = await analyze('/a11y');
    const ids = new Set(findings.map((f) => f.ruleId));
    for (const id of ['a11y.image-alt', 'a11y.color-contrast', 'a11y.button-name', 'a11y.duplicate-id', 'a11y.aria-roles', 'a11y.heading-order']) {
      expect(ids, `expected ${id}`).toContain(id);
    }
    const alt = findings.find((f) => f.ruleId === 'a11y.image-alt')!;
    expect(alt.classification).toBe('defect');
    expect(alt.basis).toBe('generic_rule');
    expect(alt.element?.selector).toContain('no-alt');
    expect(alt.expected).toMatch(/alternat(e|ive) text/i);
  });

  it('axe finds the missing form label on the forms page', async () => {
    const { findings } = await analyze('/forms');
    expect(findings.some((f) => f.ruleId === 'a11y.form-field-label' && /signup-email/.test(f.element?.selector ?? ''))).toBe(true);
  });

  it('keyboard check: unreachable fake button and missing focus indicator are anomalies (never defects)', async () => {
    const { keyboard, findings } = await analyze('/a11y');
    expect(keyboard.issues.some((i) => i.type === 'unreachable' && /fake-btn/.test(i.selector))).toBe(true);
    expect(keyboard.issues.some((i) => i.type === 'no-focus-indicator' && /no-outline/.test(i.selector))).toBe(true);
    const kb = findings.filter((f) => f.ruleId.startsWith('a11y.keyboard'));
    expect(kb.length).toBeGreaterThan(0);
    expect(kb.every((f) => f.classification === 'anomaly' && f.basis === null)).toBe(true);
  });

  it('FALSE POSITIVES: the legit page has no accessibility defects and no keyboard issues', async () => {
    const { findings, keyboard } = await analyze('/legit');
    expect(findings.filter((f) => f.classification === 'defect').map((f) => `${f.ruleId}: ${f.actual}`)).toEqual([]);
    expect(keyboard.issues.map((i) => `${i.type}: ${i.detail}`)).toEqual([]);
    expect(keyboard.tabStops).toBeGreaterThan(5);
  });
});
