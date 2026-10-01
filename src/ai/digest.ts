import type { ConsoleEvent, NetworkEvent } from '../browser/types.js';
import type { FindingView } from '../database/types.js';
import type { EvidenceRef, EvidenceStore } from '../evidence/store.js';
import type { EvidenceDigest } from './analyzer.js';

/** Summarises stored evidence for one finding into small strings for the AI prompt. Text evidence is already redacted. */
export function buildDigest(store: EvidenceStore, refs: EvidenceRef[], finding: FindingView): EvidenceDigest {
  const digest: EvidenceDigest = {};
  const read = <T>(r: EvidenceRef): T | null => { try { return JSON.parse(store.read(r).toString('utf8')) as T; } catch { return null; } };
  for (const r of refs) {
    if (r.kind === 'network') {
      const ev = read<NetworkEvent[]>(r) ?? [];
      digest.network = ev.filter((n) => !n.ok && !n.ignored && !n.blockedByGuard).map((n) => `${n.method} ${n.url} -> ${n.status ?? n.failure}`);
    } else if (r.kind === 'console') {
      const ev = read<ConsoleEvent[]>(r) ?? [];
      digest.console = ev.filter((c) => c.level === 'error' || c.level === 'warning').map((c) => `${c.level}: ${c.text}`);
    } else if (r.kind === 'geometry') {
      const g = read<{ metrics: { scrollWidth: number; clientWidth: number }; viewport: { width: number }; elements: { selector: string; box: { x: number; y: number; width: number; height: number }; position: string }[] }>(r);
      if (g) {
        digest.geometry = [`document ${g.metrics.scrollWidth}px wide in ${g.metrics.clientWidth}px viewport`];
        const el = g.elements.find((e) => e.selector === finding.element?.selector);
        if (el) digest.geometry.push(`${el.selector}: x=${Math.round(el.box.x)} y=${Math.round(el.box.y)} w=${Math.round(el.box.width)} h=${Math.round(el.box.height)} position=${el.position}`);
      }
    } else if (r.kind === 'aria') {
      digest.aria = store.read(r).toString('utf8').slice(0, 600);
    } else if (r.kind === 'visual-diff') {
      digest.visual = `visual diff image recorded (${r.label})`;
    }
  }
  return digest;
}
