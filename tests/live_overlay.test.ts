import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser, Page } from 'playwright';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserController } from '../src/browser/index.js';
import { mapBoxToDisplay, paintedRect } from '../web/src/liveOverlay.js';
import { launchForTest } from './helpers/launch.js';

/**
 * The live view must draw its target box and cursor exactly where the clicked element is ON THE DISPLAYED SCREENSHOT.
 *
 * End to end, with nothing assumed: a real button at an awkward position is measured with Playwright's boundingBox(), a
 * real screenshot of that browser is displayed the way the dashboard displays it (width 100%, clamped height,
 * object-fit: contain, so it is letterboxed), the mapping is applied, and the result is compared with where the button's
 * own pixels actually are in a screenshot of that display. The button is the only thing on the page with its colour.
 */
const MARK = { r: 255, g: 0, b: 170 }; // the button's colour: found again by scanning pixels

/** Bounding box of the marker-coloured pixels in a PNG (device pixels). */
function findMarker(png: Buffer): { left: number; top: number; right: number; bottom: number } | null {
  const img = PNG.sync.read(png);
  let left = Infinity; let top = Infinity; let right = -1; let bottom = -1;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const i = (y * img.width + x) * 4;
    if (Math.abs(img.data[i]! - MARK.r) < 40 && Math.abs(img.data[i + 1]! - MARK.g) < 40 && Math.abs(img.data[i + 2]! - MARK.b) < 40) {
      if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y;
    }
  }
  return right < 0 ? null : { left, top, right: right + 1, bottom: bottom + 1 };
}

describe('live view overlay lands on the element Playwright clicks (browser)', () => {
  let site: http.Server; let url: string; let c: BrowserController; let browser: Browser;

  beforeAll(async () => {
    site = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      // a tall page, so the button can also be tested after scrolling; the button is NOT centred
      res.end(`<!doctype html><html lang="en"><head><title>Form</title><style>html,body{margin:0;background:#fff}body{height:2600px}
#submit{position:absolute;left:937px;top:1411px;width:123px;height:41px;border:0;margin:0;padding:0;background:rgb(${MARK.r},${MARK.g},${MARK.b});color:rgb(${MARK.r},${MARK.g},${MARK.b})}</style></head>
<body><button type="button" id="submit">Submit</button></body></html>`);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    c = await launchForTest({ baseUrl: url, viewport: { name: 'desktop', width: 1440, height: 900 } });
    browser = c.page.context().browser()!;
  }, 60_000);
  afterAll(async () => { await c?.close(); site?.closeAllConnections?.(); await new Promise((r) => site.close(() => r(undefined))); });

  /** Displays a screenshot the way the dashboard does and reports the <img> element's geometry and a capture of it. */
  async function display(shot: Buffer, stage: { width: number; maxHeight: number; padding: number }): Promise<{ natural: { width: number; height: number }; displayed: { width: number; height: number }; offset: { left: number; top: number }; capture: Buffer; page: Page }> {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    // same rules as .live-simulation-stage / .live-shot in web/src/styles.css, plus a browser-frame style offset around the image
    await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;background:#020408}
.frame{margin:23px 0 0 31px;width:${stage.width}px}.bar{height:34px;background:#123}
.live-simulation-stage{position:relative;width:100%;overflow:hidden;background:#020408;padding:${stage.padding}px;box-sizing:border-box}
.live-shot{width:100%;height:auto;min-height:380px;max-height:${stage.maxHeight}px;object-fit:contain;background:#020408;display:block}</style></head>
<body><div class="frame"><div class="bar"></div><div class="live-simulation-stage"><img class="live-shot" id="shot" src="data:image/png;base64,${shot.toString('base64')}"></div></div></body></html>`);
    await page.waitForFunction("document.getElementById('shot').complete && document.getElementById('shot').naturalWidth > 0");
    const g = await page.evaluate(`(() => { const i = document.getElementById('shot'); const s = i.parentElement.getBoundingClientRect();
      return { natural: { width: i.naturalWidth, height: i.naturalHeight }, displayed: { width: i.clientWidth, height: i.clientHeight }, offset: { left: i.offsetLeft, top: i.offsetTop }, stage: { left: s.left, top: s.top } }; })()`) as { natural: { width: number; height: number }; displayed: { width: number; height: number }; offset: { left: number; top: number }; stage: { left: number; top: number } };
    // a capture of the stage element only: its pixel coordinates are the overlay's coordinate space
    const capture = await page.locator('.live-simulation-stage').screenshot({ type: 'png' });
    return { natural: g.natural, displayed: g.displayed, offset: g.offset, capture, page };
  }

  async function check(opts: { scrollY: number; dpr: number; stage: { width: number; maxHeight: number; padding: number } }): Promise<{ mapped: NonNullable<ReturnType<typeof mapBoxToDisplay>>; truth: { left: number; top: number; right: number; bottom: number }; naive: { left: number; top: number }; letterboxed: boolean }> {
    // the tested browser: its own device pixel ratio and scroll position
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: opts.dpr });
    const page = await ctx.newPage();
    await page.goto(url);
    await page.evaluate(`window.scrollTo(0, ${opts.scrollY})`);
    const box = (await page.locator('#submit').boundingBox())!; // what the testers send as the event's box
    const shot = await page.screenshot({ type: 'png' }); // the frame taken with it
    await ctx.close();
    expect(box.x).toBe(937); expect(box.y).toBe(1411 - opts.scrollY); // viewport-relative: scrolling is already in it

    const d = await display(shot, opts.stage);
    const mapped = mapBoxToDisplay({ box, viewport: { width: 1440, height: 900 }, natural: d.natural, displayed: d.displayed, offset: d.offset })!;
    expect(mapped).not.toBeNull();
    const truth = findMarker(d.capture)!; // where the button's pixels really are, in the overlay's coordinate space
    expect(truth, 'the button is visible in the displayed screenshot').not.toBeNull();
    await d.page.context().close();
    // what the old code did: percentages of the whole stage
    const stageW = opts.stage.width; const stageH = d.displayed.height + opts.stage.padding * 2;
    const naive = { left: (box.x / 1440) * stageW, top: (box.y / 900) * stageH };
    const painted = paintedRect(d.natural, d.displayed)!;
    return { mapped, truth, naive, letterboxed: painted.left > 1 || painted.top > 1 };
  }

  const cases = [
    { name: 'letterboxed left and right (clamped height), not scrolled', scrollY: 900, dpr: 1, stage: { width: 1100, maxHeight: 420, padding: 0 } },
    { name: 'no letterbox, scrolled so the button is near the top', scrollY: 1350, dpr: 1, stage: { width: 700, maxHeight: 760, padding: 0 } },
    { name: 'device pixel ratio 2 and a padded stage', scrollY: 1000, dpr: 2, stage: { width: 1000, maxHeight: 500, padding: 14 } },
  ];
  for (const k of cases) {
    it(`box and cursor are on the button: ${k.name}`, async () => {
      const r = await check(k);
      const tol = 1.5; // sub-pixel scaling of the displayed image
      expect(Math.abs(r.mapped.left - r.truth.left), `left ${r.mapped.left} vs ${r.truth.left}`).toBeLessThanOrEqual(tol);
      expect(Math.abs(r.mapped.top - r.truth.top), `top ${r.mapped.top} vs ${r.truth.top}`).toBeLessThanOrEqual(tol);
      expect(Math.abs(r.mapped.left + r.mapped.width - r.truth.right), 'right edge').toBeLessThanOrEqual(tol);
      expect(Math.abs(r.mapped.top + r.mapped.height - r.truth.bottom), 'bottom edge').toBeLessThanOrEqual(tol);
      // the cursor (the box centre) is inside the button, at its centre
      expect(Math.abs(r.mapped.centerX - (r.truth.left + r.truth.right) / 2)).toBeLessThanOrEqual(tol);
      expect(Math.abs(r.mapped.centerY - (r.truth.top + r.truth.bottom) / 2)).toBeLessThanOrEqual(tol);
      // and this test would have caught the bug: with letterboxing or padding, stage percentages miss the button
      if (r.letterboxed || k.stage.padding > 0) expect(Math.hypot(r.naive.left - r.truth.left, r.naive.top - r.truth.top)).toBeGreaterThan(10);
    }, 60_000);
  }

  it('a box is never drawn on a screenshot it does not belong to', () => {
    const base = { viewport: { width: 1440, height: 900 }, displayed: { width: 1000, height: 500 } };
    // a full-page capture (taller than the viewport): viewport coordinates would point at the wrong place
    expect(mapBoxToDisplay({ ...base, box: { x: 10, y: 10, width: 50, height: 20 }, natural: { width: 1440, height: 2600 } })).toBeNull();
    // an element entirely outside the viewport is not on the screenshot at all
    expect(mapBoxToDisplay({ ...base, box: { x: 10, y: 1400, width: 50, height: 20 }, natural: { width: 1440, height: 900 } })).toBeNull();
    // no image yet
    expect(mapBoxToDisplay({ ...base, box: { x: 10, y: 10, width: 50, height: 20 }, natural: { width: 0, height: 0 } })).toBeNull();
    // a partly visible element is clipped to what the screenshot shows
    const clipped = mapBoxToDisplay({ ...base, box: { x: 1400, y: 880, width: 100, height: 100 }, natural: { width: 1440, height: 900 } })!;
    const p = paintedRect({ width: 1440, height: 900 }, base.displayed)!;
    expect(clipped.left + clipped.width).toBeCloseTo(p.left + p.width, 3);
    expect(clipped.top + clipped.height).toBeCloseTo(p.top + p.height, 3);
  });
});
