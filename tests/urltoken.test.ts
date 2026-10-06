import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatform, type Platform } from '../src/orchestrator/index.js';

/**
 * The access token is registered as a secret and removed from everything that is stored, the run's own URL included.
 * If the page URL is entered where the token belongs, the URL itself became "a secret": the run was stored with the URL
 * "[REDACTED]" and failed with "Invalid URL" before a browser started, and so did every later run with that URL until
 * the server was restarted. A URL is not a token: it must be refused up front and must never be registered.
 */
describe('a page URL entered as the access token', () => {
  let site: http.Server; let siteUrl: string; let platform: Platform;
  const SESSION = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJxYSJ9.c2Vzc2lvbi1mb3ItdGVzdHM';

  beforeAll(async () => {
    site = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html lang="en"><head><title>Roles</title></head><body><main><h1>Roles</h1><p>Nothing to do.</p></main></body></html>'); });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-urltoken-'));
    platform = createPlatform({
      configOverrides: { paths: { dataDir: path.join(dir, 'data'), baselineDir: path.join(dir, 'baselines') }, viewports: [{ name: 'desktop', width: 1280, height: 800 }] },
      provider: null, trace: false, env: {},
    });
  }, 60_000);
  afterAll(async () => { await platform?.orchestrator.shutdown(); site.closeAllConnections?.(); await new Promise((r) => site.close(() => r(undefined))); });

  it('is refused with a clear message, is not registered as a secret, and does not break the runs that follow', async () => {
    const exact = `${siteUrl}/#setup/roles`;
    const start = (token: string) => platform.orchestrator.start({ url: exact, scope: 'page', mode: 'deterministic', auth: { token, location: 'cookie', key: 'jwt' } } as Parameters<typeof platform.orchestrator.start>[0]);

    for (const notAToken of [exact, ` ${exact} `, siteUrl, 'https://main.dvl.amp.vg/#setup/roles']) {
      expect(() => start(notAToken), notAToken).toThrow(/access token field contains a URL/i);
    }
    // nothing was registered: the URL is still readable everywhere it is stored
    expect(platform.redactor.redact(exact)).toBe(exact);
    expect(platform.orchestrator.db.listRuns().length).toBe(0);

    // the next run, with a real token, keeps the exact URL as entered and really runs
    const run = start(SESSION);
    expect(run.url).toBe(exact);
    const done = await platform.orchestrator.whenDone(run.id);
    expect(done.error ?? '').not.toMatch(/Invalid URL/);
    expect(done.status).toBe('COMPLETED');
    expect(platform.orchestrator.db.listPages(run.id).map((p) => p.url)).toEqual([exact]);
    expect(JSON.stringify(platform.orchestrator.db.getRun(run.id))).not.toContain(SESSION);
  }, 180_000);
});
