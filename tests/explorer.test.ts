import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserController } from '../src/browser/index.js';
import { buildPageModel } from '../src/discovery/pageModel.js';
import { classifyPage, classifyResult, selectTests } from '../src/dynamic/index.js';
import { ActionBudget, ActionGuard, runFunctionalTests, type FunctionalResult } from '../src/functional/index.js';
import { loadConfig } from '../src/shared/config.js';
import { launchForTest } from './helpers/launch.js';

const config = loadConfig('qa.config.json', { functional: { maxButtonsPerPage: 40 }, dynamic: { maxGenericButtons: 40 } });

/**
 * State exploration. A list whose rows open an editor; the editor has tabs (plain list items with an "active" class, no
 * ARIA), one tab has tabs of its own, each tab shows different controls, and there is a "More" menu with destructive
 * options next to Save and Close. Nothing in the engine knows these names. The page reports every tab activation, control
 * change and click to the server, so what really happened is checked from outside.
 */
describe('generic UI state exploration (browser)', () => {
  let site: http.Server; let url: string; let c: BrowserController;
  const hits: Record<string, number> = {};
  const log: Record<string, string[]> = {};

  beforeAll(async () => {
    site = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      hits[`${req.method} ${u.pathname}`] = (hits[`${req.method} ${u.pathname}`] ?? 0) + 1;
      if (u.pathname === '/did') { const k = u.searchParams.get('c')!; (log[k] ??= []).push(u.searchParams.get('v') ?? ''); res.end('ok'); return; }
      if (u.pathname.startsWith('/api/')) { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); return; }
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><html lang="en"><head><title>Roles</title>
<style>body{font-family:sans-serif;margin:24px}td,th{border:1px solid #ccc;padding:6px 10px}td[data-action]{cursor:pointer}
#editor{display:none;border:1px solid #999;padding:16px;margin-top:16px}.pane{display:none;padding:12px}.pane.active{display:block}
ul.tabs{list-style:none;display:flex;gap:12px;padding:0}ul.tabs li.active a{font-weight:bold}.menu{display:none;border:1px solid #aaa;padding:6px}label{display:block;margin:6px 0}</style></head><body>
<main><h1>Roles</h1>
<table id="roles">
  <tr><th>Name</th><th>Status</th></tr>
  <tr><td data-action="view">Delete old sales</td><td data-action="view">Unlocked</td></tr>
  <tr><td data-action="view">Partner admin</td><td data-action="view">Unlocked</td></tr>
</table>
<div id="editor"><h2>Role editor</h2>
  <ul class="tabs" id="maintabs">
    <li class="active"><a href="#p1" data-pane="p1">Getting started</a></li>
    <li><a href="#p2" data-pane="p2">Marketing functions</a></li>
    <li><a href="#p3" data-pane="p3">Operations</a></li>
    <li><a href="#p4" data-pane="p4">Advanced</a></li>
  </ul>
  <div class="pane active" id="p1"><label><input type="checkbox" id="c1" checked> Enable persona</label></div>
  <div class="pane" id="p2"><label>Email campaigns <input type="range" id="s2" min="0" max="4" value="1"></label></div>
  <div class="pane" id="p3"><label>Scope <select id="sel3"><option value="own" selected>Own</option><option value="all">All</option></select></label></div>
  <div class="pane" id="p4">
    <ul class="tabs" id="subtabs"><li class="active"><a href="#q1" data-pane="q1">Limits</a></li><li><a href="#q2" data-pane="q2">Audit</a></li></ul>
    <div class="pane active" id="q1"><label><input type="checkbox" id="c41"> Enforce limits</label></div>
    <div class="pane" id="q2"><label><input type="checkbox" id="c42" checked> Keep audit trail</label></div>
  </div>
  <button type="button" id="more" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">More</button>
  <div class="menu" id="menu"><a href="#" id="copy">Copy</a> <a href="#" id="del">Delete</a></div>
  <button type="button" id="save">Save</button> <button type="button" id="close">Close</button>
</div></main>
<script>
const did = (c, v) => fetch('/did?c=' + c + '&v=' + encodeURIComponent(v == null ? '' : v)).catch(() => null);
const post = (p) => fetch(p, { method: 'POST', body: '{}' }).catch(() => null);
document.querySelectorAll('#roles td[data-action]').forEach((td) => td.addEventListener('click', () => { document.getElementById('editor').style.display = 'block'; did('open', 'row' + td.parentElement.rowIndex); }));
document.querySelectorAll('ul.tabs').forEach((list) => list.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-pane]'); if (!a) return; e.preventDefault();
  for (const li of list.children) { const on = li.contains(a); li.classList.toggle('active', on); document.getElementById(li.querySelector('a').dataset.pane).classList.toggle('active', on); }
  did(list.id, a.textContent);
}));
document.getElementById('more').onclick = (e) => { const m = document.getElementById('menu'); const open = m.style.display !== 'block'; m.style.display = open ? 'block' : 'none'; e.currentTarget.setAttribute('aria-expanded', String(open)); did('more', open); };
document.getElementById('copy').onclick = (e) => { e.preventDefault(); did('copy', 1); post('/api/CopyRole'); };
document.getElementById('del').onclick = (e) => { e.preventDefault(); did('delete', 1); post('/api/DeleteRole'); };
document.getElementById('save').onclick = () => { did('save', 1); post('/api/SaveRole'); };
document.getElementById('close').onclick = () => { document.getElementById('editor').style.display = 'none'; did('closed', 1); };
for (const id of ['c1', 'c41', 'c42']) document.getElementById(id).addEventListener('change', (e) => did(id, e.target.checked));
for (const id of ['s2', 'sel3']) document.getElementById(id).addEventListener('input', (e) => did(id, e.target.value));
</script></body></html>`);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    c = await launchForTest({ baseUrl: url, blockExternal: true });
  }, 60_000);
  afterAll(async () => { await c?.close(); site?.closeAllConnections?.(); await new Promise((r) => site.close(() => r(undefined))); });

  it('opens the record, follows every tab (and the tabs inside a tab), tests and restores what each shows, and never mutates', async () => {
    const guard = new ActionGuard({ keywords: config.dangerousActions.keywords, allowMethods: config.dangerousActions.allowMethods, origin: url });
    c.setRequestGuard(guard.asRequestGuard());
    await c.navigate(url); await c.settle(150);
    const model = await buildPageModel(c);
    const plan = selectTests(classifyPage(model), model, config);

    // DATA is not an ACTION: the row whose name contains "Delete" is a safe entry control, because what it DOES is "view"
    const row = model.interactive.find((e) => e.name === 'Delete old sales')!;
    expect(row, JSON.stringify(model.rowCandidates, null, 1)).toMatchObject({ meta: { entry: 'labelled', entryAction: 'view' } });
    expect(plan.buttons.filter((b) => b.element.meta?.entry).map((b) => b.element.name)).toEqual(['Delete old sales']); // one row is enough

    const states: string[] = [];
    const results: FunctionalResult[] = await runFunctionalTests({
      controller: c, guard, pageUrl: c.page.url(), model, config, budget: new ActionBudget(600), plan,
      onAction: (a) => { if (a.type === 'state') states.push(`${a.target} :: ${a.detail}`); },
    });
    const say = `${results.map((r) => `${r.kind}/${r.check} | ${r.element?.name} | ${r.status} | ${r.actual}`).join('\n')}\nSTATES\n${states.join('\n')}`;
    const of = (checkName: string) => results.filter((r) => r.check === checkName);

    // the editor opened: proven by what became visible
    expect(of('entry-open').map((r) => [r.element?.name, r.status]), say).toEqual([['Delete old sales', 'pass']]);
    expect(of('entry-open')[0]!.actual).toMatch(/opened: new content was shown \("Role editor"\)/);
    expect(log.open).toEqual(['row1']);

    // every tab that was not active was switched to, and verified by its active marker AND panel visibility
    const tabs = of('tab-switch');
    expect(tabs.map((r) => r.element?.name).sort(), say).toEqual(['Advanced', 'Audit', 'Marketing functions', 'Operations']);
    expect(tabs.every((r) => r.status === 'pass'), say).toBe(true);
    expect(tabs.find((r) => r.element?.name === 'Operations')!.actual).toMatch(/"Operations" is now the active tab \(was: Getting started\)/);
    expect(tabs.find((r) => r.element?.name === 'Audit')!.actual).toMatch(/"Audit" is now the active tab \(was: Limits\)/); // tabs inside a tab
    // ...and each group was put back on the tab it started on
    expect(log.maintabs!.at(-1)).toBe('Getting started');
    expect(log.subtabs!.at(-1)).toBe('Limits');

    // the controls each state shows were found there, changed, verified and restored exactly
    const initial: Record<string, string> = { c1: 'true', sel3: 'own', c41: 'false', c42: 'true' };
    for (const [control, start] of Object.entries(initial)) {
      const v = log[control] ?? [];
      expect(v, `${control} was tested\n${say}`).toHaveLength(2); // once, however many states showed it: change + restore
      expect(v[0], control).not.toBe(start);
      expect(v[1], control).toBe(start);
    }
    expect(log.s2).toBeUndefined(); // sliders are discovered but deliberately not operated
    for (const label of [/Enable persona/, /Scope/, /Enforce limits/, /Keep audit trail/]) {
      expect(results.filter((r) => label.test(r.element?.name ?? '') && r.check.startsWith('reversible-')).map((r) => r.status), `${label}\n${say}`).toEqual(['pass']);
    }

    // the menu is a state too: opened, its options recorded, nothing in it selected, closed again
    const more = of('disclosure-open');
    expect(more.map((r) => [r.element?.name, r.status]), say).toEqual([['More', 'pass']]);
    expect(more[0]!.actual).toMatch(/"More" opened and shows: Copy, Delete\. Not selected, for safety: (Copy, )?Delete/);
    expect(log.more).toEqual(['true', 'false']);

    // states are bounded and never explored twice
    expect(states.length, say).toBeGreaterThanOrEqual(6);
    expect(states.length).toBeLessThanOrEqual(14);
    expect(new Set(states.map((s) => s.split(' :: ')[0])).size).toBe(states.length);

    // nothing was saved, copied or deleted; the editor was closed with its own close control
    for (const k of ['save', 'copy', 'delete']) expect(log[k], k).toBeUndefined();
    expect(Object.keys(hits).filter((k) => !k.startsWith('GET '))).toEqual([]);
    expect(log.closed?.length).toBeGreaterThan(0);
    expect(results.filter((r) => r.status === 'fail').map((r) => `${r.check}: ${r.actual}`), say).toEqual([]);
    expect(results.filter((r) => classifyResult(r) === 'BUG')).toEqual([]);
  }, 300_000);

  it('correctly discriminates dropdowns from tabs and executes visible safe dropdown/sort options', async () => {
    let sortSite: http.Server;
    let sortUrl: string;
    const sortClicks: string[] = [];

    sortSite = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><html lang="en"><head><title>Records</title>
<style>body{font-family:sans-serif;margin:24px}.dropdown{position:relative;display:inline-block}.dropdown-menu{display:none;position:absolute;background:#fff;border:1px solid #ccc;padding:8px;list-style:none}.dropdown-menu.show{display:block}.dropdown-item{display:block;padding:4px 8px;cursor:pointer;text-decoration:none;color:#333}.dropdown-item.active{font-weight:bold;color:blue}</style></head><body>
<main><h1>Records</h1>
<div class="dropdown">
  <button type="button" id="sort-btn" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">Sort by</button>
  <ul class="dropdown-menu" id="sort-menu">
    <li><a class="dropdown-item active" href="#" data-sort="name-asc">Name (A-Z)</a></li>
    <li><a class="dropdown-item" href="#" data-sort="name-desc">Name (Z-A)</a></li>
    <li><a class="dropdown-item" href="#" data-sort="status">Status</a></li>
  </ul>
</div>
<table id="tbl">
  <tr><th>Item</th></tr>
  <tr><td>Alpha</td></tr>
  <tr><td>Beta</td></tr>
</table>
</main>
<script>
document.getElementById('sort-btn').onclick = (e) => {
  const m = document.getElementById('sort-menu');
  const open = !m.classList.contains('show');
  m.classList.toggle('show', open);
  e.currentTarget.setAttribute('aria-expanded', String(open));
};
document.querySelectorAll('.dropdown-item').forEach(item => {
  item.onclick = (e) => {
    e.preventDefault();
    document.querySelectorAll('.dropdown-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');
    document.getElementById('sort-menu').classList.remove('show');
    document.getElementById('sort-btn').setAttribute('aria-expanded', 'false');
  };
});
</script></body></html>`);
    });

    await new Promise<void>((r) => sortSite.listen(0, '127.0.0.1', r));
    sortUrl = `http://127.0.0.1:${(sortSite.address() as AddressInfo).port}`;

    const testC = await launchForTest({ baseUrl: sortUrl, blockExternal: true });
    try {
      const guard = new ActionGuard({ keywords: config.dangerousActions.keywords, allowMethods: config.dangerousActions.allowMethods, origin: sortUrl });
      testC.setRequestGuard(guard.asRequestGuard());
      await testC.navigate(sortUrl);
      await testC.settle(150);
      const model = await buildPageModel(testC);
      const plan = selectTests(classifyPage(model), model, config);

      const results: FunctionalResult[] = await runFunctionalTests({
        controller: testC,
        guard,
        pageUrl: testC.page.url(),
        model,
        config,
        budget: new ActionBudget(100),
        plan,
      });

      // 1. None of the dropdown options should be classified as tabs
      const tabs = results.filter((r) => r.check === 'tab-switch');
      expect(tabs).toHaveLength(0);

      // 2. The dropdown button itself should be tested and pass
      const dropdownBtn = results.filter((r) => r.element?.name === 'Sort by');
      expect(dropdownBtn.length).toBeGreaterThan(0);
      expect(dropdownBtn[0]?.status).toBe('pass');

      // 3. The safe options should be executed
      const options = results.filter((r) => r.check === 'disclosure-option');
      expect(options.length).toBeGreaterThanOrEqual(2);
      expect(options.every((r) => r.status === 'pass')).toBe(true);

      // 4. No confirmed bugs on ordinary table text or dropdown state changes
      expect(results.filter((r) => classifyResult(r) === 'BUG')).toHaveLength(0);
    } finally {
      await testC.close();
      sortSite.closeAllConnections?.();
      await new Promise((r) => sortSite.close(() => r(undefined)));
    }
  }, 60_000);

  it('executes every option in a multi-option menu as a distinct UI state and audits each resulting state', async () => {
    let multiSite: http.Server;
    let multiUrl: string;

    multiSite = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><html lang="en"><head><title>Multi-State Menu Test</title>
<style>
body { font-family: sans-serif; margin: 24px; }
.dropdown { position: relative; display: inline-block; margin-bottom: 20px; }
.dropdown-menu { display: none; position: absolute; background: #fff; border: 1px solid #ccc; padding: 8px; list-style: none; }
.dropdown-menu.show { display: block; }
.dropdown-item { display: block; padding: 6px 12px; cursor: pointer; text-decoration: none; color: #333; }
.view-panel { display: none; padding: 16px; border: 1px solid #ddd; margin-top: 10px; }
.view-panel.active { display: block; }
.clipped-text { width: 70px; height: 20px; overflow: hidden; white-space: nowrap; }
</style></head><body>
<main><h1>Multi-State Menu</h1>
<div class="dropdown">
  <button type="button" id="menu-trigger" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">View Options</button>
  <ul class="dropdown-menu" id="menu-list">
    <li><a class="dropdown-item" href="#" id="opt-summary">Summary View</a></li>
    <li><a class="dropdown-item" href="#" id="opt-analytics">Analytics View</a></li>
    <li><a class="dropdown-item" href="#" id="opt-settings">Settings View</a></li>
  </ul>
</div>
<div class="view-panel" id="panel-summary">
  <h2>Summary Content</h2>
  <label><input type="checkbox" id="chk-summary" checked /> Enable Summary</label>
</div>
<div class="view-panel" id="panel-analytics">
  <h2>Analytics Content</h2>
  <label><input type="checkbox" id="chk-analytics" /> Track Metrics</label>
  <div class="clipped-text" id="analytics-clipped">Clipped analytics description text without ellipsis</div>
</div>
<div class="view-panel" id="panel-settings">
  <h2>Settings Content</h2>
  <label><input type="checkbox" id="chk-settings" checked /> Auto-refresh</label>
</div>
</main>
<script>
document.getElementById('menu-trigger').onclick = (e) => {
  const m = document.getElementById('menu-list');
  const open = !m.classList.contains('show');
  m.classList.toggle('show', open);
  e.currentTarget.setAttribute('aria-expanded', String(open));
};
function showPanel(id) {
  document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  document.getElementById('menu-list').classList.remove('show');
  document.getElementById('menu-trigger').setAttribute('aria-expanded', 'false');
}
document.getElementById('opt-summary').onclick = (e) => { e.preventDefault(); showPanel('panel-summary'); };
document.getElementById('opt-analytics').onclick = (e) => { e.preventDefault(); showPanel('panel-analytics'); };
document.getElementById('opt-settings').onclick = (e) => { e.preventDefault(); showPanel('panel-settings'); };
</script></body></html>`);
    });

    await new Promise<void>((r) => multiSite.listen(0, '127.0.0.1', r));
    multiUrl = `http://127.0.0.1:${(multiSite.address() as AddressInfo).port}`;

    const testC = await launchForTest({ baseUrl: multiUrl, blockExternal: true });
    try {
      const guard = new ActionGuard({ keywords: config.dangerousActions.keywords, allowMethods: config.dangerousActions.allowMethods, origin: multiUrl });
      testC.setRequestGuard(guard.asRequestGuard());
      await testC.navigate(multiUrl);
      await testC.settle(150);
      const model = await buildPageModel(testC);
      const plan = selectTests(classifyPage(model), model, config);

      const results: FunctionalResult[] = await runFunctionalTests({
        controller: testC,
        guard,
        pageUrl: testC.page.url(),
        model,
        config,
        budget: new ActionBudget(150),
        plan,
      });

      // 1. Every option in the menu was clicked
      const optionResults = results.filter((r) => r.check === 'disclosure-option');
      expect(optionResults.length).toBe(3);
      expect(optionResults.map((r) => r.element?.name).sort()).toEqual(['Analytics View', 'Settings View', 'Summary View']);
      expect(optionResults.every((r) => r.status === 'pass')).toBe(true);

      // 2. Each resulting state was audited (detecting clipped text revealed in Analytics View)
      const auditFindings = results.filter((r) => r.check === 'geometry.text-clipping');
      expect(auditFindings.length).toBeGreaterThan(0);
      expect(auditFindings[0]?.status).toBe('fail');

      // 3. Safe controls inside newly revealed states were tested and restored
      const checkboxResults = results.filter((r) => r.check.startsWith('reversible-'));
      expect(checkboxResults.length).toBeGreaterThanOrEqual(2);
    } finally {
      await testC.close();
      multiSite.closeAllConnections?.();
      await new Promise((r) => multiSite.close(() => r(undefined)));
    }
  }, 60_000);
});
