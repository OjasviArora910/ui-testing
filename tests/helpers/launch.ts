import { BrowserController, type BrowserControllerOptions } from '../../src/browser/index.js';

/** Uses Playwright's managed Chromium (npx playwright install chromium). Set QA_USE_SPARTICUZ=1 for the sandbox-only bundled binary. */
export async function launchForTest(opts: BrowserControllerOptions): Promise<BrowserController> {
  if (!process.env.QA_CHROMIUM_PATH && process.env.QA_USE_SPARTICUZ === '1') {
    const { default: chromium } = await import('@sparticuz/chromium');
    return BrowserController.launch({ ...opts, executablePath: await chromium.executablePath(), launchArgs: chromium.args });
  }
  return BrowserController.launch(opts);
}
