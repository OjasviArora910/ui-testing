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
 * IN-PAGE PANELS IN A FRAGMENT-ROUTED APPLICATION. The regression this guards: the application's own address is a
 * fragment (/#setup/records), and a view inside it is switched by links whose href names a panel of the same document
 * (href="#_abc_people"). Those links were taken for addresses of the application, followed as navigations, and reported
 * inconclusive because "the browser is not at the destination" -- which it never will be: the application shows the
 * panel and leaves the address alone.
 *
 * Also guarded: a panel whose data request is stopped by the safety policy is not a pass (its content never loaded),
 * and a request the page shell sent while loading is not blamed on a control.
 */
describe('links that name a panel of the same document are exercised in place (browser)', () => {
  let site: http.Server; let url: string; let c: BrowserController;
  const hits: Record<string, number> = {};
  const log: Record<string, string[]> = {};

  beforeAll(async () => {
    site = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      hits[`${req.method} ${u.pathname}`] = (hits[`${req.method} ${u.pathname}`] ?? 0) + 1;
      if (u.pathname === '/did') { (log[u.searchParams.get('c')!] ??= []).push(u.searchParams.get('v') ?? ''); res.end('ok'); return; }
      if (u.pathname.startsWith('/api/')) { res.setHeader('content-type', 'application/json'); res.end('{"rows":["one","two"]}'); return; }
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><html lang="en"><head><title>Records</title>
<style>body{font-family:sans-serif;margin:24px}td,th{border:1px solid #ccc;padding:6px 10px}td[data-action]{cursor:pointer}label{display:block;margin:6px 0}
#editor{display:none;border:1px solid #999;padding:16px;margin-top:16px}.sec{display:none;padding:10px}.sec.on{display:block}.pane{display:none}.pane.on{display:block}
#menu{display:none;border:1px solid #aaa;padding:6px;list-style:none;margin:0}#menu.open{display:block}#kinds{list-style:none;display:flex;gap:14px;padding:0}</style></head><body>
<main><h1>Records</h1>
<table id="rows"><tr><th>Name</th><th>Status</th></tr>
  <tr><td data-action="view">First record</td><td data-action="view">Active</td></tr>
  <tr><td data-action="view">Second record</td><td data-action="view">Active</td></tr></table>

<div id="editor"><h2 id="title">Record > Overview</h2>
  <button type="button" id="more" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">More</button>
  <ul id="menu"><li><a href="#" data-sec="overview">Overview</a></li><li><a href="#" data-sec="members">Members</a></li></ul>
  <div class="sec on" id="overview"><label><input type="checkbox" id="pin"> Pin this record</label></div>
  <div class="sec" id="members">
    <!-- the links name panels of this document; the application's own address stays /#setup/records -->
    <ul id="kinds">
      <li><a href="#_abc123_people">People</a></li>
      <li><a href="#_abc123_teams">Teams</a></li>
      <li><a href="#_abc123_partners">Partners</a></li>
    </ul>
    <div class="pane on" id="_abc123_people"><label><input type="checkbox" id="p1" checked> Show inactive people</label></div>
    <div class="pane" id="_abc123_teams"><label>Order <select id="t1"><option value="az" selected>A to Z</option><option value="za">Z to A</option></select></label></div>
    <div class="pane" id="_abc123_partners"><label><input type="checkbox" id="q1"> Compact rows</label><p id="partnerRows">Loading</p></div>
  </div>
  <button type="button" id="close">Close</button>
</div></main>
<script>
const did = (c, v) => fetch('/did?c=' + c + '&v=' + encodeURIComponent(v == null ? '' : v)).catch(() => null);
const post = (p) => fetch(p, { method: 'POST', body: '{}' });
// the shell asks for its own data when the page loads: nothing to do with what is clicked later
post('/api/GetShellStatus').catch(() => null);
document.querySelectorAll('#rows td[data-action]').forEach((td) => td.addEventListener('click', () => { document.getElementById('editor').style.display = 'block'; did('opened', 'row' + td.parentElement.rowIndex); }));
const more = document.getElementById('more'); const menu = document.getElementById('menu');
const setMenu = (open) => { menu.classList.toggle('open', open); more.setAttribute('aria-expanded', String(open)); };
more.onclick = () => setMenu(!menu.classList.contains('open'));
menu.addEventListener('click', (e) => { const a = e.target.closest('a[data-sec]'); if (!a) return; e.preventDefault();
  document.querySelectorAll('.sec').forEach((s) => s.classList.toggle('on', s.id === a.dataset.sec));
  document.getElementById('title').textContent = 'Record > ' + a.textContent; setMenu(false); did('section', a.dataset.sec); });
document.getElementById('kinds').addEventListener('click', (e) => { const a = e.target.closest('a'); if (!a) return;
  e.preventDefault(); // the address is left alone
  const id = a.getAttribute('href').slice(1);
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.id === id));
  did('kind', id.split('_').pop());
  // one panel needs data from the server to show its rows
  if (id.endsWith('partners')) post('/api/GetPartnerRows').then((r) => r.json()).then((d) => { document.getElementById('partnerRows').textContent = d.rows.join(', '); }).catch(() => null); });
for (const id of ['pin', 'p1', 'q1']) document.getElementById(id).addEventListener('change', (e) => did(id, e.target.checked));
document.getElementById('t1').addEventListener('change', (e) => did('t1', e.target.value));
document.getElementById('close').onclick = () => { document.getElementById('editor').style.display = 'none'; };
</script></body></html>`);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    c = await launchForTest({ baseUrl: url, blockExternal: true });
  }, 60_000);
  afterAll(async () => { await c?.close(); site?.closeAllConnections?.(); await new Promise((r) => site.close(() => r(undefined))); });

  it('verifies each panel by what is displayed, not by the address, and does not pass a panel whose data was blocked', async () => {
    const guard = new ActionGuard({ keywords: config.dangerousActions.keywords, allowMethods: config.dangerousActions.allowMethods, origin: url });
    c.setRequestGuard(guard.asRequestGuard());
    const home = `${url}/#setup/records`; // the application's own route is a fragment
    await c.navigate(home); await c.settle(600);
    const model = await buildPageModel(c);
    const plan = selectTests(classifyPage(model), model, config);
    const results: FunctionalResult[] = await runFunctionalTests({ controller: c, guard, pageUrl: c.page.url(), model, config, budget: new ActionBudget(900), plan });
    const say = results.map((r) => `${r.kind}/${r.check} | ${r.element?.name} | ${r.status} | ${r.actual}`).join('\n');
    const named = (n: string) => results.filter((r) => r.element?.name === n);

    // ---- the view was reached through the menu
    expect(log.section, say).toContain('members');

    // ---- the panel links were NOT taken for addresses: no navigation was attempted or reported for them
    expect(results.filter((r) => r.check === 'menu-navigation').map((r) => `${r.element?.name}: ${r.actual}`), say).toEqual([]);
    expect(c.page.url(), 'the application address was left alone').toBe(home);

    // ---- a panel that is switched in is verified by concrete evidence: the panel the link names is now displayed
    const teams = named('Teams');
    expect(teams.map((r) => r.status), say).toEqual(['pass']);
    expect(teams[0]!.actual).toMatch(/the panel it names \(#_abc123_teams\) is now displayed/);
    expect(teams[0]!.before, 'before evidence').toBeTruthy();
    expect(teams[0]!.screenshot, 'after evidence').toBeTruthy();
    // ... and what it shows was explored: its control was changed, verified and put back
    expect(log.t1, say).toEqual(['za', 'az']);

    // ---- the panel that is already displayed is verified as that, not left inconclusive
    const people = named('People');
    expect(people.map((r) => r.status), say).toEqual(['pass']);
    expect(people[0]!.actual).toMatch(/already the one displayed/);

    // ---- a panel whose data request the safety policy stopped: reported as blocked, with the request named. Never a pass.
    const partners = named('Partners');
    expect(partners.map((r) => [r.check, r.status, classifyResult(r)]), say).toEqual([['blocked-by-safety', 'blocked', 'BLOCKED_BY_SAFETY']]);
    expect(partners[0]!.actual).toMatch(/blocked the request it sent \(POST \/api\/GetPartnerRows\)/);
    expect(partners[0]!.actual).toMatch(/its content is not verified/);
    expect(hits['POST /api/GetPartnerRows'], 'the blocked request never reached the server').toBeUndefined();
    // its controls are still there and were explored
    expect(log.q1, say).toEqual(['true', 'false']);

    // ---- the shell's own request was blocked too, but is not blamed on any control
    expect(c.blockedRequests.some((b) => b.url.endsWith('/api/GetShellStatus')), 'the shell request was blocked').toBe(true);
    expect(hits['POST /api/GetShellStatus']).toBeUndefined();
    expect(results.filter((r) => /GetShellStatus/.test(r.actual ?? '')).map((r) => `${r.element?.name}: ${r.actual}`), say).toEqual([]);

    // nothing was written and nothing here is a bug
    expect(Object.keys(hits).filter((k) => !k.startsWith('GET ')), say).toEqual([]);
    expect(results.filter((r) => r.status === 'fail').map((r) => `${r.check}: ${r.actual}`), say).toEqual([]);
    for (const k of ['people', 'teams', 'partners']) expect((log.kind ?? []).filter((x) => x === k).length, `${k}: ${String(log.kind)}`).toBeLessThanOrEqual(2);
  }, 300_000);
});
