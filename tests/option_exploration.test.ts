import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserController } from '../src/browser/index.js';
import { buildPageModel } from '../src/discovery/pageModel.js';
import { classifyPage, classifyResult, selectTests } from '../src/dynamic/index.js';
import { ActionBudget, ActionGuard, runFunctionalTests, type ActionLifecycleEvent, type FunctionalResult } from '../src/functional/index.js';
import { loadConfig } from '../src/shared/config.js';
import { launchForTest } from './helpers/launch.js';

const config = loadConfig('qa.config.json', { functional: { maxButtonsPerPage: 40 }, dynamic: { maxGenericButtons: 40 } });

/**
 * A menu is not explored because it opened, and an option is not verified because it was visible or because a click on it
 * did not throw. This page has an editor that is opened from a list; inside it a "More" menu switches between sections in
 * place (the address never changes). One section has fields, a tab group, a menu of its own and a button that would write.
 * One option does nothing at all. Two sections have exactly the same controls and differ only in what they show.
 * Nothing in the engine knows these names; the page reports every click that matters to the server.
 */
const PAGE = `<!doctype html><html lang="en"><head><title>Teams</title><style>
body{font:16px system-ui,sans-serif;margin:24px} button,select,input{font-size:16px;min-height:36px} button{padding:6px 14px}
.dd{position:relative;display:inline-block} .dropdown-menu{position:absolute;top:40px;left:0;margin:0;padding:6px;list-style:none;background:#fff;border:1px solid #888;white-space:nowrap;z-index:5}
.dropdown-menu a{display:block;padding:6px 10px} section{margin:16px 0} .sec{padding:12px;border:1px solid #ccc;margin-top:12px}
</style></head><body><main>
<h1>Teams</h1>
<table><tr><td>Partner Sales</td><td><button type="button" id="edit">Edit team</button></td></tr></table>

<section id="editor" hidden>
  <h2>Edit team: Partner Sales</h2>
  <div class="dd"><button type="button" id="more" class="dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">More</button>
    <ul class="dropdown-menu" id="more-menu" hidden>
      <li class="active"><a href="#" data-s="permissions">Permissions</a></li>
      <li><a href="#" data-s="info">Info</a></li>
      <li><a href="#" data-s="notes">Notes</a></li>
      <li><a href="#" data-s="history">History</a></li>
      <li><a href="#" data-s="assignment">Assignment</a></li>
      <li><a href="#" data-s="">Audit trail</a></li>
    </ul></div>

  <div class="sec" id="sec-permissions"><fieldset><legend>Permissions</legend><label><input type="checkbox" id="perm"> Can approve deals</label></fieldset></div>
  <div class="sec" id="sec-info" hidden><h3>General information</h3><label for="desc">Description</label> <input id="desc" type="text" value="Sells with partners"></div>
  <div class="sec" id="sec-notes" hidden><p>Internal notes about this team are kept here.</p><label for="nf">Filter</label> <input id="nf" type="text"></div>
  <div class="sec" id="sec-history" hidden><p>This team was changed three times this year.</p><label for="hf">Filter</label> <input id="hf" type="text"></div>
  <div class="sec" id="sec-assignment" hidden><h3>Assigned users</h3>
    <label for="find">Find user</label> <input id="find" type="text">
    <label for="sort">Sort by</label> <select id="sort"><option value="name">Name</option><option value="team">Team</option></select>
    <div class="dd"><button type="button" id="cols" class="dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">Columns</button>
      <ul class="dropdown-menu" id="cols-menu" hidden><li><a href="#" data-c="compact">Compact</a></li><li><a href="#" data-c="wide">Wide</a></li></ul></div>
    <p id="layout">Layout: default</p>
    <div role="tablist" aria-label="Members"><button type="button" role="tab" id="t-users" aria-selected="true" aria-controls="p-users">Users</button><button type="button" role="tab" id="t-groups" aria-selected="false" aria-controls="p-groups">Groups</button></div>
    <div id="p-users" role="tabpanel"><p>Ada Test, Ben Sample</p></div>
    <div id="p-groups" role="tabpanel" hidden><label for="gf">Group filter</label> <input id="gf" type="text">
      <div class="dd"><button type="button" id="deep" class="dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">Density</button>
        <ul class="dropdown-menu" id="deep-menu" hidden><li><a href="#" data-d="1">Dense</a></li></ul></div></div>
    <button type="button" id="assign">Assign user</button>
  </div>
</section>

<script>
const $ = (s) => document.querySelector(s);
const did = (what) => fetch('/did?c=' + encodeURIComponent(what)).catch(() => {});
$('#edit').onclick = () => { $('#editor').hidden = false; };
function menu(btn, list) { btn.onclick = () => { const open = list.hidden; list.hidden = !open; btn.setAttribute('aria-expanded', String(open)); }; }
const close = (btn, list) => { list.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
menu($('#more'), $('#more-menu')); menu($('#cols'), $('#cols-menu')); menu($('#deep'), $('#deep-menu'));
$('#more-menu').querySelectorAll('a').forEach((a) => a.onclick = (e) => {
  e.preventDefault(); did('more:' + a.textContent); close($('#more'), $('#more-menu'));
  const s = a.dataset.s; if (!s) return; // "Audit trail" closes the menu and does nothing else
  document.querySelectorAll('.sec').forEach((x) => { x.hidden = x.id !== 'sec-' + s; });
  $('#more-menu').querySelectorAll('li').forEach((li) => li.classList.toggle('active', li === a.parentElement));
});
$('#cols-menu').querySelectorAll('a').forEach((a) => a.onclick = (e) => { e.preventDefault(); did('cols:' + a.textContent); close($('#cols'), $('#cols-menu')); $('#layout').textContent = 'Layout: ' + a.dataset.c; });
$('#deep-menu').querySelectorAll('a').forEach((a) => a.onclick = (e) => { e.preventDefault(); did('deep:' + a.textContent); close($('#deep'), $('#deep-menu')); });
document.querySelectorAll('[role=tab]').forEach((t) => t.onclick = () => { did('tab:' + t.textContent); document.querySelectorAll('[role=tab]').forEach((x) => { x.setAttribute('aria-selected', String(x === t)); $('#' + x.getAttribute('aria-controls')).hidden = x !== t; }); });
$('#assign').onclick = () => { fetch('/api/assign', { method: 'POST', body: '{}' }).catch(() => {}); did('assign'); };
$('#perm').onchange = () => did('perm');
</script></main></body></html>`;

describe('a menu option is its own verified action, and the view it opens is explored', () => {
  let site: http.Server; let url: string; let c: BrowserController;
  const did: string[] = []; const methods: string[] = [];

  beforeAll(async () => {
    site = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      methods.push(`${req.method} ${u.pathname}`);
      if (u.pathname === '/did') { did.push(u.searchParams.get('c') ?? ''); return void res.end('ok'); }
      if (u.pathname.startsWith('/api/')) { res.setHeader('content-type', 'application/json'); return void res.end('{}'); }
      res.setHeader('content-type', 'text/html'); res.end(PAGE);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    c = await launchForTest({ baseUrl: url, blockExternal: true });
  }, 60_000);
  afterAll(async () => { await c?.close(); site.closeAllConnections?.(); await new Promise((r) => site.close(() => r(undefined))); });

  async function explore(budget: ActionBudget): Promise<{ results: FunctionalResult[]; actions: ActionLifecycleEvent[] }> {
    const guard = new ActionGuard({ keywords: config.dangerousActions.keywords, allowMethods: config.dangerousActions.allowMethods, origin: url });
    c.setRequestGuard(guard.asRequestGuard());
    await c.navigate(url); await c.settle(150);
    const model = await buildPageModel(c);
    const plan = selectTests(classifyPage(model), model, config);
    const actions: ActionLifecycleEvent[] = [];
    const results = await runFunctionalTests({ controller: c, guard, pageUrl: c.page.url(), model, config, budget, plan, onAction: (a) => { actions.push(a); } });
    return { results, actions };
  }
  const named = (r: FunctionalResult[], name: string, check?: string) => r.filter((x) => x.element?.name === name && (!check || x.check === check));
  const say = (r: FunctionalResult[]) => r.map((x) => `${x.element?.name}: ${x.status} [${x.check}] ${x.actual}`).join('\n');

  describe('with room to explore', () => {
    let results: FunctionalResult[]; let actions: ActionLifecycleEvent[];
    beforeAll(async () => { did.length = 0; methods.length = 0; ({ results, actions } = await explore(new ActionBudget(400))); }, 300_000);
    const options = () => results.filter((x) => x.check === 'disclosure-option');

    it('1. opening the menu is a result about the menu only: no option is marked as tested by it', () => {
      const open = named(results, 'More', 'disclosure-open');
      expect(open.map((x) => x.status), say(results.filter((x) => /More/.test(x.element?.selector ?? '')))).toEqual(['pass']);
      expect(open[0]!.actual).toMatch(/"More" opened and shows: Permissions, Info, Notes, History, Assignment, Audit trail/);
      expect(results.filter((x) => x.check === 'disclosure-open').map((x) => x.element?.name)).not.toContain('Assignment');
    });

    it('2+3. Assignment is exercised as a separate, recorded action after the menu opened, with its own verification', () => {
      const a = named(results, 'Assignment', 'disclosure-option');
      expect(a, say(options())).toHaveLength(1);
      expect(results.indexOf(a[0]!)).toBeGreaterThan(results.indexOf(named(results, 'More', 'disclosure-open')[0]!));
      expect(a[0]).toMatchObject({ status: 'pass', confidence: 'HIGH' });
      // the pass rests on what was seen to change, and says what
      expect(a[0]!.actual).toMatch(/Option "Assignment" was selected in "More": the content shown outside the menu changed \(now showing "Assigned users"\)/);
      expect(a[0]!.element?.selector).toMatch(/Edit team > More > Assignment$/); // the path that led there
      expect(a[0]!.before && a[0]!.screenshot && a[0]!.trace?.changes.length).toBeTruthy();
      expect(did.filter((x) => x === 'more:Assignment')).toHaveLength(1); // it really was clicked, once
    });

    it('4+5. the Assignment view is explored once it is open: its own controls are discovered and tested', () => {
      const inView = results.filter((x) => /Assignment/.test(x.expected) && /^reversible-/.test(x.check));
      expect(inView.map((x) => `${x.element?.name}:${x.status}`), say(results)).toEqual(expect.arrayContaining(['Find user:pass', 'Sort by:pass']));
      const state = actions.filter((x) => x.type === 'state').map((x) => x.target);
      expect(state.some((t) => /More > Assignment$/.test(t))).toBe(true);
    });

    it('6. menus and tabs inside the view are followed in turn (nested exploration)', () => {
      // a menu of its own inside the section
      expect(named(results, 'Columns', 'disclosure-open').map((x) => x.status)).toEqual(['pass']);
      expect(named(results, 'Compact', 'disclosure-option').map((x) => x.status)).toEqual(['pass']);
      expect(named(results, 'Wide', 'disclosure-option').map((x) => x.status)).toEqual(['pass']);
      expect(named(results, 'Wide', 'disclosure-option')[0]!.actual).toMatch(/the content shown outside the menu changed/);
      // a tab inside the section, and the field that only exists on that tab
      expect(named(results, 'Groups', 'tab-switch').map((x) => x.status)).toEqual(['pass']);
      expect(results.filter((x) => x.element?.name === 'Group filter' && /^reversible-/.test(x.check)).map((x) => x.status)).toEqual(['pass']);
      expect(did).toEqual(expect.arrayContaining(['cols:Compact', 'cols:Wide', 'tab:Groups']));
    });

    it('7. other sections reached the same way are explored too, also when their controls look exactly like another one', () => {
      for (const name of ['Info', 'Notes', 'History']) expect(named(results, name, 'disclosure-option').map((x) => x.status), name).toEqual(['pass']);
      const fields = (section: string) => results.filter((x) => new RegExp(`> ${section}"`).test(x.expected) && /^reversible-/.test(x.check)).map((x) => `${x.element?.name}:${x.status}`);
      expect(fields('Info')).toEqual(['Description:pass']);
      // Notes and History have the same single "Filter" field; they are still two views, and each field is tested
      expect(fields('Notes')).toEqual(['Filter:pass']);
      expect(fields('History')).toEqual(['Filter:pass']);
    });

    it('8+9. an option whose click changes nothing is INCONCLUSIVE, never a pass; the menu closing is not evidence', () => {
      const audit = named(results, 'Audit trail', 'disclosure-option');
      expect(audit.map((x) => [x.status, classifyResult(x)]), say(audit)).toEqual([['inconclusive', 'INCONCLUSIVE']]);
      expect(audit[0]!.actual).toMatch(/was clicked in "More", but nothing could be verified to change/);
      expect(did).toContain('more:Audit trail'); // the click did happen: that alone proves nothing
    });

    it('an option that is already the selected choice is verified as that, without inventing a change', () => {
      const perm = named(results, 'Permissions', 'disclosure-option');
      expect(perm.map((x) => [x.status, x.confidence])).toEqual([['pass', 'MEDIUM']]);
      expect(perm[0]!.actual).toMatch(/is already the selected choice in "More" \(it is marked active\): selecting it again changed nothing/);
    });

    it('10. nothing is repeated: every option has exactly one result and was selected once while exploring', () => {
      const counts = new Map<string, number>();
      for (const o of options()) counts.set(o.element?.name ?? '', (counts.get(o.element?.name ?? '') ?? 0) + 1);
      expect([...counts.entries()].filter(([, n]) => n !== 1)).toEqual([]);
      for (const name of ['Info', 'Notes', 'History', 'Assignment', 'Audit trail']) expect(did.filter((x) => x === `more:${name}`), name).toHaveLength(1);
      // menu items are choices, not menus: none of them was "opened" as if it were a dropdown
      expect(results.filter((x) => x.check === 'disclosure-open').map((x) => x.element?.name).sort()).toEqual(['Columns', 'More']);
    });

    it('11. the view the menu was opened in is restored by selecting its option, so nothing after it is lost', () => {
      const restores = actions.filter((x) => x.type === 'restore');
      expect(restores.filter((x) => !x.ok).map((x) => `${x.target}: ${x.detail}`)).toEqual([]);
      expect(restores.some((x) => x.target === 'More' && x.ok && /shown again by selecting its option/.test(x.detail ?? ''))).toBe(true);
      // "Permissions" was selected a second time for exactly that purpose, and nothing else was
      expect(did.filter((x) => x === 'more:Permissions')).toHaveLength(2);
    });

    it('12. safety holds inside the explored views: no write left the browser, the permission was not touched, the writing button was not clicked', async () => {
      expect(methods.filter((m) => !m.startsWith('GET '))).toEqual([]);
      expect(did).not.toContain('assign');
      expect(did).not.toContain('perm');
      expect(await c.page.evaluate("document.getElementById('perm').checked")).toBe(false);
      expect(named(results, 'Can approve deals').filter((x) => x.status === 'pass')).toEqual([]);
      // what was left as found is named, so the record does not read as complete
      const coverage = actions.filter((x) => x.type === 'state-coverage').map((x) => x.detail ?? '').join(' | ');
      expect(coverage).toMatch(/left as found[^|]*Assign user/);
    });

    it('13. a limit that stops the exploration is recorded with what it left out', () => {
      // the menu on the second tab sits one level deeper than the nesting limit allows
      const left = actions.filter((x) => x.type === 'not-explored').map((x) => x.detail ?? '');
      expect(left.some((d) => /nesting limit of \d+ levels was reached\): Density/.test(d)), left.join(' | ')).toBe(true);
      expect(named(results, 'Dense')).toEqual([]);
      expect(did).not.toContain('deep:Dense');
    });

    it('no result is a confirmed bug: the page works', () => {
      expect(results.filter((x) => classifyResult(x) === 'BUG').map((x) => `${x.element?.name}: [${x.check}] ${x.actual}`)).toEqual([]);
    });
  });

  it('13b. with too small an action budget, what was not reached is named and nothing unexercised is reported as a pass', async () => {
    did.length = 0;
    const { results, actions } = await explore(new ActionBudget(12));
    const exercised = results.filter((x) => x.check === 'disclosure-option').map((x) => x.element?.name ?? '');
    const all = ['Permissions', 'Info', 'Notes', 'History', 'Assignment', 'Audit trail'];
    const missing = all.filter((n) => !exercised.includes(n));
    expect(missing.length).toBeGreaterThan(0);
    for (const n of missing) expect(did).not.toContain(`more:${n}`);
    const left = actions.filter((x) => x.type === 'not-explored').map((x) => x.detail ?? '').join(' | ');
    for (const n of missing) expect(left, `${n} should be named as not explored`).toContain(n);
    expect(left).toMatch(/NOT EXPLORED \(the action budget was used up\)/);
  }, 300_000);
});
