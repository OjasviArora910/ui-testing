import { describe, expect, it } from 'vitest';
import { ActionGuard } from '../src/functional/index.js';
import { loadConfig } from '../src/shared/config.js';

const config = loadConfig('qa.config.json');
const ORIGIN = 'https://app.test';
const PAGE = `${ORIGIN}/#setup/roles`;
const mk = (extra: Partial<ConstructorParameters<typeof ActionGuard>[0]> = {}) =>
  new ActionGuard({ keywords: config.dangerousActions.keywords, allowMethods: config.dangerousActions.allowMethods, origin: ORIGIN, ...extra });
const click = (g: ActionGuard, text: string) => g.check({ kind: 'click', text });
const send = (g: ActionGuard, method: string, path: string, origin = ORIGIN) => g.requestDecision({ method, url: `${origin}${path}` });

describe('safety tiers: destructive never, mutating only when explicitly authorized', () => {
  it('mutating and destructive controls are blocked by default, each with its tier', () => {
    const g = mk();
    for (const t of ['Create', 'C r e a t e', 'Save', 'Update', 'Assign', 'Publish', 'Submit', 'Confirm', 'Yes']) expect(click(g, t), t).toMatchObject({ allowed: false, tier: 'mutating' });
    for (const t of ['Delete', 'Remove', 'Purge', 'Destroy', 'Lock Out', 'Delete permanently', 'Move to trash', 'Log out']) expect(click(g, t), t).toMatchObject({ allowed: false, tier: 'destructive' });
    // the same spaced label arriving as text AND accessible name AND next to a selector, as it does from a real page
    for (const t of ['C r e a t e', 'S a v e', 'D e l e t e']) expect(g.check({ kind: 'click', text: t, name: t, selector: 'body > div:nth-of-type(9) > div > a' }).allowed, t).toBe(false);
    expect(g.check({ kind: 'click', text: 'C r e a t e role', name: 'C r e a t e role' }).allowed).toBe(false);
    expect(click(g, 'Save and delete')).toMatchObject({ allowed: false, tier: 'destructive' }); // the destructive word decides
    for (const t of ['View details', 'Edit', 'Open', 'Close', 'Cancel', 'Next']) expect(click(g, t).allowed, t).toBe(true);
  });

  it('DELETE never leaves the browser: not with writes enabled, not through an allow-list, not through a workflow', () => {
    const plain = mk();
    expect(send(plain, 'DELETE', '/api/roles/1')).toMatchObject({ allowed: false, reason: 'DELETE requests are never allowed', tier: 'destructive' });

    const writes = mk({ allowWrites: true });
    expect(send(writes, 'POST', '/api/anything').allowed).toBe(true); // the opt-in really is on...
    expect(send(writes, 'DELETE', '/api/anything').allowed).toBe(false); // ...and DELETE is still refused
    expect(send(writes, 'DELETE', '/api/GetRoles').allowed).toBe(false);
    for (const p of ['/api/DeleteRole', '/api/RemoveRole', '/api/PurgeRoles', '/api/roles/destroy', '/api/LockOutUser']) expect(send(writes, 'POST', p).allowed, p).toBe(false);

    const listed = mk({ allowedRequests: [{ origin: ORIGIN, method: 'DELETE', path: '/api/roles' }, { origin: ORIGIN, method: 'POST', path: '/api/GetRoles' }] });
    expect(send(listed, 'DELETE', '/api/roles').allowed).toBe(false);
    expect(send(listed, 'POST', '/api/GetRoles').allowed).toBe(true);

    const wf = mk();
    const refused = wf.authorizeWorkflow({ page: PAGE, labels: ['create', 'delete', 'remove', 'lock out'], requests: [{ method: 'DELETE', path: '/api/roles' }, { method: 'POST', path: '/api/DeleteRole' }, { method: 'POST', path: '/api/*' }, { method: 'GET', path: '/api/x' }, { method: 'POST', path: '/api/CreateRole' }] });
    expect(refused).toHaveLength(7); // 3 destructive labels + DELETE + destructive path + wildcard + non-write method
    expect(wf.beginWorkflowStep(PAGE)).toBe(true);
    expect(send(wf, 'DELETE', '/api/roles').allowed).toBe(false);
    expect(send(wf, 'DELETE', '/api/CreateRole').allowed).toBe(false);
    expect(send(wf, 'POST', '/api/DeleteRole').allowed).toBe(false);
    for (const t of ['Delete', 'Remove', 'Lock Out', 'Purge']) expect(click(wf, t), t).toMatchObject({ allowed: false, tier: 'destructive' });
  });

  it('an authorized creation request is allowed only on its page, during its step, once; everything else stays blocked', () => {
    const g = mk();
    expect(g.authorizeWorkflow({ page: PAGE, labels: ['create', 'save'], requests: [{ method: 'POST', path: '/api/CreateRole' }] })).toEqual([]);

    // registered but not active: nothing changes
    expect(send(g, 'POST', '/api/CreateRole').allowed).toBe(false);
    expect(click(g, 'Save').allowed).toBe(false);

    // another page of the same application: the step does not start
    expect(g.beginWorkflowStep(`${ORIGIN}/#setup/users`)).toBe(false);
    expect(send(g, 'POST', '/api/CreateRole').allowed).toBe(false);
    expect(click(g, 'Create').allowed).toBe(false);

    // the authorized page, during the step
    expect(g.beginWorkflowStep(PAGE)).toBe(true);
    expect(click(g, 'Save')).toMatchObject({ allowed: true, tier: 'mutating' });
    expect(click(g, 'Publish').allowed).toBe(false); // a mutating action the workflow does not name
    expect(send(g, 'POST', '/api/UpdateRole').allowed).toBe(false); // unrelated endpoints
    expect(send(g, 'POST', '/api/SendInvitation').allowed).toBe(false);
    expect(send(g, 'PUT', '/api/CreateRole').allowed).toBe(false); // another method
    expect(send(g, 'POST', '/api/CreateRole/1').allowed).toBe(false); // a look-alike path
    expect(send(g, 'POST', '/api/CreateRole', 'https://other.test').allowed).toBe(false); // another origin
    expect(g.workflowCommits).toBe(0);
    expect(send(g, 'POST', '/api/CreateRole')).toMatchObject({ allowed: true, reason: 'authorized workflow request POST /api/CreateRole' });
    expect(g.workflowCommits).toBe(1);
    expect(send(g, 'POST', '/api/CreateRole')).toMatchObject({ allowed: false, matched: 'workflow-budget' }); // at most one commit
    expect(g.workflowCommits).toBe(1);

    // after the step
    g.endWorkflowStep();
    expect(click(g, 'Save').allowed).toBe(false);
    expect(send(g, 'POST', '/api/CreateRole').allowed).toBe(false);
    // every use is on record with its reason
    expect(g.workflowLog.map((l) => l.what)).toEqual(expect.arrayContaining(['workflow step refused', 'workflow step started', 'control "Save" allowed', 'request POST /api/CreateRole allowed', 'workflow step ended']));
    expect(g.workflowLog.find((l) => l.what.startsWith('request'))!.why).toMatch(/exact endpoint of the active workflow authorization for https:\/\/app\.test\/#setup\/roles \(commit 1 of 1\)/);
  });

  it('a workflow for another site, or more than one commit, cannot be registered', () => {
    const g = mk();
    expect(g.authorizeWorkflow({ page: 'https://other.test/#x', labels: ['create'], requests: [{ method: 'POST', path: '/api/CreateRole' }] })).toHaveLength(1);
    expect(g.beginWorkflowStep('https://other.test/#x')).toBe(false);
    const many = mk();
    many.authorizeWorkflow({ page: PAGE, labels: ['create'], requests: [{ method: 'POST', path: '/api/CreateRole' }], maxCommits: 50 });
    many.beginWorkflowStep(PAGE);
    expect(send(many, 'POST', '/api/CreateRole').allowed).toBe(true);
    expect(send(many, 'POST', '/api/CreateRole').allowed).toBe(false);
  });

  it('reads and the read-only allow-list behave as before', () => {
    const g = mk({ allowedRequests: [{ origin: ORIGIN, method: 'POST', path: '/api/GetRoles' }] });
    expect(send(g, 'GET', '/api/x').allowed).toBe(true);
    expect(send(g, 'GET', '/api/delete-account').allowed).toBe(false);
    expect(send(g, 'POST', '/api/GetRoles').allowed).toBe(true);
    expect(send(g, 'POST', '/api/GetRolesForUser').allowed).toBe(false);
    expect(send(g, 'POST', '/api/x')).toMatchObject({ allowed: false, reason: 'write method POST blocked' });
  });

  /**
   * REGRESSION: Permission control labels contain permission NAMES, not action commands.
   *
   * "Send Publish Copy" is the name of a permission setting — a checkbox whose label says "Send Publish Copy" is
   * configuring whether someone has that permission. It is NOT a command to publish something.
   * "Delete Permission" (a checkbox) configures a permission — it is not a command to delete something.
   *
   * Safety must distinguish:
   *   <checkbox> "Send Publish Copy"  → reversible configuration DATA → ALLOWED (check kind)
   *   <checkbox> "Delete Permission"  → reversible configuration DATA → ALLOWED (check kind)
   *   <button>   "Publish"            → action command → BLOCKED       (click kind)
   *   <button>   "Delete"             → action command → BLOCKED       (click kind)
   *   <a role=menuitem> "Delete"      → action command → BLOCKED       (click kind)
   *
   * The element semantics / action kind must matter more than arbitrary text inside configuration data.
   */
  it('setting labels with dangerous words are data, not commands; permission / role settings are refused; action buttons with the same words are blocked', () => {
    const g = mk();

    // Checkboxes (kind=check): label is a PERMISSION NAME, not an action. Must be allowed regardless of words.
    expect(g.check({ kind: 'check', text: 'Send Publish Copy', name: 'Send Publish Copy' }).allowed, 'check: Send Publish Copy').toBe(true);
    expect(g.check({ kind: 'check', text: 'Delete Permission', name: 'Delete Permission' }).allowed, 'check: Delete Permission').toBe(false); // names a permission: a sensitive setting, refused (see tests/sensitive_actions.test.ts)
    expect(g.check({ kind: 'check', text: 'Remove Access', name: 'Remove Access' }).allowed, 'check: Remove Access').toBe(true);
    expect(g.check({ kind: 'check', text: 'Assign Role', name: 'Assign Role' }).allowed, 'check: Assign Role').toBe(false); // names a role: a sensitive setting, refused
    // the same harmless-looking label is refused when the control sits in a permission / role / access context
    expect(g.check({ kind: 'check', text: 'Send Publish Copy', name: 'Send Publish Copy', context: 'Edit Roles > Permissions' })).toMatchObject({ allowed: false, tier: 'sensitive' });
    expect(g.check({ kind: 'check', text: 'Create Records', name: 'Create Records' }).allowed, 'check: Create Records').toBe(true);
    expect(g.check({ kind: 'check', text: 'Update Contacts', name: 'Update Contacts' }).allowed, 'check: Update Contacts').toBe(true);
    expect(g.check({ kind: 'check', text: 'Send Emails', name: 'Send Emails' }).allowed, 'check: Send Emails').toBe(true);
    expect(g.check({ kind: 'check', text: 'Export Data', name: 'Export Data' }).allowed, 'check: Export Data').toBe(true);

    // Sliders (kind=press): same reasoning — the label describes the permission, not an action.
    expect(g.check({ kind: 'press', text: 'Interactive Data', name: 'Interactive Data' }).allowed, 'press: Interactive Data').toBe(true);
    expect(g.check({ kind: 'press', text: 'Interactive Forms', name: 'Interactive Forms' }).allowed, 'press: Interactive Forms').toBe(true);
    expect(g.check({ kind: 'press', text: 'Deal Registration User', name: 'Deal Registration User' }).allowed, 'press: Deal Registration User').toBe(true);
    expect(g.check({ kind: 'press', text: 'MDF User access', name: 'MDF User access' }).allowed, 'press: MDF User access').toBe(true);
    expect(g.check({ kind: 'press', text: 'Lead Scoring', name: 'Lead Scoring' }).allowed, 'press: Lead Scoring').toBe(true);

    // Selects (kind=select): configuration data — label of the dropdown, not a command.
    expect(g.check({ kind: 'select', text: 'Publish Scope', name: 'Publish Scope', fieldName: 'Publish Scope' }).allowed, 'select: Publish Scope').toBe(true);
    expect(g.check({ kind: 'select', text: 'Delete Confirmation', name: 'Delete Confirmation', fieldName: 'Delete Confirmation' }).allowed, 'select: Delete Confirmation').toBe(true);

    // Fill (kind=fill): configuration data — text field label, not a command.
    expect(g.check({ kind: 'fill', text: 'Delete reason', name: 'Delete reason', fieldName: 'Delete reason' }).allowed, 'fill: Delete reason').toBe(true);

    // Actual buttons and links: the same words ARE action commands here and must be blocked.
    expect(g.check({ kind: 'click', text: 'Publish' }).allowed, 'click: Publish').toBe(false);
    expect(g.check({ kind: 'click', text: 'Delete' }).allowed, 'click: Delete').toBe(false);
    expect(g.check({ kind: 'click', text: 'Remove' }).allowed, 'click: Remove').toBe(false);
    expect(g.check({ kind: 'click', text: 'Send Publish Copy' }).allowed, 'click: Send Publish Copy').toBe(false);
    expect(g.check({ kind: 'click', text: 'Delete Permission' }).allowed, 'click: Delete Permission').toBe(false);

    // Payment fields still blocked regardless of kind
    expect(g.check({ kind: 'fill', fieldName: 'card-number', text: '' }).allowed, 'fill: card-number').toBe(false);
    expect(g.check({ kind: 'select', fieldName: 'cvv', text: '' }).allowed, 'select: cvv').toBe(false);

    // NEVER patterns (access-removal) are caught by the NEVER regex in reversible.ts, not guard; but submit/navigate still block
    expect(g.check({ kind: 'submit', text: 'Log out' }).allowed, 'submit: Log out').toBe(false);
  });
});
