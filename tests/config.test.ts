import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, ConfigSchema } from '../src/shared/config.js';
import { AuthProfileResolver } from '../src/shared/authProfiles.js';
import { RunRequestSchema } from '../src/shared/runRequest.js';

describe('config', () => {
  it('shipped qa.config.json validates and equals the schema defaults for core limits', () => {
    const c = loadConfig('qa.config.json');
    expect(c.maxPages).toBe(20);
    expect(c.viewports.map((v) => v.name)).toEqual(['desktop', 'tablet', 'mobile']);
    expect(c.dangerousActions.allowMethods).toContain('GET');
  });
  it('missing file yields defaults; overrides deep-merge', () => {
    const c = loadConfig('does-not-exist.json', { maxPages: 3, geometry: { minTargetSize: 30 } });
    expect(c.maxPages).toBe(3);
    expect(c.geometry.minTargetSize).toBe(30);
    expect(c.geometry.overlapMinRatio).toBe(0.2);
  });
  it('rejects invalid config with a readable message', () => {
    expect(() => loadConfig('does-not-exist.json', { maxPages: -1 })).toThrow(/maxPages/);
    expect(ConfigSchema.safeParse({ viewports: [] }).success).toBe(false);
  });
});

describe('auth profiles', () => {
  it('lists names only and resolves from env', () => {
    const r = new AuthProfileResolver({ a: { location: 'cookie', key: 'session', source: { env: 'MY_JWT' } } }, { MY_JWT: ' secret-token-value ' });
    expect(r.list()).toEqual([{ name: 'a', location: 'cookie' }]);
    expect(JSON.stringify(r.list())).not.toContain('MY_JWT');
    const cfg = r.resolve('a');
    expect(cfg.jwt).toBe('secret-token-value');
    expect(cfg.key).toBe('session');
  });
  it('resolves from a file and errors never include the secret', () => {
    const f = path.join(os.tmpdir(), `qa-jwt-${Date.now()}.txt`);
    fs.writeFileSync(f, 'file-secret-value\n');
    const r = new AuthProfileResolver({ b: { location: 'header', source: { file: f } }, c: { location: 'header', source: { env: 'NOPE' } } }, {});
    expect(r.resolve('b').jwt).toBe('file-secret-value');
    expect(() => r.resolve('c')).toThrow(/NOPE/);
    expect(() => r.resolve('zzz')).toThrow(/Unknown auth profile/);
    fs.unlinkSync(f);
  });
});

describe('RunRequest', () => {
  it('accepts a valid request and applies defaults', () => {
    const r = RunRequestSchema.parse({ url: 'http://localhost:3000' });
    expect(r.mode).toBe('deterministic');
  });
  it('REJECTS a raw jwt (or any unknown field) so credentials cannot come from the UI', () => {
    expect(RunRequestSchema.safeParse({ url: 'http://x.test', jwt: 'eyJabc.def.ghi' }).success).toBe(false);
    expect(RunRequestSchema.safeParse({ url: 'http://x.test', authorization: 'Bearer x' }).success).toBe(false);
  });
  it('rejects non-http urls', () => {
    expect(RunRequestSchema.safeParse({ url: 'file:///etc/passwd' }).success).toBe(false);
    expect(RunRequestSchema.safeParse({ url: 'javascript:alert(1)' }).success).toBe(false);
  });
});
