import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatform, type Platform } from '../src/orchestrator/index.js';

/**
 * The controlled creation workflow against a Roles-like page: the list is loaded with an allow-listed POST, "C r e a t e"
 * opens a creation panel (no <form>), Save posts the new record. The server counts every request, so "exactly one record
 * was created" and "nothing else was written" are checked from outside the browser.
 */
type Mode = 'ok' | 'not-stored' | 'conflict' | 'two-writes';

function startSite(mode: Mode): Promise<{ server: http.Server; url: string; hits: Record<string, number>; roles: string[]; bodies: string[] }> {
  const hits: Record<string, number> = {}; const roles = ['Sales manager', 'Partner admin']; const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    const p = new URL(req.url ?? '/', 'http://x').pathname;
    const key = `${req.method} ${p}`; hits[key] = (hits[key] ?? 0) + 1;
    const json = (code: number, body: unknown): void => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (p.startsWith('/api/')) {
      let raw = ''; req.on('data', (d) => { raw += d; }); req.on('end', () => {
        if (p === '/api/GetRoles') return json(200, { data: roles.map((name, i) => ({ id: i + 1, name })) });
        if (p === '/api/SaveRoleDefinition') {
          bodies.push(raw);
          if (mode === 'conflict') return json(409, { error: 'A role with this name already exists' });
          if (mode !== 'not-stored') roles.push((JSON.parse(raw) as { roleName: string }).roleName);
          return json(200, { ok: true });
        }
        return json(200, { ok: true });
      });
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><html lang="en"><head><title>Roles</title><style>body{font-family:sans-serif;margin:24px}#panel{display:none;border:1px solid #999;padding:16px;margin:16px 0}label{display:block;margin:8px 0}td{border:1px solid #ccc;padding:4px 10px}</style></head><body>
<main><h1>Roles</h1>
<a id="create" href="#"><span>C</span><span>r</span><span>e</span><span>a</span><span>t</span><span>e</span></a>
<div id="panel"><h2>New role</h2>
  <label>Role name * <input type="text" id="rname"></label>
  <label>Description <input type="text" id="rdesc"></label>
  <label>Preset <select id="preset"><option value="0">None</option><option value="7">Manager</option></select></label>
  <label><input type="checkbox" id="lock"> Lock Out</label>
  <button type="button" id="save">Save</button> <button type="button" id="cancel">Cancel</button> <button type="button" id="del">Delete</button>
  <p id="msg"></p>
</div>
<table id="list"><tbody></tbody></table>
</main>
<script>
const post = (p, body) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
post('/api/GetRoles').then((r) => r.json()).then((d) => { document.querySelector('#list tbody').innerHTML = d.data.map((r) => '<tr><td>' + r.name + '</td></tr>').join(''); }).catch(() => { document.querySelector('#list tbody').innerHTML = '<tr><td>No Data Found</td></tr>'; });
post('/api/TrackPageView').catch(() => null);
document.getElementById('create').onclick = (e) => { e.preventDefault(); document.getElementById('panel').style.display = 'block'; };
document.getElementById('cancel').onclick = () => { document.getElementById('panel').style.display = 'none'; };
document.getElementById('del').onclick = () => { fetch('/api/roles/1', { method: 'DELETE' }).catch(() => null); post('/api/DeleteRole').catch(() => null); };
document.getElementById('save').onclick = () => {
  const name = document.getElementById('rname').value;
  if (!name) { document.getElementById('msg').textContent = 'Role name is required'; return; }
  ${mode === 'two-writes' ? "post('/api/AssignRolePermissions', { roleName: name }).catch(() => null);" : ''}
  post('/api/SaveRoleDefinition', { roleName: name, description: document.getElementById('rdesc').value, preset: document.getElementById('preset').value })
    .then((r) => { document.getElementById('msg').textContent = r.ok ? 'Saved' : 'Could not save'; if (r.ok) document.getElementById('panel').style.display = 'none'; })
    .catch(() => { document.getElementById('msg').textContent = 'Could not save'; });
};
</script></body></html>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, roles, bodies })));
}

describe('controlled creation workflow (browser)', () => {
  const open: { server: http.Server; platform?: Platform }[] = [];
  afterAll(async () => { for (const o of open) { await o.platform?.orchestrator.shutdown(); o.server.closeAllConnections?.(); await new Promise((r) => o.server.close(() => r(undefined))); } });

  async function run(mode: Mode, opts: { authorize: boolean; scope?: 'page' | 'site'; otherPage?: boolean } = { authorize: true }) {
    const site = await startSite(mode);
    const exact = `${site.url}/#setup/roles`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-wf-'));
    const platform = createPlatform({
      configOverrides: {
        paths: { dataDir: path.join(dir, 'data'), baselineDir: path.join(dir, 'baselines') }, viewports: [{ name: 'desktop', width: 1280, height: 800 }],
        network: { allowedRequests: [{ origin: site.url, method: 'POST', path: '/api/GetRoles' }] },
        workflows: opts.authorize ? [{ page: opts.otherPage ? `${site.url}/#setup/users` : exact, email: 'nikita.dhawan@revclerx.com' }] : [],
      },
      provider: null, trace: false, env: {},
    });
    open.push({ server: site.server, platform });
    const started = platform.orchestrator.start({ url: exact, scope: opts.scope ?? 'page', mode: 'deterministic' } as Parameters<typeof platform.orchestrator.start>[0]);
    const done = await platform.orchestrator.whenDone(started.id);
    const db = platform.orchestrator.db;
    const results = db.listTestResults(started.id);
    const wf = results.filter((r) => r.check === 'workflow-create');
    const name = `QA-Autonomous-${started.id.replace(/^run_/, '')}`;
    return { site, done, results, wf, name, findings: db.listFindings(started.id), say: results.map((r) => `${r.kind}/${r.check} | ${r.target} | ${r.classification} | ${r.actual}`).join('\n') };
  }
  const writes = (hits: Record<string, number>): string[] => Object.keys(hits).filter((k) => !k.startsWith('GET ') && k !== 'POST /api/GetRoles');

  beforeAll(() => undefined);

  it('creates exactly one record, through the page\'s own UI, and passes only because the record is listed after a reload', async () => {
    const r = await run('ok');
    expect(r.done.status).toBe('COMPLETED');
    expect(r.wf.map((x) => x.classification), r.say).toEqual(['EXPECTED']);
    expect(r.wf[0]!.actual).toMatch(new RegExp(`Created "${r.name}" with one POST /api/SaveRoleDefinition \\(HTTP 200\\); after a reload it is listed on the page \\(1 occurrence\\(s\\), none before\\)`));
    // seen from the server: one creation, with the test name, and no other write of any kind
    expect(r.site.hits['POST /api/SaveRoleDefinition']).toBe(1);
    expect(r.site.roles.filter((n) => n === r.name)).toHaveLength(1);
    expect(JSON.parse(r.site.bodies[0]!)).toMatchObject({ roleName: r.name, description: '', preset: '0' }); // only the minimum was filled
    expect(r.site.bodies.join('')).not.toContain('revclerx'); // no email field: the email is not forced into the form
    expect(writes(r.site.hits)).toEqual(['POST /api/SaveRoleDefinition']);
    expect(r.site.hits['DELETE /api/roles/1']).toBeUndefined();
    // outside the workflow the same control stayed blocked, and exploration went on
    expect(r.results.some((x) => x.target === 'Create' && x.classification === 'BLOCKED_BY_SAFETY'), r.say).toBe(true);
    expect(r.findings.filter((f) => f.resultClass === 'BUG')).toEqual([]);
  }, 240_000);

  it('without an authorization for exactly this page, nothing is created: none, another page, or a whole-site run', async () => {
    for (const opts of [{ authorize: false }, { authorize: true, otherPage: true }, { authorize: true, scope: 'site' as const }]) {
      const r = await run('ok', opts);
      expect(r.wf, JSON.stringify(opts)).toEqual([]);
      expect(writes(r.site.hits), JSON.stringify(opts)).toEqual([]);
      expect(r.results.some((x) => x.target === 'Create' && x.classification === 'BLOCKED_BY_SAFETY'), r.say).toBe(true);
    }
  }, 400_000);

  it('a successful answer without the record being listed is INCONCLUSIVE, never a pass', async () => {
    const r = await run('not-stored');
    expect(r.wf.map((x) => x.classification), r.say).toEqual(['INCONCLUSIVE']);
    expect(r.wf[0]!.actual).toMatch(/succeeded \(HTTP 200\), but ".+" is not shown on the page after a reload; the creation is not verified/);
    expect(r.site.hits['POST /api/SaveRoleDefinition']).toBe(1); // still exactly one commit
    expect(r.findings.filter((f) => f.resultClass === 'BUG')).toEqual([]);
  }, 240_000);

  it('a rejected creation is INCONCLUSIVE, and is not retried', async () => {
    const r = await run('conflict');
    expect(r.wf.map((x) => x.classification), r.say).toEqual(['INCONCLUSIVE']);
    expect(r.wf[0]!.actual).toMatch(/answered with HTTP 409/);
    expect(r.site.hits['POST /api/SaveRoleDefinition']).toBe(1);
    expect(r.findings.filter((f) => f.resultClass === 'BUG')).toEqual([]);
  }, 240_000);

  it('when the commit would send more than one kind of write, the endpoint is not guessed and nothing is created', async () => {
    const r = await run('two-writes');
    expect(r.wf.map((x) => x.classification), r.say).toEqual(['INCONCLUSIVE']);
    expect(r.wf[0]!.actual).toMatch(/creation endpoint could not be identified with confidence .* Nothing was created/);
    expect(writes(r.site.hits)).toEqual([]);
    expect(r.site.roles).toHaveLength(2);
  }, 240_000);
});
