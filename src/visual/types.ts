export type VisualStatus = 'NO_BASELINE_AVAILABLE' | 'PASS' | 'FAIL' | 'SKIPPED';

export interface VisualResult {
  status: VisualStatus;
  /** Fraction of differing pixels (0..1). Only for PASS/FAIL. */
  diffRatio?: number;
  diffPixels?: number;
  totalPixels?: number;
  maxDiffRatio: number;
  pixelThreshold: number;
  dimensionsChanged?: boolean;
  baselinePath?: string;
  currentPath?: string;
  diffPath?: string;
  reason?: string;
}
