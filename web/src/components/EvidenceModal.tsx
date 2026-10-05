import { useEffect, useState } from 'react';
import { IconClose, IconDownload, IconExternalLink } from './Icons';

export interface EvidenceItem {
  id: string;
  kind: string;
  label: string;
  mime: string;
  url: string;
}

interface EvidenceModalProps {
  evidence: EvidenceItem | null;
  onClose: () => void;
  metadata?: {
    page?: string;
    viewport?: string;
    ruleId?: string;
  };
}

export function EvidenceModal({ evidence, onClose, metadata }: EvidenceModalProps) {
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!evidence) return null;

  const isImage = evidence.mime.startsWith('image/');

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Evidence Inspector">
      <div className="modal-container" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <div className="modal-title-group">
            <span className="badge badge-brand">{evidence.kind}</span>
            <h3 className="modal-title">{evidence.label || 'Evidence Preview'}</h3>
          </div>
          <div className="modal-actions">
            {isImage && (
              <div className="zoom-controls">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
                  title="Zoom Out"
                >
                  -
                </button>
                <span className="zoom-pct">{Math.round(zoom * 100)}%</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
                  title="Zoom In"
                >
                  +
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setZoom(1)}
                  title="Reset Zoom"
                >
                  Reset
                </button>
              </div>
            )}
            <a
              href={evidence.url}
              target="_blank"
              rel="noreferrer"
              className="btn btn-ghost btn-sm"
              title="Open full image in new tab"
            >
              <IconExternalLink style={{ width: 14, height: 14 }} />
              Open Tab
            </a>
            <a
              href={evidence.url}
              download={`${evidence.kind}-${evidence.id}`}
              className="btn btn-ghost btn-sm"
              title="Download file"
            >
              <IconDownload style={{ width: 14, height: 14 }} />
              Download
            </a>
            <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={onClose} aria-label="Close modal">
              <IconClose style={{ width: 16, height: 16 }} />
            </button>
          </div>
        </header>

        <div className="modal-body">
          {isImage ? (
            <div className="image-stage">
              <img
                src={evidence.url}
                alt={evidence.label}
                style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
                className="modal-preview-img"
              />
            </div>
          ) : (
            <div className="modal-file-preview">
              <p className="muted">Binary file evidence: <code>{evidence.mime}</code></p>
              <a href={evidence.url} target="_blank" rel="noreferrer" className="btn btn-primary">
                Download & View {evidence.kind}
              </a>
            </div>
          )}
        </div>

        {metadata && (
          <footer className="modal-footer">
            <span className="meta-tag">Page: <code>{metadata.page || '—'}</code></span>
            <span className="meta-tag">Viewport: <code>{metadata.viewport || '—'}</code></span>
            {metadata.ruleId && <span className="meta-tag">Rule: <code>{metadata.ruleId}</code></span>}
          </footer>
        )}
      </div>
    </div>
  );
}
