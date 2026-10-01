import { z } from 'zod';
import { ViewportSchema } from './types.js';

export const TestModeSchema = z.enum(['deterministic', 'ai_assisted', 'exploratory']);
export type TestMode = z.infer<typeof TestModeSchema>;

/**
 * Input contract shared by API, CLI and dashboard. `.strict()`: any unknown field, in particular a raw `jwt`,
 * is rejected, so a credential can never be smuggled through the UI/API. Credentials are chosen by profile name only.
 */
export const RunRequestSchema = z.object({
  url: z.string().url().refine((u) => /^https?:$/.test(new URL(u).protocol), 'Only http(s) URLs are allowed'),
  authProfile: z.string().min(1).optional(),
  mode: TestModeSchema.default('deterministic'),
  viewports: z.array(ViewportSchema).min(1).optional(),
  /** Per-run overrides of qa.config.json (limits only; the merged config is validated again by ConfigSchema). */
  overrides: z.object({
    maxPages: z.number().int().positive().max(200).optional(),
    maxActions: z.number().int().positive().max(2000).optional(),
    maxDepth: z.number().int().nonnegative().max(10).optional(),
  }).strict().optional(),
}).strict();
export type RunRequest = z.infer<typeof RunRequestSchema>;
