import { z } from 'zod';

/**
 * The ONLY shape AI output is allowed to have. `.strict()` means any extra key is a validation error, so an AI
 * response containing `classification`, `basis`, `severity`, `confirmed`, `status`... is rejected outright.
 * There is deliberately no field through which the AI could confirm a defect or change a finding.
 */
export const AIAnalysisSchema = z.object({
  findingId: z.string().min(1).max(64),
  explanation: z.string().min(1).max(1500),
  likelyRootCause: z.string().max(800),
  /** 1 = fix first, 5 = lowest. Advisory ordering only. */
  priority: z.number().int().min(1).max(5),
  confidence: z.number().min(0).max(1),
  likelyFalsePositive: z.boolean(),
  falsePositiveReason: z.string().max(500).optional(),
  /** Ids of OTHER findings that probably share a root cause. */
  correlatedWith: z.array(z.string().max(64)).max(10).default([]),
  suggestedChecks: z.array(z.string().max(300)).max(5).default([]),
}).strict();
export type AIAnalysis = z.infer<typeof AIAnalysisSchema>;

export const AIBatchSchema = z.object({ analyses: z.array(AIAnalysisSchema).max(25) }).strict();
export type AIBatch = z.infer<typeof AIBatchSchema>;

/** Index just past the value that starts at `start` ('{' or '['), or -1 when the text ends before it closes. String-aware. */
function balancedEnd(s: string, start: number): number {
  let depth = 0; let inString = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) { if (ch === '\\') i++; else if (ch === '"') inString = false; continue; }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

/** Drops commas that directly precede a closing bracket, outside strings. */
function dropTrailingCommas(s: string): string {
  let out = ''; let inString = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) { out += ch; if (ch === '\\') { out += s[++i] ?? ''; } else if (ch === '"') inString = false; continue; }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === ',') { const next = /^\s*([}\]])/.exec(s.slice(i + 1)); if (next) continue; }
    out += ch;
  }
  return out;
}

function tryParse(s: string): unknown {
  try { return JSON.parse(s); } catch { /* try the tolerant form */ }
  try { return JSON.parse(dropTrailingCommas(s)); } catch { return undefined; }
}

const unfence = (text: string): string => text.replace(/```[a-z]*/gi, '').trim();

/**
 * Extract the first JSON object from model text. Tolerates ``` fences, prose before and after the object, and trailing
 * commas. Returns undefined when no complete object parses.
 */
export function extractJson(text: string): unknown {
  const s = unfence(text);
  for (let start = s.indexOf('{'); start >= 0; start = s.indexOf('{', start + 1)) {
    const end = balancedEnd(s, start);
    if (end < 0) return undefined; // the object never closes (cut-off reply)
    const v = tryParse(s.slice(start, end));
    if (v !== undefined) return v;
  }
  return undefined;
}

export interface ParsedBatch {
  /** Raw analysis objects found in the reply, not yet validated. */
  items: unknown[];
  /** The reply stopped before the JSON was complete (output limit reached): later analyses are missing. */
  truncated: boolean;
  /** False when nothing JSON-like could be read at all. */
  parsed: boolean;
}

/**
 * Reads the analyses out of a model reply, however it is wrapped: the required {"analyses":[...]} object, a bare array,
 * a single analysis object, code fences, surrounding prose, trailing commas. When the reply was cut off mid-way, every
 * analysis that is complete is still returned and `truncated` is set, so finished work is not thrown away.
 */
export function parseBatchResponse(text: string): ParsedBatch {
  const s = unfence(text);
  const firstBrace = s.indexOf('{'); const firstBracket = s.indexOf('[');
  const bareArray = firstBracket >= 0 && (firstBrace < 0 || firstBracket < firstBrace);
  const whole = bareArray ? undefined : extractJson(text);
  if (whole !== undefined && whole !== null && typeof whole === 'object') {
    const w = whole as Record<string, unknown>;
    if (Array.isArray(w.analyses)) return { items: w.analyses, truncated: false, parsed: true };
    if (typeof w.findingId === 'string') return { items: [w], truncated: false, parsed: true };
  }
  // Bare array, or a cut-off reply: walk the array and keep every element that is complete.
  const key = s.indexOf('"analyses"');
  const open = s.indexOf('[', key >= 0 ? key : 0);
  if (open < 0) return { items: [], truncated: firstBrace >= 0 && whole === undefined && balancedEnd(s, firstBrace) < 0, parsed: whole !== undefined };
  const items: unknown[] = [];
  let i = open + 1; let truncated = true;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === ']') { truncated = false; break; }
    if (ch !== '{') { i++; continue; }
    const end = balancedEnd(s, i);
    if (end < 0) break; // this element was cut off
    const v = tryParse(s.slice(i, end));
    if (v !== undefined) items.push(v);
    i = end;
  }
  return { items, truncated, parsed: items.length > 0 || !truncated };
}

/**
 * Tidies harmless formatting differences in one analysis before strict validation. It never removes or renames keys, so
 * an attempt to add `classification`, `severity`, `confirmed`... still fails AIAnalysisSchema.
 */
export function normalizeAnalysis(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const a: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  const num = (v: unknown): unknown => (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : v);
  const cut = (v: unknown, max: number): unknown => (typeof v === 'string' && v.length > max ? `${v.slice(0, max - 1)}…` : v);
  a.priority = num(a.priority);
  if (typeof a.priority === 'number') a.priority = Math.min(5, Math.max(1, Math.round(a.priority)));
  a.confidence = num(a.confidence);
  if (typeof a.confidence === 'number' && a.confidence > 1 && a.confidence <= 100) a.confidence = a.confidence / 100; // 85 -> 0.85
  if (typeof a.likelyFalsePositive === 'string' && /^(true|false)$/i.test(a.likelyFalsePositive)) a.likelyFalsePositive = /^true$/i.test(a.likelyFalsePositive);
  // models often leave the flag out when the answer is "no"
  if (a.likelyFalsePositive === undefined || a.likelyFalsePositive === null) a.likelyFalsePositive = false;
  a.explanation = cut(a.explanation, 1500);
  a.likelyRootCause = cut(a.likelyRootCause ?? '', 800);
  if (a.falsePositiveReason === null || a.falsePositiveReason === '') delete a.falsePositiveReason; else a.falsePositiveReason = cut(a.falsePositiveReason, 500);
  for (const [k, max, len] of [['correlatedWith', 10, 64], ['suggestedChecks', 5, 300]] as const) {
    if (a[k] === null) delete a[k];
    else if (Array.isArray(a[k])) a[k] = (a[k] as unknown[]).filter((x) => typeof x === 'string').slice(0, max).map((x) => (k === 'suggestedChecks' ? cut(x, len) : x));
  }
  return a;
}
