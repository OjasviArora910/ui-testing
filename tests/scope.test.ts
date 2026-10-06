import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from '../src/api/index.js';
import { createPlatform, type Platform } from '../src/orchestrator/index.js';

/**
 * Test scope. "This page only" tests exactly the URL that was entered: no crawl, no queue, no other page, URL untouched.
 * The default ("whole site") keeps crawling as before.
 */
describe('test scope: this page only', () => {
  let site: http.Server; let siteUrl: string; let platform: Platform; let api: { server: http.Server; url: string };
  const requested: string[] = [];

  beforeAll(async () => {
    const slow = Array.from({ length: 30 }, (_, i) => `<button type="button" class="slow">Step ${i + 1}</button>`).join(' ');
    const html = (title: string, body: string): string => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main>${body}</main></body></html>`;
    site = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      requested.push(u.pathname + u.search);
      res.setHeader('content-type', 'text/html');
      if (u.pathname === '/app/' || u.pathname === '/app') { // whole-site mode normalises the trailing slash away
        return void res.end(html('Sales', `<h1>Sales</h1><p id="o">idle</p>
<button type="button" id="refresh">Refresh data</button> <button type="button" id="broken">Export report</button>
<label for="q">Quantity</label> <input id="q" type="number" min="1">
<p><a href="/other">Other page</a> <a href="/missing">Old report</a></p>
<script>document.getElementById('refresh').onclick = () => { document.getElementById('o').textContent = 'refreshed'; };
document.getElementById('broken').onclick = () => fetch('/api/fail').catch(() => {});</script>`));
      }
      if (u.pathname === '/other') return void res.end(html('Other', '<h1>Other</h1><button type="button" onclick="document.title=\'x\'">Only on the other page</button><a href="/third">Third</a>'));
      if (u.pathname === '/third') return void res.end(html('Third', '<h1>Third</h1>'));
      if (u.pathname === '/busy') return void res.end(html('Busy', `<h1>Busy</h1><p id="o">idle</p>${slow}<script>document.querySelectorAll('.slow').forEach((b) => b.onclick = () => setTimeout(() => { document.getElementById('o').textContent = 'did ' + b.textContent; }, 300));</script>`));
      if (u.pathname === '/private') { res.statusCode = 302; res.setHeader('location', '/login'); return void res.end(); }
      if (u.pathname === '/login') return void res.end(html('Sign in', '<h1>Sign in</h1><form action="/login" method="post"><label for="u">User</label><input id="u" name="u" required><label for="p">Password</label><input id="p" name="p" type="password" required><button type="submit">Login</button></form>'));
      if (u.pathname === '/api/fail') { res.statusCode = 500; res.setHeader('content-type', 'application/json'); return void res.end('{}'); }
      res.statusCode = 404; res.end(html('Not found', '<h1>404 Not Found</h1>'));
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-scope-'));
    platform = createPlatform({
      configOverrides: { paths: { dataDir: path.join(dir, 'data'), baselineDir: path.join(dir, 'baselines') }, viewports: [{ name: 'desktop', width: 1280, height: 800 }] },
      provider: null, trace: false, env: {},
    });
    api = await startApi(platform, { host: '127.0.0.1', port: 0 });
  }, 60_000);
  afterAll(async () => { await platform?.orchestrator.shutdown(); api?.server.close(); site.closeAllConnections?.(); await new Promise((r) => site.close(() => r(undefined))); });

  const post = (p: string, body: unknown) => fetch(`${api.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  interface RunJson { status: string; state: string; scope: string; error: string | null; note: string | null; counts: { pagesCrawled: number; pagesTested: number; elementsTested: number; passed: number; bugs: number } }
  const getRun = async (id: string): Promise<RunJson> => (await fetch(`${api.url}/api/runs/${id}`)).json() as Promise<RunJson>;
  const finish = async (body: Record<string, unknown>) => {
    const { runId } = await (await post('/api/runs', { mode: 'deterministic', ...body })).json() as { runId: string };
    await platform.orchestrator.whenDone(runId);
    return { runId, run: await getRun(runId), db: platform.orchestrator.db };
  };

  it('tests only the exact URL: nothing else is crawled, queued or tested, and the URL is not rewritten', async () => {
    // a URL that whole-site mode would rewrite: trailing slash, unsorted query, a tracking parameter, a hash route
    const exact = `${siteUrl}/app/?b=2&a=1&utm_source=mail#dashboard/sales`;
    requested.length = 0;
    const { runId, run, db } = await finish({ url: exact, scope: 'page' });
    expect(run).toMatchObject({ status: 'COMPLETED', state: 'COMPLETED', scope: 'page' });

    // one page, stored exactly as entered
    const pages = db.listPages(runId);
    expect(pages.map((p) => p.url)).toEqual([exact]);
    expect(pages[0]).toMatchObject({ testStatus: 'tested', title: 'Sales' });
    expect(run.counts).toMatchObject({ pagesCrawled: 1, pagesTested: 1 });
    expect(db.getRun(runId)!.state!.crawl).toEqual({ visited: [exact], queue: [] });
    // the browser asked the server for exactly that path and query, every time it opened the page
    const opened = requested.filter((r) => r.startsWith('/app/'));
    expect(opened.length).toBeGreaterThan(0);
    expect(new Set(opened)).toEqual(new Set(['/app/?b=2&a=1&utm_source=mail']));

    // every relevant element of THAT page was tested
    const results = db.listTestResults(runId);
    expect(results.every((r) => r.page === exact)).toBe(true);
    expect(results.find((r) => r.target === 'Refresh data')).toMatchObject({ classification: 'EXPECTED' });
    expect(results.find((r) => r.kind === 'interactive' && r.target === 'Quantity')).toMatchObject({ classification: 'EXPECTED' });
    // working elements are silent; the genuinely broken ones are reported
    const findings = db.listFindings(runId);
    expect(findings.filter((f) => f.ruleId === 'functional.button').map((f) => f.element?.name)).toEqual(['Export report']);
    expect(findings.some((f) => f.track === 'accessibility')).toBe(false);

    // links are verified (a broken destination is found)...
    expect(results.find((r) => r.kind === 'link' && r.target === 'Other page')).toMatchObject({ classification: 'EXPECTED' });
    expect(findings.some((f) => f.ruleId === 'functional.link' && /missing.*HTTP 404/.test(f.actual))).toBe(true);
    // ...but the destination page itself is not tested, and pages beyond it are never opened
    expect(results.some((r) => r.target === 'Only on the other page')).toBe(false);
    expect(requested).not.toContain('/third');
  }, 300_000);

  it('whole-site scope is unchanged: the same start page leads to the other pages being crawled and tested', async () => {
    const { runId, run, db } = await finish({ url: `${siteUrl}/app/`, overrides: { maxPages: 3, maxDepth: 2 } });
    expect(run).toMatchObject({ status: 'COMPLETED', scope: 'site' });
    expect(db.listPages(runId).length).toBeGreaterThan(1);
    expect(db.listTestResults(runId).some((r) => r.target === 'Only on the other page')).toBe(true);
  }, 300_000);

  it('a page that needs login: "Authentication required to test this page", and the login page is not tested', async () => {
    const target = `${siteUrl}/private`;
    const { runId, run, db } = await finish({ url: target, scope: 'page' });
    expect(run.status).toBe('ERROR');
    expect(run.error).toMatch(/^Authentication required to test this page/);
    expect(run.error).toContain(target); // the original URL stays the target
    expect(run.note).toMatch(/Authentication required to test this page/);
    expect(db.listTestResults(runId)).toEqual([]);
    expect(db.listPages(runId)).toEqual([]);
    expect(db.getRun(runId)!.url).toBe(target);
  }, 120_000);

  it('stopping a single-page run keeps everything completed before the stop', async () => {
    const { runId } = await (await post('/api/runs', { url: `${siteUrl}/busy`, scope: 'page', mode: 'deterministic' })).json() as { runId: string };
    const db = platform.orchestrator.db;
    for (let i = 0; i < 300 && db.listTestResults(runId).length < 5; i++) await new Promise((r) => setTimeout(r, 200));
    const before = db.listTestResults(runId).length;
    expect(before).toBeGreaterThanOrEqual(5);
    expect(await (await post(`/api/runs/${runId}/stop`, {})).json()).toEqual({ stopped: true });
    await platform.orchestrator.whenDone(runId);
    const run = await getRun(runId);
    expect(run).toMatchObject({ status: 'ABORTED', state: 'ABORTED', scope: 'page' });
    expect(run.note).toBe('Stopped by user. Results shown for work completed before stopping.');
    expect(run.counts.elementsTested).toBeGreaterThanOrEqual(before);
    expect(run.counts.elementsTested).toBeLessThan(30); // the rest is not counted as tested
    expect(run.counts.pagesTested).toBe(0);
  }, 180_000);
});
