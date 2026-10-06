/**
 * ActionGuard: the single safety gate. Used by functional testing, the crawler AND the ReAct agent.
 * It blocks (1) actions whose visible intent is destructive, (2) cross-origin navigation,
 * (3) payment-looking fields, and (4) at network level any write method not explicitly allowed.
 */
export type GuardActionKind = 'click' | 'fill' | 'select' | 'check' | 'hover' | 'press' | 'submit' | 'navigate';

export interface GuardAction {
  kind: GuardActionKind;
  /** Visible/accessible text of the target. */
  text?: string;
  name?: string;
  role?: string;
  selector?: string;
  href?: string;
  /** For submit: the form's action URL and method. */
  formAction?: string;
  method?: string;
  /** For navigate. */
  url?: string;
  /** Field metadata for fill/select. */
  fieldType?: string;
  fieldName?: string;
  autocomplete?: string;
}

export interface GuardDecision {
  allowed: boolean; reason?: string; matched?: string;
  /**
   * destructive  removes or ends something: NEVER executable, by any policy
   * mutating     creates or changes something: blocked by default, executable only inside an explicitly authorized workflow step
   */
  tier?: 'destructive' | 'mutating';
}

/**
 * An explicit, narrow permission to perform ONE controlled mutation on ONE page. It never covers a destructive action and
 * never a DELETE request, and it is only in force between beginWorkflowStep() and endWorkflowStep().
 */
export interface WorkflowAuthorization {
  /** The exact page (full URL, hash route included) the workflow belongs to. */
  page: string;
  /** Mutating control labels that may be clicked during the step (e.g. "create", "save"). Destructive labels are refused. */
  labels: string[];
  /** The exact requests the commit may send: method + path on the application's own origin. */
  requests: { method: string; path: string }[];
  /** How many authorized requests may leave the browser in one run. Default and maximum: 1. */
  maxCommits?: number;
}
export interface GuardLogEntry { at: number; action: GuardAction; decision: GuardDecision }

export interface ActionGuardOptions {
  keywords: string[];
  allowMethods: string[];
  /** Origin under test. Navigation elsewhere is refused. */
  origin: string;
  /** Allow write methods at network level (explicit opt-in, e.g. functional.submitValidForms). */
  allowWrites?: boolean;
  /**
   * Requests that may leave the browser although their method is not a read method: READ-ONLY data endpoints that happen
   * to be called with POST. Each entry is one exact origin + method + path. No wildcards, no patterns, and a path that
   * looks like it changes anything can never be listed.
   */
  allowedRequests?: AllowedRequest[];
}

export interface AllowedRequest { origin: string; method: string; path: string }

/** A path containing any of these is never allow-listed, whatever the configuration says. */
const NEVER_ALLOWED_PATH = /delete|remove|purge|destroy|erase|wipe|drop|clear|reset|truncate|trash|save|update|upsert|insert|create|add|send|upload|import|publish|approve|archive|merge|move|rename|edit|modify|change|assign|execute|logout|signout|pay|purchase|order|cancel/i;

/** Always dangerous, regardless of config: they end sessions or move money. */
const BUILTIN_KEYWORDS = ['logout', 'log out', 'sign out', 'signout', 'cancel subscription', 'place order', 'submit order', 'send money', 'withdraw', 'transfer funds',
  'create', 'save', 'update', 'delete', 'remove', 'assign', 'publish', 'submit', 'lock out', 'lockout', 'confirm', 'yes',
  'purge', 'destroy', 'erase', 'wipe', 'trash', 'permanently'];
/** Keywords that only create or change something. Every other keyword (built in or configured) is destructive. */
const MUTATING_KEYWORDS = new Set(['create', 'save', 'update', 'assign', 'publish', 'submit', 'confirm', 'yes']);
/** A request path containing any of these never leaves the browser with a write method, whatever was authorized. */
const DESTRUCTIVE_PATH = /delete|remove|purge|destroy|erase|wipe|drop|truncate|trash|lock.?out|logout|signout|deactivate|terminate|revoke/i;
const PAYMENT_FIELD = /(card|cvv|cvc|iban|routing|account.?number|cc-)/i;

function normalize(s: string): string {
  const words = s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const joinedLetters = words.replace(/\b(?:[a-z]\s+){2,}[a-z]\b/g, (m) => m.replace(/\s+/g, ''));
  return ` ${joinedLetters} `;
}

export class ActionGuard {
  readonly log: GuardLogEntry[] = [];
  private readonly keywords: string[];
  private readonly allowMethods: Set<string>;
  private readonly origin: string;
  private allowWrites: boolean;
  private readonly allowedRequests: AllowedRequest[] = [];
  /** Allow-list entries that were refused (wildcard, malformed, or a path that looks like it changes something). */
  readonly rejectedAllowRules: { rule: AllowedRequest; reason: string }[] = [];
  /** Every request let through by the allow-list, with the entry that allowed it. */
  readonly allowedByRule: { at: number; method: string; url: string; rule: string }[] = [];

  constructor(opts: ActionGuardOptions) {
    this.keywords = [...new Set([...opts.keywords, ...BUILTIN_KEYWORDS].map((k) => normalize(k).trim()).filter(Boolean))];
    this.allowMethods = new Set(opts.allowMethods.map((m) => m.toUpperCase()));
    this.origin = new URL(opts.origin).origin;
    this.allowWrites = opts.allowWrites ?? false;
    for (const rule of opts.allowedRequests ?? []) {
      const reason = this.refuseRule(rule);
      if (reason) this.rejectedAllowRules.push({ rule, reason });
      else this.allowedRequests.push({ origin: new URL(rule.origin).origin, method: rule.method.toUpperCase(), path: rule.path });
    }
  }

  private refuseRule(rule: AllowedRequest): string | null {
    if (!/^[A-Za-z]+$/.test(rule.method)) return 'method is not valid';
    if (!/^\/[A-Za-z0-9_\-./]*[A-Za-z0-9_\-]$/.test(rule.path)) return 'wildcards and patterns are not accepted: the path must be one exact path';
    if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?\/?$/.test(rule.origin)) return 'origin must be scheme and host only, without wildcards';
    let origin = ''; try { origin = new URL(rule.origin).origin; } catch { return 'origin is not a valid URL'; }
    if (origin !== rule.origin.replace(/\/$/, '')) return 'origin must be scheme and host only, without wildcards';
    if (NEVER_ALLOWED_PATH.test(rule.path) || this.matchKeyword(rule.path)) return 'the path looks like it changes or removes something; such a path can never be allowed';
    return null;
  }

  /** The allow-list entry matching this request exactly (origin, method and path), if any. */
  private allowRule(method: string, url: string): AllowedRequest | undefined {
    let u: URL; try { u = new URL(url); } catch { return undefined; }
    return this.allowedRequests.find((r) => r.method === method && r.origin === u.origin && r.path === u.pathname);
  }

  get blockedCount(): number { return this.log.filter((l) => !l.decision.allowed).length; }

  private matchKeyword(...parts: (string | undefined)[]): string | undefined {
    // Letter-spaced labels ("C r e a t e") are read as the word they spell. Each part (text, name, selector...) is read
    // on its own: joined first, a spaced name followed by the same spaced text would run together into one non-word.
    const hay = parts.filter((p): p is string => !!p).map((p) => {
      const n = normalize(p);
      return n + n.replace(/(?<= )((?:[a-z0-9] ){3,})/g, (m: string) => `${m.replace(/ /g, '')} `);
    }).join(' ');
    // a destructive word decides first: "Save and delete" is destructive, not merely mutating
    const hits = this.keywords.filter((k) => hay.includes(` ${k} `));
    return hits.find((k) => !MUTATING_KEYWORDS.has(k)) ?? hits[0];
  }

  // ---------------------------------------------------------------- controlled workflow (optional, explicit, narrow)
  private workflow: { auth: WorkflowAuthorization; labels: Set<string>; requests: { method: string; path: string }[]; active: boolean; commits: number; max: number } | null = null;
  /** Every use of the workflow authorization: which rule allowed what, and why. */
  readonly workflowLog: { at: number; what: string; why: string }[] = [];

  /**
   * Registers a workflow authorization. Returns the reasons for anything in it that was refused (empty: accepted as is).
   * Refused parts are dropped, never widened: destructive labels, DELETE or non-write methods, patterns, destructive paths.
   */
  authorizeWorkflow(auth: WorkflowAuthorization): string[] {
    const refused: string[] = [];
    const labels = new Set<string>();
    for (const raw of auth.labels) {
      const k = normalize(raw).trim();
      if (MUTATING_KEYWORDS.has(k)) labels.add(k);
      else refused.push(`label "${raw}": only mutating actions (${[...MUTATING_KEYWORDS].join(', ')}) can be authorized; destructive actions never`);
    }
    const requests: { method: string; path: string }[] = [];
    for (const r of auth.requests) {
      const method = String(r.method).toUpperCase();
      if (method === 'DELETE') refused.push(`${method} ${r.path}: DELETE can never be authorized`);
      else if (!['POST', 'PUT', 'PATCH'].includes(method)) refused.push(`${method} ${r.path}: only POST, PUT or PATCH can be authorized`);
      else if (!/^\/[A-Za-z0-9_\-./]*[A-Za-z0-9_\-]$/.test(r.path)) refused.push(`${method} ${r.path}: the path must be one exact path (no wildcards or patterns)`);
      else if (DESTRUCTIVE_PATH.test(r.path)) refused.push(`${method} ${r.path}: the path names a destructive operation; it can never be authorized`);
      else requests.push({ method, path: r.path });
    }
    let page = ''; try { page = new URL(auth.page).toString(); } catch { refused.push(`page "${auth.page}" is not a valid URL`); }
    if (page && new URL(page).origin !== this.origin) { refused.push(`page ${auth.page} is not on the origin under test`); page = ''; }
    this.workflow = page ? { auth: { ...auth, page }, labels, requests, active: false, commits: this.workflow?.commits ?? 0, max: Math.min(1, Math.max(0, auth.maxCommits ?? 1)) } : null;
    return refused;
  }

  /** Puts the authorization in force for one step, only when the browser is on exactly the authorized page. */
  beginWorkflowStep(currentUrl: string): boolean {
    const w = this.workflow;
    if (!w) return false;
    let here = ''; try { here = new URL(currentUrl).toString(); } catch { here = ''; }
    w.active = here === w.auth.page;
    this.workflowLog.push({ at: Date.now(), what: w.active ? 'workflow step started' : 'workflow step refused', why: w.active ? `on the authorized page ${w.auth.page}` : `the browser is on ${currentUrl}, not on the authorized page` });
    return w.active;
  }
  endWorkflowStep(): void { if (this.workflow?.active) { this.workflow.active = false; this.workflowLog.push({ at: Date.now(), what: 'workflow step ended', why: `${this.workflow.commits} authorized request(s) sent` }); } }
  get workflowCommits(): number { return this.workflow?.commits ?? 0; }
  /** True for a label that is a mutating action (create, save, ...): the only kind a workflow can be authorized for. */
  isMutatingLabel(label: string): boolean { return MUTATING_KEYWORDS.has(normalize(label).trim()); }
  /** True when this write is one of the exact read-only allow-list entries (a data read that uses POST). Logs nothing. */
  isReadOnlyAllowed(method: string, url: string): boolean { return !!this.allowRule(method.toUpperCase(), url); }

  private urlText(u?: string): string {
    if (!u) return '';
    try { const x = new URL(u, this.origin); return decodeURIComponent(`${x.pathname} ${x.search}`); } catch { return u; }
  }

  private isSameOrigin(u?: string): boolean {
    if (!u) return true;
    try {
      const x = new URL(u, this.origin);
      if (x.protocol === 'javascript:' || x.protocol === 'data:' || x.protocol === 'mailto:' || x.protocol === 'tel:') return false;
      return x.origin === this.origin;
    } catch { return false; }
  }

  /** Decide whether an intended action may be performed. Every decision is logged. */
  check(action: GuardAction): GuardDecision {
    const decision = this.decide(action);
    this.log.push({ at: Date.now(), action, decision });
    return decision;
  }

  private decide(a: GuardAction): GuardDecision {
    const target = a.kind === 'navigate' ? a.url : a.href;
    if ((a.kind === 'navigate' || a.href) && target && !this.isSameOrigin(target)) {
      return { allowed: false, reason: 'cross-origin or non-http navigation is not allowed', matched: 'external' };
    }
    const kw = this.matchKeyword(a.text, a.name, a.selector, this.urlText(target), this.urlText(a.formAction));
    if (kw) {
      const tier = MUTATING_KEYWORDS.has(kw) ? 'mutating' as const : 'destructive' as const;
      // a mutating control may be used only during an authorized workflow step that names it; a destructive one never
      if (tier === 'mutating' && this.workflow?.active && this.workflow.labels.has(kw)) {
        this.workflowLog.push({ at: Date.now(), what: `control "${(a.text || a.name || a.selector || '').slice(0, 60)}" allowed`, why: `mutating action "${kw}" is named by the active workflow authorization for ${this.workflow.auth.page}` });
        return { allowed: true, reason: `authorized workflow step ("${kw}")`, matched: kw, tier };
      }
      return { allowed: false, reason: `dangerous action keyword "${kw}"`, matched: kw, tier };
    }
    if ((a.kind === 'fill' || a.kind === 'select') && (PAYMENT_FIELD.test(a.fieldName ?? '') || PAYMENT_FIELD.test(a.autocomplete ?? ''))) {
      return { allowed: false, reason: 'payment-related field', matched: 'payment-field' };
    }
    return { allowed: true };
  }

  /**
   * Network-level decision for one request, with the reason when it is refused. Every refusal is logged.
   * Order (the first refusal wins):
   *  1. DELETE: never, before any allow-list, workflow authorization or write permission is even looked at;
   *  2. a write to a path that names a destructive operation: never;
   *  3. read methods: allowed, unless the path matches a guard keyword;
   *  4. an exact read-only allow-list entry;
   *  5. an exact endpoint of the workflow authorization, only while its step is active and its commit budget is unspent;
   *  6. the explicit write opt-in (functional.submitValidForms);
   *  everything else is blocked.
   */
  requestDecision(req: { method: string; url: string }): GuardDecision {
    const method = req.method.toUpperCase();
    if (req.url.startsWith('data:') || req.url.startsWith('blob:')) return { allowed: true };
    const refuse = (reason: string, matched: string, tier?: GuardDecision['tier']): GuardDecision => {
      const decision: GuardDecision = { allowed: false, reason, matched, ...(tier ? { tier } : {}) };
      this.log.push({ at: Date.now(), action: { kind: 'submit', url: req.url, method }, decision });
      return decision;
    };
    // 1. DELETE never leaves the browser
    if (method === 'DELETE') return refuse('DELETE requests are never allowed', 'DELETE', 'destructive');
    const read = this.allowMethods.has(method); // the configured read methods (GET, HEAD, OPTIONS by default); DELETE was refused above whatever the configuration
    let path = ''; let origin = ''; try { const u = new URL(req.url, this.origin); path = u.pathname; origin = u.origin; } catch { /* unparsable: treated as unknown */ }
    // 2. a write that names a destructive operation
    if (!read && DESTRUCTIVE_PATH.test(path)) return refuse(`write to a path that names a destructive operation (${path.slice(0, 80)})`, 'destructive-path', 'destructive');

    const sameOrigin = this.isSameOrigin(req.url);
    const kw = sameOrigin ? this.matchKeyword(this.urlText(req.url)) : undefined;
    const destructiveKw = kw !== undefined && !MUTATING_KEYWORDS.has(kw);
    if (kw && (read || destructiveKw)) return refuse(`request path matches dangerous keyword "${kw}"`, kw, destructiveKw ? 'destructive' : 'mutating');
    // 3. reads
    if (read) return { allowed: true };

    // 4. exact read-only allow-list entry (its path can never look like a mutation: checked when the entry was accepted)
    const rule = this.allowRule(method, req.url);
    if (rule && !kw) {
      const entry = `${rule.method} ${rule.path}`;
      this.allowedByRule.push({ at: Date.now(), method, url: req.url.split('?')[0]!, rule: entry });
      return { allowed: true, reason: `allow-list entry ${entry}`, matched: entry };
    }
    // 5. the active workflow step's own endpoint, once
    const w = this.workflow;
    if (w?.active && origin === this.origin && w.requests.some((r) => r.method === method && r.path === path)) {
      if (w.commits >= w.max) return refuse(`the workflow's commit budget (${w.max}) is already spent`, 'workflow-budget', 'mutating');
      w.commits++;
      this.workflowLog.push({ at: Date.now(), what: `request ${method} ${path} allowed`, why: `exact endpoint of the active workflow authorization for ${w.auth.page} (commit ${w.commits} of ${w.max})` });
      return { allowed: true, reason: `authorized workflow request ${method} ${path}`, matched: `${method} ${path}`, tier: 'mutating' };
    }
    // 6. explicit write opt-in
    if (this.allowWrites && this.allowMethods.size > 0 && !kw) return { allowed: true };
    if (kw) return refuse(`request path matches dangerous keyword "${kw}"`, kw, 'mutating');
    return refuse(`write method ${method} blocked`, method);
  }

  /** Network-level guard: used with BrowserController.setRequestGuard. Returns false => the request is aborted. */
  checkRequest(req: { method: string; url: string }): boolean { return this.requestDecision(req).allowed; }

  /** For BrowserController.setRequestGuard: `true` lets the request through; a string is the reason it is aborted. */
  asRequestGuard(): (req: { method: string; url: string }) => true | string {
    return (r) => { const d = this.requestDecision(r); return d.allowed ? true : `safety guard: ${d.reason ?? 'not allowed'} (only ${[...this.allowMethods].join(', ')} requests may leave the browser)`; };
  }

  /** Temporarily permit writes (only used when config opts in). */
  setAllowWrites(v: boolean): void { this.allowWrites = v; }
}
