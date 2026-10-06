import type { ConsoleMessage, Page, Request, Response } from 'playwright';
import type { Redactor } from '../shared/redactor.js';
import type { ConsoleEvent, NetworkEvent, RequestPhase } from './types.js';

const AUTH_HEADER = /^(authorization|proxy-authorization|x-requested-with|x-.*(auth|token|key|csrf|xsrf|session).*)$/i;
const STATIC_TYPES = new Set(['stylesheet', 'script', 'image', 'font', 'media']);
const MAX_BODY_BYTES = 1_500_000;

/** Does a parsed API body carry any data? Looks at the body and one level into it; the content itself is never kept. */
export function bodyShape(value: unknown): { body: 'data' | 'empty'; items?: number } {
  if (value === null || value === undefined || value === '') return { body: 'empty' };
  if (Array.isArray(value)) return { body: value.length ? 'data' : 'empty', items: value.length };
  if (typeof value !== 'object') return { body: 'data' };
  const fields = Object.values(value as Record<string, unknown>);
  if (fields.length === 0) return { body: 'empty' };
  const lists = fields.filter(Array.isArray) as unknown[][];
  // an envelope such as { data: [], total: 0 } is empty; one with any filled list, or with no lists at all, has data
  if (lists.length > 0) { const n = Math.max(...lists.map((l) => l.length)); return { body: n > 0 ? 'data' : 'empty', items: n }; }
  const nested = fields.filter((f) => f !== null && typeof f === 'object') as Record<string, unknown>[];
  const inner = nested.flatMap((o) => Object.values(o).filter(Array.isArray) as unknown[][]);
  if (inner.length > 0) { const n = Math.max(...inner.map((l) => l.length)); return { body: n > 0 ? 'data' : 'empty', items: n }; }
  return { body: 'data' };
}

/** Collects network + console + page errors. All strings are redacted at capture time, before anything can persist them. */
export class EventCollector {
  readonly network: NetworkEvent[] = [];
  readonly console: ConsoleEvent[] = [];
  private pending = new Map<Request, { id: number; started: number; phase: RequestPhase; auth?: NetworkEvent['auth'] }>();
  private seq = 0;
  /** What new requests belong to right now. The controller switches it: page-load on navigation, action when a test acts. */
  phase: RequestPhase = 'page-load';
  /** Every request as it STARTS (finished or not), so a page load can be recognised as complete. */
  readonly started: { signature: string; at: number; phase: RequestPhase }[] = [];
  private work = new Set<Promise<unknown>>();
  private track(p: Promise<unknown>): void { this.work.add(p); void p.finally(() => this.work.delete(p)); }
  /** Waits (bounded) for the credential-name lookups and response-shape reads still in progress. */
  async flush(maxMs = 2000): Promise<void> { await Promise.race([Promise.allSettled([...this.work]), new Promise((r) => setTimeout(r, maxMs))]); }
  private blocked = new WeakMap<Request, { by: NonNullable<NetworkEvent['blockedBy']>; reason: string }>();

  /** Called by the platform's own blockers just before they abort a request, so the reason is on record. */
  markBlocked(req: Request, by: NonNullable<NetworkEvent['blockedBy']>, reason: string): void { this.blocked.set(req, { by, reason }); }

  static signature(method: string, url: string): string { try { const u = new URL(url); return `${method} ${u.origin}${u.pathname}`; } catch { return `${method} ${url}`; } }

  constructor(private redactor: Redactor, private ignoredEndpoints: string[] = []) {}

  attach(page: Page): void {
    page.on('request', (r) => {
      const meta: { id: number; started: number; phase: RequestPhase; auth?: NetworkEvent['auth'] } = { id: ++this.seq, started: Date.now(), phase: this.phase };
      this.pending.set(r, meta);
      this.started.push({ signature: EventCollector.signature(r.method(), r.url()), at: meta.started, phase: meta.phase });
      if (STATIC_TYPES.has(r.resourceType())) return;
      // Names only: which cookies the browser holds for this URL, and which auth-like headers the page set itself.
      const headerNames = Object.keys(r.headers()).filter((h) => AUTH_HEADER.test(h));
      meta.auth = { cookieNames: [], headerNames };
      this.track(page.context().cookies(r.url()).then((cs) => { meta.auth!.cookieNames = [...new Set(cs.map((c) => c.name))].sort(); }).catch(() => undefined));
    });
    // A browser abandons the requests of a document it leaves and reports nothing more about them, so they would count as
    // "in flight" for ever. When the main frame loads a NEW document (a document request came first; a hash or history
    // change within the same document has none), forget what the previous document still had pending.
    let documentRequested = false;
    const isMainDocument = (r: Request): boolean => { try { return r.isNavigationRequest() && r.frame() === page.mainFrame(); } catch { return false; } };
    page.on('request', (r) => { if (isMainDocument(r)) documentRequested = true; });
    page.on('framenavigated', (f) => {
      if (f !== page.mainFrame() || !documentRequested) return;
      documentRequested = false;
      for (const req of [...this.pending.keys()]) if (!isMainDocument(req)) this.pending.delete(req);
    });
    page.on('response', (r) => this.onResponse(page, r));
    page.on('requestfailed', (r) => this.onFailed(page, r));
    page.on('console', (m) => this.onConsole(page, m));
    page.on('pageerror', (e) => this.console.push({
      kind: 'pageerror', level: 'error', text: this.redactor.redact(`${e.name}: ${e.message}`), pageUrl: this.redactor.redactUrl(page.url()), at: Date.now(),
    }));
  }

  private isIgnored(url: string): boolean {
    return this.ignoredEndpoints.some((p) => {
      try { return new RegExp(p).test(url); } catch { return url.includes(p); }
    });
  }

  private base(page: Page, req: Request) {
    const meta = this.pending.get(req) ?? { id: ++this.seq, started: Date.now(), phase: this.phase };
    this.pending.delete(req);
    const url = this.redactor.redactUrl(req.url());
    return {
      id: meta.id, url, method: req.method(), resourceType: req.resourceType(), startedAt: meta.started,
      durationMs: Date.now() - meta.started, pageUrl: this.redactor.redactUrl(page.url()), ignored: this.isIgnored(req.url()),
      phase: meta.phase, ...(meta.auth ? { auth: meta.auth } : {}),
    };
  }

  private onResponse(page: Page, res: Response): void {
    const status = res.status();
    const ev: NetworkEvent = { ...this.base(page, res.request()), status, ok: status < 400 };
    this.network.push(ev);
    // For API calls, note whether the answer contained anything. Only the shape is kept, never the content.
    if (ev.resourceType === 'xhr' || ev.resourceType === 'fetch') {
      const contentType = (res.headers()['content-type'] ?? '').split(';')[0]!.trim();
      ev.response = { contentType, body: 'unknown' };
      this.track(res.body().then((buf) => {
        ev.response = { contentType, bytes: buf.length, body: 'unknown' };
        if (buf.length === 0) { ev.response.body = 'empty'; return; }
        if (buf.length > MAX_BODY_BYTES || !/json/i.test(contentType)) { ev.response.body = buf.length > 0 ? 'data' : 'empty'; return; }
        try { Object.assign(ev.response, bodyShape(JSON.parse(buf.toString('utf8')))); } catch { ev.response.body = 'data'; }
      }).catch(() => undefined));
    }
  }

  private onFailed(page: Page, req: Request): void {
    const base = this.base(page, req);
    const failure = this.redactor.redact(req.failure()?.errorText ?? 'unknown failure');
    // Requests aborted by OUR guard / external blocking are not application failures.
    const byUs = /BLOCKED_BY_CLIENT/i.test(failure);
    // ERR_ABORTED = request cancelled because the page navigated away (or the app aborted it): not a server failure.
    const cancelled = /ERR_ABORTED/i.test(failure);
    const why = this.blocked.get(req);
    this.network.push({ ...base, status: null, ok: false, failure, ignored: base.ignored || byUs || cancelled, blockedByGuard: byUs, ...(why ? { blockedBy: why.by, blockReason: why.reason } : {}) });
  }

  private onConsole(page: Page, m: ConsoleMessage): void {
    const t = m.type();
    const level = t === 'error' ? 'error' : t === 'warning' ? 'warning' : t === 'info' ? 'info' : t === 'debug' ? 'debug' : 'log';
    const loc = m.location();
    this.console.push({
      kind: 'console', level, text: this.redactor.redact(m.text()), at: Date.now(), pageUrl: this.redactor.redactUrl(page.url()),
      location: loc.url ? `${this.redactor.redactUrl(loc.url)}:${loc.lineNumber}` : undefined,
    });
  }

  /** Requests started but not yet answered. */
  inflight(): number { return this.pending.size; }

  /** Failed network events that are not ignored: 4xx/5xx/transport errors. */
  failures(): NetworkEvent[] { return this.network.filter((n) => !n.ok && !n.ignored); }
  errors(): ConsoleEvent[] { return this.console.filter((c) => c.level === 'error'); }
}
