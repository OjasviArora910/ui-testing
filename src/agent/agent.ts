import type { BrowserController } from '../browser/index.js';
import type { ElementInfo } from '../browser/types.js';
import { normalizeUrl, sameOrigin } from '../discovery/crawler.js';
import type { ActionGuard } from '../functional/actionGuard.js';
import { extractJson } from '../ai/schema.js';
import { sanitizeUntrusted, FIX_PROMPT } from '../ai/prompt.js';
import type { AIProvider } from '../ai/provider.js';
import type { QAConfig } from '../shared/config.js';
import { actionSignature, LoopDetector, stateSignature } from './loopDetector.js';
import { AGENT_SYSTEM_PROMPT } from './prompt.js';
import { AgentStepSchema, type AgentAction, type AgentReport, type AgentResult, type AgentStepRecord, type StopReason } from './tools.js';

export interface AgentOptions {
  controller: BrowserController;
  guard: ActionGuard;
  provider: AIProvider;
  config: QAConfig['agent'];
  startUrl: string;
  signal?: AbortSignal;
  now?: () => number;
  onStep?: (s: AgentStepRecord) => void;
  /** Called for the `screenshot` tool so the orchestrator can store it as evidence. */
  onScreenshot?: (png: Buffer, url: string) => void;
}

interface Observed { url: string; title: string; elements: ElementInfo[]; refs: Map<string, ElementInfo>; dialogOpen: boolean }

const clean = (s: string | undefined, n = 70): string => sanitizeUntrusted(s ?? '', n).text;

/**
 * Optional exploratory agent: OBSERVE -> PLAN -> ACTION -> OBSERVE -> VALIDATE -> CONTINUE/STOP.
 * The LLM only proposes JSON actions; every action is schema-validated, checked by the shared ActionGuard, and executed by
 * BrowserController. All page text reaches the model as sanitised, delimited untrusted data.
 */
export class ReactAgent {
  private readonly c: BrowserController;
  private readonly now: () => number;
  private readonly detector: LoopDetector;

  constructor(private readonly o: AgentOptions) {
    this.c = o.controller; this.now = o.now ?? Date.now;
    this.detector = new LoopDetector({ maxRepeatedActions: o.config.maxRepeatedActions, maxRepeatedStates: o.config.maxRepeatedStates, noProgressLimit: o.config.noProgressLimit });
  }

  private async observe(): Promise<Observed> {
    const all = await this.c.interactiveElements();
    const elements = all.filter((e) => e.visible && e.enabled).slice(0, 40);
    const refs = new Map(elements.map((e, i) => [`e${i + 1}`, e]));
    const dialogOpen = await this.c.page.evaluate("!!document.querySelector('dialog[open], [role=dialog]:not([hidden]), [aria-modal=true]:not([hidden])')") as boolean;
    return { url: this.c.url, title: clean(await this.c.page.title(), 80), elements, refs, dialogOpen };
  }

  private describe(ob: Observed, recent: AgentStepRecord[], toolResult: string, newProblems: string[], budget: string): string {
    const lines = [...ob.refs.entries()].map(([id, e]) => `${id} ${e.role ?? e.tag} "${clean(e.name || e.text, 50)}"${e.href ? ` -> ${clean(e.href, 80)}` : ''}${e.type ? ` [${e.type}]` : ''}`);
    const hist = recent.slice(-5).map((s) => `#${s.n} ${s.action ? JSON.stringify(s.action) : '-'} => ${s.outcome}: ${clean(s.detail, 120)}`);
    return `${budget}\n<untrusted_page>\nURL: ${clean(ob.url, 200)}\nTitle: ${ob.title}\nDialog open: ${ob.dialogOpen}\nInteractive elements:\n${lines.join('\n') || '(none)'}\n${newProblems.length ? `New problems since last step:\n${newProblems.join('\n')}\n` : ''}${toolResult ? `Tool result:\n${clean(toolResult, 1800)}\n` : ''}</untrusted_page>\nRecent actions:\n${hist.join('\n') || '(none)'}\nChoose the next action.`;
  }

  async run(): Promise<AgentResult> {
    const { config: cfg, guard } = this.o;
    const startedAt = this.now();
    const steps: AgentStepRecord[] = [];
    const reports: AgentReport[] = [];
    const visited = new Set<string>();
    const net0 = this.c.events.network.length; const con0 = this.c.events.console.length;
    let llmCalls = 0; let actions = 0; let depth = 0; let maxDepth = 0; let stop: StopReason | null = null;
    let toolResult = ''; let lastNet = net0; let lastCon = con0;

    const start = normalizeUrl(this.o.startUrl, this.o.startUrl);
    if (start && this.c.url !== this.o.startUrl) { await this.c.navigate(this.o.startUrl); await this.c.settle(150); }
    visited.add(normalizeUrl(this.c.page.url(), this.o.startUrl) ?? this.c.url);

    let ob = await this.observe();
    this.detector.checkState(stateSignature(ob.url, ob.elements, ob.dialogOpen), true);
    let invalidStreak = 0; let history: { role: 'user' | 'assistant'; content: string }[] = [];

    for (let n = 1; !stop; n++) {
      if (this.o.signal?.aborted) { stop = 'abort'; break; }
      if (this.now() - startedAt > cfg.maxRuntimeMs) { stop = 'max_runtime'; break; }
      if (actions >= cfg.maxActions || n > cfg.maxActions * 3) { stop = 'max_actions'; break; }
      if (llmCalls >= cfg.maxLlmCalls) { stop = 'budget_exhausted'; break; }

      const problems = [
        ...this.c.events.network.slice(lastNet).filter((x) => !x.ok && !x.ignored && !x.blockedByGuard).map((x) => `request failed: ${x.method} ${clean(x.url, 100)} ${x.status ?? x.failure}`),
        ...this.c.events.console.slice(lastCon).filter((x) => x.level === 'error').map((x) => `console error: ${clean(x.text, 120)}`),
      ];
      lastNet = this.c.events.network.length; lastCon = this.c.events.console.length;
      const user = this.describe(ob, steps, toolResult, problems, `Step ${n}. Actions ${actions}/${cfg.maxActions}, pages ${visited.size}/${cfg.maxPages}, depth ${depth}/${cfg.maxDepth}.`);
      toolResult = '';

      llmCalls++;
      let text: string;
      try { text = (await this.o.provider.complete({ system: AGENT_SYSTEM_PROMPT, user, history, maxTokens: 600 }, this.o.signal)).text; } catch (e) {
        steps.push(this.record(n, '', null, 'invalid', `provider error: ${e instanceof Error ? e.message : String(e)}`, ob)); stop = 'error'; break;
      }
      const parsed = AgentStepSchema.safeParse(extractJson(text));
      if (!parsed.success) {
        invalidStreak++;
        const why = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
        steps.push(this.record(n, '', null, 'invalid', `invalid output: ${why}`, ob)); this.o.onStep?.(steps.at(-1)!);
        history = [{ role: 'assistant', content: text.slice(0, 600) }, { role: 'user', content: FIX_PROMPT(why) }];
        if (invalidStreak >= 3) stop = 'error';
        continue;
      }
      invalidStreak = 0; history = [];
      const { thought, action } = parsed.data;

      if (action.tool === 'stop') { steps.push(this.record(n, thought, action, 'stopped', action.reason, ob)); stop = 'agent_stop'; break; }

      const el = 'element' in action && action.element ? ob.refs.get(action.element) : undefined;
      if ('element' in action && action.element && !el) {
        steps.push(this.record(n, thought, action, 'invalid', `unknown element ${action.element}`, ob)); this.o.onStep?.(steps.at(-1)!); continue;
      }

      const loop = this.detector.checkAction(actionSignature(action, el ? { role: el.role, name: el.name || el.text } : undefined));
      if (loop === 'repeated_action') { steps.push(this.record(n, thought, action, 'stopped', 'same action repeated too often', ob)); stop = 'repeated_action'; break; }

      // ---- shared safety guard
      const decision = this.guardCheck(action, el);
      if (!decision.allowed) {
        steps.push(this.record(n, thought, action, 'blocked', `blocked by ActionGuard: ${decision.reason}`, ob)); this.o.onStep?.(steps.at(-1)!);
        const v = this.detector.checkState(stateSignature(ob.url, ob.elements, ob.dialogOpen), false);
        if (v !== 'ok') stop = v;
        continue;
      }

      // ---- inspection / reporting tools do not consume an action
      if (['inspectDOM', 'inspectARIA', 'inspectGeometry', 'inspectNetwork', 'inspectConsole', 'screenshot', 'report'].includes(action.tool)) {
        toolResult = await this.inspect(action, el, reports, ob);
        steps.push(this.record(n, thought, action, 'inspected', clean(toolResult, 160) || 'ok', ob)); this.o.onStep?.(steps.at(-1)!);
        const v = this.detector.checkState(stateSignature(ob.url, ob.elements, ob.dialogOpen), false);
        if (v !== 'ok') stop = v;
        continue;
      }

      // ---- budgets that depend on the destination
      const beforeUrl = normalizeUrl(this.c.page.url(), this.o.startUrl);
      if (action.tool === 'navigate') {
        const dest = normalizeUrl(action.url, this.c.page.url());
        if (dest && !visited.has(dest) && visited.size >= cfg.maxPages) { stop = 'max_pages'; break; }
      }

      actions++;
      const net1 = this.c.events.network.length;
      const result = await this.execute(action, el);
      await this.c.settle(200);
      const afterUrl = normalizeUrl(this.c.page.url(), this.o.startUrl);
      if (afterUrl && !sameOrigin(afterUrl, this.o.startUrl)) { await this.c.navigate(this.o.startUrl); await this.c.settle(150); }
      const newPage = !!afterUrl && !visited.has(afterUrl);
      if (afterUrl && afterUrl !== beforeUrl) { depth++; maxDepth = Math.max(maxDepth, depth); }
      if (afterUrl) visited.add(afterUrl);

      ob = await this.observe();
      steps.push(this.record(n, thought, action, 'executed', result.ok ? 'ok' : `failed: ${result.error ?? ''}`, ob)); this.o.onStep?.(steps.at(-1)!);

      if (depth > cfg.maxDepth) { stop = 'max_depth'; break; }
      if (visited.size > cfg.maxPages) { stop = 'max_pages'; break; }
      const v = this.detector.checkState(stateSignature(ob.url, ob.elements, ob.dialogOpen), newPage || this.c.events.network.length > net1);
      if (v !== 'ok') stop = v;
    }

    return {
      stopReason: stop ?? 'max_actions', steps, actionsTaken: actions, llmCalls, pagesVisited: [...visited], maxDepthReached: maxDepth, reports,
      networkRange: [net0, this.c.events.network.length], consoleRange: [con0, this.c.events.console.length],
    };
  }

  private record(n: number, thought: string, action: AgentAction | null, outcome: AgentStepRecord['outcome'], detail: string, ob: Observed): AgentStepRecord {
    return { n, thought: this.c.redactor.redact(thought), action, outcome, detail: this.c.redactor.redact(detail), url: ob.url, stateSig: stateSignature(ob.url, ob.elements, ob.dialogOpen) };
  }

  private guardCheck(a: AgentAction, el?: ElementInfo): { allowed: boolean; reason?: string } {
    const guard = this.o.guard;
    switch (a.tool) {
      case 'navigate': return guard.check({ kind: 'navigate', url: new URL(a.url, this.c.page.url()).toString() });
      case 'click': case 'hover': case 'fill': case 'select': case 'press':
        return guard.check({
          kind: a.tool, name: el?.name, text: el?.text, selector: el?.selector, role: el?.role ?? undefined, href: el?.href ?? undefined,
          fieldName: el?.selector, fieldType: el?.type,
        });
      default: return { allowed: true };
    }
  }

  private async execute(a: AgentAction, el?: ElementInfo) {
    const t = el ? { css: el.selector } : { css: 'body' };
    switch (a.tool) {
      case 'navigate': return this.c.navigate(a.url);
      case 'click': return this.c.click(t);
      case 'fill': return this.c.fill(t, a.value);
      case 'select': return this.c.select(t, a.value);
      case 'hover': return this.c.hover(t);
      case 'scroll': return this.c.scroll(a.direction === 'top' || a.direction === 'bottom' ? { to: a.direction } : { by: a.direction === 'up' ? -600 : 600 });
      case 'press': return this.c.press(a.key);
      default: return { ok: true, durationMs: 0, urlBefore: '', urlAfter: '', newNetworkEvents: 0, newConsoleErrors: 0 };
    }
  }

  private async inspect(a: AgentAction, el: ElementInfo | undefined, reports: AgentReport[], ob: Observed): Promise<string> {
    switch (a.tool) {
      case 'inspectDOM': return (await this.c.dom()).slice(0, 2000);
      case 'inspectARIA': return (await this.c.aria()).slice(0, 2000);
      case 'inspectGeometry': {
        if (el) return JSON.stringify({ selector: el.selector, box: el.box, position: el.styles.position, overflow: el.styles.overflow, scroll: el.scroll });
        return JSON.stringify(await this.c.pageMetrics());
      }
      case 'inspectNetwork': return this.c.events.network.slice(-10).map((n) => `${n.method} ${n.url} ${n.status ?? n.failure}`).join('\n');
      case 'inspectConsole': return this.c.events.console.slice(-10).map((x) => `${x.level}: ${x.text}`).join('\n');
      case 'screenshot': { const png = await this.c.screenshot({ fullPage: false }); this.o.onScreenshot?.(png, ob.url); return 'screenshot captured'; }
      case 'report':
        reports.push({ description: this.c.redactor.redact(a.description), url: ob.url, selector: el?.selector, name: el?.name });
        return 'reported for human review';
      default: return '';
    }
  }
}
