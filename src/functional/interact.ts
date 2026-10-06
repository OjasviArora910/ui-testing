import type { BrowserController } from '../browser/index.js';
import type { ElementTarget } from '../browser/types.js';
import { observeAction, type ObservationOptions } from './observer.js';
import type { FunctionalContext, FunctionalKind, FunctionalResult, InferredIntent, InteractionCause, InteractionResult, PostActionObservation, PreActionSnapshot } from './types.js';
import { observedChange } from './verifier.js';

/** What a person would find at the element right now. Read from the page itself, never inferred from a browser error message. */
export interface ElementState {
  present: boolean;
  visible: boolean;
  enabled: boolean;
  /** Its centre can be brought inside the viewport. */
  reachable: boolean;
  /** A click at its centre lands on the element itself (or its own content). */
  hit: boolean;
  /** Who is on top of its centre instead; `floating` = fixed/sticky or dialog UI (banner, modal), which is legitimate layering. */
  cover: { description: string; floating: boolean } | null;
}

const PROBE_SCRIPT = `((sel, scroll) => {
  let el = null;
  try { el = document.querySelector(sel); } catch { /* not a selector this document understands */ }
  if (!el) return { present: false, visible: false, enabled: false, reachable: false, hit: false, cover: null };
  if (scroll) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
  const visible = r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
  const enabled = !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true';
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  const reachable = visible && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
  let hit = false; let cover = null;
  if (reachable) {
    const top = document.elementFromPoint(x, y);
    hit = !!top && (top === el || el.contains(top));
    if (top && !hit && !top.contains(el)) {
      let floating = false;
      for (let n = top; n && n !== document.body; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.position === 'fixed' || s.position === 'sticky' || n.getAttribute('role') === 'dialog' || n.getAttribute('aria-modal') === 'true' || n.tagName === 'DIALOG') { floating = true; break; }
      }
      cover = { description: top.tagName.toLowerCase() + (top.id ? '#' + top.id : ''), floating };
    }
  }
  return { present: true, visible, enabled, reachable, hit, cover };
})`;

const GONE: ElementState = { present: false, visible: false, enabled: false, reachable: false, hit: false, cover: null };

export function probeElement(c: BrowserController, selector: string, scroll = true): Promise<ElementState> {
  return (c.page.evaluate(`${PROBE_SCRIPT}(${JSON.stringify(selector)}, ${scroll})`) as Promise<ElementState>).catch(() => GONE);
}

/** null = nothing about the element stops a person from clicking it. */
function causeOf(s: ElementState): InteractionCause | null {
  if (!s.present || !s.visible || !s.enabled) return 'unavailable';
  if (s.cover) return s.cover.floating ? 'overlay' : 'obstructed';
  return s.reachable && s.hit ? null : 'unknown';
}

function describeState(s: ElementState): string {
  if (!s.present) return 'the element is no longer on the page';
  if (!s.visible) return 'the element is on the page but not displayed';
  if (!s.enabled) return 'the element is disabled';
  if (s.cover) return `<${s.cover.description}> is on top of it`;
  if (!s.reachable) return 'the element is displayed but cannot be scrolled into the viewport';
  return s.hit ? 'the element is displayed, enabled and on top at its centre' : 'the element is displayed and enabled, but a click at its centre does not land on it';
}

const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0]!;
const describeTarget = (t: ElementTarget): string => (t.css ? 'CSS selector' : t.role ? `role "${t.role}"${t.name ? ` named "${t.name}"` : ''}` : 'semantic locator');

export interface Readiness {
  ok: boolean;
  /** The target that resolved and is actionable: the real action must use this one. */
  target: ElementTarget;
  /** The element is usable for a person but never passed the browser's actionability wait: act on it directly. */
  force?: boolean;
  cause?: InteractionCause;
  error?: string;
  state?: ElementState;
  /** What was tried, in order. Diagnostic only. */
  notes: string[];
}

/**
 * Finds a way to act on the element before anything is clicked (nothing here changes the page: only scrolling and trial clicks).
 * A browser error on the way is a test-runner event, so it is never reported by itself:
 *  1. try the preferred (semantic) locator; when it resolves nothing or times out, try the element's own CSS selector;
 *  2. when both fail, look at the element: present, displayed, enabled, in reach, and what a click at its centre would hit;
 *  3. usable for a person => proceed (retry, then act without the actionability wait); otherwise say what is in the way.
 */
export async function prepareInteraction(ctx: FunctionalContext, target: ElementTarget, selector: string): Promise<Readiness> {
  const c = ctx.controller;
  const css: ElementTarget = { css: selector };
  const notes: string[] = [];
  let error = '';
  for (const t of target.css ? [target] : [target, css]) {
    const loc = c.locate(t);
    // A semantic lookup that matches nothing is the tester's lookup failing, not the page: no need to wait for it to time out.
    if (t !== css && !t.css && (await loc.count().catch(() => 0)) === 0) { notes.push(`${describeTarget(t)} matched no element`); continue; }
    try {
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
      await loc.click({ trial: true, timeout: 3000 });
      return { ok: true, target: t, notes };
    } catch (e) { error = c.redactor.redact(firstLine(e)); notes.push(`${describeTarget(t)}: ${error}`); }
  }

  const state = await probeElement(c, selector);
  notes.push(describeState(state));
  const cause = causeOf(state);
  if (cause) return { ok: false, target: css, cause, error, state, notes };

  // Displayed, enabled, in reach and on top: a person can click it. Give the browser one more try now that it is centred.
  try { await c.locate(css).click({ trial: true, timeout: 1500 }); return { ok: true, target: css, notes }; } catch { /* still not settled */ }
  notes.push('clicked at its centre without waiting for the browser actionability checks');
  return { ok: true, target: css, force: true, state, notes };
}

/** The result for an element that could not be acted on. Only a real obstruction is a defect; an undetermined cause is not reported. */
export function notInteractable(kind: FunctionalKind, element: FunctionalResult['element'], label: string, r: Readiness): FunctionalResult {
  const expected = `"${label}" can be clicked`;
  const what = r.state ? describeState(r.state) : 'its state could not be read';
  const details = { interaction: r.notes };
  if (r.cause === 'unavailable') {
    return { kind, check: 'not-interactable', status: 'skipped', severity: 'info', basis: null, element, expected: 'Displayed, enabled elements are tested', actual: `Not tested: ${what}`, details };
  }
  if (r.cause === 'obstructed') {
    return {
      kind, check: 'clickable', status: 'fail', severity: 'major', basis: 'deterministic', confidence: 'HIGH', element, expected,
      actual: `<${r.state!.cover!.description}> covers "${label}", so a click cannot reach it`,
      details: { ...details, reason: 'Another element in the page flow sits on top of the control at its centre, so it cannot be clicked' },
    };
  }
  if (r.cause === 'overlay') {
    return {
      kind, check: 'clickable', status: 'anomaly', severity: 'minor', basis: null, element, expected,
      actual: `<${r.state!.cover!.description}> covers "${label}" (floating/overlay UI, needs review)`,
      details: { ...details, reason: 'Floating UI such as a banner or dialog is on top of the control; that is often intended, so a person has to decide' },
    };
  }
  return {
    kind, check: 'clickable', status: 'inconclusive', severity: 'info', basis: null, element, expected,
    actual: `The test runner could not click "${label}" (${r.error || 'no browser error'}); ${what}`,
    details: { ...details, reason: 'The test runner failed to act and the cause could not be determined; that is not evidence of a website defect' },
  };
}

export interface ClickObservation { click: InteractionResult; observation: PostActionObservation }

/**
 * ACTION -> OBSERVE. When the browser reports an error for the click, what the page did decides what happens next:
 *  - the page changed => the click landed; the verifier judges that result;
 *  - nothing changed and the element is usable => the click never landed: one retry without the actionability wait;
 *  - otherwise the failure is returned with its cause, established from the element's own state.
 */
export async function clickAndObserve(
  ctx: FunctionalContext, ready: Readiness, selector: string, pre: PreActionSnapshot, intent: InferredIntent | undefined, options: ObservationOptions,
): Promise<ClickObservation> {
  const c = ctx.controller;
  const notes = [...ready.notes];
  const first = await c.click(ready.target, { force: ready.force });
  let observation = await observeAction(ctx, pre, intent, options);
  if (first.ok) return { click: { ok: true, notes }, observation };

  notes.push(`click: ${first.error}`);
  if (observedChange(observation)) return { click: { ok: false, error: first.error, cause: 'unknown', notes }, observation };

  const state = await probeElement(c, selector);
  notes.push(describeState(state));
  const cause = causeOf(state);
  if (cause) return { click: { ok: false, error: first.error, cause, notes }, observation };

  const retry = await c.click({ css: selector }, { force: true });
  observation = await observeAction(ctx, pre, intent, options);
  notes.push(retry.ok ? 'retried at its centre without the browser actionability wait: clicked' : `retry: ${retry.error}`);
  return { click: retry.ok ? { ok: true, notes } : { ok: false, error: retry.error ?? first.error, cause: 'unknown', notes }, observation };
}
