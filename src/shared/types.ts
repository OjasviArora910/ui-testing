import { z } from 'zod';

export const BasisSchema = z.enum(['deterministic', 'generic_rule', 'configured_rule', 'baseline', 'human']);
export type Basis = z.infer<typeof BasisSchema>;

export const SeveritySchema = z.enum(['critical', 'major', 'minor', 'info']);
export type Severity = z.infer<typeof SeveritySchema>;

export const ClassificationSchema = z.enum(['defect', 'anomaly']);

export const BoundingBoxSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
export type BoundingBox = z.infer<typeof BoundingBoxSchema>;

export const ViewportSchema = z.object({
  name: z.string().min(1), width: z.number().int().positive(), height: z.number().int().positive(),
});
export type Viewport = z.infer<typeof ViewportSchema>;

/** Finding contract. A `defect` MUST carry a valid basis; anything weaker is an `anomaly`. */
export const FindingSchema = z.object({
  ruleId: z.string().min(1),
  category: z.string().min(1),
  severity: SeveritySchema,
  classification: ClassificationSchema,
  basis: BasisSchema.nullable(),
  page: z.string().min(1),
  viewport: z.string().min(1),
  element: z.object({
    selector: z.string(), role: z.string().optional(), name: z.string().optional(), box: BoundingBoxSchema.optional(),
  }).nullable(),
  expected: z.string().min(1),
  actual: z.string().min(1),
  evidence: z.array(z.string()),
  /** Why the test that produced this finding ran (dynamic selection). Informational: never part of the defect/anomaly contract. */
  context: z.object({
    resultId: z.string().optional(),
    scenario: z.string().optional(),
    pageType: z.string().optional(),
    reason: z.string().optional(),
    confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
    /** Why this observation means the UI is broken (the rule's criterion, or the tester's reasoning). */
    why: z.string().optional(),
  }).optional(),
}).superRefine((f, ctx) => {
  if (f.classification === 'defect' && !f.basis) {
    ctx.addIssue({ code: 'custom', path: ['basis'], message: 'A defect requires a ground-truth basis' });
  }
});
export type Finding = z.infer<typeof FindingSchema>;

export const JwtLocationSchema = z.enum(['cookie', 'localStorage', 'sessionStorage', 'header']);
export type JwtLocation = z.infer<typeof JwtLocationSchema>;

export const AuthConfigSchema = z.object({
  jwt: z.string().min(1),
  location: JwtLocationSchema,
  /** cookie name / storage key / header name. Defaults: token | token | Authorization */
  key: z.string().optional(),
  /** Header scheme prefix, e.g. "Bearer". Only used for header location. */
  scheme: z.string().default('Bearer'),
});
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
