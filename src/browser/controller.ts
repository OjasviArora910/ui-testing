import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { Redactor } from '../shared/redactor.js';
import type { AuthConfig, BoundingBox, Viewport } from '../shared/types.js';
import { applyAuth } from './auth.js';
import { EventCollector } from './collectors.js';
import { COLLECT_ROW_CANDIDATES_SCRIPT } from './entryEvidence.js';
import { COLLECT_ELEMENTS_SCRIPT, COLLECT_STRUCTURE_SCRIPT } from './inpage.js';
import type { ActionResult, ElementInfo, ElementTarget, RawStructure, RequestPhase, RowCandidate } from './types.js';

export interface BrowserControllerOptions {
  baseUrl: string;
  viewport?: Viewport;
  auth?: Partial<AuthConfig>;
  redactor?: Redactor;
  ignoredEndpoints?: string[];
  actionTimeoutMs?: number;
  navigationTimeoutMs?: number;
  /** Path to a Chromium binary. Falls back to QA_CHROMIUM_PATH, then Playwright's managed browser. */
  executablePath?: string;
  launchArgs?: string[];
  headless?: boolean;
  /**
   * When true, the browser stays on the target origin: navigation, frames, XHR/fetch, websockets and anything else to another
   * origin are aborted. The one exception is static page resources (stylesheet, script, image, font, media) requested with
   * GET, which a page needs in order to render and run and which are routinely served from a CDN on another host.
   */
  blockExternal?: boolean;
  /** Extra origins the page may talk to (for example the application's own API host). Write methods stay blocked by the request guard. */
  allowedOrigins?: string[];
  trace?: boolean;
}

const DEFAULT_VIEWPORT: Viewport = { name: 'desktop', width: 1440, height: 900 };

export class BrowserController {
  readonly redactor: Redactor;
  readonly events: EventCollector;
  private browser!: Browser;
  private context!: BrowserContext;
  private _page!: Page;
  private _viewport: Viewport;
  private tracing = false;
  private requestGuard: ((req: { method: string; url: string }) => boolean | string) | null = null;
  private lastStatus: number | undefined;
  /** Requests aborted by the request guard (method + redacted url). They are not application failures. */
  readonly blockedRequests: { method: string; url: string; at: number; phase: RequestPhase; reason: string }[] = [];
  /** Native alert/confirm/prompt dialogs the page opened (dismissed automatically). Opening one is an observable result of an action. */
  readonly jsDialogs: { type: string; message: string }[] = [];
  /** Popup windows/tabs the page opened (closed automatically; the run stays on the page under test). */
  readonly popups: { url: string }[] = [];

  private constructor(private opts: BrowserControllerOptions) {
    this.redactor = opts.redactor ?? new Redactor();
    this.events = new EventCollector(this.redactor, opts.ignoredEndpoints ?? []);
    this._viewport = opts.viewport ?? DEFAULT_VIEWPORT;
  }

  static async launch(opts: BrowserControllerOptions): Promise<BrowserController> {
    const c = new BrowserController(opts);
    await c.init();
    return c;
  }

  private async init(): Promise<void> {
    const executablePath = this.opts.executablePath ?? process.env.QA_CHROMIUM_PATH ?? undefined;
    this.browser = await chromium.launch({ headless: this.opts.headless ?? true, executablePath, args: this.opts.launchArgs });
    this.context = await this.browser.newContext({ viewport: { width: this._viewport.width, height: this._viewport.height } });
    this.context.setDefaultTimeout(this.opts.actionTimeoutMs ?? 8000);
    this.context.setDefaultNavigationTimeout(this.opts.navigationTimeoutMs ?? 30000);
    await applyAuth(this.context, this.opts.baseUrl, this.opts.auth, this.redactor);
    if (this.opts.blockExternal) {
      const origin = new URL(this.opts.baseUrl).origin;
      const allowed = new Set([origin, ...(this.opts.allowedOrigins ?? []).map((o) => { try { return new URL(o).origin; } catch { return o; } })]);
      const STATIC = new Set(['stylesheet', 'script', 'image', 'font', 'media']);
      await this.context.route('**/*', (route) => {
        const req = route.request(); const u = req.url();
        if (u.startsWith('data:') || u.startsWith('blob:')) return route.fallback();
        let target = ''; try { target = new URL(u).origin; } catch { /* unparsable: treated as external */ }
        if (allowed.has(target)) return route.fallback();
        // another host: only the files a page is built from, and only by reading them
        if (STATIC.has(req.resourceType()) && req.method() === 'GET') return route.fallback();
        this.events.markBlocked(req, 'external-host', `another host (${target || 'unknown'}) is not on the allowed list; only static files are loaded from other hosts`);
        return route.abort('blockedbyclient');
      });
    }
    // Registered AFTER auth/external routes so it runs first (Playwright evaluates routes newest-first) and falls back to them.
    await this.context.route('**/*', (route) => {
      const req = route.request();
      const verdict = this.requestGuard ? this.requestGuard({ method: req.method(), url: req.url() }) : true;
      if (verdict !== true) {
        const reason = typeof verdict === 'string' ? verdict : 'safety guard: request not allowed';
        this.blockedRequests.push({ method: req.method(), url: this.redactor.redactUrl(req.url()), at: Date.now(), phase: this.events.phase, reason });
        this.events.markBlocked(req, 'safety-guard', reason);
        return route.abort('blockedbyclient');
      }
      return route.fallback();
    });
    if (this.opts.trace) { await this.context.tracing.start({ screenshots: true, snapshots: true }); this.tracing = true; }
    this._page = await this.context.newPage();
    this.wire(this._page);
    this.context.on('page', (p) => {
      if (p === this._page || this.openingTab) return;
      this.popups.push({ url: this.redactor.redactUrl(p.url()) });
      void p.close().catch(() => undefined);
    });
  }

  private openingTab = false;
  private wire(page: Page): void {
    this.events.attach(page);
    page.on('dialog', (d) => {
      this.jsDialogs.push({ type: d.type(), message: this.redactor.redact(d.message()).slice(0, 200) });
      void (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => undefined);
    });
  }

  /** True when the tab no longer answers at all (a script is spinning, or it is blocked in a dialog or unload handler). */
  private async tabIsHung(): Promise<boolean> {
    const alive = await Promise.race([
      this._page.evaluate('1').then(() => true, () => false),
      new Promise<boolean>((r) => setTimeout(() => r(false), 2500)),
    ]);
    return !alive;
  }

  /**
   * Replaces a hung tab with a fresh one in the SAME context, so cookies and storage (the logged-in session) are kept.
   * The old tab is closed without waiting, because a hung tab may never confirm.
   */
  private async freshTab(): Promise<void> {
    const old = this._page;
    // Close the hung tab FIRST and give the browser a moment to tear it down: a new tab for the same site shares its
    // process, and would be stuck behind it otherwise. The wait is bounded because a hung tab may never confirm.
    await Promise.race([old.close().catch(() => undefined), new Promise((r) => setTimeout(r, 4000))]);
    this.openingTab = true;
    try {
      const page = await this.context.newPage();
      await page.setViewportSize({ width: this._viewport.width, height: this._viewport.height }).catch(() => undefined);
      this.wire(page);
      this._page = page;
    } finally { this.openingTab = false; }
  }

  get page(): Page { return this._page; }
  get currentViewport(): Viewport { return this._viewport; }
  get viewport(): Viewport { return this._viewport; }
  get url(): string { return this.redactor.redactUrl(this._page.url()); }

  /** Install (or clear with null) a predicate; requests for which it returns false are aborted before leaving the browser. */
  setRequestGuard(fn: ((req: { method: string; url: string }) => boolean | string) | null): void { this.requestGuard = fn; }

  async setViewport(v: Viewport): Promise<void> {
    this._viewport = v;
    await this._page.setViewportSize({ width: v.width, height: v.height });
  }

  // ---------- semantic locator resolution ----------
  /** Resolves the target by priority: role+name > label > text > testId > attribute > css. */
  locate(t: ElementTarget): Locator {
    const p = this._page;
    let loc: Locator;
    if (t.role) loc = p.getByRole(t.role as Parameters<Page['getByRole']>[0], t.name ? { name: t.name } : undefined);
    else if (t.label) loc = p.getByLabel(t.label);
    else if (t.text) loc = p.getByText(t.text);
    else if (t.testId) loc = p.getByTestId(t.testId);
    else if (t.attr?.name === 'placeholder') loc = p.getByPlaceholder(t.attr.value);
    else if (t.attr?.name === 'title') loc = p.getByTitle(t.attr.value);
    else if (t.attr?.name === 'alt') loc = p.getByAltText(t.attr.value);
    else if (t.css) loc = p.locator(t.css);
    else throw new Error('ElementTarget requires at least one selector strategy');
    return loc.nth(t.nth ?? 0);
  }

  // ---------- actions ----------
  private async act(fn: () => Promise<unknown>): Promise<ActionResult> {
    const t0 = Date.now(); const urlBefore = this.url;
    const n0 = this.events.network.length; const c0 = this.events.errors().length;
    let ok = true; let error: string | undefined; let status: number | undefined;
    try {
      const r = await fn();
      if (r && typeof r === 'object' && 'status' in r && typeof (r as { status: unknown }).status === 'function') status = (r as { status(): number }).status();
    } catch (e) { ok = false; error = this.redactor.redact(e instanceof Error ? e.message.split('\n')[0]! : String(e)); }
    this.lastStatus = status;
    const partial = this.partialLoad; this.partialLoad = false;
    return {
      ok, error, status, ...(partial && ok ? { partial } : {}), durationMs: Date.now() - t0, urlBefore, urlAfter: this.url,
      newNetworkEvents: this.events.network.length - n0, newConsoleErrors: this.events.errors().length - c0,
    };
  }

  private partialLoad = false;
  private navStartedAt = 0;
  private navStartIndex = 0;
  /**
   * The DATA requests this page makes whenever it loads, learned from its first load: signature (method + endpoint) and how
   * many milliseconds after the navigation each one started. Requests that turn out not to repeat are removed.
   */
  pageLoadProfile: Map<string, number> | null = null;

  /** From now on, new requests are caused by what the tester does, not by the page loading. */
  beginAction(): void { this.events.phase = 'action'; }

  /**
   * Waits until the page has finished LOADING ITS DATA, not just its document, so that a late page-load request is not
   * mistaken for the result of the next click.
   *  - `learn` (the FIRST load of a page): the pattern is unknown, so wait for a long quiet period; applications often fetch
   *    their data a moment after the document.
   *  - otherwise (every reload): wait only for the data requests the page is known to repeat, then a short quiet period.
   *    A known request that has not come back by the time it was due is a one-time request (made once per session): it is
   *    dropped from the pattern, so it is waited for at most once and never again.
   * Always bounded by maxMs.
   */
  async waitForPageLoad(opts: { learn?: boolean; maxMs?: number } = {}): Promise<void> {
    const deadline = Date.now() + (opts.maxMs ?? 6000);
    const profile = opts.learn ? null : this.pageLoadProfile;
    // by when the slowest known load request should have started again (generous, but bounded)
    const dueBy = profile && profile.size > 0 ? this.navStartedAt + Math.max(...profile.values()) * 1.5 + 600 : 0;
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      const now = Date.now();
      if (this.events.inflight() > 0) quietSince = now;
      const quiet = now - quietSince;
      if (opts.learn) {
        if (quiet >= 1500) return;
      } else if (!profile || profile.size === 0) {
        if (quiet >= 150) return;
      } else {
        const seen = new Set(this.events.started.slice(this.navStartIndex).map((r) => r.signature));
        const missing = [...profile.keys()].filter((sig) => !seen.has(sig));
        if (missing.length === 0) { if (quiet >= 200) return; }
        else if (now >= dueBy && quiet >= 200) { for (const sig of missing) profile.delete(sig); return; }
      }
      await this._page.waitForTimeout(40).catch(() => undefined);
    }
  }

  /**
   * Staged navigation, so one slow or hanging resource cannot make a reachable page "unreachable":
   *  1. wait for the server's response (commit). No response within the navigation timeout => genuinely unreachable.
   *  2. wait for `load` for the rest of that same timeout.
   *  3. if `load` did not arrive, proceed anyway when the document is usable (parsed, has a body). A document that is still
   *     being parsed gets one bounded grace period (half the timeout) because a response proves the page is reachable.
   * A page accepted in step 3 is flagged `partial` so callers can say that some resources never finished loading.
   */
  private async gotoUsable(go: (waitUntil: 'commit') => Promise<unknown>): Promise<unknown> {
    const budget = this.opts.navigationTimeoutMs ?? 30000;
    const t0 = Date.now();
    this.partialLoad = false;
    const response = await go('commit');
    try {
      await this._page.waitForLoadState('load', { timeout: Math.max(1000, budget - (Date.now() - t0)) });
      return response;
    } catch { /* still loading: decide below whether the page is usable */ }
    const parsed = (): Promise<boolean> => this._page.evaluate("document.readyState !== 'loading' && !!document.body").then(Boolean).catch(() => false);
    if (!(await parsed())) {
      await this._page.waitForLoadState('domcontentloaded', { timeout: Math.ceil(budget / 2) }).catch(() => undefined);
      // parser still blocked: accept only a document that already has rendered content
      const hasContent = await this._page.evaluate("!!document.body && document.body.children.length > 0").then(Boolean).catch(() => false);
      if (!(await parsed()) && !hasContent) {
        throw new Error(`Page responded but its document never became usable within ${Math.round((Date.now() - t0) / 1000)}s (a resource in the page head is still loading)`);
      }
    }
    this.partialLoad = true;
    return response;
  }

  private loadMark = 0;
  /** Index into events.console at which the current document started loading: what follows was logged by this page load. */
  get consoleIndexAtLoad(): number { return this.loadMark; }

  navigate(url: string): Promise<ActionResult> {
    const abs = new URL(url, this.opts.baseUrl).toString();
    return this.act(async () => {
      this.events.phase = 'page-load'; this.navStartedAt = Date.now(); this.navStartIndex = this.events.started.length;
      this.loadMark = this.events.console.length;
      // Going to a URL that differs from the current one only by its fragment (or not at all) does not load anything:
      // the browser just changes the hash. To really open that view from scratch, leave the page first. Leaving through a
      // blank page also works when the current page is hung or still loading, where reload or script evaluation would stall.
      const strip = (x: string): string => x.replace(/#.*$/, '');
      if (abs.includes('#') && strip(this._page.url()) === strip(abs)) {
        await this._page.goto('about:blank', { waitUntil: 'commit', timeout: 5000 }).catch(() => undefined);
      }
      try {
        return await this.gotoUsable((waitUntil) => this._page.goto(abs, { waitUntil }));
      } catch (e) {
        // A navigation that cannot even start is usually not the server: the tab itself is stuck. One hung page must not
        // make every following page "unreachable", so open the URL in a fresh tab of the same session, once.
        if (!/Timeout/i.test(e instanceof Error ? e.message : String(e)) || !(await this.tabIsHung())) throw e;
        await this.freshTab();
        return this.gotoUsable((waitUntil) => this._page.goto(abs, { waitUntil }));
      }
    });
  }
  /** `force` skips Playwright's actionability wait; only for an element already verified to be visible, enabled and on top. */
  click(t: ElementTarget, opts: { force?: boolean } = {}): Promise<ActionResult> { return this.act(() => this.locate(t).click(opts.force ? { force: true } : undefined)); }
  fill(t: ElementTarget, value: string): Promise<ActionResult> { return this.act(() => this.locate(t).fill(value)); }
  select(t: ElementTarget, value: string | string[]): Promise<ActionResult> { return this.act(() => this.locate(t).selectOption(value)); }
  check(t: ElementTarget): Promise<ActionResult> { return this.act(() => this.locate(t).check()); }
  uncheck(t: ElementTarget): Promise<ActionResult> { return this.act(() => this.locate(t).uncheck()); }
  hover(t: ElementTarget): Promise<ActionResult> { return this.act(() => this.locate(t).hover()); }
  press(key: string, t?: ElementTarget): Promise<ActionResult> {
    return this.act(() => (t ? this.locate(t).press(key) : this._page.keyboard.press(key)));
  }
  scroll(opts: { to?: 'top' | 'bottom'; by?: number; target?: ElementTarget } = {}): Promise<ActionResult> {
    return this.act(async () => {
      if (opts.target) return this.locate(opts.target).scrollIntoViewIfNeeded();
      await this._page.evaluate(`((o) => {
        if (o.to === 'top') window.scrollTo(0, 0);
        else if (o.to === 'bottom') window.scrollTo(0, document.documentElement.scrollHeight);
        else window.scrollBy(0, o.by ?? window.innerHeight * 0.8);
      })(${JSON.stringify({ to: opts.to, by: opts.by })})`);
    });
  }
  reload(): Promise<ActionResult> { return this.act(() => { this.loadMark = this.events.console.length; return this.gotoUsable((waitUntil) => this._page.reload({ waitUntil })); }); }
  back(): Promise<ActionResult> { return this.act(() => this._page.goBack({ waitUntil: 'load' })); }
  forward(): Promise<ActionResult> { return this.act(() => this._page.goForward({ waitUntil: 'load' })); }
  /** Waits (at most maxMs) until no request has been in flight for 150ms. Used before snapshotting network activity. */
  async waitForIdle(maxMs: number): Promise<void> {
    const deadline = Date.now() + maxMs;
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      if (this.events.inflight() > 0) quietSince = Date.now();
      else if (Date.now() - quietSince >= 150) return;
      await this._page.waitForTimeout(25);
    }
  }

  /** Waits until no requests are in flight for a short quiet period (bounded by ms*5). Cheaper than Playwright's networkidle (500ms). */
  async settle(ms = 400): Promise<void> {
    const deadline = Date.now() + ms * 5;
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      if (this.events.inflight() > 0) quietSince = Date.now();
      else if (Date.now() - quietSince >= Math.min(ms, 120)) return;
      await this._page.waitForTimeout(20);
    }
  }

  // ---------- inspection ----------
  async screenshot(opts: { fullPage?: boolean; target?: ElementTarget; path?: string; mask?: string[] } = {}): Promise<Buffer> {
    const mask = (opts.mask ?? []).map((s) => this._page.locator(s));
    if (opts.target) return this.locate(opts.target).screenshot({ path: opts.path, mask, animations: 'disabled', caret: 'hide' });
    return this._page.screenshot({ fullPage: opts.fullPage ?? false, path: opts.path, mask, animations: 'disabled', caret: 'hide' });
  }
  /** Raw DOM, redacted. */
  async dom(): Promise<string> { return this.redactor.redact(await this._page.content()); }
  /** ARIA tree (YAML), redacted. */
  async aria(target?: ElementTarget): Promise<string> {
    const loc = target ? this.locate(target) : this._page.locator('body');
    return this.redactor.redact(await loc.ariaSnapshot());
  }
  private async collect(mode: 'all' | 'visible' | 'interactive'): Promise<ElementInfo[]> {
    const raw = await this._page.evaluate(`(${COLLECT_ELEMENTS_SCRIPT})(${JSON.stringify(mode)})`) as ElementInfo[];
    return raw.map((e) => ({ ...e, name: this.redactor.redact(e.name), text: this.redactor.redact(e.text), href: e.href ? this.redactor.redactUrl(new URL(e.href, this._page.url()).toString()) : e.href }));
  }
  /** Forms/fields, images, tables, headings, dialogs, menus, tabs, accordions, links (redacted). */
  async structure(): Promise<RawStructure> {
    const raw = await this._page.evaluate(`(${COLLECT_STRUCTURE_SCRIPT})()`) as RawStructure;
    return this.redactor.redactDeep(raw);
  }
  get lastNavigationStatus(): number | undefined { return this.lastStatus; }
  /** Clickable-looking elements in the first rows of each table, with the evidence found and the decision taken (diagnostic record). */
  async rowCandidates(): Promise<RowCandidate[]> {
    const raw = await this._page.evaluate(`(${COLLECT_ROW_CANDIDATES_SCRIPT})()`).catch(() => []) as RowCandidate[];
    return this.redactor.redactDeep(raw);
  }
  allElements(): Promise<ElementInfo[]> { return this.collect('all'); }
  visibleElements(): Promise<ElementInfo[]> { return this.collect('visible'); }
  interactiveElements(): Promise<ElementInfo[]> { return this.collect('interactive'); }

  async boundingBox(t: ElementTarget): Promise<BoundingBox | null> { return this.locate(t).boundingBox(); }
  async computedStyles(t: ElementTarget, props: string[]): Promise<Record<string, string>> {
    return this.locate(t).evaluate((el, ps) => {
      const cs = getComputedStyle(el); const out: Record<string, string> = {};
      for (const p of ps) out[p] = cs.getPropertyValue(p);
      return out;
    }, props);
  }
  async pageMetrics(): Promise<{ scrollWidth: number; clientWidth: number; scrollHeight: number; viewportHeight: number; title: string }> {
    return this._page.evaluate(`({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight, viewportHeight: window.innerHeight, title: document.title })`) as never;
  }

  // ---------- lifecycle ----------
  async stopTrace(path: string): Promise<boolean> {
    if (!this.tracing) return false;
    await this.context.tracing.stop({ path }); this.tracing = false; return true;
  }
  async close(): Promise<void> {
    if (this.tracing) await this.context.tracing.stop().catch(() => undefined);
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }
}
