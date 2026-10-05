/**
 * What is really drawn where two element boxes intersect. A bounding-box intersection says nothing about whether any
 * content is obscured: boxes include padding and line spacing, and an element can be clipped or hidden by an ancestor.
 */
export interface OverlapProbe {
  /** Area (px²) of each element's actual content: text line boxes for text, the whole box for controls and media. */
  contentA: number;
  contentB: number;
  /** Area where the content of both is rendered at the same place. */
  covered: number;
  /** Part of `covered` confirmed by hit-testing (both elements found under the point). */
  verified: number;
  /** Effective opacity through all ancestors (0 = not rendered at all). */
  opacityA: number;
  opacityB: number;
}

/** Runs in the page. Scrolls the first element into view to hit-test, then restores the scroll position. */
export const OVERLAP_PROBE_SCRIPT = `((sa, sb) => {
  let a, b;
  try { a = document.querySelector(sa); b = document.querySelector(sb); } catch { return null; }
  if (!a || !b) return null;
  const sx = scrollX, sy = scrollY;
  try {
    a.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const CONTROL = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch]';
    const opacity = (el) => {
      let o = 1;
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
        o *= parseFloat(cs.opacity || '1');
      }
      return o;
    };
    // The part of a rect that survives every clipping ancestor (overflow other than visible).
    const clip = (el, r) => {
      let x1 = r.left, y1 = r.top, x2 = r.right, y2 = r.bottom;
      for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const c = n.getBoundingClientRect();
        if (cs.overflowX !== 'visible') { x1 = Math.max(x1, c.left); x2 = Math.min(x2, c.right); }
        if (cs.overflowY !== 'visible') { y1 = Math.max(y1, c.top); y2 = Math.min(y2, c.bottom); }
      }
      return x2 - x1 > 0.5 && y2 - y1 > 0.5 ? { left: x1, top: y1, right: x2, bottom: y2 } : null;
    };
    const content = (el) => {
      const rects = [];
      if (el.matches(CONTROL) || /^(IMG|VIDEO|CANVAS|SVG|IFRAME)$/i.test(el.tagName)) rects.push(el.getBoundingClientRect());
      else for (const n of el.childNodes) {
        if (n.nodeType !== 3 || !n.textContent.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(n);
        for (const c of range.getClientRects()) rects.push(c);
      }
      return rects.filter((r) => r.width > 0 && r.height > 0).map((r) => clip(el, r)).filter(Boolean);
    };
    const hittable = (el) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) if (getComputedStyle(n).pointerEvents === 'none') return false; return true; };
    // true/false: the element is / is not rendered at the point. null: cannot tell (outside the viewport or not hit-testable).
    const painted = (el, x, y) => {
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || !hittable(el)) return null;
      return document.elementsFromPoint(x, y).some((n) => n === el || el.contains(n));
    };
    const area = (rs) => rs.reduce((s, r) => s + (r.right - r.left) * (r.bottom - r.top), 0);
    const ra = content(a), rb = content(b);
    let covered = 0, verified = 0;
    for (const p of ra) for (const q of rb) {
      const x1 = Math.max(p.left, q.left), y1 = Math.max(p.top, q.top), x2 = Math.min(p.right, q.right), y2 = Math.min(p.bottom, q.bottom);
      if (x2 - x1 <= 0 || y2 - y1 <= 0) continue;
      const pa = painted(a, (x1 + x2) / 2, (y1 + y2) / 2), pb = painted(b, (x1 + x2) / 2, (y1 + y2) / 2);
      if (pa === false || pb === false) continue; // one of them is not actually rendered there
      covered += (x2 - x1) * (y2 - y1);
      if (pa === true && pb === true) verified += (x2 - x1) * (y2 - y1);
    }
    return { contentA: area(ra), contentB: area(rb), covered, verified, opacityA: opacity(a), opacityB: opacity(b) };
  } finally { window.scrollTo(sx, sy); }
})`;
