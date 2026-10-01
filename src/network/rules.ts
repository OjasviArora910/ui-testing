import type { NetworkEvent } from '../browser/types.js';
import { makeFinding } from '../rules/helpers.js';
import type { Rule } from '../rules/types.js';
import type { Finding, Severity } from '../shared/types.js';

function describe(n: NetworkEvent): string {
  return n.status === null ? `${n.method} ${n.url} failed: ${n.failure ?? 'unknown'}` : `${n.method} ${n.url} returned HTTP ${n.status}`;
}

function severityFor(n: NetworkEvent): Severity {
  if (/favicon\.ico/.test(n.url)) return 'info';
  if (n.status === null) return /TIMED_OUT|TIMEOUT/i.test(n.failure ?? '') ? 'major' : 'major';
  if (n.status >= 500) return 'major';
  if (n.status === 401 || n.status === 403) return 'major';
  return 'minor';
}

export const failedRequestRule: Rule = {
  id: 'network.failed-request', name: 'Failed network request', category: 'network', severity: 'major', basis: 'deterministic',
  description: 'A request returned HTTP 4xx/5xx or failed at transport level (excluding ignored endpoints and requests blocked by the platform guard).',
  async evaluate(ctx) {
    const seen = new Set<string>();
    const out: Finding[] = [];
    for (const n of ctx.network) {
      if (n.ok || n.ignored || n.blockedByGuard) continue;
      const key = `${n.method} ${n.url} ${n.status ?? n.failure}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(makeFinding(failedRequestRule, ctx, {
        classification: 'defect', severity: severityFor(n),
        element: null, expected: 'Requests made by the page succeed (HTTP status < 400)', actual: describe(n),
      }));
    }
    return out;
  },
};

export const slowRequestRule: Rule = {
  id: 'network.slow-request', name: 'Slow network request', category: 'performance', severity: 'minor', basis: 'configured_rule',
  description: 'A request took longer than network.slowRequestMs. Latency depends on the environment, so this is an anomaly for review.',
  async evaluate(ctx) {
    const limit = ctx.config.network.slowRequestMs;
    const seen = new Set<string>();
    const out: Finding[] = [];
    for (const n of ctx.network) {
      if (n.ignored || n.blockedByGuard || n.durationMs === null || n.durationMs <= limit) continue;
      if (!['fetch', 'xhr', 'document'].includes(n.resourceType)) continue;
      const key = `${n.method} ${n.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(makeFinding(slowRequestRule, ctx, {
        classification: 'anomaly', element: null,
        expected: `Requests complete within ${limit}ms`, actual: `${n.method} ${n.url} took ${Math.round(n.durationMs)}ms`,
      }));
    }
    return out;
  },
};

const RESOURCE_NOISE = /Failed to load resource/i; // already reported by network.failed-request

export const consoleErrorRule: Rule = {
  id: 'console.error', name: 'Console error', category: 'console', severity: 'minor', basis: 'deterministic',
  description: 'The page logged console.error or threw an uncaught exception.',
  async evaluate(ctx) {
    const seen = new Set<string>();
    const out: Finding[] = [];
    for (const c of ctx.console) {
      if (c.level !== 'error' || RESOURCE_NOISE.test(c.text) || seen.has(c.text)) continue;
      seen.add(c.text);
      out.push(makeFinding(consoleErrorRule, ctx, {
        classification: 'defect', severity: c.kind === 'pageerror' ? 'major' : 'minor', element: null,
        expected: 'No console errors or uncaught exceptions',
        actual: `${c.kind === 'pageerror' ? 'Uncaught exception' : 'console.error'}: ${c.text.slice(0, 300)}${c.location ? ` (${c.location})` : ''}`,
      }));
    }
    return out;
  },
};

export const consoleWarningRule: Rule = {
  id: 'console.warning', name: 'Console warning', category: 'console', severity: 'info', basis: 'generic_rule',
  description: 'The page logged console warnings. Informational: warnings are not necessarily defects.',
  async evaluate(ctx) {
    const seen = new Set<string>();
    const out: Finding[] = [];
    for (const c of ctx.console) {
      if (c.level !== 'warning' || RESOURCE_NOISE.test(c.text) || seen.has(c.text)) continue;
      seen.add(c.text);
      out.push(makeFinding(consoleWarningRule, ctx, {
        classification: 'anomaly', element: null, expected: 'No console warnings', actual: `console.warn: ${c.text.slice(0, 300)}`,
      }));
    }
    return out;
  },
};

export const networkRules: Rule[] = [failedRequestRule, slowRequestRule, consoleErrorRule, consoleWarningRule];
