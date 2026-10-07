import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserController } from '../src/browser/index.js';
import { buildPageModel } from '../src/discovery/pageModel.js';
import { classifyPage, classifyResult, selectTests } from '../src/dynamic/index.js';
import { ActionBudget, ActionGuard, runFunctionalTests, type FunctionalResult } from '../src/functional/index.js';
import { auditStateWithScrolling } from '../src/functional/audit.js';
import { buildRegistry } from '../src/rules/index.js';
import { loadConfig } from '../src/shared/config.js';
import { launchForTest } from './helpers/launch.js';

const config = loadConfig('qa.config.json', { functional: { maxButtonsPerPage: 40 }, dynamic: { maxGenericButtons: 40 } });

describe('state-aware full UI/UX auditing and scrolling', () => {
  let site: http.Server;
  let url: string;
  let c: BrowserController;

  beforeAll(async () => {
    site = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><html lang="en"><head><title>Full UI/UX State Test</title>
<style>
body { font-family: sans-serif; margin: 20px; }
.scroll-panel { height: 300px; overflow-y: scroll; border: 1px solid #ccc; padding: 10px; margin-bottom: 20px; }
.spacer { height: 400px; background: #f0f0f0; margin-bottom: 10px; }
.broken-img { width: 100px; height: 100px; }
.tabs { display: flex; gap: 8px; list-style: none; padding: 0; }
.tabs li.active a { font-weight: bold; }
.tab-content { display: none; padding: 10px; border: 1px solid #ddd; }
.tab-content.active { display: block; }
.modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); }
.modal.show { display: block; }
.modal-box { background: white; margin: 50px auto; width: 400px; height: 250px; overflow-y: scroll; padding: 20px; }

/* Deliberately malformed UI layout styles */
.clipped-box { width: 80px; height: 25px; overflow: hidden; white-space: nowrap; border: 1px solid red; }
</style>
</head>
<body>
<h1>App UI/UX State Test</h1>

<!-- Deliberately clipped text defect on initial page -->
<div class="clipped-box" id="clipped-hero">Unusually long descriptive content that gets cut off without ellipsis</div>

<!-- Long Scrollable Container with defect placed below fold -->
<div class="scroll-panel" id="main-scroll">
  <p>Top of scroll container</p>
  <div class="spacer"></div>
  <p id="bottom-text">Bottom of scroll container</p>
  <!-- Distorted image defect at bottom of scroll container (natural 100x100 png rendered at 200x60) -->
  <img id="distorted-img" class="broken-img" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAPklEQVR42u3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwG5nQAAGY0s10AAAAAElFTkSuQmCC" style="width: 200px; height: 60px;" alt="Distorted" />
</div>

<!-- Tabs State -->
<ul class="tabs" id="tab-nav">
  <li class="active"><a href="#tab1" data-target="tab1">Overview</a></li>
  <li><a href="#tab2" data-target="tab2">Details</a></li>
</ul>
<div id="tab1" class="tab-content active">
  <p>Overview panel text.</p>
  <button type="button" id="open-modal-btn">Open Dialog</button>
</div>
<div id="tab2" class="tab-content">
  <p>Details panel text with extra content.</p>
  <div class="clipped-box" id="clipped-tab-text">Tab specific long text that is badly clipped</div>
</div>

<!-- Modal State -->
<div class="modal" id="dialog-test">
  <div class="modal-box">
    <h2>Dialog Header</h2>
    <div class="clipped-box" id="clipped-modal-text">Modal action header text with obvious clipping problem</div>
    <div class="spacer"></div>
    <button type="button" id="close-modal-btn">Close Dialog</button>
  </div>
</div>

<script>
document.querySelectorAll('.tabs a').forEach(a => {
  a.onclick = (e) => {
    e.preventDefault();
    document.querySelectorAll('.tabs li').forEach(li => li.classList.remove('active'));
    a.parentElement.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
    document.getElementById(a.dataset.target).classList.add('active');
  };
});
document.getElementById('open-modal-btn').onclick = () => {
  document.getElementById('dialog-test').classList.add('show');
};
document.getElementById('close-modal-btn').onclick = () => {
  document.getElementById('dialog-test').classList.remove('show');
};
</script>
</body>
</html>`);
    });

    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    c = await launchForTest({ baseUrl: url, blockExternal: true });
  }, 60_000);

  afterAll(async () => {
    await c?.close();
    site?.closeAllConnections?.();
    await new Promise((r) => site.close(() => r(undefined)));
  });

  it('scans scrollable containers and detects defects placed below the fold and in malformed layout', async () => {
    await c.navigate(url);
    await c.settle(150);
    const registry = await buildRegistry(config);
    const findings = await auditStateWithScrolling(c, config, registry);

    // 1. Distorted image defect detected
    const imgDefect = findings.find((f) => f.ruleId === 'image.distorted');
    expect(imgDefect).toBeDefined();
    expect(imgDefect?.classification).toBe('defect');

    // 2. Clipped text defect detected on initial page
    const clipDefect = findings.find((f) => f.ruleId === 'geometry.text-clipping');
    expect(clipDefect).toBeDefined();
    expect(clipDefect?.classification).toBe('defect');
  });

  it('audits state transitions across tabs and modals, detecting dynamic defects without creating false bugs on plain text', async () => {
    const guard = new ActionGuard({ keywords: config.dangerousActions.keywords, allowMethods: config.dangerousActions.allowMethods, origin: url });
    c.setRequestGuard(guard.asRequestGuard());
    await c.navigate(url);
    await c.settle(150);

    const model = await buildPageModel(c);
    const plan = selectTests(classifyPage(model), model, config);

    const results: FunctionalResult[] = await runFunctionalTests({
      controller: c,
      guard,
      pageUrl: c.page.url(),
      model,
      config,
      budget: new ActionBudget(100),
      plan,
    });

    // 1. Plain text like "Overview panel text" must never become a confirmed BUG
    const plainTextBugs = results.filter((r) => classifyResult(r) === 'BUG' && /panel text/i.test(r.actual));
    expect(plainTextBugs).toHaveLength(0);

    // 2. Buttons exercised correctly
    expect(results.some((r) => r.element?.name === 'Open Dialog')).toBe(true);

    // 3. Dynamic UI/UX defects detected in revealed states
    const confirmedBugs = results.filter((r) => classifyResult(r) === 'BUG');
    expect(confirmedBugs.some((r) => r.check === 'geometry.text-clipping' || r.check === 'image.distorted')).toBe(true);
  });
});
