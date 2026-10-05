import { z } from 'zod';
import { JwtLocationSchema, ViewportSchema, type AuthConfig } from './types.js';

export const TestModeSchema = z.enum(['deterministic', 'ai_assisted', 'exploratory']);
export type TestMode = z.infer<typeof TestModeSchema>;

/**
 * One-time credentials supplied together with the URL. They live ONLY in server memory for the duration of the run:
 * never persisted (DB, evidence, reports, logs, traces), never echoed back, and registered with the Redactor on arrival.
 */
export const DirectAuthSchema = z.object({
  token: z.string().trim().min(1).max(16384),
  location: JwtLocationSchema,
  /** Cookie name / storage key / header name. Defaults: token | token | Authorization. */
  key: z.string().trim().min(1).max(200).optional(),
  /** Header scheme prefix (header location only). Default "Bearer". */
  scheme: z.string().trim().max(40).optional(),
}).strict();
export type DirectAuth = z.infer<typeof DirectAuthSchema>;

/**
 * Input contract shared by API, CLI and dashboard. `.strict()`: unknown fields (e.g. a top-level `jwt`) are rejected;
 * credentials are accepted only inside `auth`, or by referencing a server-side `authProfile`.
 */
export const RunRequestSchema = z.object({
  url: z.string().url().refine((u) => /^https?:$/.test(new URL(u).protocol), 'Only http(s) URLs are allowed'),
  auth: DirectAuthSchema.optional(),
  authProfile: z.string().min(1).optional(),
  mode: TestModeSchema.default('deterministic'),
  viewports: z.array(ViewportSchema).min(1).optional(),
  /** Per-run overrides of qa.config.json (limits only; the merged config is validated again by ConfigSchema). */
  overrides: z.object({
    maxPages: z.number().int().positive().max(2000).optional(),
    maxActions: z.number().int().positive().max(100000).optional(),
    maxDepth: z.number().int().nonnegative().max(50).optional(),
    accessibility: z.object({ enabled: z.boolean().optional(), failRun: z.boolean().optional() }).strict().optional(),
    dynamic: z.object({ enabled: z.boolean().optional() }).strict().optional(),
  }).strict().optional(),
}).strict().refine((r) => !(r.auth && r.authProfile), { message: 'Use either a token (auth) or an authProfile, not both', path: ['auth'] });
export type RunRequest = z.infer<typeof RunRequestSchema>;

export type AuthSource = 'none' | 'token' | 'profile';

/** What is persisted for a run: the request WITHOUT any credential, plus where auth came from. */
export interface PersistedRunRequest extends Omit<RunRequest, 'auth'> {
  authSource: AuthSource;
  /** Where the token was injected (cookie/localStorage/...). Never the token itself. */
  authLocation?: DirectAuth['location'];
}

export function toPersisted(req: RunRequest): PersistedRunRequest {
  const { auth, ...rest } = req;
  return { ...rest, authSource: auth ? 'token' : req.authProfile ? 'profile' : 'none', ...(auth ? { authLocation: auth.location } : {}) };
}

export function directAuthToConfig(a: DirectAuth): AuthConfig {
  return { jwt: a.token, location: a.location, key: a.key, scheme: a.scheme ?? 'Bearer' };
}
