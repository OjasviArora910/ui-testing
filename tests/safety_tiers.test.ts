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
});
