import type { BrowserController } from './controller.js';
import { EventCollector } from './collectors.js';
import type { NetworkEvent, RequestPhase } from './types.js';

/**
 * What happened while a page loaded, so "the page shows no data" can be explained instead of guessed at:
 * which requests were made, which succeeded, which were blocked (and by which rule), whether credentials were
 * attached, and whether the answers contained anything. Credential VALUES and response CONTENT are never recorded.
 */
export interface ReadinessRequest {
  method: string;
  /** Redacted URL. */
  url: string;
  /** origin + path, without the query: the identity of the endpoint. */
  endpoint: string;
  type: string;
  status: number | null;
  outcome: 'ok' | 'failed' | 'blocked';
  blockedBy?: NetworkEvent['blockedBy'];
  /** Why it was blocked or failed. */
  reason?: string;
  phase: RequestPhase;
  /** Milliseconds after the navigation started. */
  startedMs: number;
  durationMs: number | null;
  /** Names only. */
  auth?: { cookieNames: string[]; headerNames: string[] };
  response?: NetworkEvent['response'];
  /**
   * required   a data endpoint declared for this application (allow-list): the page's own data
   * auxiliary  anything else that was blocked or failed while the declared page data loaded, or a request to another host
   */
  role?: 'required' | 'auxiliary';
}

/**
 * ready            the page's data requests succeeded
 * partial          the page's REQUIRED data loaded; only auxiliary requests (shell or secondary data, other hosts) were
 *                  blocked or failed. The page content is its real content.
 * data-not-loaded  required page data was blocked, failed or returned nothing usable: what the page shows is not its real content
 * empty            the data requests succeeded and returned nothing: a legitimately empty page
 */
export type ReadinessState = 'ready' | 'partial' | 'data-not-loaded' | 'empty';

export interface PageReadiness {
  url: string;
  capturedAt: string;
  state: ReadinessState;
  /** One sentence a person can act on. */
  summary: string;
  /** Document and API requests (everything that is not a static file), in the order they started. */
  requests: ReadinessRequest[];
  /** Static files (scripts, styles, images, fonts, media). */
  staticFiles: { total: number; loaded: number; failed: number; blocked: number; hosts: string[] };
  /** Names of the cookies the browser holds for this page. Never values. */
  cookieNames: string[];
  /** Names of the keys in the page's storage. Never values. */
  storageKeys: { local: string[]; session: string[] };
  /** "No data"-style messages currently visible on the page. */
  emptyStateText: string[];
  consoleErrors: string[];
}

const STATIC_TYPES = new Set(['stylesheet', 'script', 'image', 'font', 'media']);
const EMPTY_STATE = /\bno (data|results?|records?|items?|content|entries|matches)\b( (found|available|to (show|display)))?|\bnothing (to (show|display)|found|here)\b|\bproblem while retrieving\b|\bfailed to load\b|\bunable to (load|fetch|retrieve)\b/i;

const endpointOf = (url: string): string => { try { const u = new URL(url); return u.origin + u.pathname; } catch { return url; } };
const isData = (n: Pick<NetworkEvent, 'resourceType' | 'method'>): boolean => n.resourceType === 'xhr' || n.resourceType === 'fetch' || !['GET', 'HEAD', 'OPTIONS'].includes(n.method.toUpperCase());

/**
 * Decides the state from the data requests alone. Pure, so it can be tested without a browser.
 *
 * What counts as REQUIRED page data:
 *  - requests to a declared endpoint (`role: 'required'`), when the page made any. They are the source of truth: if they
 *    all succeeded and brought data, the page has its content, and whatever else was blocked or failed is auxiliary.
 *  - with no declared endpoint on the page, every same-application data request is treated as required (nothing says
 *    otherwise); only requests to other hosts, which the platform always blocks, are auxiliary.
 */
export function evaluateReadiness(requests: ReadinessRequest[], emptyStateText: string[]): { state: ReadinessState; summary: string } {
  const data = requests.filter((r) => isData({ resourceType: r.type, method: r.method }));
  const list = (rs: ReadinessRequest[]): string => [...new Set(rs.map((r) => `${r.method} ${(() => { try { return new URL(r.endpoint).pathname; } catch { return r.endpoint; } })()}`))].slice(0, 6).join(', ');
  const bad = (r: ReadinessRequest): boolean => r.outcome === 'blocked' || r.outcome === 'failed';
  const declared = data.filter((r) => r.role === 'required');
  const required = declared.length > 0 ? declared : data.filter((r) => r.blockedBy !== 'external-host');
  const auxiliary = data.filter((r) => !required.includes(r));

  const blocked = required.filter((r) => r.outcome === 'blocked');
  const failed = required.filter((r) => r.outcome === 'failed');
  if (blocked.length > 0 || failed.length > 0) {
    const parts = [
      ...(blocked.length ? [`${blocked.length} data request(s) were blocked by the QA platform (${list(blocked)})`] : []),
      ...(failed.length ? [`${failed.length} data request(s) failed (${list(failed)})`] : []),
    ];
    return {
      state: 'data-not-loaded',
      summary: `Page data did not load: ${parts.join('; ')}. ${emptyStateText.length ? `The page shows "${emptyStateText[0]}", which is a consequence of that, not a UI bug. ` : ''}Results for this page are not reliable until the data loads.`,
    };
  }
  const answered = required.filter((r) => r.response && r.response.body !== 'unknown');
  const allEmpty = answered.length > 0 && answered.every((r) => r.response!.body === 'empty');
  if (declared.length > 0 && allEmpty && auxiliary.some(bad)) {
    // the declared page data came back with nothing while other requests were blocked: it cannot be called loaded
    return { state: 'data-not-loaded', summary: `Page data did not load: the required data request(s) (${list(declared)}) returned no usable data, and ${auxiliary.filter(bad).length} other request(s) were blocked or failed. Results for this page are not reliable.` };
  }
  if (emptyStateText.length > 0 && allEmpty) {
    return { state: 'empty', summary: `The page's ${answered.length} data request(s) succeeded and returned no data, and the page shows "${emptyStateText[0]}": a legitimately empty page.` };
  }
  const aux = auxiliary.filter(bad);
  if (aux.length > 0) {
    const what = declared.length > 0 ? `Required page data loaded (${list(declared)}).` : `The page's ${required.length} own data request(s) succeeded.`;
    return { state: 'partial', summary: `${what} ${aux.length} auxiliary request(s) were blocked or failed and are not this page's content (${list(aux)}); the page content is reliable.` };
  }
  return { state: 'ready', summary: data.length ? `All ${data.length} data request(s) made while the page loaded succeeded.` : 'The page made no data requests while loading.' };
}

/** Builds the report from what the browser recorded since the navigation that opened the page. */
export async function buildReadiness(c: BrowserController, opts: { url: string; networkFrom: number; consoleFrom: number; navStartedAt: number; declared?: string[] }): Promise<PageReadiness> {
  await c.events.flush();
  const events = c.events.network.slice(opts.networkFrom).filter((n) => n.phase !== 'action');
  const declared = new Set(opts.declared ?? []);
  const toRequest = (n: NetworkEvent): ReadinessRequest => {
    const blocked = !!n.blockedByGuard;
    const role = declared.has(EventCollector.signature(n.method, n.url)) ? 'required' as const : n.blockedBy === 'external-host' ? 'auxiliary' as const : undefined;
    const failed = !blocked && !n.ok && !/ERR_ABORTED/i.test(n.failure ?? '');
    return {
      method: n.method, url: n.url, endpoint: endpointOf(n.url), type: n.resourceType, status: n.status,
      outcome: blocked ? 'blocked' : failed ? 'failed' : 'ok',
      ...(n.blockedBy ? { blockedBy: n.blockedBy } : {}),
      ...(blocked ? { reason: n.blockReason ?? 'blocked by the QA platform' } : failed ? { reason: n.status ? `HTTP ${n.status}` : n.failure ?? 'request failed' } : {}),
      phase: n.phase ?? 'page-load', startedMs: Math.max(0, n.startedAt - opts.navStartedAt), durationMs: n.durationMs,
      ...(n.auth ? { auth: n.auth } : {}), ...(n.response ? { response: n.response } : {}), ...(role ? { role } : {}),
    };
  };
  const requests = events.filter((n) => !STATIC_TYPES.has(n.resourceType)).sort((a, b) => a.startedAt - b.startedAt).map(toRequest);
  const statics = events.filter((n) => STATIC_TYPES.has(n.resourceType));
  const hostOf = (u: string): string => { try { return new URL(u).host; } catch { return ''; } };

  const page = await c.page.evaluate(`(() => {
    const keys = (s) => { try { return Object.keys(s).slice(0, 40); } catch { return []; } };
    const lines = (document.body ? document.body.innerText : '').split('\\n').map((l) => l.trim()).filter((l) => l && l.length < 160);
    return { local: keys(window.localStorage), session: keys(window.sessionStorage), lines };
  })()`).catch(() => ({ local: [], session: [], lines: [] })) as { local: string[]; session: string[]; lines: string[] };
  const emptyStateText = [...new Set(page.lines.filter((l) => EMPTY_STATE.test(l)))].slice(0, 3).map((l) => c.redactor.redact(l));
  const cookieNames = [...new Set((await c.page.context().cookies(c.page.url()).catch(() => [])).map((k) => k.name))].sort();
  const consoleErrors = [...new Set(c.events.console.slice(opts.consoleFrom).filter((e) => e.level === 'error' && !/Failed to load resource/i.test(e.text)).map((e) => e.text.slice(0, 200)))].slice(0, 8);

  return {
    url: opts.url, capturedAt: new Date().toISOString(), ...evaluateReadiness(requests, emptyStateText), requests,
    staticFiles: {
      total: statics.length, loaded: statics.filter((n) => n.ok).length, blocked: statics.filter((n) => n.blockedByGuard).length,
      failed: statics.filter((n) => !n.ok && !n.blockedByGuard && !/ERR_ABORTED/i.test(n.failure ?? '')).length, hosts: [...new Set(statics.map((n) => hostOf(n.url)).filter(Boolean))].sort(),
    },
    cookieNames, storageKeys: { local: page.local, session: page.session }, emptyStateText, consoleErrors,
  };
}

/**
 * The DATA requests (XHR/fetch) a page made while loading, with when each started: the pattern used to recognise that a
 * reload has finished loading its data. Documents, site icons and other non-data requests are not part of it.
 */
export function loadProfile(r: PageReadiness): Map<string, number> {
  const profile = new Map<string, number>();
  for (const x of r.requests) {
    if (x.type !== 'xhr' && x.type !== 'fetch') continue;
    const sig = EventCollector.signature(x.method, x.url);
    if (!profile.has(sig)) profile.set(sig, x.startedMs);
  }
  return profile;
}
