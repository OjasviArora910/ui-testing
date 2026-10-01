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

export interface GuardDecision { allowed: boolean; reason?: string; matched?: string }
export interface GuardLogEntry { at: number; action: GuardAction; decision: GuardDecision }

export interface ActionGuardOptions {
  keywords: string[];
  allowMethods: string[];
  /** Origin under test. Navigation elsewhere is refused. */
  origin: string;
  /** Allow write methods at network level (explicit opt-in, e.g. functional.submitValidForms). */
  allowWrites?: boolean;
}

/** Always dangerous, regardless of config: they end sessions or move money. */
const BUILTIN_KEYWORDS = ['logout', 'log out', 'sign out', 'signout', 'cancel subscription', 'place order', 'submit order', 'send money', 'withdraw', 'transfer funds'];
const PAYMENT_FIELD = /(card|cvv|cvc|iban|routing|account.?number|cc-)/i;

function normalize(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

export class ActionGuard {
  readonly log: GuardLogEntry[] = [];
  private readonly keywords: string[];
  private readonly allowMethods: Set<string>;
  private readonly origin: string;
  private allowWrites: boolean;

  constructor(opts: ActionGuardOptions) {
    this.keywords = [...new Set([...opts.keywords, ...BUILTIN_KEYWORDS].map((k) => normalize(k).trim()).filter(Boolean))];
    this.allowMethods = new Set(opts.allowMethods.map((m) => m.toUpperCase()));
    this.origin = new URL(opts.origin).origin;
    this.allowWrites = opts.allowWrites ?? false;
  }

  get blockedCount(): number { return this.log.filter((l) => !l.decision.allowed).length; }

  private matchKeyword(...parts: (string | undefined)[]): string | undefined {
    const hay = normalize(parts.filter(Boolean).join(' '));
    return this.keywords.find((k) => hay.includes(` ${k} `));
  }

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
    if (kw) return { allowed: false, reason: `dangerous action keyword "${kw}"`, matched: kw };
    if ((a.kind === 'fill' || a.kind === 'select') && (PAYMENT_FIELD.test(a.fieldName ?? '') || PAYMENT_FIELD.test(a.autocomplete ?? ''))) {
      return { allowed: false, reason: 'payment-related field', matched: 'payment-field' };
    }
    return { allowed: true };
  }

  /** Network-level guard: used with BrowserController.setRequestGuard. Returns false => the request is aborted. */
  checkRequest(req: { method: string; url: string }): boolean {
    const method = req.method.toUpperCase();
    if (req.url.startsWith('data:') || req.url.startsWith('blob:')) return true;
    if (!this.allowWrites && !this.allowMethods.has(method)) {
      this.log.push({ at: Date.now(), action: { kind: 'submit', url: req.url, method }, decision: { allowed: false, reason: `write method ${method} blocked`, matched: method } });
      return false;
    }
    if (this.isSameOrigin(req.url)) {
      const kw = this.matchKeyword(this.urlText(req.url));
      if (kw) {
        this.log.push({ at: Date.now(), action: { kind: 'navigate', url: req.url, method }, decision: { allowed: false, reason: `request path matches dangerous keyword "${kw}"`, matched: kw } });
        return false;
      }
    }
    return true;
  }

  asRequestGuard(): (req: { method: string; url: string }) => boolean { return (r) => this.checkRequest(r); }

  /** Temporarily permit writes (only used when config opts in). */
  setAllowWrites(v: boolean): void { this.allowWrites = v; }
}
