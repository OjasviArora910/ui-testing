import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, ConfigSchema } from '../src/shared/config.js';
import { AuthProfileResolver } from '../src/shared/authProfiles.js';
import { directAuthToConfig, RunRequestSchema, toPersisted } from '../src/shared/runRequest.js';

describe('config', () => {
  it('shipped qa.config.json validates and equals the schema defaults for core limits', () => {
    const c = loadConfig('qa.config.json');
    expect(c.maxPages).toBe(100); // limits are safety bounds, not coverage targets
    expect(c.accessibility.enabled).toBe(false); // out of scope for normal UI/UX runs
    expect(c.dynamic.consistencyChecks).toBe(false);
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
  it('rejects a top-level jwt (or any unknown field): tokens are only accepted inside `auth`', () => {
    expect(RunRequestSchema.safeParse({ url: 'http://x.test', jwt: 'eyJabc.def.ghi' }).success).toBe(false);
    expect(RunRequestSchema.safeParse({ url: 'http://x.test', authorization: 'Bearer x' }).success).toBe(false);
  });
  it('accepts a one-time token inside `auth`, and the persisted form never contains it', () => {
    const r = RunRequestSchema.parse({ url: 'http://x.test', auth: { token: ' eyJabc.def.ghi ', location: 'header' } });
    expect(r.auth?.token).toBe('eyJabc.def.ghi');
    const p = toPersisted(r);
    expect(JSON.stringify(p)).not.toContain('eyJabc');
    expect(p).toMatchObject({ authSource: 'token', authLocation: 'header' });
    expect(toPersisted(RunRequestSchema.parse({ url: 'http://x.test' })).authSource).toBe('none');
    expect(directAuthToConfig(r.auth!)).toEqual({ jwt: 'eyJabc.def.ghi', location: 'header', key: undefined, scheme: 'Bearer' });
  });
  it('rejects token + profile together, bad locations and unknown auth fields', () => {
    expect(RunRequestSchema.safeParse({ url: 'http://x.test', authProfile: 'a', auth: { token: 't', location: 'cookie' } }).success).toBe(false);
    expect(RunRequestSchema.safeParse({ url: 'http://x.test', auth: { token: 't', location: 'url' } }).success).toBe(false);
    expect(RunRequestSchema.safeParse({ url: 'http://x.test', auth: { token: 't', location: 'cookie', extra: 1 } }).success).toBe(false);
    expect(RunRequestSchema.safeParse({ url: 'http://x.test', auth: { token: '   ', location: 'cookie' } }).success).toBe(false);
  });
  it('rejects non-http urls', () => {
    expect(RunRequestSchema.safeParse({ url: 'file:///etc/passwd' }).success).toBe(false);
    expect(RunRequestSchema.safeParse({ url: 'javascript:alert(1)' }).success).toBe(false);
  });
});
