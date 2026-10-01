import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { QADatabase } from '../src/database/db.js';
import { computeVerdict, reviewStateOf } from '../src/database/review.js';
import { Redactor } from '../src/shared/redactor.js';
import type { Finding } from '../src/shared/types.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.c2VjcmV0LXNpZ25hdHVyZQ';

function finding(o: Partial<Finding> = {}): Finding {
  return { ruleId: 'geometry.overlap', category: 'layout', severity: 'major', classification: 'defect', basis: 'generic_rule', page: 'http://app.test/a', viewport: 'desktop', element: { selector: '#x' }, expected: 'e', actual: 'a', evidence: [], ...o };
}

describe('QADatabase', () => {
  it('creates all required tables', () => {
    const db = QADatabase.open(':memory:', new Redactor());
    const tables = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of ['runs', 'pages', 'actions', 'findings', 'evidence', 'network_events', 'console_events', 'ai_analyses', 'human_decisions', 'baselines']) expect(tables).toContain(t);
  });

  it('never stores raw JWTs, Authorization headers or secret query params', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-db-')), 'qa.sqlite');
    const r = new Redactor(); r.register(JWT);
    const db = QADatabase.open(file, r);
    const run = db.createRun({ url: `http://app.test/?token=${JWT}&q=1`, mode: 'deterministic', request: { url: 'http://app.test', authorization: `Bearer ${JWT}` }, config: {} });
    db.upsertPage(run.id, { url: `http://app.test/p?access_token=abc123456789`, depth: 0, title: `hello ${JWT}` });
    db.addNetworkEvents(run.id, 'http://app.test/', 'desktop', [{ id: 1, url: `http://app.test/api?api_key=sk-abcdefghijklmnop12345`, method: 'GET', resourceType: 'fetch', status: 200, ok: true, durationMs: 5, startedAt: 1, pageUrl: 'http://app.test/', ignored: false }]);
    db.addConsoleEvents(run.id, 'http://app.test/', 'desktop', [{ kind: 'console', level: 'error', text: `token is ${JWT}`, pageUrl: 'x', at: 1 }]);
    db.insertFinding(run.id, finding({ actual: `Authorization: Bearer ${JWT}` }));
    db.addAction(run.id, { source: 'functional', type: 'fill', target: JWT, ok: true });
    db.close();
    for (const f of fs.readdirSync(path.dirname(file))) {
      const content = fs.readFileSync(path.join(path.dirname(file), f)).toString('latin1');
      expect(content).not.toContain(JWT);
      expect(content).not.toContain('abc123456789');
      expect(content).not.toContain('sk-abcdefghijklmnop12345');
    }
  });

  it('rejects a defect without basis (schema AND database constraint)', () => {
    const db = QADatabase.open(':memory:', new Redactor());
    const run = db.createRun({ url: 'http://app.test', mode: 'deterministic', request: {}, config: {} });
    expect(() => db.insertFinding(run.id, finding({ basis: null }))).toThrow();
    expect(() => db.raw.prepare(`INSERT INTO findings (id, run_id, fingerprint, rule_id, category, severity, classification, basis, page, viewport, expected, actual, evidence_json, created_at)
      VALUES ('f1', ?, 'fp', 'r', 'c', 'major', 'defect', NULL, 'p', 'v', 'e', 'a', '[]', 'now')`).run(run.id)).toThrow(/CHECK/);
  });

  it('dedupes identical findings by fingerprint', () => {
    const db = QADatabase.open(':memory:', new Redactor());
    const run = db.createRun({ url: 'http://app.test', mode: 'deterministic', request: {}, config: {} });
    const a = db.insertFinding(run.id, finding());
    const b = db.insertFinding(run.id, finding());
    expect(a.inserted).toBe(true); expect(b.inserted).toBe(false); expect(b.id).toBe(a.id);
    expect(db.insertFinding(run.id, finding({ viewport: 'mobile' })).inserted).toBe(true);
  });

  it('human decisions drive review state; latest decision wins; persisted', () => {
    const db = QADatabase.open(':memory:', new Redactor());
    const run = db.createRun({ url: 'http://app.test', mode: 'deterministic', request: {}, config: {} });
    const { id } = db.insertFinding(run.id, finding({ classification: 'anomaly', basis: null }));
    expect(db.getFindingView(id)!.reviewState).toBe('pending');
    db.addDecision({ findingId: id, decision: 'NEEDS_INVESTIGATION', decidedBy: 'alice' });
    expect(db.getFindingView(id)!.reviewState).toBe('investigating');
    db.addDecision({ findingId: id, decision: 'CONFIRM_BUG', decidedBy: 'alice', note: 'reproduced' });
    const v = db.getFindingView(id)!;
    expect(v.reviewState).toBe('confirmed');
    expect(v.decision?.note).toBe('reproduced');
    expect(db.listDecisions(run.id)).toHaveLength(2);
  });

  it('resumable run state round-trips', () => {
    const db = QADatabase.open(':memory:', new Redactor());
    const run = db.createRun({ url: 'http://app.test', mode: 'deterministic', request: {}, config: {} });
    db.saveState(run.id, { phase: 'TESTING', testedUnits: ['http://app.test/|desktop'], actionsUsed: 7, testedLinks: [], crawlDone: true });
    db.setStatus(run.id, 'TESTING');
    expect(db.listIncompleteRuns().map((r) => r.id)).toContain(run.id);
    expect(db.getRun(run.id)!.state!.actionsUsed).toBe(7);
  });
});

describe('review state & verdict', () => {
  it('derives review state', () => {
    expect(reviewStateOf('defect', null)).toBe('defect');
    expect(reviewStateOf('anomaly', null)).toBe('pending');
    const d = (decision: 'CONFIRM_BUG' | 'NOT_A_BUG' | 'EXPECTED_BEHAVIOR' | 'NEEDS_INVESTIGATION') => ({ id: 1, findingId: 'f', runId: 'r', decision, note: null, decidedBy: 'x', decidedAt: 'now' });
    expect(reviewStateOf('anomaly', d('CONFIRM_BUG'))).toBe('confirmed');
    expect(reviewStateOf('defect', d('NOT_A_BUG'))).toBe('dismissed');
    expect(reviewStateOf('defect', d('EXPECTED_BEHAVIOR'))).toBe('dismissed');
  });
  it('computes the four final verdicts', () => {
    expect(computeVerdict([])).toBe('PASS');
    expect(computeVerdict([{ reviewState: 'defect', severity: 'minor' }])).toBe('PASS_WITH_WARNINGS');
    expect(computeVerdict([{ reviewState: 'pending', severity: 'major' }])).toBe('BLOCKED_PENDING_REVIEW');
    expect(computeVerdict([{ reviewState: 'defect', severity: 'major' }, { reviewState: 'pending', severity: 'minor' }])).toBe('FAILED');
    expect(computeVerdict([{ reviewState: 'confirmed', severity: 'minor' }])).toBe('FAILED');
    expect(computeVerdict([{ reviewState: 'dismissed', severity: 'critical' }])).toBe('PASS');
  });
});
