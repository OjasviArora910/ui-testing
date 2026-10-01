import fs from 'node:fs';
import path from 'node:path';
import type { BrowserController } from '../browser/index.js';
import type { QAConfig } from '../shared/config.js';
import { compareImages } from './compare.js';
import type { BaselineStore } from './store.js';
import type { VisualResult } from './types.js';

export interface VisualCheckOutput {
  result: VisualResult;
  /** Current screenshot (always captured so a human can approve it as the new baseline). */
  currentPng: Buffer;
  diffPng?: Buffer;
  baselinePng?: Buffer;
}

/**
 * Compares the current page with its approved baseline. With NO baseline the outcome is NO_BASELINE_AVAILABLE,
 * which is explicitly NOT a regression failure: "no baseline" never means "visually broken".
 */
export class VisualTester {
  constructor(private readonly store: BaselineStore, private readonly thresholds: QAConfig['visualThresholds']) {}

  async check(controller: BrowserController, opts: { artifactDir?: string; label?: string } = {}): Promise<VisualCheckOutput> {
    const viewport = controller.currentViewport.name;
    const pageUrl = controller.url;
    const base = { maxDiffRatio: this.thresholds.maxDiffRatio, pixelThreshold: this.thresholds.pixelThreshold };
    let currentPng: Buffer;
    try {
      // The first full-page capture after load can be a couple of px taller than later ones (late layout/fonts); warm up, then capture.
      await controller.page.evaluate('document.fonts ? document.fonts.ready.then(() => true) : true');
      await controller.screenshot({ fullPage: true });
      currentPng = await controller.screenshot({ fullPage: true, mask: this.thresholds.maskSelectors });
    } catch (e) {
      return { result: { ...base, status: 'SKIPPED', reason: `screenshot failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` }, currentPng: Buffer.alloc(0) };
    }
    const baselinePng = this.store.get(pageUrl, viewport);
    if (!baselinePng) return { result: { ...base, status: 'NO_BASELINE_AVAILABLE', reason: 'No approved baseline exists for this page/viewport' }, currentPng };

    const { result, diffPng } = compareImages(baselinePng, currentPng, base);
    result.baselinePath = this.store.filePath(pageUrl, viewport);
    if (opts.artifactDir && diffPng) {
      fs.mkdirSync(opts.artifactDir, { recursive: true });
      result.diffPath = path.join(opts.artifactDir, `${opts.label ?? 'diff'}.png`);
      fs.writeFileSync(result.diffPath, diffPng);
    }
    return { result, currentPng, diffPng, baselinePng };
  }
}
