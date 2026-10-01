import type { FindingView } from '../database/types.js';
import { ANALYSIS_SYSTEM_PROMPT, FIX_PROMPT, sanitizeUntrusted } from './prompt.js';
import type { AIProvider } from './provider.js';
import { AIBatchSchema, extractJson, type AIAnalysis } from './schema.js';

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
 * Runs advisory analysis. Output is strictly validated (AIBatchSchema is .strict()); invalid output is rejected,
 * retried once with the validator error, and then dropped. The result type contains no way to alter a finding.
 */
export async function analyzeFindings(o: AnalyzeOptions): Promise<AnalyzeResult> {
  const result: AnalyzeResult = { accepted: [], rejected: [], callsUsed: 0, injectionSuspected: [], skippedForBudget: [] };
  const known = new Set(o.findings.map((f) => f.id));
  const flags = new Set<string>();

  for (let i = 0; i < o.findings.length; i += o.maxFindingsPerCall) {
    const batch = o.findings.slice(i, i + o.maxFindingsPerCall);
    const ids = new Set(batch.map((f) => f.id));
    if (result.callsUsed >= o.maxCalls) { result.skippedForBudget.push(...batch.map((f) => f.id)); continue; }

    const user = buildUserMessage(batch, o.digest, flags);
    const img = o.screenshot ? batch.map((f) => o.screenshot!(f)).filter((x): x is string => !!x).slice(0, 3) : [];
    let history: { role: 'user' | 'assistant'; content: string }[] = [];
    let accepted: AIAnalysis[] | null = null;
    let lastReason = 'no response';

    for (let attempt = 0; attempt < 2 && accepted === null; attempt++) {
      if (result.callsUsed >= o.maxCalls) break;
      result.callsUsed++;
      let text: string;
      try {
        text = (await o.provider.complete({ system: ANALYSIS_SYSTEM_PROMPT, user, history, images: img.length ? img : undefined }, o.signal)).text;
      } catch (e) { lastReason = `provider error: ${e instanceof Error ? e.message : String(e)}`; break; }

      const json = extractJson(text);
      const parsed = AIBatchSchema.safeParse(json);
      if (!parsed.success) {
        lastReason = json === undefined ? 'response was not valid JSON' : parsed.error.issues.slice(0, 4).map((x) => `${x.path.join('.') || '(root)'}: ${x.message}`).join('; ');
        history = [{ role: 'assistant', content: text.slice(0, 2000) }, { role: 'user', content: FIX_PROMPT(lastReason) }];
        continue;
      }
      // Semantic validation: ids must be ones we sent.
      const bad = parsed.data.analyses.filter((a) => !ids.has(a.findingId));
      if (bad.length) {
        lastReason = `unknown findingId(s): ${bad.map((b) => b.findingId).slice(0, 3).join(', ')}`;
        history = [{ role: 'assistant', content: text.slice(0, 2000) }, { role: 'user', content: FIX_PROMPT(lastReason) }];
        continue;
      }
      accepted = parsed.data.analyses.map((a) => ({ ...a, correlatedWith: a.correlatedWith.filter((c) => known.has(c) && c !== a.findingId) }));
    }

    if (accepted) result.accepted.push(...accepted);
    else result.rejected.push({ findingIds: [...ids], reason: lastReason });
  }
  result.injectionSuspected = [...flags];
  return result;
}
