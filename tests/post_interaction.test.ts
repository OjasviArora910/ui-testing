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
 * POST-INTERACTION EXPLORATION. The regression this guards: a view reached through a menu ("More" -> a section) was
 * opened, described and left, because everything inside it was a plain link or button (no tab role, no active marker,
 * no menu) and plain controls of an opened view were never followed.
 *
 * The fixture is a record editor whose "More" menu shows a "Members" section. That section is navigated by a plain list
 * of links (People / Teams / Partners / History); each shows different content with its own controls. Next to them are a
 * command button, a destructive button and a link that does nothing. Nothing in the engine knows these names. Every
 * handler reports to the server when it RUNS, so what was really clicked, how often and in what order is checked from
 * outside the browser.
 */
describe('a view revealed by an interaction is explored before moving on (browser)', () => {
  let site: http.Server; let url: string; let c: BrowserController;
  const hits: Record<string, number> = {};
  const log: Record<string, string[]> = {};
  const order: string[] = [];

  beforeAll(async () => {
    site = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      hits[`${req.method} ${u.pathname}`] = (hits[`${req.method} ${u.pathname}`] ?? 0) + 1;
      if (u.pathname === '/did') { const k = u.searchParams.get('c')!; const v = u.searchParams.get('v') ?? ''; (log[k] ??= []).push(v); order.push(`${k}:${v}`); res.end('ok'); return; }
      if (u.pathname.startsWith('/api/')) { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); return; }
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><html lang="en"><head><title>Records</title>
<style>body{font-family:sans-serif;margin:24px}td,th{border:1px solid #ccc;padding:6px 10px}td[data-action]{cursor:pointer}label{display:block;margin:6px 0}
#editor{display:none;border:1px solid #999;padding:16px;margin-top:16px}.sec{display:none;padding:10px}.sec.on{display:block}.list{display:none}.list.on{display:block}
#menu{display:none;border:1px solid #aaa;padding:6px;list-style:none;margin:0}#menu.open{display:block}div.plain{display:flex;gap:14px}</style></head><body>
<main><h1>Records</h1>
<table id="rows"><tr><th>Name</th><th>Status</th></tr>
  <tr><td data-action="view">First record</td><td data-action="view">Active</td></tr>
  <tr><td data-action="view">Second record</td><td data-action="view">Active</td></tr></table>

<div id="editor"><h2 id="title">Record > Overview</h2>
  <button type="button" id="more" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">More</button>
  <ul id="menu"><li><a href="#" data-sec="overview">Overview</a></li><li><a href="#" data-sec="members">Members</a></li></ul>

  <div class="sec on" id="overview"><label><input type="checkbox" id="pin"> Pin this record</label></div>

  <div class="sec" id="members">
    <!-- plain links: no list, no role, no "active" class, no menu -->
    <div class="plain" id="kinds">
      <a href="#" data-list="people">People</a>
      <a href="#" data-list="teams">Teams</a>
      <a href="#" data-list="partners">Partners</a>
      <a href="#" data-list="history">History</a>
    </div>
    <div class="list on" id="people"><h3>People</h3><label><input type="checkbox" id="p1" checked> Show inactive people</label></div>
    <div class="list" id="teams"><h3>Teams</h3><label>Order <select id="t1"><option value="az" selected>A to Z</option><option value="za">Z to A</option></select></label></div>
    <div class="list" id="partners"><h3>Partners</h3><label><input type="checkbox" id="q1"> Compact rows</label></div>
    <div class="list" id="history"><h3>History</h3><p>Nothing yet.</p></div>
    <p>
      <button type="button" id="addm">Add member</button>
      <button type="button" id="rem">Remove all</button>
    </p>
  </div>
  <button type="button" id="save">Save</button> <button type="button" id="close">Close</button>
</div></main>
<script>
const did = (c, v) => fetch('/did?c=' + c + '&v=' + encodeURIComponent(v == null ? '' : v)).catch(() => null);
const post = (p) => fetch(p, { method: 'POST', body: '{}' }).catch(() => null);
document.querySelectorAll('#rows td[data-action]').forEach((td) => td.addEventListener('click', () => { document.getElementById('editor').style.display = 'block'; did('opened', 'row' + td.parentElement.rowIndex); }));
const more = document.getElementById('more'); const menu = document.getElementById('menu');
const setMenu = (open) => { menu.classList.toggle('open', open); more.setAttribute('aria-expanded', String(open)); };
more.onclick = () => { setMenu(!menu.classList.contains('open')); did('more', menu.classList.contains('open') ? 'open' : 'shut'); };
menu.addEventListener('click', (e) => { const a = e.target.closest('a[data-sec]'); if (!a) return; e.preventDefault();
  document.querySelectorAll('.sec').forEach((s) => s.classList.toggle('on', s.id === a.dataset.sec));
  document.getElementById('title').textContent = 'Record > ' + a.textContent; setMenu(false); did('section', a.dataset.sec); });
document.getElementById('kinds').addEventListener('click', (e) => { const a = e.target.closest('a[data-list]'); if (!a) return; e.preventDefault();
  did('kind', a.dataset.list);
  if (a.dataset.list === 'history') return; // a link that does nothing
  document.querySelectorAll('.list').forEach((l) => l.classList.toggle('on', l.id === a.dataset.list)); });
for (const id of ['pin', 'p1', 'q1']) document.getElementById(id).addEventListener('change', (e) => did(id, e.target.checked));
document.getElementById('t1').addEventListener('change', (e) => did('t1', e.target.value));
document.getElementById('addm').onclick = () => { did('addm', 1); post('/api/AddMember'); };
document.getElementById('rem').onclick = () => { did('rem', 1); post('/api/RemoveAllMembers'); };
document.getElementById('save').onclick = () => { did('save', 1); post('/api/SaveRecord'); };
document.getElementById('close').onclick = () => { document.getElementById('editor').style.display = 'none'; did('closed', 1); };
</script></body></html>`);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    c = await launchForTest({ baseUrl: url, blockExternal: true });
  }, 60_000);
  afterAll(async () => { await c?.close(); site?.closeAllConnections?.(); await new Promise((r) => site.close(() => r(undefined))); });

  it('follows the plain controls of the revealed view, tests what each shows, and blocks what could change data', async () => {
    const guard = new ActionGuard({ keywords: config.dangerousActions.keywords, allowMethods: config.dangerousActions.allowMethods, origin: url });
    c.setRequestGuard(guard.asRequestGuard());
    await c.navigate(url); await c.settle(150);
    const model = await buildPageModel(c);
    const plan = selectTests(classifyPage(model), model, config);
    const notes: string[] = [];
    const results: FunctionalResult[] = await runFunctionalTests({
      controller: c, guard, pageUrl: c.page.url(), model, config, budget: new ActionBudget(900), plan,
      onAction: (a) => { if (['state', 'not-explored', 'state-coverage'].includes(a.type)) notes.push(`${a.type} | ${a.target} | ${a.detail}`); },
    });
    const say = `${results.map((r) => `${r.kind}/${r.check} | ${r.element?.name} | ${r.status} | ${r.actual}`).join('\n')}\nNOTES\n${notes.join('\n')}\nORDER ${order.join(' ')}`;
    const of = (check: string) => results.filter((r) => r.check === check);
    const named = (re: RegExp) => results.filter((r) => re.test(r.element?.name ?? ''));

    // ---- the menu was opened and its item shown to switch the view (existing behaviour, still true)
    expect(of('disclosure-open').some((r) => r.element?.name === 'More' && r.status === 'pass'), say).toBe(true);
    expect(of('disclosure-option').filter((r) => r.element?.name === 'Members').map((r) => r.status), say).toEqual(['pass']);
    expect(log.section).toContain('members');

    // ---- 1 + 2 + 4: the revealed view was EXPLORED: each plain link in it is a recorded, verified interaction
    const views = of('view-control');
    expect(views.map((r) => r.element?.name).sort(), say).toEqual(['History', 'Partners', 'People', 'Teams']);
    const pass = (n: string) => views.find((r) => r.element?.name === n)!;
    expect(pass('Teams').status, say).toBe('pass');
    expect(pass('Teams').actual).toMatch(/the content shown outside the menu changed \(now showing "Teams"\)/);
    expect(pass('Partners').status, say).toBe('pass');
    expect(pass('Partners').actual).toMatch(/now showing "Partners"/);
    // 9: each verified view carries its own before / after evidence
    for (const n of ['Teams', 'Partners']) { expect(pass(n).before, `${n} before`).toBeTruthy(); expect(pass(n).screenshot, `${n} after`).toBeTruthy(); }

    // ---- 5: the controls each view shows were found THERE and tested (changed, verified, put back)
    for (const [control, start] of Object.entries({ t1: 'az', q1: 'false' })) {
      const v = log[control] ?? [];
      expect(v.length, `${control} was operated\n${say}`).toBe(2);
      expect(v[0]).not.toBe(start);
      expect(v[1]).toBe(start);
    }
    expect(named(/^Order/).some((r) => r.check === 'reversible-select' && r.status === 'pass'), say).toBe(true);
    expect(named(/Compact rows/).some((r) => r.check === 'reversible-toggle' && r.status === 'pass'), say).toBe(true);
    // the control of a sub-view was only operated AFTER its link was followed: explored before moving on
    expect(order.indexOf('kind:teams'), say).toBeGreaterThanOrEqual(0);
    expect(order.findIndex((o) => o.startsWith('t1:')), say).toBeGreaterThan(order.indexOf('kind:teams'));
    expect(order.findIndex((o) => o.startsWith('q1:')), say).toBeGreaterThan(order.indexOf('kind:partners'));

    // ---- 8: a link that does nothing is reported as not verified, never as a pass
    expect(pass('History').status, say).toBe('inconclusive');
    expect(pass('History').actual).toMatch(/nothing could be verified to change/);

    // ---- 5 + 6: no control was clicked again and again, and the menu was not opened and shut in a loop
    for (const k of ['people', 'teams', 'partners', 'history']) expect((log.kind ?? []).filter((x) => x === k).length, `${k} clicked once: ${String(log.kind)}`).toBeLessThanOrEqual(1);
    expect((log.more ?? []).length, `More toggled ${String(log.more)}`).toBeLessThanOrEqual(8);
    const states = notes.filter((n) => n.startsWith('state |')).map((n) => n.split(' | ')[1]);
    expect(new Set(states).size, say).toBe(states.length); // a state is explored once
    expect(states.length).toBeLessThanOrEqual(14);

    // ---- 7: what could change data was never pressed, and is recorded as blocked rather than silently left
    for (const k of ['save', 'rem', 'addm']) expect(log[k], `${k} handler ran\n${say}`).toBeUndefined();
    expect(Object.keys(hits).filter((k) => !k.startsWith('GET ')), say).toEqual([]);
    expect(named(/^Remove all$/).map((r) => [r.check, classifyResult(r)]), say).toEqual([['guard', 'BLOCKED_BY_SAFETY']]);
    expect(named(/^Add member$/).map((r) => [r.check, classifyResult(r)]), say).toEqual([['guard', 'BLOCKED_BY_SAFETY']]);
    expect(named(/^Add member$/)[0]!.actual).toMatch(/its label names a command/);

    // nothing here is a bug
    expect(results.filter((r) => r.status === 'fail').map((r) => `${r.check}: ${r.actual}`), say).toEqual([]);
  }, 300_000);
});
