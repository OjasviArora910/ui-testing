import type { BrowserController } from '../browser/index.js';
import { buildPageModel } from './pageModel.js';
import type { CrawlQueueItem, CrawlState, CrawledPage, PageModel } from './types.js';

const SKIP_EXT = /\.(pdf|zip|gz|tar|png|jpe?g|gif|svg|webp|ico|mp4|mp3|webm|woff2?|ttf|css|js|map|xml|json|csv|docx?|xlsx?|pptx?)$/i;
const TRACKING_PARAM = /^(utm_|fbclid|gclid|mc_|_ga)/i;

/**
 * Canonical URL used for dedupe: lowercase host, no hash, no default port, tracking params dropped,
 * query params sorted, trailing slash removed (except root). Returns null for non-http(s) or file-like URLs.
 */
/**
 * A fragment that addresses a VIEW of a single-page app (#/orders, #!/a, #dashboard/sales) rather than a position inside
 * the page (#pricing). Route fragments are part of the page's identity and must be kept.
 */
export function isHashRoute(fragment: string): boolean {
  const f = fragment.replace(/^#/, '');
  return f.length > 1 && (/^[!/]/.test(f) || f.includes('/'));
}

/** Fragments in the wild are not always valid percent-encoding (a stray "%"); a URL must never crash the crawl. */
function safeDecode(s: string): string { try { return decodeURIComponent(s); } catch { return s; } }

export interface NormalizeOptions {
  /** The site routes by fragment: keep single-word fragments (#reports) too, unless they are anchors inside the page. */
  hashRouted?: boolean;
  /** Ids/anchor names present in the current page, so a plain in-page anchor is never mistaken for a route. */
  anchors?: ReadonlySet<string>;
}

export function normalizeUrl(href: string, base: string, opts: NormalizeOptions = {}): string | null {
  let u: URL;
  try { u = new URL(href, base); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (SKIP_EXT.test(u.pathname)) return null;
  const frag = safeDecode(u.hash.replace(/^#/, ''));
  const route = isHashRoute(u.hash) || (!!opts.hashRouted && frag.length > 1 && !opts.anchors?.has(frag));
  if (!route) u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  if (u.pathname.endsWith('/index.html')) {
    u.pathname = u.pathname.slice(0, -10);
  } else if (u.pathname.endsWith('/index.htm')) {
    u.pathname = u.pathname.slice(0, -9);
  }
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

export function sameOrigin(a: string, b: string): boolean {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

export interface CrawlOptions {
  startUrl: string;
  maxPages: number;
  maxDepth: number;
  /** Resume from a persisted state. */
  initial?: CrawlState;
  /** Return false to skip navigating to a discovered link (ActionGuard hook). */
  allowLink?: (link: { href: string; text: string; selector: string }) => boolean;
  shouldStop?: () => boolean;
  /** True when the browser was sent to a login page instead of the requested page. Such a page is recorded as requiring authentication, not tested as if it were the target. */
  isLoginRedirect?: (model: PageModel, requested: string, landed: string) => boolean;
  onPage?: (page: CrawledPage, state: CrawlState) => void | Promise<void>;
}

/**
 * Same-origin breadth-first crawler with page/depth limits and dedupe.
 * `visited` and `queue` are exposed through onPage so callers can persist progress and resume.
 */
export async function crawl(controller: BrowserController, opts: CrawlOptions): Promise<CrawledPage[]> {
  // A start URL that is itself a hash route tells us the application routes by fragment.
  const hashRouted = (() => { try { return isHashRoute(new URL(opts.startUrl).hash); } catch { return false; } })();
  const start = normalizeUrl(opts.startUrl, opts.startUrl, { hashRouted });
  if (!start) throw new Error(`Cannot crawl invalid start URL: ${opts.startUrl}`);
  const visited = new Set<string>(opts.initial?.visited ?? []);
  const queue: CrawlQueueItem[] = opts.initial?.queue ? [...opts.initial.queue] : [{ url: start, depth: 0 }];
  const queued = new Set<string>([...visited, ...queue.map((q) => q.url)]);
  const pages: CrawledPage[] = [];

  while (queue.length > 0 && visited.size < opts.maxPages) {
    if (opts.shouldStop?.()) break;
    const item = queue.shift()!;
    if (visited.has(item.url)) continue;
    visited.add(item.url);

    const nav = await controller.navigate(item.url);
    await controller.settle(150);
    const finalUrl = normalizeUrl(controller.page.url(), item.url, { hashRouted });
    const page: CrawledPage = { url: item.url, depth: item.depth, status: nav.status, model: null, outgoing: [] };

    if (!nav.ok) {
      page.error = nav.error;
    } else if (!finalUrl || !sameOrigin(finalUrl, start)) {
      page.error = 'redirected outside the target origin';
    } else {
      if (finalUrl !== item.url) { visited.add(finalUrl); page.url = finalUrl; }
      if ((nav.status ?? 200) < 400) {
        page.model = await buildPageModel(controller, { status: nav.status });
        if (finalUrl !== item.url && opts.isLoginRedirect?.(page.model, item.url, controller.page.url())) {
          // A protected page: the application answered with its login page. It was not reached, so it is not tested.
          page.url = item.url; page.model = null;
          page.error = 'requires authentication (the application redirected to its login page)';
          pages.push(page);
          await opts.onPage?.(page, { visited: [...visited], queue: [...queue] });
          continue;
        }
        const anchors = hashRouted ? new Set(await controller.page.evaluate("Array.from(document.querySelectorAll('[id],a[name]')).map((e) => e.id || e.getAttribute('name'))").catch(() => []) as string[]) : undefined;
        for (const l of page.model.links) {
          // a link to a position inside this same page is not another page
          const here = (() => { try { const t = new URL(l.href ?? '', controller.page.url()); const cur = new URL(controller.page.url()); return t.origin + t.pathname + t.search === cur.origin + cur.pathname + cur.search && !!anchors?.has(safeDecode(t.hash.replace(/^#/, ''))); } catch { return false; } })();
          if (here) continue;
          const n = normalizeUrl(l.href ?? '', controller.page.url(), { hashRouted, anchors });
          if (!n || !sameOrigin(n, start)) continue;
          if (opts.allowLink && !opts.allowLink({ href: n, text: l.name || l.text, selector: l.selector })) continue;
          page.outgoing.push(n);
          if (item.depth < opts.maxDepth && !queued.has(n)) { queued.add(n); queue.push({ url: n, depth: item.depth + 1 }); }
        }
        page.outgoing = [...new Set(page.outgoing)];
      } else {
        page.error = `HTTP ${nav.status}`;
      }
    }
    pages.push(page);
    await opts.onPage?.(page, { visited: [...visited], queue: [...queue] });
  }
  return pages;
}
