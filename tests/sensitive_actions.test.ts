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
const mk = (origin: string) => new ActionGuard({ keywords: config.dangerousActions.keywords, allowMethods: config.dangerousActions.allowMethods, origin });

describe('sensitive settings are refused by the guard before they are operated', () => {
  const g = mk('https://app.test');
  it('a checkbox, switch, slider or select under a permission / role / access context is blocked, whatever its own label says', () => {
    for (const kind of ['check', 'select', 'press'] as const) {
      expect(g.check({ kind, name: 'Send Share Copy', context: 'Edit Roles > Permissions (Partner sales)' }), kind).toMatchObject({ allowed: false, tier: 'sensitive', matched: 'sensitive-setting' });
    }
    expect(g.check({ kind: 'check', name: 'Can export reports', context: 'Access control' }).allowed).toBe(false);
    expect(g.check({ kind: 'check', name: 'Grant admin privileges' }).allowed).toBe(false); // its own label is enough
    expect(g.check({ kind: 'select', name: 'Level', context: 'Security settings' }).allowed).toBe(false);
  });
  it('ordinary settings, lookups, and navigation inside the same view stay allowed', () => {
    expect(g.check({ kind: 'check', name: 'Compact view', context: 'Display options' }).allowed).toBe(true);
    expect(g.check({ kind: 'select', name: 'Rows per page', context: 'Orders' }).allowed).toBe(true);
    expect(g.check({ kind: 'fill', name: 'Search for records', fieldType: 'text', context: 'Edit Roles > Permissions' }).allowed).toBe(true); // looking up is not changing
    expect(g.check({ kind: 'fill', name: 'q', fieldType: 'search', context: 'Roles' }).allowed).toBe(true);
    expect(g.check({ kind: 'fill', name: 'Role name', fieldType: 'text', context: 'Create role' }).allowed).toBe(true); // typing a name sets no permission
    // a tab or menu is a click that shows something: its label naming permissions does not make it a permission change
    expect(g.check({ kind: 'click', name: 'Permissions', text: 'Permissions' }).allowed).toBe(true);
    expect(g.check({ kind: 'click', name: 'Marketing functions', text: 'Marketing functions' }).allowed).toBe(true);
  });
  it('a page or section heading alone is circumstantial: harmless purposes pass, anything that could set a permission is refused', () => {
    // selecting rows on a page called "Roles" changes nothing
    expect(g.check({ kind: 'check', name: 'Partner sales Active', heading: 'Roles', purpose: 'row-selection' }).allowed).toBe(true);
    expect(g.check({ kind: 'check', name: 'Select all', heading: 'Roles', purpose: 'row-selection' }).allowed).toBe(true);
    // arranging the list is not a permission either
    expect(g.check({ kind: 'select', name: 'Rows per page', heading: 'Roles' }).allowed).toBe(true);
    expect(g.check({ kind: 'select', name: 'Sort by', heading: 'Permissions' }).allowed).toBe(true);
    // purpose not established under such a heading: it COULD set a permission, so it is refused
    expect(g.check({ kind: 'check', name: 'Auto-approve', heading: 'Role defaults' })).toMatchObject({ allowed: false, tier: 'sensitive' });
    expect(g.check({ kind: 'press', name: 'Level', heading: 'Permissions' }).allowed).toBe(false);
    // what directly governs the control (dialog, fieldset, tab panel, table column) is decisive: no purpose exempts it
    expect(g.check({ kind: 'check', name: 'Contacts', context: 'Edit Roles > Permissions', purpose: 'row-selection' }).allowed).toBe(false);
    expect(g.check({ kind: 'check', name: '', context: 'Can delete', heading: 'Team' }).allowed).toBe(true); // an ordinary column
    expect(g.check({ kind: 'check', name: '', context: 'Admin privileges', heading: 'Team' }).allowed).toBe(false); // a permission column
    // an ordinary page is untouched
    expect(g.check({ kind: 'check', name: 'Compact view', heading: 'Display options' }).allowed).toBe(true);
  });
});

/**
 * A page with a record editor full of permission controls, an ordinary setting, a button that brings up a security
 * confirmation, and a button that asks with a native confirm(). Every handler reports to the server when it RUNS, so
 * "blocked before the click handler executes" and "nothing was confirmed" are checked from outside the browser.
 */
describe('permission controls and unexpected dialogs in a real page (browser)', () => {
  let site: http.Server; let url: string; let c: BrowserController;
  const log: Record<string, string[]> = {};
  const hits: Record<string, number> = {};

  beforeAll(async () => {
    site = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      hits[`${req.method} ${u.pathname}`] = (hits[`${req.method} ${u.pathname}`] ?? 0) + 1;
      if (u.pathname === '/did') { const k = u.searchParams.get('c')!; (log[k] ??= []).push(u.searchParams.get('v') ?? ''); res.end('ok'); return; }
      if (u.pathname.startsWith('/api/')) { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); return; }
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><html lang="en"><head><title>Roles</title>
<style>body{font-family:sans-serif;margin:24px}td,th{border:1px solid #ccc;padding:6px 10px}td[data-action]{cursor:pointer}label{display:block;margin:6px 0}
#editor{display:none;border:1px solid #999;padding:16px;margin-top:16px}.pane{display:none;padding:10px}.pane.active{display:block}ul.tabs{list-style:none;display:flex;gap:12px;padding:0}ul.tabs li.active a{font-weight:bold}
#warn{display:none;position:fixed;inset:25% 30%;background:#fff;border:2px solid #b00;padding:20px}#help{display:none;border:1px solid #999;padding:10px;margin-top:10px}</style></head><body>
<main><h1>Roles</h1>
<table id="list"><thead><tr><th><input type="checkbox" id="all"></th><th>Name</th><th>Status</th></tr></thead>
  <tbody><tr><td><input type="checkbox" class="rowsel" data-k="r1"></td><td data-action="view">Partner sales</td><td data-action="view">Active</td></tr>
  <tr><td><input type="checkbox" class="rowsel" data-k="r2"></td><td data-action="view">Support</td><td data-action="view">Active</td></tr></tbody></table>
<label><input type="checkbox" id="auto"> Auto-approve new members</label>

<section><h2>Display options</h2><label><input type="checkbox" id="compact"> Compact view</label></section>
<section><h2>Maintenance</h2>
  <button type="button" id="recalc">Recalculate totals</button>
  <button type="button" id="sync">Sync now</button>
  <button type="button" id="helpbtn">Show help</button>
  <div id="help"><h3>Help</h3><label><input type="checkbox" id="tips" checked> Show tips</label></div></section>

<div id="editor" role="dialog" aria-label="Edit Roles > Permissions (Partner sales)"><h2>Edit Roles &gt; Permissions (Partner sales)</h2>
  <ul class="tabs" id="tabs"><li class="active"><a href="#g" data-pane="g">Getting started</a></li><li><a href="#m" data-pane="m">Permissions</a></li></ul>
  <div class="pane active" id="g">
    <label><input type="checkbox" class="perm" data-k="p1"> Send</label>
    <label><input type="checkbox" class="perm" data-k="p2" checked> Share</label>
    <label>Level <input type="range" class="perm" data-k="p3" min="0" max="4" value="2"></label>
    <label>Scope <select class="perm" data-k="p4"><option value="own" selected>Own</option><option value="all">All</option></select></label>
  </div>
  <div class="pane" id="m"><label><input type="checkbox" class="perm" data-k="p5"> Email campaigns</label></div>
  <button type="button" id="close">Close</button>
</div>

<div id="warn" role="alertdialog" aria-label="Security warning"><p>Security warning: this will change permissions for all users. Are you sure?</p>
  <button type="button" id="yes">Yes, apply</button> <button type="button" id="no">Cancel</button></div>
</main>
<script>
const did = (c, v) => fetch('/did?c=' + c + '&v=' + encodeURIComponent(v == null ? '' : v)).catch(() => null);
const post = (p) => fetch(p, { method: 'POST', body: '{}' }).catch(() => null);
document.querySelectorAll('#list td[data-action]').forEach((td) => td.addEventListener('click', () => { document.getElementById('editor').style.display = 'block'; did('opened', 'row' + td.parentElement.rowIndex); }));
// every handler of a permission control reports the moment it RUNS, and the application reacts with its warning
for (const el of document.querySelectorAll('.perm')) for (const ev of ['click', 'input', 'change', 'keydown', 'mousedown', 'pointerdown']) el.addEventListener(ev, () => { did('perm', el.dataset.k + ':' + ev); document.getElementById('warn').style.display = 'block'; });
document.getElementById('tabs').addEventListener('click', (e) => { const a = e.target.closest('a[data-pane]'); if (!a) return; e.preventDefault();
  for (const li of e.currentTarget.children) { const on = li.contains(a); li.classList.toggle('active', on); document.getElementById(li.querySelector('a').dataset.pane).classList.toggle('active', on); } did('tab', a.textContent); });
for (const el of document.querySelectorAll('.rowsel')) el.addEventListener('change', () => did('rowsel', el.dataset.k + ':' + el.checked));
document.getElementById('all').addEventListener('change', (e) => did('selall', e.target.checked));
document.getElementById('auto').addEventListener('click', () => did('auto', 1));
document.getElementById('close').onclick = () => { document.getElementById('editor').style.display = 'none'; did('closed', 1); };
document.getElementById('compact').addEventListener('change', (e) => did('compact', e.target.checked));
document.getElementById('tips').addEventListener('change', (e) => did('tips', e.target.checked));
document.getElementById('recalc').onclick = () => { did('recalc', 1); document.getElementById('warn').style.display = 'block'; };
document.getElementById('yes').onclick = () => { did('accepted', 1); post('/api/ApplyPermissionChange'); document.getElementById('warn').style.display = 'none'; };
document.getElementById('no').onclick = () => { did('declined', 1); document.getElementById('warn').style.display = 'none'; };
document.getElementById('sync').onclick = () => { if (confirm('Apply the new access rules to every user?')) { did('nativeaccepted', 1); post('/api/ApplyAccessRules'); } else did('nativedeclined', 1); };
document.getElementById('helpbtn').onclick = () => { document.getElementById('help').style.display = 'block'; did('help', 1); };
</script></body></html>`);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    c = await launchForTest({ baseUrl: url, blockExternal: true });
  }, 60_000);
  afterAll(async () => { await c?.close(); site?.closeAllConnections?.(); await new Promise((r) => site.close(() => r(undefined))); });

  it('blocks every permission control before its handler runs, never confirms a dialog, and keeps testing what is safe', async () => {
    const guard = mk(url);
    c.setRequestGuard(guard.asRequestGuard());
    await c.navigate(url); await c.settle(150);
    const model = await buildPageModel(c);
    const plan = selectTests(classifyPage(model), model, config);
    const results: FunctionalResult[] = await runFunctionalTests({ controller: c, guard, pageUrl: c.page.url(), model, config, budget: new ActionBudget(600), plan });
    const say = results.map((r) => `${r.kind}/${r.check} | ${r.element?.name} | ${r.status} | ${r.actual}`).join('\n');
    const named = (re: RegExp) => results.filter((r) => re.test(r.element?.name ?? ''));

    // ---- the editor really was opened, so the permission controls really were on screen
    expect(log.opened?.length, say).toBeGreaterThan(0);
    expect(results.some((r) => r.check === 'entry-open' && r.status === 'pass'), say).toBe(true);

    // ---- 1. every permission control was refused BEFORE anything touched it: none of its handlers ever ran
    expect(log.perm, `permission handlers ran: ${String(log.perm)}\n${say}`).toBeUndefined();
    for (const label of [/^Send$/, /^Share$/, /^Level/, /^Scope/, /^Email campaigns$/]) {
      const r = named(label);
      // the slider may not be visited at all; whenever a permission control IS visited, it is refused
      if (!/Level/.test(String(label))) expect(r.length, `${label}\n${say}`).toBeGreaterThan(0);
      if (r.length === 0) continue;
      expect(r.every((x) => x.check === 'guard' && classifyResult(x) === 'BLOCKED_BY_SAFETY'), `${label}\n${say}`).toBe(true);
      expect(r[0]!.actual).toMatch(/changes a permission or access setting \(in "Edit Roles > Permissions \(Partner sales\)/);
    }

    // ---- 2. harmless navigation inside the same sensitive view stayed testable
    expect(results.filter((r) => r.check === 'tab-switch').map((r) => [r.element?.name, r.status]), say).toEqual([['Permissions', 'pass']]); // going to a tab called Permissions changes no permission
    expect(log.tab).toContain('Permissions');
    // row selection on a page called "Roles" is not a permission change: it was operated, not blocked
    expect(log.rowsel?.length, `row selection was operated
${say}`).toBeGreaterThan(0);
    expect(log.selall?.length ?? 0, say).toBeGreaterThan(0);
    expect(results.filter((r) => r.check === 'guard' && /Partner sales|Support/.test(r.element?.name ?? '')), say).toEqual([]);
    // a setting on that page whose purpose is not established could set a permission: refused, its handler never ran
    expect(log.auto).toBeUndefined();
    expect(named(/Auto-approve/).map((r) => [r.check, classifyResult(r)]), say).toEqual([['guard', 'BLOCKED_BY_SAFETY']]);
    expect(named(/Auto-approve/)[0]!.actual).toMatch(/under "Roles", purpose not established/);
    // ...and an ordinary setting elsewhere on the page was still tested and put back
    expect(named(/Compact view/).map((r) => r.status), say).toContain('pass');
    expect(log.compact?.[0]).toBe('true'); // it really was operated

    // ---- 3. the security dialog was identified and declined; nothing affirmative was ever clicked
    const dialogs = results.filter((r) => r.check === 'unexpected-dialog');
    expect(dialogs.map((r) => [r.element?.name, r.status]), say).toEqual([['Recalculate totals', 'inconclusive']]);
    expect(dialogs[0]!.actual).toMatch(/an unexpected confirmation dialog appeared \("Security warning: this will change permissions for all users\. Are you sure\?.*buttons: Yes, apply, Cancel\); dismissed with its "Cancel" control\. Nothing was confirmed/);
    expect(log.declined).toEqual(['1']);
    expect(log.accepted).toBeUndefined();
    // the native confirm() was cancelled, never accepted, and that is NOT reported as a verified action
    expect(log.nativedeclined).toEqual(['1']);
    expect(log.nativeaccepted).toBeUndefined();
    const sync = named(/^Sync now$/);
    expect(sync.map((r) => [r.check, classifyResult(r)]), say).toEqual([['native-dialog-cancelled', 'INCONCLUSIVE']]);
    expect(sync[0]!.actual).toMatch(/asked for confirmation with a native confirm dialog \("Apply the new access rules to every user\?"\)\. It was safely cancelled \(never accepted\), so the intended action was not performed and is not verified/);
    expect(results.some((r) => /Sync now/.test(r.element?.name ?? '') && r.status === 'pass'), say).toBe(false);
    // and no write of any kind left the browser
    expect(Object.keys(hits).filter((k) => !k.startsWith('GET '))).toEqual([]);

    // ---- 4. the run went on after the blocked controls and the dismissed dialog
    expect(log.help).toEqual(['1']);
    expect(named(/Show tips/).map((r) => r.status), say).toContain('pass');
    expect(log.tips).toEqual(['false', 'true']);

    // nothing here is a bug
    expect(results.filter((r) => r.status === 'fail').map((r) => `${r.check}: ${r.actual}`), say).toEqual([]);
  }, 300_000);
});
