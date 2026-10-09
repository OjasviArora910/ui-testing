import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserController } from '../src/browser/index.js';
import { buildPageModel } from '../src/discovery/pageModel.js';
import { classifyPage, classifyResult, groupProblems, selectTests } from '../src/dynamic/index.js';
import { ActionBudget, ActionGuard, producesFinding, runFunctionalTests, type FunctionalResult } from '../src/functional/index.js';
import { collectRuleContext } from '../src/rules/context.js';
import { buildRegistry } from '../src/rules/index.js';
import { loadConfig } from '../src/shared/config.js';
import type { Finding } from '../src/shared/types.js';
import { launchForTest } from './helpers/launch.js';

/**
 * Generic regression: ordinary, working UI must not be reported as a bug, and genuinely broken UI must still be.
 * The pages use plain patterns found on any site (some with ARIA, some with classes only); nothing in the engine knows them.
 */
const config = loadConfig('qa.config.json', { functional: { maxButtonsPerPage: 60 }, dynamic: { maxGenericButtons: 40 } });

const STYLE = `<style>
body{font:16px system-ui,sans-serif;margin:24px;color:#111;background:#fff}
button{font-size:16px;padding:8px 16px;min-height:40px}
section{margin:28px 0}
.field{position:relative;width:360px}
.field input{width:100%;height:44px;padding:8px 44px 8px 12px;font-size:16px;box-sizing:border-box}
.field .inside{position:absolute;right:6px;top:6px;width:32px;height:32px;min-height:0;padding:0}
.acc-body{max-height:0;overflow:hidden;transition:none}
.acc.open .acc-body{max-height:200px}
.carousel{position:relative;width:420px;height:120px;overflow:hidden}
.slide{position:absolute;inset:0;background:#fff;z-index:1;padding:12px}
.slide.on{z-index:2}
.sheet{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100}
.sheet.show{display:block}
.sheet .box{background:#fff;width:360px;margin:120px auto;padding:24px}
[data-theme=dark] body{background:#111;color:#eee}
.pager button.active{font-weight:700}
table{border-collapse:collapse}td,th{padding:6px 12px;border:1px solid #999}
</style>`;

const WORKING = `<!doctype html><html lang="en"><head><title>Working UI</title>${STYLE}</head><body>
<h1>Working components</h1>

<section><label for="pw">Password</label>
<div class="field"><input id="pw" type="password" value="secret"><button type="button" id="pw-toggle" class="inside" aria-label="Show password">o</button></div></section>

<section><label for="find">Find</label>
<div class="field"><input id="find" type="text" value="apples" placeholder="Type here"><button type="button" id="find-clear" class="inside" aria-label="Clear text">x</button></div></section>

<section><label for="note">Note</label><br><textarea id="note" rows="2" cols="40" maxlength="200"></textarea>
<div id="count" style="text-align:right;width:360px;margin-bottom:-14px">0/200</div>
<label id="agree-label" style="display:block;width:360px;padding:10px 0"><input type="checkbox" id="agree"> I agree</label></section>

<section><h2>Class-based accordion</h2>
<div class="acc"><button type="button" class="acc-head">What is this? v</button><div class="acc-body"><p>This paragraph is long enough to take real space once the panel is opened by the user.</p></div></div>
<div class="acc"><button type="button" class="acc-head">How does it work? v</button><div class="acc-body"><p>Another collapsed paragraph that has its own height but is clipped while the panel is closed.</p></div></div></section>

<section><h2>ARIA accordion</h2><button type="button" id="aria-acc" aria-expanded="false" aria-controls="aria-panel">Shipping details</button>
<div id="aria-panel" hidden><p>Ships in two days.</p></div></section>

<section><h2>Carousel</h2><div class="carousel">
<div class="slide on"><h3>First slide title</h3><p>First slide body text here</p></div>
<div class="slide"><h3>Second slide title</h3><p>Second slide body text</p></div>
<div class="slide"><h3>Third slide title!</h3><p>Third slide body text..</p></div></div>
<button type="button" id="next-slide">Next slide</button></section>

<section><h2>Tabs</h2><div role="tablist" aria-label="Views"><button role="tab" id="t1" aria-selected="true" aria-controls="p1">Overview</button><button role="tab" id="t2" aria-selected="false" aria-controls="p2">Details</button></div>
<div id="p1" role="tabpanel">Overview panel</div><div id="p2" role="tabpanel" hidden>Details panel</div></section>

<section><h2>Table</h2><div><button type="button" id="flt">Filter: Fruit</button> <button type="button" id="srt">Sort by name</button></div>
<table id="tbl"><thead><tr><th>Name</th><th>Kind</th></tr></thead><tbody></tbody></table>
<div class="pager"><button type="button" id="pg1" class="active" aria-current="page">1</button><button type="button" id="pg2">2</button><button type="button" id="pgn" aria-label="Next page">Next</button></div></section>

<section><h2>Menu</h2><div style="position:relative;display:inline-block"><button type="button" id="menu-btn" aria-haspopup="true" aria-expanded="false">Actions</button>
<ul id="menu" role="menu" hidden style="position:absolute;top:44px;left:0;margin:0;padding:8px;background:#fff;border:1px solid #888;list-style:none;z-index:5"><li role="menuitem">Rename</li><li role="menuitem">Share</li></ul></div></section>

<section><h2>Dialogs</h2><button type="button" id="sheet-open">View summary</button> <button type="button" id="ask">Ask before leaving</button>
<div id="sheet" class="sheet"><div class="box"><p>Summary content</p><button type="button" id="sheet-close">Close</button></div></div></section>

<section><h2>Dialog with semantics</h2><button type="button" id="dlg-open" aria-haspopup="dialog">Open preferences</button>
<div id="dlg" role="dialog" aria-modal="true" aria-label="Preferences" hidden style="position:fixed;top:80px;left:80px;background:#fff;border:1px solid #333;padding:24px;z-index:200"><p>Preferences</p><button type="button" id="dlg-close">Close</button></div></section>

<section><h2>Toggles</h2><button type="button" id="theme">Toggle theme</button> <button type="button" id="bold" aria-pressed="false">Bold</button>
<button type="button" role="switch" id="sw" aria-checked="false">Notifications</button> <button type="button" id="inc">Add one</button> <span id="n">Count: 0</span></section>

<section><h2>Sizes</h2><input type="range" min="0" max="10" aria-label="Volume" style="width:300px"> <a href="#top" style="display:inline-block;height:22px">A text link</a>
<input type="text" aria-label="Short field" style="height:19px;width:170px;padding:0"></section>

<section><button type="button" id="quiet">Refresh hints</button></section>

<script>
const $ = (s) => document.querySelector(s);
$('#pw-toggle').onclick = () => { const i = $('#pw'); i.type = i.type === 'password' ? 'text' : 'password'; };
$('#find-clear').onclick = () => { $('#find').value = ''; $('#find').placeholder = 'Cleared'; };
$('#note').oninput = (e) => { $('#count').textContent = e.target.value.length + '/200'; };
document.querySelectorAll('.acc-head').forEach((h) => h.onclick = () => h.parentElement.classList.toggle('open'));
$('#aria-acc').onclick = (e) => { const open = e.target.getAttribute('aria-expanded') === 'true'; e.target.setAttribute('aria-expanded', String(!open)); $('#aria-panel').hidden = open; };
$('#next-slide').onclick = () => { const s = [...document.querySelectorAll('.slide')]; const i = s.findIndex((x) => x.classList.contains('on')); s[i].classList.remove('on'); s[(i + 1) % s.length].classList.add('on'); };
document.querySelectorAll('[role=tab]').forEach((t) => t.onclick = () => document.querySelectorAll('[role=tab]').forEach((x) => { x.setAttribute('aria-selected', String(x === t)); $('#' + x.getAttribute('aria-controls')).hidden = x !== t; }));
const DATA = [['Pear','Fruit'],['Kale','Plant'],['Plum','Fruit'],['Leek','Plant'],['Lime','Fruit'],['Corn','Plant']];
let page = 1, onlyFruit = false, sorted = false;
const render = () => { let d = DATA.filter((r) => !onlyFruit || r[1] === 'Fruit'); if (sorted) d = [...d].sort((a, b) => a[0].localeCompare(b[0])); d = d.slice((page - 1) * 3, page * 3);
  $('#tbl tbody').innerHTML = d.map((r) => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>').join('');
  $('#pg1').classList.toggle('active', page === 1); $('#pg2').classList.toggle('active', page === 2);
  page === 1 ? $('#pg1').setAttribute('aria-current', 'page') : $('#pg1').removeAttribute('aria-current'); page === 2 ? $('#pg2').setAttribute('aria-current', 'page') : $('#pg2').removeAttribute('aria-current'); };
$('#pg1').onclick = () => { page = 1; render(); }; $('#pg2').onclick = () => { page = 2; render(); }; $('#pgn').onclick = () => { page = 2; render(); };
$('#flt').onclick = () => { onlyFruit = !onlyFruit; page = 1; render(); }; $('#srt').onclick = () => { sorted = !sorted; render(); };
$('#menu-btn').onclick = (e) => { const open = e.target.getAttribute('aria-expanded') === 'true'; e.target.setAttribute('aria-expanded', String(!open)); $('#menu').hidden = open; };
$('#sheet-open').onclick = () => $('#sheet').classList.add('show'); $('#sheet-close').onclick = () => $('#sheet').classList.remove('show');
$('#dlg-open').onclick = () => { $('#dlg').hidden = false; }; $('#dlg-close').onclick = () => { $('#dlg').hidden = true; }; // deliberately no Escape handler
$('#ask').onclick = () => { confirm('Leave this page?'); };
$('#theme').onclick = () => { const r = document.documentElement; r.dataset.theme = r.dataset.theme === 'dark' ? 'light' : 'dark'; };
$('#bold').onclick = (e) => e.target.setAttribute('aria-pressed', String(e.target.getAttribute('aria-pressed') !== 'true'));
$('#sw').onclick = (e) => e.target.setAttribute('aria-checked', String(e.target.getAttribute('aria-checked') !== 'true'));
let n = 0; $('#inc').onclick = () => { $('#n').textContent = 'Count: ' + (++n); };
render();
</script></body></html>`;

const BROKEN = `<!doctype html><html lang="en"><head><title>Broken UI</title>${STYLE}</head><body>
<h1>Broken components</h1>
<section style="position:relative;height:90px"><p id="txt-a" style="position:absolute;top:10px;left:0;margin:0;width:340px">This sentence is printed underneath another one</p>
<p id="txt-b" style="position:absolute;top:16px;left:30px;margin:0;width:340px">A second sentence printed right on top of it</p></section>
<section style="position:relative;height:70px"><button type="button" id="btn-a" style="position:absolute;top:0;left:0;width:180px">Save draft</button>
<button type="button" id="btn-b" style="position:absolute;top:6px;left:80px;width:180px">Discard</button></section>
<section><button type="button" id="export">Export report</button> <button type="button" id="crash">Recalculate</button>
<button type="button" id="dead-modal" aria-haspopup="dialog">Open settings</button> <button type="button" id="dead-acc" aria-expanded="false" aria-controls="dead-panel">More info</button> <button type="button" id="stuck-open" aria-expanded="true" aria-controls="open-panel">Legal notes</button>
<div id="open-panel">Always shown</div>
<div id="dead-panel" hidden>Never shown</div>
<div id="dlg" role="dialog" aria-modal="true" aria-label="Settings" hidden>Settings</div></section>
<section><div role="tablist" aria-label="Broken tabs"><button role="tab" id="bt1" aria-selected="true">One</button><button role="tab" id="bt2" aria-selected="false">Two</button></div></section>
<section><label for="eat">Nickname</label> <input id="eat" type="text"> <label for="snap">Plan</label> <select id="snap"><option value="free">Free</option><option value="pro">Pro</option></select>
<button type="button" id="e1">Reload orders</button> <button type="button" id="e2">Refresh orders</button></section>
<section><button type="button" id="dot" aria-label="Go to slide 2" style="width:10px;height:10px;min-height:0;padding:0;border-radius:50%"></button></section>
<script>
document.querySelector('#export').onclick = () => fetch('/api/fail').catch(() => {});
document.querySelector('#eat').addEventListener('input', (e) => { e.target.value = ''; });
document.querySelector('#snap').addEventListener('change', (e) => { e.target.value = 'free'; });
document.querySelector('#e1').onclick = document.querySelector('#e2').onclick = () => fetch('/api/fail').catch(() => {});
document.querySelector('#crash').onclick = () => { setTimeout(() => { throw new Error('recalculation failed'); }, 0); };
</script></body></html>`;

describe('conservative verification: working UI is not a bug, broken UI still is', () => {
  let server: http.Server; let url: string; let c: BrowserController;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      if (p === '/working') { res.setHeader('content-type', 'text/html'); return void res.end(WORKING); }
      if (p === '/broken') { res.setHeader('content-type', 'text/html'); return void res.end(BROKEN); }
      if (p === '/api/fail') { res.statusCode = 500; return void res.end('{"error":"boom"}'); }
      res.statusCode = 404; res.end('not found');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    c = await launchForTest({ baseUrl: url, blockExternal: true });
  });
  afterAll(async () => { await c?.close(); server.closeAllConnections?.(); await new Promise((r) => server.close(() => r(undefined))); });

  async function functional(path: string): Promise<FunctionalResult[]> {
    const guard = new ActionGuard({ keywords: config.dangerousActions.keywords, allowMethods: config.dangerousActions.allowMethods, origin: url });
    c.setRequestGuard(guard.asRequestGuard());
    await c.navigate(`${url}${path}`); await c.settle(150);
    const model = await buildPageModel(c);
    const plan = selectTests(classifyPage(model), model, config);
    return runFunctionalTests({ controller: c, guard, pageUrl: c.page.url(), model, config, budget: new ActionBudget(600), plan });
  }
  async function rules(path: string): Promise<Finding[]> {
    await c.navigate(`${url}${path}`); await c.settle(150);
    const res = await (await buildRegistry(config)).run(await collectRuleContext(c, { config }));
    expect(res.errors).toEqual([]);
    return res.findings;
  }
  const of = (r: FunctionalResult[], name: RegExp) => r.filter((x) => name.test(x.element?.name ?? ''));
  const classes = (r: FunctionalResult[], name: RegExp) => of(r, name).map((x) => classifyResult(x));

  describe('working page', () => {
    let r: FunctionalResult[];
    beforeAll(async () => { r = await functional('/working'); }, 240_000);

    it('no interaction is reported as a failure of any severity', () => {
      expect(r.filter((x) => x.status === 'fail').map((x) => `${x.element?.name}: [${x.check}] ${x.actual}`)).toEqual([]);
    });

    it.each([
      ['password visibility toggle', /Show password/],
      ['clear button inside a field', /Clear text/],
      ['class-based accordion (no ARIA)', /What is this/],
      ['second class-based accordion', /How does it work/],
      ['ARIA accordion', /Shipping details/],
      ['carousel next', /Next slide/],
      ['tab', /^Details$/],
      ['filter', /Filter: Fruit/],
      ['sort (same row count, same text length)', /Sort by name/],
      ['pagination: another page', /^2$/],
      ['pagination: next', /Next page/],
      ['dropdown menu', /^Actions$/],
      ['modal without dialog semantics', /View summary/],
      ['theme toggle', /Toggle theme/],
      ['pressed-state button', /^Bold$/],
      ['switch', /Notifications/],
      ['counter', /Add one/],
    ])('%s is EXPECTED', (_label, name) => {
      const got = classes(r, name);
      expect(got.length, `a result for ${name}`).toBeGreaterThan(0);
      expect(got.every((x) => x === 'EXPECTED'), `${name}: ${of(r, name).map((x) => `[${x.check}] ${x.actual}`).join(' | ')}`).toBe(true);
    });

    it('a native confirm dialog is cancelled for safety: INCONCLUSIVE (the action is not verified), never a pass and never a bug', () => {
      const got = of(r, /Ask before leaving/);
      expect(got.length).toBeGreaterThan(0);
      expect(got.map((x) => [x.check, classifyResult(x)])).toEqual([['native-dialog-cancelled', 'INCONCLUSIVE']]);
      expect(got[0]!.actual).toMatch(/safely cancelled \(never accepted\), so the intended action was not performed and is not verified/);
    });

    it('form controls are exercised too and are silent when they take the value', () => {
      const fields = r.filter((x) => x.kind === 'interactive');
      expect(fields.map((x) => x.check)).toEqual(expect.arrayContaining(['field-fill', 'field-check']));
      expect(fields.every((x) => classifyResult(x) === 'EXPECTED'), fields.filter((x) => x.status !== 'pass').map((x) => `${x.element?.name}: ${x.actual}`).join(' | ')).toBe(true);
    });

    it('coverage: every button, tab and custom toggle on the page was tested (none dropped by a cap)', () => {
      const clicked = new Set(r.filter((x) => x.kind === 'button' || x.kind === 'modal').map((x) => x.element?.selector));
      for (const id of ['pw-toggle', 'find-clear', 'aria-acc', 'next-slide', 't1', 't2', 'flt', 'srt', 'pg1', 'pg2', 'pgn', 'menu-btn', 'sheet-open', 'dlg-open', 'ask', 'theme', 'bold', 'sw', 'inc', 'quiet']) expect(clicked.has(`#${id}`), id).toBe(true);
    });

    it('clicking the page that is already current is EXPECTED (a no-op by design)', () => {
      expect(of(r, /^1$/).map((x) => [x.check, classifyResult(x)])).toEqual([['already-active', 'EXPECTED']]);
    });

    it('a button of unclear purpose with no observable effect is counted as tested and NOT reported', () => {
      expect(classes(r, /Refresh hints/)).toEqual(['INCONCLUSIVE']);
      expect(of(r, /Refresh hints/).some(producesFinding)).toBe(false);
    });

    it('a working page produces no finding of any kind: no bug, no warning, no review item', () => {
      expect(r.filter(producesFinding).map((x) => `${x.element?.name}: [${x.check}] ${x.actual}`)).toEqual([]);
    });

    it('a dialog is opened and closed with its close control; Escape is not tested and never reported', () => {
      const dlg = of(r, /Open preferences/);
      expect(dlg.map((x) => [x.check, classifyResult(x)])).toEqual([['modal-open', 'EXPECTED'], ['modal-close', 'EXPECTED']]);
      expect(r.some((x) => /escape|keyboard|focus/i.test(`${x.check} ${x.expected} ${x.actual}`))).toBe(false);
    });

    it('layout rules: composition, clipping and layering are not overlap; native and one-dimension-small controls are not defects', async () => {
      const f = await rules('/working');
      expect(f.filter((x) => x.ruleId === 'geometry.overlap').map((x) => x.actual)).toEqual([]);
      expect(f.filter((x) => x.ruleId === 'geometry.small-target' && x.classification === 'defect').map((x) => x.actual)).toEqual([]);
      expect(f.filter((x) => x.classification === 'defect' && x.category !== 'accessibility').map((x) => `${x.ruleId}: ${x.actual}`)).toEqual([]);
    });
  });

  describe('broken page', () => {
    let r: FunctionalResult[];
    beforeAll(async () => { r = await functional('/broken'); }, 240_000);

    it('a request that fails and an uncaught exception are BUGs with before/after evidence', () => {
      const exp = of(r, /Export report/)[0]!; const crash = of(r, /Recalculate/)[0]!;
      expect([exp.check, classifyResult(exp)]).toEqual(['network-failure', 'BUG']);
      expect([crash.check, classifyResult(crash)]).toEqual(['javascript-error', 'BUG']);
      expect(exp.before && exp.screenshot && exp.trace?.network.join(' ')).toMatch(/api\/fail -> 500/);
    });

    it('a declared dialog trigger that opens nothing is a BUG', () => {
      expect(of(r, /Open settings/).map((x) => [x.check, classifyResult(x)])).toEqual([['modal-open', 'BUG']]);
    });

    it('a tab that does not switch and a collapsed control that does not expand are BUGs', () => {
      expect(of(r, /^Two$/).map((x) => [x.check, classifyResult(x)])).toEqual([['tab-switch', 'BUG']]);
      expect(of(r, /More info/).map((x) => [x.check, classifyResult(x)])).toEqual([['expand-collapse', 'BUG']]);
    });

    it('an already-open control that does not close is ambiguous: not a BUG and not reported', () => {
      expect(classes(r, /Legal notes/)).toEqual(['INCONCLUSIVE']);
      expect(of(r, /Legal notes/).some(producesFinding)).toBe(false);
    });

    it('form controls that do not take a value are BUGs, each verified on its own state', () => {
      expect(of(r, /Nickname/).map((x) => [x.check, classifyResult(x)])).toEqual([['field-fill', 'BUG']]);
      expect(of(r, /^Plan$/).map((x) => [x.check, classifyResult(x)])).toEqual([['field-select', 'BUG']]);
      expect(of(r, /Nickname/)[0]!.actual).toMatch(/Typed text but the field still contains ""/);
    });

    it('three buttons failing on the same request are three failed tests but one reported problem', async () => {
      const failing = r.filter((x) => x.check === 'network-failure');
      expect(failing).toHaveLength(3);
      const ctx = await collectRuleContext(c, { config, functional: r });
      const found = (await (await buildRegistry(config)).run(ctx, (rule) => rule.id.startsWith('functional.'))).findings.filter((x) => /network-failure/.test(x.actual));
      expect(found).toHaveLength(3);
      expect(groupProblems(found)).toHaveLength(1);
      expect(found.every((x) => x.context?.why)).toBe(true); // each says why it is a problem
    });

    it('real obstruction is still an overlap defect', async () => {
      const f = await rules('/broken');
      const overlap = f.filter((x) => x.ruleId === 'geometry.overlap' && x.classification === 'defect');
      expect(overlap.some((x) => /printed underneath/.test(x.actual) && /hit-testing/.test(x.actual))).toBe(true);
      expect(overlap.some((x) => /Save draft/.test(x.actual) && x.severity === 'major')).toBe(true);
      // target size is an accessibility criterion: silent by default, reported in the accessibility category when enabled
      expect(f.some((x) => x.ruleId === 'geometry.small-target')).toBe(false);
      const a11y = loadConfig('qa.config.json', { accessibility: { enabled: true } });
      const withA11y = (await (await buildRegistry(a11y)).run(await collectRuleContext(c, { config: a11y }))).findings;
      expect(withA11y.find((x) => x.ruleId === 'geometry.small-target' && /10x10/.test(x.actual))).toMatchObject({ category: 'accessibility' });
    });
  });
});
