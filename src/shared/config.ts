import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ViewportSchema, SeveritySchema } from './types.js';

/** Declarative, application-specific rule. Evaluated by the built-in `configured` rule plugin; basis is always `configured_rule`. */
export const CustomRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  severity: SeveritySchema.default('major'),
  category: z.string().default('custom'),
  /** Glob-ish page filter on the URL path; `*` wildcard. Default: all pages. */
  pages: z.array(z.string()).default(['*']),
  /** selector-exists: selector must match >=1 element. selector-absent: must match none. text-present/absent: page text. min-count/max-count: number of selector matches. */
  type: z.enum(['selector-exists', 'selector-absent', 'text-present', 'text-absent', 'min-count', 'max-count']),
  selector: z.string().optional(),
  text: z.string().optional(),
  count: z.number().int().nonnegative().optional(),
});
export type CustomRule = z.infer<typeof CustomRuleSchema>;

export const ConfigSchema = z.object({
  maxPages: z.number().int().positive().default(20),
  maxActions: z.number().int().positive().default(100),
  maxDepth: z.number().int().nonnegative().default(3),
  timeouts: z.object({
    navigationMs: z.number().int().positive().default(30000),
    actionMs: z.number().int().positive().default(8000),
    runMs: z.number().int().positive().default(900000),
  }).default({ navigationMs: 30000, actionMs: 8000, runMs: 900000 }),
  viewports: z.array(ViewportSchema).min(1).default([
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'mobile', width: 390, height: 844 },
  ]),
  rules: z.object({
    disabled: z.array(z.string()).default([]),
    severityOverrides: z.record(z.string(), SeveritySchema).default({}),
    custom: z.array(CustomRuleSchema).default([]),
    /** Paths to JS/TS modules (relative to cwd) that default-export Rule | Rule[]. Lets teams add rules without touching core. */
    plugins: z.array(z.string()).default([]),
  }).default({ disabled: [], severityOverrides: {}, custom: [], plugins: [] }),
  ignoredEndpoints: z.array(z.string()).default([]),
  dangerousActions: z.object({
    keywords: z.array(z.string()).default(['delete', 'remove account', 'purchase', 'buy now', 'pay', 'checkout', 'confirm payment', 'deactivate', 'close account', 'unsubscribe all', 'destroy', 'wipe', 'reset all']),
    allowMethods: z.array(z.string()).default(['GET', 'HEAD', 'OPTIONS']),
  }).default({ keywords: ['delete', 'remove account', 'purchase', 'buy now', 'pay', 'checkout', 'confirm payment', 'deactivate', 'close account', 'unsubscribe all', 'destroy', 'wipe', 'reset all'], allowMethods: ['GET', 'HEAD', 'OPTIONS'] }),
  visualThresholds: z.object({
    maxDiffRatio: z.number().min(0).max(1).default(0.01),
    pixelThreshold: z.number().min(0).max(1).default(0.1),
    maskSelectors: z.array(z.string()).default([]),
  }).default({ maxDiffRatio: 0.01, pixelThreshold: 0.1, maskSelectors: [] }),
  functional: z.object({
    /** When false (default) form submissions are verified client-side and the network write is blocked. */
    submitValidForms: z.boolean().default(false),
    maxButtonsPerPage: z.number().int().positive().default(15),
    maxLinksPerPage: z.number().int().positive().default(15),
    maxFormsPerPage: z.number().int().positive().default(5),
    allViewports: z.boolean().default(false),
  }).default({ submitValidForms: false, maxButtonsPerPage: 15, maxLinksPerPage: 15, maxFormsPerPage: 5, allViewports: false }),
  accessibility: z.object({ enabled: z.boolean().default(true), keyboard: z.boolean().default(true), allViewports: z.boolean().default(false) })
    .default({ enabled: true, keyboard: true, allViewports: false }),
  network: z.object({ slowRequestMs: z.number().int().positive().default(3000) }).default({ slowRequestMs: 3000 }),
  geometry: z.object({
    minTargetSize: z.number().positive().default(24),
    overlapMinRatio: z.number().min(0).max(1).default(0.2),
    maxElements: z.number().int().positive().default(1500),
  }).default({ minTargetSize: 24, overlapMinRatio: 0.2, maxElements: 1500 }),
  ai: z.object({
    maxCalls: z.number().int().nonnegative().default(20),
    maxFindingsPerCall: z.number().int().positive().default(8),
    sendScreenshots: z.boolean().default(false),
  }).default({ maxCalls: 20, maxFindingsPerCall: 8, sendScreenshots: false }),
  agent: z.object({
    maxActions: z.number().int().positive().default(25),
    maxPages: z.number().int().positive().default(5),
    maxDepth: z.number().int().nonnegative().default(3),
    maxRuntimeMs: z.number().int().positive().default(180000),
    maxRepeatedActions: z.number().int().positive().default(3),
    maxRepeatedStates: z.number().int().positive().default(3),
    noProgressLimit: z.number().int().positive().default(5),
    maxLlmCalls: z.number().int().positive().default(30),
  }).default({ maxActions: 25, maxPages: 5, maxDepth: 3, maxRuntimeMs: 180000, maxRepeatedActions: 3, maxRepeatedStates: 3, noProgressLimit: 5, maxLlmCalls: 30 }),
  paths: z.object({
    dataDir: z.string().default('data'),
    baselineDir: z.string().default('data/baselines'),
  }).default({ dataDir: 'data', baselineDir: 'data/baselines' }),
  server: z.object({ host: z.string().default('127.0.0.1'), port: z.number().int().positive().default(4000) }).default({ host: '127.0.0.1', port: 4000 }),
});
export type QAConfig = z.infer<typeof ConfigSchema>;

/** Deep-merge plain objects; arrays and scalars from `over` replace `base`. */
export function deepMerge<T>(base: T, over: unknown): T {
  if (over === undefined || over === null) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base) || typeof over !== 'object' || Array.isArray(over)) return over as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) out[k] = deepMerge(out[k], v);
  return out as T;
}

/** Loads and validates qa.config.json; missing file => defaults. Throws a readable error on invalid config. */
export function loadConfig(file = process.env.QA_CONFIG ?? 'qa.config.json', overrides: unknown = {}): QAConfig {
  let raw: unknown = {};
  if (fs.existsSync(file)) {
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`Invalid JSON in ${path.resolve(file)}: ${(e as Error).message}`); }
  }
  const parsed = ConfigSchema.safeParse(deepMerge(raw, overrides));
  if (!parsed.success) throw new Error(`Invalid config ${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}
