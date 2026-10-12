import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from '../src/api/index.js';
import { hashTwin, samePage } from '../src/discovery/crawler.js';
import { defectKey } from '../src/functional/audit.js';
import { sameViewUrl } from '../src/functional/helpers.js';
import { ActionBudget } from '../src/functional/index.js';
import { createPlatform, type Platform } from '../src/orchestrator/index.js';

/**
 * Whole-site runs: every discovered page is tested within the run's time, menus built from plain lists are opened and their
 * items followed, equivalent routes are one page, one defect is one finding, and a navigation is a pass only when it was
 * seen to happen. The fixtures are generic applications; nothing in the engine knows their routes or labels.
 */

// ------------------------------------------------------------------ a hash-routed application with a plain nested menu
const VIEWS: Record<string, [string, string]> = {
  'dashboard/sales': ['Sales Dashboard', `<h1>Sales Dashboard</h1><button type="button" id="refresh">Refresh data</button> <span id="o">idle</span>
<span id="range-box" style="display:inline-block;position:relative"></span> <span id="r">all</span>
<p><a href="#help/faq">FAQ</a> <a href="#reports/none">Old report</a></p>`],
  'collateral/internal-playbook': ['Internal Playbook', '<h1>Internal Playbook</h1><button type="button" id="pb">Expand chapters</button><p id="pbo">collapsed</p>'],
  'collateral/data-room': ['Data Room', '<h1>Data Room</h1><button type="button" id="dr">Show files</button><p id="dro">none</p>'],
  'tools/audit': ['Audit Log', '<h1>Audit Log</h1><button type="button" id="au">Load entries</button><p id="auo">empty</p>'],
  'help/faq': ['FAQ', '<h1>FAQ</h1><button type="button" id="fq">Show answer</button><p id="fqo">hidden</p>'],
};

const SHELL = `<!doctype html><html lang="en"><head><title>Portal</title><style>
body{font:16px system-ui,sans-serif;margin:0}
aside{position:fixed;left:0;top:0;bottom:0;width:220px;background:#eee;padding:12px;overflow:auto}
main{margin-left:260px;padding:16px}
nav ul{list-style:none;margin:0;padding-left:12px} nav a{display:block;padding:6px 4px}
nav li > ul{display:none} nav li.open > ul{display:block}
button{min-height:36px;padding:6px 14px;font-size:16px}
#strip{width:600px} #strip-inner{width:680px;background:#fde;padding:4px 0}
.dropdown-menu{position:absolute;top:40px;left:0;margin:0;padding:6px;list-style:none;background:#fff;border:1px solid #888}
</style></head><body>
<aside><a id="logo" href="dashboard/sales">Portal</a>
<nav aria-label="Main"><ul>
<li><a href="#dashboard/sales">Dashboard</a></li>
<li><a href="#" title="Playbook">Playbook</a>
  <ul><li><a href="#collateral/internal-playbook">Internal Playbook</a></li><li><a href="#collateral/data-room">Data Room</a></li><li><a href="#collateral/ghost">Ghost Page</a></li></ul></li>
<li><a href="#" title="Tools" id="tools">Tools</a><ul id="tools-list"></ul></li>
</ul></nav></aside>
<main><div id="strip"><div id="strip-inner">A promotional strip that is wider than the box it sits in</div></div>
<p id="stats"></p><div id="view"></div></main>
<script>
const VIEWS = ${JSON.stringify(VIEWS)};
const view = document.getElementById('view');
const set = (id, text) => { const e = document.getElementById(id); if (e) e.textContent = text; };
function range() {
  const box = document.getElementById('range-box'); if (!box) return;
  // the widget is drawn again after every choice, as many component libraries do
  box.innerHTML = '<button type="button" id="range" class="dropdown-toggle" aria-haspopup="true" aria-expanded="false">Range</button>'
    + '<ul class="dropdown-menu" id="range-menu" hidden><li><a href="#" class="dropdown-item" data-r="week">This week</a></li><li><a href="#" class="dropdown-item" data-r="month">This month</a></li></ul>';
  const btn = box.querySelector('#range'); const menu = box.querySelector('#range-menu');
  btn.onclick = () => { const open = menu.hidden; menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
  menu.querySelectorAll('a').forEach((a) => a.onclick = (e) => { e.preventDefault(); fetch('/api/hit?o=' + a.dataset.r).catch(() => {}); const label = a.textContent; range(); set('r', label); });
}
function wire() {
  const on = (id, fn) => { const e = document.getElementById(id); if (e) e.onclick = fn; };
  on('refresh', () => set('o', 'refreshed')); on('pb', () => set('pbo', 'chapters 1 to 9')); on('dr', () => set('dro', '3 files'));
  on('au', () => set('auo', '12 entries')); on('fq', () => set('fqo', 'Forty-two.'));
  range();
}
// "/x/y" and "/#x/y" show the same view; "/#" (what an <a href="#"> leaves behind) and unknown routes change nothing
const route = () => location.hash.replace(/^#/, '') || (location.pathname.length > 1 ? location.pathname.slice(1) : '');
function render() { const v = VIEWS[route()]; if (!v) return; document.title = v[0]; view.innerHTML = v[1]; wire(); }
if (!location.hash && location.pathname === '/') location.replace('#dashboard/sales');
addEventListener('hashchange', render); render();
const tools = document.getElementById('tools-list');
document.querySelectorAll('nav a[href="#"]').forEach((a) => a.addEventListener('click', () => {
  a.parentElement.classList.toggle('open');
  // this menu does not exist in the document until it is opened
  if (a.id === 'tools' && !tools.children.length) tools.innerHTML = '<li><a href="#tools/audit">Audit Log</a></li><li><a href="#" id="quick">Quick stats</a></li>';
}));
tools.addEventListener('click', (e) => { const a = e.target.closest('#quick'); if (a) { e.preventDefault(); set('stats', 'Stats: 42 open, 7 closed'); } });
</script></body></html>`;

// ------------------------------------------------------------------ ordinary pages, one of which is far too big for its time share
const page = (title: string, body: string): string => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main>${body}</main></body></html>`;
const BUSY = page('Busy', `<h1>Busy</h1><p id="o">idle</p><p><a href="/b2">Second</a> <a href="/b3">Third</a></p>
${Array.from({ length: 150 }, (_, i) => `<button type="button" class="slow">Step ${i + 1}</button>`).join(' ')}
<script>document.querySelectorAll('.slow').forEach((b) => b.onclick = () => setTimeout(() => { document.getElementById('o').textContent = 'did ' + b.textContent; }, 250));</script>`);

describe('whole-site runs test every page, follow menus, and report each thing once', () => {
  let app: http.Server; let appUrl: string; let plain: http.Server; let plainUrl: string;
  const hits: Record<string, number> = {};
  const platforms: { platform: Platform; api: { server: http.Server; url: string } }[] = [];

  const listen = async (s: http.Server): Promise<string> => { await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(s.address() as AddressInfo).port}`; };
  const boot = async (timeouts?: Record<string, number>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-multi-'));
    const platform = createPlatform({
      configOverrides: { paths: { dataDir: path.join(dir, 'data'), baselineDir: path.join(dir, 'baselines') }, viewports: [{ name: 'desktop', width: 1280, height: 800 }], ...(timeouts ? { timeouts } : {}) },
      provider: null, trace: false, env: {},
    });
    const api = await startApi(platform, { host: '127.0.0.1', port: 0 });
    platforms.push({ platform, api });
    return { platform, api };
  };
  interface RunJson { status: string; state: string; counts: { pagesCrawled: number; pagesTested: number; notTestedPages: number; notTestedElements: number } }
  const finish = async (p: { platform: Platform; api: { url: string } }, body: Record<string, unknown>) => {
    const res = await fetch(`${p.api.url}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'deterministic', ...body }) });
    const { runId } = await res.json() as { runId: string };
    await p.platform.orchestrator.whenDone(runId);
    const run = await (await fetch(`${p.api.url}/api/runs/${runId}`)).json() as RunJson;
    return { runId, run, db: p.platform.orchestrator.db };
  };
  const routeOf = (u: string): string => { const x = new URL(u); return x.pathname + x.hash; };

  beforeAll(async () => {
    app = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.pathname === '/api/hit') { const o = u.searchParams.get('o') ?? ''; hits[o] = (hits[o] ?? 0) + 1; res.setHeader('content-type', 'application/json'); return void res.end('{}'); }
      res.setHeader('content-type', 'text/html'); res.end(SHELL); // any path is answered with the application shell
    });
    plain = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      res.setHeader('content-type', 'text/html');
      const slow = u.pathname.startsWith('/slow');
      const body = u.pathname === '/busy' ? BUSY
        : u.pathname === '/b2' ? page('Second', '<h1>Second</h1><button type="button" onclick="this.textContent=\'Done\'">Only on page two</button>')
        : u.pathname === '/b3' ? page('Third', '<h1>Third</h1><button type="button" onclick="this.textContent=\'Done\'">Only on page three</button>')
        : slow ? page(`Slow ${u.pathname}`, `<h1>${u.pathname}</h1>${[1, 2, 3, 4, 5, 6].map((n) => `<a href="/slow/${n}">Page ${n}</a>`).join(' ')}`)
        : null;
      if (!body) { res.statusCode = 404; return void res.end(page('Not found', '<h1>404 Not Found</h1>')); }
      if (slow) setTimeout(() => res.end(body), 1300); else res.end(body); // the slow site takes its time over every document
    });
    appUrl = await listen(app); plainUrl = await listen(plain);
  }, 60_000);
  afterAll(async () => {
    for (const p of platforms) { await p.platform.orchestrator.shutdown(); p.api.server.close(); }
    for (const s of [app, plain]) { s.closeAllConnections?.(); await new Promise((r) => s.close(() => r(undefined))); }
  });

  describe('hash-routed application with a plain <ul><li><a> menu', () => {
    let out: Awaited<ReturnType<typeof finish>>;
    beforeAll(async () => { out = await finish(await boot(), { url: `${appUrl}/` }); }, 420_000);

    const results = () => out.db.listTestResults(out.runId);
    const of = (target: string, check?: string) => results().filter((r) => r.target === target && (!check || r.check === check));

    it('the run completes and every discovered page was tested, not just the first one', () => {
      expect(out.run).toMatchObject({ status: 'COMPLETED', state: 'COMPLETED' });
      const pages = out.db.listPages(out.runId);
      const tested = pages.filter((p) => p.testStatus === 'tested').map((p) => routeOf(p.url));
      expect(tested).toEqual(expect.arrayContaining(['/#dashboard/sales', '/#collateral/internal-playbook', '/#collateral/data-room', '/#help/faq']));
      expect(pages.filter((p) => p.testStatus === 'pending')).toEqual([]);
      expect(out.run.counts.pagesTested).toBeGreaterThanOrEqual(5);
      expect(out.run.counts.notTestedPages).toBe(0);
    });

    it('"/dashboard/sales" and "/#dashboard/sales" are one page', () => {
      const routes = out.db.listPages(out.runId).map((p) => routeOf(p.url));
      expect(routes.filter((r) => r === '/#dashboard/sales')).toHaveLength(1);
      expect(routes).not.toContain('/dashboard/sales');
    });

    it('opening the parent reveals its submenu items, and each one is followed and verified', () => {
      for (const item of ['Internal Playbook', 'Data Room']) {
        const r = of(item, 'menu-navigation');
        expect(r.map((x) => x.classification), `${item}: ${r.map((x) => x.actual).join(' | ')}`).toEqual(['EXPECTED']);
        expect(r[0]!.actual).toMatch(/the destination view was shown/);
      }
      // the parent itself is not "done" merely because it opened: its items were gone through
      expect(of('Playbook').some((x) => x.classification === 'EXPECTED')).toBe(true);
    });

    it('the destination pages are tested as pages: their own controls have results', () => {
      const on = (route: string, target: string) => results().filter((r) => routeOf(r.page) === route && r.target === target).map((r) => r.classification);
      expect(on('/#collateral/internal-playbook', 'Expand chapters')).toEqual(['EXPECTED']);
      expect(on('/#collateral/data-room', 'Show files')).toEqual(['EXPECTED']);
      expect(on('/#help/faq', 'Show answer')).toEqual(['EXPECTED']);
    });

    it('a page that exists only behind a menu built on opening is discovered, scheduled and tested', () => {
      expect(of('Audit Log', 'menu-navigation').map((x) => x.classification)).toEqual(['EXPECTED']);
      const audit = out.db.listPages(out.runId).find((p) => routeOf(p.url) === '/#tools/audit');
      expect(audit).toMatchObject({ testStatus: 'tested' });
      expect(results().filter((r) => routeOf(r.page) === '/#tools/audit' && r.target === 'Load entries').map((r) => r.classification)).toEqual(['EXPECTED']);
    });

    it('a menu item that changes the view in place, without any address change, is exercised as an option', () => {
      expect(of('Quick stats', 'disclosure-option').map((x) => x.classification)).toEqual(['EXPECTED']);
    });

    it('a navigation that cannot be verified is never a pass', () => {
      // the address changes but the application shows nothing new: through the menu ...
      expect(of('Ghost Page', 'menu-navigation').map((x) => x.classification)).toEqual(['INCONCLUSIVE']);
      // ... and as an ordinary link on the page
      const old = of('Old report', 'navigation');
      expect(old.map((x) => x.classification), old.map((x) => x.actual).join(' | ')).toEqual(['INCONCLUSIVE']);
      expect(old[0]!.actual).toMatch(/could not be verified: the address changed, but the view shown did not/);
      // a hash route that does open is a pass on evidence, not on a missing HTTP status
      const faq = of('FAQ', 'navigation');
      expect(faq.map((x) => x.classification)).toEqual(['EXPECTED']);
      expect(faq[0]!.actual).toMatch(/the destination view was shown/);
      expect(results().some((r) => /HTTP n\/a/.test(r.actual))).toBe(false);
    });

    it('each destination is followed once in the run, and each dropdown option is executed once', () => {
      for (const item of ['Internal Playbook', 'Data Room', 'Audit Log', 'Ghost Page']) expect(of(item, 'menu-navigation'), item).toHaveLength(1);
      // the widget redraws itself after a choice, which used to make a second mechanism go through its options again
      expect(of('This week', 'disclosure-option')).toHaveLength(1);
      expect(of('This month', 'disclosure-option')).toHaveLength(1);
      expect(hits).toMatchObject({ week: 1, month: 1 });
    });

    it('a defect visible in every UI state of a page is ONE finding for that page, with its other occurrences recorded', () => {
      const strip = out.db.listFindings(out.runId).filter((f) => f.ruleId === 'geometry.container-overflow' && f.element?.selector === '#strip-inner');
      const perPage = new Map<string, number>();
      for (const f of strip) perPage.set(routeOf(f.page), (perPage.get(routeOf(f.page)) ?? 0) + 1);
      expect(perPage.get('/#dashboard/sales')).toBe(1);
      expect([...perPage.values()].every((n) => n === 1), JSON.stringify([...perPage])).toBe(true);
      expect(out.db.listFindings(out.runId).some((f) => /In UI state after/.test(f.actual))).toBe(false);
      const again = out.db.listActions(out.runId).filter((a) => a.type === 'defect-seen-again');
      expect(again.some((a) => /geometry\.container-overflow #strip-inner/.test(a.target ?? '') && /also present in \d+ other UI state/.test(a.detail ?? ''))).toBe(true);
    });

    it('nothing was written and nothing unsafe was followed', () => {
      expect(results().some((r) => r.classification === 'BUG' && r.kind === 'link')).toBe(false);
      expect(Object.keys(hits).sort()).toEqual(['month', 'week']); // only the read-only GETs of the dropdown
    });
  });

  it('page limit: the pages that were found but not visited are recorded as not tested, with the reason', async () => {
    const { runId, run, db } = await finish(platforms[0]!, { url: `${appUrl}/`, overrides: { maxPages: 3 } });
    expect(run.status).toBe('COMPLETED');
    const pages = db.listPages(runId);
    const left = pages.filter((p) => p.testStatus === 'not_tested');
    expect(left.length).toBeGreaterThan(0);
    expect(left.every((p) => !p.model && /page limit \(maxPages=3\) was reached/.test(p.error ?? ''))).toBe(true);
    const tested = pages.filter((p) => p.testStatus === 'tested');
    expect(tested.length).toBeGreaterThanOrEqual(1);
    expect(tested.length).toBeLessThanOrEqual(3); // the limit also holds for pages reached through a menu
    expect(pages.filter((p) => p.testStatus === 'pending')).toEqual([]);
    expect(run.counts.notTestedPages).toBe(left.length);
    expect(run.counts.pagesCrawled).toBe(tested.length);
  }, 300_000);

  it('a page that would take the whole run gets its share of the time; the run then tests the other pages', async () => {
    const p = await boot({ runMs: 60_000, minPageMs: 5_000 });
    const { runId, run, db } = await finish(p, { url: `${plainUrl}/busy` });
    expect(run.status).toBe('COMPLETED');
    const pages = db.listPages(runId);
    expect(pages.filter((x) => x.testStatus === 'tested').map((x) => new URL(x.url).pathname).sort()).toEqual(['/b2', '/b3', '/busy']);
    // the big page was cut off at its share, and that is said, not hidden
    expect(db.listActions(runId).some((a) => a.type === 'page-time-share' && /\/busy$/.test(a.target ?? ''))).toBe(true);
    expect(run.counts.notTestedElements).toBeGreaterThan(0);
    expect(pages.find((x) => new URL(x.url).pathname === '/busy')!.error).toMatch(/^partially tested: this page used its share of the run time/);
    // the pages after it were really tested
    const results = db.listTestResults(runId);
    expect(results.find((r) => r.target === 'Only on page two')).toMatchObject({ classification: 'EXPECTED' });
    expect(results.find((r) => r.target === 'Only on page three')).toMatchObject({ classification: 'EXPECTED' });
  }, 300_000);

  it('run time limit: the run ends by itself and every remaining page is recorded as not tested, with the reason', async () => {
    const p = await boot({ runMs: 8_000, minPageMs: 1_000 });
    const { runId, run, db } = await finish(p, { url: `${plainUrl}/slow/1` });
    expect(['COMPLETED', 'ABORTED']).toContain(run.status);
    expect(['COMPLETED', 'ABORTED']).toContain(run.state); // never left RUNNING or INTERRUPTED
    const pages = db.listPages(runId).filter((x) => x.model);
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.filter((x) => x.testStatus === 'pending')).toEqual([]);
    expect(pages.every((x) => x.testStatus === 'not_tested' && /run time limit/.test(x.error ?? '')), JSON.stringify(pages.map((x) => [x.url, x.testStatus, x.error]))).toBe(true);
    expect(run.counts.notTestedPages).toBe(pages.length);
  }, 120_000);

  it('a run left behind by a server that stopped is closed, with its untested pages recorded; it does not stay in TESTING', async () => {
    const { platform } = platforms[0]!;
    const db = platform.orchestrator.db;
    const url = `${plainUrl}/b2`;
    const run = db.createRun({ url, authProfile: null, mode: 'deterministic', request: { url, mode: 'deterministic', scope: 'site', controlledCreate: false, authSource: 'none' }, config: platform.config });
    db.setStatus(run.id, 'TESTING');
    db.upsertPage(run.id, { url, depth: 0, statusCode: 200, model: { url }, testStatus: 'tested' });
    db.upsertPage(run.id, { url: `${plainUrl}/b3`, depth: 1, statusCode: 200, model: { url }, testStatus: 'pending' });
    expect(platform.orchestrator.interruptedRuns().map((r) => r.id)).toContain(run.id);
    expect(platform.orchestrator.closeInterrupted()).toContain(run.id);
    const after = db.getRun(run.id)!;
    expect(after.status).toBe('ABORTED');
    expect(after.abortReason).toMatch(/server process ended/);
    expect(db.listPages(run.id).map((x) => [new URL(x.url).pathname, x.testStatus])).toEqual([['/b2', 'tested'], ['/b3', 'not_tested']]);
    expect(db.listPages(run.id)[1]!.error).toMatch(/server process ended/);
    expect(platform.orchestrator.interruptedRuns().map((r) => r.id)).not.toContain(run.id);
  });
});

describe('the rules behind it (no browser)', () => {
  it('a path and its hash-route form are the same page of a hash-routed application', () => {
    expect(hashTwin('https://app.test/dashboard/sales')).toBe('https://app.test/#dashboard/sales');
    expect(hashTwin('https://app.test/')).toBeNull();
    expect(hashTwin('https://app.test/#dashboard/sales')).toBeNull();
    expect(samePage('https://app.test/dashboard/sales', 'https://app.test/#dashboard/sales')).toBe(true);
    expect(samePage('https://app.test/#dashboard/sales', 'https://app.test/#dashboard/sales/')).toBe(false);
    expect(samePage('https://app.test/#a/b', 'https://app.test/#a/c')).toBe(false);
    expect(samePage('https://app.test/x?utm_source=m', 'https://app.test/x')).toBe(true);
  });

  it('an emptied fragment is not a navigation; another route or path is', () => {
    expect(sameViewUrl('https://app.test/#', 'https://app.test/#orders/open')).toBe(true); // what <a href="#"> leaves behind
    expect(sameViewUrl('https://app.test/', 'https://app.test/#orders/open')).toBe(true);
    expect(sameViewUrl('https://app.test/#orders/open', 'https://app.test/#orders/open')).toBe(true);
    expect(sameViewUrl('https://app.test/#orders/closed', 'https://app.test/#orders/open')).toBe(false);
    expect(sameViewUrl('https://app.test/other', 'https://app.test/#orders/open')).toBe(false);
    expect(sameViewUrl('https://app.test/#x', undefined)).toBe(false);
  });

  it('a page time share ends the page without spending the action budget, and is lifted for the next page', () => {
    const b = new ActionBudget(100);
    expect(b.consume()).toBe(true);
    b.setDeadline(Date.now() - 1);
    expect([b.exhausted, b.timedOut, b.consume()]).toEqual([true, true, false]);
    expect(b.used).toBe(1); // nothing was spent while the page was out of time
    b.clearDeadline();
    expect([b.exhausted, b.timedOut, b.consume()]).toEqual([false, false, true]);
    b.setDeadline(Date.now() + 60_000);
    expect(b.exhausted).toBe(false);
  });

  it('a defect has one identity whatever state or address it is looked at in; another element is another defect', () => {
    const f = (selector: string, actual: string) => ({ ruleId: 'geometry.container-overflow', element: { selector }, actual });
    const a = defectKey(f('#strip-inner', '#strip-inner (680x24 at (276,16)) extends 80px beyond its parent #strip (600x24 at (276,16))'));
    // the same thing measured after a menu opened and the page scrolled a little
    expect(defectKey(f('#strip-inner', '#strip-inner (680x24 at (276,212)) extends 80px beyond its parent #strip (600x24 at (276,212))'))).toBe(a);
    expect(defectKey(f('#other', '#other (680x24 at (276,16)) extends 80px beyond its parent #strip (600x24 at (276,16))'))).not.toBe(a);
    expect(defectKey({ ...f('#strip-inner', 'x'), ruleId: 'geometry.overlap' })).not.toBe(a);
    expect(a).not.toMatch(/state|after/i);
  });
});
