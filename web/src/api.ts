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
  accessibility?: { enabled: boolean; failRun: boolean };
}

export interface RunCounts {
  pagesCrawled: number; pagesTested: number; elementsTested: number; passed: number; blocked: number; inconclusive?: number;
  bugs: number; warnings: number; needsReview: number; notTestedPages: number; notTestedElements: number;
}

export interface Snapshot {
  runId: string; status: string; currentPage: string | null; currentViewport: string | null; currentAction: string | null;
  pagesDiscovered: number; unitsDone: number; unitsTotal: number; actionsUsed: number; findings: number; categories: Record<string, number>; errors: string[]; counts?: RunCounts;
}

export interface Run {
  id: string; url: string; mode: Mode; status: string; verdict: string | null; authProfile: string | null; auth: { source: 'none' | 'token' | 'profile'; location?: string; profile?: string }; createdAt: string; finishedAt: string | null;
  error: string | null; abortReason: string | null; active: boolean; interrupted: boolean; progress: Snapshot | null;
  summary: { counts?: { bugs: number; warnings: number; needsReview: number; accessibility: number; accessibilityNeedsReview: number }; pages: number; defects: number; anomalies: number; pendingReview: number; actions: number; guardBlocked: number; visual: { pass: number; fail: number; noBaseline: number } } | null;
  reports: { html: boolean; json: boolean; junit: boolean };
  /** RUNNING until the run ends, then COMPLETED / ABORTED / ERROR (INTERRUPTED = the server restarted mid-run). */
  state?: 'RUNNING' | 'COMPLETED' | 'ABORTED' | 'ERROR' | 'INTERRUPTED';
  counts?: RunCounts;
  note?: string | null;
}

export interface AIAnalysis { explanation: string; likelyRootCause: string; priority: number; confidence: number; likelyFalsePositive: boolean; falsePositiveReason?: string; suggestedChecks: string[] }

export type ResultClass = 'BUG' | 'WARNING' | 'EXPECTED' | 'NEEDS_REVIEW' | 'BLOCKED_BY_SAFETY' | 'INCONCLUSIVE';
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';
export interface ScenarioRef { id: string; label: string; pageType: string; reason: string; confidence: Confidence }
export interface PageDecision {
  types: { type: string; confidence: Confidence; signals: string[] }[];
  selected: ScenarioRef[];
  skipped: { id: string; label: string; reason: string }[];
}
export interface TestResult {
  id: number; page: string; viewport: string; scenario: string; scenarioLabel: string; pageType: string; reason: string; confidence: Confidence;
  kind: string; check: string; target: string | null; expected: string; actual: string; classification: ResultClass;
}
/** What was detected per page, which tests were selected/skipped, and how every selected test ended. */
export interface DynamicData {
  pages: { url: string; title: string | null; decision: PageDecision }[];
  results: TestResult[];
  accessibility: { enabled: boolean; failRun: boolean };
}

export interface Finding {
  id: string; runId: string; ruleId: string; category: string; severity: Severity; classification: 'defect' | 'anomaly'; basis: string | null;
  reviewState: ReviewState; page: string; viewport: string; element: { selector: string; role?: string; name?: string } | null;
  expected: string; actual: string; decision: { decision: Decision; note: string | null; decidedBy: string; decidedAt: string } | null;
  evidence: { id: string; kind: string; label: string; mime: string; url: string }[]; ai: AIAnalysis | null;
  aiRejectReason?: string | null;
  /** BUG / WARNING / NEEDS_REVIEW are UI/UX labels; an accessibility finding is always ACCESSIBILITY. */
  resultClass?: ResultClass | 'ACCESSIBILITY';
  /** Accessibility findings are a separate category from general UI/UX. */
  track?: 'accessibility' | 'uiux';
  context?: { scenario?: string; pageType?: string; reason?: string; confidence?: Confidence; why?: string } | null;
  /** Findings with the same key are occurrences of one underlying problem. */
  problemKey?: string;
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
  start: (body: { url: string; auth?: DirectAuth; authProfile?: string; mode: Mode; viewports: Viewport[]; overrides?: Record<string, unknown> }) => req<{ runId: string }>('/api/runs', { method: 'POST', body: JSON.stringify(body) }),
  stop: (id: string) => req<{ stopped: boolean }>(`/api/runs/${id}/stop`, { method: 'POST', body: '{}' }),
  resume: (id: string, auth?: DirectAuth) => req<{ runId: string }>(`/api/runs/${id}/resume`, { method: 'POST', body: JSON.stringify(auth ? { auth } : {}) }),
  findings: (id: string) => req<{ findings: Finding[] }>(`/api/runs/${id}/findings`).then((r) => r.findings),
  queue: (id: string) => req<{ queue: Finding[] }>(`/api/runs/${id}/review-queue`).then((r) => r.queue),
  decide: (findingId: string, decision: Decision, note?: string) => req<{ verdict: string }>(`/api/findings/${findingId}/decision`, { method: 'POST', body: JSON.stringify({ decision, note: note || undefined }) }),
  approveBaseline: (runId: string, page: string, viewport: string) => req<{ file: string }>(`/api/runs/${runId}/baselines`, { method: 'POST', body: JSON.stringify({ page, viewport }) }),
  dynamic: (id: string) => req<DynamicData>(`/api/runs/${id}/dynamic`),
  simulation: (runId: string) => req<{ simulation: SimulationStep[] }>(`/api/runs/${runId}/simulation`).then((r) => r.simulation),
};

