import { makeFinding } from '../rules/helpers.js';
import type { Rule } from '../rules/types.js';

/** Only a real baseline comparison can fail. NO_BASELINE_AVAILABLE and SKIPPED never produce a finding. */
export const visualRegressionRule: Rule = {
  id: 'visual.regression', name: 'Visual regression', category: 'visual', severity: 'major', basis: 'baseline',
  description: 'Screenshot differs from the approved baseline by more than visualThresholds.maxDiffRatio.',
  async evaluate(ctx) {
    const v = ctx.visual;
    if (!v || v.status !== 'FAIL') return [];
    const actual = v.dimensionsChanged
      ? `Screenshot dimensions changed versus the baseline (${v.reason ?? 'size mismatch'})`
      : `${((v.diffRatio ?? 0) * 100).toFixed(2)}% of pixels differ (${v.diffPixels} px), threshold ${(v.maxDiffRatio * 100).toFixed(2)}%`;
    return [makeFinding(visualRegressionRule, ctx, {
      classification: 'defect', basis: 'baseline', element: null,
      expected: `Page matches the approved baseline within ${(v.maxDiffRatio * 100).toFixed(2)}%`, actual,
    })];
  },
};

export const visualRules: Rule[] = [visualRegressionRule];
