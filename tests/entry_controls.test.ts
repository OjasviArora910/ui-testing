import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserController } from '../src/browser/index.js';
import { buildPageModel } from '../src/discovery/pageModel.js';
import { classifyPage, selectTests } from '../src/dynamic/index.js';
import { loadConfig } from '../src/shared/config.js';
import { launchForTest } from './helpers/launch.js';

describe('generic row/detail entry controls', () => {
  let server: http.Server;
  let url: string;
  let browser: BrowserController;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><html lang="en"><head><title>List</title></head><body>
<main>
  <h1>Accounts</h1>
  <table>
    <tr><th>Name</th><th>Actions</th></tr>
    <tr>
      <td>Alpha</td>
      <td><span id="entry" class="row-action icon-pencil" style="display:inline-block;width:24px;height:24px;cursor:pointer" onclick="document.getElementById('editor').hidden=false"></span></td>
    </tr>
    <tr id="ambiguous-row" style="cursor:pointer" onclick="document.body.dataset.row='clicked'"><td>Beta</td><td></td></tr>
  </table>
  <span id="danger-icon" class="icon-trash" style="display:inline-block;width:24px;height:24px;cursor:pointer" onclick="document.body.dataset.deleted='1'"></span>
  <section id="editor" hidden><h2>Editor</h2><label>Enabled <input type="checkbox"></label></section>
</main>
</body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await launchForTest({ baseUrl: url });
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  it('discovers safe icon-like row entry controls without selecting ambiguous or destructive click targets', async () => {
    await browser.navigate(url);
    const model = await buildPageModel(browser);
    const profile = classifyPage(model);
    const plan = selectTests(profile, model, loadConfig('qa.config.json', { functional: { maxButtonsPerPage: 20 }, dynamic: { maxGenericButtons: 20 } }));

    expect(model.interactive.find((e) => e.selector === '#entry')).toMatchObject({ type: 'interactive', name: 'pencil', visible: true });
    expect(model.interactive.some((e) => e.selector === '#ambiguous-row')).toBe(false);
    expect(model.interactive.some((e) => e.selector === '#danger-icon')).toBe(false);
    expect(plan.buttons.map((b) => b.element.selector)).toContain('#entry');
    expect(plan.buttons.map((b) => b.element.selector)).not.toContain('#ambiguous-row');
    expect(plan.buttons.map((b) => b.element.selector)).not.toContain('#danger-icon');
  });
});
