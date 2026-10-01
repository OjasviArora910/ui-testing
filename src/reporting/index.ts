import fs from 'node:fs';
import path from 'node:path';
import type { QADatabase } from '../database/db.js';
import type { EvidenceStore } from '../evidence/store.js';
import { buildReportData, type ReportData } from './data.js';
import { renderHtml } from './html.js';
import { renderJUnit } from './junit.js';

export * from './data.js';
export { renderHtml } from './html.js';
export { renderJUnit } from './junit.js';

export interface GeneratedReports { dir: string; html: string; json: string; junit: string; data: ReportData }

/** Writes report.html, report.json and report.xml for a run and updates the stored summary/verdict. Safe to call repeatedly (e.g. after each human decision). */
export function generateReports(db: QADatabase, store: EvidenceStore | undefined, runId: string, reportsRoot: string): GeneratedReports {
  const data = buildReportData(db, runId);
  db.saveSummary(runId, data.summary, data.run.verdict);
  const dir = path.join(reportsRoot, runId);
  fs.mkdirSync(dir, { recursive: true });
  const html = path.join(dir, 'report.html'); const json = path.join(dir, 'report.json'); const junit = path.join(dir, 'report.xml');
  fs.writeFileSync(html, renderHtml(data, store));
  fs.writeFileSync(json, JSON.stringify(data, null, 2));
  fs.writeFileSync(junit, renderJUnit(data));
  return { dir, html, json, junit, data };
}
