import type { Request, Response } from 'playwright';
import { shellAmong } from '../discovery/shell.js';
import { resetPage } from './helpers.js';
import type { FunctionalContext, FunctionalResult } from './types.js';

/**
 * ONE controlled creation, explicitly authorized for ONE page (config `workflows`). It runs after the generic tests and
 * uses nothing but what the page shows: it finds the creation control, opens the creation UI, fills the minimum, finds the
 * commit control, and creates exactly one clearly named test record.
 *
 * Safety:
 *  - every click and fill goes through ActionGuard; "Create"/"Save" are allowed only because the workflow authorization
 *    names them, only on the authorized page, and only between beginWorkflowStep() and endWorkflowStep();
 *  - PROBE first: the commit is clicked while NO write endpoint is authorized, so the request is stopped inside the browser
 *    and nothing is created. That shows exactly which request the UI makes. It is accepted as the creation endpoint only
 *    if it is the single write the click attempted, on the application's own origin, and it carries the test name;
 *  - COMMIT: the page is reloaded, the form is filled again and committed with exactly that endpoint authorized, once;
 *  - VERIFY: PASS only if the request succeeded AND, after a reload, the test name is on the page (it was not before).
 *    Anything else is INCONCLUSIVE. Destructive controls and DELETE stay impossible throughout (ActionGuard).
 */
export interface WorkflowPolicy {
  /** The exact page URL this workflow is authorized for. */
  page: string;
  /** Labels of the control that opens the creation UI. */
  entryLabels: string[];
  /** Labels of the control that commits the creation. */
  commitLabels: string[];
  /** Used only when the creation UI has a REQUIRED email field. */
  email?: string;
  /** Exact endpoints approved beforehand. Empty: the endpoint is identified by the probe (see above). */
  requests: { method: string; path: string }[];
  /** The name given to the single test record. */
  name: string;
}

const BASE = { kind: 'form' as const, check: 'workflow-create' };
const MARK = 'data-qa-wf';
const NEXT = /^(next|continue|proceed)\b/i;

interface Field { id: number; tag: string; type: string; label: string; required: boolean; value: string; options: string[] }
interface Control { id: number; label: string; path: string }
interface Attempt { req: Request; method: string; url: string; path: string; origin: string; carriesName: boolean; keys: string[]; status?: number }

const HELPERS = `
  const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || '1') > 0.05; };
  const text = (e) => (e ? (e.innerText || e.textContent || e.value || '') : '').replace(/\\s+/g, ' ').trim();
  // letter-spaced labels ("C r e a t e") are read as the word they spell
  const word = (s) => (/^(\\S\\s)+\\S$/.test(s) ? s.replace(/\\s/g, '') : s);
  const labelOf = (el) => word(el.getAttribute('aria-label') || text(el) || el.getAttribute('title') || el.getAttribute('value') || '').slice(0, 80);
  const CLICKABLE = 'button, a, [role=button], input[type=button], input[type=submit]';
  const FIELDS = 'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=file]):not([type=image]), select, textarea';
  const pathOf = (el) => { if (el.id) return '#' + el.id; const parts = []; for (let e = el; e && e !== document.body && parts.length < 5; e = e.parentElement) { const same = e.parentElement ? Array.from(e.parentElement.children).filter((x) => x.tagName === e.tagName) : [e]; parts.unshift(e.tagName.toLowerCase() + (same.length > 1 ? ':nth-of-type(' + (same.indexOf(e) + 1) + ')' : '')); } return parts.join(' > '); };
`;

/** Clickable controls outside dialogs whose label is one of the given labels (exactly, or followed by more words). */
const ENTRY_SCRIPT = `((labels, mark) => { ${HELPERS}
  document.querySelectorAll('[' + mark + ']').forEach((e) => e.removeAttribute(mark));
  const out = [];
  for (const el of document.querySelectorAll(CLICKABLE)) {
    if (!visible(el) || el.disabled || el.closest('dialog,[role=dialog],[aria-modal=true]')) continue;
    const l = labelOf(el).toLowerCase(); if (!l) continue;
    const exact = labels.includes(l); const starts = labels.some((x) => l.startsWith(x + ' '));
    if (!exact && !starts) continue;
    el.setAttribute(mark, 'e' + out.length);
    out.push({ id: out.length, label: labelOf(el), path: pathOf(el), exact });
  }
  return out;
})`;

const REMEMBER_SCRIPT = `(() => { ${HELPERS} window.__qaWfSeen = new WeakSet(Array.from(document.querySelectorAll(CLICKABLE + ', ' + FIELDS)).filter(visible)); return true; })()`;

/** Fields and clickable controls that became visible since REMEMBER ran: the creation UI. */
const REVEALED_SCRIPT = `((mark) => { ${HELPERS}
  const seen = window.__qaWfSeen; if (!seen) return null;
  document.querySelectorAll('[' + mark + ']').forEach((e) => e.removeAttribute(mark));
  const fieldLabel = (el) => {
    const aria = el.getAttribute('aria-label'); if (aria) return aria;
    if (el.labels && el.labels.length) { const t = text(el.labels[0]); if (t) return t; }
    const box = el.closest('.form-group, .field, .form-row, .row, tr, li, p, div');
    const t = box ? text(box).slice(0, 80) : '';
    return t || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || '';
  };
  const requiredOf = (el) => el.required === true || el.getAttribute('aria-required') === 'true' || /\\*/.test(fieldLabel(el)) || !!el.closest('.required, [class*=required], [class*=mandatory]');
  const fields = []; const controls = [];
  for (const el of document.querySelectorAll(FIELDS)) {
    if (!visible(el) || seen.has(el) || el.disabled || el.readOnly) continue;
    el.setAttribute(mark, 'f' + fields.length);
    fields.push({ id: fields.length, tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') || el.tagName).toLowerCase(), label: fieldLabel(el).slice(0, 80), required: requiredOf(el),
      value: el.type === 'checkbox' || el.type === 'radio' ? String(el.checked) : String(el.value || ''), options: el.tagName === 'SELECT' ? Array.from(el.options).filter((o) => !o.disabled && o.value !== '').map((o) => o.value).slice(0, 5) : [] });
  }
  for (const el of document.querySelectorAll(CLICKABLE)) {
    if (!visible(el) || seen.has(el) || el.disabled) continue;
    const l = labelOf(el); if (!l) continue;
    el.setAttribute(mark, 'c' + controls.length);
    controls.push({ id: controls.length, label: l, path: pathOf(el) });
  }
  return { fields, controls };
})`;

const COUNT_SCRIPT = `((name) => { let n = 0; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); while (w.nextNode()) { if ((w.currentNode.nodeValue || '').includes(name)) n++; } for (const el of document.querySelectorAll('input, textarea')) if (String(el.value || '').includes(name)) n++; return n; })`;

export async function runCreationWorkflow(ctx: FunctionalContext, policy: WorkflowPolicy): Promise<FunctionalResult[]> {
  const { controller: c, guard } = ctx;
  const results: FunctionalResult[] = [];
  const steps: string[] = [];
  const note = (s: string): void => { steps.push(s); ctx.onAction?.({ type: 'workflow', target: 'controlled creation', ok: true, detail: s }); };
  const element = { selector: policy.page, name: `Create "${policy.name}"` };
  const expected = `One test record named "${policy.name}" is created through the page's own creation UI and is listed after a reload`;
  const shot = (): Promise<Buffer | undefined> => c.page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => undefined);
  const finish = async (status: 'pass' | 'inconclusive', actual: string, extra: Record<string, unknown> = {}): Promise<FunctionalResult[]> => {
    guard.endWorkflowStep();
    const r: FunctionalResult = {
      ...BASE, status, severity: 'info', basis: null, element, expected, actual, confidence: status === 'pass' ? 'HIGH' : 'LOW', screenshot: await shot(),
      details: { steps, authorization: guard.workflowLog.map((l) => `${l.what}: ${l.why}`), ...extra },
      trace: { action: `controlled creation of "${policy.name}"`, urlBefore: policy.page, urlAfter: c.page.url(), network: [], console: [], changes: steps },
    };
    results.push(r); ctx.onResult?.(r);
    return results;
  };
  const count = (): Promise<number> => (c.page.evaluate(`${COUNT_SCRIPT}(${JSON.stringify(policy.name)})`) as Promise<number>).catch(() => 0);

  // what the commit click really sends: every write request, whether it leaves the browser or is stopped
  const attempts: Attempt[] = [];
  const onRequest = (r: Request): void => {
    const method = r.method().toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method) || guard.isReadOnlyAllowed(method, r.url())) return; // reads, including allow-listed data reads
    let u: URL; try { u = new URL(r.url()); } catch { return; }
    const body = r.postData() ?? '';
    let keys: string[] = []; try { const j = JSON.parse(body) as unknown; if (j && typeof j === 'object') keys = Object.keys(j as object).slice(0, 30); } catch { keys = [...new URLSearchParams(body).keys()].slice(0, 30); }
    attempts.push({ req: r, method, url: r.url(), path: u.pathname, origin: u.origin, carriesName: body.includes(policy.name) || decodeURIComponent(body.replace(/\+/g, ' ')).includes(policy.name), keys });
  };
  const onResponse = (r: Response): void => { const a = attempts.find((x) => x.req === r.request()); if (a) a.status = r.status(); };

  /** Opens the creation UI, fills the minimum and returns the commit control. null (with the reason noted) when it cannot. */
  const prepare = async (): Promise<{ commit: Control; filled: string[] } | string> => {
    if (!(await resetPage(ctx))) return 'the action budget is spent';
    if (!guard.beginWorkflowStep(c.page.url())) return `the browser is on ${c.page.url()}, not on the authorized page`;
    let entries = (await c.page.evaluate(`${ENTRY_SCRIPT}(${JSON.stringify(policy.entryLabels.map((l) => l.toLowerCase()))}, ${JSON.stringify(MARK)})`).catch(() => [])) as (Control & { exact: boolean })[];
    if (ctx.pageOnly && entries.length) { const shell = await shellAmong(c, entries.map((e) => `[${MARK}="e${e.id}"]`)); entries = entries.filter((e) => !shell.has(`[${MARK}="e${e.id}"]`)); }
    if (entries.some((e) => e.exact)) entries = entries.filter((e) => e.exact);
    if (entries.length === 0) return `no control labelled ${policy.entryLabels.join(' / ')} was found on the page`;
    if (entries.length > 1) return `${entries.length} controls could open a creation UI (${entries.map((e) => `"${e.label}"`).join(', ')}): ambiguous, none was used`;
    const entry = entries[0]!;
    const g = guard.check({ kind: 'click', name: entry.label, text: entry.label, selector: entry.path });
    if (!g.allowed) return `the creation control "${entry.label}" is not authorized: ${g.reason}`;
    await c.page.evaluate(REMEMBER_SCRIPT).catch(() => undefined);
    const opened = await c.click({ css: `[${MARK}="e${entry.id}"]` });
    if (!opened.ok) return `the creation control "${entry.label}" could not be clicked: ${opened.error ?? ''}`;
    await c.settle(300); await c.waitForIdle(3000);
    note(`creation control "${entry.label}" clicked (${g.reason})`);

    const filled: string[] = [];
    for (let step = 0; step < 4; step++) {
      const ui = (await c.page.evaluate(`${REVEALED_SCRIPT}(${JSON.stringify(MARK)})`).catch(() => null)) as { fields: Field[]; controls: Control[] } | null;
      if (!ui || ui.fields.length + ui.controls.length === 0) return 'the creation control was clicked but no creation UI (fields or buttons) appeared';
      if (step === 0) note(`creation UI opened: ${ui.fields.length} field(s) [${ui.fields.map((f) => `${f.label || f.type}${f.required ? '*' : ''}`).join(', ')}], controls [${ui.controls.map((x) => x.label).join(', ')}]`);
      // the minimum: required fields, and the record's name (a record must be recognisable afterwards)
      const texty = (f: Field): boolean => f.tag === 'textarea' || ['text', 'input', 'search', ''].includes(f.type);
      const nameField = ui.fields.find((f) => texty(f) && /\b(name|title)\b/i.test(f.label)) ?? (filled.some((x) => x.includes(policy.name)) ? undefined : ui.fields.find((f) => texty(f) && f.required) ?? ui.fields.find(texty));
      for (const f of ui.fields) {
        const target = { css: `[${MARK}="f${f.id}"]` };
        let value: string | null = null;
        const isEmail = f.type === 'email' || /e-?mail/i.test(f.label);
        if (f === nameField && !f.value.includes(policy.name)) value = policy.name;
        else if (!f.required || f.value !== '' && f.type !== 'checkbox') continue;
        else if (isEmail) { if (!policy.email) return `the required field "${f.label}" is an email and no test email is authorized`; value = policy.email; }
        else if (f.tag === 'select') { if (f.options.length === 0) continue; value = f.options[0]!; }
        else if (f.type === 'number') value = '1';
        else if (texty(f)) value = 'QA test';
        else continue; // checkboxes, radios, dates: not guessed
        const fg = guard.check({ kind: f.tag === 'select' ? 'select' : 'fill', name: f.label, fieldName: f.label, fieldType: f.type });
        if (!fg.allowed) return `the field "${f.label}" may not be filled: ${fg.reason}`;
        const r = f.tag === 'select' ? await c.select(target, value) : await c.fill(target, value);
        if (!r.ok) return `the field "${f.label}" could not be filled: ${r.error ?? ''}`;
        filled.push(`${f.label || f.type} = ${isEmail ? '(the authorized test email)' : value}`);
      }
      await c.settle(150);
      const commits = ui.controls.filter((x) => policy.commitLabels.some((l) => x.label.toLowerCase() === l.toLowerCase() || x.label.toLowerCase().startsWith(`${l.toLowerCase()} `)));
      if (commits.length === 1) { note(`fields filled: ${filled.join('; ') || '(none needed)'}`); return { commit: commits[0]!, filled }; }
      if (commits.length > 1) return `${commits.length} controls could commit the creation (${commits.map((x) => `"${x.label}"`).join(', ')}): ambiguous, none was used`;
      const next = ui.controls.find((x) => NEXT.test(x.label));
      if (!next) return `no commit control (${policy.commitLabels.join(' / ')}) was found in the creation UI; controls shown: ${ui.controls.map((x) => x.label).join(', ') || 'none'}`;
      const ng = guard.check({ kind: 'click', name: next.label, text: next.label, selector: next.path });
      if (!ng.allowed) return `"${next.label}" is not allowed: ${ng.reason}`;
      const moved = await c.click({ css: `[${MARK}="c${next.id}"]` });
      if (!moved.ok) return `"${next.label}" could not be clicked: ${moved.error ?? ''}`;
      await c.settle(300); await c.waitForIdle(3000);
      note(`step ${step + 1} done; "${next.label}" clicked`);
    }
    return 'the creation UI has more steps than the workflow follows (4)';
  };

  /** Clicks the commit control (through ActionGuard) and returns the write requests that click attempted. */
  const commit = async (ctl: Control): Promise<Attempt[] | string> => {
    const g = guard.check({ kind: 'click', name: ctl.label, text: ctl.label, selector: ctl.path });
    if (!g.allowed) return `the commit control "${ctl.label}" is not authorized: ${g.reason}`;
    const from = attempts.length;
    c.beginAction();
    const r = await c.click({ css: `[${MARK}="c${ctl.id}"]` });
    if (!r.ok) return `the commit control "${ctl.label}" could not be clicked: ${r.error ?? ''}`;
    await c.settle(400); await c.waitForIdle(8000);
    return attempts.slice(from);
  };

  const refused = guard.authorizeWorkflow({ page: policy.page, labels: [...policy.entryLabels, ...policy.commitLabels].filter((l) => guard.isMutatingLabel(l)), requests: policy.requests, maxCommits: 1 });
  if (refused.length) note(`parts of the authorization were refused: ${refused.join('; ')}`);
  c.page.on('request', onRequest); c.page.on('response', onResponse);
  try {
    const before = await count();
    if (before > 0) return await finish('inconclusive', `A record named "${policy.name}" is already on the page (${before} occurrence(s)); nothing was created`);

    let endpoint = policy.requests[0] ? { method: policy.requests[0].method.toUpperCase(), path: policy.requests[0].path } : null;
    // ---- PROBE: nothing is authorized to leave the browser, so the commit click only shows what it would send
    if (!endpoint) {
      const ready = await prepare();
      if (typeof ready === 'string') return await finish('inconclusive', `The creation workflow stopped before anything was sent: ${ready}`);
      const tried = await commit(ready.commit);
      guard.endWorkflowStep();
      if (typeof tried === 'string') return await finish('inconclusive', `The creation workflow stopped before anything was sent: ${tried}`);
      if (guard.workflowCommits > 0 || tried.some((a) => a.status !== undefined)) return await finish('inconclusive', 'A write request left the browser during the probe, which must not happen; the workflow was stopped', { attempts: tried.map((a) => `${a.method} ${a.path} -> ${a.status ?? 'stopped'}`) });
      const own = tried.filter((a) => a.origin === new URL(policy.page).origin);
      note(`probe: the commit control "${ready.commit.label}" attempted ${tried.length} write request(s): ${tried.map((a) => `${a.method} ${a.path}${a.carriesName ? ' (carries the test name)' : ''} fields [${a.keys.join(', ')}]`).join(' | ') || 'none'}; all were stopped in the browser`);
      const candidates = own.filter((a) => a.carriesName);
      if (candidates.length !== 1 || new Set(own.map((a) => `${a.method} ${a.path}`)).size !== 1) {
        return await finish('inconclusive', `The creation endpoint could not be identified with confidence (${own.length} write request(s) to the application, ${candidates.length} carrying the test name). Nothing was created`, { attempts: tried.map((a) => `${a.method} ${a.path}`) });
      }
      endpoint = { method: candidates[0]!.method, path: candidates[0]!.path };
      const no = guard.authorizeWorkflow({ page: policy.page, labels: [...policy.entryLabels, ...policy.commitLabels].filter((l) => guard.isMutatingLabel(l)), requests: [endpoint], maxCommits: 1 });
      if (no.length) return await finish('inconclusive', `The request the creation UI makes (${endpoint.method} ${endpoint.path}) can never be authorized: ${no.join('; ')}. Nothing was created`);
      note(`creation endpoint identified and authorized for one commit: ${endpoint.method} ${endpoint.path}`);
    }

    // ---- COMMIT: a fresh page, the same steps, exactly one authorized request
    const ready = await prepare();
    if (typeof ready === 'string') return await finish('inconclusive', `The creation workflow stopped before the commit: ${ready}. Nothing was created`);
    const sent = await commit(ready.commit);
    guard.endWorkflowStep();
    if (typeof sent === 'string') return await finish('inconclusive', `The creation workflow stopped at the commit: ${sent}`);
    const done = sent.find((a) => a.method === endpoint!.method && a.path === endpoint!.path && a.status !== undefined);
    const others = sent.filter((a) => a !== done);
    note(`commit: ${done ? `${done.method} ${done.path} -> HTTP ${done.status}` : 'the authorized request was not sent'}${others.length ? `; ${others.length} other write request(s) were stopped in the browser (${others.map((a) => `${a.method} ${a.path}`).join(', ')})` : ''}`);
    const evidence = { endpoint: `${endpoint.method} ${endpoint.path}`, status: done?.status ?? null, commits: guard.workflowCommits, filled: ready.filled, stopped: others.map((a) => `${a.method} ${a.path}`) };
    if (!done || guard.workflowCommits !== 1) return await finish('inconclusive', `The authorized creation request ${endpoint.method} ${endpoint.path} did not complete (${guard.workflowCommits} sent). Whether a record was created is not known`, evidence);
    if (done.status! < 200 || done.status! >= 300) return await finish('inconclusive', `The creation request ${endpoint.method} ${endpoint.path} was answered with HTTP ${done.status}; the record is not confirmed`, evidence);

    // ---- VERIFY: only what a reload shows counts
    if (!(await resetPage(ctx))) return await finish('inconclusive', `The creation request succeeded (HTTP ${done.status}) but the page could not be reloaded to verify it`, evidence);
    await c.waitForIdle(4000);
    const after = await count();
    note(`after reload: "${policy.name}" appears ${after} time(s) on the page (before: ${before})`);
    if (after < 1) return await finish('inconclusive', `The creation request ${endpoint.method} ${endpoint.path} succeeded (HTTP ${done.status}), but "${policy.name}" is not shown on the page after a reload; the creation is not verified`, { ...evidence, listedAfterReload: after });
    return await finish('pass', `Created "${policy.name}" with one ${endpoint.method} ${endpoint.path} (HTTP ${done.status}); after a reload it is listed on the page (${after} occurrence(s), none before)`, { ...evidence, listedAfterReload: after });
  } finally {
    guard.endWorkflowStep();
    c.page.off('request', onRequest); c.page.off('response', onResponse);
    await c.page.evaluate(`document.querySelectorAll('[${MARK}]').forEach((e) => e.removeAttribute('${MARK}'))`).catch(() => undefined);
  }
}
