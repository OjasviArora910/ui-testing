export type Severity = 'critical' | 'major' | 'minor' | 'info';
export type ReviewState = 'defect' | 'pending' | 'confirmed' | 'dismissed' | 'investigating';
export type Decision = 'CONFIRM_BUG' | 'NOT_A_BUG' | 'EXPECTED_BEHAVIOR' | 'NEEDS_INVESTIGATION';
export type Mode = 'deterministic' | 'ai_assisted' | 'exploratory';
export type JwtLocation = 'cookie' | 'localStorage' | 'sessionStorage' | 'header';
/** One-time credentials: sent once with the start request, kept in server memory for that run only, never stored. */
export interface DirectAuth { token: string; location: JwtLocation; key?: string; scheme?: string }
export interface Viewport { name: string; width: number; height: number }

export interface PlatformConfig {
  viewports: Viewport[]; modes: Mode[]; aiConfigured: boolean; aiProvider: { name: string; model: string } | null;
  authProfiles: { name: string; location: string }[]; limits: { maxPages: number; maxActions: number; maxDepth: number };
}

export interface Snapshot {
  runId: string; status: string; currentPage: string | null; currentViewport: string | null; currentAction: string | null;
  pagesDiscovered: number; unitsDone: number; unitsTotal: number; actionsUsed: number; findings: number; categories: Record<string, number>; errors: string[];
}

export interface Run {
  id: string; url: string; mode: Mode; status: string; verdict: string | null; authProfile: string | null; auth: { source: 'none' | 'token' | 'profile'; location?: string; profile?: string }; createdAt: string; finishedAt: string | null;
  error: string | null; abortReason: string | null; active: boolean; interrupted: boolean; progress: Snapshot | null;
  summary: { pages: number; defects: number; anomalies: number; pendingReview: number; actions: number; guardBlocked: number; visual: { pass: number; fail: number; noBaseline: number } } | null;
  reports: { html: boolean; json: boolean; junit: boolean };
}

export interface AIAnalysis { explanation: string; likelyRootCause: string; priority: number; confidence: number; likelyFalsePositive: boolean; falsePositiveReason?: string; suggestedChecks: string[] }

export interface Finding {
  id: string; runId: string; ruleId: string; category: string; severity: Severity; classification: 'defect' | 'anomaly'; basis: string | null;
  reviewState: ReviewState; page: string; viewport: string; element: { selector: string; role?: string; name?: string } | null;
  expected: string; actual: string; decision: { decision: Decision; note: string | null; decidedBy: string; decidedAt: string } | null;
  evidence: { id: string; kind: string; label: string; mime: string; url: string }[]; ai: AIAnalysis | null;
  aiRejectReason?: string | null;
}

export interface ProgressEvent { runId: string; seq: number; at: string; type: string; message: string; data?: Record<string, unknown> }

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string; issues?: { path: string; message: string }[] }).issues?.map((i) => `${i.path}: ${i.message}`).join('; ') || (body as { error?: string }).error || `HTTP ${res.status}`);
  return body as T;
}

export interface SimulationStep {
  id: number;
  url: string;
  viewport: string;
  source: string;
  action: string;
  target: string;
  ok: boolean;
  detail: string | null;
  at: string;
  screenshotUrl: string | null;
  findingsCount: number;
  findings: Array<{ id: string; ruleId: string; severity: string; actual: string }>;
}

export const api = {
  config: () => req<PlatformConfig>('/api/config'),
  runs: () => req<{ runs: Run[] }>('/api/runs').then((r) => r.runs),
  run: (id: string) => req<Run>(`/api/runs/${id}`),
  start: (body: { url: string; auth?: DirectAuth; authProfile?: string; mode: Mode; viewports: Viewport[]; overrides?: Record<string, number> }) => req<{ runId: string }>('/api/runs', { method: 'POST', body: JSON.stringify(body) }),
  stop: (id: string) => req<{ stopped: boolean }>(`/api/runs/${id}/stop`, { method: 'POST', body: '{}' }),
  resume: (id: string, auth?: DirectAuth) => req<{ runId: string }>(`/api/runs/${id}/resume`, { method: 'POST', body: JSON.stringify(auth ? { auth } : {}) }),
  findings: (id: string) => req<{ findings: Finding[] }>(`/api/runs/${id}/findings`).then((r) => r.findings),
  queue: (id: string) => req<{ queue: Finding[] }>(`/api/runs/${id}/review-queue`).then((r) => r.queue),
  decide: (findingId: string, decision: Decision, note?: string) => req<{ verdict: string }>(`/api/findings/${findingId}/decision`, { method: 'POST', body: JSON.stringify({ decision, note: note || undefined }) }),
  approveBaseline: (runId: string, page: string, viewport: string) => req<{ file: string }>(`/api/runs/${runId}/baselines`, { method: 'POST', body: JSON.stringify({ page, viewport }) }),
  simulation: (runId: string) => req<{ simulation: SimulationStep[] }>(`/api/runs/${runId}/simulation`).then((r) => r.simulation),
};

