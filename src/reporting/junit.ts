import type { ReportData, ReportFinding } from './data.js';

// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;
export const xml = (s: unknown): string => String(s ?? '').replace(INVALID_XML, '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

function name(f: ReportFinding): string {
  let p = f.page; try { const u = new URL(f.page); p = u.pathname + u.search; } catch { /* keep */ }
  return `${f.ruleId} ${p} [${f.viewport}]${f.element ? ` ${f.element.selector}` : ''}`;
}

function testcase(f: ReportFinding): string {
  const body = `Expected: ${f.expected}\nActual: ${f.actual}\nPage: ${f.page}\nViewport: ${f.viewport}\nSeverity: ${f.severity}\nClassification: ${f.classification}${f.basis ? ` (${f.basis})` : ''}\nReview state: ${f.reviewState}`;
  const head = `<testcase classname="${xml(f.category)}" name="${xml(name(f))}">`;
  switch (f.reviewState) {
    case 'defect': case 'confirmed':
      return `${head}<failure type="${xml(f.severity)}" message="${xml(f.actual.slice(0, 200))}">${xml(body)}</failure></testcase>`;
    case 'pending': case 'investigating':
      return `${head}<skipped message="Pending human review: ${xml(f.actual.slice(0, 160))}"/><system-out>${xml(body)}</system-out></testcase>`;
    default:
      return `${head}<system-out>${xml(`Dismissed by human. ${body}`)}</system-out></testcase>`;
  }
}

/** JUnit XML: one suite per category. Defects/confirmed => failure; anomalies awaiting review => skipped; rules with no findings => passing testcase. */
export function renderJUnit(data: ReportData): string {
  const byCat = new Map<string, ReportFinding[]>();
  for (const f of data.findings) byCat.set(f.category, [...(byCat.get(f.category) ?? []), f]);
  // A rule is reported as passing only if nothing in its namespace (geometry., a11y., network., ...) produced a finding,
  // because some rules emit sub-ids (a11y.axe -> a11y.image-alt).
  const namespacesWithFindings = new Set(data.findings.map((f) => f.ruleId.split('.')[0]));
  const passing = data.rulesRun.filter((r) => !namespacesWithFindings.has(r.split('.')[0]));
  const suites: string[] = [];
  let tests = 0; let failures = 0; let skipped = 0;
  for (const [cat, list] of byCat) {
    const fl = list.filter((f) => f.reviewState === 'defect' || f.reviewState === 'confirmed').length;
    const sk = list.filter((f) => f.reviewState === 'pending' || f.reviewState === 'investigating').length;
    tests += list.length; failures += fl; skipped += sk;
    suites.push(`<testsuite name="${xml(cat)}" tests="${list.length}" failures="${fl}" errors="0" skipped="${sk}">${list.map(testcase).join('')}</testsuite>`);
  }
  if (passing.length) {
    tests += passing.length;
    suites.push(`<testsuite name="rules-without-findings" tests="${passing.length}" failures="0" errors="0" skipped="0">${passing.map((r) => `<testcase classname="rules" name="${xml(r)}"/>`).join('')}</testsuite>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="qa-platform" tests="${tests}" failures="${failures}" errors="0" skipped="${skipped}">`
    + `<properties><property name="verdict" value="${xml(data.run.verdict)}"/><property name="url" value="${xml(data.run.url)}"/><property name="runId" value="${xml(data.run.id)}"/></properties>`
    + `${suites.join('')}</testsuites>\n`;
}
