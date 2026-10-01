import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BANNER_SVG, PAGES } from './pages.js';

/** Syntactically valid (unsigned, demo-only) JWT. Public on purpose: it protects nothing. */
export const DEMO_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZW1vIiwibmFtZSI6IkRlbW8gVXNlciJ9.ZGVtby1zaWduYXR1cmUtbm90LXJlYWw';

export interface DemoServer {
  url: string;
  port: number;
  /** Counters for requests that a safe QA run must NEVER cause. */
  hits: Record<string, number>;
  requests: { method: string; path: string }[];
  close(): Promise<void>;
}

function authorized(req: http.IncomingMessage): boolean {
  const h = req.headers.authorization;
  if (h && h === `Bearer ${DEMO_JWT}`) return true;
  const cookie = req.headers.cookie ?? '';
  return cookie.split(/;\s*/).some((c) => /^(token|session)=/.test(c) && c.split('=')[1] === DEMO_JWT);
}

export async function startDemoApp(port = 0, opts: { slowMs?: number } = {}): Promise<DemoServer> {
  const slowMs = opts.slowMs ?? Number(process.env.DEMO_SLOW_MS ?? 3500);
  const hits: Record<string, number> = { deleteAccount: 0, purchase: 0, subscribe: 0, deleteLink: 0 };
  const requests: DemoServer['requests'] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const p = u.pathname;
    requests.push({ method: req.method ?? 'GET', path: p });
    const json = (code: number, body: unknown) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (p === '/api/_hits') return json(200, hits);
    if (p === '/api/fail') return json(500, { error: 'demo failure' });
    if (p === '/api/ok') return json(200, { ok: true });
    if (p === '/api/slow') { setTimeout(() => json(200, { value: 'slow response' }), slowMs); return; }
    if (p === '/api/me') return authorized(req) ? json(200, { name: 'Demo User' }) : json(401, { error: 'unauthorized' });
    if (p === '/api/subscribe') { hits.subscribe!++; return json(200, { ok: true }); }
    if (p === '/api/delete-account') { hits.deleteAccount!++; return json(200, { deleted: true }); }
    if (p === '/api/purchase') { hits.purchase!++; return json(200, { purchased: true }); }
    if (p === '/api/delete-account-link') { hits.deleteLink!++; return json(200, { deleted: true }); }
    if (p === '/api/contact') return json(200, { ok: true });
    if (p === '/img/banner.svg') { res.setHeader('content-type', 'image/svg+xml'); return void res.end(BANNER_SVG); }
    if (p === '/error-500') { res.statusCode = 500; res.setHeader('content-type', 'text/html'); return void res.end(PAGES['/error-500']); }
    const page = PAGES[p];
    if (page) { res.setHeader('content-type', 'text/html; charset=utf-8'); return void res.end(page); }
    res.statusCode = 404; res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html lang="en"><head><title>Not found</title></head><body><main><h1>404 Not Found</h1></main></body></html>');
  });
  await new Promise<void>((r) => server.listen(port, process.env.DEMO_HOST ?? '127.0.0.1', r));
  const actual = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${actual}`, port: actual, hits, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
