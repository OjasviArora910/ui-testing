import type { RunCounts, RunStatus } from '../database/types.js';

export type ProgressEventType = 'status' | 'page' | 'action' | 'finding' | 'log' | 'warning' | 'error' | 'done' | 'frame' | 'result';

export interface ProgressEvent {
  runId: string;
  seq: number;
  at: string;
  type: ProgressEventType;
  message: string;
  data?: Record<string, unknown>;
}

/** Live snapshot shown by the dashboard. */
export interface ProgressSnapshot {
  runId: string;
  status: RunStatus;
  currentPage: string | null;
  currentViewport: string | null;
  currentAction: string | null;
  pagesDiscovered: number;
  unitsDone: number;
  unitsTotal: number;
  actionsUsed: number;
  findings: number;
  categories: Record<string, number>;
  errors: string[];
  /** Pages / elements tested / passed / bugs / needs review, kept current while the run is going. */
  counts?: RunCounts;
}

export function emptySnapshot(runId: string, status: RunStatus = 'CREATED'): ProgressSnapshot {
  return { runId, status, currentPage: null, currentViewport: null, currentAction: null, pagesDiscovered: 0, unitsDone: 0, unitsTotal: 0, actionsUsed: 0, findings: 0, categories: {}, errors: [] };
}
