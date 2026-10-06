/**
 * In-page helpers (plain JS, shared by the collection scripts) that decide whether a NON-SEMANTIC element (a span, div,
 * icon or table cell rather than a button or link) is a safe ENTRY control: something that opens, shows or edits content.
 *
 * Two independent kinds of evidence are both required:
 *  1. it is really clickable: its own handler, a framework click attribute, a script handler bound to it directly or
 *     delegated from an ancestor (read from jQuery's own registry when the page uses jQuery), or the pointer cursor
 *     starting at this element;
 *  2. it says what it does, safely:
 *       - "labelled": its own label, tooltip, icon or attributes carry an open/view/edit/details/more word, or
 *       - "row": it is the primary label of a repeated table row (the name cell that opens the record).
 * A destructive or mutating word anywhere in that label rejects it. A clickable element with no such indication is
 * AMBIGUOUS and is not selected: the engine does not guess. ActionGuard still checks every selected control before a click.
 * Read-only: nothing on the page is changed.
 */
export const ENTRY_HELPERS_JS = `
  const E_INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[contenteditable=""],[contenteditable="true"],'
    + '[tabindex]:not([tabindex^="-"]),[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=option]';
  const E_SAFE = /(^|[^a-z])(open|view|show|details?|inspect|preview|edit|pencil|settings?|configure|gear|cog|more|ellipsis|expand)([^a-z]|$)/i;
  const E_DANGER = /(^|[^a-z])(save|create|delete|remove|update|assign|publish|lock\\s*out|lockout|confirm|yes|destroy|purge|erase|wipe|trash|reset|submit|send|logout|sign\\s*out)([^a-z]|$)/i;
  const E_CLICK_ATTR = /^(onclick|ng-click|data-ng-click|v-on:click|@click|\\(click\\)|data-action|data-toggle|data-target|data-bs-toggle|data-bs-target|data-href|data-url|data-click|data-bind)$/i;
  const E_TIPS = ['data-original-title', 'data-bs-original-title', 'data-tooltip', 'data-tip', 'data-title'];
  const eText = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
  const eClass = (el) => (typeof el.className === 'string' ? el.className : (el.getAttribute && el.getAttribute('class')) || '');

  // script click handlers, read once from jQuery's registry when the page uses jQuery (direct and delegated)
  const E_JQ = (window.jQuery && typeof window.jQuery._data === 'function') ? window.jQuery : null;
  const eDirect = new Set(); const eDelegated = [];
  if (E_JQ) {
    const roots = [document, document.documentElement, document.body].concat(Array.from(document.querySelectorAll('body *')));
    for (const root of roots) {
      let ev = null; try { ev = E_JQ._data(root, 'events'); } catch (e) { ev = null; }
      if (!ev) continue;
      for (const name of ['click', 'mousedown', 'mouseup', 'tap', 'touchend']) for (const h of (ev[name] || [])) {
        if (h && h.selector) { if (eDelegated.length < 400) eDelegated.push({ root, selector: String(h.selector) }); }
        else if (root.nodeType === 1 && root !== document.body && root !== document.documentElement) eDirect.add(root);
      }
    }
  }

  /** Why this element is believed to be clickable. Empty: no evidence. */
  const eClickEvidence = (el, cs) => {
    const ev = [];
    if (typeof el.onclick === 'function') ev.push('own click handler');
    for (const a of Array.from(el.attributes || [])) {
      const n = a.name.toLowerCase();
      if ((E_CLICK_ATTR.test(n) && (n !== 'data-bind' || /click/i.test(a.value))) || (/click/i.test(n) && n !== 'onclick')) ev.push('attribute ' + n);
    }
    if (eDirect.has(el)) ev.push('script click handler');
    for (const d of eDelegated) {
      let m = false; try { m = (d.root === document || d.root.contains(el)) && el.matches(d.selector); } catch (e) { m = false; }
      if (m) { ev.push('delegated click handler (' + d.selector.slice(0, 40) + ')'); break; }
    }
    const pe = el.parentElement;
    if (cs.cursor === 'pointer' && (!pe || getComputedStyle(pe).cursor !== 'pointer')) ev.push('pointer cursor starts here');
    return ev;
  };

  /** Everything that names the control: its attributes, tooltip, icon child and (short) own text. */
  const eLabelText = (el, withoutText) => {
    const own = [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-testid'), el.getAttribute('data-test'), el.getAttribute('data-qa'),
      el.getAttribute('name'), el.id, eClass(el)].concat(E_TIPS.map((a) => el.getAttribute(a)))
      .concat(Array.from(el.attributes || []).filter((a) => /click|action|toggle/i.test(a.name)).map((a) => a.value));
    const icons = Array.from(el.children).slice(0, 3).map((k) => [eClass(k), k.getAttribute('title'), k.getAttribute('aria-label'), k.tagName === 'IMG' ? k.getAttribute('alt') : ''].filter(Boolean).join(' '));
    const t = eText(el);
    return own.concat(icons).concat(!withoutText && t.length <= 40 ? [t] : []).filter(Boolean).join(' ').replace(/[_-]+/g, ' ');
  };

  /** The repeated row (table row or ARIA row with at least one sibling row) this element sits in, outside the header. */
  const eRowOf = (el) => {
    const r = el.closest('tr, [role=row]');
    if (!r || r === el || !r.parentElement || el.closest('thead, th, [role=columnheader]')) return null;
    const rows = Array.from(r.parentElement.children).filter((x) => x.tagName === r.tagName && !x.querySelector('th'));
    return rows.length >= 2 || (rows.length === 1 && r.parentElement.querySelector('th')) ? r : null;
  };

  /**
   * { kind, name, evidence } when the element is a safe entry control; otherwise { reason } saying what was missing.
   * Native and ARIA controls are not judged here: they are discovered as what they are.
   */
  const eEntryOf = (el, cs) => {
    if (el.matches(E_INTERACTIVE)) return { reason: 'a native or ARIA control: discovered as such' };
    if (cs.pointerEvents === 'none' || el.getAttribute('aria-disabled') === 'true' || el.disabled === true) return { reason: 'not operable (disabled or pointer-events none)' };
    const inherited = cs.cursor === 'pointer';
    const label = eLabelText(el);
    const declared = Array.from(el.attributes || []).filter((a) => /^(data-action|data-toggle|data-bs-toggle|data-click|ng-click|data-ng-click|v-on:click|@click)$/i.test(a.name)).map((a) => a.value).join(' ').replace(/[_-]+/g, ' ');
    // what the element SAYS IT DOES (its declared action, class, title, tooltip, icon) versus the text it merely displays
    const said = declared ? eLabelText(el, true) : label;
    const danger = E_DANGER.test(said);
    const safe = E_SAFE.exec(said);
    if (!safe && !danger && !eRowOf(el)) return { reason: inherited ? 'clickable-looking, but nothing indicates that it opens, shows or edits content (ambiguous: not guessed)' : 'no evidence that it is a control' };
    const evidence = eClickEvidence(el, cs);
    if (safe && !danger && (evidence.length > 0 || inherited)) {
      if (el.querySelector(E_INTERACTIVE)) return { reason: 'contains other controls: a container, not a control' };
      const r = el.getBoundingClientRect();
      if (r.width > 420 || r.height > 140) return { reason: 'too large to be a single control' };
      return { kind: 'labelled', name: safe[2].replace(/^(detail|setting)s$/i, '$1'), action: safe[2].toLowerCase(), evidence: evidence.length ? evidence : ['pointer cursor'] };
    }
    if (danger) return { reason: 'its label names a destructive or mutating action: never selected' };
    if (evidence.length === 0) return { reason: inherited ? 'pointer cursor only inherited from a parent, and no open/view/edit indication' : 'no evidence that it is clickable' };
    const row = eRowOf(el);
    if (row) {
      const t = eText(el);
      if (t && t.length <= 80 && !el.querySelector(E_INTERACTIVE) && !E_DANGER.test(t)) {
        const first = Array.from(row.querySelectorAll('td, [role=cell], [role=gridcell]')).find((c) => eText(c));
        if (first && (first === el || first.contains(el))) return { kind: 'row', name: t, action: 'open', evidence: evidence.concat(['primary label of a repeated row']) };
        return { reason: 'clickable text in a row, but not the row\\'s primary label and no open/view/edit indication' };
      }
    }
    return { reason: 'clickable, but nothing indicates that it opens, shows or edits content (ambiguous: not guessed)' };
  };
`;

/**
 * For the first data rows of each visible table / ARIA grid: every element in the row that shows any sign of being
 * clickable, with the evidence found and the decision taken. Kept with the page model, so "why was this not tested?"
 * can be answered from the record instead of guessed.
 */
export const COLLECT_ROW_CANDIDATES_SCRIPT = `() => {
  ${ENTRY_HELPERS_JS}
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) !== 0; };
  const out = [];
  const containers = Array.from(document.querySelectorAll('table, [role=grid], [role=table], [role=treegrid]')).filter(visible).slice(0, 6);
  for (const table of containers) {
    const rows = Array.from(table.querySelectorAll('tr, [role=row]')).filter((r) => !r.querySelector('th') && !r.closest('thead') && visible(r)).slice(0, 2);
    for (const row of rows) {
      const nodes = [row].concat(Array.from(row.querySelectorAll('*'))).slice(0, 120);
      for (const el of nodes) {
        const cs = getComputedStyle(el);
        const native = el.matches(E_INTERACTIVE);
        const ev = eClickEvidence(el, cs);
        const hidden = !visible(el);
        if (!native && ev.length === 0 && !(hidden && /icon|action|btn|edit|view|more/i.test(eClass(el)))) continue;
        const d = eEntryOf(el, cs);
        out.push({
          row: eText(row).slice(0, 60), tag: el.tagName.toLowerCase(), className: eClass(el).slice(0, 80), text: eText(el).slice(0, 40),
          visible: !hidden, evidence: ev, decision: native ? 'native control' : d.kind ? 'entry control (' + d.kind + ': ' + d.name + ')' : 'not selected: ' + d.reason + (hidden ? '; not visible (it may appear only on hover)' : ''),
        });
        if (out.length >= 60) return out;
      }
    }
  }
  return out;
}`;
