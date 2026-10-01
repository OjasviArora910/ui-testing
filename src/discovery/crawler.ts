import type { BrowserController } from '../browser/index.js';
import { buildPageModel } from './pageModel.js';
import type { CrawlQueueItem, CrawlState, CrawledPage } from './types.js';

const SKIP_EXT = /\.(pdf|zip|gz|tar|png|jpe?g|gif|svg|webp|ico|mp4|mp3|webm|woff2?|ttf|css|js|map|xml|json|csv|docx?|xlsx?|pptx?)$/i;
const TRACKING_PARAM = /^(utm_|fbclid|gclid|mc_|_ga)/i;

/**
 * Canonical URL used for dedupe: lowercase host, no hash, no default port, tracking params dropped,
 * query params sorted, trailing slash removed (except root). Returns null for non-http(s) or file-like URLs.
 */
export function normalizeUrl(href: string, base: string): string | null {
  let u: URL;
  try { u = new URL(href, base); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (SKIP_EXT.test(u.pathname)) return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
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
  onPage?: (page: CrawledPage, state: CrawlState) => void | Promise<void>;
}

/**
 * Same-origin breadth-first crawler with page/depth limits and dedupe.
 * `visited` and `queue` are exposed through onPage so callers can persist progress and resume.
 */
export async function crawl(controller: BrowserController, opts: CrawlOptions): Promise<CrawledPage[]> {
  const start = normalizeUrl(opts.startUrl, opts.startUrl);
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
    const finalUrl = normalizeUrl(controller.page.url(), item.url);
    const page: CrawledPage = { url: item.url, depth: item.depth, status: nav.status, model: null, outgoing: [] };

    if (!nav.ok) {
      page.error = nav.error;
    } else if (!finalUrl || !sameOrigin(finalUrl, start)) {
      page.error = 'redirected outside the target origin';
    } else {
      if (finalUrl !== item.url) { visited.add(finalUrl); page.url = finalUrl; }
      if ((nav.status ?? 200) < 400) {
        page.model = await buildPageModel(controller, { status: nav.status });
        for (const l of page.model.links) {
          const n = normalizeUrl(l.href ?? '', controller.page.url());
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
