import type { BrowserController } from '../browser/index.js';
import type { FunctionalContext } from './types.js';

/**
 * Two things that keep normal QA away from sensitive operations:
 *
 *  1. CONTEXT of a state control (checkbox, switch, slider, select): what directly governs it (the title of the dialog it
 *     is in, its fieldset legend, its tab panel, its table column), the nearest heading above it, and its purpose. A checkbox labelled "Send / Share / Copy"
 *     means nothing by itself; inside "Edit Roles > Permissions" it changes what someone is allowed to do. ActionGuard
 *     refuses such a control BEFORE it is operated (see `sensitiveSetting` there).
 *
 *  2. UNEXPECTED DIALOGS: a warning, confirmation or security dialog that appears after an interaction is identified
 *     before anything is done with it. It is dismissed only through an unmistakable negative control (Cancel, No, Close,
 *     Dismiss, ×) or Escape. Nothing affirmative (Yes, OK, Confirm, Continue, Save, Allow, Delete...) is ever clicked. If it
 *     cannot be dismissed that way it is left unanswered and the caller reloads the page.
 *
 * Generic: structure, roles and wording only. Read-only apart from one marker attribute on the button that is clicked.
 */
export const CONTEXT_JS = `
  const __ctxText = (e) => (e ? (e.innerText || e.textContent || '') : '').replace(/\\s+/g, ' ').trim().slice(0, 90);
  /**
   * { context, heading, purpose } for a state control.
   *   context  what DIRECTLY governs the control: the title of the dialog it is in, its fieldset legend, its tab panel,
   *            the header of its table column. Decisive.
   *   heading  the nearest section / page heading above it. Only circumstantial: a page called "Roles" also holds
   *            controls that set no permission (selecting rows, paging, sorting).
   *   purpose  'row-selection' when the control only selects a row or all rows; '' when its purpose is not established.
   */
  const contextOf = (el) => {
    const parts = [];
    const add = (t) => { if (t && !parts.includes(t)) parts.push(t); };
    const dlg = el.closest('dialog, [role=dialog], [role=alertdialog], [aria-modal=true], .modal, .modal-dialog, .ui-dialog, .drawer, .offcanvas');
    if (dlg) {
      add(dlg.getAttribute('aria-label') || '');
      const by = dlg.getAttribute('aria-labelledby'); if (by) add(__ctxText(document.getElementById(by.split(/\\s+/)[0])));
      add(__ctxText(dlg.querySelector('h1, h2, h3, h4, h5, h6, [role=heading], .modal-title, .ui-dialog-title')));
    }
    const fs = el.closest('fieldset'); if (fs) add(__ctxText(fs.querySelector('legend')));
    const group = el.closest('[role=group], [role=radiogroup]'); if (group) add(group.getAttribute('aria-label') || '');
    const panel = el.closest('[role=tabpanel]');
    if (panel) { add(panel.getAttribute('aria-label') || ''); const id = panel.getAttribute('aria-labelledby'); if (id) add(__ctxText(document.getElementById(id.split(/\\s+/)[0]))); }
    // the header of the table column the control is in (a permission matrix names the permission there)
    const cell = el.closest('td, th, [role=cell], [role=gridcell], [role=columnheader]'); const row = cell && cell.closest('tr, [role=row]'); const table = row && row.closest('table, [role=grid], [role=table]');
    if (cell && row && table) {
      const index = Array.from(row.children).indexOf(cell);
      const head = table.querySelector('thead tr, tr');
      const th = head && head !== row ? head.children[index] : null;
      if (th && th.tagName === 'TH') add(__ctxText(th));
    }
    // the nearest heading that comes before the control, looking outwards (inside a dialog it is part of the dialog's own context)
    let heading = '';
    for (let a = el.parentElement, i = 0; a && a !== document.body && i < 10; a = a.parentElement, i++) {
      let last = null;
      for (const h of a.querySelectorAll('h1, h2, h3, h4, h5, h6, [role=heading], legend')) { if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) last = h; }
      if (last) { heading = __ctxText(last); break; }
    }
    if (dlg && heading) { add(heading); heading = ''; }
    // PURPOSE: a checkbox that only selects its row (or all rows). Strict: no label of its own, alone among the row's
    // controls, in the row's first cell or in the header; or it says so itself.
    let purpose = '';
    const own = (el.getAttribute('aria-label') || el.getAttribute('title') || (el.labels && el.labels.length ? __ctxText(el.labels[0]) : '') || '').trim();
    const isBox = (el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'checkbox') || el.getAttribute('role') === 'checkbox';
    if (isBox && /^(select|check|toggle|mark)( (all|row|rows|item|items|this|record|records|page))?( .{0,24})?$/i.test(own) && /\\b(all|row|rows|item|items|record|records|select)\\b/i.test(own)) purpose = 'row-selection';
    else if (isBox && !own && row) {
      const first = row.children[0];
      const inFirst = !!first && first.contains(el);
      const others = Array.from(row.querySelectorAll('input:not([type=hidden]), select, textarea, [role=checkbox], [role=switch], [role=slider]')).filter((x) => x !== el);
      const lone = __ctxText(first).length === 0;
      const header = !!el.closest('thead, th');
      const ownCell = cell && cell.contains(el) ? __ctxText(cell).length === 0 : false;
      if ((header && ownCell && others.length === 0) || (inFirst && lone && others.length === 0 && row.children.length >= 2)) purpose = 'row-selection';
    }
    return { context: parts.join(' | ').slice(0, 240), heading: heading.slice(0, 120), purpose };
  };
`;

export interface ControlContext { context: string; heading: string; purpose: string }

/** The context of one control, by selector ('' when it cannot be found). */
export async function controlContext(c: BrowserController, selector: string): Promise<ControlContext> {
  const none: ControlContext = { context: '', heading: '', purpose: '' };
  return (await c.page.evaluate(`((sel) => { ${CONTEXT_JS} let el = null; try { el = document.querySelector(sel); } catch (e) { el = null; } return el ? contextOf(el) : null; })(${JSON.stringify(selector)})`).catch(() => null) as ControlContext | null) ?? none;
}

export interface DialogInfo {
  /** Identity of the dialog as shown (its text), to tell a new one from one that was already open. */
  key: string;
  text: string;
  /** confirmation: offers an affirmative and a negative answer. acknowledgement: only an affirmative one. notice: only a way to close. */
  type: 'confirmation' | 'acknowledgement' | 'notice';
  /** True for a warning / confirmation / security style dialog (as opposed to an editor or form shown in a dialog). */
  sensitive: boolean;
  buttons: string[];
  /** Label of the unmistakably negative control, when there is one. */
  negative: string | null;
}

const DIALOG_SCRIPT = `((mark) => {
  const shown = (el) => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || '1') > 0.05; };
  const text = (e) => (e ? (e.innerText || e.textContent || '') : '').replace(/\\s+/g, ' ').trim();
  document.querySelectorAll('[' + mark + ']').forEach((e) => e.removeAttribute(mark));
  const all = Array.from(document.querySelectorAll('dialog[open], [role=alertdialog], [role=dialog], [aria-modal=true], .modal.show, .modal.in, .swal2-popup, .bootbox, .ui-dialog')).filter(shown);
  // the innermost / last one is the one on top
  const top = all.filter((d) => !all.some((o) => o !== d && d.contains(o))).pop();
  if (!top) return null;
  const label = (e) => (e.getAttribute('aria-label') || text(e) || e.getAttribute('title') || e.getAttribute('value') || '').slice(0, 40);
  const btns = Array.from(top.querySelectorAll('button, [role=button], a, input[type=button], input[type=submit]')).filter(shown).filter((b) => label(b));
  const fields = Array.from(top.querySelectorAll('input:not([type=hidden]):not([type=button]):not([type=submit]), select, textarea, [role=slider], [role=switch], [role=checkbox]')).filter(shown).length;
  const AFFIRM = /^(yes|ok|okay|confirm|continue|proceed|save|apply|allow|grant|accept|agree|delete|remove|submit|update|publish|approve|i understand|got it|done|sure)\\b/i;
  const NEGATE = /^(no|cancel|close|dismiss|not now|go back|back|keep|stay|abort|×|✕|x)$|^(no,|cancel |don.t )/i;
  const affirm = btns.filter((b) => AFFIRM.test(label(b)));
  const negate = btns.filter((b) => NEGATE.test(label(b)) || /close|dismiss/i.test(b.getAttribute('aria-label') || ''));
  const body = text(top).slice(0, 300);
  const WARN = /\\b(warning|security|are you sure|confirm|cannot be undone|can.t be undone|permission|unauthori[sz]ed|not allowed|not permitted|access denied|forbidden|unsaved|discard|will be (lost|removed|deleted|changed|overwritten)|do you (want|wish)|suspicious|session (has )?expired|irreversible)\\b/i;
  const sensitive = top.getAttribute('role') === 'alertdialog' || (fields === 0 && btns.length <= 4 && WARN.test(body));
  let negative = null;
  if (negate.length > 0) { negate[0].setAttribute(mark, '1'); negative = label(negate[0]); }
  return { key: body.slice(0, 120), text: body, type: affirm.length > 0 && negate.length > 0 ? 'confirmation' : affirm.length > 0 ? 'acknowledgement' : 'notice', sensitive, buttons: btns.map(label), negative };
})`;

const MARK = 'data-qa-dialog-no';

/** The dialog currently on top, described; null when none is shown. Marks its negative control so it can be clicked. */
export async function inspectDialog(c: BrowserController): Promise<DialogInfo | null> {
  return (await c.page.evaluate(`${DIALOG_SCRIPT}(${JSON.stringify(MARK)})`).catch(() => null)) as DialogInfo | null;
}

export interface DialogOutcome { dialog: DialogInfo; dismissed: boolean; how: string }

/**
 * Call after an interaction, with the key of the dialog that was open before it (or null). If a sensitive dialog has
 * appeared that was not there before, it is identified and then dismissed ONLY through its negative control or Escape.
 * Returns what was found and done; null when nothing unexpected is on screen.
 */
export async function resolveUnexpectedDialog(ctx: FunctionalContext, before: string | null): Promise<DialogOutcome | null> {
  const { controller: c, guard } = ctx;
  const d = await inspectDialog(c);
  if (!d || !d.sensitive || d.key === before) return null;
  let how = 'left unanswered';
  if (d.negative && guard.check({ kind: 'click', name: d.negative, text: d.negative }).allowed) {
    const r = await c.click({ css: `[${MARK}="1"]` });
    how = r.ok ? `dismissed with its "${d.negative}" control` : 'left unanswered';
  } else {
    await c.press('Escape').catch(() => undefined);
    how = 'dismissed with Escape';
  }
  await c.settle(200);
  const after = await inspectDialog(c);
  const dismissed = !after || after.key !== d.key;
  ctx.onAction?.({ type: 'dialog', target: d.text.slice(0, 80), ok: dismissed, detail: `unexpected ${d.type} dialog; ${dismissed ? how : 'it could not be dismissed safely and was left unanswered'}; buttons: ${d.buttons.join(', ')}` });
  return { dialog: d, dismissed, how: dismissed ? how : 'it could not be dismissed safely and was left unanswered' };
}
