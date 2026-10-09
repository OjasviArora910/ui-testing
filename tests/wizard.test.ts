import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createPlatform, type Platform } from '../src/orchestrator/index.js';

/**
 * A creation WIZARD: three steps behind Next / Back with a step indicator, different controls on every step, and the
 * commit only on the last one. Nothing in the engine knows the step names or how many there are. With an authorization
 * for this exact page the wizard is traversed, every step is explored (controls tested and restored), Next and Back are
 * verified, and exactly one record is created. Without it, the wizard is never opened.
 */
function startSite(): Promise<{ server: http.Server; url: string; hits: Record<string, number>; roles: string[]; bodies: string[]; log: Record<string, string[]> }> {
  const hits: Record<string, number> = {}; const roles = ['Sales manager']; const bodies: string[] = []; const log: Record<string, string[]> = {};
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x'); const p = u.pathname;
    hits[`${req.method} ${p}`] = (hits[`${req.method} ${p}`] ?? 0) + 1;
    const json = (code: number, body: unknown): void => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (p === '/did') { const k = u.searchParams.get('c')!; (log[k] ??= []).push(u.searchParams.get('v') ?? ''); res.end('ok'); return; }
    if (p.startsWith('/api/')) {
      let raw = ''; req.on('data', (d) => { raw += d; }); req.on('end', () => {
        if (p === '/api/GetRoles') return json(200, { data: roles.map((name, i) => ({ id: i + 1, name })) });
        if (p === '/api/AddRoleFromWizard') { bodies.push(raw); roles.push((JSON.parse(raw) as { name: string }).name); return json(200, { ok: true }); }
        return json(200, { ok: true });
      });
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><html lang="en"><head><title>Records</title><style>body{font-family:sans-serif;margin:24px}#wiz{display:none;border:1px solid #999;padding:16px;margin:16px 0}.step{display:none}.step.on{display:block}
ol.wizard-steps{list-style:none;display:flex;gap:16px;padding:0}ol.wizard-steps li.active a{font-weight:bold}label{display:block;margin:8px 0}td{border:1px solid #ccc;padding:4px 10px}</style></head><body>
<main><h1>Records</h1>
<a id="create" href="#">C r e a t e</a>
<div id="wiz"><h2>Create record</h2>
  <ol class="wizard-steps"><li class="active"><a href="#" data-step="0">Info</a></li><li><a href="#" data-step="1">Options</a></li><li><a href="#" data-step="2">Assignment</a></li></ol>
  <div class="step on"><label>Name * <input type="text" id="rname"></label><label>Description <textarea id="rdesc"></textarea></label><p id="msg" role="alert"></p></div>
  <div class="step"><label>Contacts access <input type="range" id="perm" min="0" max="4" value="2"></label><label><input type="checkbox" id="reports" checked> Reports</label></div>
  <div class="step"><label><input type="checkbox" id="assign"> All users group</label><button type="button" id="save">Save</button> <button type="button" id="del">Delete</button></div>
  <button type="button" id="back">Back</button> <button type="button" id="next">Next</button> <button type="button" id="cancel">Cancel</button>
</div>
<table id="list"><tbody></tbody></table>
</main>
<script>
const did = (c, v) => fetch('/did?c=' + c + '&v=' + encodeURIComponent(v == null ? '' : v)).catch(() => null);
const post = (p, body) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
post('/api/GetRoles').then((r) => r.json()).then((d) => { document.querySelector('#list tbody').innerHTML = d.data.map((r) => '<tr><td>' + r.name + '</td></tr>').join(''); });
let step = 0;
const show = () => {
  document.querySelectorAll('.step').forEach((s, i) => s.classList.toggle('on', i === step));
  document.querySelectorAll('.wizard-steps li').forEach((li, i) => li.classList.toggle('active', i === step));
  document.getElementById('back').style.display = step === 0 ? 'none' : ''; document.getElementById('next').style.display = step === 2 ? 'none' : '';
  did('step', step);
};
document.getElementById('create').onclick = (e) => { e.preventDefault(); document.getElementById('wiz').style.display = 'block'; step = 0; show(); };
document.getElementById('next').onclick = () => { if (step === 0 && !document.getElementById('rname').value) { document.getElementById('msg').textContent = 'Name is required'; return; } document.getElementById('msg').textContent = ''; step++; show(); };
document.getElementById('back').onclick = () => { step--; show(); };
document.querySelectorAll('.wizard-steps a').forEach((a) => a.onclick = (e) => e.preventDefault()); // the indicator only shows where you are
document.getElementById('cancel').onclick = () => { document.getElementById('wiz').style.display = 'none'; };
document.getElementById('del').onclick = () => { fetch('/api/roles/1', { method: 'DELETE' }).catch(() => null); };
for (const id of ['reports', 'assign']) document.getElementById(id).addEventListener('change', (e) => did(id === 'assign' ? 'grp' : id, e.target.checked));
document.getElementById('perm').addEventListener('input', (e) => did('perm', e.target.value));
document.getElementById('save').onclick = () => post('/api/AddRoleFromWizard', { name: document.getElementById('rname').value, description: document.getElementById('rdesc').value, perm: document.getElementById('perm').value, reports: document.getElementById('reports').checked, assign: document.getElementById('assign').checked })
  .then(() => { document.getElementById('wiz').style.display = 'none'; });
</script></body></html>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, roles, bodies, log })));
}

describe('creation wizard: traversed, explored step by step, committed once (browser)', () => {
  const open: { server: http.Server; platform?: Platform }[] = [];
  afterAll(async () => { for (const o of open) { await o.platform?.orchestrator.shutdown(); o.server.closeAllConnections?.(); await new Promise((r) => o.server.close(() => r(undefined))); } });

  async function run(authorize: boolean) {
    const site = await startSite();
    const exact = `${site.url}/#setup/roles`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-wiz-'));
    const platform = createPlatform({
      configOverrides: {
        paths: { dataDir: path.join(dir, 'data'), baselineDir: path.join(dir, 'baselines') }, viewports: [{ name: 'desktop', width: 1280, height: 800 }],
        network: { allowedRequests: [{ origin: site.url, method: 'POST', path: '/api/GetRoles' }] },
        workflows: authorize ? [{ page: exact, entryLabels: ['create'], commitLabels: ['save', 'create'] }] : [],
      },
      provider: null, trace: false, env: {},
    });
    open.push({ server: site.server, platform });
    const started = platform.orchestrator.start({ url: exact, scope: 'page', mode: 'deterministic', controlledCreate: authorize } as Parameters<typeof platform.orchestrator.start>[0]);
    await platform.orchestrator.whenDone(started.id);
    const results = platform.orchestrator.db.listTestResults(started.id);
    return { site, results, name: `QA-Autonomous-${started.id.replace(/^run_/, '')}`, findings: platform.orchestrator.db.listFindings(started.id),
      say: results.map((r) => `${r.kind}/${r.check} | ${r.target} | ${r.classification} | ${r.actual}`).join('\n') };
  }

  it('normal QA never opens the wizard: Create is blocked and nothing is written', async () => {
    const r = await run(false);
    expect(r.results.some((x) => (x.target ?? '').replace(/\s/g, '') === 'Create' && x.classification === 'BLOCKED_BY_SAFETY'), r.say).toBe(true);
    expect(r.site.log.step).toBeUndefined();
    expect(Object.keys(r.site.hits).filter((k) => !k.startsWith('GET ') && k !== 'POST /api/GetRoles')).toEqual([]);
  }, 240_000);

  it('with the authorization: every step is reached and explored, Next and Back are verified, one record is created and verified', async () => {
    const r = await run(true);
    const of = (check: string) => r.results.filter((x) => x.check === check);
    // forward and back through the wizard, each verified by the step that is shown
    expect(of('wizard-next').map((x) => x.classification), r.say).toEqual(['EXPECTED', 'EXPECTED']);
    expect(of('wizard-back').map((x) => x.classification), r.say).toEqual(['EXPECTED', 'EXPECTED']);
    expect(of('wizard-next')[0]!.actual).toMatch(/led from step 1 to another step: .*active: Options/);
    expect(of('wizard-next')[1]!.actual).toMatch(/led from step 2 to another step: .*active: Assignment/);
    // the controls of every step were found on that step, tested and restored exactly
    for (const label of [/Reports/, /All users group/, /Description/]) {
      expect(r.results.filter((x) => label.test(x.target ?? '') && x.check.startsWith('reversible-')).map((x) => x.classification), `${label}\n${r.say}`).toEqual(['EXPECTED']);
    }
    for (const [control, start] of Object.entries({ reports: 'true', grp: 'false' })) {
      const v = r.site.log[control] ?? [];
      expect(v, `${control}\n${r.say}`).toHaveLength(2);
      expect(v[1]).toBe(start);
    }
    // exactly one record, with the test name, a synthetic description, and the wizard's own defaults untouched
    const wf = of('workflow-create');
    expect(wf.map((x) => x.classification), r.say).toEqual(['EXPECTED']);
    expect(wf[0]!.actual).toMatch(new RegExp(`Created "${r.name}" with one POST /api/AddRoleFromWizard \\(HTTP 200\\); after a reload it is listed`));
    expect(r.site.hits['POST /api/AddRoleFromWizard']).toBe(1);
    expect(JSON.parse(r.site.bodies[0]!)).toEqual({ name: r.name, description: 'Created by automated UI QA', perm: '2', reports: true, assign: false });
    expect(r.site.roles.filter((n) => n === r.name)).toHaveLength(1);
    expect(Object.keys(r.site.hits).filter((k) => !k.startsWith('GET ') && k !== 'POST /api/GetRoles')).toEqual(['POST /api/AddRoleFromWizard']);
    expect(r.findings.filter((f) => f.resultClass === 'BUG')).toEqual([]);
  }, 300_000);
});
