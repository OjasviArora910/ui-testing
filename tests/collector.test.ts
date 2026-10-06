import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserController } from '../src/browser/index.js';
import { launchForTest } from './helpers/launch.js';

/**
 * A request that is still unanswered when its page is left is abandoned by the browser, which reports nothing more about
 * it. It must not stay "in flight" for ever: every later wait for the network to go quiet would run to its limit.
 */
describe('requests in flight (browser)', () => {
  let site: http.Server; let url: string; let c: BrowserController;
  const SLOW_MS = 1200;

  beforeAll(async () => {
    site = http.createServer((req, res) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      const json = (body: unknown): void => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
      if (p === '/api/never') return; // never answered
      if (p === '/api/slow') { setTimeout(() => json({ value: 'slow' }), SLOW_MS); return; }
      if (p === '/api/ok') return json({ items: [1, 2] });
      res.setHeader('content-type', 'text/html');
      res.end(p === '/leaving'
        ? `<!doctype html><title>Leaving</title><h1>Leaving</h1><script>fetch('/api/never').catch(() => null)</script>`
        : `<!doctype html><title>Next</title><h1>Next</h1><script>fetch('/api/ok').then((r) => r.json()).catch(() => null)</script>`);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    c = await launchForTest({ baseUrl: url, blockExternal: true });
  }, 60_000);
  afterAll(async () => { await c?.close(); site.closeAllConnections?.(); await new Promise((r) => site.close(() => r(undefined))); });

  const until = async (ok: () => boolean, maxMs = 5000): Promise<void> => { const end = Date.now() + maxMs; while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 25)); };

  it('a request abandoned by leaving its page does not stay in flight; the next page is tracked normally', async () => {
    await c.navigate(`${url}/leaving`);
    await until(() => c.events.inflight() === 1);
    expect(c.events.inflight()).toBe(1); // the unanswered request of the page about to be left

    const from = c.events.network.length;
    await c.navigate(`${url}/next`);
    const t = Date.now();
    await c.waitForPageLoad();
    expect(Date.now() - t).toBeLessThan(2000); // not the 6s limit
    expect(c.events.inflight()).toBe(0);

    // the new page's own requests are tracked as before
    await c.events.flush();
    const ok = c.events.network.slice(from).find((n) => new URL(n.url).pathname === '/api/ok');
    expect(ok).toMatchObject({ method: 'GET', status: 200, ok: true, phase: 'page-load', response: { body: 'data', items: 2 } });
    expect(c.events.network.slice(from).some((n) => n.resourceType === 'document' && n.status === 200)).toBe(true);
  }, 60_000);

  it('a change within the same document (hash) keeps its requests in flight, and they are recorded when they finish', async () => {
    await c.navigate(`${url}/next`);
    await c.waitForPageLoad();
    expect(c.events.inflight()).toBe(0);
    const from = c.events.network.length;
    c.beginAction();
    await c.page.evaluate("fetch('/api/slow').then((r) => r.json()).catch(() => null); location.hash = 'section'; undefined");
    await until(() => c.events.inflight() === 1, 1000);
    await new Promise((r) => setTimeout(r, 300)); // well after the hash change
    expect(c.page.url()).toBe(`${url}/next#section`);
    expect(c.events.inflight()).toBe(1); // still waited for
    await until(() => c.events.inflight() === 0, SLOW_MS + 3000);
    expect(c.events.inflight()).toBe(0);
    const slow = c.events.network.slice(from).find((n) => new URL(n.url).pathname === '/api/slow');
    expect(slow).toMatchObject({ status: 200, ok: true, phase: 'action' });
    expect(slow!.durationMs).toBeGreaterThanOrEqual(SLOW_MS - 100);
  }, 60_000);
});
