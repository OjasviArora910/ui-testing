import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type DynamicData, type Finding, type ProgressEvent, type Run, type Severity, type Snapshot } from '../api';
import { DynamicPanel } from './DynamicPanel';
import { EvidenceModal, type EvidenceItem } from './EvidenceModal';
import { FindingCard } from './FindingCard';
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCheck,
  IconCritical,
  IconDownload,
  IconExternalLink,
  IconFilter,
  IconInfo,
  IconLayers,
  IconPlay,
  IconRefresh,
  IconSearch,
  IconShield,
  IconStop,
  IconTerminal,
} from './Icons';
import { ReviewQueueWizard } from './ReviewQueueWizard';
import { RunProgress } from './RunProgress';
import { notify } from './Toast';
import { emptyToken, toDirectAuth, TokenFields, type TokenState } from './TokenFields';
import { VerdictBadge } from './VerdictBadge';

type MainTab = 'findings' | 'accessibility' | 'selection' | 'review' | 'activity';

const TERMINAL = ['COMPLETED', 'ABORTED', 'ERROR', 'REVIEW'];

type FindingGroup = {
  key: string;
  ruleId: string;
  category: string;
  severity: Severity;
  expected: string;
  findings: Finding[];
  viewports: Set<string>;
  uniqueElements: number;
};

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, major: 3, minor: 2, info: 1 };

const ISSUE_TITLES: Record<string, string> = {
  'geometry.text-clipping': 'Text is clipped',
  'geometry.overlap': 'Elements overlap',
  'geometry.viewport-overflow': 'Content extends beyond the viewport',
  'geometry.parent-overflow': 'Content overflows its container',
  'geometry.offscreen': 'Element is off screen',
  'geometry.image-distortion': 'Image appears distorted',
  'responsive.table-overflow': 'Table does not fit the viewport',
  'responsive.image-overflow': 'Image does not fit the viewport',
  'responsive.dialog-overflow': 'Dialog does not fit the viewport',
  'functional.link': 'Broken link',
  'functional.button': 'Button did not work as expected',
  'functional.form': 'Form validation failed',
  'functional.search': 'Search did not work as expected',
  'functional.modal': 'Modal did not work as expected',
  'functional.interactive': 'Form control did not work as expected',
  'visual.regression': 'Visual regression detected',
  'visual.no-baseline': 'Visual baseline is missing',
};

function buildFindingGroups(items: Finding[]): FindingGroup[] {
  const map = new Map<string, FindingGroup>();
  for (const f of items) {
    const groupKey = f.problemKey ?? f.ruleId;
    const existing = map.get(groupKey);
    if (existing) {
      existing.findings.push(f);
      existing.viewports.add(f.viewport);
      if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[existing.severity]) existing.severity = f.severity;
    } else {
      map.set(groupKey, {
        key: groupKey,
        ruleId: f.ruleId,
        category: f.category,
        severity: f.severity,
        expected: f.expected,
        findings: [f],
        viewports: new Set([f.viewport]),
        uniqueElements: 0,
      });
    }
  }
  const groups = Array.from(map.values());
  for (const g of groups) {
    const selectors = new Set(g.findings.map((f) => f.element?.selector || f.id));
    g.uniqueElements = selectors.size;
  }
  return groups.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.findings.length - a.findings.length);
}

function issueTitle(group: FindingGroup): string {
  return ISSUE_TITLES[group.ruleId] ?? group.ruleId
    .split('.')
    .slice(-1)[0]
    ?.replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase()) ?? 'Issue detected';
}

function issueExplanation(group: FindingGroup): string {
  const first = group.findings[0];
  if (first?.expected) return first.expected;
  return group.expected || 'The automated test found behavior that should be inspected.';
}

function pathOf(raw: string): string {
  try {
    const u = new URL(raw);
    return u.pathname + u.search || '/';
  } catch {
    return raw;
  }
}

function pageSummary(findings: Finding[]): string {
  const pages = [...new Set(findings.map((f) => pathOf(f.page)))];
  if (pages.length === 0) return 'No page recorded';
  if (pages.length <= 2) return pages.join(', ');
  return `${pages.slice(0, 2).join(', ')} +${pages.length - 2} more`;
}

function simpleCategory(category: string): 'layout' | 'functional' | 'responsive' | 'other' {
  if (category === 'layout' || category.startsWith('geometry')) return 'layout';
  if (category === 'functional') return 'functional';
  if (category === 'responsive' || category === 'visual') return 'responsive';
  return 'other';
}

const CATEGORY_META: Record<string, { label: string; icon: string; desc: string }> = {
  layout: { label: 'Layout', icon: '📐', desc: 'Overlaps, text clipping, overflows' },
  functional: { label: 'Functional', icon: '⚡', desc: 'Buttons, links, and form validation' },
  accessibility: { label: 'Accessibility', icon: '♿', desc: 'axe-core, labels, keyboard reachability' },
  network: { label: 'Network', icon: '🌐', desc: 'Failed 4xx/5xx requests, slow APIs' },
  usability: { label: 'Usability', icon: '👆', desc: 'Touch target sizing, interactive affordances' },
  responsive: { label: 'Responsive', icon: '📱', desc: 'Multi-viewport scaling, tables, dialogs' },
  performance: { label: 'Performance', icon: '⏱️', desc: 'Slow requests & rendering bottlenecks' },
};

export function RunView({ runId, onChange }: { runId: string; onChange: () => void }) {
  const [run, setRun] = useState<Run | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [queue, setQueue] = useState<Finding[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [tab, setTab] = useState<MainTab>('findings');
  const [search, setSearch] = useState('');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [stateFilter, setStateFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'severity' | 'category' | 'page' | 'newest'>('severity');
  const [viewMode, setViewMode] = useState<'grouped' | 'flat'>('grouped');
  const [expandedRules, setExpandedRules] = useState<Record<string, boolean>>({});
  const [selectedIssueKey, setSelectedIssueKey] = useState<string | null>(null);
  const [selectedOccurrenceId, setSelectedOccurrenceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeToken, setResumeToken] = useState<TokenState>(emptyToken);
  const [activeEvidence, setActiveEvidence] = useState<{
    item: EvidenceItem;
    meta: { page: string; viewport: string; ruleId: string };
  } | null>(null);
  const loadedFinal = useRef(false);
  const [stopping, setStopping] = useState(false);
  const stopRun = async () => {
    setStopping(true);
    try {
      const r = await api.stop(runId);
      if (r.stopped) notify.success('Stopping the run…'); else { notify.error('This run is not running any more.'); setStopping(false); }
      await reload();
      onChange();
    } catch (e) {
      setStopping(false);
      notify.error((e as Error).message);
    }
  };
  const [dynamic, setDynamic] = useState<DynamicData | null>(null);

  const toggleRuleExpand = (ruleId: string) => {
    setExpandedRules((prev) => ({ ...prev, [ruleId]: !prev[ruleId] }));
  };

  const reload = useCallback(async () => {
    try {
      const r = await api.run(runId);
      setRun(r);
      if (r.progress) setSnap(r.progress);
      const [q, f, d] = await Promise.all([api.queue(runId), api.findings(runId), api.dynamic(runId).catch(() => null)]);
      setQueue(q);
      setFindings(f);
      setDynamic(d);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [runId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Live SSE listener
  useEffect(() => {
    const es = new EventSource(`/api/runs/${runId}/events`);
    es.addEventListener('snapshot', (e) => setSnap(JSON.parse((e as MessageEvent).data) as Snapshot));
    es.addEventListener('progress', (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as ProgressEvent;
      setEvents((prev) => (prev.some((p) => p.seq === ev.seq) ? prev : [...prev.slice(-400), ev]));
      // a page was classified and its tests selected: show the decision while the run is still going
      if (ev.type === 'page' && ev.data?.decision) void api.dynamic(runId).then(setDynamic).catch(() => undefined);
      if (ev.type === 'finding') void api.findings(runId).then(setFindings).catch(() => undefined);
      if (ev.type === 'done' || ev.type === 'error' || (ev.type === 'status' && ev.message === 'REPORTING')) {
        void reload();
        onChange();
      }
    });
    return () => es.close();
  }, [runId, reload, onChange]);

  // When run finishes, load final data
  useEffect(() => {
    if (snap && TERMINAL.includes(snap.status) && !loadedFinal.current) {
      loadedFinal.current = true;
      void reload();
    }
  }, [snap, reload]);

  // Two separate tracks: UI/UX findings (is the interface broken?) and accessibility findings (can everyone use it?).
  // A control can work correctly and still have an accessibility finding; that never counts as a UI/UX bug.
  const isA11y = (f: Finding) => (f.track ? f.track === 'accessibility' : f.category === 'accessibility' || f.ruleId.startsWith('a11y.'));
  const uiFindings = useMemo(() => findings.filter((f) => !isA11y(f)), [findings]);
  const a11yFindings = useMemo(() => findings.filter(isA11y), [findings]);
  const uiCounts = useMemo(() => ({
    // distinct problems, not occurrences
    bugs: new Set(uiFindings.filter((f) => f.resultClass === 'BUG').map((f) => f.problemKey ?? f.id)).size,
    warnings: new Set(uiFindings.filter((f) => f.resultClass === 'WARNING').map((f) => f.problemKey ?? f.id)).size,
    review: new Set(uiFindings.filter((f) => f.resultClass === 'NEEDS_REVIEW').map((f) => f.problemKey ?? f.id)).size,
  }), [uiFindings]);
  const showA11y = a11yFindings.length > 0 || !!dynamic?.accessibility.enabled;
  const tested = dynamic?.results.length ?? 0;
  const worked = dynamic?.results.filter((r) => r.classification === 'EXPECTED').length ?? 0;

  // Filtered & Sorted findings
  const filteredFindings = useMemo(() => {
    return uiFindings
      .filter((f) => {
        if (severityFilter !== 'all' && f.severity !== severityFilter) return false;
        if (categoryFilter !== 'all' && f.category !== categoryFilter) return false;
        if (stateFilter !== 'all' && f.reviewState !== stateFilter) return false;
        if (search.trim()) {
          const q = search.toLowerCase();
          const matchRule = f.ruleId.toLowerCase().includes(q);
          const matchCat = f.category.toLowerCase().includes(q);
          const matchActual = f.actual.toLowerCase().includes(q);
          const matchPage = f.page.toLowerCase().includes(q);
          const matchElem = f.element?.selector.toLowerCase().includes(q) || f.element?.name?.toLowerCase().includes(q);
          if (!matchRule && !matchCat && !matchActual && !matchPage && !matchElem) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sortBy === 'severity') {
          const rank = { critical: 4, major: 3, minor: 2, info: 1 };
          return (rank[b.severity] || 0) - (rank[a.severity] || 0);
        }
        if (sortBy === 'category') return a.category.localeCompare(b.category);
        if (sortBy === 'page') return a.page.localeCompare(b.page);
        return 0;
      });
  }, [uiFindings, severityFilter, categoryFilter, stateFilter, search, sortBy]);

  // Grouped by underlying problem: the same failure on several elements, pages or viewports is one entry
  const groupedFindings = useMemo(() => buildFindingGroups(filteredFindings), [filteredFindings]);
  const allGroupedFindings = useMemo(() => buildFindingGroups(uiFindings), [uiFindings]);

  // Severity metrics breakdown
  const severityCounts = useMemo(() => {
    const counts = { critical: 0, major: 0, minor: 0, info: 0 };
    for (const f of uiFindings) {
      if (f.severity in counts) counts[f.severity as keyof typeof counts]++;
    }
    return counts;
  }, [uiFindings]);

  // Category counts
  const categoryCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const f of findings) {
      map[f.category] = (map[f.category] || 0) + 1;
    }
    return map;
  }, [findings]);

  const allCategories = ['layout', 'functional', 'accessibility', 'network', 'usability', 'responsive', 'performance'];
  const completedIssueGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allGroupedFindings.filter((group) => {
      if (severityFilter !== 'all' && group.severity !== severityFilter) return false;
      if (categoryFilter !== 'all' && simpleCategory(group.category) !== categoryFilter) return false;
      if (!q) return true;
      const title = issueTitle(group).toLowerCase();
      return title.includes(q)
        || group.ruleId.toLowerCase().includes(q)
        || group.findings.some((f) =>
          f.actual.toLowerCase().includes(q)
          || f.expected.toLowerCase().includes(q)
          || f.page.toLowerCase().includes(q)
          || (f.element?.name ?? '').toLowerCase().includes(q)
          || (f.element?.selector ?? '').toLowerCase().includes(q)
        );
    });
  }, [allGroupedFindings, categoryFilter, search, severityFilter]);
  const selectedIssue = selectedIssueKey ? allGroupedFindings.find((group) => group.key === selectedIssueKey) ?? null : null;
  const selectedOccurrence = selectedIssue
    ? selectedIssue.findings.find((f) => f.id === selectedOccurrenceId) ?? selectedIssue.findings[0] ?? null
    : null;
  const distinctIssues = allGroupedFindings.length;
  const totalOccurrences = uiFindings.length;
  const screenshots = selectedOccurrence?.evidence.filter((e) => e.mime === 'image/png' || e.mime === 'image/jpeg') ?? [];
  const firstScreenshot = screenshots[0];

  if (!run) {
    return (
      <div className="loading-state-wrapper">
        <div className="spinner-lg" />
        <p className="loading-text">Loading test run data...</p>
      </div>
    );
  }

  const s = snap ?? run.progress;
  const active = run.active || (s ? !TERMINAL.includes(s.status) && !run.interrupted : false);
  const counts = (active ? s?.counts : undefined) ?? run.counts ?? s?.counts;

  async function act(fn: () => Promise<unknown>, successMsg?: string) {
    try {
      setError(null);
      await fn();
      await reload();
      onChange();
      if (successMsg) notify.success(successMsg);
    } catch (e) {
      setError((e as Error).message);
      notify.error((e as Error).message);
    }
  }

  return (
    <div className={`run-view-container ${active ? 'run-active' : ''}`}>
      {/* Evidence Lightbox Modal */}
      {activeEvidence && (
        <EvidenceModal
          evidence={activeEvidence.item}
          metadata={activeEvidence.meta}
          onClose={() => setActiveEvidence(null)}
        />
      )}

      {/* Top Header Card */}
      <header className="results-header-card">
        <div className="results-header-main">
          <div className="results-target-info">
            <div className="results-meta-strip">
              <span className="results-id-pill">{run.id}</span>
              <span className="results-meta-item">Mode: <strong>{run.mode.replace('_', ' ')}</strong></span>
              <span className="results-meta-item">
                Started: {new Date(run.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <h1 className="results-url">
              {run.url}
              <a href={run.url} target="_blank" rel="noreferrer" className="external-btn" title="Open target website">
                <IconExternalLink style={{ width: 14, height: 14 }} />
              </a>
            </h1>
          </div>

          <div className="results-header-actions">
            {!active && run.state === 'ABORTED' ? <span className="verdict-pill v-ABORTED">ABORTED</span> : run.verdict && !active && <VerdictBadge verdict={run.verdict} />}
            {active && (
              <button
                type="button"
                className="btn btn-danger btn-cta-stop"
                disabled={stopping}
                onClick={() => void stopRun()}
              >
                <IconStop style={{ width: 14, height: 14 }} />
                <span>{stopping ? 'STOPPING…' : 'STOP TEST'}</span>
              </button>
            )}

            {run.interrupted && !run.active && run.auth.source !== 'token' && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => act(() => api.resume(runId), 'Resuming test')}
              >
                <IconPlay style={{ width: 14, height: 14 }} />
                Resume Test
              </button>
            )}

            {run.interrupted && !run.active && run.auth.source === 'token' && !resumeOpen && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setResumeToken({ ...emptyToken(), location: (run.auth.location as TokenState['location']) ?? 'cookie' });
                  setResumeOpen(true);
                }}
              >
                Resume with Token…
              </button>
            )}

            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon"
              onClick={() => void reload()}
              title="Refresh findings"
            >
              <IconRefresh style={{ width: 14, height: 14 }} />
            </button>
          </div>
        </div>

        {/* Resume with token drawer */}
        {resumeOpen && (
          <form
            className="resume-drawer animated-reveal"
            autoComplete="off"
            onSubmit={(e) => {
              e.preventDefault();
              const auth = toDirectAuth(resumeToken);
              setResumeToken((t) => ({ ...t, token: '' }));
              if (!auth) {
                setError('Please paste the token to resume.');
                return;
              }
              void act(() => api.resume(runId, auth), 'Resumed run').then(() => setResumeOpen(false));
            }}
          >
            <p className="resume-notice">
              This run used a one-time token that was kept in server RAM only. Paste it again to resume testing.
            </p>
            <TokenFields value={resumeToken} onChange={setResumeToken} idPrefix="resume" />
            <div className="row gap mt-2">
              <button type="submit" className="btn btn-primary btn-sm">Resume Run</button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setResumeOpen(false);
                  setResumeToken(emptyToken());
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {/* Reports Download Bar */}
        {(run.reports.html || run.reports.json || run.reports.junit) && !active && (
          <div className="reports-bar">
            <span className="reports-bar-title">Generated Test Reports:</span>
            <div className="reports-links-group">
              {run.reports.html && (
                <a
                  href={`/api/runs/${runId}/report.html`}
                  target="_blank"
                  rel="noreferrer"
                  className="report-link-pill"
                >
                  <IconExternalLink style={{ width: 12, height: 12 }} />
                  <span>Interactive HTML Report</span>
                </a>
              )}
              {run.reports.json && (
                <a href={`/api/runs/${runId}/report.json`} className="report-link-pill">
                  <IconDownload style={{ width: 12, height: 12 }} />
                  <span>JSON Export</span>
                </a>
              )}
              {run.reports.junit && (
                <a href={`/api/runs/${runId}/report.xml`} className="report-link-pill">
                  <IconDownload style={{ width: 12, height: 12 }} />
                  <span>JUnit XML (CI/CD)</span>
                </a>
              )}
            </div>
          </div>
        )}
      </header>

      {/* Live Testing Experience (when active) */}
      {active && (
        <RunProgress
          runId={runId}
          snapshot={s}
          status={s?.status ?? run.status}
          url={run.url}
          startTime={run.createdAt}
          events={events}
          findings={uiFindings}
          onStop={() => void stopRun()}
          stopping={stopping}
        />
      )}

      {/* What happened, in plain numbers. They come from what is saved, so they are right for a stopped run too. */}
      {run.note && (
        <div className={`run-note ${run.state === 'ERROR' ? 'run-note-error' : ''}`}>
          <strong>{run.state === 'ERROR' ? 'FAILED' : 'ABORTED'}</strong> {run.note}
        </div>
      )}

      {!active && (
        <section className="completed-results-shell">
          <div className="completed-findings-heading">
            <h2>{distinctIssues} {distinctIssues === 1 ? 'Issue' : 'Issues'} Found</h2>
            <p>{totalOccurrences} total {totalOccurrences === 1 ? 'occurrence' : 'occurrences'}</p>
          </div>

          <div className="completed-results-layout">
            <section className="issue-list-panel">
              <div className="issue-list-toolbar">
                <div className="search-box issue-search">
                  <IconSearch style={{ width: 16, height: 16 }} className="search-icon" />
                  <input
                    type="text"
                    placeholder="Search issues..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="search-input"
                  />
                </div>
                <select
                  value={severityFilter}
                  onChange={(e) => setSeverityFilter(e.target.value)}
                  className="filter-select"
                  aria-label="Severity"
                >
                  <option value="all">All severity</option>
                  <option value="critical">Critical</option>
                  <option value="major">Major</option>
                  <option value="minor">Minor</option>
                  <option value="info">Info</option>
                </select>
              </div>

              <div className="issue-filter-chips" aria-label="Issue category filters">
                {[
                  ['all', 'All'],
                  ['layout', 'Layout'],
                  ['functional', 'Functional'],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={`issue-chip ${categoryFilter === value ? 'active' : ''}`}
                    onClick={() => setCategoryFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {completedIssueGroups.length === 0 ? (
                <div className="empty-state-box">
                  <h3 className="empty-state-title">{uiFindings.length === 0 ? 'No UI/UX issues found' : 'No matching issues'}</h3>
                  <p className="empty-state-desc">
                    {uiFindings.length === 0 ? 'The completed run did not report UI/UX defects.' : 'Try clearing search or filters.'}
                  </p>
                </div>
              ) : (
                <div className="issue-list">
                  {completedIssueGroups.map((group) => (
                    <article className={`issue-row ${selectedIssueKey === group.key ? 'selected' : ''}`} key={group.key}>
                      <div className="issue-severity">
                        <span className={`severity-badge s-${group.severity}`}>{group.severity.toUpperCase()}</span>
                      </div>
                      <div className="issue-row-main">
                        <h3>{issueTitle(group)}</h3>
                        <p>{issueExplanation(group)}</p>
                        <div className="issue-row-meta">
                          <span>{group.findings.length} {group.findings.length === 1 ? 'occurrence' : 'occurrences'}</span>
                          <span>{pageSummary(group.findings)}</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => {
                          setSelectedIssueKey(group.key);
                          setSelectedOccurrenceId(group.findings[0]?.id ?? null);
                        }}
                      >
                        View
                      </button>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <aside className={`issue-detail-drawer ${selectedIssue && selectedOccurrence ? 'open' : ''}`}>
              {selectedIssue && selectedOccurrence ? (
                <>
                  <div className="drawer-header">
                    <div>
                      <span className={`severity-badge s-${selectedIssue.severity}`}>{selectedIssue.severity.toUpperCase()}</span>
                      <h3>{issueTitle(selectedIssue)}</h3>
                    </div>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelectedIssueKey(null)}>Close</button>
                  </div>

                  {selectedIssue.findings.length > 1 && (
                    <div className="occurrence-selector">
                      {selectedIssue.findings.map((finding, index) => (
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
                    <div><span>Affected page</span><strong>{pathOf(selectedOccurrence.page)}</strong></div>
                    <div><span>Affected element</span><strong>{selectedOccurrence.element?.name || selectedOccurrence.element?.selector || 'Element not recorded'}</strong></div>
                    <div><span>Expected</span><p>{selectedOccurrence.expected}</p></div>
                    <div><span>Actual</span><p>{selectedOccurrence.actual}</p></div>
                  </div>

                  {firstScreenshot ? (
                    <button
                      type="button"
                      className="drawer-evidence-preview"
                      onClick={() => setActiveEvidence({ item: firstScreenshot, meta: { page: selectedOccurrence.page, viewport: selectedOccurrence.viewport, ruleId: selectedOccurrence.ruleId } })}
                    >
                      <img src={firstScreenshot.url} alt={firstScreenshot.label} />
                      <span>View screenshot</span>
                    </button>
                  ) : (
                    <div className="drawer-empty-evidence">No screenshot evidence attached to this occurrence.</div>
                  )}

                  <div className="drawer-disclosures">
                    <details>
                      <summary>Technical Details</summary>
                      <div className="technical-details-content">
                        <div>
                          <span>Rule ID</span>
                          <code>{selectedOccurrence.ruleId}</code>
                        </div>
                        <div>
                          <span>Measurements</span>
                          <p>{selectedOccurrence.actual}</p>
                        </div>
                        <div>
                          <span>Why this was flagged</span>
                          <p>{selectedOccurrence.basis || selectedOccurrence.context?.why || selectedOccurrence.expected}</p>
                        </div>
                        <div>
                          <span>DOM evidence</span>
                          <code>{selectedOccurrence.element?.selector || 'No selector recorded'}</code>
                        </div>
                        <div>
                          <span>Network / console evidence</span>
                          <p>Related network and console evidence remains available in the generated report and raw evidence.</p>
                        </div>
                        {selectedOccurrence.ai && (
                          <div>
                            <span>AI analysis</span>
                            <p>{selectedOccurrence.ai.explanation}</p>
                            <p>{selectedOccurrence.ai.likelyRootCause}</p>
                          </div>
                        )}
                      </div>
                      <FindingCard
                        finding={selectedOccurrence}
                        onDecide={(d, note) => act(() => api.decide(selectedOccurrence.id, d, note), `Decision saved: ${d}`)}
                        onApproveBaseline={(p, v) => act(() => api.approveBaseline(runId, p, v), 'Baseline approved')}
                        onViewEvidence={(item, meta) => setActiveEvidence({ item, meta })}
                      />
                    </details>
                  </div>
                </>
              ) : (
                <div className="drawer-placeholder">
                  <h3>Select an issue</h3>
                  <p>Choose the issue that looks most important to inspect its evidence without losing your place in the list.</p>
                </div>
              )}
            </aside>
          </div>
        </section>
      )}

      {!active && (
      <details className="advanced-test-details">
        <summary>Advanced Test Details</summary>
      <section className="metrics-grid">
        <div className="metric-card">
          <span className="metric-label">Status</span>
          <span className="metric-value">{active ? 'RUNNING' : run.state ?? run.status}</span>
          <span className="metric-sub">{active ? 'Results are saved as each element is tested' : run.state === 'ABORTED' ? 'Stopped before finishing' : run.state === 'COMPLETED' ? 'Finished' : ''}</span>
        </div>

        <div className="metric-card">
          <span className="metric-label">Pages</span>
          <span className="metric-value">{counts ? `${counts.pagesTested}/${counts.pagesCrawled}` : '0'}</span>
          <span className="metric-sub">tested / found</span>
        </div>

        <div className="metric-card">
          <span className="metric-label">Elements Tested</span>
          <span className="metric-value metric-value-brand">{counts?.elementsTested ?? 0}</span>
          <span className="metric-sub">buttons, links, controls, forms</span>
        </div>

        <div className="metric-card">
          <span className="metric-label">Passed</span>
          <span className="metric-value metric-value-success">{counts?.passed ?? 0}</span>
          <span className="metric-sub">worked; not listed as findings{(counts?.inconclusive ?? 0) > 0 ? ` · ${counts?.inconclusive} had no visible effect` : ''}</span>
        </div>

        <div className="metric-card">
          <span className="metric-label">Bugs</span>
          <span className="metric-value metric-value-danger">{counts?.bugs ?? 0}</span>
          <span className="metric-sub">{counts?.warnings ?? 0} warnings</span>
        </div>

        <div className="metric-card">
          <span className="metric-label">Needs Review</span>
          <span className="metric-value">{counts?.needsReview ?? 0}</span>
          <span className="metric-sub">could not be decided</span>
        </div>

        {(active || run.state === 'ABORTED' || (counts?.notTestedPages ?? 0) + (counts?.notTestedElements ?? 0) > 0) && (
          <div className="metric-card">
            <span className="metric-label">Not Tested</span>
            <span className="metric-value">{counts?.notTestedPages ?? 0}</span>
            <span className="metric-sub">pages{(counts?.notTestedElements ?? 0) > 0 ? ` · ${counts?.notTestedElements} elements on started pages` : ''}</span>
          </div>
        )}
      </section>


      {/* Severity Breakdown Bar */}
      {uiFindings.length > 0 && (
        <div className="visual-distribution-card">
          <div className="dist-header">
            <span className="dist-title">Findings Severity Distribution</span>
            <div className="dist-legend">
              <span className="legend-item"><span className="legend-dot bg-critical" /> Critical ({severityCounts.critical})</span>
              <span className="legend-item"><span className="legend-dot bg-major" /> Major ({severityCounts.major})</span>
              <span className="legend-item"><span className="legend-dot bg-minor" /> Minor ({severityCounts.minor})</span>
              <span className="legend-item"><span className="legend-dot bg-info" /> Info ({severityCounts.info})</span>
            </div>
          </div>
          <div className="distribution-bar-track">
            {severityCounts.critical > 0 && (
              <div
                className="dist-segment bg-critical"
                style={{ width: `${(severityCounts.critical / uiFindings.length) * 100}%` }}
                title={`Critical: ${severityCounts.critical}`}
              />
            )}
            {severityCounts.major > 0 && (
              <div
                className="dist-segment bg-major"
                style={{ width: `${(severityCounts.major / uiFindings.length) * 100}%` }}
                title={`Major: ${severityCounts.major}`}
              />
            )}
            {severityCounts.minor > 0 && (
              <div
                className="dist-segment bg-minor"
                style={{ width: `${(severityCounts.minor / uiFindings.length) * 100}%` }}
                title={`Minor: ${severityCounts.minor}`}
              />
            )}
            {severityCounts.info > 0 && (
              <div
                className="dist-segment bg-info"
                style={{ width: `${(severityCounts.info / uiFindings.length) * 100}%` }}
                title={`Info: ${severityCounts.info}`}
              />
            )}
          </div>
        </div>
      )}

      {/* Interactive Category Filter Cards */}
      <section className="categories-section">
        <div className="categories-header">
          <h3 className="categories-title">Findings by Category</h3>
          <span className="categories-subtitle">Click a category card to quickly filter the findings below</span>
        </div>

        <div className="category-cards-grid">
          {allCategories.map((catKey) => {
            const count = categoryCounts[catKey] || s?.categories?.[catKey] || 0;
            const meta = CATEGORY_META[catKey] || { label: catKey, icon: '🔍', desc: 'Category findings' };
            const isSelected = categoryFilter === catKey;

            return (
              <button
                key={catKey}
                type="button"
                className={`category-summary-card ${isSelected ? 'cat-card-selected' : ''}`}
                onClick={() => {
                  if (catKey === 'accessibility') { setTab('accessibility'); return; }
                  setTab('findings');
                  setCategoryFilter(isSelected ? 'all' : catKey);
                }}
              >
                <div className="cat-card-top">
                  <span className="cat-icon">{meta.icon}</span>
                  <span className={`cat-count-badge ${count > 0 ? 'count-active' : ''}`}>{count}</span>
                </div>
                <div className="cat-card-name">{meta.label}</div>
                <div className="cat-card-desc">{meta.desc}</div>
              </button>
            );
          })}
        </div>
      </section>

      {/* Main Tabs Navigation */}
      <div className="main-tabs-bar">
        <button
          type="button"
          className={`main-tab-item ${tab === 'findings' ? 'main-tab-active' : ''}`}
          onClick={() => setTab('findings')}
        >
          <IconLayers style={{ width: 15, height: 15 }} />
          <span>UI/UX Findings</span>
          <span className="tab-counter-badge">{uiFindings.length}</span>
        </button>

        {showA11y && (
          <button
            type="button"
            className={`main-tab-item ${tab === 'accessibility' ? 'main-tab-active' : ''}`}
            onClick={() => setTab('accessibility')}
          >
            <IconInfo style={{ width: 15, height: 15 }} />
            <span>Accessibility</span>
            <span className="tab-counter-badge">{a11yFindings.length}</span>
          </button>
        )}

        {dynamic && dynamic.pages.length > 0 && (
          <button
            type="button"
            className={`main-tab-item ${tab === 'selection' ? 'main-tab-active' : ''}`}
            onClick={() => setTab('selection')}
          >
            <IconFilter style={{ width: 15, height: 15 }} />
            <span>Tested Elements</span>
            <span className="tab-counter-badge">{dynamic.pages.length}</span>
          </button>
        )}

        <button
          type="button"
          className={`main-tab-item ${tab === 'review' ? 'main-tab-active' : ''}`}
          onClick={() => setTab('review')}
        >
          <IconShield style={{ width: 15, height: 15 }} />
          <span>Review Queue</span>
          <span className={`tab-counter-badge ${queue.length > 0 ? 'badge-review-alert' : ''}`}>
            {queue.length}
          </span>
        </button>

        <button
          type="button"
          className={`main-tab-item ${tab === 'activity' ? 'main-tab-active' : ''}`}
          onClick={() => setTab('activity')}
        >
          <IconTerminal style={{ width: 15, height: 15 }} />
          <span>Activity Stream</span>
          {events.length > 0 && <span className="tab-counter-badge">{events.length}</span>}
        </button>
      </div>

      {/* TAB 1: ALL FINDINGS */}
      {tab === 'findings' && (
        <div className="tab-findings-content animated-reveal">
          {/* Sticky Filtering & Search Toolbar */}
          <div className="findings-toolbar">
            <div className="search-box">
              <IconSearch style={{ width: 16, height: 16 }} className="search-icon" />
              <input
                type="text"
                placeholder="Search findings by rule, text, page URL, or CSS selector..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="search-input"
              />
              {search && (
                <button type="button" className="btn-clear-search" onClick={() => setSearch('')}>
                  ✕
                </button>
              )}
            </div>

            <div className="toolbar-filters-row">
              {/* Severity Pills */}
              <div className="filter-pills-group">
                <span className="filter-group-label">Severity:</span>
                {['all', 'critical', 'major', 'minor', 'info'].map((sev) => (
                  <button
                    key={sev}
                    type="button"
                    className={`filter-pill ${severityFilter === sev ? 'pill-active' : ''}`}
                    onClick={() => setSeverityFilter(sev)}
                  >
                    {sev}
                  </button>
                ))}
              </div>

              {/* Category Dropdown */}
              <div className="filter-select-group">
                <span className="filter-group-label">Category:</span>
                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  className="filter-select"
                >
                  <option value="all">All Categories</option>
                  {allCategories.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_META[c]?.label || c} ({categoryCounts[c] || 0})
                    </option>
                  ))}
                </select>
              </div>

              {/* Status Dropdown */}
              <div className="filter-select-group">
                <span className="filter-group-label">State:</span>
                <select
                  value={stateFilter}
                  onChange={(e) => setStateFilter(e.target.value)}
                  className="filter-select"
                >
                  <option value="all">All States</option>
                  <option value="defect">Defect (Confirmed)</option>
                  <option value="pending">Pending Review</option>
                  <option value="confirmed">Human Confirmed</option>
                  <option value="dismissed">Dismissed</option>
                  <option value="investigating">Under Investigation</option>
                </select>
              </div>

              {/* Sort Order */}
              <div className="filter-select-group">
                <span className="filter-group-label">Sort:</span>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                  className="filter-select"
                >
                  <option value="severity">Highest Severity</option>
                  <option value="category">Category</option>
                  <option value="page">Page URL</option>
                  <option value="newest">Order Discovered</option>
                </select>
              </div>

              {(search || severityFilter !== 'all' || categoryFilter !== 'all' || stateFilter !== 'all') && (
                <button
                  type="button"
                  className="btn-text btn-text-brand"
                  onClick={() => {
                    setSearch('');
                    setSeverityFilter('all');
                    setCategoryFilter('all');
                    setStateFilter('all');
                  }}
                >
                  Reset Filters
                </button>
              )}
            </div>

            <div className="results-count-banner" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
              <div>
                Showing <strong>{filteredFindings.length}</strong> of <strong>{uiFindings.length}</strong> UI/UX findings
                {viewMode === 'grouped' && ` (${groupedFindings.length} distinct problems)`}
              </div>

              <div className="view-mode-toggle">
                <button
                  type="button"
                  className={`view-mode-btn ${viewMode === 'grouped' ? 'active' : ''}`}
                  onClick={() => setViewMode('grouped')}
                  title="Group repeated issues by rule type"
                >
                  📁 Group by Issue Type ({groupedFindings.length})
                </button>
                <button
                  type="button"
                  className={`view-mode-btn ${viewMode === 'flat' ? 'active' : ''}`}
                  onClick={() => setViewMode('flat')}
                  title="Show all individual finding logs"
                >
                  📄 All Finding Cards ({filteredFindings.length})
                </button>
              </div>
            </div>
          </div>

          {/* Findings List */}
          {uiFindings.length === 0 && (run?.status === 'ERROR' || (run?.status === 'ABORTED' && (run.summary?.pages ?? 0) === 0)) ? (
            <div className="empty-state-box">
              <div className="empty-state-icon">
                <IconAlertCircle style={{ width: 36, height: 36 }} className="text-danger" />
              </div>
              <h3 className="empty-state-title">Run failed: nothing was tested</h3>
              <p className="empty-state-desc">
                {run.error || run.abortReason || 'The run stopped before any page could be tested.'} No findings here does not mean the site is clean.
              </p>
            </div>
          ) : filteredFindings.length === 0 ? (
            <div className="empty-state-box">
              <div className="empty-state-icon">
                <IconCheck style={{ width: 36, height: 36 }} className="text-success" />
              </div>
              <h3 className="empty-state-title">No matching findings found</h3>
              <p className="empty-state-desc">
                {uiFindings.length === 0
                  ? (run?.summary?.pages ?? 0) > 0
                    ? `${run?.state === 'ABORTED' ? 'The run was stopped. ' : ''}No UI/UX issues were detected on the ${run?.summary?.pages} page(s) tested${run?.state === 'ABORTED' ? ' before it stopped' : ' in this run'}.${a11yFindings.length ? ` ${a11yFindings.length} accessibility finding(s) are listed in the Accessibility tab.` : ''}`
                    : run?.state === 'ABORTED' ? 'The run was stopped before a page was finished. See the counts above for what was tested.' : 'No findings yet.'
                  : 'Try clearing your search query or broadening your filters.'}
              </p>
            </div>
          ) : viewMode === 'grouped' ? (
            <div className="findings-grouped-stream">
              {groupedFindings.map((group) => {
                const isExpanded = !!expandedRules[group.key];
                return (
                  <div key={group.key} className="rule-group-card">
                    <div className="rule-group-header" onClick={() => toggleRuleExpand(group.key)}>
                      <div className="rule-group-title-row">
                        <div className="rule-group-badges">
                          <span className={`severity-badge s-${group.severity}`}>
                            {group.severity.toUpperCase()}
                          </span>
                          <span className="badge badge-neutral" style={{ textTransform: 'capitalize' }}>
                            {group.category}
                          </span>
                          <span className="rule-group-id">{group.ruleId}</span>
                        </div>
                        <div className="rule-group-meta">
                          <span className="rule-count-pill">
                            {group.findings.length} {group.findings.length === 1 ? 'occurrence' : 'occurrences'}
                            {group.uniqueElements > 1 && ` (${group.uniqueElements} elements)`}
                          </span>
                          <div className="viewport-pills-row">
                            {Array.from(group.viewports).map((vp) => (
                              <span key={vp} className="vp-pill">@{vp}</span>
                            ))}
                          </div>
                          <button
                            type="button"
                            className="btn-toggle-expand"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleRuleExpand(group.key);
                            }}
                          >
                            {isExpanded ? 'Collapse ▲' : `View ${group.findings.length} instances ▼`}
                          </button>
                        </div>
                      </div>
                      <div className="rule-group-desc">{group.expected}</div>
                    </div>

                    {isExpanded && (
                      <div className="rule-group-instances">
                        {group.findings.map((f) => (
                          <FindingCard
                            key={f.id}
                            finding={f}
                            onDecide={(d, note) => act(() => api.decide(f.id, d, note), `Decision saved: ${d}`)}
                            onApproveBaseline={(p, v) => act(() => api.approveBaseline(runId, p, v), 'Baseline approved')}
                            onViewEvidence={(item, meta) => setActiveEvidence({ item, meta })}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="findings-stream">
              {filteredFindings.map((f) => (
                <FindingCard
                  key={f.id}
                  finding={f}
                  onDecide={(d, note) => act(() => api.decide(f.id, d, note), `Decision saved: ${d}`)}
                  onApproveBaseline={(p, v) => act(() => api.approveBaseline(runId, p, v), 'Baseline approved')}
                  onViewEvidence={(item, meta) => setActiveEvidence({ item, meta })}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: REVIEW QUEUE */}
      {/* TAB: accessibility findings, kept apart from UI/UX bugs */}
      {tab === 'accessibility' && (
        <div className="tab-findings-content animated-reveal">
          <div className="a11y-banner">
            <strong>Accessibility findings are a separate category from UI/UX bugs.</strong> An element listed here may look and work
            correctly and still be hard or impossible to use with a screen reader or keyboard (for example an icon-only button with no
            accessible name). {dynamic?.accessibility.failRun ? 'Accessibility is required for this run, so these findings affect the verdict.' : 'They do not affect this run\'s verdict.'}
          </div>
          {a11yFindings.length === 0 ? (
            <div className="empty-state-box">
              <h3 className="empty-state-title">No accessibility findings</h3>
              <p className="empty-state-desc">{dynamic && !dynamic.accessibility.enabled ? 'Accessibility checks were switched off for this run.' : 'The automated accessibility checks reported nothing on the tested pages.'}</p>
            </div>
          ) : (
            <div className="findings-stream">
              {a11yFindings.map((f) => (
                <FindingCard
                  key={f.id}
                  finding={f}
                  onDecide={(d, note) => act(() => api.decide(f.id, d, note), `Decision saved: ${d}`)}
                  onApproveBaseline={(p, v) => act(() => api.approveBaseline(runId, p, v), 'Baseline approved')}
                  onViewEvidence={(item, meta) => setActiveEvidence({ item, meta })}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB: what was detected per page and which tests were selected/skipped */}
      {tab === 'selection' && dynamic && (
        <div className="animated-reveal">
          <DynamicPanel data={dynamic} />
        </div>
      )}

      {tab === 'review' && (
        <div className="tab-review-content animated-reveal">
          <ReviewQueueWizard
            queue={queue}
            onDecide={(fId, d, note) => act(() => api.decide(fId, d, note), `Decision saved: ${d}`)}
            onApproveBaseline={(p, v) => act(() => api.approveBaseline(runId, p, v), 'Baseline approved')}
            onViewEvidence={(item, meta) => setActiveEvidence({ item, meta })}
          />
        </div>
      )}

      {/* TAB 3: ACTIVITY STREAM */}
      {tab === 'activity' && (
        <div className="tab-activity-content animated-reveal">
          <div className="activity-terminal-card">
            <div className="terminal-header">
              <div className="row gap">
                <span className="term-dot red" />
                <span className="term-dot yellow" />
                <span className="term-dot green" />
                <span className="terminal-title">Live Execution Activity Stream</span>
              </div>
              <span className="badge badge-neutral">{events.length} events logged</span>
            </div>

            <div className="terminal-logs-window">
              {events.length === 0 ? (
                <div className="p-4 muted text-center">No execution log events recorded yet.</div>
              ) : (
                events
                  .slice()
                  .reverse()
                  .map((ev) => (
                    <div key={ev.seq} className={`terminal-log-line log-type-${ev.type}`}>
                      <span className="log-time">{new Date(ev.at).toLocaleTimeString()}</span>
                      <span className="log-type-tag">[{ev.type.toUpperCase()}]</span>
                      <span className="log-msg">{ev.message}</span>
                    </div>
                  ))
              )}
            </div>
          </div>
        </div>
      )}
      </details>
      )}
    </div>
  );
}
