import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserController } from '../src/browser/index.js';
import { crawl } from '../src/discovery/crawler.js';
import { launchForTest } from './helpers/launch.js';

/**
 * Regression: a reachable page whose resources keep loading used to fail with "page.goto: Timeout exceeded",
 * which made the whole run "Target unreachable" with 0 pages crawled.
 */
const NAV_TIMEOUT = 2000;
const page = (head: string, body: string): string => `<!doctype html><html lang="en"><head><title>Slow</title>${head}</head><body><h1>Usable page</h1>${body}<a href="/next">Next</a></body></html>`;

describe('navigation is robust against resources that keep loading', () => {
  let server: http.Server; let url: string; let c: BrowserController;
  const hanging: http.ServerResponse[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      const html = (s: string): void => { res.setHeader('content-type', 'text/html'); res.end(s); };
      if (p === '/hanging-image') return html(page('', '<img src="/never.png" alt="never loads">'));
      if (p === '/slow-head-script') return html(page('<script src="/slow.js"></script>', '<p>content after a slow script</p>'));
      if (p === '/next') return html(page('', '<p>second page</p>'));
      if (p === '/never.png' || p === '/no-response') { hanging.push(res); return; } // never answered
      // parser-blocking script that arrives AFTER the navigation timeout, like a slow vendor bundle
      if (p === '/slow.js') { setTimeout(() => { res.setHeader('content-type', 'text/javascript'); res.end('window.slowLoaded = true;'); }, NAV_TIMEOUT + 500); return; }
      res.statusCode = 404; res.end('not found');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    c = await launchForTest({ baseUrl: url, navigationTimeoutMs: NAV_TIMEOUT });
  });
  afterAll(async () => {
    await c?.close();
    for (const r of hanging) r.destroy();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(() => r(undefined)));
  });

  it('proceeds when the DOM is usable although the load event never fires', async () => {
    const nav = await c.navigate(`${url}/hanging-image`);
    expect(nav).toMatchObject({ ok: true, status: 200, partial: true });
    expect(nav.durationMs).toBeLessThan(NAV_TIMEOUT * 1.5); // the configured timeout is kept, not extended
    expect(await c.page.textContent('h1')).toBe('Usable page');
  });

  it('gives a document that is still being parsed a bounded grace period instead of failing', async () => {
    const nav = await c.navigate(`${url}/slow-head-script`);
    expect(nav).toMatchObject({ ok: true, status: 200 });
    expect(nav.durationMs).toBeLessThan(NAV_TIMEOUT * 1.5 + 1000);
    expect(await c.page.textContent('p')).toBe('content after a slow script');
  });

  it('a fully loaded page is not flagged as partial', async () => {
    const nav = await c.navigate(`${url}/next`);
    expect(nav.ok).toBe(true);
    expect(nav.partial).toBeUndefined();
  });

  it('the crawler crawls such a page and follows its links', async () => {
    const pages = await crawl(c, { startUrl: `${url}/hanging-image`, maxPages: 5, maxDepth: 1 });
    expect(pages.map((p) => new URL(p.url).pathname)).toEqual(['/hanging-image', '/next']);
    expect(pages.every((p) => p.model !== null && !p.error)).toBe(true);
    expect(pages[0]!.model!.images).toHaveLength(1);
  });

  it('a server that never answers is still a real failure', async () => {
    const nav = await c.navigate(`${url}/no-response`);
    expect(nav.ok).toBe(false);
    expect(nav.error).toMatch(/Timeout/i);
    expect(nav.partial).toBeUndefined();
  });
});
