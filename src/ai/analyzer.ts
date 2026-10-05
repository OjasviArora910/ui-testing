import type { FindingView } from '../database/types.js';
import { ANALYSIS_SYSTEM_PROMPT, FIX_PROMPT, sanitizeUntrusted } from './prompt.js';
import type { AIProvider } from './provider.js';
import { AIAnalysisSchema, normalizeAnalysis, parseBatchResponse, type AIAnalysis } from './schema.js';

/** Upper bound of model calls spent on one batch (first call, continuations of cut-off replies, one corrective retry). */
const MAX_CALLS_PER_BATCH = 4;

/** Compact, already-redacted facts that back a finding (built from stored evidence). */
export interface EvidenceDigest {
  network?: string[];
  console?: string[];
  geometry?: string[];
  aria?: string;
  visual?: string;
}

export interface AnalyzeOptions {
  provider: AIProvider;
  findings: FindingView[];
  digest: (f: FindingView) => EvidenceDigest;
  /** Base64 PNG for a finding (only supplied when config.ai.sendScreenshots is true). */
  screenshot?: (f: FindingView) => string | undefined;
  maxCalls: number;
  maxFindingsPerCall: number;
  signal?: AbortSignal;
}

export interface AnalyzeResult {
  accepted: AIAnalysis[];
  rejected: { findingIds: string[]; reason: string }[];
  callsUsed: number;
  injectionSuspected: string[];
  skippedForBudget: string[];
}

/** Build the user message. All page-derived text is sanitised and wrapped as untrusted evidence. */
export function buildUserMessage(batch: FindingView[], digest: AnalyzeOptions['digest'], flags: Set<string>): string {
  const clean = (id: string, s: string | undefined, max = 300): string => {
    const r = sanitizeUntrusted(s ?? '', max);
    if (r.suspicious) flags.add(id);
    return r.text;
  };
  const items = batch.map((f) => {
    const d = digest(f);
    return {
      findingId: f.id, ruleId: f.ruleId, category: f.category, severity: f.severity, classification: f.classification, basis: f.basis,
      page: (() => { try { return new URL(f.page).pathname; } catch { return f.page; } })(), viewport: f.viewport,
      element: f.element ? { selector: clean(f.id, f.element.selector, 200), role: f.element.role, name: clean(f.id, f.element.name, 100) } : null,
      expected: clean(f.id, f.expected), actual: clean(f.id, f.actual, 500),
      evidence: {
        network: d.network?.slice(0, 5).map((x) => clean(f.id, x, 200)), console: d.console?.slice(0, 5).map((x) => clean(f.id, x, 200)),
        geometry: d.geometry?.slice(0, 6).map((x) => clean(f.id, x, 200)), aria: d.aria ? clean(f.id, d.aria, 600) : undefined, visual: d.visual ? clean(f.id, d.visual, 200) : undefined,
      },
    };
  });
  return `Analyse these ${items.length} QA finding(s). Return the JSON object described in the system message.\n<untrusted_evidence>\n${JSON.stringify(items, null, 1)}\n</untrusted_evidence>`;
}

/**
 * Runs advisory analysis. Every analysis is strictly validated (AIAnalysisSchema is .strict()); an invalid one is rejected
 * on its own, the model gets one corrective retry, and a reply cut off by the output limit is continued for the findings it
 * did not reach. The result type contains no way to alter a finding.
 */
export async function analyzeFindings(o: AnalyzeOptions): Promise<AnalyzeResult> {
  const result: AnalyzeResult = { accepted: [], rejected: [], callsUsed: 0, injectionSuspected: [], skippedForBudget: [] };
  const known = new Set(o.findings.map((f) => f.id));
  const flags = new Set<string>();

  for (let i = 0; i < o.findings.length; i += o.maxFindingsPerCall) {
    if (o.signal?.aborted) break; // the run was stopped
    const batch = o.findings.slice(i, i + o.maxFindingsPerCall);
    const ids = new Set(batch.map((f) => f.id));
    if (result.callsUsed >= o.maxCalls) { result.skippedForBudget.push(...batch.map((f) => f.id)); continue; }

    const img = o.screenshot ? batch.map((f) => o.screenshot!(f)).filter((x): x is string => !!x).slice(0, 3) : [];
    const pending = new Map(batch.map((f) => [f.id, f]));
    let history: { role: 'user' | 'assistant'; content: string }[] = [];
    let lastReason = 'no response';
    let corrections = 0;

    // Each call must either answer findings or be the single corrective retry; a cut-off reply is continued with the rest.
    for (let call = 0; pending.size > 0 && call < MAX_CALLS_PER_BATCH; call++) {
      if (result.callsUsed >= o.maxCalls) break;
      result.callsUsed++;
      const user = buildUserMessage([...pending.values()], o.digest, flags);
      let text: string;
      try {
        text = (await o.provider.complete({ system: ANALYSIS_SYSTEM_PROMPT, user, history, images: img.length ? img : undefined }, o.signal)).text;
      } catch (e) { lastReason = `provider error: ${e instanceof Error ? e.message : String(e)}`; break; }

      const reply = parseBatchResponse(text);
      const problems: string[] = [];
      let answered = 0;
      for (const raw of reply.items) {
        // Validated one by one, so a single malformed analysis no longer discards the valid ones beside it.
        const parsed = AIAnalysisSchema.safeParse(normalizeAnalysis(raw));
        if (!parsed.success) { problems.push(parsed.error.issues.slice(0, 2).map((x) => `${x.path.join('.') || '(root)'}: ${x.message}`).join('; ')); continue; }
        const a = parsed.data;
        if (!pending.has(a.findingId)) { if (!ids.has(a.findingId)) problems.push(`unknown findingId(s): ${a.findingId}`); continue; }
        result.accepted.push({ ...a, correlatedWith: a.correlatedWith.filter((c) => known.has(c) && c !== a.findingId) });
        pending.delete(a.findingId); answered++;
      }
      if (pending.size === 0) break;

      if (reply.truncated && answered > 0) {
        // Output limit reached after some complete analyses: ask again for the unanswered findings only.
        lastReason = 'response was cut off (output limit reached) before these findings were analysed';
        history = [];
        continue;
      }
      lastReason = problems.length ? problems.slice(0, 4).join('; ')
        : reply.truncated ? 'response was cut off (output limit reached) before any analysis was complete'
        : !reply.parsed ? 'response was not valid JSON'
        : 'response did not include an analysis for these findings';
      if (corrections++ >= 1) break; // one corrective retry, as before
      history = [{ role: 'assistant', content: text.slice(0, 2000) }, { role: 'user', content: FIX_PROMPT(lastReason) }];
    }

    if (pending.size > 0) result.rejected.push({ findingIds: [...pending.keys()], reason: lastReason });
  }
  result.injectionSuspected = [...flags];
  return result;
}
