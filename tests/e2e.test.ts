import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_JWT, startDemoApp, type DemoServer } from '../demo-app/server.js';
import { GROUND_TRUTH } from '../demo-app/pages.js';
import { startApi } from '../src/api/index.js';
import { MockProvider } from '../src/ai/index.js';
import { createPlatform, type Platform } from '../src/orchestrator/index.js';

/**
 * Full pipeline through the API: start -> crawl -> test -> analyze (mock AI) -> review -> reports, against the demo app.
 */
describe('end-to-end against the demo app', () => {
  let demo: DemoServer; let platform: Platform; let api: { server: http.Server; url: string }; let dir: string; let authFile: string;

  beforeAll(async () => {
    demo = await startDemoApp(0, { slowMs: 3500 });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-e2e-'));
    authFile = path.join(dir, 'qa.auth.json');
    fs.writeFileSync(authFile, JSON.stringify({ profiles: { demo: { location: 'cookie', key: 'token', source: { env: 'QA_JWT_DEMO' } } } }));
    // AI: deterministic mock that always flags exactly one finding as a likely false positive.
    const provider = new MockProvider((req) => {
      const ids = [...req.user.matchAll(/"findingId": "(fnd_[a-f0-9]+)"/g)].map((m) => m[1]!);
      return JSON.stringify({ analyses: ids.map((id, i) => ({ findingId: id, explanation: 'Mock explanation.', likelyRootCause: 'mock', priority: (i % 5) + 1, confidence: 0.5, likelyFalsePositive: i === 0, correlatedWith: [], suggestedChecks: [] })) });
    });
    platform = createPlatform({
      configOverrides: { paths: { dataDir: path.join(dir, 'data'), baselineDir: path.join(dir, 'baselines') }, maxPages: 20, maxDepth: 1, maxActions: 400, ai: { maxCalls: 4 }, accessibility: { enabled: true }, rules: { disabled: [] } }, // accessibility is opt-in; enabled here so its pipeline stays covered
      provider, trace: false, env: { QA_AUTH_PROFILES: authFile, QA_JWT_DEMO: DEMO_JWT },
    });
    api = await startApi(platform, { host: '127.0.0.1', port: 0 });
  }, 60_000);
  afterAll(async () => { await platform?.orchestrator.shutdown(); api?.server.close(); await demo?.close(); });

  const post = (p: string, body: unknown) => fetch(`${api.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('API refuses raw credentials and cross-origin writes', async () => {
    const r = await post('/api/runs', { url: demo.url, jwt: DEMO_JWT });
    expect(r.status).toBe(400);
    expect(await r.text()).not.toContain(DEMO_JWT);
    const x = await fetch(`${api.url}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.test' }, body: JSON.stringify({ url: demo.url }) });
    expect(x.status).toBe(403);
    const cfg = await (await fetch(`${api.url}/api/config`)).json() as { authProfiles: { name: string }[] };
    expect(cfg.authProfiles).toEqual([{ name: 'demo', location: 'cookie' }]);
    expect(JSON.stringify(cfg)).not.toContain(DEMO_JWT);
  });

  it('runs the whole pipeline, finds the planted defects, and stays quiet on legit UI', async () => {
    // Token supplied together with the URL (the main login path): used in memory only.
    const r = await post('/api/runs', { url: demo.url, mode: 'ai_assisted', auth: { token: DEMO_JWT, location: 'cookie', key: 'token' } });
    expect(r.status).toBe(202);
    const { runId } = await r.json() as { runId: string };
    expect((await post('/api/runs', { url: demo.url })).status).toBe(409); // one run at a time

    const run = await platform.orchestrator.whenDone(runId);
    expect(run.status).toBe('COMPLETED');
    expect(run.verdict).toBe('FAILED');
    expect(JSON.stringify(run.request)).not.toContain(DEMO_JWT);
    expect(run.request).toMatchObject({ authSource: 'token', authLocation: 'cookie' });
    const runApi = await (await fetch(`${api.url}/api/runs/${runId}`)).text();
    expect(runApi).not.toContain(DEMO_JWT);

    const findings = platform.orchestrator.db.listFindings(runId);
    const on = (p: string) => findings.filter((f) => new URL(f.page).pathname === p);
    for (const [page, rules] of Object.entries(GROUND_TRUTH)) {
      for (const rule of rules) expect(on(page).map((f) => f.ruleId), `${rule} on ${page}`).toContain(rule);
    }
    // false positives: no engine-confirmed defect on /legit
    expect(on('/legit').filter((f) => f.classification === 'defect').map((f) => `${f.ruleId}: ${f.actual}`)).toEqual([]);
    // safety: nothing destructive happened
    expect(demo.hits).toEqual({ deleteAccount: 0, purchase: 0, subscribe: 0, deleteLink: 0, login: 0 });
    // auth profile worked (cookie injected): the account API answered 200 at least once
    expect(demo.requests.some((q) => q.path === '/api/me')).toBe(true);

    // every defect has a basis; evidence is hashed and verifiable
    expect(findings.every((f) => f.classification !== 'defect' || f.basis)).toBe(true);
    const ev = platform.orchestrator.db.listEvidence(runId);
    expect(ev.length).toBeGreaterThan(5);
    expect(ev.slice(0, 5).every((e) => platform.orchestrator.opts.evidence.verify(e))).toBe(true);
    expect(findings.some((f) => f.evidence.length > 0)).toBe(true);

    // AI ran but could not change any finding's classification
    const analyses = platform.orchestrator.db.listAnalyses(runId);
    expect(analyses.some((a) => a.status === 'accepted')).toBe(true);
    const after = platform.orchestrator.db.listFindings(runId);
    expect(after.map((f) => [f.id, f.classification, f.basis])).toEqual(findings.map((f) => [f.id, f.classification, f.basis]));
    expect(after.some((f) => f.reviewState === 'confirmed')).toBe(false);

    // no secret anywhere on disk (db, evidence text, reports)
    const scan = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) scan(p); else if (!/\.(png|zip)$/.test(e.name)) expect(fs.readFileSync(p).toString('latin1').includes(DEMO_JWT), p).toBe(false);
      }
    };
    scan(path.join(dir, 'data'));

    // reports via API
    for (const k of ['html', 'json', 'xml']) expect((await fetch(`${api.url}/api/runs/${runId}/report.${k}`)).status).toBe(200);

    // human review: confirm an anomaly -> persisted; verdict recomputed
    const queue = (await (await fetch(`${api.url}/api/runs/${runId}/review-queue`)).json() as { queue: { id: string; evidence: { url: string }[] }[] }).queue;
    expect(queue.length).toBeGreaterThan(0);
    const d = await post(`/api/findings/${queue[0]!.id}/decision`, { decision: 'CONFIRM_BUG', note: 'seen it' });
    expect(d.status).toBe(200);
    expect(platform.orchestrator.db.getFindingView(queue[0]!.id)!.reviewState).toBe('confirmed');
    expect((await post(`/api/findings/${queue[0]!.id}/decision`, { decision: 'MAYBE' })).status).toBe(400);
  }, 600_000);

  it('a stopped run keeps partial results and a report', async () => {
    const r = await post('/api/runs', { url: demo.url, mode: 'deterministic' });
    const { runId } = await r.json() as { runId: string };
    await new Promise((res) => setTimeout(res, 2500));
    expect((await post(`/api/runs/${runId}/stop`, {})).status).toBe(200);
    const run = await platform.orchestrator.whenDone(runId);
    expect(run.status).toBe('ABORTED');
    expect(run.summary?.incomplete).toBe(true);
    expect(platform.orchestrator.reportPath(runId, 'html')).not.toBeNull();
    // the persisted cursor allows resuming
    expect(run.state?.phase).toBeDefined();
  }, 120_000);

  it('a run that used a one-time token cannot be resumed without supplying the token again', async () => {
    const auth = { token: DEMO_JWT, location: 'cookie', key: 'token' };
    const { runId } = await (await post('/api/runs', { url: demo.url, mode: 'deterministic', auth })).json() as { runId: string };
    await new Promise((res) => setTimeout(res, 2000));
    await post(`/api/runs/${runId}/stop`, {});
    await platform.orchestrator.whenDone(runId);
    platform.orchestrator.db.setStatus(runId, 'TESTING'); // simulate a crash mid-run
    const without = await post(`/api/runs/${runId}/resume`, {});
    expect(without.status).toBe(409);
    expect(await without.text()).toMatch(/never stored/);
    expect((await post(`/api/runs/${runId}/resume`, { auth })).status).toBe(202);
    await platform.orchestrator.whenDone(runId);
  }, 600_000); // waits for a complete resumed run over the whole demo app
});
