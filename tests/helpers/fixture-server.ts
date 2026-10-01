import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Fixture { url: string; received: { authorization?: string; cookie?: string }[]; close(): Promise<void>; }

const PAGE = `<!doctype html><html lang="en"><head><title>Fixture</title></head><body>
<header><nav><a href="/about">About</a> <a href="/missing">Broken</a></nav></header>
<main><h1>Fixture App</h1>
<form id="f"><label for="email">Email</label><input id="email" name="email" type="email" required>
<input type="text" placeholder="Search" title="search box">
<label><input type="checkbox" id="agree"> I agree</label>
<select aria-label="Plan"><option value="a">A</option><option value="b">B</option></select>
<button type="submit">Save</button></form>
<button id="boom" onclick="fetch('/api/boom?token=SUPERSECRET123456')">Boom</button>
<button id="err" onclick="console.error('bad thing happened'); setTimeout(()=>{throw new Error('uncaught!')},0)">Err</button>
<button disabled>Disabled</button>
<div data-testid="hidden" style="display:none">hidden</div>
<img src="/missing.png" alt="Logo">
</main></body></html>`;

export async function startFixture(): Promise<Fixture> {
  const received: Fixture['received'] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/' || u.pathname === '/about') { res.setHeader('content-type', 'text/html'); return void res.end(PAGE); }
    if (u.pathname === '/api/echo') {
      received.push({ authorization: req.headers.authorization, cookie: req.headers.cookie });
      res.setHeader('content-type', 'application/json'); return void res.end('{"ok":true}');
    }
    if (u.pathname === '/api/boom') { res.statusCode = 500; return void res.end('boom'); }
    res.statusCode = 404; res.end('not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, received, close: () => new Promise((r) => server.close(() => r())) };
}
