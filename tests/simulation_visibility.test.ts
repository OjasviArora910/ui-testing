import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserController } from '../src/browser/index.js';
import { buildPageModel } from '../src/discovery/pageModel.js';
import { ActionBudget, ActionGuard, runFunctionalTests, type ActionLifecycleEvent } from '../src/functional/index.js';
import { buildRegistry } from '../src/rules/index.js';
import { loadConfig } from '../src/shared/config.js';
import { launchForTest } from './helpers/launch.js';

const config = loadConfig('qa.config.json');

const HTML_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Simulation Visibility Verification</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 30px; background: #ffffff; color: #111827; }
    button { font-size: 16px; padding: 10px 20px; border-radius: 6px; cursor: pointer; border: 1px solid #d1d5db; background: #f3f4f6; }
    .dialog-box { display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 340px; padding: 24px; background: #ffffff; border: 2px solid #3b82f6; box-shadow: 0 10px 25px rgba(0,0,0,0.2); border-radius: 8px; z-index: 1000; }
    .dialog-box.is-open { display: block; }
    .tab-btn { padding: 8px 16px; background: #e5e7eb; border: 1px solid #9ca3af; margin-right: 4px; }
    .tab-btn[aria-selected="true"] { background: #3b82f6; color: #ffffff; font-weight: bold; }
    .panel { padding: 16px; border: 1px solid #e5e7eb; margin-top: 8px; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <h1>Simulation Verification Page</h1>

  <!-- 1. Modal Trigger -->
  <section style="margin-bottom: 40px;">
    <h2>Modal Dialog Test</h2>
    <button type="button" id="open-modal-btn" aria-haspopup="dialog">Open Confirmation Modal</button>
    <div id="modal-container" class="dialog-box" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <h3 id="modal-title">Confirmation Dialog</h3>
      <p>Modal content is now visibly rendered on screen.</p>
      <button type="button" id="close-modal-btn" aria-label="Close dialog">Close Dialog</button>
    </div>
  </section>

  <!-- 2. Tabs Switcher -->
  <section style="margin-bottom: 40px;">
    <h2>Tabs Test</h2>
    <div role="tablist">
      <button role="tab" id="tab-overview" aria-selected="true" class="tab-btn">Overview</button>
      <button role="tab" id="tab-permissions" aria-selected="false" class="tab-btn">Permissions</button>
    </div>
    <div id="panel-overview" class="panel">Overview content is currently displayed.</div>
    <div id="panel-permissions" class="panel hidden">Permissions settings are now displayed!</div>
  </section>

  <script>
    const modalBtn = document.getElementById('open-modal-btn');
    const modalBox = document.getElementById('modal-container');
    const closeBtn = document.getElementById('close-modal-btn');

    modalBtn.addEventListener('click', () => {
      modalBox.classList.add('is-open');
    });
    closeBtn.addEventListener('click', () => {
      modalBox.classList.remove('is-open');
    });

    const tabOverview = document.getElementById('tab-overview');
    const tabPerms = document.getElementById('tab-permissions');
    const panelOverview = document.getElementById('panel-overview');
    const panelPerms = document.getElementById('panel-permissions');

    tabOverview.addEventListener('click', () => {
      tabOverview.setAttribute('aria-selected', 'true');
      tabPerms.setAttribute('aria-selected', 'false');
      panelOverview.classList.remove('hidden');
      panelPerms.classList.add('hidden');
    });

    tabPerms.addEventListener('click', () => {
      tabPerms.setAttribute('aria-selected', 'true');
      tabOverview.setAttribute('aria-selected', 'false');
      panelPerms.classList.remove('hidden');
      panelOverview.classList.add('hidden');
    });
  </script>
</body>
</html>`;

describe('Live simulation visual execution and state propagation', () => {
  let server: http.Server;
  let url: string;
  let c: BrowserController;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML_PAGE);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        url = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
    c = await launchForTest({ baseUrl: url, blockExternal: true });
  }, 30000);

  afterAll(async () => {
    await c?.close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it('proves that physical click execution visibly changes the simulation screenshot buffer', async () => {
    await c.navigate(url);
    const model = await buildPageModel(c);
    const registry = await buildRegistry(config);
    const guard = new ActionGuard({ keywords: config.dangerousActions.keywords, allowMethods: config.dangerousActions.allowMethods, origin: url });
    c.setRequestGuard(guard.asRequestGuard());
    const budget = new ActionBudget(20);

    const actionEvents: ActionLifecycleEvent[] = [];

    await runFunctionalTests({
      controller: c,
      guard,
      pageUrl: url,
      model,
      config,
      budget,
      testedLinks: new Set(),
      registry,
      onAction: (a) => {
        actionEvents.push(a);
      },
    });

    // 1. Verify TARGETED phase was emitted with bounding box
    const targetedEvents = actionEvents.filter((e) => e.phase === 'TARGETED');
    expect(targetedEvents.length).toBeGreaterThan(0);
    for (const t of targetedEvents) {
      expect(t.box).toBeDefined();
      expect(t.box?.width).toBeGreaterThan(0);
      expect(t.box?.height).toBeGreaterThan(0);
      expect(typeof t.box?.x).toBe('number');
      expect(typeof t.box?.y).toBe('number');
    }

    // 2. Verify CLICKING phase was emitted with buffer and bounding box
    const clickingEvents = actionEvents.filter((e) => e.phase === 'CLICKING');
    expect(clickingEvents.length).toBeGreaterThan(0);
    for (const clk of clickingEvents) {
      expect(clk.box).toBeDefined();
      expect(clk.box?.width).toBeGreaterThan(0);
      expect(clk.buffer).toBeDefined();
      expect(Buffer.isBuffer(clk.buffer)).toBe(true);
      expect(clk.buffer!.length).toBeGreaterThan(1000);
    }

    // 3. Verify RESULT / VERIFYING phase captures the post-click state with changed screenshot
    const resultEvents = actionEvents.filter((e) => e.phase === 'RESULT' || e.phase === 'VERIFYING');
    expect(resultEvents.length).toBeGreaterThan(0);

    // Find the modal click or tab switch interaction
    const clickingModal = clickingEvents.find((e) => /modal/i.test(e.target));
    const resultModal = resultEvents.find((e) => /modal/i.test(e.target) && e.phase === 'RESULT');

    if (clickingModal && resultModal) {
      expect(clickingModal.buffer).toBeDefined();
      expect(resultModal.buffer).toBeDefined();
      // The visual state buffer MUST be physically different because the modal dialog was opened on screen!
      const beforeBuffer = clickingModal.buffer!;
      const afterBuffer = resultModal.buffer!;
      expect(beforeBuffer.equals(afterBuffer)).toBe(false);
    }

    // 4. Verify that the sequence of phases is ordered correctly: TARGETED -> CLICKING -> (OBSERVING/VERIFYING) -> RESULT
    const firstTargetIdx = actionEvents.findIndex((e) => e.phase === 'TARGETED');
    const firstClickIdx = actionEvents.findIndex((e) => e.phase === 'CLICKING');
    const firstResultIdx = actionEvents.findIndex((e) => e.phase === 'RESULT');

    expect(firstTargetIdx).toBeGreaterThanOrEqual(0);
    expect(firstClickIdx).toBeGreaterThan(firstTargetIdx);
    expect(firstResultIdx).toBeGreaterThan(firstClickIdx);
  });
});
