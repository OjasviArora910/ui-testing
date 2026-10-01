import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDemoApp, type DemoServer } from '../demo-app/server.js';
import { buildPageModel } from '../src/discovery/pageModel.js';
import { crawl, normalizeUrl, sameOrigin } from '../src/discovery/crawler.js';
import { ActionGuard } from '../src/functional/actionGuard.js';
import { loadConfig } from '../src/shared/config.js';
import { launchForTest } from './helpers/launch.js';
import type { BrowserController } from '../src/browser/index.js';

describe('normalizeUrl', () => {
  it('dedupes equivalent URLs', () => {
    const b = 'http://Example.com/app/';
    expect(normalizeUrl('/a/?b=2&a=1#frag', b)).toBe('http://example.com/a?a=1&b=2');
    expect(normalizeUrl('/a?a=1&b=2&utm_source=x', b)).toBe('http://example.com/a?a=1&b=2');
    expect(normalizeUrl('http://example.com:80/x', b)).toBe('http://example.com/x');
  });
  it('rejects non-page URLs', () => {
    expect(normalizeUrl('mailto:a@b.c', 'http://x.test')).toBeNull();
    expect(normalizeUrl('javascript:void(0)', 'http://x.test')).toBeNull();
    expect(normalizeUrl('/file.pdf', 'http://x.test')).toBeNull();
    expect(sameOrigin('http://a.test/x', 'http://a.test/y')).toBe(true);
    expect(sameOrigin('http://a.test/x', 'http://b.test/y')).toBe(false);
  });
});

describe('discovery against the demo app', () => {
  let demo: DemoServer; let c: BrowserController;
  beforeAll(async () => { demo = await startDemoApp(); c = await launchForTest({ baseUrl: demo.url, blockExternal: true }); });
  afterAll(async () => { await c?.close(); await demo?.close(); });

  it('builds a PageModel with headings, forms, fields, tables and images', async () => {
    await c.navigate(`${demo.url}/forms`);
    const m = await buildPageModel(c);
    expect(m.title).toContain('Forms');
    expect(m.lang).toBe('en');
    expect(m.headings.map((h) => h.name)).toContain('Forms');
    expect(m.forms).toHaveLength(1);
    expect(m.forms[0]!.form.fields.map((f) => f.type)).toEqual(['email', 'text', 'number']);
    expect(m.forms[0]!.form.noValidate).toBe(true);
    expect(m.buttons.some((b) => b.name === 'Subscribe')).toBe(true);
    expect(m.inputs.length).toBeGreaterThanOrEqual(2);
    expect(m.counts.links).toBeGreaterThan(5);

    await c.navigate(`${demo.url}/responsive`);
    const r = await buildPageModel(c);
    expect(r.tables).toHaveLength(1);
    expect(r.tables[0]!.meta?.headers).toBe(7);
    expect(r.images[0]!.meta?.alt).toBe('Wide banner');
    expect(r.images[0]!.box.width).toBe(1200);
  });

  it('records visibility, enabled state and bounding boxes for elements', async () => {
    await c.navigate(`${demo.url}/modal`);
    const m = await buildPageModel(c);
    const open = m.buttons.find((b) => b.name === 'Open settings')!;
    expect(open.visible).toBe(true);
    expect(open.enabled).toBe(true);
    expect(open.box.width).toBeGreaterThan(40);
    expect(m.dialogs[0]!.visible).toBe(false);
  });

  it('crawls same-origin pages with limits, skipping guard-blocked links', async () => {
    const cfg = loadConfig('qa.config.json');
    const guard = new ActionGuard({ keywords: cfg.dangerousActions.keywords, allowMethods: cfg.dangerousActions.allowMethods, origin: demo.url });
    const seen: string[] = [];
    const pages = await crawl(c, {
      startUrl: demo.url, maxPages: 30, maxDepth: 2,
      allowLink: (l) => guard.check({ kind: 'navigate', url: l.href, text: l.text, selector: l.selector }).allowed,
      onPage: (p) => { seen.push(p.url); },
    });
    const paths = pages.map((p) => new URL(p.url).pathname);
    expect(paths).toContain('/overlap');
    expect(paths).toContain('/legit');
    expect(new Set(paths).size).toBe(paths.length); // deduped
    expect(demo.hits.deleteLink).toBe(0); // guard kept the crawler off the destructive link
    const links = pages.find((p) => new URL(p.url).pathname === '/links')!;
    expect(links.outgoing.some((u) => u.endsWith('/does-not-exist'))).toBe(true);
    const missing = pages.find((p) => p.url.endsWith('/does-not-exist'));
    expect(missing?.status).toBe(404);
    expect(missing?.model).toBeNull();
  });

  it('honours maxPages and maxDepth and can resume from persisted state', async () => {
    const first = await crawl(c, { startUrl: demo.url, maxPages: 3, maxDepth: 1 });
    expect(first.length).toBe(3);
    let state = { visited: first.map((p) => p.url), queue: [] as { url: string; depth: number }[] };
    await crawl(c, { startUrl: demo.url, maxPages: 3, maxDepth: 1, onPage: (_p, s) => { state = s; } });
    const shallow = await crawl(c, { startUrl: demo.url, maxPages: 50, maxDepth: 0 });
    expect(shallow.length).toBe(1);
    const resumed = await crawl(c, { startUrl: demo.url, maxPages: 6, maxDepth: 1, initial: { visited: state.visited, queue: state.queue } });
    for (const p of resumed) expect(state.visited.slice(0, 3)).not.toContain(p.url);
  });
});
