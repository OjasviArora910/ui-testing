import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserController } from '../src/browser/index.js';
import { buildPageModel } from '../src/discovery/pageModel.js';
import { classifyPage, classifyResult, sameRootCause, selectTests } from '../src/dynamic/index.js';
import { ActionBudget, ActionGuard, findingFromResult, producesFinding, runFunctionalTests, type FunctionalResult } from '../src/functional/index.js';
import { collectRuleContext } from '../src/rules/context.js';
import { buildRegistry } from '../src/rules/index.js';
import { loadConfig } from '../src/shared/config.js';
import type { Finding } from '../src/shared/types.js';
import { launchForTest } from './helpers/launch.js';

/**
 * A UI/UX bug means the user-facing behaviour is broken. A console error, an uncaught exception or a browser-automation
 * timeout is not one by itself: the verdict comes from what the UI observably did.
 * The pages are plain generic patterns; nothing in the engine knows their ids or labels.
 */
const config = loadConfig('qa.config.json');

const STYLE = `<style>
body{font:16px system-ui,sans-serif;margin:24px}
button,summary,a.ctl{font-size:16px;padding:8px 16px;min-height:40px;display:inline-block}
section{margin:28px 0;position:relative}
.drop{position:absolute;top:48px;left:0;margin:0;padding:8px;background:#fff;border:1px solid #888;list-style:none}
@keyframes drift{from{transform:translateX(0)}to{transform:translateX(6px)}}
.restless{animation:drift 90ms linear infinite alternate}
</style>`;

const WORKING = `<!doctype html><html lang="en"><head><title>Working with noise</title>${STYLE}</head><body>
<h1>Working controls</h1>

<section><a href="#" class="ctl" id="nav-menu">Menu</a><ul id="nav-drop" class="drop" hidden><li>Profile</li><li>Billing</li></ul></section>

<section style="margin-top:120px"><button type="button" id="acts" aria-haspopup="true" aria-expanded="false">Actions</button>
<ul id="acts-drop" class="drop" role="menu" hidden><li role="menuitem">Rename</li></ul></section>

<section style="margin-top:120px"><button type="button" id="acc" aria-expanded="false" aria-controls="acc-panel">Returns policy</button>
<div id="acc-panel" hidden><p>Thirty days.</p></div></section>

<section><details id="ship"><summary>Shipping details</summary><p>Ships in two days from our warehouse.</p></details></section>

<section><button type="button" id="restless" class="restless">Add to list</button> <span id="added">0 items</span></section>

<section><button type="button" id="save-view">Save view</button> <span id="saved">Not saved</span></section>

<script>
const $ = (s) => document.querySelector(s);
// unrelated noise while the page loads: a request that 404s and an exception in a script nobody depends on
fetch('/telemetry/boot.json').catch(() => {});
setTimeout(() => { throw new Error('boot analytics failed'); }, 0);
// the control works, and also sends a request that 404s
$('#save-view').addEventListener('click', () => { $('#saved').textContent = 'Saved'; fetch('/telemetry/click.json').catch(() => {}); });
// the dropdown opens, and a second, unrelated listener on the same click throws
$('#nav-menu').addEventListener('click', (e) => { e.preventDefault(); $('#nav-drop').hidden = !$('#nav-drop').hidden; });
$('#nav-menu').addEventListener('click', (e) => { document.querySelector(e.currentTarget.getAttribute('href')); });
// the menu opens, and the handler also logs an error
$('#acts').addEventListener('click', (e) => { const open = e.currentTarget.getAttribute('aria-expanded') === 'true'; e.currentTarget.setAttribute('aria-expanded', String(!open)); $('#acts-drop').hidden = open; console.error('analytics: tracker not initialised'); });
$('#acc').addEventListener('click', (e) => { const open = e.currentTarget.getAttribute('aria-expanded') === 'true'; e.currentTarget.setAttribute('aria-expanded', String(!open)); $('#acc-panel').hidden = open; setTimeout(() => { throw new Error('metrics endpoint missing'); }, 0); });
let n = 0; $('#restless').addEventListener('click', () => { $('#added').textContent = (++n) + ' items'; });
</script></body></html>`;

const BROKEN = `<!doctype html><html lang="en"><head><title>Broken controls</title>${STYLE}</head><body>
<h1>Broken controls</h1>

<section><button type="button" id="crash-menu" aria-haspopup="true" aria-expanded="false">Account</button>
<ul id="crash-drop" class="drop" role="menu" hidden><li role="menuitem">Sign out</li></ul></section>

<section style="margin-top:120px"><button type="button" id="dead" aria-expanded="false" aria-controls="dead-panel">Delivery options</button>
<div id="dead-panel" hidden>Never shown</div></section>

<section style="height:70px"><button type="button" id="under" style="position:absolute;top:0;left:0;width:200px">Download invoice</button>
<div id="lid" style="position:absolute;top:0;left:0;width:260px;height:60px;background:#ddd">Promotional panel placed over the button</div></section>

<section style="height:70px"><button type="button" id="banner-under" style="position:fixed;bottom:10px;left:10px;width:200px">Start chat</button></section>
<div id="banner" style="position:fixed;bottom:0;left:0;right:0;height:80px;background:#222;color:#fff">We use cookies on this site</div>

<section><button type="button" id="vague">Sync</button></section>

<script>
const $ = (s) => document.querySelector(s);
// throws before it gets to open anything
$('#crash-menu').addEventListener('click', () => { const state = undefined; state.open = true; $('#crash-drop').hidden = false; });
// purpose unknown, changes nothing, logs an error
$('#vague').addEventListener('click', () => { console.error('sync: nothing to do'); });
</script></body></html>`;

const NOISY = `<!doctype html><html lang="en"><head><title>Noisy page</title>${STYLE}</head><body>
<h1>Page with a recurring background error</h1>
<section><button type="button" id="inc">Add one</button> <span id="n">Count: 0</span></section>
<section><button type="button" id="idle">Recheck</button></section>
<script>
setInterval(() => { throw new Error('heartbeat failed'); }, 40);
let n = 0; document.querySelector('#inc').addEventListener('click', () => { document.querySelector('#n').textContent = 'Count: ' + (++n); });
</script></body></html>`;

describe('the verdict comes from the UI result, not from console errors or browser-automation errors', () => {
  let server: http.Server; let url: string; let c: BrowserController;

  beforeAll(async () => {
    const pages: Record<string, string> = { '/working': WORKING, '/broken': BROKEN, '/noisy': NOISY };
    server = http.createServer((req, res) => {
      const body = pages[new URL(req.url ?? '/', 'http://x').pathname];
      if (body) { res.setHeader('content-type', 'text/html'); return void res.end(body); }
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
    return runFunctionalTests({ controller: c, guard, pageUrl: c.page.url(), model, config, budget: new ActionBudget(400), plan });
  }
  const of = (r: FunctionalResult[], name: RegExp) => r.filter((x) => name.test(x.element?.name ?? ''));
  const say = (r: FunctionalResult[]) => r.map((x) => `${x.element?.name}: ${x.status} [${x.check}] ${x.actual}`).join(' | ');
  const diagnostics = (x: FunctionalResult): string => JSON.stringify(x.details ?? {});

  describe('working UI stays a pass', () => {
    let r: FunctionalResult[];
    beforeAll(async () => { r = await functional('/working'); }, 240_000);

    it('1. a dropdown that opens is EXPECTED although an unrelated listener throws on the same click', () => {
      const menu = of(r, /^Menu$/);
      expect(menu.map((x) => classifyResult(x)), say(menu)).toEqual(['EXPECTED']);
      expect(diagnostics(menu[0]!)).toMatch(/uncaught: SyntaxError.*not a valid selector/); // kept as a diagnostic
    });

    it('1b. a menu that opens is EXPECTED although its handler logs console.error', () => {
      const menu = of(r, /^Actions$/);
      expect(menu.map((x) => classifyResult(x)), say(menu)).toEqual(['EXPECTED']);
      expect(diagnostics(menu[0]!)).toMatch(/console\.error: analytics: tracker not initialised/);
    });

    it('1c. an accordion that expands is EXPECTED although an exception is thrown right after', () => {
      const acc = of(r, /Returns policy/);
      expect(acc.map((x) => [x.check, classifyResult(x)]), say(acc)).toEqual([['accordion-toggle', 'EXPECTED']]);
    });

    it('2. a disclosure whose first locator never resolves is still clicked and EXPECTED once it expands', () => {
      const ship = of(r, /Shipping details/);
      expect(ship.map((x) => [x.check, classifyResult(x)]), say(ship)).toEqual([['accordion-toggle', 'EXPECTED']]);
      expect(diagnostics(ship[0]!)).toMatch(/matched no element/); // the recovery is recorded, not reported
    });

    it('2b. a control the browser never considers "stable" is clicked anyway and EXPECTED because its effect is seen', () => {
      const add = of(r, /Add to list/);
      expect(add.map((x) => classifyResult(x)), say(add)).toEqual(['EXPECTED']);
      expect(add[0]!.actual).toMatch(/observable change/);
    }, 60_000);

    it('1d. a control that works is EXPECTED although the request it also sends returns 404', () => {
      const save = of(r, /Save view/);
      expect(save.map((x) => classifyResult(x)), say(save)).toEqual(['EXPECTED']);
      expect(diagnostics(save[0]!)).toMatch(/request: GET .*click\.json returned HTTP 404/);
    });

    it('nothing on a working page is reported: no bug, no warning, no review item', () => {
      expect(r.filter(producesFinding).map((x) => `${x.element?.name}: [${x.check}] ${x.actual}`)).toEqual([]);
    });

    it('ACCEPTANCE: unrelated console error + unrelated 404 + a browser timeout that recovers => no finding at all', async () => {
      const n0 = c.events.network.length; const k0 = c.events.console.length;
      await c.navigate(`${url}/working`); await c.settle(300);
      const network = c.events.network.slice(n0); const cons = c.events.console.slice(k0);
      expect(network.some((n) => n.status === 404)).toBe(true); // the noise is really there
      expect(cons.some((x) => x.kind === 'pageerror')).toBe(true);
      const page = (await (await buildRegistry(config)).run(await collectRuleContext(c, { config, network, console: cons }))).findings;
      expect(page.map((x) => `${x.ruleId}: ${x.actual}`)).toEqual([]);
      expect(r.filter(producesFinding)).toEqual([]);
      expect(r.filter((x) => x.kind === 'button').every((x) => x.status === 'pass'), say(r.filter((x) => x.status !== 'pass'))).toBe(true);
    });

    it('console and network diagnostics are not findings by default; switched on, a logged error is still never a defect', async () => {
      await c.navigate(`${url}/noisy`); await c.settle(200);
      const cons = c.events.console.slice(c.consoleIndexAtLoad);
      const run = async (cfg: typeof config) => (await (await buildRegistry(cfg)).run(await collectRuleContext(c, { config: cfg, console: cons }), (rule) => rule.id === 'console.error')).findings;
      expect(await run(config)).toEqual([]);
      const found = await run(loadConfig('qa.config.json', { rules: { disabled: [] } }));
      expect(found.length).toBeGreaterThan(0);
      expect(found.every((x) => x.classification === 'anomaly' && x.basis === null)).toBe(true);
    });
  });

  describe('broken UI is still reported', () => {
    let r: FunctionalResult[];
    beforeAll(async () => { r = await functional('/broken'); }, 240_000);

    it('3. a dropdown that does not open because its handler throws is a BUG, with the exception as its cause', () => {
      const menu = of(r, /^Account$/);
      expect(menu.map((x) => [x.check, classifyResult(x)]), say(menu)).toEqual([['javascript-error', 'BUG']]);
      expect(menu[0]!.actual).toMatch(/Nothing on the page changed.*uncaught exception/);
      expect(menu[0]!.trace?.console.join(' ')).toMatch(/uncaught: TypeError/);
    });

    it('4. a collapsed control that does not expand is a BUG with no console error involved', () => {
      const dead = of(r, /Delivery options/);
      expect(dead.map((x) => [x.check, classifyResult(x)]), say(dead)).toEqual([['expand-collapse', 'BUG']]);
      expect(dead[0]!.trace?.console).toEqual([]);
    });

    it('5. a button that another in-flow element really covers is a BUG; the browser timeout is not what makes it one', () => {
      const under = of(r, /Download invoice/);
      expect(under.map((x) => [x.check, classifyResult(x)]), say(under)).toEqual([['clickable', 'BUG']]);
      expect(under[0]!.actual).toMatch(/<div#lid> covers "Download invoice"/);
      expect(under[0]!.actual).not.toMatch(/Timeout|exceeded/i);
    });

    it('5b. a button under floating UI (a banner) cannot be judged automatically: NEEDS_REVIEW', () => {
      const chat = of(r, /Start chat/);
      expect(chat.map((x) => [x.check, classifyResult(x)]), say(chat)).toEqual([['clickable', 'NEEDS_REVIEW']]);
      expect(chat[0]!.actual).toMatch(/floating\/overlay UI/);
    });

    it('6. unclear purpose, no visible effect and a console.error: no strong evidence, so no finding', () => {
      const vague = of(r, /^Sync$/);
      expect(vague.map((x) => [x.check, classifyResult(x)]), say(vague)).toEqual([['console-error', 'INCONCLUSIVE']]);
      expect(vague.some(producesFinding)).toBe(false);
    });

    it('ACCEPTANCE: one broken element is ONE bug, also when a page check and the click test both see it', async () => {
      await c.navigate(`${url}/broken`); await c.settle(200);
      const reg = await buildRegistry(config);
      const page = (await reg.run(await collectRuleContext(c, { config }))).findings;
      const rule = reg.get('functional.button')!;
      const where = { page: c.url, viewport: c.currentViewport };
      const reported: Finding[] = [...page];
      for (const x of r.filter(producesFinding)) { const f = findingFromResult(rule, where, x); if (!sameRootCause(f, reported)) reported.push(f); }
      const about = (name: RegExp) => reported.filter((f) => f.classification === 'defect' && (name.test(f.element?.name ?? '') || name.test(f.actual)));
      expect(about(/Download invoice/).map((f) => `${f.ruleId}: ${f.actual}`)).toHaveLength(1);
      expect(about(/^Account$|"Account"/).map((f) => f.actual)).toHaveLength(1);
      expect(about(/Delivery options/).map((f) => f.actual)).toHaveLength(1);
      // and nothing in the report is a bare technical diagnostic
      expect(reported.filter((f) => ['network', 'console', 'performance'].includes(f.category))).toEqual([]);
    });

    it('no result on the broken page blames a browser-automation error', () => {
      expect(r.filter((x) => x.status === 'fail').map((x) => x.actual).join(' ')).not.toMatch(/Timeout \d+ms exceeded|scrollIntoView/);
    });
  });

  describe('an error the page keeps logging by itself is not attributed to an action', () => {
    let r: FunctionalResult[];
    beforeAll(async () => { r = await functional('/noisy'); }, 120_000);

    it('a working control is EXPECTED', () => {
      expect(of(r, /Add one/).map((x) => classifyResult(x)), say(r)).toEqual(['EXPECTED']);
    });
    it('a control that does nothing is not a BUG because of the background error', () => {
      const idle = of(r, /Recheck/);
      expect(idle.map((x) => classifyResult(x)), say(idle)).toEqual(['INCONCLUSIVE']);
      expect(idle.some(producesFinding)).toBe(false);
    });
  });
});
