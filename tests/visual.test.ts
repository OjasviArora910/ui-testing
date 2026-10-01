import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDemoApp, type DemoServer } from '../demo-app/server.js';
import { collectRuleContext } from '../src/rules/context.js';
import { buildRegistry } from '../src/rules/index.js';
import { loadConfig } from '../src/shared/config.js';
import { BaselineStore, compareImages, VisualTester } from '../src/visual/index.js';
import { launchForTest } from './helpers/launch.js';
import type { BrowserController } from '../src/browser/index.js';

function png(w: number, h: number, fill: [number, number, number], patch?: { x: number; y: number; w: number; h: number }): Buffer {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4; const inPatch = patch && x >= patch.x && x < patch.x + patch.w && y >= patch.y && y < patch.y + patch.h;
    const c = inPatch ? [255 - fill[0], 255 - fill[1], 255 - fill[2]] : fill;
    p.data[i] = c[0]!; p.data[i + 1] = c[1]!; p.data[i + 2] = c[2]!; p.data[i + 3] = 255;
  }
  return PNG.sync.write(p);
}

describe('compareImages', () => {
  const opts = { pixelThreshold: 0.1, maxDiffRatio: 0.01 };
  it('identical images pass with zero diff', () => {
    const a = png(50, 50, [200, 200, 200]);
    const r = compareImages(a, a, opts);
    expect(r.result.status).toBe('PASS'); expect(r.result.diffPixels).toBe(0); expect(r.diffPng).toBeUndefined();
  });
  it('a small difference under maxDiffRatio passes, over it fails', () => {
    const a = png(100, 100, [200, 200, 200]);
    expect(compareImages(a, png(100, 100, [200, 200, 200], { x: 0, y: 0, w: 5, h: 5 }), opts).result.status).toBe('PASS'); // 0.25%
    const big = compareImages(a, png(100, 100, [200, 200, 200], { x: 0, y: 0, w: 30, h: 30 }), opts);
    expect(big.result.status).toBe('FAIL'); expect(big.result.diffRatio).toBeCloseTo(0.09, 2); expect(big.diffPng).toBeInstanceOf(Buffer);
  });
  it('different dimensions fail', () => {
    const r = compareImages(png(10, 10, [0, 0, 0]), png(10, 12, [0, 0, 0]), opts);
    expect(r.result.status).toBe('FAIL'); expect(r.result.dimensionsChanged).toBe(true);
  });
});

describe('visual testing against the demo app', () => {
  let demo: DemoServer; let c: BrowserController; let dir: string;
  beforeAll(async () => { demo = await startDemoApp(); c = await launchForTest({ baseUrl: demo.url }); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-visual-')); });
  afterAll(async () => { await c?.close(); await demo?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const cfg = (o: object = {}) => loadConfig('x.json', { visualThresholds: o });

  it('NO_BASELINE_AVAILABLE is reported, and is NOT a failure/finding', async () => {
    const t = new VisualTester(new BaselineStore(path.join(dir, 'none')), cfg().visualThresholds);
    await c.navigate(`${demo.url}/legit`); await c.settle(100);
    const out = await t.check(c);
    expect(out.result.status).toBe('NO_BASELINE_AVAILABLE');
    expect(out.currentPng.length).toBeGreaterThan(1000);
    const config = cfg();
    const ctx = await collectRuleContext(c, { config, visual: out.result });
    const res = await (await buildRegistry(config)).run(ctx);
    expect(res.findings.filter((f) => f.category === 'visual')).toEqual([]);
  });

  it('a saved baseline passes on re-check; masking hides dynamic regions', async () => {
    const store = new BaselineStore(path.join(dir, 'b1'));
    const tight = { maxDiffRatio: 0.00001, maskSelectors: ['[data-dynamic]'] };
    const t = new VisualTester(store, cfg(tight).visualThresholds);
    await c.navigate(`${demo.url}/dynamic`); await c.settle(100);
    const first = await t.check(c);
    store.save(c.url, 'desktop', first.currentPng, tight.maskSelectors);
    await c.navigate(`${demo.url}/dynamic`); await c.settle(100); // clock + random changed
    expect((await t.check(c)).result.status).toBe('PASS');
    const unmasked = new VisualTester(store, cfg({ maxDiffRatio: 0.00001 }).visualThresholds);
    expect((await unmasked.check(c)).result.status).toBe('FAIL');
  });

  it('a visual change produces a baseline-basis defect with a diff image', async () => {
    const store = new BaselineStore(path.join(dir, 'b2'));
    const config = cfg({ maxDiffRatio: 0.0001 });
    const t = new VisualTester(store, config.visualThresholds);
    await c.navigate(`${demo.url}/legit`); await c.settle(100);
    store.save(c.url, 'desktop', (await t.check(c)).currentPng);
    await c.page.addStyleTag({ content: 'h1{color:red !important}' });
    const out = await t.check(c, { artifactDir: path.join(dir, 'art'), label: 'legit-desktop' });
    expect(out.result.status).toBe('FAIL');
    expect(out.result.dimensionsChanged, out.result.reason).toBeUndefined();
    expect(fs.existsSync(out.result.diffPath!)).toBe(true);
    const ctx = await collectRuleContext(c, { config, visual: out.result });
    const f = (await (await buildRegistry(config)).run(ctx)).findings.filter((x) => x.category === 'visual');
    expect(f).toHaveLength(1);
    expect(f[0]!.classification).toBe('defect'); expect(f[0]!.basis).toBe('baseline');
  });

  it('baselines are per viewport', async () => {
    const store = new BaselineStore(path.join(dir, 'b3'));
    const t = new VisualTester(store, cfg().visualThresholds);
    await c.navigate(`${demo.url}/legit`); await c.settle(100);
    store.save(c.url, 'desktop', (await t.check(c)).currentPng);
    await c.setViewport({ name: 'mobile', width: 390, height: 844 }); await c.settle(100);
    expect((await t.check(c)).result.status).toBe('NO_BASELINE_AVAILABLE');
    await c.setViewport({ name: 'desktop', width: 1440, height: 900 });
  });
});
