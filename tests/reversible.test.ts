import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from '../src/api/index.js';
import { createPlatform, type Platform } from '../src/orchestrator/index.js';

/**
 * TEST -> VERIFY -> RESTORE -> CONTINUE. A page with an editor that opens on a click and holds permission sliders, a
 * checkbox, a select, a text field, an access-removing switch, a broken checkbox, and Save / Delete buttons.
 * Every safe control must be operated, verified and put back exactly; nothing may be saved, deleted or locked out.
 * The page reports every state change of its controls to the server (a GET), so restoration is checked from outside.
 */
describe('reversible controls: test, verify, restore (browser)', () => {
  let site: http.Server; let siteUrl: string; let platform: Platform; let api: { server: http.Server; url: string };
  const hits: Record<string, number> = {};
  const log: Record<string, string[]> = {}; // control -> the values it went through

  beforeAll(async () => {
    site = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      const p = u.pathname;
      hits[`${req.method} ${p}`] = (hits[`${req.method} ${p}`] ?? 0) + 1;
      if (p === '/state') { const c = u.searchParams.get('c')!; (log[c] ??= []).push(u.searchParams.get('v')!); res.end('ok'); return; }
      if (p.startsWith('/api/')) { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); return; }
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><html lang="en"><head><title>Roles</title>
<style>body{font-family:sans-serif;margin:24px}#editor{display:none;border:1px solid #999;padding:16px;margin-top:16px}
.ui-slider{position:relative;width:200px;height:8px;background:#ccc;margin:14px 0}.ui-slider-handle{position:absolute;top:-6px;width:16px;height:20px;background:#246;display:block}
label{display:block;margin:8px 0}</style></head><body>
<main><h1>Roles</h1>
<label>Page size <input type="range" id="zoom" min="0" max="10" value="4"></label>
<button type="button" id="edit">Edit role</button>
<div id="editor">
  <h2>Permissions</h2>
  <label>Contacts access <input type="range" id="perm" min="0" max="4" value="4"></label>
  <div class="row">Reports access <div class="ui-slider"><span class="ui-slider-handle" id="custom" tabindex="0" style="left: 50%"></span></div></div>
  <label><input type="checkbox" id="notify" checked> Send notifications</label>
  <label><input type="checkbox" id="broken"> Weekly digest</label>
  <label><input type="checkbox" id="lock"> Lock Out</label>
  <label>Scope <select id="scope"><option value="own">Own</option><option value="team" selected>Team</option><option value="all">All</option></select></label>
  <label>Role name <input type="text" id="name" value="Sales manager"></label>
  <button type="button" id="save">Save</button> <button type="button" id="del">Delete role</button>
</div></main>
<script>
const say = (c, v) => fetch('/state?c=' + c + '&v=' + encodeURIComponent(v)).catch(() => null);
const post = (p) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null);
document.getElementById('edit').onclick = () => { document.getElementById('editor').style.display = 'block'; };
for (const id of ['zoom', 'perm', 'scope', 'name']) document.getElementById(id).addEventListener('input', (e) => say(id, e.target.value));
for (const id of ['notify', 'lock']) document.getElementById(id).addEventListener('change', (e) => say(id, e.target.checked));
document.getElementById('broken').addEventListener('click', (e) => e.preventDefault()); // a checkbox that does not work
const h = document.getElementById('custom');
h.addEventListener('keydown', (e) => { // a library-style slider: no role, no input, moved with the arrow keys
  let v = parseInt(h.style.left, 10);
  if (e.key === 'ArrowRight') v = Math.min(100, v + 25); else if (e.key === 'ArrowLeft') v = Math.max(0, v - 25); else return;
  h.style.left = v + '%'; say('custom', v);
});
document.getElementById('save').onclick = () => post('/api/SaveRole');
document.getElementById('del').onclick = () => post('/api/DeleteRole');
</script></body></html>`);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-rev-'));
    platform = createPlatform({
      configOverrides: { paths: { dataDir: path.join(dir, 'data'), baselineDir: path.join(dir, 'baselines') }, viewports: [{ name: 'desktop', width: 1280, height: 800 }] },
      provider: null, trace: false, env: {},
    });
    api = await startApi(platform, { host: '127.0.0.1', port: 0 });
  }, 60_000);
  afterAll(async () => { await platform?.orchestrator.shutdown(); api?.server.close(); site.closeAllConnections?.(); await new Promise((r) => site.close(() => r(undefined))); });

  it('operates each safe control, verifies it, restores it exactly, and never saves, deletes or locks out', async () => {
    const res = await fetch(`${api.url}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: `${siteUrl}/#setup/roles`, scope: 'page', mode: 'deterministic' }) });
    const { runId } = await res.json() as { runId: string };
    const run = await platform.orchestrator.whenDone(runId);
    expect(run.status).toBe('COMPLETED');
    const db = platform.orchestrator.db;
    const results = db.listTestResults(runId);
    const say = results.map((r) => `${r.check} | ${r.target} | ${r.classification} | ${r.actual}`).join('\n');
    const of = (re: RegExp) => results.filter((r) => re.test(r.target ?? '') && r.check.startsWith('reversible-'));

    // ---- each control was changed and came back to exactly its original value
    expect(of(/Contacts access/).map((r) => [r.check, r.classification]), say).toEqual([['reversible-slider', 'EXPECTED']]);
    expect(of(/Reports access/).map((r) => [r.check, r.classification]), say).toEqual([['reversible-slider', 'EXPECTED']]);
    expect(of(/Send notifications/).map((r) => [r.check, r.classification]), say).toEqual([['reversible-toggle', 'EXPECTED']]);
    expect(of(/Scope/).map((r) => [r.check, r.classification]), say).toEqual([['reversible-select', 'EXPECTED']]);
    expect(of(/Role name/).map((r) => [r.check, r.classification]), say).toEqual([['reversible-text', 'EXPECTED']]);
    expect(of(/Page size/).some((r) => r.classification === 'EXPECTED'), say).toBe(true); // a slider on the page itself
    expect(of(/Contacts access/)[0]!.actual).toMatch(/Responded \(4 -> 3\) and was restored to its original state \(4\)/); // at its maximum: moved the other way

    // seen from the server: every control moved away from its initial value and ended on it again
    const initial: Record<string, string> = { perm: '4', custom: '50', notify: 'true', scope: 'team', name: 'Sales manager', zoom: '4' };
    for (const [control, start] of Object.entries(initial)) {
      const values = log[control] ?? [];
      expect(values.length, `${control}: ${values.join(',')}`).toBeGreaterThanOrEqual(2);
      expect(values.some((v) => v !== start), `${control} changed: ${values.join(',')}`).toBe(true);
      expect(values[values.length - 1], `${control} restored: ${values.join(',')}`).toBe(start);
    }

    // ---- never touched: the access-removing switch, Save, Delete
    expect(log.lock).toBeUndefined();
    expect(results.filter((r) => /Lock Out/.test(r.target ?? '')).every((r) => r.classification === 'BLOCKED_BY_SAFETY'), say).toBe(true);
    expect(hits['POST /api/SaveRole']).toBeUndefined();
    expect(hits['POST /api/DeleteRole']).toBeUndefined();
    expect(results.some((r) => r.target === 'Save' || r.target === 'Delete role'), say).toBe(false);

    // ---- a control that really does not work is a confirmed bug, with evidence; nothing else is
    const bugs = db.listFindings(runId).filter((f) => f.resultClass === 'BUG');
    expect(bugs.map((f) => f.actual), say).toEqual([expect.stringMatching(/"Weekly digest" was operated \(toggle it\) but its state stayed false/)]);
    expect(bugs[0]!.evidence.length).toBeGreaterThan(0);
  }, 240_000);
});
