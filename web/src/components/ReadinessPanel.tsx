import { useState } from 'react';
import type { PageReadiness } from '../api';

const STATE_LABEL: Record<PageReadiness['state'], string> = { ready: 'READY: DATA LOADED', partial: 'READY: PAGE DATA LOADED (AUXILIARY DATA BLOCKED)', empty: 'EMPTY (NO DATA RETURNED)', 'data-not-loaded': 'PAGE DATA NOT LOADED' };

const routeOf = (u: string): string => {
  try {
    const x = new URL(u);
    return x.pathname + x.search + x.hash;
  } catch {
    return u;
  }
};
const pathOf = (u: string): string => {
  try {
    return new URL(u).pathname;
  } catch {
    return u;
  }
};

/**
 * What each page asked for while loading and what became of it: which requests succeeded, which were blocked (and by which
 * rule) or failed, which credentials were attached (names only), and whether the answers contained data.
 */
export function ReadinessPanel({ pages }: { pages: { url: string; title: string | null; readiness: PageReadiness }[] }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const meaningfulPages = pages.filter(({ readiness: r }) => {
    const hasApi = r.requests.some((q) => q.type !== 'document');
    const hasBlockedOrFailed = r.staticFiles.blocked > 0 || r.staticFiles.failed > 0;
    const isSpecialState = r.state === 'partial' || r.state === 'data-not-loaded' || r.state === 'empty';
    return hasApi || hasBlockedOrFailed || isSpecialState;
  });
  if (meaningfulPages.length === 0) return null;

  return (
    <section>
      {meaningfulPages.map(({ url, readiness: r }) => {
        const isOpen = open[url] ?? r.state === 'data-not-loaded';
        const api = r.requests.filter((q) => q.type !== 'document');
        return (
          <article className={`readiness-card rd-${r.state}`} key={url}>
            <div className="readiness-head">
              <span className={`readiness-state rd-pill-${r.state}`}>{STATE_LABEL[r.state]}</span>
              <code>{routeOf(url)}</code>
              <button type="button" className="btn-text" onClick={() => setOpen((o) => ({ ...o, [url]: !isOpen }))}>
                {isOpen ? 'Hide' : 'Show'} {api.length} data requests
              </button>
            </div>
            <p className="readiness-summary">{r.summary}</p>
            <p className="readiness-meta">
              Cookies in the test browser (names only): {r.cookieNames.join(', ') || 'none'} · Static files: {r.staticFiles.loaded}/{r.staticFiles.total} loaded
              {r.staticFiles.blocked > 0 ? `, ${r.staticFiles.blocked} blocked` : ''}{r.staticFiles.failed > 0 ? `, ${r.staticFiles.failed} failed` : ''}
            </p>
            {isOpen && (
              <div className="readiness-table">
                <table>
                  <thead>
                    <tr>
                      <th>Result</th>
                      <th>Method</th>
                      <th>Path</th>
                      <th>Status</th>
                      <th>Why</th>
                      <th>Credentials attached</th>
                      <th>Response</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.requests.map((q, i) => (
                      <tr key={`${q.method}${q.url}${i}`}>
                        <td className={`rq-${q.outcome}`}>{q.outcome.toUpperCase()}</td>
                        <td>{q.method}</td>
                        <td title={q.url}>{pathOf(q.endpoint)}{q.type === 'document' ? ' (page)' : ''}</td>
                        <td>{q.status ?? '—'}</td>
                        <td>{q.reason ?? ''}</td>
                        <td>{[...(q.auth?.cookieNames ?? []).map((n) => `cookie ${n}`), ...(q.auth?.headerNames ?? []).map((n) => `header ${n}`)].join(', ') || 'none'}</td>
                        <td>{q.response ? `${q.response.body === 'data' ? 'has data' : q.response.body}${q.response.items !== undefined ? ` (${q.response.items} items)` : ''}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}
