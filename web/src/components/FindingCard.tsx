import { useState } from 'react';
import type { Decision, Finding } from '../api';
import type { EvidenceItem } from './EvidenceModal';
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCode,
  IconCritical,
  IconExternalLink,
  IconEye,
  IconInfo,
  IconSparkles,
} from './Icons';

// ─── Evidence categorisation helpers ─────────────────────────────────────────
type EvidenceRef = Finding['evidence'][number];
const getHighlightImg = (ev: EvidenceRef[]) =>
  ev.find((e) => (e.mime === 'image/png' || e.mime === 'image/jpeg') && e.label.toLowerCase().includes('highlighted'));
const getInteractionImg = (ev: EvidenceRef[]) =>
  ev.find((e) => (e.mime === 'image/png' || e.mime === 'image/jpeg') && (e.label.toLowerCase().includes('interaction') || e.label.toLowerCase().includes('after') || e.label.toLowerCase().includes('error state')));
const getFullPageImg = (ev: EvidenceRef[]) =>
  ev.find((e) => (e.mime === 'image/png' || e.mime === 'image/jpeg') && (e.label.toLowerCase().includes('full page') || e.label.toLowerCase().includes('full-page') || e.label.toLowerCase().includes('current screenshot') || e.kind === 'screenshot')) ??
  ev.find((e) => (e.mime === 'image/png' || e.mime === 'image/jpeg') && !e.label.toLowerCase().includes('highlighted') && !e.label.toLowerCase().includes('interaction') && !e.label.toLowerCase().includes('after') && !e.label.toLowerCase().includes('error state'));
const getBeforeImg = (ev: EvidenceRef[]) =>
  ev.find((e) => (e.mime === 'image/png' || e.mime === 'image/jpeg') && (e.label.toLowerCase().includes('before') || e.label.toLowerCase().includes('baseline')));
const allImages = (ev: EvidenceRef[]) => ev.filter((e) => e.mime === 'image/png' || e.mime === 'image/jpeg');
const allFiles  = (ev: EvidenceRef[]) => ev.filter((e) => e.mime !== 'image/png' && e.mime !== 'image/jpeg');

// ─── Semantic rule explanation ────────────────────────────────────────────────
function getSemanticRows(ruleId: string, element: Finding['element'], actual: string): Array<{ field: string; value: string; status: 'fail' | 'warn' | 'ok' | 'info' }> {
  if (!element) return [];
  const rows: Array<{ field: string; value: string; status: 'fail' | 'warn' | 'ok' | 'info' }> = [];
  switch (ruleId) {
    case 'a11y.button-name':
      rows.push({ field: 'Role', value: element.role ?? 'button', status: 'info' });
      rows.push({ field: 'Accessible Name', value: element.name?.trim() ? `"${element.name}"` : '⚠ EMPTY — no accessible name computed', status: element.name?.trim() ? 'ok' : 'fail' });
      rows.push({ field: 'Failure Reason', value: 'Screen readers will announce this button as "button" with no name. Users cannot tell what it does.', status: 'fail' });
      break;
    case 'a11y.label-title-only':
      rows.push({ field: 'Role', value: element.role ?? 'textbox', status: 'info' });
      rows.push({ field: 'Visible Label', value: '⚠ NONE — no <label> element is visible in the DOM', status: 'fail' });
      rows.push({ field: 'aria-label', value: '⚠ MISSING', status: 'fail' });
      rows.push({ field: 'title attribute', value: '✓ Present (used as fallback — not sufficient)', status: 'warn' });
      rows.push({ field: 'Failure Reason', value: 'The title attribute is not reliably announced by all screen readers and is invisible to sighted keyboard users. A <label> or aria-label is required.', status: 'fail' });
      break;
    case 'a11y.image-alt':
      rows.push({ field: 'Role', value: element.role ?? 'img', status: 'info' });
      rows.push({ field: 'alt attribute', value: '⚠ MISSING or EMPTY', status: 'fail' });
      rows.push({ field: 'Failure Reason', value: 'Screen readers cannot describe this image. Assistive technology users receive no information about the image content.', status: 'fail' });
      break;
    case 'a11y.color-contrast':
      rows.push({ field: 'Role', value: element.role ?? 'text node', status: 'info' });
      rows.push({ field: 'Contrast Ratio', value: actual.match(/\d+\.\d+:\d+/)?.[0] ?? 'Below minimum threshold', status: 'fail' });
      rows.push({ field: 'WCAG Minimum (AA)', value: '4.5:1 for normal text, 3:1 for large text', status: 'info' });
      rows.push({ field: 'Failure Reason', value: 'Text is not readable against its background for users with low vision or color blindness.', status: 'fail' });
      break;
    default:
      if (element.role) rows.push({ field: 'Role', value: element.role, status: 'info' });
      if (element.name) rows.push({ field: 'Accessible Name', value: `"${element.name}"`, status: 'info' });
      break;
  }
  return rows;
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function EvidenceImage({ img, caption, badge, finding, onViewEvidence }: { img: EvidenceRef; caption: string; badge?: string; finding: Finding; onViewEvidence?: (item: EvidenceItem, meta: { page: string; viewport: string; ruleId: string }) => void }) {
  return (
    <div className="evidence-block">
      {badge && <div className="evidence-block-badge">{badge}</div>}
      <div className="evidence-block-img-wrap" onClick={() => onViewEvidence?.(img, { page: finding.page, viewport: finding.viewport, ruleId: finding.ruleId })}>
        <img src={img.url} alt={caption} loading="lazy" />
        <div className="thumb-hover-overlay"><IconEye style={{ width: 22, height: 22 }} /><span>Click to expand</span></div>
      </div>
      <div className="evidence-block-caption"><IconEye style={{ width: 12, height: 12 }} className="text-muted" /><span>{caption}</span></div>
    </div>
  );
}

function SemanticTable({ rows }: { rows: ReturnType<typeof getSemanticRows> }) {
  if (rows.length === 0) return null;
  return (
    <div className="semantic-table">
      {rows.map((r, i) => (
        <div key={i} className={`semantic-row st-${r.status}`}>
          <span className="semantic-field">{r.field}</span>
          <span className="semantic-value">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

const DECISIONS: { d: Decision; label: string; cls: string; desc: string }[] = [
  { d: 'CONFIRM_BUG', label: 'Confirm Bug', cls: 'btn-decision-bug', desc: 'Promotes this finding to a verified defect' },
  { d: 'NOT_A_BUG', label: 'Not a Bug', cls: 'btn-decision-dismiss', desc: 'Dismisses as false positive' },
  { d: 'EXPECTED_BEHAVIOR', label: 'Expected Behavior', cls: 'btn-decision-expected', desc: 'Intended application behavior' },
  { d: 'NEEDS_INVESTIGATION', label: 'Investigate', cls: 'btn-decision-investigate', desc: 'Mark for manual deep dive' },
];

const pathOf = (u: string) => {
  try {
    const x = new URL(u);
    return x.pathname + x.search + x.hash;
  } catch {
    return u;
  }
};

type CardTab = 'overview' | 'ai' | 'dom';

interface FindingCardProps {
  finding: Finding;
  onDecide: (d: Decision, note?: string) => void;
  onApproveBaseline: (page: string, viewport: string) => void;
  onViewEvidence?: (item: EvidenceItem, meta: { page: string; viewport: string; ruleId: string }) => void;
  defaultExpanded?: boolean;
}

export function FindingCard({
  finding: f,
  onDecide,
  onApproveBaseline,
  onViewEvidence,
  defaultExpanded = false,
}: FindingCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [activeTab, setActiveTab] = useState<CardTab>('overview');
  const [showFullPage, setShowFullPage] = useState(false);
  const [note, setNote] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const interactionImg = getInteractionImg(f.evidence);
  const highlightImg   = getHighlightImg(f.evidence);
  const fullPageImg    = getFullPageImg(f.evidence);
  const beforeImg      = getBeforeImg(f.evidence);
  const images         = allImages(f.evidence);
  const files          = allFiles(f.evidence);

  const isFunctional = f.category === 'functional' || !!interactionImg;
  const isA11y       = f.track ? f.track === 'accessibility' : f.category === 'accessibility' || f.ruleId.startsWith('a11y.');
  const semanticRows = getSemanticRows(f.ruleId, f.element, f.actual);

  const getSeverityIcon = (sev: string) => {
    switch (sev) {
      case 'critical': return <IconCritical style={{ width: 14, height: 14 }} />;
      case 'major':    return <IconAlertTriangle style={{ width: 14, height: 14 }} />;
      case 'minor':    return <IconAlertCircle style={{ width: 14, height: 14 }} />;
      default:         return <IconInfo style={{ width: 14, height: 14 }} />;
    }
  };

  const handleDecision = async (d: Decision) => {
    setIsSubmitting(true);
    try {
      await onDecide(d, note);
      setNote('');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <article className={`finding-card ${isA11y ? 'track-a11y' : `sev-${f.severity}`} ${expanded ? 'finding-expanded' : ''}`}>
      {/* Clickable Header Bar */}
      <div className="finding-header" onClick={() => setExpanded(!expanded)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setExpanded(!expanded)}>
        <div className="finding-header-left">
          <span className="finding-expand-icon">
            {expanded ? <IconChevronDown style={{ width: 16, height: 16 }} /> : <IconChevronRight style={{ width: 16, height: 16 }} />}
          </span>
          <span className={`severity-badge s-${f.severity}`}>
            {getSeverityIcon(f.severity)}
            <span>{f.severity}</span>
          </span>
          {isA11y ? (
            <span className="result-class rc-ACCESSIBILITY">Accessibility</span>
          ) : f.resultClass ? (
            <span className={`result-class rc-${f.resultClass}`}>{f.resultClass === 'BUG' ? 'confirmed bug' : f.resultClass.replace(/_/g, ' ').toLowerCase()}</span>
          ) : null}
          <span className="category-pill">{f.category}</span>
          <span className="finding-rule-title">{f.ruleId}</span>
        </div>

        <div className="finding-header-right">
          <span className={`review-state-pill st-${f.reviewState}`}>
            {f.reviewState}
          </span>
          <span className="finding-page-tag" title={f.page}>
            <code>{pathOf(f.page)}</code> @ {f.viewport}
          </span>
        </div>
      </div>

      {/* Target Element Snippet */}
      {f.element && (
        <div className="finding-element-bar">
          <IconCode style={{ width: 13, height: 13 }} className="text-muted" />
          <code className="element-selector" title={f.element.selector}>{f.element.selector}</code>
          {f.ruleId === 'a11y.button-name' && (
            <span className="badge badge-danger">Accessible name: EMPTY</span>
          )}
          {f.element.name && f.element.name !== 'Accessible name: EMPTY' && (
            <span className="element-name">"{f.element.name}"</span>
          )}
          {f.element.role && <span className="badge badge-subtle">role={f.element.role}</span>}
        </div>
      )}

      {/* Actual concise description preview when collapsed */}
      {!expanded && (
        <div className="finding-preview-text" onClick={() => setExpanded(true)}>
          <span className="preview-label">Actual:</span> {f.actual}
        </div>
      )}

      {/* Expanded Content with Tabs */}
      {expanded && (
        <div className="finding-body animated-reveal">
          {/* ── Tabs ── */}
          <div className="card-tabs">
            <button type="button" className={`card-tab-btn ${activeTab === 'overview' ? 'card-tab-active' : ''}`} onClick={() => setActiveTab('overview')}>
              {isA11y ? 'Accessibility Report' : 'Finding Report'}
            </button>
            <button type="button" className={`card-tab-btn ${activeTab === 'ai' ? 'card-tab-active' : ''}`} onClick={() => setActiveTab('ai')}>
              <IconSparkles style={{ width: 13, height: 13 }} /> AI Root Cause
            </button>
            <button type="button" className={`card-tab-btn ${activeTab === 'dom' ? 'card-tab-active' : ''}`} onClick={() => setActiveTab('dom')}>
              <IconCode style={{ width: 13, height: 13 }} /> DOM &amp; Logs
            </button>
          </div>

          {/* ━━━━ TAB: DEFECT REPORT ━━━━ */}
          {activeTab === 'overview' && (
            <div className="tab-pane">

              {/* ① Expected vs Actual */}
              <div className="comparison-grid">
                <div className="comparison-card comp-expected">
                  <div className="comp-label">
                    <IconCheck style={{ width: 14, height: 14 }} className="text-success" />
                    Expected Behavior
                  </div>
                  <div className="comp-text">{f.expected}</div>
                </div>
                <div className="comparison-card comp-actual">
                  <div className="comp-label">
                    <IconAlertCircle style={{ width: 14, height: 14 }} className="text-danger" />
                    Actual Observation
                  </div>
                  <div className="comp-text">{f.actual}</div>
                </div>
              </div>

              {/* ② Functional: Before → After/Error state */}
              {isFunctional && (interactionImg || beforeImg) && (
                <div className="evidence-section">
                  <div className="evidence-section-title">
                    <span className="evidence-step-num">②</span>
                    Interaction Evidence
                  </div>
                  <div className="evidence-flow-row">
                    {beforeImg && (
                      <EvidenceImage img={beforeImg} caption="Before interaction" badge="BEFORE" finding={f} onViewEvidence={onViewEvidence} />
                    )}
                    {beforeImg && interactionImg && <div className="evidence-flow-arrow">→</div>}
                    {interactionImg && (
                      <EvidenceImage img={interactionImg} caption={interactionImg.label} badge="💥 ERROR / AFTER STATE" finding={f} onViewEvidence={onViewEvidence} />
                    )}
                  </div>
                </div>
              )}

              {/* ② A11y / Other: Highlighted element screenshot */}
              {!isFunctional && highlightImg && (
                <div className="evidence-section">
                  <div className="evidence-section-title">
                    <span className="evidence-step-num">②</span>
                    Exact Failing Element — Highlighted in UI
                  </div>
                  <p className="evidence-section-note">
                    The red box marks the exact DOM element that caused this finding.
                  </p>
                  <EvidenceImage img={highlightImg} caption={highlightImg.label} badge="🎯 FAILING ELEMENT" finding={f} onViewEvidence={onViewEvidence} />
                </div>
              )}

              {/* ② Fallback: full-page only */}
              {!isFunctional && !highlightImg && fullPageImg && (
                <div className="evidence-section">
                  <div className="evidence-section-title">
                    <span className="evidence-step-num">②</span>
                    Screenshot at Time of Finding
                  </div>
                  <EvidenceImage img={fullPageImg} caption={fullPageImg.label} finding={f} onViewEvidence={onViewEvidence} />
                </div>
              )}

              {/* ③ Why this failed — semantic table */}
              {(semanticRows.length > 0 || isA11y) && (
                <div className="evidence-section">
                  <div className="evidence-section-title">
                    <span className="evidence-step-num">③</span>
                    Why This Failed — Semantic Evidence
                  </div>
                  {semanticRows.length > 0
                    ? <SemanticTable rows={semanticRows} />
                    : <p className="evidence-section-note text-muted">No additional semantic data was captured for this rule.</p>
                  }
                </div>
              )}

              {/* Meta strip */}
              <div className="meta-strip">
                <span className="meta-item">Classification: <strong>{f.classification}</strong></span>
                {f.context?.why && (
                  <span className="meta-item">Why it is a problem: {f.context.why}</span>
                )}
                {f.context?.reason && (
                  <span className="meta-item">Why tested: <strong>{f.context.pageType}</strong> — {f.context.reason}{f.context.confidence ? ` (${f.context.confidence} confidence)` : ''}</span>
                )}
                <span className="meta-item">Ground Truth: <strong>{f.basis || 'Requires Human Decision'}</strong></span>
                <span className="meta-item">Page: <code>{f.page}</code></span>
              </div>

              {/* Full-page — collapsible secondary context (only if we already showed a highlight/interaction) */}
              {fullPageImg && (highlightImg || interactionImg) && (
                <div className="secondary-evidence-section">
                  <button type="button" className="secondary-evidence-toggle" onClick={() => setShowFullPage(!showFullPage)}>
                    {showFullPage
                      ? <IconChevronDown style={{ width: 13, height: 13 }} />
                      : <IconChevronRight style={{ width: 13, height: 13 }} />}
                    Full-page context screenshot (additional reference)
                  </button>
                  {showFullPage && (
                    <EvidenceImage img={fullPageImg} caption={fullPageImg.label} finding={f} onViewEvidence={onViewEvidence} />
                  )}
                </div>
              )}
            </div>
          )}

          {/* ━━━━ TAB: AI ROOT CAUSE ━━━━ */}
          {activeTab === 'ai' && (
            <div className="tab-pane">
              {f.ai ? (
                <div className="ai-insight-box">
                  <div className="ai-box-header">
                    <div className="row gap">
                      <div className="ai-sparkle-badge">
                        <IconSparkles style={{ width: 14, height: 14 }} />
                        <span>Gemini Root Cause Digest</span>
                      </div>
                      <span className="badge badge-brand">Priority P{f.ai.priority}</span>
                      <span className="badge badge-neutral">Confidence {Math.round(f.ai.confidence * 100)}%</span>
                    </div>
                    {f.ai.likelyFalsePositive && (
                      <span className="badge badge-warning">
                        <IconAlertTriangle style={{ width: 12, height: 12 }} /> Likely False Positive
                      </span>
                    )}
                  </div>
                  <div className="ai-content-body">
                    <div className="ai-explanation">{f.ai.explanation}</div>
                    {f.ai.likelyRootCause && (
                      <div className="ai-sub-section">
                        <span className="ai-sub-label">Likely Root Cause:</span>
                        <p>{f.ai.likelyRootCause}</p>
                      </div>
                    )}
                    {f.ai.falsePositiveReason && (
                      <div className="ai-sub-section warning-sub-section">
                        <span className="ai-sub-label">False Positive Rationale:</span>
                        <p>{f.ai.falsePositiveReason}</p>
                      </div>
                    )}
                    {f.ai.suggestedChecks?.length > 0 && (
                      <div className="ai-sub-section">
                        <span className="ai-sub-label">Recommended Verification Checks:</span>
                        <ul className="ai-checks-list">
                          {f.ai.suggestedChecks.map((c, i) => <li key={i}>{c}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className={`ai-insight-box ${f.aiRejectReason?.includes('429') ? 'warning-sub-section' : 'ai-box-empty'}`}>
                  <div className="ai-box-header">
                    <div className={`ai-sparkle-badge ${f.aiRejectReason?.includes('429') ? 'warning' : 'neutral'}`}>
                      {f.aiRejectReason?.includes('429') ? <IconAlertTriangle style={{ width: 14, height: 14 }} /> : <IconSparkles style={{ width: 14, height: 14 }} />}
                      <span>{f.aiRejectReason?.includes('429') ? 'Gemini API Daily Free-Tier Quota Exceeded (HTTP 429)' : 'AI Root Cause Analysis Unavailable'}</span>
                    </div>
                  </div>
                  <div className="ai-content-body">
                    {f.aiRejectReason?.includes('429') ? (
                      <div>
                        <p className="text-secondary"><strong>Google Gemini Free Tier Limit Reached:</strong> Google AI Studio free tier for <code>gemini-2.5-flash</code> is capped at <strong>20 requests per day</strong>. Running large test suites quickly exhausts this quota.</p>
                        <div className="ai-sub-section" style={{ marginTop: 10, background: 'rgba(255,255,255,0.03)', padding: '10px 12px', borderRadius: 6 }}>
                          <span className="ai-sub-label">How to fix &amp; get AI explanations:</span>
                          <ul className="ai-checks-list text-sm" style={{ marginTop: 6 }}>
                            <li><strong>Option 1 (Recommended &amp; Free):</strong> Use Groq! Set <code>QA_AI_PROVIDER=groq</code> in <code>.env</code> and add a free key from <a href="https://console.groq.com" target="_blank" rel="noreferrer" style={{ color: '#60a5fa' }}>console.groq.com</a>.</li>
                            <li><strong>Option 2:</strong> Link a billing account in Google Cloud / AI Studio for Pay-As-You-Go Gemini access.</li>
                            <li><strong>Option 3:</strong> Wait for Google's daily quota to reset.</li>
                          </ul>
                        </div>
                      </div>
                    ) : f.aiRejectReason ? (
                      <div>
                        <p className="text-secondary">AI provider returned an error for this finding:</p>
                        <p className="text-muted text-sm mono" style={{ marginTop: 6, background: 'rgba(0,0,0,0.3)', padding: 8, borderRadius: 4 }}>{f.aiRejectReason}</p>
                      </div>
                    ) : (
                      <div>
                        <p className="text-secondary">No AI root cause analysis was saved for this finding in this run.</p>
                        <ul className="ai-checks-list text-sm" style={{ marginTop: 8 }}>
                          <li>The run may have been executed in Deterministic Mode without LLM calls.</li>
                          <li>The finding may have been skipped due to call budget limits.</li>
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ━━━━ TAB: DOM & LOGS ━━━━ */}
          {activeTab === 'dom' && (
            <div className="tab-pane">
              <div className="dom-inspector">
                <div className="dom-row">
                  <span className="dom-label">Target Selector:</span>
                  <code className="dom-code">{f.element?.selector || 'Page-level / Viewport-level issue'}</code>
                </div>
                {f.element?.role && (
                  <div className="dom-row">
                    <span className="dom-label">ARIA Role:</span>
                    <code>{f.element.role}</code>
                  </div>
                )}
                {f.element?.name && (
                  <div className="dom-row">
                    <span className="dom-label">Accessible Name:</span>
                    <code>"{f.element.name}"</code>
                  </div>
                )}
                <div className="dom-row">
                  <span className="dom-label">Full Page URL:</span>
                  <a href={f.page} target="_blank" rel="noreferrer" className="dom-link">{f.page}</a>
                </div>
                <div className="dom-row">
                  <span className="dom-label">Active Viewport:</span>
                  <span>{f.viewport}</span>
                </div>
              </div>

              {images.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div className="evidence-section-title" style={{ marginBottom: 10 }}>All Captured Screenshots ({images.length})</div>
                  <div className="evidence-images-row">
                    {images.map((img) => (
                      <div key={img.id} className="evidence-thumb-card" onClick={() => onViewEvidence?.(img, { page: f.page, viewport: f.viewport, ruleId: f.ruleId })}>
                        <div className={`thumb-preview-wrap ${img.kind === 'element-crop' ? 'thumb-crop' : 'thumb-screenshot'}`}>
                          <img src={img.url} alt={img.label} loading="lazy" />
                          <div className="thumb-hover-overlay"><IconEye style={{ width: 20, height: 20 }} /><span>Click to Zoom</span></div>
                        </div>
                        <div className="thumb-caption">
                          <span className="thumb-label">{img.label}</span>
                          <span className="thumb-kind">
                            {img.label.toLowerCase().includes('highlighted') ? '🎯 Highlighted'
                              : img.label.toLowerCase().includes('error state') || img.label.toLowerCase().includes('after') ? '💥 Error State'
                              : img.kind === 'element-crop' ? 'Element Crop'
                              : 'Full Viewport'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {files.length > 0 && (
                <div className="evidence-files-list" style={{ marginTop: 14 }}>
                  <span className="files-header">Forensic Logs &amp; Binary Artifacts:</span>
                  <div className="row gap wrap">
                    {files.map((file) => (
                      <a key={file.id} href={file.url} target="_blank" rel="noreferrer" className="file-evidence-pill">
                        <IconExternalLink style={{ width: 12, height: 12 }} />
                        <span>{file.label || file.kind} ({file.mime})</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Decision / Review Actions ── */}
          <div className="decision-bar">
            {f.decision && (
              <div className="existing-decision-banner">
                <span className="decision-title">Current Human Verdict: <strong>{f.decision.decision.replace(/_/g, ' ')}</strong></span>
                <span className="decision-meta">by {f.decision.decidedBy} {f.decision.note ? `— "${f.decision.note}"` : ''}</span>
              </div>
            )}
            <div className="decision-controls">
              <input
                type="text"
                placeholder="Optional reviewer note (e.g. verified in Chrome 124)..."
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="form-input decision-note-input"
                aria-label="Decision note"
                disabled={isSubmitting}
              />
              <div className="decision-buttons-group">
                {DECISIONS.map((dec) => (
                  <button key={dec.d} type="button" disabled={isSubmitting} className={`btn btn-sm ${dec.cls}`} onClick={() => handleDecision(dec.d)} title={dec.desc}>
                    {dec.label}
                  </button>
                ))}
                {f.category === 'visual' && (
                  <button type="button" className="btn btn-sm btn-outline-brand" onClick={() => onApproveBaseline(f.page, f.viewport)}>
                    Approve as Visual Baseline
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
