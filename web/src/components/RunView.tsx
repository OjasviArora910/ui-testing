import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Finding, type ProgressEvent, type Run, type Severity, type Snapshot } from '../api';
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

type MainTab = 'findings' | 'review' | 'activity';

const TERMINAL = ['COMPLETED', 'ABORTED', 'ERROR', 'REVIEW'];

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
  const [error, setError] = useState<string | null>(null);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeToken, setResumeToken] = useState<TokenState>(emptyToken);
  const [activeEvidence, setActiveEvidence] = useState<{
    item: EvidenceItem;
    meta: { page: string; viewport: string; ruleId: string };
  } | null>(null);
  const loadedFinal = useRef(false);

  const toggleRuleExpand = (ruleId: string) => {
    setExpandedRules((prev) => ({ ...prev, [ruleId]: !prev[ruleId] }));
  };

  const reload = useCallback(async () => {
    try {
      const r = await api.run(runId);
      setRun(r);
      if (r.progress) setSnap(r.progress);
      const [q, f] = await Promise.all([api.queue(runId), api.findings(runId)]);
      setQueue(q);
      setFindings(f);
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

  // Filtered & Sorted findings
  const filteredFindings = useMemo(() => {
    return findings
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
  }, [findings, severityFilter, categoryFilter, stateFilter, search, sortBy]);

  // Grouped findings by rule ID
  const groupedFindings = useMemo(() => {
    const map = new Map<string, {
      ruleId: string;
      category: string;
      severity: Severity;
      expected: string;
      findings: Finding[];
      viewports: Set<string>;
      uniqueElements: number;
    }>();

    for (const f of filteredFindings) {
      const existing = map.get(f.ruleId);
      if (existing) {
        existing.findings.push(f);
        existing.viewports.add(f.viewport);
        const order: Severity[] = ['critical', 'major', 'minor', 'info'];
        if (order.indexOf(f.severity) < order.indexOf(existing.severity)) {
          existing.severity = f.severity;
        }
      } else {
        map.set(f.ruleId, {
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

    const rank: Record<Severity, number> = { critical: 4, major: 3, minor: 2, info: 1 };
    return groups.sort((a, b) => (rank[b.severity] || 0) - (rank[a.severity] || 0) || b.findings.length - a.findings.length);
  }, [filteredFindings]);

  // Severity metrics breakdown
  const severityCounts = useMemo(() => {
    const counts = { critical: 0, major: 0, minor: 0, info: 0 };
    for (const f of findings) {
      if (f.severity in counts) counts[f.severity as keyof typeof counts]++;
    }
    return counts;
  }, [findings]);

  // Category counts
  const categoryCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const f of findings) {
      map[f.category] = (map[f.category] || 0) + 1;
    }
    return map;
  }, [findings]);

  const allCategories = ['layout', 'functional', 'accessibility', 'network', 'usability', 'responsive', 'performance'];

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
    <div className="run-view-container">
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
            {run.verdict && !active && <VerdictBadge verdict={run.verdict} />}
            {active && (
              <button
                type="button"
                className="btn btn-danger btn-cta-stop"
                onClick={() => act(() => api.stop(runId), 'Stop request sent')}
              >
                <IconStop style={{ width: 14, height: 14 }} />
                <span>STOP TEST</span>
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
          onStop={() => act(() => api.stop(runId), 'Stop requested')}
        />
      )}

      {/* Hero Metrics Row */}
      <section className="metrics-grid">
        <div className="metric-card">
          <span className="metric-label">Execution Status</span>
          <span className="metric-value">{s?.status ?? run.status}</span>
          <span className="metric-sub">{active ? 'In progress' : run.finishedAt ? 'Completed run' : 'Finished'}</span>
        </div>

        <div className="metric-card">
          <span className="metric-label">Pages Crawled</span>
          <span className="metric-value">{s?.pagesDiscovered ?? run.summary?.pages ?? 0}</span>
          <span className="metric-sub">Same-origin routes</span>
        </div>

        <div className="metric-card">
          <span className="metric-label">Pages Tested</span>
          <span className="metric-value">
            {s ? `${s.unitsDone}/${s.unitsTotal}` : `${run.summary?.pages ?? 0}`}
          </span>
          <span className="metric-sub">Desktop (1440 × 900)</span>
        </div>

        <div className="metric-card">
          <span className="metric-label">Total Findings</span>
          <span className="metric-value metric-value-danger">{findings.length || (s?.findings ?? 0)}</span>
          <span className="metric-sub">
            {run.summary?.defects ?? 0} defects · {queue.length} pending review
          </span>
        </div>

        <div className="metric-card">
          <span className="metric-label">ActionGuard Blocked</span>
          <span className="metric-value metric-value-brand">{run.summary?.guardBlocked ?? 0}</span>
          <span className="metric-sub">Destructive writes prevented</span>
        </div>
      </section>


      {/* Severity Breakdown Bar */}
      {findings.length > 0 && (
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
                style={{ width: `${(severityCounts.critical / findings.length) * 100}%` }}
                title={`Critical: ${severityCounts.critical}`}
              />
            )}
            {severityCounts.major > 0 && (
              <div
                className="dist-segment bg-major"
                style={{ width: `${(severityCounts.major / findings.length) * 100}%` }}
                title={`Major: ${severityCounts.major}`}
              />
            )}
            {severityCounts.minor > 0 && (
              <div
                className="dist-segment bg-minor"
                style={{ width: `${(severityCounts.minor / findings.length) * 100}%` }}
                title={`Minor: ${severityCounts.minor}`}
              />
            )}
            {severityCounts.info > 0 && (
              <div
                className="dist-segment bg-info"
                style={{ width: `${(severityCounts.info / findings.length) * 100}%` }}
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
          <span>All Findings</span>
          <span className="tab-counter-badge">{findings.length}</span>
        </button>

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
                Showing <strong>{filteredFindings.length}</strong> of <strong>{findings.length}</strong> findings
                {viewMode === 'grouped' && ` (grouped into ${groupedFindings.length} distinct issue types)`}
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
          {filteredFindings.length === 0 ? (
            <div className="empty-state-box">
              <div className="empty-state-icon">
                <IconCheck style={{ width: 36, height: 36 }} className="text-success" />
              </div>
              <h3 className="empty-state-title">No matching findings found</h3>
              <p className="empty-state-desc">
                {findings.length === 0
                  ? 'No issues were detected during this QA run. Everything verified cleanly!'
                  : 'Try clearing your search query or broadening your filters.'}
              </p>
            </div>
          ) : viewMode === 'grouped' ? (
            <div className="findings-grouped-stream">
              {groupedFindings.map((group) => {
                const isExpanded = !!expandedRules[group.ruleId];
                return (
                  <div key={group.ruleId} className="rule-group-card">
                    <div className="rule-group-header" onClick={() => toggleRuleExpand(group.ruleId)}>
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
                              toggleRuleExpand(group.ruleId);
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
    </div>
  );
}
