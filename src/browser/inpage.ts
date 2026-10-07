/**
 * Scripts executed inside the page. Kept as plain-JS strings (not functions) so bundler helpers
 * such as esbuild's __name never leak into the browser context.
 */
import { ENTRY_HELPERS_JS } from './entryEvidence.js';

export const COLLECT_ELEMENTS_SCRIPT = `(mode) => {
  const IMPLICIT = { button:'button', select:'combobox', textarea:'textbox', img:'img', table:'table', nav:'navigation',
    main:'main', header:'banner', footer:'contentinfo', dialog:'dialog', ul:'list', ol:'list', li:'listitem', form:'form',
    h1:'heading', h2:'heading', h3:'heading', h4:'heading', h5:'heading', h6:'heading', summary:'button', details:'group',
    aside:'complementary', section:'region', article:'article', progress:'progressbar', output:'status' };
  const INPUT_ROLES = { button:'button', submit:'button', reset:'button', checkbox:'checkbox', radio:'radio', range:'slider',
    search:'searchbox', number:'spinbutton', email:'textbox', tel:'textbox', url:'textbox', text:'textbox', password:'textbox' };
  const STYLE_KEYS = ['display','position','visibility','opacity','overflow','overflowX','overflowY','zIndex','color',
    'backgroundColor','fontSize','fontWeight','textOverflow','whiteSpace','pointerEvents','cursor','webkitLineClamp','clip','clipPath','width','height','flexWrap','objectFit'];
  const INTERACTIVE_SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[contenteditable=""],[contenteditable="true"],'
    + '[tabindex]:not([tabindex^="-"]),[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=option]';
  ${ENTRY_HELPERS_JS}
  const roleOf = (el) => {
    const explicit = el.getAttribute('role'); if (explicit) return explicit.split(' ')[0];
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'input') return INPUT_ROLES[(el.getAttribute('type') || 'text').toLowerCase()] || 'textbox';
    return IMPLICIT[tag] || null;
  };
  const textOf = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
  const entryCache = new Map();
  const entryOf = (el, cs) => { if (!entryCache.has(el)) entryCache.set(el, eEntryOf(el, cs || getComputedStyle(el))); return entryCache.get(el); };
  const safeEntryName = (el) => { const e = entryOf(el); return e.kind ? e.name : ''; };
  const isSafeEntryAffordance = (el, cs) => !!entryOf(el, cs).kind;
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label'); if (aria) return aria.trim();
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\\s+/).map(id => document.getElementById(id)).filter(Boolean).map(e => textOf(e)).join(' ').trim(); if (t) return t; }
    if (el.labels && el.labels.length) { const t = Array.from(el.labels).map(l => textOf(l)).join(' ').trim(); if (t) return t; }
    if (el.tagName === 'IMG') { const alt = el.getAttribute('alt'); if (alt !== null) return alt.trim(); }
    if (el.tagName === 'INPUT' && ['button','submit','reset'].includes((el.getAttribute('type')||'').toLowerCase())) return (el.value || '').trim();
    const txt = textOf(el); if (txt) return txt;
    const safe = safeEntryName(el); if (safe) return safe;
    return (el.getAttribute('title') || el.getAttribute('placeholder') || '').trim();
  };
  const esc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
  const selectorOf = (el) => {
    const tid = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-qa');
    if (tid) return '[data-testid="' + tid.replace(/"/g, '\\\\"') + '"]';
    if (el.id && document.querySelectorAll('#' + esc(el.id)).length === 1) return '#' + esc(el.id);
    const parts = []; let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      const tag = cur.tagName.toLowerCase(); const parent = cur.parentElement;
      if (cur === document.body) { parts.unshift('body'); break; }
      const same = parent ? Array.from(parent.children).filter(c => c.tagName === cur.tagName) : [];
      parts.unshift(same.length > 1 ? tag + ':nth-of-type(' + (same.indexOf(cur) + 1) + ')' : tag);
      cur = parent;
    }
    return parts.join(' > ');
  };
  const visibleOf = (el, rect, cs) => rect.width > 0 && rect.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) !== 0;
  const nodes = document.querySelectorAll('body *');
  const ids = new Map(); let nextId = 0;
  for (const el of nodes) ids.set(el, nextId++);
  const out = [];
  for (const el of nodes) {
    const tag = el.tagName.toLowerCase();
    if (['script','style','noscript','template','head','meta','link','title'].includes(tag)) continue;
    const rect = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    if (mode === 'interactive' && !el.matches(INTERACTIVE_SEL) && !isSafeEntryAffordance(el, cs)) continue;
    const visible = visibleOf(el, rect, cs);
    if (mode === 'visible' && !visible) continue;
    const styles = {}; for (const k of STYLE_KEYS) styles[k] = cs[k];
    const ownText = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').replace(/\\s+/g, ' ').trim().slice(0, 200);
    const pe = el.parentElement;
    out.push({
      id: ids.get(el), parentId: pe && ids.has(pe) ? ids.get(pe) : null, ownText,
      className: typeof el.className === 'string' ? el.className.slice(0, 120) : '',
      aria: {
        modal: el.getAttribute('aria-modal') === 'true', hidden: !!el.closest('[aria-hidden="true"]'),
        haspopup: el.getAttribute('aria-haspopup') && el.getAttribute('aria-haspopup') !== 'false' ? (el.getAttribute('aria-haspopup') === 'true' ? true : el.getAttribute('aria-haspopup')) : false,
        expanded: el.getAttribute('aria-expanded'), disabled: el.getAttribute('aria-disabled') === 'true',
        invalid: el.getAttribute('aria-invalid') === 'true', live: el.getAttribute('aria-live'),
      },
      tag, type: el.getAttribute('type') || undefined, role: roleOf(el), name: nameOf(el), text: textOf(el),
      selector: selectorOf(el), visible,
      enabled: !(el.disabled === true || el.getAttribute('aria-disabled') === 'true'),
      box: { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height },
      styles,
      scroll: { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
      href: tag === 'a' ? el.getAttribute('href') : undefined,
      entry: (mode === 'interactive' && !el.matches(INTERACTIVE_SEL) && entryOf(el, cs).kind) ? { kind: entryOf(el, cs).kind, action: entryOf(el, cs).action, evidence: entryOf(el, cs).evidence } : undefined,
      required: el.required === true || undefined,
    });
    if (out.length >= 5000) break;
  }
  return out;
}`;

/** Structural facts that are not derivable from the per-element collection: forms and their fields, images, tables, headings, dialogs. */
export const COLLECT_STRUCTURE_SCRIPT = `() => {
  const esc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
  const sel =(el) => {
    const tid = el.getAttribute('data-testid'); if (tid) return '[data-testid="' + tid.replace(/"/g, '\\\\"') + '"]';
    if (el.id && document.querySelectorAll('#' + esc(el.id)).length === 1) return '#' + esc(el.id);
    const parts = []; let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      const tag = cur.tagName.toLowerCase(); const parent = cur.parentElement;
      if (cur === document.body) { parts.unshift('body'); break; }
      const same = parent ? Array.from(parent.children).filter(c => c.tagName === cur.tagName) : [];
      parts.unshift(same.length > 1 ? tag + ':nth-of-type(' + (same.indexOf(cur) + 1) + ')' : tag);
      cur = parent;
    }
    return parts.join(' > ');
  };
  const txt = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
  const labelOf = (f) => {
    if (f.getAttribute('aria-label')) return f.getAttribute('aria-label').trim();
    const lb = f.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\\s+/).map(i => document.getElementById(i)).filter(Boolean).map(txt).join(' ').trim(); if (t) return t; }
    if (f.labels && f.labels.length) return Array.from(f.labels).map(txt).join(' ').trim();
    return '';
  };
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const forms = Array.from(document.forms).map((f) => ({
    selector: sel(f), name: f.getAttribute('aria-label') || f.getAttribute('name') || f.id || '', action: f.getAttribute('action') || '',
    method: (f.getAttribute('method') || 'get').toUpperCase(), noValidate: f.noValidate, visible: visible(f),
    fields: Array.from(f.elements).filter(e => ['INPUT','SELECT','TEXTAREA'].includes(e.tagName) && e.type !== 'hidden' && e.type !== 'submit' && e.type !== 'button' && e.type !== 'reset').map((e) => ({
      selector: sel(e), tag: e.tagName.toLowerCase(), type: (e.getAttribute('type') || (e.tagName === 'SELECT' ? 'select' : e.tagName === 'TEXTAREA' ? 'textarea' : 'text')).toLowerCase(),
      name: e.getAttribute('name') || '', label: labelOf(e), placeholder: e.getAttribute('placeholder') || '',
      required: e.required === true || e.getAttribute('aria-required') === 'true', pattern: e.getAttribute('pattern') || undefined,
      min: e.getAttribute('min') || undefined, max: e.getAttribute('max') || undefined,
      minLength: e.minLength > 0 ? e.minLength : undefined, maxLength: e.maxLength > 0 ? e.maxLength : undefined,
      options: e.tagName === 'SELECT' ? Array.from(e.options).map(o => o.value) : undefined, visible: visible(e), disabled: e.disabled === true,
    })),
    submit: (() => { const b = f.querySelector('button[type=submit], input[type=submit], button:not([type])'); return b ? { selector: sel(b), text: (b.value || txt(b)) } : null; })(),
  }));
  const images = Array.from(document.images).map((i) => ({
    selector: sel(i), src: i.currentSrc || i.getAttribute('src') || '', alt: i.getAttribute('alt'), complete: i.complete,
    naturalWidth: i.naturalWidth, naturalHeight: i.naturalHeight, visible: visible(i),
  }));
  const tables = Array.from(document.querySelectorAll('table, [role=table], [role=grid]')).map((t) => ({
    selector: sel(t), rows: t.querySelectorAll('tr, [role=row]').length, headers: t.querySelectorAll('th, [role=columnheader]').length,
    caption: (t.querySelector('caption') ? txt(t.querySelector('caption')) : '') || t.getAttribute('aria-label') || '', visible: visible(t),
  }));
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]')).map((h) => ({
    selector: sel(h), level: parseInt(h.tagName.slice(1)) || parseInt(h.getAttribute('aria-level') || '2'), text: txt(h), visible: visible(h),
  }));
  const dialogs = Array.from(document.querySelectorAll('dialog, [role=dialog], [role=alertdialog]')).map((d) => ({
    selector: sel(d), name: d.getAttribute('aria-label') || '', open: d.tagName === 'DIALOG' ? d.open : visible(d), modal: d.getAttribute('aria-modal') === 'true',
  }));
  const menus = Array.from(document.querySelectorAll('[role=menu], [role=menubar], nav')).map((m) => ({ selector: sel(m), role: m.getAttribute('role') || 'navigation', items: m.querySelectorAll('a, [role=menuitem]').length, visible: visible(m) }));
  const tabs = Array.from(document.querySelectorAll('[role=tablist]')).map((t) => ({ selector: sel(t), tabs: Array.from(t.querySelectorAll('[role=tab]')).map((x) => ({ selector: sel(x), name: txt(x), selected: x.getAttribute('aria-selected') === 'true' })) }));
  const accordions = Array.from(document.querySelectorAll('details, [aria-expanded][aria-controls]')).map((a) => ({
    selector: sel(a), name: txt(a.tagName === 'DETAILS' ? (a.querySelector('summary') || a) : a).slice(0, 80), expanded: a.tagName === 'DETAILS' ? a.open : a.getAttribute('aria-expanded') === 'true',
  }));
  const links = Array.from(document.querySelectorAll('a[href]')).map((a) => ({ selector: sel(a), href: a.getAttribute('href') || '', resolved: a.href, text: txt(a) || a.getAttribute('aria-label') || '', target: a.getAttribute('target') || '', visible: visible(a), inNav: !!a.closest('nav, header, footer, [role=navigation]') }));
  return { title: document.title, lang: document.documentElement.getAttribute('lang') || '', forms, images, tables, headings, dialogs, menus, tabs, accordions, links };
}`;
