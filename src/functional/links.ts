import { normalizeUrl, sameOrigin } from '../discovery/crawler.js';
import { coveredBy, resetPage } from './helpers.js';
import type { FunctionalContext, FunctionalResult } from './types.js';

const BASE = { kind: 'link' as const };
const SOFT_404 = /^(404|500|502|503|not found|page not found|internal server error|server error|something went wrong)\b/i;

/** Tests link usability: usable href, clickability, navigation outcome, obvious 404/500 pages. Same-origin only. */
export async function testLinks(ctx: FunctionalContext): Promise<FunctionalResult[]> {
  const { controller: c, guard, config } = ctx;
  const results: FunctionalResult[] = [];
  const structure = await c.structure();
  const seen = new Set<string>();
  const origin = ctx.pageUrl;
  const tested = ctx.testedLinks ?? new Set<string>();
  const links = structure.links.filter((l) => l.visible)
    .sort((a, b) => Number(a.inNav) - Number(b.inNav)) // page-specific links first, shared navigation last
    .filter((l) => {
      const key = normalizeUrl(l.resolved, ctx.pageUrl) ?? l.href;
      if (seen.has(`${l.href}|${l.text}`) || tested.has(key)) return false;
      seen.add(`${l.href}|${l.text}`);
      return true;
    }).slice(0, config.functional.maxLinksPerPage);
  for (const l of links) tested.add(normalizeUrl(l.resolved, ctx.pageUrl) ?? l.href);

  for (const l of links) {
    if (ctx.budget.exhausted) break;
    const label = l.text || l.href;
    const el = { selector: l.selector, role: 'link', name: label.slice(0, 80) };
    const raw = l.href.trim();

    if (raw === '' || raw === '#' || /^javascript:/i.test(raw)) {
      results.push({ ...BASE, check: 'destination', status: 'anomaly', severity: 'minor', basis: null, element: el, expected: 'Links point to a real destination', actual: `Link "${label}" has href="${raw}" (no usable destination)` });
      continue;
    }
    const target = normalizeUrl(l.resolved, ctx.pageUrl);
    if (!target || !sameOrigin(target, origin)) {
      results.push({ ...BASE, check: 'external', status: 'skipped', severity: 'info', basis: null, element: el, expected: 'Same-origin links are followed', actual: `Not followed (external or non-http): ${raw.slice(0, 120)}` });
      continue;
    }
    if (target === normalizeUrl(ctx.pageUrl, ctx.pageUrl)) continue; // self link
    const decision = guard.check({ kind: 'click', name: label, text: label, href: target, selector: l.selector, role: 'link' });
    if (!decision.allowed) {
      results.push({ ...BASE, check: 'guard', status: 'skipped', severity: 'info', basis: null, element: el, expected: 'Safe links are followed', actual: `Not followed: ${decision.reason}`, details: { guard: decision } });
      continue;
    }
    if (!(await resetPage(ctx))) break;

    const loc = c.locate({ css: l.selector });
    try {
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
      await loc.click({ trial: true, timeout: 3000 });
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).split('\n')[0]!;
      const covered = /intercepts pointer events/i.test(msg);
      const cover = covered ? await coveredBy(ctx, l.selector) : null;
      const hard = covered && !cover?.floating;
      results.push({ ...BASE, check: 'clickable', status: hard ? 'fail' : 'anomaly', severity: hard ? 'major' : 'minor', basis: hard ? 'deterministic' : null, element: el, expected: `Link "${label}" can be clicked`, actual: c.redactor.redact(`Not clickable${cover ? `: <${cover.description}> covers it${cover.floating ? ' (floating/overlay UI, needs review)' : ''}` : `: ${msg.slice(0, 200)}`}`) });
      continue;
    }

    if (!ctx.budget.consume()) break;
    const n0 = c.events.network.length;
    let status: number | undefined;
    let usedClick = l.target !== '_blank';
    if (usedClick) {
      const r = await c.click({ css: l.selector });
      await c.page.waitForLoadState('load', { timeout: 5000 }).catch(() => undefined);
      await c.settle(150);
      ctx.onAction?.({ type: 'click', target: label, ok: r.ok, detail: r.error });
      const doc = c.events.network.slice(n0).filter((n) => n.resourceType === 'document').pop();
      status = doc?.status ?? undefined;
      if (!r.ok) usedClick = false;
    }
    if (!usedClick) { // target=_blank or click failed: navigate directly
      const r = await c.navigate(target);
      status = r.status;
      await c.settle(150);
      ctx.onAction?.({ type: 'navigate', target, ok: r.ok, detail: r.error });
    }

    const finalUrl = c.url;
    if (status !== undefined && status >= 400) {
      results.push({ ...BASE, check: 'navigation', status: 'fail', severity: 'major', basis: 'deterministic', element: el, expected: 'Link leads to a working page (HTTP < 400)', actual: `Link "${label}" -> ${target} returned HTTP ${status}`, details: { status, target } });
      continue;
    }
    const heading = (await c.page.evaluate("(document.querySelector('h1,h2,title') || {}).textContent || ''") as string).trim();
    if (SOFT_404.test(heading) || SOFT_404.test(await c.page.title())) {
      results.push({ ...BASE, check: 'soft-error-page', status: 'anomaly', severity: 'minor', basis: null, element: el, expected: 'Link leads to a content page', actual: `Link "${label}" leads to what looks like an error page ("${heading.slice(0, 60)}") although HTTP status was ${status ?? 'unknown'}` });
      continue;
    }
    results.push({ ...BASE, check: 'navigation', status: 'pass', severity: 'info', basis: null, element: el, expected: 'Link works', actual: `Link "${label}" -> ${finalUrl} (HTTP ${status ?? 'n/a'})` });
  }
  return results;
}
