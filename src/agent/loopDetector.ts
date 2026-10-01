import crypto from 'node:crypto';
import type { AgentAction } from './tools.js';

export interface ElementDesc { role?: string | null; name?: string }

const norm = (s: string | undefined): string => (s ?? '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 60);

function normUrl(u: string): string {
  try {
    const x = new URL(u, 'http://x.invalid');
    const q = [...x.searchParams.keys()].sort().join(',');
    return `${x.pathname.replace(/\/$/, '') || '/'}${q ? `?${q}` : ''}`;
  } catch { return u; }
}

/**
 * Normalised action signature: ignores volatile parts (numbers, ids, query values) so "click item 3" and "click item 7"
 * count as the same kind of action, and the same click repeated on a re-rendered page is detected.
 */
export function actionSignature(a: AgentAction, el?: ElementDesc): string {
  switch (a.tool) {
    case 'navigate': return `navigate|${normUrl(a.url)}`;
    case 'click': case 'hover': return `${a.tool}|${el?.role ?? ''}|${norm(el?.name)}`;
    case 'fill': case 'select': return `${a.tool}|${el?.role ?? ''}|${norm(el?.name)}|${norm(a.value)}`;
    case 'scroll': return `scroll|${a.direction}`;
    case 'press': return `press|${a.key.toLowerCase()}`;
    case 'inspectGeometry': return `inspectGeometry|${norm(el?.name)}`;
    case 'report': return `report|${norm(a.description)}`;
    case 'stop': return 'stop';
    default: return a.tool;
  }
}

/** Normalised state signature: path + the set of (role,name) of interactive elements + dialog presence. */
export function stateSignature(url: string, elements: ElementDesc[], dialogOpen: boolean): string {
  const set = [...new Set(elements.map((e) => `${e.role ?? ''}|${norm(e.name)}`))].sort().slice(0, 80);
  return crypto.createHash('sha1').update(`${normUrl(url)}#${dialogOpen ? 'D' : ''}#${set.join(';')}`).digest('hex').slice(0, 12);
}

export interface LoopLimits { maxRepeatedActions: number; maxRepeatedStates: number; noProgressLimit: number }
export type LoopVerdict = 'ok' | 'repeated_action' | 'repeated_state' | 'no_progress';

/** Tracks repetition and lack of progress across an agent run. */
export class LoopDetector {
  private readonly actionCounts = new Map<string, number>();
  private readonly stateCounts = new Map<string, number>();
  private stagnant = 0;

  constructor(private readonly limits: LoopLimits) {}

  /** Call BEFORE executing an action. */
  checkAction(sig: string): LoopVerdict {
    const n = (this.actionCounts.get(sig) ?? 0) + 1;
    this.actionCounts.set(sig, n);
    return n > this.limits.maxRepeatedActions ? 'repeated_action' : 'ok';
  }

  /** Call AFTER an action with the resulting state. `madeProgress` = new network activity, new page, or a state not seen before. */
  checkState(sig: string, extraProgress: boolean): LoopVerdict {
    const seen = this.stateCounts.get(sig) ?? 0;
    this.stateCounts.set(sig, seen + 1);
    const progressed = seen === 0 || extraProgress;
    this.stagnant = progressed ? 0 : this.stagnant + 1;
    if (seen + 1 > this.limits.maxRepeatedStates) return 'repeated_state';
    if (this.stagnant >= this.limits.noProgressLimit) return 'no_progress';
    return 'ok';
  }

  get distinctStates(): number { return this.stateCounts.size; }
}
