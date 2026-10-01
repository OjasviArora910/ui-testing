import { describe, expect, it } from 'vitest';
import { FindingSchema } from '../src/shared/types.js';

const base = {
  ruleId: 'r', category: 'layout', severity: 'major', classification: 'defect', basis: 'deterministic',
  page: '/', viewport: 'desktop', element: null, expected: 'e', actual: 'a', evidence: [],
};
describe('FindingSchema', () => {
  it('accepts a defect with a valid basis', () => expect(FindingSchema.safeParse(base).success).toBe(true));
  it('rejects a defect without basis', () => expect(FindingSchema.safeParse({ ...base, basis: null }).success).toBe(false));
  it('rejects an AI-ish basis and unknown classification', () => {
    expect(FindingSchema.safeParse({ ...base, basis: 'ai' }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...base, classification: 'confirmed' }).success).toBe(false);
  });
  it('allows an anomaly without basis', () => expect(FindingSchema.safeParse({ ...base, classification: 'anomaly', basis: null }).success).toBe(true));
});
