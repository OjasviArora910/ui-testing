import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { QADatabase } from '../src/database/db.js';
import { generateReports } from '../src/reporting/index.js';
import { Redactor } from '../src/shared/redactor.js';
import type { Finding } from '../src/shared/types.js';

const f = (o: Partial<Finding>): Finding => ({ ruleId: 'r', category: 'layout', severity: 'major', classification: 'defect', basis: 'deterministic', page: 'http://app.test/', viewport: 'desktop', element: null, expected: 'e', actual: 'a', evidence: ['ev_1'], ...o });

describe('reports', () => {
  it('labels substantial inconclusive interaction coverage as INCOMPLETE, never PASS', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-incomplete-'));
    const db = QADatabase.open(':memory:', new Redactor());
    const run = db.createRun({ url: 'http://app.test/', mode: 'deterministic', request: {}, config: { viewports: [{ name: 'desktop' }], maxPages: 5, maxActions: 10, maxDepth: 1 } });
    db.setStatus(run.id, 'COMPLETED');
    db.addTestResults(run.id, [1, 2, 3].map((n) => ({
      page: 'http://app.test/', viewport: 'desktop', scenario: 'buttons', scenarioLabel: 'Button interaction', pageType: 'UNKNOWN_GENERAL',
      reason: 'generic control', confidence: 'LOW' as const, kind: 'button', check: `control-${n}`, target: `Control ${n}`,
      expected: 'visible response', actual: 'could not verify', classification: 'INCONCLUSIVE' as const,
    })));
    const out = generateReports(db, undefined, run.id, dir);
    expect(out.data.run.verdict).toBe('INCOMPLETE');
    expect(out.data.incomplete).toBe(true);
    expect(fs.readFileSync(out.html, 'utf8')).toMatch(/3 interaction\(s\) could not be verified/);
  });

  it('writes HTML, JSON and JUnit with the verdict; escapes page content', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-rep-'));
    const db = QADatabase.open(':memory:', new Redactor());
    const run = db.createRun({ url: 'http://app.test/', mode: 'deterministic', request: {}, config: { viewports: [{ name: 'desktop' }], maxPages: 5, maxActions: 10, maxDepth: 1 } });
    db.setStatus(run.id, 'COMPLETED');
    db.saveRulesRun(run.id, ['r', 'geometry.overlap', 'a11y.axe']);
    db.insertFinding(run.id, f({ ruleId: 'r', actual: '<script>alert(1)</script> & "quotes"' }));
    const anomaly = db.insertFinding(run.id, f({ ruleId: 'geometry.overlap', classification: 'anomaly', basis: null, severity: 'minor' }));
    const out = generateReports(db, undefined, run.id, dir);

    const html = fs.readFileSync(out.html, 'utf8');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('FAILED');
    expect(html).toMatch(/not a WCAG conformance certification/);

    const json = JSON.parse(fs.readFileSync(out.json, 'utf8'));
    expect(json.run.verdict).toBe('FAILED');
    expect(json.findings).toHaveLength(2);

    const xml = fs.readFileSync(out.junit, 'utf8');
    expect(xml).toMatch(/^<\?xml/);
    expect(xml).toContain('<failure');
    expect(xml).toContain('<skipped message="Pending human review');
    expect(xml).toContain('name="a11y.axe"'); // rule without findings => passing testcase
    expect(xml).not.toContain('<script>');

    // human dismisses the defect => no confirmed bug is left. The remaining anomaly is an observation, not a bug: it does not block the verdict
    const defectId = db.listFindings(run.id).find((x) => x.classification === 'defect')!.id;
    db.addDecision({ findingId: defectId, decision: 'NOT_A_BUG', decidedBy: 'qa' });
    expect(generateReports(db, undefined, run.id, dir).data.run.verdict).toBe('PASS');
    db.addDecision({ findingId: anomaly.id, decision: 'EXPECTED_BEHAVIOR', decidedBy: 'qa' });
    expect(generateReports(db, undefined, run.id, dir).data.run.verdict).toBe('PASS');
  });
});
