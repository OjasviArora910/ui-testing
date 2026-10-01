import type { ConsoleMessage, Page, Request, Response } from 'playwright';
import type { Redactor } from '../shared/redactor.js';
import type { ConsoleEvent, NetworkEvent } from './types.js';

/** Collects network + console + page errors. All strings are redacted at capture time, before anything can persist them. */
export class EventCollector {
  readonly network: NetworkEvent[] = [];
  readonly console: ConsoleEvent[] = [];
  private pending = new Map<Request, { id: number; started: number }>();
  private seq = 0;

  constructor(private redactor: Redactor, private ignoredEndpoints: string[] = []) {}

  attach(page: Page): void {
    page.on('request', (r) => this.pending.set(r, { id: ++this.seq, started: Date.now() }));
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
    const meta = this.pending.get(req) ?? { id: ++this.seq, started: Date.now() };
    this.pending.delete(req);
    const url = this.redactor.redactUrl(req.url());
    return {
      id: meta.id, url, method: req.method(), resourceType: req.resourceType(), startedAt: meta.started,
      durationMs: Date.now() - meta.started, pageUrl: this.redactor.redactUrl(page.url()), ignored: this.isIgnored(req.url()),
    };
  }

  private onResponse(page: Page, res: Response): void {
    const status = res.status();
    this.network.push({ ...this.base(page, res.request()), status, ok: status < 400 });
  }

  private onFailed(page: Page, req: Request): void {
    const base = this.base(page, req);
    const failure = this.redactor.redact(req.failure()?.errorText ?? 'unknown failure');
    // Requests aborted by OUR guard / external blocking are not application failures.
    const byUs = /BLOCKED_BY_CLIENT/i.test(failure);
    // ERR_ABORTED = request cancelled because the page navigated away (or the app aborted it): not a server failure.
    const cancelled = /ERR_ABORTED/i.test(failure);
    this.network.push({ ...base, status: null, ok: false, failure, ignored: base.ignored || byUs || cancelled, blockedByGuard: byUs });
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
