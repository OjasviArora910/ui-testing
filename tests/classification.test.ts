import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAxe } from '../src/accessibility/index.js';
import type { BrowserController } from '../src/browser/index.js';
import { QADatabase } from '../src/database/db.js';
import { buildPageModel } from '../src/discovery/pageModel.js';
import { classifyFinding, classifyPage, classifyResult, countFindings, groupProblems, problemKey, sameRootCause, selectTests, trackOf } from '../src/dynamic/index.js';
import { ActionBudget, ActionGuard, runFunctionalTests, type FunctionalResult } from '../src/functional/index.js';
import { buildReportData, summarizeRun } from '../src/reporting/data.js';
import { renderHtml } from '../src/reporting/html.js';
import { renderJUnit } from '../src/reporting/junit.js';
import { collectRuleContext } from '../src/rules/context.js';
import { buildRegistry } from '../src/rules/index.js';
import { loadConfig } from '../src/shared/config.js';
import { Redactor } from '../src/shared/redactor.js';
import type { Finding } from '../src/shared/types.js';
import { launchForTest } from './helpers/launch.js';

const config = loadConfig('qa.config.json', { dynamic: { maxGenericButtons: 20 } });

/**
 * A page whose UI works, but which has real accessibility problems: icon-only pagination buttons with no accessible name,
 * an unlabelled field, low-contrast text. Expected outcome: interactions EXPECTED, findings ACCESSIBILITY, zero UI/UX bugs.
 */
const ICON = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2l6 6-6 6" fill="none" stroke="currentColor"/></svg>';
const PAGE = `<!doctype html><html lang="en"><head><title>Orders</title><style>
body{font:16px system-ui,sans-serif;margin:24px}button{min-width:44px;min-height:44px;font-size:16px}td,th{padding:6px 12px;border:1px solid #999}table{border-collapse:collapse;margin:12px 0}
.hint{color:#bbb;background:#fff}</style></head><body><main>
<h1>Orders</h1><p class="hint">Showing recent orders in low contrast text</p>
<input type="text" id="quick" placeholder="">
<table><thead><tr><th>Order</th><th>Customer</th></tr></thead><tbody id="rows"></tbody></table>
<div><button type="button" id="prev">${ICON}</button> <span id="where">Page 1 of 3</span> <button type="button" id="next">${ICON}</button></div>
</main><script>
const all = Array.from({ length: 9 }, (_, i) => ['#' + (100 + i), 'Customer ' + String.fromCharCode(65 + i)]);
let page = 1;
const render = () => { document.getElementById('rows').innerHTML = all.slice((page - 1) * 3, page * 3).map((r) => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>').join('');
  document.getElementById('where').textContent = 'Page ' + page + ' of 3'; document.getElementById('prev').disabled = page === 1; document.getElementById('next').disabled = page === 3; };
document.getElementById('prev').onclick = () => { page--; render(); }; document.getElementById('next').onclick = () => { page++; render(); };
render();
</script></body></html>`;

describe('tracks: a finding is UI/UX or accessibility, never both', () => {
  const f = (o: Partial<Finding>): Pick<Finding, 'classification' | 'severity' | 'category' | 'ruleId'> => ({ classification: 'defect', severity: 'critical', category: 'accessibility', ruleId: 'a11y.button-name', ...o });

  it('an accessibility finding is ACCESSIBILITY whatever its severity, basis or review state', () => {
    for (const severity of ['critical', 'major', 'minor', 'info'] as const) expect(classifyFinding(f({ severity }))).toBe('ACCESSIBILITY');
    expect(classifyFinding(f({ classification: 'anomaly' }))).toBe('ACCESSIBILITY');
    expect(classifyFinding({ ...f({}), reviewState: 'confirmed' })).toBe('ACCESSIBILITY');
    expect(classifyFinding({ ...f({}), reviewState: 'dismissed' })).toBe('EXPECTED');
  });

  it('the track comes from what the finding is about, not from a list of known rules', () => {
    expect(trackOf({ category: 'accessibility', ruleId: 'plugin.custom-aria-check' })).toBe('accessibility'); // e.g. a rule plugin
    expect(trackOf({ category: 'custom', ruleId: 'a11y.something-new' })).toBe('accessibility');
    expect(trackOf({ category: 'layout', ruleId: 'geometry.overlap' })).toBe('uiux');
    expect(trackOf({ category: 'functional', ruleId: 'functional.button' })).toBe('uiux');
    expect(classifyFinding({ classification: 'defect', severity: 'critical', category: 'accessibility', ruleId: 'plugin.custom-aria-check' })).toBe('ACCESSIBILITY');
  });

  const full = (o: Partial<Finding>): Finding => ({ ruleId: 'functional.button', category: 'functional', severity: 'major', classification: 'defect', basis: 'deterministic', page: 'http://app.test/a', viewport: 'desktop', element: { selector: '#x' }, expected: 'e', actual: 'a', evidence: ['ev_1'], ...o });

  it('counts keep the tracks apart', () => {
    expect(countFindings([
      full({ ruleId: 'a11y.button-name', category: 'accessibility', severity: 'critical' }), full({ ruleId: 'a11y.label', category: 'accessibility', severity: 'minor' }),
      full({ ruleId: 'a11y.keyboard.unreachable', category: 'accessibility', classification: 'anomaly', basis: null }),
      full({}), full({ ruleId: 'image.distorted', category: 'layout', severity: 'minor' }), full({ ruleId: 'geometry.overlap', category: 'layout', classification: 'anomaly', basis: null }),
    ])).toEqual({ bugs: 2, warnings: 0, needsReview: 1, accessibility: 2, accessibilityNeedsReview: 1 }); // a confirmed bug is a bug whatever its severity; an anomaly is an observation
  });
});

describe('one underlying problem is reported once', () => {
  const full = (o: Partial<Finding>): Finding => ({ ruleId: 'functional.button', category: 'functional', severity: 'major', classification: 'defect', basis: 'deterministic', page: 'http://app.test/a', viewport: 'desktop', element: { selector: '#x' }, expected: 'e', actual: 'a', evidence: ['ev_1'], ...o });

  it('several controls failing on the same request are one problem with several occurrences', () => {
    const fail = (name: string, page: string) => full({ page, element: { selector: `#${name}`, name }, actual: `[network-failure] Network failure: GET http://app.test/api/orders returned HTTP 500` });
    const groups = groupProblems([fail('export', 'http://app.test/a'), fail('refresh', 'http://app.test/a'), fail('reload', 'http://app.test/b')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ resultClass: 'BUG' });
    expect(groups[0]!.occurrences).toHaveLength(3);
    expect(countFindings([fail('export', 'http://app.test/a'), fail('refresh', 'http://app.test/a'), fail('reload', 'http://app.test/b')]).bugs).toBe(1);
  });

  it('a control that cannot be clicked because of an overlap already reported is that same problem, not a second finding', () => {
    const overlap = full({ ruleId: 'geometry.overlap', category: 'layout', element: { selector: '#save' }, actual: '"Save" (180x40 at (10,120)) and "Discard" (180x40 at (90,128), #discard) are rendered on top of each other' });
    const click = (selector: string, o: Partial<Finding> = {}) => full({ element: { selector }, actual: `[clickable] <button#discard> covers "Save", so a click cannot reach it`, ...o });
    expect(sameRootCause(click('#save'), [overlap])).toBe(overlap);
    expect(sameRootCause(click('#discard'), [overlap])).toBe(overlap); // either side of the overlapping pair
    expect(sameRootCause(click('#other'), [overlap])).toBeUndefined();
    expect(sameRootCause(click('#save', { page: 'http://app.test/b' }), [overlap])).toBeUndefined(); // another page
    expect(sameRootCause(click('#save'), [{ ...overlap, classification: 'anomaly' as const }])).toBeUndefined(); // an unproven overlap does not absorb a proven failure
    expect(sameRootCause(full({ element: { selector: '#save' }, actual: '[network-failure] Network failure: GET /x returned HTTP 500' }), [overlap])).toBeUndefined();
  });

  it('different failures stay separate', () => {
    const a = full({ actual: '[network-failure] Network failure: GET http://app.test/api/orders returned HTTP 500' });
    const b = full({ actual: '[network-failure] Network failure: GET http://app.test/api/users returned HTTP 500' });
    const c = full({ actual: '[network-failure] Network failure: GET http://app.test/api/orders returned HTTP 404' });
    expect(groupProblems([a, b, c])).toHaveLength(3);
  });

  it('the same element failing at three viewport sizes is one layout problem; another element is another problem', () => {
    const clip = (viewport: string, selector = '#title', w = 120) => full({ ruleId: 'geometry.text-clipping', category: 'layout', viewport, element: { selector }, actual: `Text is clipped: content ${w + 80}px in a ${w}px box` });
    const groups = groupProblems([clip('desktop'), clip('tablet', '#title', 110), clip('mobile', '#title', 90), clip('desktop', '#subtitle')]);
    expect(groups.map((g) => g.occurrences.length).sort()).toEqual([1, 3]);
    expect(problemKey(clip('desktop'))).toBe(problemKey(clip('mobile', '#title', 90)));
  });

  it('a group takes the label of its most serious occurrence', () => {
    const msg = 'Modal opened by "X" ignores Escape; it only closes through its "Close" control';
    const groups = groupProblems([full({ ruleId: 'functional.modal', severity: 'minor', actual: msg, element: { selector: '#a' } }), full({ ruleId: 'functional.modal', severity: 'minor', actual: msg.replace('"X"', '"Y"'), element: { selector: '#b' } })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ resultClass: 'BUG' });
  });
});

describe('working UI with accessibility problems (browser)', () => {
  let server: http.Server; let url: string; let c: BrowserController;
  let results: FunctionalResult[]; let db: QADatabase; let runId: string;

  beforeAll(async () => {
    server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    c = await launchForTest({ baseUrl: url, blockExternal: true });
    const guard = new ActionGuard({ keywords: config.dangerousActions.keywords, allowMethods: config.dangerousActions.allowMethods, origin: url });
    c.setRequestGuard(guard.asRequestGuard());
    await c.navigate(`${url}/orders`); await c.settle(150);
    const model = await buildPageModel(c);
    results = await runFunctionalTests({ controller: c, guard, pageUrl: c.page.url(), model, config, budget: new ActionBudget(200), plan: selectTests(classifyPage(model), model, config) });

    // the same path a real run takes: rules -> findings -> database -> summary/reports
    await c.navigate(`${url}/orders`); await c.settle(150);
    const ctx = await collectRuleContext(c, { config, functional: results, axe: await runAxe(c) });
    const found = (await (await buildRegistry(config)).run(ctx)).findings;
    db = QADatabase.open(':memory:', new Redactor());
    runId = db.createRun({ url, mode: 'deterministic', request: { url }, config }).id;
    db.upsertPage(runId, { url: `${url}/orders`, depth: 0, statusCode: 200, title: 'Orders', testStatus: 'tested' });
    for (const x of found) db.insertFinding(runId, x);
  }, 240_000);
  afterAll(async () => { await c?.close(); db?.close(); server.closeAllConnections?.(); await new Promise((r) => server.close(() => r(undefined))); });

  it('the icon-only pagination button works: the interaction is EXPECTED', () => {
    const next = results.filter((r) => r.element?.selector === '#next');
    expect(next.map((r) => classifyResult(r))).toEqual(['EXPECTED']);
    expect(results.filter((r) => r.status === 'fail')).toEqual([]);
  });

  it('axe still reports the missing accessible name, as an ACCESSIBILITY finding', () => {
    const name = db.listFindings(runId).find((x) => x.ruleId === 'a11y.button-name')!;
    expect(name).toMatchObject({ track: 'accessibility', resultClass: 'ACCESSIBILITY', category: 'accessibility', classification: 'defect' });
    expect(name.element?.selector).toMatch(/#next|#prev/);
  });

  it('no accessibility finding is labelled BUG or WARNING, and the page has no UI/UX bug at all', () => {
    const all = db.listFindings(runId);
    const a11y = all.filter((x) => x.track === 'accessibility');
    expect(a11y.length).toBeGreaterThanOrEqual(2); // button name + at least one of label / contrast
    expect(a11y.every((x) => x.resultClass === 'ACCESSIBILITY')).toBe(true);
    expect(all.filter((x) => x.resultClass === 'BUG' || x.resultClass === 'WARNING').map((x) => `${x.ruleId}: ${x.actual}`)).toEqual([]);
  });

  it('summary and verdict: zero UI/UX defects, accessibility counted on its own, run not failed', () => {
    const { summary, verdict } = summarizeRun(db, runId);
    expect(summary.defects).toBe(0);
    expect(summary.counts).toMatchObject({ bugs: 0, warnings: 0 });
    expect(summary.counts!.accessibility).toBeGreaterThanOrEqual(2);
    expect(summary.bySeverity.critical ?? 0).toBe(0); // axe "critical" does not show up as a critical UI/UX defect
    expect(summary.byCategory.accessibility).toBeGreaterThanOrEqual(2);
    expect(['PASS', 'BLOCKED_PENDING_REVIEW']).toContain(verdict);
  });

  it('when accessibility is a required category the same findings fail the run, still as ACCESSIBILITY', () => {
    const strict = QADatabase.open(':memory:', new Redactor());
    const id = strict.createRun({ url, mode: 'deterministic', request: { url }, config: { ...config, accessibility: { ...config.accessibility, failRun: true } } }).id;
    for (const x of db.listFindings(runId)) strict.insertFinding(id, { ruleId: x.ruleId, category: x.category, severity: x.severity, classification: x.classification, basis: x.basis, page: x.page, viewport: x.viewport, element: x.element, expected: x.expected, actual: x.actual, evidence: [] });
    expect(summarizeRun(strict, id).verdict).toBe('FAILED');
    expect(summarizeRun(strict, id).summary.counts!.bugs).toBe(0);
    expect(strict.listFindings(id).filter((x) => x.track === 'accessibility').every((x) => x.resultClass === 'ACCESSIBILITY')).toBe(true);
    strict.close();
  });

  it('reports keep the tracks apart: own section and label in HTML, no failure in JUnit', () => {
    const data = buildReportData(db, runId);
    const html = renderHtml(data);
    expect(html).toMatch(/Accessibility findings \(separate from UI\/UX bugs/);
    expect(html).toMatch(/CONFIRMED UI\/UX BUGS \(0\)/);
    expect(html).toMatch(/>ACCESSIBILITY<\/span>[^<]*<span[^>]*>critical<\/span> <strong>a11y\.button-name/);
    expect(html).not.toMatch(/>BUG<\/span>/);
    expect(renderJUnit(data)).toMatch(/<testsuites name="qa-platform" tests="\d+" failures="0"/);
  });
});
