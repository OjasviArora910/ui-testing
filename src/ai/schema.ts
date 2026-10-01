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

/** Extract the first JSON object from model text (tolerates ``` fences and leading prose). Returns undefined when none parses. */
export function extractJson(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/gi, '').trim();
  const start = stripped.indexOf('{'); const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try { return JSON.parse(stripped.slice(start, end + 1)); } catch { return undefined; }
}
