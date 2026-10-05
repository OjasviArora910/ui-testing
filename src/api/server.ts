import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import { EvidenceStore } from '../evidence/store.js';
import { DecisionSchema, type FindingView } from '../database/types.js';
import type { Platform } from '../orchestrator/bootstrap.js';
import { runCounts } from '../reporting/data.js';
import { DirectAuthSchema, RunRequestSchema } from '../shared/runRequest.js';

const MAX_BODY = 256 * 1024;
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json' };
const CREDENTIAL_KEYS = ['jwt', 'token', 'authorization', 'cookie', 'apikey', 'api_key', 'password', 'secret'];

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

const DecisionBody = z.object({ decision: DecisionSchema, note: z.string().max(2000).optional(), decidedBy: z.string().min(1).max(80).optional() }).strict();
const ResumeBody = z.object({ auth: DirectAuthSchema.optional() }).strict();
const BaselineBody = z.object({ page: z.string().url(), viewport: z.string().min(1).max(40), approvedBy: z.string().min(1).max(80).optional() }).strict();

export interface ApiOptions { webDir?: string }

/** REST + SSE API. Binds to localhost by default; credentials are never accepted or returned (auth profiles are names only). */
export function createApiServer(platform: Platform, opts: ApiOptions = {}): http.Server {
  const { orchestrator: orch } = platform;
  const db = orch.db;
  const webDir = opts.webDir ? path.resolve(opts.webDir) : undefined;

  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };

  async function readJson(req: http.IncomingMessage): Promise<unknown> {
    const ct = req.headers['content-type'] ?? '';
    if (!ct.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Content-Type must be application/json');
    const chunks: Buffer[] = []; let size = 0;
    for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new HttpError(413, 'Request body too large'); chunks.push(c as Buffer); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'Invalid JSON'); }
  }

  const findingJson = (runId: string, f: FindingView, analyses: ReturnType<typeof db.analysesByFinding>, aiErrors: Map<string, string>, evidence: Map<string, ReturnType<typeof db.listEvidence>[number]>) => ({
    id: f.id, runId, ruleId: f.ruleId, category: f.category, severity: f.severity, classification: f.classification, basis: f.basis, reviewState: f.reviewState,
    page: f.page, viewport: f.viewport, element: f.element, expected: f.expected, actual: f.actual, decision: f.decision,
    evidence: f.evidence.map((id) => evidence.get(id)).filter(Boolean).map((e) => ({ id: e!.id, kind: e!.kind, label: e!.label, mime: e!.mime, url: `/api/runs/${runId}/evidence/${e!.id}` })),
    resultClass: f.resultClass, track: f.track, problemKey: f.problemKey, context: f.context ?? null,
    ai: analyses.get(f.id) ?? null,
    aiRejectReason: aiErrors.get(f.id) ?? null,
  });

  function runJson(runId: string) {
    const run = db.getRun(runId);
    if (!run) throw new HttpError(404, 'Run not found');
    return {
      id: run.id, url: run.url, mode: run.mode, status: run.status, verdict: run.verdict, authProfile: run.authProfile, auth: orch.authInfo(runId), createdAt: run.createdAt, startedAt: run.startedAt,
      finishedAt: run.finishedAt, error: run.error, abortReason: run.abortReason, summary: run.summary, active: orch.isActive(runId),
      interrupted: !orch.isActive(runId) && !['COMPLETED', 'ABORTED', 'ERROR', 'REVIEW'].includes(run.status),
      progress: orch.snapshot(runId),
      // one simple state for people: RUNNING until the run ends, then COMPLETED / ABORTED / ERROR
      state: orch.isActive(runId) ? 'RUNNING' : run.status === 'ABORTED' ? 'ABORTED' : run.status === 'ERROR' ? 'ERROR' : ['COMPLETED', 'REVIEW'].includes(run.status) ? 'COMPLETED' : 'INTERRUPTED',
      counts: runCounts(db, runId),
      note: run.status === 'ABORTED' ? `${/user/.test(run.abortReason ?? '') ? 'Stopped by user' : `Stopped (${run.abortReason ?? 'aborted'})`}. Results shown for work completed before stopping.` : run.status === 'ERROR' ? `Run failed: ${run.error ?? 'error'}` : null,
      reports: { html: !!orch.reportPath(runId, 'html'), json: !!orch.reportPath(runId, 'json'), junit: !!orch.reportPath(runId, 'xml') },
    };
  }

  function serveSse(req: http.IncomingMessage, res: http.ServerResponse, runId: string): void {
    if (!db.getRun(runId)) throw new HttpError(404, 'Run not found');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const write = (event: string, data: unknown, id?: number): void => { res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    write('snapshot', orch.snapshot(runId));
    const last = Number(req.headers['last-event-id'] ?? 0) || 0;
    for (const ev of orch.replay(runId, last)) write('progress', ev, ev.seq);
    const listener = (ev: { runId: string; seq: number }): void => {
      if (ev.runId !== runId) return;
      write('progress', ev, ev.seq); write('snapshot', orch.snapshot(runId));
    };
    orch.events.on('event', listener);
    const hb = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(hb); orch.events.off('event', listener); });
  }

  function serveEvidence(res: http.ServerResponse, runId: string, id: string): void {
    if (!EvidenceStore.isValidId(id)) throw new HttpError(400, 'Invalid evidence id');
    const ref = db.getEvidence(id, runId);
    if (!ref) throw new HttpError(404, 'Evidence not found');
    const buf = orch.opts.evidence.read(ref);
    // DOM/ARIA/text snapshots are served as plain text so recorded page markup can never execute in our origin.
    const safeMime = ref.mime === 'text/html' || ref.mime === 'text/yaml' ? 'text/plain; charset=utf-8' : ref.mime;
    res.writeHead(200, { 'content-type': safeMime, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'private, max-age=3600', 'content-length': buf.length });
    res.end(buf);
  }

  function serveReport(res: http.ServerResponse, runId: string, kind: 'html' | 'json' | 'xml'): void {
    const file = orch.reportPath(runId, kind);
    if (!file) throw new HttpError(404, 'Report not available yet');
    const types = { html: 'text/html; charset=utf-8', json: 'application/json', xml: 'application/xml' } as const;
    res.writeHead(200, { 'content-type': types[kind], 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox", 'content-disposition': `${kind === 'html' ? 'inline' : 'attachment'}; filename="qa-report-${runId}.${kind}"` });
    res.end(fs.readFileSync(file));
  }

  function serveStatic(res: http.ServerResponse, urlPath: string): boolean {
    if (!webDir) return false;
    const rel = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath);
    let file = path.resolve(webDir, `.${rel}`);
    if (!file.startsWith(webDir + path.sep) && file !== webDir) return false;
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(webDir, 'index.html'); // SPA fallback
    if (!fs.existsSync(file)) return false;
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' });
    res.end(fs.readFileSync(file));
    return true;
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname; const m = req.method ?? 'GET';
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('x-frame-options', 'DENY'); res.setHeader('referrer-policy', 'no-referrer');

    // CSRF/DNS-rebinding guard for state-changing requests: Origin (when sent) must match Host.
    if (m !== 'GET' && m !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin) { let ok = false; try { ok = new URL(origin).host === req.headers.host; } catch { ok = false; } if (!ok) throw new HttpError(403, 'Cross-origin request refused'); }
    }

    if (p === '/api/health') return send(res, 200, { ok: true });
    if (p === '/api/config' && m === 'GET') {
      const desktopVp = platform.config.viewports.filter((v) => v.name === 'desktop');
      return send(res, 200, {
        viewports: desktopVp.length ? desktopVp : [{ name: 'desktop', width: 1440, height: 900 }],
        // exploratory (AI-driven) runs are not offered: the product is deterministic UI/UX testing, with AI only explaining findings
        modes: ['deterministic', 'ai_assisted'],
        aiConfigured: !!platform.provider,
        aiProvider: platform.provider ? { name: platform.provider.name, model: platform.provider.model } : null,
        authProfiles: platform.profiles.list(),
        limits: { maxPages: platform.config.maxPages, maxActions: platform.config.maxActions, maxDepth: platform.config.maxDepth },
        accessibility: { enabled: platform.config.accessibility.enabled, failRun: platform.config.accessibility.failRun },
        dynamic: platform.config.dynamic.enabled,
      });
    }
    if (p === '/api/runs' && m === 'GET') return send(res, 200, { runs: db.listRuns(50).map((r) => runJson(r.id)) });
    if (p === '/api/runs' && m === 'POST') {
      const body = await readJson(req);
      if (body && typeof body === 'object') {
        const bad = Object.keys(body).find((k) => CREDENTIAL_KEYS.includes(k.toLowerCase()));
        if (bad) throw new HttpError(400, `Unexpected top-level field "${bad}". Send credentials as "auth": { "token", "location", "key"?, "scheme"? } (used in memory only, never stored), or reference a server-side "authProfile".`);
      }
      const parsed = RunRequestSchema.safeParse(body);
      if (!parsed.success) return send(res, 400, { error: 'Invalid request', issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
      try {
        const run = orch.start(parsed.data);
        return send(res, 202, { runId: run.id });
      } catch (e) {
        throw new HttpError(/already in progress/.test((e as Error).message) ? 409 : 400, platform.redactor.redact((e as Error).message));
      }
    }

    const rm = /^\/api\/runs\/([\w-]+)(?:\/(.*))?$/.exec(p);
    if (rm) {
      const runId = rm[1]!; const sub = rm[2] ?? '';
      if (sub === '' && m === 'GET') return send(res, 200, runJson(runId));
      if (sub === 'events' && m === 'GET') return serveSse(req, res, runId);
      if (sub === 'stop' && m === 'POST') { if (!db.getRun(runId)) throw new HttpError(404, 'Run not found'); return send(res, 200, { stopped: orch.abort(runId) || orch.stopInterrupted(runId) }); }
      if (sub === 'resume' && m === 'POST') {
        const body = ResumeBody.safeParse(await readJson(req));
        if (!body.success) throw new HttpError(400, 'Invalid resume request: expected optional { "auth": { "token", "location", "key"?, "scheme"? } }');
        try { orch.resume(runId, body.data.auth); return send(res, 202, { runId }); } catch (e) { throw new HttpError(409, platform.redactor.redact((e as Error).message)); }
      }
      if (sub === 'findings' && m === 'GET') {
        if (!db.getRun(runId)) throw new HttpError(404, 'Run not found');
        const ev = new Map(db.listEvidence(runId).map((e) => [e.id, e])); const an = db.analysesByFinding(runId); const errs = db.aiErrorsByFinding(runId);
        const state = url.searchParams.get('state'); const category = url.searchParams.get('category');
        const list = db.listFindings(runId).filter((f) => (!state || f.reviewState === state) && (!category || f.category === category));
        return send(res, 200, { findings: list.map((f) => findingJson(runId, f, an, errs, ev)) });
      }
      if (sub === 'review-queue' && m === 'GET') {
        if (!db.getRun(runId)) throw new HttpError(404, 'Run not found');
        const ev = new Map(db.listEvidence(runId).map((e) => [e.id, e])); const an = db.analysesByFinding(runId); const errs = db.aiErrorsByFinding(runId);
        return send(res, 200, { queue: orch.reviewQueue(runId).map((f) => findingJson(runId, f, an, errs, ev)) });
      }
      if (sub === 'baselines' && m === 'POST') {
        const b = BaselineBody.safeParse(await readJson(req));
        if (!b.success) throw new HttpError(400, b.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
        try { return send(res, 200, orch.approveBaseline(runId, b.data.page, b.data.viewport, b.data.approvedBy ?? 'reviewer')); } catch (e) { throw new HttpError(404, (e as Error).message); }
      }
      if (sub === 'dynamic' && m === 'GET') {
        const run = db.getRun(runId);
        if (!run) throw new HttpError(404, 'Run not found');
        const a11y = (run.config as { accessibility?: { enabled?: boolean; failRun?: boolean } } | null)?.accessibility;
        return send(res, 200, {
          pages: db.listPages(runId).filter((pg) => pg.decision).map((pg) => ({ url: pg.url, title: pg.title, decision: pg.decision })),
          results: db.listTestResults(runId),
          accessibility: { enabled: a11y?.enabled !== false, failRun: a11y?.failRun === true },
        });
      }
      if (sub === 'actions' && m === 'GET') return send(res, 200, { actions: db.listActions(runId).slice(-500) });
      if (sub === 'simulation' && m === 'GET') {
        if (!db.getRun(runId)) throw new HttpError(404, 'Run not found');
        return send(res, 200, { simulation: orch.buildSimulation(runId) });
      }
      if (sub === 'live-preview' && m === 'GET') {
        const frame = orch.getFrame(runId);
        if (frame?.buffer) {
          const contentType = frame.buffer[0] === 0x89 && frame.buffer[1] === 0x50 ? 'image/png' : 'image/jpeg';
          res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache, no-store, must-revalidate', 'content-length': frame.buffer.length });
          res.end(frame.buffer);
          return;
        }
        const latestEv = db.listEvidence(runId).reverse().find((e) => e.kind === 'visual-current' || e.kind === 'screenshot');
        if (latestEv) { serveEvidence(res, runId, latestEv.id); return; }
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
        return;
      }
      if (sub.startsWith('evidence/') && m === 'GET') return serveEvidence(res, runId, sub.slice('evidence/'.length));
      if (sub === 'report.html' && m === 'GET') return serveReport(res, runId, 'html');
      if (sub === 'report.json' && m === 'GET') return serveReport(res, runId, 'json');
      if (sub === 'report.xml' && m === 'GET') return serveReport(res, runId, 'xml');
    }

    const fm = /^\/api\/findings\/([\w-]+)\/decision$/.exec(p);
    if (fm && m === 'POST') {
      const body = DecisionBody.safeParse(await readJson(req));
      if (!body.success) throw new HttpError(400, body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      if (!db.getFinding(fm[1]!)) throw new HttpError(404, 'Finding not found');
      const view = orch.decide(fm[1]!, body.data.decision, body.data.note, body.data.decidedBy ?? 'reviewer');
      const run = db.getRun(view.runId)!;
      return send(res, 200, { finding: { id: view.id, reviewState: view.reviewState, decision: view.decision }, verdict: run.verdict });
    }

    if (p.startsWith('/api/')) throw new HttpError(404, 'Not found');
    if (m === 'GET' && serveStatic(res, p)) return;
    throw new HttpError(404, webDir ? 'Not found' : 'Dashboard not built. Run "npm run web:build" or use "npm run dev:web".');
  }

  return http.createServer((req, res) => {
    route(req, res).catch((e) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (!(e instanceof HttpError)) console.error('[api] unexpected error:', platform.redactor.redact(e instanceof Error ? (e.stack ?? e.message) : String(e)));
      if (!res.headersSent) send(res, status, { error: e instanceof HttpError ? e.message : 'Internal server error' }); else res.end();
    });
  });
}

export function startApi(platform: Platform, opts: ApiOptions & { host?: string; port?: number } = {}): Promise<{ server: http.Server; url: string }> {
  const server = createApiServer(platform, opts);
  const host = opts.host ?? platform.config.server.host; const port = opts.port ?? platform.config.server.port;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ server, url: `http://${host}:${actual}` });
    });
  });
}
