import { useState } from 'react';
import type { Decision, Finding } from '../api';

const DECISIONS: { d: Decision; label: string; cls: string }[] = [
  { d: 'CONFIRM_BUG', label: 'CONFIRM BUG', cls: 'danger' },
  { d: 'NOT_A_BUG', label: 'NOT A BUG', cls: '' },
  { d: 'EXPECTED_BEHAVIOR', label: 'EXPECTED BEHAVIOR', cls: '' },
  { d: 'NEEDS_INVESTIGATION', label: 'NEEDS INVESTIGATION', cls: '' },
];

const pathOf = (u: string) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };

export function FindingCard({ finding: f, onDecide, onApproveBaseline }: { finding: Finding; onDecide: (d: Decision, note?: string) => void; onApproveBaseline: (page: string, viewport: string) => void }) {
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  const images = f.evidence.filter((e) => e.mime === 'image/png');
  const files = f.evidence.filter((e) => e.mime !== 'image/png');

  return (
    <article className={`card sev-${f.severity}`}>
      <header className="row between wrap">
        <div className="row gap wrap">
          <span className={`sev s-${f.severity}`}>{f.severity}</span>
          <strong>{f.ruleId}</strong>
          <span className="tag">{f.category}</span>
          <span className="tag">{f.classification}{f.basis ? ` · ${f.basis}` : ' · no basis'}</span>
          <span className={`tag st-${f.reviewState}`}>{f.reviewState}</span>
        </div>
        <span className="muted small">{pathOf(f.page)} · {f.viewport}</span>
      </header>
      {f.element && <p className="small"><code>{f.element.selector}</code>{f.element.name ? ` "${f.element.name}"` : ''}</p>}
      <dl>
        <dt>Expected</dt><dd>{f.expected}</dd>
        <dt>Actual</dt><dd>{f.actual}</dd>
      </dl>

      {f.ai && (
        <div className="ai">
          <div className="row gap wrap small">
            <b>AI analysis (advisory)</b>
            <span>priority {f.ai.priority}</span>
            <span>confidence {Math.round(f.ai.confidence * 100)}%</span>
            {f.ai.likelyFalsePositive && <span className="tag warn">likely false positive</span>}
          </div>
          <p>{f.ai.explanation}</p>
          {f.ai.likelyRootCause && <p className="small"><i>Likely cause:</i> {f.ai.likelyRootCause}</p>}
          {f.ai.falsePositiveReason && <p className="small"><i>Why it may be a false positive:</i> {f.ai.falsePositiveReason}</p>}
        </div>
      )}

      {(images.length > 0 || files.length > 0) && (
        <div>
          <button className="link" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} evidence ({f.evidence.length})</button>
          {open && (
            <div className="evidence">
              {images.map((e) => <a key={e.id} href={e.url} target="_blank" rel="noreferrer" title={e.label}><img src={e.url} alt={e.label} loading="lazy" /></a>)}
              <p className="row gap wrap small">{files.map((e) => <a key={e.id} href={e.url} target="_blank" rel="noreferrer">{e.kind}</a>)}</p>
            </div>
          )}
        </div>
      )}

      {f.decision && <p className="small muted">Decision: <b>{f.decision.decision}</b> by {f.decision.decidedBy}{f.decision.note ? ` — ${f.decision.note}` : ''}</p>}

      <div className="decide">
        <input placeholder="Optional note" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Decision note" />
        <div className="row gap wrap">
          {DECISIONS.map((x) => <button key={x.d} className={x.cls} onClick={() => { onDecide(x.d, note); setNote(''); }}>{x.label}</button>)}
          {f.category === 'visual' && <button onClick={() => onApproveBaseline(f.page, f.viewport)}>Approve current as baseline</button>}
        </div>
      </div>
    </article>
  );
}
