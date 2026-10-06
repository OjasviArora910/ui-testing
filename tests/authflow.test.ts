import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from '../src/api/index.js';
import { isHashRoute, normalizeUrl } from '../src/discovery/crawler.js';
import { createPlatform, type Platform } from '../src/orchestrator/index.js';

/**
 * A logged-in, hash-routed single-page application whose scripts and styles are served from ANOTHER host, as many real
 * applications are. Regression for three problems that made such an app untestable:
 *  - the session was not recognised and the run quietly tested the login page instead of the requested page;
 *  - "#dashboard/sales" was dropped from the URL, so hash routes were not pages;
 *  - every request to another host was blocked, so the application's own JavaScript and CSS never loaded.
 */
describe('hash routes are part of the URL', () => {
  it('route fragments are kept, in-page anchors are dropped', () => {
    expect(isHashRoute('#dashboard/sales')).toBe(true);
    expect(isHashRoute('#/orders')).toBe(true);
    expect(isHashRoute('#!/a')).toBe(true);
    expect(isHashRoute('#pricing')).toBe(false);
    expect(normalizeUrl('https://app.test/#dashboard/sales', 'https://app.test/')).toBe('https://app.test/#dashboard/sales');
    expect(normalizeUrl('https://app.test/docs#pricing', 'https://app.test/')).toBe('https://app.test/docs');
    // on a site known to route by fragment, a single-word fragment is a route unless it is an anchor in the page
    expect(normalizeUrl('https://app.test/#settings', 'https://app.test/', { hashRouted: true, anchors: new Set(['top']) })).toBe('https://app.test/#settings');
    expect(normalizeUrl('https://app.test/#top', 'https://app.test/', { hashRouted: true, anchors: new Set(['top']) })).toBe('https://app.test/');
    // a fragment that is not valid percent-encoding must not throw (real applications contain such links)
    expect(normalizeUrl('https://app.test/#search/100%', 'https://app.test/')).toBe('https://app.test/#search/100%');
    expect(normalizeUrl('https://app.test/#%E0%A4%A', 'https://app.test/', { hashRouted: true })).toBe('https://app.test/#%E0%A4%A');
  });
});

describe('authenticated, hash-routed app with assets on another host', () => {
  const SESSION = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJxYSJ9.c2Vzc2lvbi1mb3ItdGVzdHM';
  let app: http.Server; let cdn: http.Server; let appUrl: string; let cdnUrl: string;
  let platform: Platform; let api: { server: http.Server; url: string };
  const hits = { css: 0, js: 0, track: 0, save: 0 };

  beforeAll(async () => {
    cdn = http.createServer((req, res) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      if (p === '/app.css') { hits.css++; res.setHeader('content-type', 'text/css'); return void res.end('body{font:16px sans-serif;margin:24px} table{border-collapse:collapse} td,th{border:1px solid #888;padding:6px 12px} button{min-height:40px;padding:8px 16px}'); }
      if (p === '/api/track') { hits.track++; res.setHeader('access-control-allow-origin', '*'); return void res.end('{}'); }
      if (p === '/app.js') {
        hits.js++; res.setHeader('content-type', 'text/javascript');
        return void res.end(`
const views = {
  'dashboard/sales': '<h1>Sales Dashboard</h1><p id="total">Total: 3 deals</p><button type="button" id="refresh">Refresh data</button> <button type="button" id="save">Save view</button>' +
    '<table><thead><tr><th>Deal</th><th>Value</th></tr></thead><tbody><tr><td>Acme</td><td>10</td></tr><tr><td>Globex</td><td>20</td></tr><tr><td>Initech</td><td>30</td></tr></tbody></table>' +
    '<p><a href="#dashboard/reports">Reports</a> <a href="#settings">Settings</a> <a href="#top">Back to top</a></p>',
  'dashboard/reports': '<h1>Reports</h1><p>Quarterly reports</p><button type="button" id="toggle" aria-expanded="false" aria-controls="more">Details</button><div id="more" hidden>More</div><p><a href="#dashboard/sales">Sales</a></p>',
  'settings': '<h1>Settings</h1><label for="nick">Display name</label> <input id="nick" type="text"><p><a href="#dashboard/sales">Sales</a></p>',
};
const render = () => {
  const route = location.hash.replace(/^#/, '') || 'dashboard/sales';
  document.getElementById('app').innerHTML = '<div id="top"></div>' + (views[route] || '<h1>Not found</h1>');
  document.title = (document.querySelector('h1') || {}).textContent || 'App';
  const r = document.getElementById('refresh'); if (r) r.onclick = () => { document.getElementById('total').textContent = 'Total: 3 deals (refreshed ' + Date.now() + ')'; };
  const s = document.getElementById('save'); if (s) s.onclick = () => { fetch('/api/save', { method: 'POST', body: '{}' }).catch(() => {}); };
  const t = document.getElementById('toggle'); if (t) t.onclick = () => { const open = t.getAttribute('aria-expanded') === 'true'; t.setAttribute('aria-expanded', String(!open)); document.getElementById('more').hidden = open; };
};
addEventListener('hashchange', render); render();
fetch('${'${CDN}'}/api/track').catch(() => {});
`.replace('${CDN}', cdnUrl));
      }
      res.statusCode = 404; res.end();
    });
    await new Promise<void>((r) => cdn.listen(0, '127.0.0.1', r));
    cdnUrl = `http://127.0.0.1:${(cdn.address() as AddressInfo).port}`;

    app = http.createServer((req, res) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      const loggedIn = (req.headers.cookie ?? '').split(/;\s*/).includes(`jwt=${SESSION}`);
      if (p === '/api/save') { hits.save++; return void res.end('{}'); }
      if (p === '/login') {
        res.setHeader('content-type', 'text/html');
        return void res.end('<!doctype html><html lang="en"><head><title>Welcome</title></head><body><main><h1>Sign in</h1><form id="formLogin" action="/login" method="post"><label for="u">Username</label><input id="u" name="username" required><label for="p">Password</label><input id="p" name="password" type="password" required><button type="submit">Login</button></form><a href="/register">Register Now</a></main></body></html>');
      }
      if (p === '/') {
        if (!loggedIn) { res.statusCode = 302; res.setHeader('location', '/login'); return void res.end(); }
        res.setHeader('content-type', 'text/html');
        return void res.end(`<!doctype html><html lang="en"><head><title>App</title><link rel="stylesheet" href="${cdnUrl}/app.css"></head><body><main id="app">Loading…</main><script src="${cdnUrl}/app.js"></script></body></html>`);
      }
      res.statusCode = 404; res.end('not found');
    });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-auth-'));
    platform = createPlatform({
      configOverrides: { paths: { dataDir: path.join(dir, 'data'), baselineDir: path.join(dir, 'baselines') }, viewports: [{ name: 'desktop', width: 1280, height: 800 }] },
      provider: null, trace: false, env: {},
    });
    api = await startApi(platform, { host: '127.0.0.1', port: 0 });
  }, 60_000);
  afterAll(async () => {
    await platform?.orchestrator.shutdown(); api?.server.close();
    for (const s of [app, cdn]) { s.closeAllConnections?.(); await new Promise((r) => s.close(() => r(undefined))); }
  });

  const start = async (body: Record<string, unknown>) => {
    const res = await fetch(`${api.url}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'deterministic', ...body }) });
    const { runId } = await res.json() as { runId: string };
    await platform.orchestrator.whenDone(runId);
    const run = await (await fetch(`${api.url}/api/runs/${runId}`)).json() as { status: string; state: string; error: string | null; note: string | null; counts: { pagesTested: number; elementsTested: number } };
    return { runId, run, db: platform.orchestrator.db };
  };
  const routeOf = (u: string) => { const x = new URL(u); return x.pathname + x.hash; };

  it('with the right session cookie: the requested Sales Dashboard is loaded and tested, with its other routes as separate pages', async () => {
    const { runId, run, db } = await start({ url: `${appUrl}/#dashboard/sales`, auth: { token: SESSION, location: 'cookie', key: 'jwt' } });
    expect(run).toMatchObject({ status: 'COMPLETED', state: 'COMPLETED' });
    const pages = db.listPages(runId);
    // the hash route is the page, and the routes it links to are pages of their own; "#top" is only an anchor
    expect(pages.filter((p) => p.testStatus === 'tested').map((p) => routeOf(p.url)).sort()).toEqual(['/#dashboard/reports', '/#dashboard/sales', '/#settings']);
    expect(pages.some((p) => /login/.test(p.url))).toBe(false);
    expect(pages.find((p) => routeOf(p.url) === '/#dashboard/sales')!.title).toBe('Sales Dashboard');
    // the dashboard exists only because the application's script (served from the other host) ran
    expect(hits.js).toBeGreaterThan(0);
    expect(hits.css).toBeGreaterThan(0);
    const results = db.listTestResults(runId);
    const onSales = results.filter((r) => routeOf(r.page) === '/#dashboard/sales');
    expect(onSales.find((r) => r.target === 'Refresh data')).toMatchObject({ classification: 'EXPECTED' });
    expect(results.find((r) => routeOf(r.page) === '/#dashboard/reports' && r.target === 'Details')).toMatchObject({ classification: 'EXPECTED' });
    expect(results.find((r) => routeOf(r.page) === '/#settings' && r.kind === 'interactive')).toMatchObject({ classification: 'EXPECTED' });
    expect(results.some((r) => r.target === 'formLogin' || r.target === 'Register Now')).toBe(false);
    // safety is unchanged: no write left the browser, and non-static requests to the other host stayed blocked
    expect(onSales.find((r) => r.target === 'Save view')).toMatchObject({ classification: 'BLOCKED_BY_SAFETY' });
    expect(hits.save).toBe(0);
    expect(hits.track).toBe(0);
  }, 300_000);

  it('without a session: the run says AUTHENTICATION REQUIRED and does not test the login page', async () => {
    const { runId, run, db } = await start({ url: `${appUrl}/#dashboard/sales` });
    expect(run.status).toBe('ERROR');
    expect(run.error).toMatch(/Authentication required to test this page/);
    expect(run.error).toMatch(/login page \(\/login\)/);
    expect(run.error).toMatch(/Supply a session token/);
    expect(run.note).toMatch(/Authentication required to test this page/);
    expect(db.listTestResults(runId)).toEqual([]);
    expect(run.counts.elementsTested).toBe(0);
  }, 120_000);

  it('with the session under the wrong cookie name: the same clear result, saying the credentials were not accepted', async () => {
    const { run } = await start({ url: `${appUrl}/#dashboard/sales`, auth: { token: SESSION, location: 'cookie' } }); // default name "token"
    expect(run.status).toBe('ERROR');
    expect(run.error).toMatch(/Authentication required to test this page/);
    expect(run.error).toMatch(/did not accept the supplied token \(cookie\)/);
    expect(run.error).not.toContain(SESSION);
  }, 120_000);

  it('a login page requested on purpose is still an ordinary page to test', async () => {
    const { runId, run, db } = await start({ url: `${appUrl}/login`, overrides: { maxPages: 1 } });
    expect(run.status).toBe('COMPLETED');
    expect(db.listTestResults(runId).some((r) => r.scenario === 'login')).toBe(true);
  }, 180_000);
});
