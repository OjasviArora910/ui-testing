import fs from 'node:fs';
import type { EvidenceStore } from '../evidence/store.js';
import { groupProblems } from '../dynamic/resultClassifier.js';
import type { ReportData, ReportFinding } from './data.js';

export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const VERDICT_COLOR: Record<string, string> = { PASS: '#1a7f37', PASS_WITH_WARNINGS: '#9a6700', FAILED: '#cf222e', BLOCKED_PENDING_REVIEW: '#8250df', INCOMPLETE: '#8250df' };
const SEV_COLOR: Record<string, string> = { critical: '#cf222e', major: '#bc4c00', minor: '#9a6700', info: '#57606a' };
const CLASS_COLOR: Record<string, string> = { BUG: '#cf222e', WARNING: '#9a6700', EXPECTED: '#1a7f37', NEEDS_REVIEW: '#8250df', BLOCKED_BY_SAFETY: '#57606a', ACCESSIBILITY: '#0969da', INCONCLUSIVE: '#8c959f' };
const STATE_LABEL: Record<string, string> = { defect: 'Defect', pending: 'Needs review', confirmed: 'Confirmed bug', dismissed: 'Dismissed', investigating: 'Investigating' };

const MAX_EMBED_BYTES = 350_000;
const MAX_TOTAL_EMBED = 6_000_000;

function path(u: string): string { try { const x = new URL(u); return x.pathname + x.search + x.hash; } catch { return u; } }

function card(f: ReportFinding, embed: (f: ReportFinding) => string, others: ReportFinding[] = []): string {
  const ai = f.ai;
  const where = (x: ReportFinding): string => `${path(x.page)} @ ${x.viewport}${x.element?.name ? ` · "${x.element.name}"` : x.element ? ` · ${x.element.selector}` : ''}`;
  return `<article class="card" id="${esc(f.id)}">
<header><span class="sev" style="background:${CLASS_COLOR[f.resultClass]}">${esc(f.resultClass)}</span> <span class="sev" style="background:${SEV_COLOR[f.severity]}">${esc(f.severity)}</span> <strong>${esc(f.ruleId)}</strong>
<span class="tag">${esc(f.category)}</span> <span class="tag">${esc(f.classification)}${f.basis ? ` · basis: ${esc(f.basis)}` : ' · no basis'}</span>
<span class="tag state-${esc(f.reviewState)}">${esc(STATE_LABEL[f.reviewState])}</span></header>
<p class="meta">${esc(path(f.page))} · ${esc(f.viewport)}${f.element ? ` · <code>${esc(f.element.selector)}</code>${f.element.name ? ` "${esc(f.element.name)}"` : ''}` : ''}</p>
<dl><dt>Expected</dt><dd>${esc(f.expected)}</dd><dt>Actual</dt><dd>${esc(f.actual)}</dd>${f.context?.why ? `<dt>Why it is a problem</dt><dd>${esc(f.context.why)}</dd>` : ''}${f.context?.reason ? `<dt>Why tested</dt><dd>${esc(f.context.pageType ?? '')}: ${esc(f.context.reason)}${f.context.confidence ? ` (confidence ${esc(f.context.confidence)})` : ''}</dd>` : ''}</dl>
${embed(f)}
${others.length ? `<details><summary>Same problem, ${others.length} more occurrence(s)</summary><ul>${others.slice(0, 60).map((x) => `<li>${esc(where(x))}</li>`).join('')}</ul></details>` : ''}
${f.evidenceRefs.length ? `<p class="meta">Evidence: ${f.evidenceRefs.map((e) => `<a href="${esc(`../../evidence/${e.path}`)}">${esc(e.kind)}</a>`).join(' · ')}</p>` : ''}
${ai ? `<div class="ai"><strong>AI analysis (advisory)</strong> · priority ${ai.priority} · confidence ${Math.round(ai.confidence * 100)}%${ai.likelyFalsePositive ? ' · <em>likely false positive</em>' : ''}
<p>${esc(ai.explanation)}</p><p><em>Likely cause:</em> ${esc(ai.likelyRootCause)}</p>${ai.falsePositiveReason ? `<p><em>False-positive reasoning:</em> ${esc(ai.falsePositiveReason)}</p>` : ''}</div>` : ''}
${f.decision ? `<p class="meta">Human decision: <strong>${esc(f.decision.decision)}</strong> by ${esc(f.decision.decidedBy)} on ${esc(f.decision.decidedAt)}${f.decision.note ? ` — ${esc(f.decision.note)}` : ''}</p>` : ''}
</article>`;
}

/** Self-contained HTML report. Everything is escaped; screenshots are embedded (size-capped) so the file can be shared alone. */
export function renderHtml(data: ReportData, store?: EvidenceStore): string {
  let embedded = 0;
  const embed = (f: ReportFinding): string => {
    if (!store) return '';
    // a finding produced by an action shows that action: BEFORE -> AFTER / error state
    const own = [f.evidenceRefs.find((e) => e.kind === 'screenshot' && e.label.startsWith('Before:')), f.evidenceRefs.find((e) => e.kind === 'screenshot' && e.label.startsWith('After'))].filter((e): e is NonNullable<typeof e> => !!e);
    if (own.length > 0) {
      const imgs = own.map((ref) => {
        if (ref.bytes > MAX_EMBED_BYTES || embedded + ref.bytes > MAX_TOTAL_EMBED) return '';
        try {
          const buf = fs.readFileSync(store.absolutePath(ref)); embedded += ref.bytes;
          const mime = buf[0] === 0x89 ? 'image/png' : 'image/jpeg';
          return `<figure><img class="shot" alt="${esc(ref.label)}" src="data:${mime};base64,${buf.toString('base64')}"><figcaption>${esc(ref.label)}</figcaption></figure>`;
        } catch { return ''; }
      }).join('');
      if (imgs) return `<div class="flow">${imgs}</div>`;
    }
    const ref = f.evidenceRefs.find((e) => e.kind === 'element-crop') ?? f.evidenceRefs.find((e) => e.kind === 'visual-diff') ?? f.evidenceRefs.find((e) => e.kind === 'screenshot');
    if (!ref || ref.mime !== 'image/png' || ref.bytes > MAX_EMBED_BYTES || embedded + ref.bytes > MAX_TOTAL_EMBED) return '';
    try {
      const b64 = fs.readFileSync(store.absolutePath(ref)).toString('base64'); embedded += ref.bytes;
      return `<img class="shot" alt="${esc(ref.kind)} for ${esc(f.ruleId)}" src="data:image/png;base64,${b64}">`;
    } catch { return ''; }
  };
  const uiux = data.findings.filter((f) => f.track !== 'accessibility');
  const a11y = data.findings.filter((f) => f.track === 'accessibility' && f.reviewState !== 'dismissed');
  const groups: [string, ReportFinding[]][] = [
    ['CONFIRMED UI/UX BUGS', uiux.filter((f) => f.resultClass === 'BUG')],
    ['INCONCLUSIVE: observations that are NOT bugs (not confirmed; kept as a record)', uiux.filter((f) => f.resultClass === 'INCONCLUSIVE')],
    ...(data.accessibility.enabled || a11y.length ? [[`Accessibility findings (separate from UI/UX bugs; ${data.accessibility.failRun ? 'required for this run' : 'they do not affect the verdict'}). A control listed here may work correctly and still be unusable with assistive technology`, a11y] as [string, ReportFinding[]]] : []),
    ['Dismissed by a human', data.findings.filter((f) => f.reviewState === 'dismissed')],
  ];
  const resultsByPage = new Map<string, typeof data.testResults>();
  for (const r of data.testResults) resultsByPage.set(r.page, [...(resultsByPage.get(r.page) ?? []), r]);
  const uniq = <T extends { label: string; reason: string }>(list: T[]): T[] => [...new Map(list.map((x) => [`${x.label}|${x.reason}`, x])).values()];
  const dynamic = data.pages.filter((p) => p.decision).map((p) => {
    const d = p.decision!; const results = resultsByPage.get(p.url) ?? [];
    const counts = Object.entries(results.reduce<Record<string, number>>((acc, r) => { acc[r.classification] = (acc[r.classification] ?? 0) + 1; return acc; }, {}));
    return `<article class="card"><header><strong>${esc(path(p.url))}</strong></header>
<p><b>Detected:</b> ${d.types.filter((t) => t.confidence !== 'LOW').map((t) => `<span class="tag" title="${esc(t.signals.join('; '))}">${esc(t.type)} · ${esc(t.confidence)}</span>`).join(' ')}</p>
<p><b>Selected:</b></p><ul class="plan">${uniq(d.selected).map((x) => `<li>&#10003; ${esc(x.label)} <span class="meta">— ${esc(x.reason)}</span></li>`).join('')}</ul>
${d.skipped.length ? `<p><b>Skipped:</b></p><ul class="plan">${uniq(d.skipped).map((x) => `<li>&#9675; ${esc(x.label)} <span class="meta">— ${esc(x.reason)}</span></li>`).join('')}</ul>` : ''}
${results.length ? `<p>${counts.map(([k, v]) => `<span class="sev" style="background:${CLASS_COLOR[k]}">${esc(k)}: ${v}</span>`).join(' ')}</p>
<details><summary>${results.length} test result(s)</summary><div class="wrap"><table><tr><th>Result</th><th>Test</th><th>Target</th><th>Expected</th><th>Actual</th><th>Confidence</th></tr>${results.map((r) => `<tr><td><span class="sev" style="background:${CLASS_COLOR[r.classification]}">${esc(r.classification)}</span></td><td>${esc(r.scenarioLabel)} / ${esc(r.check)}</td><td>${esc(r.target ?? '')}</td><td>${esc(r.expected)}</td><td>${esc(r.actual)}</td><td>${esc(r.confidence)}</td></tr>`).join('')}</table></div></details>` : ''}
</article>`;
  }).join('');
  const s = data.summary;
  const cats = Object.entries(s.byCategory).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="tag">${esc(k)}: ${v}</span>`).join(' ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>QA report ${esc(data.run.id)}</title><style>
body{font:14px/1.5 system-ui,Arial,sans-serif;margin:0;background:#f6f8fa;color:#1f2328}main{max-width:1000px;margin:0 auto;padding:24px 16px}
h1{margin:0 0 4px}h2{margin-top:32px}.verdict{display:inline-block;color:#fff;padding:6px 14px;border-radius:6px;font-weight:700}
.tiles{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}.tile{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:10px 16px;min-width:110px}.tile b{display:block;font-size:22px}
.card{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:12px 16px;margin:12px 0}.sev{color:#fff;border-radius:4px;padding:1px 8px;font-size:12px}
.tag{background:#eaeef2;border-radius:10px;padding:1px 8px;font-size:12px}.meta{color:#57606a;margin:4px 0;word-break:break-word}dl{display:grid;grid-template-columns:90px 1fr;gap:4px 12px}dt{font-weight:600}dd{margin:0;word-break:break-word}
.shot{max-width:100%;border:1px solid #d0d7de;border-radius:4px;margin-top:8px}.ai{background:#f3f0ff;border-radius:6px;padding:8px 12px;margin-top:8px}.note{background:#fff8c5;border:1px solid #d4a72c;border-radius:6px;padding:8px 12px}
.flow{display:flex;gap:12px;flex-wrap:wrap}.flow figure{margin:0;flex:1 1 300px}figcaption{font-size:12px;color:#57606a}.plan{margin:4px 0 8px;padding-left:20px;list-style:none}details{margin-top:8px}
table{border-collapse:collapse;width:100%;background:#fff}td,th{border:1px solid #d0d7de;padding:4px 8px;text-align:left;font-size:13px;word-break:break-all}.wrap{overflow-x:auto}code{font-size:12px}
</style></head><body><main>
<h1>QA report</h1><p class="meta">${esc(data.run.url)} · run ${esc(data.run.id)} · mode ${esc(data.run.mode)} · ${esc(data.run.finishedAt ?? data.generatedAt)}</p>
<p><span class="verdict" style="background:${VERDICT_COLOR[data.run.verdict]}">${esc(data.run.verdict)}</span></p>
${data.incomplete ? `<p class="note"><strong>Incomplete coverage</strong>${data.run.abortReason || data.run.error ? ` (${esc(data.run.abortReason ?? data.run.error)})` : ''}. ${data.summary.coverage?.inconclusive ? `${data.summary.coverage.inconclusive} interaction(s) could not be verified; the run is not reported as a pass.` : 'Results cover only the work completed before the run stopped.'}</p>` : ''}
<div class="tiles"><div class="tile"><b>${s.pages}</b>pages tested</div><div class="tile"><b>${data.testResults.length}</b>interactions tested</div><div class="tile"><b>${data.testResults.filter((r) => r.classification === 'EXPECTED').length}</b>PASS</div><div class="tile"><b>${data.testResults.filter((r) => r.classification === 'INCONCLUSIVE' || r.classification === 'BLOCKED_BY_SAFETY' || r.classification === 'NEEDS_REVIEW').length}</b>INCONCLUSIVE / BLOCKED</div><div class="tile"><b>${s.counts?.bugs ?? 0}</b>CONFIRMED BUGS</div>${data.accessibility.enabled ? `<div class="tile"><b>${a11y.length}</b>accessibility</div>` : ''}<div class="tile"><b>${s.counts?.needsReview ?? 0}</b>observations (not bugs)</div><div class="tile"><b>${s.actions}</b>actions</div><div class="tile"><b>${s.guardBlocked}</b>blocked by safety guard</div></div>
<p>${cats || '<span class="meta">No active findings.</span>'}</p>
<p class="meta">Viewports: ${esc(data.limits.viewports.join(', '))} · limits: ${data.limits.maxPages} pages, ${data.limits.maxActions} actions, depth ${data.limits.maxDepth} · visual: ${s.visual.pass} pass, ${s.visual.fail} fail, ${s.visual.noBaseline} no baseline</p>
${groups.map(([title, list]) => { const problems = groupProblems(list); return `<h2>${esc(title)} (${problems.length}${problems.length !== list.length ? ` problems, ${list.length} occurrences` : ''})</h2>${problems.map((g) => card(g.representative, embed, g.occurrences.slice(1))).join('') || '<p class="meta">None.</p>'}`; }).join('')}
${data.pages.some((p) => p.readiness) ? `<h2>Page readiness</h2><p class="meta">What each page requested while loading and what became of it. A page whose required data did not load is not showing its real content; blocked auxiliary requests (shell or secondary data, other hosts) do not affect it.</p>${data.pages.filter((p) => p.readiness).map((p) => { const r = p.readiness!; return `<article class="card"><header><span class="sev" style="background:${r.state === 'ready' || r.state === 'partial' ? '#1a7f37' : r.state === 'empty' ? '#57606a' : '#bc4c00'}">${esc(r.state === 'partial' ? 'READY (AUXILIARY DATA BLOCKED)' : r.state.toUpperCase().replace(/-/g, ' '))}</span> <strong>${esc(path(p.url))}</strong></header><p>${esc(r.summary)}</p>
<p class="meta">Cookies present (names only): ${esc(r.cookieNames.join(', ') || 'none')} · static files: ${r.staticFiles.loaded}/${r.staticFiles.total} loaded${r.staticFiles.blocked ? `, ${r.staticFiles.blocked} blocked` : ''}${r.staticFiles.failed ? `, ${r.staticFiles.failed} failed` : ''}</p>
<details${r.state === 'data-not-loaded' ? ' open' : ''}><summary>${r.requests.length} document/API request(s)</summary><div class="wrap"><table><tr><th>Result</th><th>Method</th><th>Endpoint</th><th>Status</th><th>Why</th><th>Credentials attached (names)</th><th>Response</th></tr>${r.requests.map((q) => `<tr><td>${esc(q.outcome.toUpperCase())}</td><td>${esc(q.method)}</td><td>${esc(q.endpoint)}</td><td>${esc(q.status ?? '')}</td><td>${esc(q.reason ?? '')}</td><td>${esc([...(q.auth?.cookieNames ?? []).map((n) => `cookie:${n}`), ...(q.auth?.headerNames ?? []).map((n) => `header:${n}`)].join(', ') || 'none')}</td><td>${esc(q.response ? `${q.response.body}${q.response.items !== undefined ? ` (${q.response.items} items)` : ''}` : '')}</td></tr>`).join('')}</table></div></details></article>`; }).join('')}` : ''}
${dynamic ? `<h2>Dynamic test selection</h2><p class="meta">What was detected on each page, which tests were selected for it and which were skipped.</p>${dynamic}` : ''}
<h2>Pages</h2><div class="wrap"><table><tr><th>URL</th><th>HTTP</th><th>Title</th><th>Tested</th></tr>${data.pages.map((p) => `<tr><td>${esc(p.url)}</td><td>${esc(p.statusCode ?? p.error ?? '')}</td><td>${esc(p.title ?? '')}</td><td>${esc(p.testStatus)}</td></tr>`).join('')}</table></div>
<h2>Rules evaluated</h2><p class="meta">${data.rulesRun.map(esc).join(', ') || 'n/a'}</p>
<h2>Limitations</h2><ul>${data.disclaimers.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
</main></body></html>`;
}
