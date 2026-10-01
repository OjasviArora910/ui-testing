import { describe, expect, it } from 'vitest';
import { Redactor, REDACTED } from '../src/shared/redactor.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123_-sig';

describe('Redactor', () => {
  it('redacts registered secrets and JWT-shaped tokens', () => {
    const r = new Redactor(); r.register('my-super-secret-value');
    expect(r.redact('x my-super-secret-value y')).toBe(`x ${REDACTED} y`);
    expect(r.redact(`token=${JWT}`)).not.toContain('eyJ');
  });
  it('redacts Bearer values and URL-encoded variants', () => {
    const r = new Redactor(); r.register('abc/def+ghi==jkl');
    expect(r.redact('Bearer abcdefghijklmnop')).toBe(`Bearer ${REDACTED}`);
    expect(r.redact(encodeURIComponent('abc/def+ghi==jkl'))).toBe(REDACTED);
  });
  it('redacts sensitive query params and userinfo in URLs', () => {
    const r = new Redactor();
    const out = r.redactUrl('https://user:pw@example.com/a?token=zzz&page=2&api_key=k1#access_token=q');
    expect(out).not.toMatch(/zzz|k1|pw@|=q$/);
    expect(out).toContain('page=2');
  });
  it('masks sensitive headers and deep objects', () => {
    const r = new Redactor();
    expect(r.redactHeaders({ Authorization: 'Bearer abc12345678', Accept: 'a/b' })).toEqual({ Authorization: REDACTED, Accept: 'a/b' });
    expect(r.redactDeep({ a: [{ cookie: 'x', t: JWT }] })).toEqual({ a: [{ cookie: REDACTED, t: REDACTED }] });
  });
  it('ignores too-short secrets to avoid mangling text', () => {
    const r = new Redactor(); r.register('ab');
    expect(r.redact('about')).toBe('about');
  });
});
