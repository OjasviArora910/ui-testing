import path from 'node:path';
import fs from 'node:fs';
import { startApi } from './api/index.js';
import { startDemoApp, DEMO_JWT } from '../demo-app/server.js';
import { createPlatform } from './orchestrator/bootstrap.js';
import { DirectAuthSchema, RunRequestSchema, TestModeSchema, type DirectAuth } from './shared/runRequest.js';

const HELP = `Autonomous UI/UX QA Platform

Usage:
  qa serve   [--port 4000] [--host 127.0.0.1]     Start API + dashboard (build the dashboard first: npm run web:build)
  qa demo    [--port 3000]                        Start the intentionally broken demo app
  qa run     --url <url> [--token-env VAR --token-location cookie|localStorage|sessionStorage|header [--token-key K]] | [--profile <name>]
             [--mode deterministic|ai_assisted|exploratory]
             [--max-pages N] [--max-depth N] [--max-actions N] [--viewports desktop,tablet,mobile]
                                                  Run one test headlessly; exit code 0=PASS/WARN, 1=FAILED, 2=BLOCKED_PENDING_REVIEW, 3=error
  qa runs                                         List recent runs
  qa resume  <runId>                              Resume an interrupted run
  qa baseline --run <id> --page <url> --viewport <name> [--by <name>]   Approve a run's screenshot as the visual baseline (human action)

Tokens are never passed as arguments (shell history/process list). Put the token in an environment variable and name it
with --token-env (used in memory only, never stored), or reference a server-side auth profile with --profile.
Resuming a token-based run needs the same --token-env/--token-location flags.`;

function parseArgs(argv: string[]): { cmd: string; positional: string[]; flags: Record<string, string> } {
  const [cmd = 'help', ...rest] = argv; const flags: Record<string, string> = {}; const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) { const next = rest[i + 1]; if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = 'true'; else { flags[a.slice(2)] = next; i++; } } else positional.push(a);
  }
  return { cmd, positional, flags };
}

/** Reads a one-time token from the env var named by --token-env. Throws (without the value) when misconfigured. */
function tokenFromEnv(flags: Record<string, string>): DirectAuth | undefined {
  if (!flags['token-env']) return undefined;
  const token = process.env[flags['token-env']];
  if (!token) throw new Error(`Environment variable ${flags['token-env']} is empty or not set`);
  const parsed = DirectAuthSchema.safeParse({ token, location: flags['token-location'] ?? 'cookie', ...(flags['token-key'] ? { key: flags['token-key'] } : {}) });
  if (!parsed.success) throw new Error('Invalid --token-location (cookie | localStorage | sessionStorage | header)');
  return parsed.data;
}

async function main(): Promise<number> {
  const { cmd, positional, flags } = parseArgs(process.argv.slice(2));

  if (cmd === 'demo') {
    const demo = await startDemoApp(Number(flags.port ?? 3000));
    console.log(`Demo app running at ${demo.url}`);
    console.log(`Demo auth token (public, protects nothing): QA_JWT_DEMO=${DEMO_JWT}`);
    await new Promise(() => undefined);
    return 0;
  }

  if (cmd === 'serve') {
    const platform = createPlatform();
    const webDir = ['web/dist', 'dist/web'].map((d) => path.resolve(d)).find((d) => fs.existsSync(path.join(d, 'index.html')));
    const { url } = await startApi(platform, { webDir, host: flags.host, port: flags.port ? Number(flags.port) : undefined });
    console.log(`QA platform API listening on ${url}${webDir ? ' (dashboard served)' : ' (dashboard not built: npm run web:build, or npm run dev:web)'}`);
    console.log(`AI: ${platform.provider ? `${platform.provider.name} / ${platform.provider.model}` : 'not configured (QA_AI_PROVIDER, QA_AI_API_KEY)'} · auth profiles: ${platform.profiles.list().map((p) => p.name).join(', ') || 'none'}`);
    const interrupted = platform.orchestrator.interruptedRuns();
    if (interrupted.length) {
      console.log(`${interrupted.length} interrupted run(s): ${interrupted.map((r) => r.id).join(', ')}`);
      if (process.env.QA_AUTO_RESUME === '1') { try { platform.orchestrator.resume(interrupted[0]!.id); console.log(`Resumed ${interrupted[0]!.id}`); } catch (e) { console.log(`Could not resume: ${(e as Error).message}`); } }
    }
    const stop = async (): Promise<void> => { console.log('Shutting down...'); await platform.orchestrator.shutdown(); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    await new Promise(() => undefined);
    return 0;
  }

  if (cmd === 'runs') {
    const platform = createPlatform();
    for (const r of platform.orchestrator.db.listRuns(30)) console.log(`${r.id}  ${r.status.padEnd(14)} ${(r.verdict ?? '-').padEnd(22)} ${r.mode.padEnd(13)} ${r.url}`);
    return 0;
  }

  if (cmd === 'baseline') {
    const platform = createPlatform();
    if (!flags.run || !flags.page || !flags.viewport) { console.error('--run, --page and --viewport are required'); return 3; }
    const r = platform.orchestrator.approveBaseline(flags.run, flags.page, flags.viewport, flags.by ?? 'cli');
    console.log(`Baseline saved: ${r.file}`);
    return 0;
  }

  if (cmd === 'run' || cmd === 'resume') {
    const platform = createPlatform();
    const orch = platform.orchestrator;
    let runId: string;
    if (cmd === 'resume') {
      if (!positional[0]) { console.error('Usage: qa resume <runId>'); return 3; }
      runId = orch.resume(positional[0], tokenFromEnv(flags)).id;
    } else {
      const mode = TestModeSchema.safeParse(flags.mode ?? 'deterministic');
      if (!mode.success) { console.error('Invalid --mode'); return 3; }
      const all = platform.config.viewports;
      const vps = flags.viewports ? flags.viewports.split(',').map((n) => all.find((v) => v.name === n.trim())).filter((v): v is NonNullable<typeof v> => !!v) : undefined;
      const overrides: Record<string, number> = {};
      if (flags['max-pages']) overrides.maxPages = Number(flags['max-pages']);
      if (flags['max-depth']) overrides.maxDepth = Number(flags['max-depth']);
      if (flags['max-actions']) overrides.maxActions = Number(flags['max-actions']);
      const auth = tokenFromEnv(flags);
      const req = RunRequestSchema.safeParse({ url: flags.url, ...(auth ? { auth } : {}), authProfile: flags.profile, mode: mode.data, ...(vps?.length ? { viewports: vps } : {}), ...(Object.keys(overrides).length ? { overrides } : {}) });
      if (!req.success) { console.error(`Invalid arguments: ${req.error.issues.map((i) => `${i.path.join('.') || 'url'}: ${i.message}`).join('; ')}`); return 3; }
      runId = orch.start(req.data).id;
    }
    console.log(`Run ${runId} started`);
    orch.events.on('event', (e: { runId: string; type: string; message: string }) => { if (e.runId === runId && e.type !== 'action') console.log(`[${e.type}] ${e.message}`); });
    process.on('SIGINT', () => { console.log('Stopping...'); orch.abort(runId, 'interrupted (Ctrl+C)'); });
    const run = await orch.whenDone(runId);
    const s = run.summary;
    console.log(`\nStatus: ${run.status}  Verdict: ${run.verdict ?? 'n/a'}`);
    if (s) console.log(`Pages: ${s.pages}  UI/UX bugs: ${s.counts?.bugs ?? s.defects}  Warnings: ${s.counts?.warnings ?? 0}  To review: ${s.pendingReview}  Accessibility: ${(s.counts?.accessibility ?? 0) + (s.counts?.accessibilityNeedsReview ?? 0)}  Actions: ${s.actions}  Blocked by guard: ${s.guardBlocked}`);
    if (run.error) console.log(`Error: ${run.error}`);
    for (const k of ['html', 'json', 'xml'] as const) { const f = orch.reportPath(runId, k); if (f) console.log(`Report (${k}): ${f}`); }
    if (run.status === 'ERROR') return 3;
    return run.verdict === 'FAILED' ? 1 : run.verdict === 'BLOCKED_PENDING_REVIEW' ? 2 : 0;
  }

  console.log(HELP);
  return cmd === 'help' ? 0 : 3;
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(3); });
