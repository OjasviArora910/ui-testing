import { useState } from 'react';
import type { DynamicData, ResultClass } from '../api';

const pathOf = (u: string) => {
  try {
    const x = new URL(u);
    return x.pathname + x.search + x.hash;
  } catch {
    return u;
  }
};

const CLASS_ORDER: ResultClass[] = ['BUG', 'WARNING', 'NEEDS_REVIEW', 'BLOCKED_BY_SAFETY', 'EXPECTED', 'INCONCLUSIVE'];
export const CLASS_LABEL: Record<ResultClass, string> = {
  BUG: 'Confirmed bug',
  WARNING: 'Confirmed bug',
  EXPECTED: 'Pass',
  NEEDS_REVIEW: 'Inconclusive',
  BLOCKED_BY_SAFETY: 'Blocked (safety)',
  INCONCLUSIVE: 'Inconclusive',
};

function uniq<T extends { label: string; reason: string }>(list: T[]): T[] {
  return [...new Map(list.map((x) => [`${x.label}|${x.reason}`, x])).values()];
}

/** Shows, per page, what the engine detected, which tests it selected and skipped, and how each selected test ended. */
export function DynamicPanel({ data }: { data: DynamicData }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (data.pages.length === 0) return null;

  return (
    <section className="dynamic-section">
      <div className="categories-header">
        <h3 className="categories-title">Tested elements</h3>
        <span className="categories-subtitle">
          Every relevant control found on each page is exercised. Interactions that work are counted here and not listed as findings.
        </span>
      </div>

      <div className="dynamic-grid">
        {data.pages.map((p) => {
          const results = data.results.filter((r) => r.page === p.url);
          const counts = CLASS_ORDER.map((c) => [c, results.filter((r) => r.classification === c).length] as const).filter(([, n]) => n > 0);
          const isOpen = !!open[p.url];
          return (
            <article className="dynamic-card" key={p.url}>
              <header className="dynamic-card-head">
                <code className="dynamic-path" title={p.url}>{pathOf(p.url)}</code>
                <div className="dynamic-types">
                  {p.decision.types.filter((t) => t.confidence !== 'LOW').map((t) => (
                    <span className="dynamic-type" key={t.type} title={`${t.confidence} confidence: ${t.signals.join('; ')}`}>
                      {t.type}
                    </span>
                  ))}
                </div>
              </header>

              <div className="dynamic-cols">
                <div>
                  <div className="dynamic-col-title">Selected</div>
                  <ul className="dynamic-list">
                    {uniq(p.decision.selected).map((s) => (
                      <li key={`${s.id}|${s.reason}`} title={`${s.pageType} · ${s.confidence} confidence`}>
                        <span className="dynamic-mark dynamic-mark-on">✓</span>
                        <span>
                          {s.label}
                          <span className="dynamic-reason"> — {s.reason}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="dynamic-col-title">Skipped</div>
                  {p.decision.skipped.length === 0 ? (
                    <p className="dynamic-reason">Nothing skipped.</p>
                  ) : (
                    <ul className="dynamic-list">
                      {uniq(p.decision.skipped).map((s) => (
                        <li key={`${s.id}|${s.reason}`}>
                          <span className="dynamic-mark">○</span>
                          <span>
                            {s.label}
                            <span className="dynamic-reason"> — {s.reason}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              {results.length > 0 && (
                <footer className="dynamic-card-foot">
                  <div className="dynamic-counts">
                    {counts.map(([c, n]) => (
                      <span className={`result-class rc-${c}`} key={c}>
                        {CLASS_LABEL[c]}: {n}
                      </span>
                    ))}
                  </div>
                  <button type="button" className="btn-text" onClick={() => setOpen((o) => ({ ...o, [p.url]: !isOpen }))}>
                    {isOpen ? 'Hide' : 'Show'} {results.length} test results
                  </button>
                </footer>
              )}

              {isOpen && (
                <div className="dynamic-results">
                  <table>
                    <thead>
                      <tr>
                        <th>Result</th>
                        <th>Test</th>
                        <th>Target</th>
                        <th>Expected</th>
                        <th>Actual</th>
                        <th>Confidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.map((r) => (
                        <tr key={r.id} title={`Selected because: ${r.reason}`}>
                          <td><span className={`result-class rc-${r.classification}`}>{CLASS_LABEL[r.classification]}</span></td>
                          <td>{r.scenarioLabel}<br /><code>{r.check}</code></td>
                          <td>{r.target ?? ''}</td>
                          <td>{r.expected}</td>
                          <td>{r.actual}</td>
                          <td>{r.confidence}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
