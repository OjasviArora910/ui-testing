import fs from 'node:fs';
import type { EvidenceStore } from '../evidence/store.js';
import type { ReportData, ReportFinding } from './data.js';

export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const VERDICT_COLOR: Record<string, string> = { PASS: '#1a7f37', PASS_WITH_WARNINGS: '#9a6700', FAILED: '#cf222e', BLOCKED_PENDING_REVIEW: '#8250df' };
const SEV_COLOR: Record<string, string> = { critical: '#cf222e', major: '#bc4c00', minor: '#9a6700', info: '#57606a' };
const STATE_LABEL: Record<string, string> = { defect: 'Defect', pending: 'Needs review', confirmed: 'Confirmed bug', dismissed: 'Dismissed', investigating: 'Investigating' };

const MAX_EMBED_BYTES = 350_000;
const MAX_TOTAL_EMBED = 6_000_000;

function path(u: string): string { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } }

function card(f: ReportFinding, embed: (f: ReportFinding) => string): string {
  const ai = f.ai;
  return `<article class="card" id="${esc(f.id)}">
<header><span class="sev" style="background:${SEV_COLOR[f.severity]}">${esc(f.severity)}</span> <strong>${esc(f.ruleId)}</strong>
<span class="tag">${esc(f.category)}</span> <span class="tag">${esc(f.classification)}${f.basis ? ` · basis: ${esc(f.basis)}` : ' · no basis'}</span>
<span class="tag state-${esc(f.reviewState)}">${esc(STATE_LABEL[f.reviewState])}</span></header>
<p class="meta">${esc(path(f.page))} · ${esc(f.viewport)}${f.element ? ` · <code>${esc(f.element.selector)}</code>${f.element.name ? ` "${esc(f.element.name)}"` : ''}` : ''}</p>
<dl><dt>Expected</dt><dd>${esc(f.expected)}</dd><dt>Actual</dt><dd>${esc(f.actual)}</dd></dl>
${embed(f)}
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
    const ref = f.evidenceRefs.find((e) => e.kind === 'element-crop') ?? f.evidenceRefs.find((e) => e.kind === 'visual-diff') ?? f.evidenceRefs.find((e) => e.kind === 'screenshot');
    if (!ref || ref.mime !== 'image/png' || ref.bytes > MAX_EMBED_BYTES || embedded + ref.bytes > MAX_TOTAL_EMBED) return '';
    try {
      const b64 = fs.readFileSync(store.absolutePath(ref)).toString('base64'); embedded += ref.bytes;
      return `<img class="shot" alt="${esc(ref.kind)} for ${esc(f.ruleId)}" src="data:image/png;base64,${b64}">`;
    } catch { return ''; }
  };
  const groups: [string, ReportFinding[]][] = [
    ['Defects (confirmed by a rule or a human)', data.findings.filter((f) => f.reviewState === 'defect' || f.reviewState === 'confirmed')],
    ['Needs human review (anomalies)', data.findings.filter((f) => f.reviewState === 'pending' || f.reviewState === 'investigating')],
    ['Dismissed by a human', data.findings.filter((f) => f.reviewState === 'dismissed')],
  ];
  const order = { critical: 0, major: 1, minor: 2, info: 3 } as const;
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
table{border-collapse:collapse;width:100%;background:#fff}td,th{border:1px solid #d0d7de;padding:4px 8px;text-align:left;font-size:13px;word-break:break-all}.wrap{overflow-x:auto}code{font-size:12px}
</style></head><body><main>
<h1>QA report</h1><p class="meta">${esc(data.run.url)} · run ${esc(data.run.id)} · mode ${esc(data.run.mode)} · ${esc(data.run.finishedAt ?? data.generatedAt)}</p>
<p><span class="verdict" style="background:${VERDICT_COLOR[data.run.verdict]}">${esc(data.run.verdict)}</span></p>
${data.incomplete ? `<p class="note"><strong>Incomplete run</strong> (${esc(data.run.abortReason ?? data.run.error ?? data.run.status)}). Results cover only what was tested before the run stopped.</p>` : ''}
<div class="tiles"><div class="tile"><b>${s.pages}</b>pages tested</div><div class="tile"><b>${s.defects}</b>defects</div><div class="tile"><b>${s.anomalies}</b>to review</div><div class="tile"><b>${s.actions}</b>actions</div><div class="tile"><b>${s.guardBlocked}</b>blocked by safety guard</div></div>
<p>${cats || '<span class="meta">No active findings.</span>'}</p>
<p class="meta">Viewports: ${esc(data.limits.viewports.join(', '))} · limits: ${data.limits.maxPages} pages, ${data.limits.maxActions} actions, depth ${data.limits.maxDepth} · visual: ${s.visual.pass} pass, ${s.visual.fail} fail, ${s.visual.noBaseline} no baseline</p>
${groups.map(([title, list]) => `<h2>${esc(title)} (${list.length})</h2>${list.sort((a, b) => order[a.severity] - order[b.severity]).map((f) => card(f, embed)).join('') || '<p class="meta">None.</p>'}`).join('')}
<h2>Pages</h2><div class="wrap"><table><tr><th>URL</th><th>HTTP</th><th>Title</th><th>Tested</th></tr>${data.pages.map((p) => `<tr><td>${esc(p.url)}</td><td>${esc(p.statusCode ?? p.error ?? '')}</td><td>${esc(p.title ?? '')}</td><td>${esc(p.testStatus)}</td></tr>`).join('')}</table></div>
<h2>Rules evaluated</h2><p class="meta">${data.rulesRun.map(esc).join(', ') || 'n/a'}</p>
<h2>Limitations</h2><ul>${data.disclaimers.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
</main></body></html>`;
}
