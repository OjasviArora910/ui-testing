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
 * A list page built the way many applications build them: no semantic buttons in the rows. The record opens from its
 * name cell through a handler DELEGATED from the table (kept in a jQuery-style registry), from an icon-only div, and
 * there are destructive icons, an unlabelled clickable cell and a whole-row click next to them.
 * The page reports every click and every control change to the server, so what really happened is checked from outside.
 */
describe('generic row entry controls and the UI they reveal (browser)', () => {
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
<style>body{font-family:sans-serif;margin:24px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 10px}
.rname{color:#06c;cursor:pointer}.ico{display:inline-block;width:20px;height:20px;background:#888;cursor:pointer}
#editor{display:none;border:1px solid #999;padding:16px;margin-top:16px}#help{display:none;position:fixed;inset:20% 30%;background:#fff;border:1px solid #333;padding:20px}label{display:block;margin:6px 0}</style></head><body>
<main><h1>Roles</h1>
<a id="create" href="#"><span>C</span><span>r</span><span>e</span><span>a</span><span>t</span><span>e</span></a>
<button type="button" id="helpbtn">Show help</button>
<table id="roles">
  <tr><th>Name</th><th>Users</th><th>Status</th><th></th></tr>
  <tr><td><span class="rname">Alpha role</span></td><td>3</td><td><span class="st">Active</span></td><td><div class="ico ico-pencil" data-k="pencil1"></div> <span class="ico ico-trash" data-k="trash1"></span> <span class="ico" title="Remove" data-k="remove1"></span></td></tr>
  <tr><td><span class="rname">Beta role</span></td><td>1</td><td><span class="st">Active</span></td><td><div class="ico ico-pencil" data-k="pencil2"></div> <span class="ico ico-trash" data-k="trash2"></span> <span class="ico" title="Remove" data-k="remove2"></span></td></tr>
</table>
<table id="plain">
  <tr><th>Item</th></tr>
  <tr id="wholerow1" style="cursor:pointer"><td>Whole row one</td></tr>
  <tr id="wholerow2" style="cursor:pointer"><td>Whole row two</td></tr>
</table>
<div id="editor"><h2>Edit role</h2>
  <label>Contacts access <input type="range" id="perm" min="0" max="4" value="2"></label>
  <label><input type="checkbox" id="notify" checked> Send notifications</label>
  <label><input type="checkbox" id="lock"> Lock Out</label>
  <label>Scope <select id="scope"><option value="own">Own</option><option value="team" selected>Team</option></select></label>
  <button type="button" id="save">Save</button> <button type="button" id="del">Delete</button>
</div>
<div id="help" role="dialog" aria-label="Help"><p>How roles work.</p><button type="button" id="helpclose">Close</button></div>
</main>
<script>
const did = (c, v) => fetch('/did?c=' + c + '&v=' + encodeURIComponent(v == null ? '' : v)).catch(() => null);
const post = (p) => fetch(p, { method: 'POST', body: '{}' }).catch(() => null);
// a jQuery-style event registry with real delegation: the handlers are not on the elements themselves
const registry = new WeakMap();
window.jQuery = { _data: (el, key) => (key === 'events' ? registry.get(el) : undefined) };
const delegate = (root, selector, fn) => {
  const ev = registry.get(root) || { click: [] }; ev.click.push({ selector, handler: fn }); registry.set(root, ev);
  root.addEventListener('click', (e) => { const t = e.target.closest(selector); if (t && root.contains(t)) fn(t); });
};
const openEditor = (who) => { document.getElementById('editor').style.display = 'block'; did('open', who); };
const table = document.getElementById('roles');
delegate(table, 'span.rname', (t) => openEditor(t.textContent));
delegate(table, '.ico-pencil', (t) => openEditor(t.dataset.k));
delegate(table, '.ico-trash', (t) => { did('trash', t.dataset.k); post('/api/DeleteRole'); });
delegate(table, 'span[title=Remove]', (t) => { did('remove', t.dataset.k); post('/api/RemoveRole'); });
delegate(table, 'span.st', (t) => did('status', t.textContent));
document.querySelectorAll('#plain tr[id]').forEach((r) => { r.onclick = () => did('wholerow', r.id); });
document.getElementById('create').onclick = () => { did('create', 1); post('/api/CreateRole'); };
document.getElementById('save').onclick = () => { did('save', 1); post('/api/SaveRole'); };
document.getElementById('del').onclick = () => { did('delete', 1); post('/api/DeleteRole'); };
document.getElementById('helpbtn').onclick = () => { document.getElementById('help').style.display = 'block'; };
document.getElementById('helpclose').onclick = () => { document.getElementById('help').style.display = 'none'; did('helpclosed', 1); };
for (const id of ['perm', 'scope']) document.getElementById(id).addEventListener('input', (e) => did(id, e.target.value));
for (const id of ['notify', 'lock']) document.getElementById(id).addEventListener('change', (e) => did(id, e.target.checked));
</script></body></html>`);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    c = await launchForTest({ baseUrl: url, blockExternal: true });
  }, 60_000);
  afterAll(async () => { await c?.close(); site?.closeAllConnections?.(); await new Promise((r) => site.close(() => r(undefined))); });

  it('finds the safe row entry controls from evidence, opens the editor, tests and restores what is inside, and never mutates', async () => {
    const guard = new ActionGuard({ keywords: config.dangerousActions.keywords, allowMethods: config.dangerousActions.allowMethods, origin: url });
    c.setRequestGuard(guard.asRequestGuard());
    await c.navigate(url); await c.settle(150);
    const model = await buildPageModel(c);
    const plan = selectTests(classifyPage(model), model, config);
    const bySel = (sub: string) => model.interactive.filter((e) => e.selector.includes(sub) || e.name === sub);

    // ---- discovery: both kinds of evidence are required
    const name = model.interactive.find((e) => e.name === 'Alpha role')!;
    expect(name, JSON.stringify(model.rowCandidates, null, 1)).toMatchObject({ type: 'interactive', visible: true, meta: { entry: 'row' } });
    expect(String(name.meta!.entryEvidence)).toMatch(/delegated click handler \(span\.rname\).*primary label of a repeated row/);
    const pencils = model.interactive.filter((e) => e.meta?.entry === 'labelled' && e.name === 'pencil');
    expect(pencils).toHaveLength(2);
    // never discovered as controls: destructive icons, an unlabelled clickable cell, whole-row clicks
    const names = model.interactive.map((e) => `${e.name}|${e.selector}`).join('\n');
    expect(model.interactive.some((e) => /ico-trash|trash/.test(String(e.meta?.className)))).toBe(false);
    expect(model.interactive.some((e) => e.name === 'Remove')).toBe(false);
    expect(model.interactive.some((e) => e.name === 'Active'), names).toBe(false);
    expect(bySel('wholerow')).toEqual([]);
    // the record says why, for each
    const why = (re: RegExp) => model.rowCandidates!.filter((r) => re.test(`${r.className} ${r.text}`)).map((r) => r.decision);
    expect(why(/ico-trash/)[0]).toMatch(/not selected: its label names a destructive or mutating action/);
    expect(why(/Active/)[0]).toMatch(/not selected: clickable text in a row, but not the row's primary label/);
    expect(why(/rname/)[0]).toMatch(/entry control \(row: Alpha role\)/);

    // ---- selection: one of each kind (rows repeat), plus the blocked Create and the ordinary button
    const chosen = plan.buttons.map((b) => b.element.name);
    expect(chosen.filter((n) => n === 'Alpha role' || n === 'Beta role')).toEqual(['Alpha role']);
    expect(chosen.filter((n) => n === 'pencil')).toHaveLength(1);
    expect(chosen).toEqual(expect.arrayContaining(['Create', 'Show help']));

    // ---- run, recording the order of guard decisions and real clicks
    const order: string[] = [];
    const check = guard.check.bind(guard);
    guard.check = (a) => { const d = check(a); if (a.kind === 'click') order.push(`guard:${a.name ?? a.text}:${d.allowed ? 'allowed' : 'blocked'}`); return d; };
    const click = c.click.bind(c);
    c.click = (t, o) => { order.push(`click:${'css' in t ? t.css : JSON.stringify(t)}`); return click(t, o); };
    const results: FunctionalResult[] = await runFunctionalTests({ controller: c, guard, pageUrl: c.page.url(), model, config, budget: new ActionBudget(400), plan });
    const say = results.map((r) => `${r.kind}/${r.check} | ${r.element?.name} | ${r.status} | ${r.actual}`).join('\n');
    const of = (n: RegExp, checkName?: string) => results.filter((r) => n.test(r.element?.name ?? '') && (!checkName || r.check === checkName));

    // Create (also when spelled "C r e a t e") is blocked before any click, and exploration goes on after it
    expect(of(/^Create$/).map((r) => [r.check, classifyResult(r)]), say).toEqual([['guard', 'BLOCKED_BY_SAFETY']]);
    expect(log.create).toBeUndefined();
    expect(order.indexOf('guard:Create:blocked'), order.join('\n')).toBeGreaterThanOrEqual(0);
    expect(order.some((o) => o.startsWith('click:') && /create/i.test(o))).toBe(false);
    // every real click on a planned control was preceded by an allowing guard decision for that control
    for (const b of plan.buttons.filter((x) => x.element.name !== 'Create')) {
      const g = order.indexOf(`guard:${b.element.name}:allowed`);
      expect(g, `${b.element.name}\n${order.join('\n')}`).toBeGreaterThanOrEqual(0);
    }
    expect(order.findIndex((o) => o.startsWith('click:'))).toBeGreaterThan(order.findIndex((o) => o.startsWith('guard:')));

    // the row entry controls opened the editor: concrete proof, not "something changed"
    expect(of(/^Alpha role$/, 'entry-open').map((r) => r.status), say).toEqual(['pass']);
    expect(of(/^Alpha role$/, 'entry-open')[0]!.actual).toMatch(/opened: new content was shown \("Edit role"\): \d+ control\(s\), 1 heading\(s\)/);
    expect(of(/^pencil$/, 'entry-open').map((r) => r.status), say).toEqual(['pass']);
    expect(log.open).toEqual(expect.arrayContaining(['Alpha role', 'pencil1']));
    expect((log.open ?? []).some((v) => /Beta|pencil2/.test(v))).toBe(false); // one row is enough

    // inside the revealed editor: reversible controls were tested and put back exactly
    expect(of(/Contacts access/, 'reversible-slider').every((r) => r.status === 'pass'), say).toBe(true);
    expect(of(/Contacts access/, 'reversible-slider').length).toBeGreaterThan(0);
    expect(of(/Send notifications/, 'reversible-toggle').every((r) => r.status === 'pass') && of(/Send notifications/).length > 0, say).toBe(true);
    expect(of(/Scope/, 'reversible-select').length, say).toBeGreaterThan(0);
    for (const [control, start] of Object.entries({ perm: '2', notify: 'true', scope: 'team' })) {
      const v = log[control] ?? [];
      expect(v.some((x) => x !== start), `${control} changed: ${v.join(',')}`).toBe(true);
      expect(v.length % 2, `${control} changes come in change/restore pairs: ${v.join(',')}`).toBe(0);
      expect(v[v.length - 1], `${control} restored: ${v.join(',')}`).toBe(start);
    }

    // mutating and destructive controls stayed untouched, on the page and inside the editor
    for (const k of ['save', 'delete', 'trash', 'remove', 'lock', 'wholerow', 'status']) expect(log[k], `${k}: ${String(log[k])}`).toBeUndefined();
    for (const p of ['POST /api/CreateRole', 'POST /api/SaveRole', 'POST /api/DeleteRole', 'POST /api/RemoveRole']) expect(hits[p], p).toBeUndefined();
    expect(of(/Lock Out/).every((r) => classifyResult(r) === 'BLOCKED_BY_SAFETY'), say).toBe(true);

    // a dialog opened by an ordinary button (no declared trigger) was tested then: opened, closed with its close control
    expect(of(/^Show help$/, 'modal-close').map((r) => r.status), say).toEqual(['pass']);
    expect(log.helpclosed?.length).toBeGreaterThan(0);

    // nothing here is a failure
    expect(results.filter((r) => r.status === 'fail').map((r) => `${r.check}: ${r.actual}`), say).toEqual([]);
  }, 240_000);
});
