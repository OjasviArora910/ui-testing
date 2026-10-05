import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from '../src/api/index.js';
import { createPlatform, type Platform } from '../src/orchestrator/index.js';

/**
 * Regression: "Stop" used to be noticed only between pages, so a run in the middle of a slow page load or a long series
 * of clicks kept going for minutes. A stop request must end the run promptly and still leave a usable partial report.
 */
describe('stopping a run', () => {
  let site: http.Server; let siteUrl: string; let platform: Platform; let api: { server: http.Server; url: string };
  const hanging: http.ServerResponse[] = [];

  beforeAll(async () => {
    // A page whose image never finishes: every visit sits in a long navigation wait, the worst case for stopping.
    const buttons = Array.from({ length: 12 }, (_, i) => `<button type="button" onclick="document.getElementById('o').textContent='clicked ${i}'">Action ${i}</button>`).join(' ');
    site = http.createServer((req, res) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      if (p === '/never.png') { hanging.push(res); return; }
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><html lang="en"><head><title>Slow</title></head><body><main><h1>Slow page</h1><p id="o">idle</p>${buttons}<img src="/never.png" alt="never loads"><a href="/two">Two</a> <a href="/three">Three</a></main></body></html>`);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-stop-'));
    platform = createPlatform({
      configOverrides: { paths: { dataDir: path.join(dir, 'data'), baselineDir: path.join(dir, 'baselines') }, maxPages: 5, timeouts: { navigationMs: 20000, actionMs: 8000, runMs: 900000 } },
      provider: null, trace: false, env: {},
    });
    api = await startApi(platform, { host: '127.0.0.1', port: 0 });
  }, 60_000);
  afterAll(async () => {
    await platform?.orchestrator.shutdown(); api?.server.close();
    for (const r of hanging) r.destroy();
    site.closeAllConnections?.(); await new Promise((r) => site.close(() => r(undefined)));
  });

  const post = (p: string, body: unknown) => fetch(`${api.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('takes effect within seconds, even in the middle of a 20s page load, and keeps a partial report', async () => {
    const { runId } = await (await post('/api/runs', { url: siteUrl, mode: 'deterministic' })).json() as { runId: string };
    await new Promise((r) => setTimeout(r, 4000)); // the run is now waiting for a page that will not finish loading
    const t0 = Date.now();
    const res = await post(`/api/runs/${runId}/stop`, {});
    expect(await res.json()).toEqual({ stopped: true });
    const run = await platform.orchestrator.whenDone(runId);
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(run.status).toBe('ABORTED');
    expect(run.abortReason).toMatch(/stopped by user/);
    expect(platform.orchestrator.isActive(runId)).toBe(false);
    expect(platform.orchestrator.reportPath(runId, 'html')).not.toBeNull();
    // a new run can start straight away
    const next = await post('/api/runs', { url: siteUrl, mode: 'deterministic' });
    expect(next.status).toBe(202);
    const second = (await next.json() as { runId: string }).runId;
    await post(`/api/runs/${second}/stop`, {});
    await platform.orchestrator.whenDone(second);
  }, 60_000);

  it('a run left "running" by a server restart can also be stopped', async () => {
    const db = platform.orchestrator.db;
    const run = db.createRun({ url: siteUrl, mode: 'deterministic', request: { url: siteUrl, mode: 'deterministic', authSource: 'none' }, config: platform.config });
    db.setStatus(run.id, 'TESTING'); // what the database looks like after the process died mid-run
    expect(platform.orchestrator.isActive(run.id)).toBe(false);
    expect(await (await post(`/api/runs/${run.id}/stop`, {})).json()).toEqual({ stopped: true });
    const after = db.getRun(run.id)!;
    expect(after.status).toBe('ABORTED');
    expect(after.abortReason).toMatch(/no longer executing/);
    // stopping something that is already finished reports that nothing was stopped
    expect(await (await post(`/api/runs/${run.id}/stop`, {})).json()).toEqual({ stopped: false });
  });
});

/**
 * Stopping keeps the work that was finished: results are saved element by element, so a run stopped half-way shows exactly
 * what was tested, passed and found before the stop, and nothing that was not finished is counted as passed.
 */
describe('a stopped run keeps everything completed before the stop', () => {
  let site: http.Server; let siteUrl: string; let platform: Platform; let api: { server: http.Server; url: string };

  beforeAll(async () => {
    // Page one: a button whose request fails (a real bug, found early), a broken image, then many slow working buttons.
    const slow = Array.from({ length: 40 }, (_, i) => `<button type="button" class="slow">Step ${i + 1}</button>`).join(' ');
    const first = `<!doctype html><html lang="en"><head><title>One</title></head><body><main><h1>Page one</h1><p id="o">idle</p>
<button type="button" id="broken">Export report</button> <img src="/missing.png" alt="chart" width="80" height="40"> ${slow}
<p><a href="/two">Two</a> <a href="/three">Three</a></p></main>
<script>document.getElementById('broken').onclick = () => fetch('/api/fail').catch(() => {});
document.querySelectorAll('.slow').forEach((b) => b.onclick = () => { setTimeout(() => { document.getElementById('o').textContent = 'did ' + b.textContent; }, 300); });</script></body></html>`;
    const other = (n: string): string => `<!doctype html><html lang="en"><head><title>${n}</title></head><body><main><h1>Page ${n}</h1><button type="button" onclick="document.getElementById('o').textContent='ok'">Go</button><p id="o">idle</p><a href="/">Home</a></main></body></html>`;
    site = http.createServer((req, res) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      if (p === '/api/fail') { res.statusCode = 500; return void res.end('{}'); }
      if (p === '/missing.png') { res.statusCode = 404; return void res.end(); }
      res.setHeader('content-type', 'text/html');
      res.end(p === '/two' ? other('two') : p === '/three' ? other('three') : first);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-stop2-'));
    platform = createPlatform({
      configOverrides: { paths: { dataDir: path.join(dir, 'data'), baselineDir: path.join(dir, 'baselines') }, viewports: [{ name: 'desktop', width: 1280, height: 800 }] },
      provider: null, trace: false, env: {},
    });
    api = await startApi(platform, { host: '127.0.0.1', port: 0 });
  }, 60_000);
  afterAll(async () => { await platform?.orchestrator.shutdown(); api?.server.close(); site.closeAllConnections?.(); await new Promise((r) => site.close(() => r(undefined))); });

  const post = (p: string, body: unknown) => fetch(`${api.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const get = async <T>(p: string): Promise<T> => (await fetch(`${api.url}${p}`)).json() as Promise<T>;
  interface RunJson { id: string; status: string; state: string; note: string | null; verdict: string | null; counts: { pagesCrawled: number; pagesTested: number; elementsTested: number; passed: number; bugs: number; needsReview: number; notTestedPages: number; notTestedElements: number } }

  it('progress is saved while the run is going, and survives a stop in the middle of a page', async () => {
    const { runId } = await (await post('/api/runs', { url: siteUrl, mode: 'deterministic' })).json() as { runId: string };
    // wait until some elements of page one have been tested (it has 41 buttons, so the page is far from finished)
    const db = platform.orchestrator.db;
    for (let i = 0; i < 300 && db.listTestResults(runId).length < 6; i++) await new Promise((r) => setTimeout(r, 200));
    const during = await get<RunJson>(`/api/runs/${runId}`);
    expect(during.state).toBe('RUNNING');
    expect(during.counts.elementsTested).toBeGreaterThanOrEqual(6); // visible before the page or the run is done
    expect(during.counts.bugs).toBeGreaterThanOrEqual(1);
    const findingsDuring = db.listFindings(runId).length;
    expect(findingsDuring).toBeGreaterThanOrEqual(2); // broken image (page check) + failing button (interaction)

    expect(await (await post(`/api/runs/${runId}/stop`, {})).json()).toEqual({ stopped: true });
    await platform.orchestrator.whenDone(runId);

    const run = await get<RunJson>(`/api/runs/${runId}`);
    expect(run).toMatchObject({ status: 'ABORTED', state: 'ABORTED' });
    expect(run.note).toBe('Stopped by user. Results shown for work completed before stopping.');
    // nothing was erased or reset
    expect(run.counts.pagesCrawled).toBe(3);
    expect(run.counts.elementsTested).toBeGreaterThanOrEqual(during.counts.elementsTested);
    expect(run.counts.bugs).toBeGreaterThanOrEqual(1);
    expect(db.listFindings(runId).length).toBeGreaterThanOrEqual(findingsDuring);
    // unfinished work is not counted as passed or as a bug: it is "not tested"
    expect(run.counts.elementsTested).toBeLessThan(41);
    expect(run.counts.passed).toBeLessThanOrEqual(run.counts.elementsTested);
    expect(run.counts.pagesTested).toBe(0); // page one was interrupted, pages two and three never started
    expect(run.counts.notTestedPages).toBe(3);
    expect(run.counts.notTestedElements).toBeGreaterThan(0);
    const results = db.listTestResults(runId);
    expect(results.every((r) => new URL(r.page).pathname === '/')).toBe(true);
    expect(results.some((r) => /Target closed|browser has been closed/i.test(r.actual))).toBe(false); // the interrupted click is not a result

    // findings, their evidence and the activity stay available afterwards
    const { findings } = await get<{ findings: { ruleId: string; resultClass: string; evidence: { url: string }[] }[] }>(`/api/runs/${runId}/findings`);
    const bug = findings.find((f) => f.ruleId === 'functional.button' && f.resultClass === 'BUG')!;
    expect(bug.evidence.length).toBeGreaterThan(0);
    expect((await fetch(`${api.url}${bug.evidence[0]!.url}`)).status).toBe(200);
    expect(findings.some((f) => f.ruleId === 'image.broken')).toBe(true);
    expect((await get<{ actions: unknown[] }>(`/api/runs/${runId}/actions`)).actions.length).toBeGreaterThan(0);
    expect((await fetch(`${api.url}/api/runs/${runId}/report.html`)).status).toBe(200);
    // the run stays in the history
    const { runs } = await get<{ runs: RunJson[] }>('/api/runs');
    expect(runs.find((r) => r.id === runId)).toMatchObject({ state: 'ABORTED' });
    // accessibility is not part of a normal run
    expect(findings.some((f) => f.ruleId.startsWith('a11y.') || f.ruleId === 'geometry.small-target')).toBe(false);
  }, 180_000);

  it('a normal run to completion: working elements are silent, real problems are reported once, no accessibility', async () => {
    const { runId } = await (await post('/api/runs', { url: `${siteUrl}/two`, mode: 'deterministic', overrides: { maxPages: 2, maxDepth: 1 } })).json() as { runId: string };
    await platform.orchestrator.whenDone(runId);
    const run = await get<RunJson>(`/api/runs/${runId}`);
    expect(run).toMatchObject({ status: 'COMPLETED', state: 'COMPLETED', note: null });
    expect(run.counts.pagesTested).toBe(2); // /two and the home page it links to
    expect(run.counts.notTestedPages).toBe(0);
    const db = platform.orchestrator.db;
    const results = db.listTestResults(runId);
    // every one of the 41 buttons on the home page was tested, plus the one on /two
    expect(results.filter((r) => r.kind === 'button').length).toBe(42);
    expect(run.counts.passed).toBeGreaterThanOrEqual(41);
    const findings = db.listFindings(runId);
    // the 41 working controls produced no finding at all
    expect(findings.filter((f) => f.ruleId === 'functional.button').map((f) => f.element?.name)).toEqual(['Export report']);
    expect(findings.some((f) => f.ruleId === 'image.broken')).toBe(true);
    expect(findings.some((f) => f.track === 'accessibility')).toBe(false);
    expect(run.counts.bugs).toBeGreaterThanOrEqual(2);
  }, 300_000);
});
