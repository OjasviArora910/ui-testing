import { useState, type ReactNode } from 'react';
import type { Finding } from '../api';

/** One confirmed problem: the same failure on several elements, pages or viewports is one row with several instances. */
export interface BugGroup {
  ruleId: string;
  category: string;
  severity: Finding['severity'];
  expected: string;
  findings: Finding[];
  viewports: Set<string>;
  uniqueElements: number;
}

const SEVERITY_LABEL: Record<string, string> = { critical: 'Critical', major: 'Major', minor: 'Minor', info: 'Info' };

const pathOf = (u: string): string => {
  try { const x = new URL(u); return (x.pathname + x.hash) || '/'; } catch { return u; }
};

/** A short, human title from the observed failure: the first sentence, without the internal check tag. */
export function bugTitle(f: Finding): string {
  const text = f.actual.replace(/^\[[^\]]+\]\s*/, '').replace(/\s+/g, ' ').trim();
  const first = text.split(/(?<=[.!?])\s|;\s/)[0] ?? text;
  const t = (first || f.ruleId).replace(/https?:\/\/[^/\s]+/g, '');
  return t.length > 110 ? `${t.slice(0, 108)}…` : t;
}

const whereOf = (g: BugGroup): string => {
  const f = g.findings[0]!;
  const pages = new Set(g.findings.map((x) => pathOf(x.page)));
  const el = f.element?.name?.trim();
  const page = pages.size > 1 ? `${pathOf(f.page)} +${pages.size - 1} more` : pathOf(f.page);
  return el && g.uniqueElements <= 1 ? `${page} · ${el.slice(0, 40)}` : g.uniqueElements > 1 ? `${page} · ${g.uniqueElements} elements` : page;
};

/**
 * The primary view of a finished run: confirmed bugs as a compact table. A row shows only severity, a short title, the
 * category and where it is; everything else (expected, actual, evidence, screenshots, technical details, every
 * instance) is behind "View details".
 */
export function BugList({ groups, renderInstance }: { groups: BugGroup[]; renderInstance: (f: Finding, first: boolean) => ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="bugs" role="table" aria-label="Confirmed bugs">
      <div className="bugs-head" role="row">
        <span role="columnheader">Severity</span><span role="columnheader">Bug</span><span role="columnheader">Category</span><span role="columnheader">Page / element</span><span role="columnheader" />
      </div>
      {groups.map((g) => {
        const f = g.findings[0]!;
        const key = f.problemKey ?? f.id;
        const isOpen = open === key;
        return (
          <div className={`bugs-item ${isOpen ? 'open' : ''}`} key={key}>
            <button type="button" className="bugs-row" role="row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : key)}>
              <span className={`bugs-sev sev-${g.severity}`} role="cell"><i />{SEVERITY_LABEL[g.severity] ?? g.severity}</span>
              <span className="bugs-title" role="cell" title={f.actual}>{bugTitle(f)}</span>
              <span className="bugs-cat" role="cell">{g.category}</span>
              <span className="bugs-where" role="cell" title={f.page}>{whereOf(g)}</span>
              <span className="bugs-action" role="cell">{isOpen ? 'Hide details' : 'View details'}{g.findings.length > 1 ? ` (${g.findings.length})` : ''}</span>
            </button>
            {isOpen && (
              <div className="bugs-detail">
                <dl className="bugs-facts">
                  <dt>Expected</dt><dd>{f.expected}</dd>
                  <dt>Actual</dt><dd>{f.actual.replace(/^\[[^\]]+\]\s*/, '')}</dd>
                  <dt>Where</dt><dd><code>{pathOf(f.page)}</code>{f.element?.name ? ` · ${f.element.name}` : ''} · {Array.from(g.viewports).join(', ')}</dd>
                </dl>
                <div className="bugs-instances-label">
                  {g.findings.length === 1 ? 'Evidence and technical details' : `${g.findings.length} instances${g.uniqueElements > 1 ? ` on ${g.uniqueElements} elements` : ''}: evidence and technical details for each`}
                  <span className="bugs-rule">rule <code>{g.ruleId}</code></span>
                </div>
                <div className="bugs-instances">{g.findings.map((x, i) => renderInstance(x, i === 0))}</div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
