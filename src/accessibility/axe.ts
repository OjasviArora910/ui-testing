import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { BrowserController } from '../browser/index.js';
import type { AxeFinding } from './types.js';

const require = createRequire(import.meta.url);
let axeSource: string | undefined;
function getAxeSource(): string {
  axeSource ??= fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  return axeSource;
}

const RUN_SCRIPT = `(async () => {
  const r = await window.axe.run(document, { resultTypes: ['violations', 'incomplete'] });
  const map = (kind) => (list) => list.map((v) => ({
    axeRuleId: v.id, kind, impact: v.impact || null, help: v.help, description: v.description, helpUrl: v.helpUrl, tags: v.tags,
    nodes: v.nodes.slice(0, 15).map((n) => ({ selector: (n.target || []).join(' '), html: (n.html || '').slice(0, 200), summary: (n.failureSummary || '').replace(/\\s+/g, ' ').slice(0, 300) })),
  }));
  const out = [...map('violation')(r.violations), ...map('incomplete')(r.incomplete)];

  // Custom deterministic checks axe 4.x does not enable by default.
  const sel = (el) => el.id ? '#' + CSS.escape(el.id) : el.tagName.toLowerCase() + (el.getAttribute('name') ? '[name="' + el.getAttribute('name') + '"]' : '');
  const ids = {};
  for (const el of document.querySelectorAll('[id]')) { if (el.id) (ids[el.id] = ids[el.id] || []).push(el); }
  const dups = Object.entries(ids).filter(([, els]) => els.length > 1);
  if (dups.length) out.push({ axeRuleId: 'duplicate-id', kind: 'violation', impact: 'minor', help: 'id attribute values must be unique', description: 'Duplicate id values break label, ARIA and anchor references',
    helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/parsing.html', tags: ['custom', 'wcag2a'],
    nodes: dups.slice(0, 15).map(([id, els]) => ({ selector: '#' + id, html: els[0].outerHTML.slice(0, 200), summary: 'id "' + id + '" is used by ' + els.length + ' elements' })) });
  const unlabeled = Array.from(document.querySelectorAll('input, select, textarea')).filter((e) => {
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes((e.getAttribute('type') || '').toLowerCase())) return false;
    const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden' || r.width === 0) return false;
    const named = (e.labels && e.labels.length) || e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.getAttribute('title');
    return !named && !!e.getAttribute('placeholder');
  });
  if (unlabeled.length) out.push({ axeRuleId: 'form-field-label', kind: 'violation', impact: 'moderate', help: 'Form fields need a persistent visible label; a placeholder disappears on input and is not a label',
    description: 'Field is labelled only by its placeholder', helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/labels-or-instructions.html', tags: ['custom', 'wcag2a', 'wcag332'],
    nodes: unlabeled.slice(0, 15).map((e) => ({ selector: sel(e), html: e.outerHTML.slice(0, 200), summary: 'No <label>, aria-label or title; only placeholder "' + e.getAttribute('placeholder') + '"' })) });
  return out;
})()`;

/**
 * Runs axe-core in the page. axe finds common, machine-detectable accessibility problems (names, labels, ARIA,
 * contrast, duplicate ids, heading order...). It is NOT a WCAG conformance audit: many criteria need manual review.
 */
export async function runAxe(controller: BrowserController): Promise<AxeFinding[]> {
  await controller.page.evaluate(getAxeSource());
  const raw = await controller.page.evaluate(RUN_SCRIPT) as AxeFinding[];
  return controller.redactor.redactDeep(raw);
}
