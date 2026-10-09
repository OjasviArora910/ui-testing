import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Finding, Severity } from '../api';

interface BugGroup {
  key?: string;
  ruleId: string;
  category: string;
  severity: Severity;
  expected: string;
  findings: Finding[];
  viewports: Set<string>;
  uniqueElements: number;
}

interface BugListProps {
  groups: BugGroup[];
  renderInstance: (finding: Finding, first: boolean) => ReactNode;
}

const ISSUE_TITLES: Record<string, string> = {
  'geometry.text-clipping': 'Text is clipped',
  'geometry.overlap': 'Elements overlap',
  'geometry.container-overflow': 'Content overflows its container',
  'geometry.parent-overflow': 'Content overflows its container',
  'geometry.viewport-overflow': 'Content extends beyond the viewport',
  'geometry.offscreen': 'Element is off screen',
  'functional.link': 'Broken link',
  'functional.button': 'Button did not work as expected',
  'functional.form': 'Form validation failed',
  'functional.search': 'Search did not work as expected',
  'functional.modal': 'Modal did not work as expected',
  'functional.interactive': 'Form control did not work as expected',
  'responsive.table-overflow': 'Table does not fit the viewport',
  'responsive.image-overflow': 'Image does not fit the viewport',
  'responsive.dialog-overflow': 'Dialog does not fit the viewport',
  'visual.regression': 'Visual regression detected',
};

const keyFor = (group: BugGroup): string =>
  group.key ?? `${group.ruleId}:${group.findings.map((finding) => finding.id).join('|')}`;

const titleFor = (group: BugGroup): string => {
  const generated = group.ruleId
    .split('.')
    .slice(-1)[0]
    ?.replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
  return ISSUE_TITLES[group.ruleId] ?? generated ?? 'Issue detected';
};

const explanationFor = (group: BugGroup): string => {
  const first = group.findings[0];
  return first?.expected || group.expected || 'The automated test found behavior that should be inspected.';
};

const pathOf = (raw: string): string => {
  try {
    const u = new URL(raw);
    return u.pathname + u.search || '/';
  } catch {
    return raw;
  }
};

const pageSummary = (findings: Finding[]): string => {
  const pages = [...new Set(findings.map((finding) => pathOf(finding.page)))];
  if (pages.length === 0) return 'No page recorded';
  if (pages.length <= 2) return pages.join(', ');
  return `${pages.slice(0, 2).join(', ')} +${pages.length - 2} more`;
};

const elementLabel = (finding: Finding): string =>
  finding.element?.name || finding.element?.selector || 'Element not recorded';

export function BugList({ groups, renderInstance }: BugListProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(groups[0] ? keyFor(groups[0]) : null);
  const selectedGroup = useMemo(
    () => groups.find((group) => keyFor(group) === selectedKey) ?? null,
    [groups, selectedKey],
  );
  const [selectedOccurrenceId, setSelectedOccurrenceId] = useState<string | null>(
    selectedGroup?.findings[0]?.id ?? null,
  );
  const selectedOccurrence =
    selectedGroup?.findings.find((finding) => finding.id === selectedOccurrenceId)
    ?? selectedGroup?.findings[0]
    ?? null;

  useEffect(() => {
    if (groups.length === 0) {
      setSelectedKey(null);
      return;
    }
    if (!selectedKey || !groups.some((group) => keyFor(group) === selectedKey)) {
      setSelectedKey(keyFor(groups[0]));
    }
  }, [groups, selectedKey]);

  useEffect(() => {
    if (!selectedGroup) {
      setSelectedOccurrenceId(null);
      return;
    }
    if (!selectedOccurrenceId || !selectedGroup.findings.some((finding) => finding.id === selectedOccurrenceId)) {
      setSelectedOccurrenceId(selectedGroup.findings[0]?.id ?? null);
    }
  }, [selectedGroup, selectedOccurrenceId]);

  return (
    <div className="bugs bugs-drawer-layout">
      <div className="bugs-list-panel">
        {groups.map((group) => {
          const groupKey = keyFor(group);
          const selected = selectedKey === groupKey;

          return (
            <article className={`issue-row ${selected ? 'selected' : ''}`} key={groupKey}>
              <div className="issue-severity">
                <span className={`severity-badge s-${group.severity}`}>{group.severity.toUpperCase()}</span>
              </div>
              <div className="issue-row-main">
                <h3>{titleFor(group)}</h3>
                <p>{explanationFor(group)}</p>
                <div className="issue-row-meta">
                  <span>{pageSummary(group.findings)}</span>
                  <span>{group.findings.length} occurrence{group.findings.length === 1 ? '' : 's'}</span>
                </div>
              </div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => {
                  setSelectedKey(groupKey);
                  setSelectedOccurrenceId(group.findings[0]?.id ?? null);
                }}
              >
                View
              </button>
            </article>
          );
        })}
      </div>

      <aside className={`issue-detail-drawer ${selectedGroup && selectedOccurrence ? 'open' : ''}`}>
        {selectedGroup && selectedOccurrence ? (
          <>
            <div className="drawer-header">
              <div>
                <span className={`severity-badge s-${selectedGroup.severity}`}>{selectedGroup.severity.toUpperCase()}</span>
                <h3>{titleFor(selectedGroup)}</h3>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelectedKey(null)}>
                Close
              </button>
            </div>

            {selectedGroup.findings.length > 1 && (
              <div className="occurrence-selector">
                {selectedGroup.findings.map((finding, index) => (
                  <button
                    key={finding.id}
                    type="button"
                    className={selectedOccurrence.id === finding.id ? 'active' : ''}
                    onClick={() => setSelectedOccurrenceId(finding.id)}
                  >
                    Occurrence {index + 1} - {pathOf(finding.page)}
                  </button>
                ))}
              </div>
            )}

            <div className="drawer-facts">
              <div><span>Page</span><strong>{pathOf(selectedOccurrence.page)}</strong></div>
              <div><span>Element</span><strong>{elementLabel(selectedOccurrence)}</strong></div>
              <div><span>Expected</span><p>{selectedOccurrence.expected}</p></div>
              <div><span>Actual</span><p>{selectedOccurrence.actual}</p></div>
            </div>

            <details className="drawer-disclosures" open>
              <summary>Screenshot / evidence</summary>
              {renderInstance(selectedOccurrence, true)}
            </details>

            <details className="drawer-disclosures">
              <summary>Technical Details</summary>
              <div className="technical-details-content">
                <div>
                  <span>Rule ID</span>
                  <code>{selectedOccurrence.ruleId}</code>
                </div>
                <div>
                  <span>Measurements and actual observation</span>
                  <p>{selectedOccurrence.actual}</p>
                </div>
                <div>
                  <span>DOM evidence</span>
                  <code>{selectedOccurrence.element?.selector || 'No selector recorded'}</code>
                </div>
                <div>
                  <span>Occurrences</span>
                  <p>{selectedGroup.findings.length} total across {selectedGroup.uniqueElements} element{selectedGroup.uniqueElements === 1 ? '' : 's'} and {[...selectedGroup.viewports].join(', ')}</p>
                </div>
              </div>
            </details>
          </>
        ) : (
          <div className="drawer-placeholder">
            <h3>Select an issue</h3>
            <p>Choose an issue to inspect evidence without losing your place in the list.</p>
          </div>
        )}
      </aside>
    </div>
  );
}
