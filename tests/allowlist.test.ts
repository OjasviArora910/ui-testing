import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from '../src/api/index.js';
import type { PageReadiness } from '../src/browser/readiness.js';
import { ActionGuard } from '../src/functional/index.js';
import { createPlatform, type Platform } from '../src/orchestrator/index.js';
import { loadConfig } from '../src/shared/config.js';

const config = loadConfig('qa.config.json');
const ORIGIN = 'https://app.test';
const guardWith = (allowedRequests: { origin: string; method: string; path: string }[]) =>
  new ActionGuard({ keywords: config.dangerousActions.keywords, allowMethods: config.dangerousActions.allowMethods, origin: ORIGIN, allowedRequests });

describe('request allow-list: deny by default, exact entries only', () => {
  const g = guardWith([{ origin: ORIGIN, method: 'POST', path: '/api/GetImagesForCurrentUser' }]);
  it('lets through exactly the listed origin + method + path and records which entry allowed it', () => {
    expect(g.checkRequest({ method: 'POST', url: `${ORIGIN}/api/GetImagesForCurrentUser` })).toBe(true);
    expect(g.allowedByRule).toMatchObject([{ method: 'POST', rule: 'POST /api/GetImagesForCurrentUser' }]);
  });
  it('everything else stays blocked: other paths, look-alikes, other methods, other hosts', () => {
    for (const [method, url] of [
      ['POST', `${ORIGIN}/api/GetImages`], ['POST', `${ORIGIN}/api/GetImagesForCurrentUser/1`], ['POST', `${ORIGIN}/api/GetImagesForCurrentUser2`],
      ['POST', `${ORIGIN}/api/getimagesforcurrentuser`], ['POST', `${ORIGIN}/api/GetOrAddFilter`], ['POST', `${ORIGIN}/api/DeleteImage`],
      ['PUT', `${ORIGIN}/api/GetImagesForCurrentUser`], ['DELETE', `${ORIGIN}/api/GetImagesForCurrentUser`],
      ['POST', 'https://other.test/api/GetImagesForCurrentUser'], ['POST', 'https://cdn.walkme.com/api/GetImagesForCurrentUser'],
    ] as const) expect(g.checkRequest({ method, url }), `${method} ${url}`).toBe(false);
  });
  it('refuses wildcard entries and entries whose path changes or removes something', () => {
    const bad = guardWith([
      { origin: ORIGIN, method: 'POST', path: '/api/*' }, { origin: ORIGIN, method: 'POST', path: '/api/Get*' }, { origin: ORIGIN, method: '*', path: '/api/GetImages' },
      { origin: 'https://*.test', method: 'POST', path: '/api/GetImages' }, { origin: ORIGIN, method: 'POST', path: '/api/' },
      { origin: ORIGIN, method: 'POST', path: '/api/DeleteImage' }, { origin: ORIGIN, method: 'POST', path: '/api/RemoveBanner' }, { origin: ORIGIN, method: 'POST', path: '/api/GetOrAddFilter' },
      { origin: ORIGIN, method: 'POST', path: '/api/GetAndSaveTelnyxCallRecord' }, { origin: ORIGIN, method: 'POST', path: '/api/UpdateImage' }, { origin: ORIGIN, method: 'POST', path: '/api/PurgeAll' },
    ]);
    expect(bad.rejectedAllowRules).toHaveLength(11);
    for (const p of ['/api/x', '/api/GetImages', '/api/DeleteImage', '/api/RemoveBanner', '/api/GetOrAddFilter', '/api/GetAndSaveTelnyxCallRecord', '/api/UpdateImage', '/api/PurgeAll']) {
      expect(bad.checkRequest({ method: 'POST', url: `${ORIGIN}${p}` }), p).toBe(false);
    }
  });
  it('the shipped configuration lists exactly the approved read endpoints (Banner Images, Roles) and nothing else', () => {
    expect(config.network.allowedRequests).toEqual([
      { origin: 'https://main.dvl.amp.vg', method: 'POST', path: '/api/GetFiltersForImages' },
      { origin: 'https://main.dvl.amp.vg', method: 'POST', path: '/api/GetImagesForCurrentUser' },
      { origin: 'https://main.dvl.amp.vg', method: 'POST', path: '/api/GetRoles' },
      { origin: 'https://main.dvl.amp.vg', method: 'POST', path: '/api/GetRolesData' },
    ]);
    const shipped = new ActionGuard({ keywords: config.dangerousActions.keywords, allowMethods: config.dangerousActions.allowMethods, origin: 'https://main.dvl.amp.vg', allowedRequests: config.network.allowedRequests });
    expect(shipped.rejectedAllowRules).toEqual([]);
    // the Roles page data endpoint, exactly; look-alikes, other methods and anything that changes roles stay blocked
    const A = 'https://main.dvl.amp.vg';
    expect(shipped.checkRequest({ method: 'POST', url: `${A}/api/GetRoles` })).toBe(true);
    expect(shipped.checkRequest({ method: 'POST', url: `${A}/api/GetRolesData` })).toBe(true); // loads the editor of an existing role
    for (const p of ['/api/GetRolesDataForUser', '/api/GetRolesData/1', '/api/SaveRolesData', '/api/UpdateRolesData', '/api/DeleteRolesData']) expect(shipped.checkRequest({ method: 'POST', url: `${A}${p}` }), p).toBe(false);
    expect(shipped.checkRequest({ method: 'DELETE', url: `${A}/api/GetRolesData` })).toBe(false);
    for (const [method, url] of [
      ['POST', `${A}/api/GetRole`], ['POST', `${A}/api/GetRolesForUser`], ['POST', `${A}/api/getroles`], ['POST', `${A}/api/GetRoles/1`],
      ['PUT', `${A}/api/GetRoles`], ['DELETE', `${A}/api/GetRoles`], ['POST', 'https://other.test/api/GetRoles'],
      ['POST', `${A}/api/AddRole`], ['POST', `${A}/api/SaveRole`], ['POST', `${A}/api/UpdateRole`], ['POST', `${A}/api/DeleteRole`], ['POST', `${A}/api/RemoveRole`],
      ['POST', `${A}/api/GetProfileDetails`], ['POST', `${A}/api/GetNavigationTopBanner`], ['POST', `${A}/api/GetTotalUnreadNotificationsForUser`],
    ] as const) expect(shipped.checkRequest({ method, url }), `${method} ${url}`).toBe(false);
  });
  it('destructive controls are never clicked, whatever they are called', () => {
    for (const text of ['Delete', 'Delete image', 'Remove', 'Remove banner', 'Purge', 'Destroy', 'Erase all', 'Move to trash', 'Delete permanently', 'Yes, delete']) {
      expect(g.check({ kind: 'click', text }).allowed, text).toBe(false);
    }
  });
});

/**
 * A page like the real one: a global menu bar on top (plain divs), page content that loads its data with POST, and a
 * destructive control. In "this page only" mode the menu bar is not tested, the listed read endpoint loads the data, the
 * unlisted one stays blocked, and nothing destructive is ever sent.
 */
describe('page-only run with an allow-listed data request (browser)', () => {
  let site: http.Server; let siteUrl: string; let platform: Platform; let api: { server: http.Server; url: string };
  const hits: Record<string, number> = {};

  beforeAll(async () => {
    site = http.createServer((req, res) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      hits[`${req.method} ${p}`] = (hits[`${req.method} ${p}`] ?? 0) + 1;
      const json = (body: unknown): void => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
      if (p === '/details') { res.setHeader('content-type', 'text/html'); return res.end('<!doctype html><title>Details</title><h1>Details</h1>'); }
      if (p.startsWith('/api/')) return json({ data: [{ id: 1, name: 'Banner A' }, { id: 2, name: 'Banner B' }] });
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><html lang="en"><head><title>Banner Images</title>
<style>body{margin:0;font-family:sans-serif}#bar{display:flex;gap:8px;height:48px;align-items:center;background:#223;padding:0 12px}#bar button,#bar a{color:#fff;background:none;border:0}
#content{padding:24px}.dd{display:none}#confirm{display:none;position:fixed;inset:20% 30%;background:#fff;border:1px solid #333;padding:20px}</style></head><body>
<div id="bar"><button type="button" id="m-manage">Manage</button><button type="button" id="m-reports">Reports</button><a href="#dashboard/sales">Dashboard</a><a href="#assets/list">Assets</a>
  <div class="dd" id="dd">menu</div></div>
<aside><nav><ul><li><a href="#collateral/journeys">Journeys</a></li><li><a href="#collateral/playbooks">Playbooks</a></li></ul></nav></aside>
<div id="content"><h1>Banner Images</h1> <a href="/details" id="more">Image details</a>
  <button type="button" id="view-list">List view</button> <button type="button" id="view-grid">Thumbnail view</button>
  <button type="button" id="del">Delete image</button>
  <p id="mode">thumbnail</p><div id="grid">Loading…</div>
  <div id="confirm" role="dialog" aria-modal="true" aria-label="Confirm"><p>Delete this image?</p><button type="button" id="yes">Yes</button> <button type="button" id="no">Cancel</button></div>
</div>
<script>
const post = (p) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json());
post('/api/GetImagesForCurrentUser').then((d) => { document.getElementById('grid').textContent = d.data.length + ' images'; }).catch(() => { document.getElementById('grid').textContent = 'No Data Found'; });
post('/api/TrackPageView').catch(() => null);
for (const id of ['m-manage', 'm-reports']) document.getElementById(id).onclick = () => { document.getElementById('dd').style.display = 'block'; };
document.getElementById('view-list').onclick = () => { document.getElementById('mode').textContent = 'list'; };
document.getElementById('view-grid').onclick = () => { document.getElementById('mode').textContent = 'thumbnail (refreshed)'; };
document.getElementById('del').onclick = () => { document.getElementById('confirm').style.display = 'block'; };
document.getElementById('yes').onclick = () => { post('/api/DeleteImage'); document.getElementById('confirm').style.display = 'none'; };
document.getElementById('no').onclick = () => { document.getElementById('confirm').style.display = 'none'; };
</script></body></html>`);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-allow-'));
    platform = createPlatform({
      configOverrides: {
        paths: { dataDir: path.join(dir, 'data'), baselineDir: path.join(dir, 'baselines') }, viewports: [{ name: 'desktop', width: 1280, height: 800 }],
        network: { allowedRequests: [{ origin: siteUrl, method: 'POST', path: '/api/GetImagesForCurrentUser' }] },
      },
      provider: null, trace: false, env: {},
    });
    api = await startApi(platform, { host: '127.0.0.1', port: 0 });
  }, 60_000);
  afterAll(async () => { await platform?.orchestrator.shutdown(); api?.server.close(); site.closeAllConnections?.(); await new Promise((r) => site.close(() => r(undefined))); });

  it('loads the data, tests only the page content, sends nothing destructive, reports no bug', async () => {
    const exact = `${siteUrl}/#gallery/bannerimages`;
    const res = await fetch(`${api.url}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: exact, scope: 'page', mode: 'deterministic' }) });
    const { runId } = await res.json() as { runId: string };
    const run = await platform.orchestrator.whenDone(runId);
    expect(run.status).toBe('COMPLETED');
    const db = platform.orchestrator.db;

    // exact URL, one page, no crawl
    expect(db.listPages(runId).map((p) => p.url)).toEqual([exact]);

    // the listed read endpoint reached the server and the page has its data; the unlisted POST stayed in the browser
    const r = ((await (await fetch(`${api.url}/api/runs/${runId}/readiness`)).json()) as { pages: { readiness: PageReadiness }[] }).pages[0]!.readiness;
    const byPath = (p: string) => r.requests.find((x) => new URL(x.endpoint).pathname === p)!;
    expect(byPath('/api/GetImagesForCurrentUser')).toMatchObject({ method: 'POST', outcome: 'ok', status: 200, response: { body: 'data', items: 2 } });
    expect(byPath('/api/TrackPageView')).toMatchObject({ method: 'POST', outcome: 'blocked', blockedBy: 'safety-guard' });
    expect(hits['POST /api/GetImagesForCurrentUser']).toBeGreaterThan(0);
    expect(hits['POST /api/TrackPageView']).toBeUndefined();
    expect(r.emptyStateText).toEqual([]);
    // required (declared) page data loaded; the blocked extra request is auxiliary, so the page is ready, not DATA NOT LOADED
    expect(r.state).toBe('partial');
    expect(byPath('/api/GetImagesForCurrentUser').role).toBe('required');
    expect(r.summary).toMatch(/Required page data loaded \(POST \/api\/GetImagesForCurrentUser\)/);

    // only the page content was tested: nothing from the global menu bar
    const results = db.listTestResults(runId);
    const targets = results.map((x) => x.target ?? '');
    expect(targets).toEqual(expect.arrayContaining(['List view', 'Thumbnail view']));
    expect(targets, targets.join(' | ')).toContain('Image details'); // a link in the page content IS tested
    for (const shell of ['Manage', 'Reports', 'Dashboard', 'Assets', 'dashboard/sales', 'assets/list', 'Journeys', 'Playbooks', 'collateral']) expect(targets.some((t) => t.includes(shell)), shell).toBe(false);

    // the destructive control was never activated and its confirmation never clicked
    expect(hits['POST /api/DeleteImage']).toBeUndefined();
    expect(results.filter((x) => /delete/i.test(x.target ?? '') && x.classification !== 'BLOCKED_BY_SAFETY' && x.classification !== 'INCONCLUSIVE').map((x) => `${x.target}: ${x.classification}`)).toEqual([]);
    expect(targets).not.toContain('Yes');

    // working elements are silent
    expect(db.listFindings(runId).filter((f) => f.classification === 'defect').map((f) => `${f.ruleId}: ${f.actual}`)).toEqual([]);
  }, 240_000);
});
