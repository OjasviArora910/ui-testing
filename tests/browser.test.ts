import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserController } from '../src/browser/index.js';
import { startFixture, type Fixture } from './helpers/fixture-server.js';
import { launchForTest } from './helpers/launch.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123_-sig';
let fx: Fixture; let b: BrowserController;

beforeAll(async () => { fx = await startFixture(); b = await launchForTest({ baseUrl: fx.url }); });
afterAll(async () => { await b?.close(); await fx?.close(); });

describe('BrowserController basics', () => {
  it('navigates and reports results', async () => {
    const r = await b.navigate('/');
    expect(r.ok).toBe(true);
    expect(r.urlAfter).toBe(`${fx.url}/`);
    expect((await b.pageMetrics()).title).toBe('Fixture');
  });
  it('resolves semantic targets and performs actions', async () => {
    expect((await b.fill({ label: 'Email' }, 'qa@example.com')).ok).toBe(true);
    expect(await b.locate({ label: 'Email' }).inputValue()).toBe('qa@example.com');
    expect((await b.check({ label: 'I agree' })).ok).toBe(true);
    expect((await b.select({ role: 'combobox', name: 'Plan' }, 'b')).ok).toBe(true);
    expect((await b.fill({ attr: { name: 'placeholder', value: 'Search' } }, 'x')).ok).toBe(true);
    expect((await b.hover({ role: 'button', name: 'Save' })).ok).toBe(true);
    expect((await b.uncheck({ label: 'I agree' })).ok).toBe(true);
    expect((await b.press('Tab')).ok).toBe(true);
    expect((await b.scroll({ to: 'bottom' })).ok).toBe(true);
  });
  it('returns failure (not exception) for missing elements', async () => {
    const quick = await launchForTest({ baseUrl: fx.url, actionTimeoutMs: 1000 });
    try {
      await quick.navigate('/');
      const r = await quick.click({ role: 'button', name: 'Nope' });
      expect(r.ok).toBe(false); expect(r.error).toBeTruthy();
    } finally { await quick.close(); }
  });
  it('supports history navigation and reload', async () => {
    await b.navigate('/about');
    expect((await b.back()).urlAfter).toBe(`${fx.url}/`);
    expect((await b.forward()).urlAfter).toBe(`${fx.url}/about`);
    expect((await b.reload()).ok).toBe(true);
    await b.navigate('/');
  });
});

describe('inspection', () => {
  it('lists interactive elements with role/name/state', async () => {
    const els = await b.interactiveElements();
    const save = els.find((e) => e.role === 'button' && e.name === 'Save');
    expect(save?.enabled).toBe(true); expect(save?.visible).toBe(true);
    expect(save!.box.width).toBeGreaterThan(0);
    expect(els.find((e) => e.name === 'Disabled')?.enabled).toBe(false);
    expect(els.find((e) => e.role === 'link' && e.name === 'About')?.href).toBe(`${fx.url}/about`);
    expect(els.find((e) => e.role === 'textbox' && e.name === 'Email')?.required).toBe(true);
  });
  it('excludes hidden elements from visibleElements but not allElements', async () => {
    const vis = await b.visibleElements(); const all = await b.allElements();
    expect(vis.some((e) => e.selector === '[data-testid="hidden"]')).toBe(false);
    expect(all.find((e) => e.selector === '[data-testid="hidden"]')?.visible).toBe(false);
  });
  it('returns ARIA, DOM, bounding box and computed styles', async () => {
    expect(await b.aria()).toContain('button "Save"');
    expect(await b.dom()).toContain('<h1>Fixture App</h1>');
    expect((await b.boundingBox({ role: 'button', name: 'Save' }))?.width).toBeGreaterThan(0);
    expect((await b.computedStyles({ role: 'button', name: 'Save' }, ['display']))['display']).toBeTruthy();
  });
  it('takes page and element screenshots', async () => {
    expect((await b.screenshot()).subarray(1, 4).toString()).toBe('PNG');
    expect((await b.screenshot({ target: { role: 'button', name: 'Save' } })).length).toBeGreaterThan(100);
  });
  it('changes viewport', async () => {
    await b.setViewport({ name: 'mobile', width: 390, height: 844 });
    expect((await b.pageMetrics()).clientWidth).toBeLessThanOrEqual(390);
    await b.setViewport({ name: 'desktop', width: 1440, height: 900 });
  });
});

describe('network + console collection', () => {
  it('captures 404, 500, console errors and page errors with redacted URLs', async () => {
    await b.navigate('/');
    await b.click({ css: '#boom' }); await b.settle(300);
    await b.click({ css: '#err' }); await b.settle(300);
    const fails = b.events.failures();
    expect(fails.some((n) => n.status === 404 && n.url.endsWith('/missing.png'))).toBe(true);
    const boom = fails.find((n) => n.status === 500);
    expect(boom).toBeTruthy();
    expect(boom!.url).not.toContain('SUPERSECRET123456');
    expect(b.events.errors().some((c) => c.kind === 'console' && c.text.includes('bad thing'))).toBe(true);
    expect(b.events.errors().some((c) => c.kind === 'pageerror' && c.text.includes('uncaught!'))).toBe(true);
  });
  it('honours ignoredEndpoints', async () => {
    const ib = await launchForTest({ baseUrl: fx.url, ignoredEndpoints: ['missing\\.png'] });
    try {
      await ib.navigate('/'); await ib.settle(200);
      expect(ib.events.failures().some((n) => n.url.includes('missing.png'))).toBe(false);
      expect(ib.events.network.some((n) => n.url.includes('missing.png') && n.ignored)).toBe(true);
    } finally { await ib.close(); }
  });
});

describe('authentication', () => {
  const echo = async (c: BrowserController) => { await c.navigate('/'); await c.page.evaluate("fetch('/api/echo')"); await c.settle(300); return fx.received.at(-1); };

  it('header: sends Authorization to same origin only and never leaks into events', async () => {
    const c = await launchForTest({ baseUrl: fx.url, auth: { jwt: JWT, location: 'header' } });
    try {
      const got = await echo(c);
      expect(got?.authorization).toBe(`Bearer ${JWT}`);
      expect(JSON.stringify([c.events.network, c.events.console, await c.dom()])).not.toContain(JWT);
    } finally { await c.close(); }
  });
  it('cookie: sets cookie', async () => {
    const c = await launchForTest({ baseUrl: fx.url, auth: { jwt: JWT, location: 'cookie', key: 'session_jwt' } });
    try { expect((await echo(c))?.cookie).toContain(`session_jwt=${JWT}`); } finally { await c.close(); }
  });
  it.each(['localStorage', 'sessionStorage'] as const)('%s: injects value before page scripts', async (loc) => {
    const c = await launchForTest({ baseUrl: fx.url, auth: { jwt: JWT, location: loc, key: 'auth' } });
    try {
      await c.navigate('/');
      expect(await c.page.evaluate(`${loc}.getItem('auth')`)).toBe(JWT);
      expect(await c.aria()).not.toContain(JWT);
    } finally { await c.close(); }
  });
  it('rejects invalid auth config', async () => {
    await expect(launchForTest({ baseUrl: fx.url, auth: { jwt: 'x', location: 'bogus' as never } })).rejects.toThrow();
  });
});
