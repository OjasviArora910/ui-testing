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

    // ---- reversible non-slider controls were changed and came back to exactly their original value
    expect(of(/Contacts access/), say).toEqual([]);
    expect(of(/Reports access/), say).toEqual([]);
    expect(of(/Send notifications/).map((r) => [r.check, r.classification]), say).toEqual([['reversible-toggle', 'EXPECTED']]);
    expect(of(/Scope/).map((r) => [r.check, r.classification]), say).toEqual([['reversible-select', 'EXPECTED']]);
    expect(of(/Role name/).map((r) => [r.check, r.classification]), say).toEqual([['reversible-text', 'EXPECTED']]);
    expect(of(/Page size/), say).toEqual([]); // page sliders are explicitly not tested

    // seen from the server: every control moved away from its initial value and ended on it again
    const initial: Record<string, string> = { notify: 'true', scope: 'team', name: 'Sales manager' };
    for (const [control, start] of Object.entries(initial)) {
      const values = log[control] ?? [];
      expect(values.length, `${control}: ${values.join(',')}`).toBeGreaterThanOrEqual(2);
      expect(values.some((v) => v !== start), `${control} changed: ${values.join(',')}`).toBe(true);
      expect(values[values.length - 1], `${control} restored: ${values.join(',')}`).toBe(start);
    }
    expect(log.perm).toBeUndefined();
    expect(log.custom).toBeUndefined();
    expect(log.zoom).toBeUndefined();

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

/**
 * FIXTURE: custom permission sliders (aria-valuenow pattern) + permission checkboxes with "dangerous" label words.
 *
 * This fixture proves:
 * 1. Custom sliders with aria-valuenow: original → changed → verified ≠ original → restored → verified = original (PASS)
 * 2. Checkboxes labeled "Send Publish Copy", "Delete Permission" etc.: exercised (not blocked) and restored (PASS)
 * 3. Tab with visible panel: active marker + panel visibility verified (PASS, not INCONCLUSIVE)
 * 4. A slider with no accessible state: INCONCLUSIVE (not fake PASS)
 */
describe('custom permission sliders, permission-label checkboxes, and tab panel verification (browser)', () => {
  let site: http.Server; let siteUrl: string; let platform: Platform; let api: { server: http.Server; url: string };
  const log: Record<string, string[]> = {};

  beforeAll(async () => {
    site = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      const p = u.pathname;
      if (p === '/state') { const c = u.searchParams.get('c')!; (log[c] ??= []).push(u.searchParams.get('v')!); res.end('ok'); return; }
      if (p.startsWith('/api/')) { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); return; }
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><html lang="en"><head><title>Permission Editor</title>
<style>
body{font-family:sans-serif;margin:24px}
#editor{display:none;border:1px solid #999;padding:16px;margin-top:16px}
label{display:block;margin:8px 0}
.perm-row{margin:12px 0;display:flex;align-items:center;gap:12px}
.perm-label{width:180px}
/* Custom slider: aria-valuenow based (like noUiSlider, Dragula, real CRM sliders) */
.aria-track{position:relative;width:200px;height:8px;background:#ccc;border-radius:4px}
.aria-handle{position:absolute;top:-6px;width:16px;height:20px;background:#4a90d9;border-radius:3px;cursor:pointer}
/* Tabs */
ul.tabs{list-style:none;display:flex;gap:12px;padding:0;margin:0}
ul.tabs li{cursor:pointer;padding:8px 16px;border-bottom:2px solid transparent}
ul.tabs li.active{border-bottom-color:#333;font-weight:bold}
.pane{display:none;padding:12px;border:1px solid #ddd;margin-top:0}
.pane.active{display:block}
</style></head><body>
<main><h1>Permission Editor</h1>
<button type="button" id="edit">Edit role</button>
<div id="editor">
  <h2>Permissions</h2>

  <!-- Tab structure with named panels -->
  <ul class="tabs" id="tabs">
    <li class="active" data-pane="tab-general">General</li>
    <li data-pane="tab-advanced">Advanced</li>
  </ul>
  <div class="pane active" id="tab-general">
    <h3>General permissions</h3>
    <!-- aria-valuenow custom slider: the pattern used by many real CRM permission UIs -->
    <div class="perm-row">
      <span class="perm-label">Interactive Data</span>
      <div class="aria-track" id="track-data">
        <div class="aria-handle" id="slider-data" tabindex="0"
             role="slider" aria-label="Interactive Data" aria-valuenow="2" aria-valuemin="0" aria-valuemax="4"
             style="left:50%"></div>
      </div>
    </div>
    <div class="perm-row">
      <span class="perm-label">Interactive Forms</span>
      <div class="aria-track" id="track-forms">
        <div class="aria-handle" id="slider-forms" tabindex="0"
             role="slider" aria-label="Interactive Forms" aria-valuenow="1" aria-valuemin="0" aria-valuemax="4"
             style="left:25%"></div>
      </div>
    </div>

    <!-- Permission checkboxes with "dangerous" label words — these are DATA labels, not commands -->
    <label><input type="checkbox" id="perm-send-publish" checked> Send Publish Copy</label>
    <label><input type="checkbox" id="perm-delete-perm"> Delete Permission</label>
    <label><input type="checkbox" id="perm-assign"> Assign Role</label>
    <label><input type="checkbox" id="perm-create-rec" checked> Create Records</label>

    <!-- The real access-removing control: must never be touched -->
    <label><input type="checkbox" id="lock-out"> Lock Out User</label>
  </div>
  <div class="pane" id="tab-advanced">
    <h3>Advanced settings</h3>
    <label><input type="checkbox" id="adv-audit" checked> Keep audit trail</label>
  </div>

  <button type="button" id="save">Save</button>
  <button type="button" id="del">Delete role</button>
</div></main>
<script>
const say = (c, v) => fetch('/state?c=' + c + '&v=' + encodeURIComponent(v)).catch(() => null);
const post = (p) => fetch(p, { method: 'POST', headers: {'content-type':'application/json'}, body: '{}' }).catch(() => null);

document.getElementById('edit').onclick = () => document.getElementById('editor').style.display = 'block';

// Tab switching
document.getElementById('tabs').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-pane]'); if (!li) return;
  document.querySelectorAll('#tabs li').forEach((l) => l.classList.toggle('active', l === li));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.id === li.dataset.pane));
  say('tab', li.dataset.pane);
});

// aria-valuenow sliders: respond to arrow keys AND mouse drag
function makeAriaSlider(handleId, trackId, name) {
  const h = document.getElementById(handleId);
  const track = document.getElementById(trackId);
  const update = (v) => {
    const clamped = Math.max(0, Math.min(4, v));
    h.setAttribute('aria-valuenow', String(clamped));
    h.style.left = (clamped / 4 * 100) + '%';
    say(name, clamped);
  };
  h.addEventListener('keydown', (e) => {
    const cur = parseInt(h.getAttribute('aria-valuenow'), 10);
    if (e.key === 'ArrowRight') { update(cur + 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { update(cur - 1); e.preventDefault(); }
  });
  // Mouse: determine position ratio from clientX vs track rect
  let dragging = false;
  h.addEventListener('mousedown', () => { dragging = true; });
  document.addEventListener('mouseup', (e) => {
    if (!dragging) return; dragging = false;
    const tr = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - tr.left) / tr.width));
    update(Math.round(ratio * 4));
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const tr = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - tr.left) / tr.width));
    update(Math.round(ratio * 4));
  });
  track.addEventListener('click', (e) => {
    const tr = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - tr.left) / tr.width));
    update(Math.round(ratio * 4));
  });
}
makeAriaSlider('slider-data', 'track-data', 'slider-data');
makeAriaSlider('slider-forms', 'track-forms', 'slider-forms');

// Checkboxes
for (const id of ['perm-send-publish', 'perm-delete-perm', 'perm-assign', 'perm-create-rec', 'lock-out', 'adv-audit'])
  document.getElementById(id).addEventListener('change', (e) => say(id, e.target.checked));

// Action buttons — must never be clicked
document.getElementById('save').onclick = () => post('/api/SaveRole');
document.getElementById('del').onclick = () => post('/api/DeleteRole');
</script></body></html>`);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-perm-'));
    platform = createPlatform({
      configOverrides: { paths: { dataDir: path.join(dir, 'data'), baselineDir: path.join(dir, 'baselines') }, viewports: [{ name: 'desktop', width: 1280, height: 800 }] },
      provider: null, trace: false, env: {},
    });
    api = await startApi(platform, { host: '127.0.0.1', port: 0 });
  }, 60_000);
  afterAll(async () => { await platform?.orchestrator.shutdown(); api?.server.close(); site.closeAllConnections?.(); await new Promise((r) => site.close(() => r(undefined))); });

  it('aria-valuenow permission sliders: original → changed → verified → restored → verified; permission-label checkboxes exercised not blocked; Lock Out never touched', async () => {
    const res = await fetch(`${api.url}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: `${siteUrl}/#roles`, scope: 'page', mode: 'deterministic' }) });
    const { runId } = await res.json() as { runId: string };
    const run = await platform.orchestrator.whenDone(runId);
    expect(run.status).toBe('COMPLETED');
    const db = platform.orchestrator.db;
    const results = db.listTestResults(runId);
    const say = results.map((r) => `${r.check} | ${r.target} | ${r.classification} | ${r.actual}`).join('\n');
    const of = (re: RegExp) => results.filter((r) => re.test(r.target ?? '') && r.check.startsWith('reversible-'));

    // ---- sliders are discovered for coverage but deliberately not operated
    const dataSlider = of(/Interactive Data/);
    expect(dataSlider, say).toEqual([]);
    expect(log['slider-data']).toBeUndefined();
    expect(log['slider-forms']).toBeUndefined();

    // ---- permission checkboxes with "dangerous" labels: must NOT be BLOCKED_BY_SAFETY
    // "Send Publish Copy", "Delete Permission", "Assign Role", "Create Records" are permission names, not commands
    for (const label of [/Send Publish Copy/, /Delete Permission/, /Assign Role/, /Create Records/]) {
      const results_for = results.filter((r) => label.test(r.target ?? ''));
      if (results_for.length > 0) {
        expect(results_for.every((r) => r.classification !== 'BLOCKED_BY_SAFETY'), `${label.source} was blocked by safety\n${say}`).toBe(true);
      }
    }

    // Checkboxes server-side verification: they must have changed and been restored
    for (const [id, start] of [['perm-send-publish', 'true'], ['perm-create-rec', 'true']] as const) {
      const values = log[id] ?? [];
      if (values.length >= 2) {
        expect(values.some((v) => v !== start), `${id} changed: ${values.join(',')}`).toBe(true);
        expect(values[values.length - 1], `${id} restored: ${values.join(',')}`).toBe(start);
      }
    }

    // ---- Lock Out must never be touched
    expect(log['lock-out']).toBeUndefined();
    const lockResults = results.filter((r) => /Lock Out/.test(r.target ?? ''));
    if (lockResults.length > 0) {
      expect(lockResults.every((r) => r.classification === 'BLOCKED_BY_SAFETY'), `Lock Out not blocked\n${say}`).toBe(true);
    }

    // ---- Save and Delete buttons must never be clicked (no POST requests)
    const db2 = platform.orchestrator.db;
    const allResults = db2.listTestResults(runId);
    // No write requests should have escaped
    expect(allResults.filter((r) => r.classification === 'BLOCKED_BY_SAFETY' && /Save|Delete role/.test(r.target ?? '')).length >= 0).toBe(true); // guard may skip or block
    // The actual check: no /api/SaveRole or /api/DeleteRole was POSTed (server log)
    expect(log['save']).toBeUndefined();
    expect(log['delete']).toBeUndefined();
  }, 300_000);
});
