/**
 * Maps an element box measured in the TESTED browser (Playwright boundingBox: CSS pixels relative to that browser's
 * viewport) onto the screenshot as it is DISPLAYED in the dashboard, so the overlay lands exactly on the element.
 *
 * Coordinate spaces, in order:
 *   1. box            CSS px in the tested browser's viewport (scroll already accounted for: boundingBox is viewport-relative)
 *   2. screenshot     natural image px = CSS px x device pixel ratio (natural.width / viewport.width)
 *   3. painted image  the screenshot scaled by object-fit: contain inside the <img> element (letterboxed and centred)
 *   4. stage          the positioned container the overlay lives in; the <img> element sits at `offset` inside it
 *
 * Returns null when the box cannot belong to this screenshot: missing sizes, or a screenshot whose shape is not the
 * viewport's (a full-page capture), for which viewport coordinates would point at the wrong place.
 */
export interface Size { width: number; height: number }
export interface Box { x: number; y: number; width: number; height: number }
export interface OverlayInput {
  /** Element box in the tested browser's viewport, CSS px. */
  box: Box;
  /** The tested browser's viewport, CSS px. */
  viewport: Size;
  /** The screenshot's own pixel size (img.naturalWidth / naturalHeight). */
  natural: Size;
  /** The <img> element's rendered box (clientWidth / clientHeight): includes any letterbox bands. */
  displayed: Size;
  /** Where the <img> element's top-left corner is inside the overlay's container, px. */
  offset?: { left: number; top: number };
}
export interface OverlayRect { left: number; top: number; width: number; height: number; centerX: number; centerY: number; scale: number }

/** The rectangle the screenshot is actually painted in, inside an element using object-fit: contain (centred). */
export function paintedRect(natural: Size, displayed: Size): { left: number; top: number; width: number; height: number; scale: number } | null {
  if (!(natural.width > 0 && natural.height > 0 && displayed.width > 0 && displayed.height > 0)) return null;
  const scale = Math.min(displayed.width / natural.width, displayed.height / natural.height);
  const width = natural.width * scale; const height = natural.height * scale;
  return { left: (displayed.width - width) / 2, top: (displayed.height - height) / 2, width, height, scale };
}

export function mapBoxToDisplay(i: OverlayInput): OverlayRect | null {
  const { box, viewport, natural, displayed } = i;
  if (!(viewport.width > 0 && viewport.height > 0)) return null;
  const painted = paintedRect(natural, displayed);
  if (!painted) return null;
  // screenshot px per CSS px (the device pixel ratio). Both axes must agree, or this image is not a viewport screenshot.
  const dprX = natural.width / viewport.width; const dprY = natural.height / viewport.height;
  if (Math.abs(dprX - dprY) / dprX > 0.02) return null;
  const k = dprX * painted.scale; // displayed px per CSS px of the tested page
  const ox = (i.offset?.left ?? 0) + painted.left; const oy = (i.offset?.top ?? 0) + painted.top;
  // only the part of the element that is inside the viewport is on the screenshot
  const x0 = Math.max(0, box.x); const y0 = Math.max(0, box.y);
  const x1 = Math.min(viewport.width, box.x + box.width); const y1 = Math.min(viewport.height, box.y + box.height);
  if (x1 <= x0 || y1 <= y0) return null; // entirely outside the viewport: not on this screenshot
  const left = ox + x0 * k; const top = oy + y0 * k; const width = (x1 - x0) * k; const height = (y1 - y0) * k;
  return { left, top, width, height, centerX: left + width / 2, centerY: top + height / 2, scale: k };
}
