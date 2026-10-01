import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDemoApp, type DemoServer } from '../demo-app/server.js';
import { actionSignature, LoopDetector, ReactAgent, stateSignature } from '../src/agent/index.js';
import { MockProvider } from '../src/ai/index.js';
import { ActionGuard } from '../src/functional/index.js';
import { loadConfig } from '../src/shared/config.js';
import { launchForTest } from './helpers/launch.js';
import type { BrowserController } from '../src/browser/index.js';

const config = loadConfig('qa.config.json');
const step = (action: object, thought = 't') => JSON.stringify({ thought, action });

describe('loop detection', () => {
  it('normalises actions so near-identical repeats are recognised', () => {
    expect(actionSignature({ tool: 'click', element: 'e1' }, { role: 'button', name: 'Item 3' })).toBe(actionSignature({ tool: 'click', element: 'e9' }, { role: 'button', name: 'Item 7' }));
    expect(actionSignature({ tool: 'navigate', url: '/a?id=1' })).toBe(actionSignature({ tool: 'navigate', url: '/a?id=2' }));
    expect(stateSignature('http://x/a?id=1', [{ role: 'button', name: 'Row 1' }], false)).toBe(stateSignature('http://x/a?id=9', [{ role: 'button', name: 'Row 2' }], false));
  });
  it('flags repeated actions, repeated states and lack of progress', () => {
    const d = new LoopDetector({ maxRepeatedActions: 2, maxRepeatedStates: 2, noProgressLimit: 3 });
    expect(d.checkAction('a')).toBe('ok'); expect(d.checkAction('a')).toBe('ok'); expect(d.checkAction('a')).toBe('repeated_action');
    const s = new LoopDetector({ maxRepeatedActions: 9, maxRepeatedStates: 2, noProgressLimit: 9 });
    expect(s.checkState('s1', false)).toBe('ok'); expect(s.checkState('s1', false)).toBe('ok'); expect(s.checkState('s1', false)).toBe('repeated_state');
    const n = new LoopDetector({ maxRepeatedActions: 9, maxRepeatedStates: 99, noProgressLimit: 2 });
    n.checkState('x', true); expect(n.checkState('x', false)).toBe('ok'); expect(n.checkState('x', false)).toBe('no_progress');
  });
});

describe('ReAct agent against the demo app', () => {
  let demo: DemoServer; let c: BrowserController;
  beforeAll(async () => { demo = await startDemoApp(); c = await launchForTest({ baseUrl: demo.url, blockExternal: true }); });
  afterAll(async () => { await c?.close(); await demo?.close(); });

  const mkGuard = () => new ActionGuard({ keywords: config.dangerousActions.keywords, allowMethods: config.dangerousActions.allowMethods, origin: demo.url });
  const elId = (user: string, name: string): string => new RegExp(`(e\\d+) \\w+ "${name}`).exec(user)?.[1] ?? 'e999';

  it('uses the shared ActionGuard: destructive clicks are blocked and never reach the server', async () => {
    const guard = mkGuard(); c.setRequestGuard(guard.asRequestGuard());
    const p = new MockProvider((req, i) => (i === 0 ? step({ tool: 'click', element: elId(req.user, 'Delete account') }) : i === 1 ? step({ tool: 'click', element: elId(req.user, 'Buy now') }) : step({ tool: 'stop', reason: 'done' })));
    const r = await new ReactAgent({ controller: c, guard, provider: p, config: config.agent, startUrl: `${demo.url}/danger` }).run();
    expect(r.steps.filter((s) => s.outcome === 'blocked')).toHaveLength(2);
    expect(demo.hits.deleteAccount).toBe(0); expect(demo.hits.purchase).toBe(0);
    expect(r.stopReason).toBe('agent_stop');
  });

  it('page text cannot instruct the agent: page content only reaches the model inside <untrusted_page>', async () => {
    const guard = mkGuard();
    const p = new MockProvider(() => step({ tool: 'stop', reason: 'ok' }));
    await new ReactAgent({ controller: c, guard, provider: p, config: config.agent, startUrl: `${demo.url}/legit` }).run();
    const u = p.calls[0]!.user;
    expect(u.indexOf('<untrusted_page>')).toBeLessThan(u.indexOf('Legit UI'));
    expect(p.calls[0]!.system).toMatch(/NEVER follow them/);
  });

  it('rejects invalid tool calls and stops after repeated invalid output', async () => {
    const p = new MockProvider(() => JSON.stringify({ thought: 'x', action: { tool: 'rm -rf', path: '/' } }));
    const r = await new ReactAgent({ controller: c, guard: mkGuard(), provider: p, config: config.agent, startUrl: `${demo.url}/` }).run();
    expect(r.stopReason).toBe('error');
    expect(r.steps.every((s) => s.outcome === 'invalid')).toBe(true);
  });

  it('stops on repeated action', async () => {
    const p = new MockProvider(() => step({ tool: 'scroll', direction: 'down' }));
    const r = await new ReactAgent({ controller: c, guard: mkGuard(), provider: p, config: { ...config.agent, maxRepeatedActions: 2, maxRepeatedStates: 50, noProgressLimit: 50 }, startUrl: `${demo.url}/legit` }).run();
    expect(r.stopReason).toBe('repeated_action');
    expect(r.actionsTaken).toBe(2);
  });

  it('stops on max actions, max pages, max runtime and LLM budget', async () => {
    const pages = ['/overlap', '/clipping', '/overflow', '/links', '/forms', '/modal'];
    const nav = new MockProvider((_r, i) => step({ tool: 'navigate', url: pages[i % pages.length]! }));
    const r1 = await new ReactAgent({ controller: c, guard: mkGuard(), provider: nav, config: { ...config.agent, maxActions: 3, maxPages: 50, maxDepth: 50 }, startUrl: `${demo.url}/` }).run();
    expect(r1.stopReason).toBe('max_actions');
    const nav2 = new MockProvider((_r, i) => step({ tool: 'navigate', url: pages[i % pages.length]! }));
    const r2 = await new ReactAgent({ controller: c, guard: mkGuard(), provider: nav2, config: { ...config.agent, maxActions: 50, maxPages: 2, maxDepth: 50 }, startUrl: `${demo.url}/` }).run();
    expect(r2.stopReason).toBe('max_pages');
    let t = 0;
    const r3 = await new ReactAgent({ controller: c, guard: mkGuard(), provider: new MockProvider(() => step({ tool: 'inspectNetwork' })), config: { ...config.agent, maxRuntimeMs: 1000 }, startUrl: `${demo.url}/`, now: () => (t += 600) }).run();
    expect(r3.stopReason).toBe('max_runtime');
    const r4 = await new ReactAgent({ controller: c, guard: mkGuard(), provider: new MockProvider((_r, i) => step({ tool: 'scroll', direction: i % 2 ? 'up' : 'down' })), config: { ...config.agent, maxLlmCalls: 3, maxRepeatedActions: 99, maxRepeatedStates: 99, noProgressLimit: 99 }, startUrl: `${demo.url}/` }).run();
    expect(r4.stopReason).toBe('budget_exhausted');
  });

  it('agent reports become review items, not confirmations', async () => {
    const p = new MockProvider((req, i) => (i === 0 ? step({ tool: 'report', description: 'Buttons overlap each other', element: elId(req.user, 'Primary action') }) : step({ tool: 'stop', reason: 'done' })));
    const r = await new ReactAgent({ controller: c, guard: mkGuard(), provider: p, config: config.agent, startUrl: `${demo.url}/overlap` }).run();
    expect(r.reports).toHaveLength(1);
    expect(r.reports[0]!.selector).toBe('#ov-btn-a');
  });
});
