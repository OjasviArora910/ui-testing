import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from '../src/api/index.js';
import { bodyShape } from '../src/browser/collectors.js';
import { evaluateReadiness, type PageReadiness, type ReadinessRequest } from '../src/browser/readiness.js';
import { createPlatform, type Platform } from '../src/orchestrator/index.js';

describe('response shape: is there any data? (content is never kept)', () => {
  it('recognises empty and filled bodies, including the usual envelopes', () => {
    expect(bodyShape([])).toEqual({ body: 'empty', items: 0 });
    expect(bodyShape([1, 2, 3])).toEqual({ body: 'data', items: 3 });
    expect(bodyShape({ data: [], total: 0 })).toEqual({ body: 'empty', items: 0 });
    expect(bodyShape({ data: [{ id: 1 }], total: 1 })).toEqual({ body: 'data', items: 1 });
    expect(bodyShape({ result: { rows: [] } })).toEqual({ body: 'empty', items: 0 });
    expect(bodyShape({ name: 'x' })).toEqual({ body: 'data' });
    expect(bodyShape(null)).toEqual({ body: 'empty' });
    expect(bodyShape({})).toEqual({ body: 'empty' });
  });
});

describe('readiness state', () => {
  const q = (o: Partial<ReadinessRequest>): ReadinessRequest => ({ method: 'GET', url: 'https://app.test/api/x', endpoint: 'https://app.test/api/x', type: 'xhr', status: 200, outcome: 'ok', phase: 'page-load', startedMs: 10, durationMs: 5, ...o });
  it('a blocked or failed data request means the page is not showing its real content', () => {
    const blocked = evaluateReadiness([q({}), q({ method: 'POST', endpoint: 'https://app.test/api/GetItems', outcome: 'blocked', status: null, blockedBy: 'safety-guard' })], ['No Data Found']);
    expect(blocked.state).toBe('data-not-loaded');
    expect(blocked.summary).toMatch(/blocked by the QA platform \(POST \/api\/GetItems\)/);
    expect(blocked.summary).toMatch(/"No Data Found", which is a consequence of that, not a UI bug/);
    expect(evaluateReadiness([q({ outcome: 'failed', status: 500 })], []).state).toBe('data-not-loaded');
  });
  it('successful requests that return nothing are a legitimately empty page', () => {
    expect(evaluateReadiness([q({ response: { body: 'empty', items: 0 } })], ['No results found']).state).toBe('empty');
  });
  it('successful requests with data are ready, even if some text on the page says "no results"', () => {
    expect(evaluateReadiness([q({ response: { body: 'data', items: 4 } }), q({ response: { body: 'empty', items: 0 } })], ['No results found']).state).toBe('ready');
    expect(evaluateReadiness([], []).state).toBe('ready');
  });
  it('declared page data that loaded makes the page ready; other blocked requests are auxiliary (PARTIAL)', () => {
    const images = q({ method: 'POST', endpoint: 'https://app.test/api/GetImages', role: 'required', response: { body: 'data', items: 14 } });
    const filters = q({ method: 'POST', endpoint: 'https://app.test/api/GetFilters', role: 'required', response: { body: 'data', items: 1 } });
    const profile = q({ method: 'POST', endpoint: 'https://app.test/api/GetProfileDetails', outcome: 'blocked', status: null, blockedBy: 'safety-guard' });
    const walkme = q({ endpoint: 'https://cdn.other.test/data.json', outcome: 'blocked', status: null, blockedBy: 'external-host', role: 'auxiliary' });
    const partial = evaluateReadiness([images, filters, profile, walkme], []);
    expect(partial.state).toBe('partial');
    expect(partial.summary).toMatch(/Required page data loaded \(POST \/api\/GetImages, POST \/api\/GetFilters\)\. 2 auxiliary request\(s\) were blocked or failed/);
    expect(evaluateReadiness([images, filters], []).state).toBe('ready');
  });
  it('required page data that is blocked, fails or returns nothing usable is DATA NOT LOADED', () => {
    const profile = q({ method: 'POST', endpoint: 'https://app.test/api/GetProfileDetails', outcome: 'blocked', status: null, blockedBy: 'safety-guard' });
    const ok = q({ method: 'POST', endpoint: 'https://app.test/api/GetFilters', role: 'required', response: { body: 'data', items: 1 } });
    expect(evaluateReadiness([ok, q({ method: 'POST', endpoint: 'https://app.test/api/GetImages', role: 'required', outcome: 'blocked', status: null, blockedBy: 'safety-guard' })], []).state).toBe('data-not-loaded');
    expect(evaluateReadiness([ok, q({ method: 'POST', endpoint: 'https://app.test/api/GetImages', role: 'required', outcome: 'failed', status: 500 })], []).state).toBe('data-not-loaded');
    expect(evaluateReadiness([q({ method: 'POST', endpoint: 'https://app.test/api/GetImages', role: 'required', response: { body: 'empty', items: 0 } }), profile], []).state).toBe('data-not-loaded');
    // nothing declared for the page: a blocked request of the application itself is still treated as required
    expect(evaluateReadiness([q({ response: { body: 'data', items: 3 } }), profile], []).state).toBe('data-not-loaded');
  });
  it('Roles page: the declared GetRoles request decides readiness; the blocked shell requests are auxiliary', () => {
    const shell = ['GetProfileDetails', 'GetNavigationTopBanner', 'GetTotalUnreadNotificationsForUser'].map((n) => q({ method: 'POST', endpoint: `https://app.test/api/${n}`, outcome: 'blocked', status: null, blockedBy: 'safety-guard' }));
    const roles = (o: Partial<ReadinessRequest>) => q({ method: 'POST', endpoint: 'https://app.test/api/GetRoles', role: 'required', ...o });
    const loaded = evaluateReadiness([roles({ response: { body: 'data', items: 6 } }), ...shell], []);
    expect(loaded.state).toBe('partial');
    expect(loaded.summary).toMatch(/Required page data loaded \(POST \/api\/GetRoles\)\. 3 auxiliary request\(s\)/);
    expect(evaluateReadiness([roles({ outcome: 'blocked', status: null, blockedBy: 'safety-guard' }), ...shell], ['No Data Found']).state).toBe('data-not-loaded');
    expect(evaluateReadiness([roles({ outcome: 'failed', status: 500 }), ...shell], []).state).toBe('data-not-loaded');
  });
  it('a request to another host is never page data: blocking it alone leaves the page reliable', () => {
    const walkme = q({ endpoint: 'https://cdn.other.test/data.json', outcome: 'blocked', status: null, blockedBy: 'external-host', role: 'auxiliary' });
    expect(evaluateReadiness([q({ response: { body: 'data', items: 3 } }), walkme], []).state).toBe('partial');
  });
});

/**
 * A page that loads its content with a POST (blocked by the safety guard) and so shows "No Data Found", as real
 * applications do. The run must explain that, must not blame a click for it, and must not call it a UI bug.
 */
describe('page readiness report (browser)', () => {
  const SESSION = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJxYSJ9.c2Vzc2lvbi1mb3ItdGVzdHM';
  let site: http.Server; let siteUrl: string; let platform: Platform; let api: { server: http.Server; url: string };
  const hits = { getItems: 0 };

  beforeAll(async () => {
    const slow = Array.from({ length: 25 }, (_, i) => `<button type="button" class="slow">Step ${i + 1}</button>`).join(' ');
    site = http.createServer((req, res) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      const json = (body: unknown): void => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
      if (p === '/api/GetMenu') return json({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] });
      if (p === '/api/GetTags') return json({ data: [], total: 0 });
      if (p === '/api/GetItems') { hits.getItems++; return json({ data: [{ id: 1 }] }); }
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><html lang="en"><head><title>Gallery</title></head><body>
<main><h1>Gallery</h1><p><button type="button" id="manage">Manage</button> <button type="button" id="connections">Connections</button></p><div id="grid">Loading…</div><p id="o">idle</p>${slow}</main>
<script>
// like many applications: the page content is requested with POST, some of it a little after the document has loaded
fetch('/api/GetMenu', { headers: { 'X-Requested-With': 'XMLHttpRequest' } }).then((r) => r.json()).catch(() => null);
fetch('/api/GetTags').then((r) => r.json()).catch(() => null);
setTimeout(() => {
  fetch('/api/GetItems', { method: 'POST', headers: { 'content-type': 'application/json', 'X-CSRF-Token': 'abc123-secret-value' }, body: '{}' })
    .then((r) => r.json()).then((d) => { document.getElementById('grid').textContent = d.data.length + ' items'; })
    .catch(() => { document.getElementById('grid').textContent = 'No Data Found'; });
}, 700);
document.getElementById('manage').onclick = () => { document.getElementById('o').textContent = 'manage menu opened'; };
document.getElementById('connections').onclick = () => { document.getElementById('o').textContent = 'connections menu opened'; };
document.querySelectorAll('.slow').forEach((b) => b.onclick = () => setTimeout(() => { document.getElementById('o').textContent = 'did ' + b.textContent; }, 300));
</script></body></html>`);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ready-'));
    platform = createPlatform({
      configOverrides: { paths: { dataDir: path.join(dir, 'data'), baselineDir: path.join(dir, 'baselines') }, viewports: [{ name: 'desktop', width: 1280, height: 800 }] },
      provider: null, trace: false, env: {},
    });
    api = await startApi(platform, { host: '127.0.0.1', port: 0 });
  }, 60_000);
  afterAll(async () => { await platform?.orchestrator.shutdown(); api?.server.close(); site.closeAllConnections?.(); await new Promise((r) => site.close(() => r(undefined))); });

  const post = (p: string, body: unknown) => fetch(`${api.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const readinessOf = async (runId: string): Promise<PageReadiness | undefined> => ((await (await fetch(`${api.url}/api/runs/${runId}/readiness`)).json()) as { pages: { readiness: PageReadiness }[] }).pages[0]?.readiness;

  it('is saved as soon as the page has loaded and survives a stop; explains the missing data; blames no click', async () => {
    const exact = `${siteUrl}/#gallery/bannerimages`;
    const { runId } = await (await post('/api/runs', { url: exact, scope: 'page', mode: 'deterministic', auth: { token: SESSION, location: 'cookie', key: 'jwt' } })).json() as { runId: string };
    const db = platform.orchestrator.db;
    // the report exists before the page's elements have been tested
    let early: PageReadiness | undefined;
    for (let i = 0; i < 200 && !(early = await readinessOf(runId)); i++) await new Promise((r) => setTimeout(r, 150));
    expect(early).toBeDefined();
    for (let i = 0; i < 300 && db.listTestResults(runId).length < 4; i++) await new Promise((r) => setTimeout(r, 200));
    await post(`/api/runs/${runId}/stop`, {});
    await platform.orchestrator.whenDone(runId);
    expect(db.getRun(runId)!.status).toBe('ABORTED');

    const r = (await readinessOf(runId))!; // still there after the stop
    expect(r.url).toBe(exact); // the URL exactly as entered
    expect(r.state).toBe('data-not-loaded');
    expect(r.summary).toMatch(/1 data request\(s\) were blocked by the QA platform \(POST \/api\/GetItems\)/);
    expect(r.emptyStateText).toEqual(['No Data Found']);

    const byPath = (p: string) => r.requests.find((x) => new URL(x.endpoint).pathname === p)!;
    // the blocked request: method, exact path, the rule and the reason
    expect(byPath('/api/GetItems')).toMatchObject({ method: 'POST', outcome: 'blocked', status: null, blockedBy: 'safety-guard', phase: 'page-load' });
    expect(byPath('/api/GetItems').reason).toMatch(/safety guard: write method POST blocked \(only GET, HEAD, OPTIONS requests may leave the browser\)/);
    expect(hits.getItems).toBe(0); // and it really never left the browser
    // the successful ones: status and whether they carried data
    expect(byPath('/api/GetMenu')).toMatchObject({ method: 'GET', outcome: 'ok', status: 200, response: { body: 'data', items: 3 } });
    expect(byPath('/api/GetTags')).toMatchObject({ outcome: 'ok', status: 200, response: { body: 'empty', items: 0 } });
    // credentials: names only
    expect(byPath('/api/GetMenu').auth).toEqual({ cookieNames: ['jwt'], headerNames: ['x-requested-with'] });
    expect(byPath('/api/GetItems').auth).toEqual({ cookieNames: ['jwt'], headerNames: ['x-csrf-token'] });
    expect(r.cookieNames).toEqual(['jwt']);
    const stored = JSON.stringify(r) + JSON.stringify(db.listPages(runId));
    expect(stored).not.toContain(SESSION);
    expect(stored).not.toContain('abc123-secret-value');
    // every request carries when it started, relative to the navigation
    expect(r.requests.every((x) => typeof x.startedMs === 'number')).toBe(true);
    expect(byPath('/api/GetItems').startedMs).toBeGreaterThan(byPath('/api/GetMenu').startedMs);

    // the page-load request is NOT evidence against any click, even though the page reloads before every click
    const results = db.listTestResults(runId);
    expect(results.length).toBeGreaterThanOrEqual(4);
    expect(results.filter((x) => x.classification === 'BLOCKED_BY_SAFETY')).toEqual([]);
    expect(results.some((x) => /GetItems/.test(x.actual))).toBe(false);
    expect(results.find((x) => x.target === 'Manage')).toMatchObject({ classification: 'EXPECTED' });
    expect(results.find((x) => x.target === 'Connections')).toMatchObject({ classification: 'EXPECTED' });
    // "No Data Found" is not reported as a UI problem
    const findings = db.listFindings(runId);
    expect(findings.filter((f) => f.classification === 'defect').map((f) => `${f.ruleId}: ${f.actual}`)).toEqual([]);
    expect(findings.some((f) => /no data/i.test(`${f.expected} ${f.actual}`))).toBe(false);
    // and it is in the report
    expect(fs.readFileSync(platform.orchestrator.reportPath(runId, 'html')!, 'utf8')).toMatch(/Page readiness[\s\S]*DATA NOT LOADED[\s\S]*\/api\/GetItems/);
  }, 240_000);
});
