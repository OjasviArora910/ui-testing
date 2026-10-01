import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { VisualResult } from './types.js';

export interface CompareOptions { pixelThreshold: number; maxDiffRatio: number }
export interface CompareOutput { result: VisualResult; diffPng?: Buffer }

/** Pixel comparison of two PNGs. Different dimensions are a FAIL by definition (layout changed). */
export function compareImages(baseline: Buffer, current: Buffer, opts: CompareOptions): CompareOutput {
  const a = PNG.sync.read(baseline); const b = PNG.sync.read(current);
  const base = { maxDiffRatio: opts.maxDiffRatio, pixelThreshold: opts.pixelThreshold };
  if (a.width !== b.width || a.height !== b.height) {
    return {
      result: { ...base, status: 'FAIL', diffRatio: 1, dimensionsChanged: true, reason: `baseline ${a.width}x${a.height} vs current ${b.width}x${b.height}` },
    };
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const diffPixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: opts.pixelThreshold });
  const total = a.width * a.height;
  const ratio = total === 0 ? 0 : diffPixels / total;
  return {
    result: { ...base, status: ratio > opts.maxDiffRatio ? 'FAIL' : 'PASS', diffRatio: ratio, diffPixels, totalPixels: total },
    diffPng: diffPixels > 0 ? PNG.sync.write(diff) : undefined,
  };
}
