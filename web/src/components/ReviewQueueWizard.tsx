import { useState } from 'react';
import type { Decision, Finding } from '../api';
import type { EvidenceItem } from './EvidenceModal';
import { FindingCard } from './FindingCard';
import { IconCheck, IconChevronDown, IconChevronRight, IconShield } from './Icons';

interface ReviewQueueWizardProps {
  queue: Finding[];
  onDecide: (findingId: string, d: Decision, note?: string) => Promise<void>;
  onApproveBaseline: (page: string, viewport: string) => Promise<void>;
  onViewEvidence?: (item: EvidenceItem, meta: { page: string; viewport: string; ruleId: string }) => void;
}

export function ReviewQueueWizard({
  queue,
  onDecide,
  onApproveBaseline,
  onViewEvidence,
}: ReviewQueueWizardProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [viewMode, setViewMode] = useState<'wizard' | 'list'>('wizard');

  if (queue.length === 0) {
    return (
      <div className="empty-state-box">
        <div className="empty-state-icon text-success">
          <IconCheck style={{ width: 36, height: 36 }} />
        </div>
        <h3 className="empty-state-title">Review Queue is Clear!</h3>
        <p className="empty-state-desc">
          All flagged anomalies have been evaluated by human review, or no unconfirmed issues require human judgment.
        </p>
      </div>
    );
  }

  const validIndex = Math.min(currentIndex, queue.length - 1);
  const currentFinding = queue[validIndex]!;

  const handleNext = () => {
    if (validIndex < queue.length - 1) {
      setCurrentIndex(validIndex + 1);
    }
  };

  const handlePrev = () => {
    if (validIndex > 0) {
      setCurrentIndex(validIndex - 1);
    }
  };

  const handleDecision = async (findingId: string, d: Decision, note?: string) => {
    await onDecide(findingId, d, note);
    // Keep index valid after item is removed from queue
    if (validIndex >= queue.length - 1 && validIndex > 0) {
      setCurrentIndex(validIndex - 1);
    }
  };

  return (
    <div className="review-wizard-container">
      {/* Wizard Header Toolbar */}
      <div className="review-wizard-header">
        <div className="wizard-progress-info">
          <div className="row gap">
            <IconShield style={{ width: 18, height: 18 }} className="text-purple" />
            <h3 className="wizard-title">Human Review Queue</h3>
            <span className="badge badge-purple">{queue.length} awaiting review</span>
          </div>
          <p className="wizard-subtitle">
            Anomalies and heuristic observations that require human verification before being marked as bugs.
          </p>
        </div>

        <div className="wizard-controls">
          <div className="wizard-mode-toggle">
            <button
              type="button"
              className={`toggle-pill ${viewMode === 'wizard' ? 'active' : ''}`}
              onClick={() => setViewMode('wizard')}
            >
              Step-by-step
            </button>
            <button
              type="button"
              className={`toggle-pill ${viewMode === 'list' ? 'active' : ''}`}
              onClick={() => setViewMode('list')}
            >
              Show All ({queue.length})
            </button>
          </div>

          {viewMode === 'wizard' && (
            <div className="nav-buttons-group">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={handlePrev}
                disabled={validIndex === 0}
                title="Previous anomaly"
              >
                ← Prev
              </button>
              <span className="step-counter">
                <strong>{validIndex + 1}</strong> of {queue.length}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={handleNext}
                disabled={validIndex === queue.length - 1}
                title="Next anomaly"
              >
                Next →
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Progress Bar for Reviewing */}
      {viewMode === 'wizard' && (
        <div className="wizard-progress-bar-track">
          <div
            className="wizard-progress-bar-fill"
            style={{ width: `${Math.round(((validIndex + 1) / queue.length) * 100)}%` }}
          />
        </div>
      )}

      {/* Main Review View */}
      {viewMode === 'wizard' ? (
        <div className="wizard-card-stage animated-reveal">
          <FindingCard
            key={currentFinding.id}
            finding={currentFinding}
            defaultExpanded={true}
            onDecide={(d, note) => handleDecision(currentFinding.id, d, note)}
            onApproveBaseline={(p, v) => onApproveBaseline(p, v)}
            onViewEvidence={onViewEvidence}
          />
        </div>
      ) : (
        <div className="review-list-view">
          {queue.map((f) => (
            <FindingCard
              key={f.id}
              finding={f}
              defaultExpanded={false}
              onDecide={(d, note) => handleDecision(f.id, d, note)}
              onApproveBaseline={(p, v) => onApproveBaseline(p, v)}
              onViewEvidence={onViewEvidence}
            />
          ))}
        </div>
      )}
    </div>
  );
}
