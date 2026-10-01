/** Central secret redactor. Every string that is persisted, logged, reported or sent to AI passes through here. */
export const REDACTED = '[REDACTED]';

const SENSITIVE_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token', 'x-csrf-token',
]);
const SENSITIVE_QUERY_KEYS = /^(token|access_token|id_token|refresh_token|jwt|auth|authorization|api[_-]?key|apikey|key|secret|password|passwd|pwd|sig|signature|session|sessionid|code)$/i;
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KEY_PATTERNS = [/\bsk-[A-Za-z0-9_-]{16,}/g, /\bAIza[0-9A-Za-z_-]{20,}/g, /\bgsk_[A-Za-z0-9]{16,}/g];

export class Redactor {
  private secrets = new Set<string>();

  /** Register a literal secret (JWT, API key...). Short values are rejected to avoid mangling normal text. */
  register(secret: string | undefined | null): void {
    if (!secret) return;
    const s = secret.trim();
    if (s.length < 6) return;
    this.secrets.add(s);
    this.secrets.add(encodeURIComponent(s));
    if (/^bearer\s+/i.test(s)) this.secrets.add(s.replace(/^bearer\s+/i, ''));
  }

  get registeredCount(): number { return this.secrets.size; }

  redact(input: string): string {
    if (!input) return input;
    let out = input;
    // longest first so composite values are replaced before their parts
    for (const s of [...this.secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join(REDACTED);
    out = out.replace(JWT_PATTERN, REDACTED).replace(BEARER_PATTERN, (_m, scheme: string) => `${scheme} ${REDACTED}`);
    for (const p of KEY_PATTERNS) out = out.replace(p, REDACTED);
    return out;
  }

  /** Redacts secrets in query strings, fragments and userinfo. Never throws. */
  redactUrl(url: string): string {
    try {
      const u = new URL(url);
      if (u.username) u.username = 'redacted';
      if (u.password) u.password = 'redacted';
      for (const k of [...u.searchParams.keys()]) {
        if (SENSITIVE_QUERY_KEYS.test(k)) u.searchParams.set(k, REDACTED);
      }
      if (u.hash && /(token|access_token|id_token|jwt|key)=/i.test(u.hash)) u.hash = `#${REDACTED}`;
      return this.redact(decodeURIComponent(u.toString()));
    } catch {
      return this.redact(url);
    }
  }

  redactHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? REDACTED : this.redact(v);
    }
    return out;
  }

  /** Deep-redacts any JSON-like value (keys named like sensitive headers are masked entirely). */
  redactDeep<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v)) as unknown as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? REDACTED : this.redactDeep(v);
      }
      return out as T;
    }
    return value;
  }
}
