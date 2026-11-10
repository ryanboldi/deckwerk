/**
 * Curly-brace geometry.
 *
 * A brace is laid out like a line: its endpoints are the left- and
 * right-centre of the element box, rotated about the box centre, so moving,
 * rotating and dragging an endpoint all work exactly as they do for a line.
 * The one extra parameter is `braceDepth`, the signed distance from the
 * chord's midpoint to the brace's point along the element's own +y. Every
 * curl — the two at the ends and the two that meet at the point — has the
 * same radius, half the depth, so the point always stands at twice the
 * radius off the chord. When the brace is too short for four full curls the
 * curls flatten horizontally rather than letting the point leave the handle.
 */

type XY = { x: number; y: number };

type BraceBox = { x: number; y: number; w: number; h: number; rot: number; braceDepth?: number };

/** The depth a brace is drawn with when it does not carry one. */
export const DEFAULT_BRACE_DEPTH = 40;

export function braceDepthOf(el: { braceDepth?: number }): number {
  return el.braceDepth ?? DEFAULT_BRACE_DEPTH;
}

/** The curls' radii in element pixels: `rx` along the chord, `ry` across it. */
function braceRadii(w: number, depth: number): { rx: number; ry: number } {
  const ry = Math.abs(depth) / 2;
  return { rx: Math.min(ry, Math.max(0, w) / 4), ry };
}

/**
 * The brace as SVG path data in element pixels, from (0, h/2) to (w, h/2).
 * A depth of zero is a straight line.
 */
export function bracePath(w: number, h: number, depth: number): string {
  const y0 = h / 2;
  const n = (value: number): string => String(Math.round(value * 100) / 100 + 0);
  if (depth === 0 || w <= 0) return `M 0 ${n(y0)} L ${n(Math.max(0, w))} ${n(y0)}`;
  const s = Math.sign(depth);
  const { rx, ry } = braceRadii(w, depth);
  const mid = w / 2;
  const body = y0 + s * ry;
  const tip = y0 + 2 * s * ry;
  // Sweep flags for a point toward +y; a point toward −y is the mirror image.
  const outer = s > 0 ? 0 : 1;
  const inner = 1 - outer;
  const arc = (sweep: number, x: number, y: number): string =>
    ` A ${n(rx)} ${n(ry)} 0 0 ${sweep} ${n(x)} ${n(y)}`;
  return `M 0 ${n(y0)}`
    + arc(outer, rx, body)
    + ` L ${n(mid - rx)} ${n(body)}`
    + arc(inner, mid, tip)
    + arc(inner, mid + rx, body)
    + ` L ${n(w - rx)} ${n(body)}`
    + arc(outer, w, y0);
}

/** Element-local point → canvas point (rotation about the box centre). */
function toCanvas(el: BraceBox, local: XY): XY {
  const rad = (el.rot * Math.PI) / 180;
  const dx = local.x - el.w / 2;
  const dy = local.y - el.h / 2;
  return {
    x: el.x + el.w / 2 + dx * Math.cos(rad) - dy * Math.sin(rad),
    y: el.y + el.h / 2 + dx * Math.sin(rad) + dy * Math.cos(rad),
  };
}

/** Where the brace's point is, in canvas coordinates: its third handle. */
export function braceTip(el: BraceBox): XY {
  return toCanvas(el, { x: el.w / 2, y: el.h / 2 + braceDepthOf(el) });
}

/**
 * The depth that puts the brace's point nearest `point`: the pointer's
 * component along the chord's normal. The point stays on the perpendicular
 * bisector, so the brace stays symmetric however the handle is dragged, and
 * dragging across the chord flips which way it points.
 */
export function braceDepthToward(el: BraceBox, point: XY): number {
  const rad = (el.rot * Math.PI) / 180;
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  return (point.x - cx) * -Math.sin(rad) + (point.y - cy) * Math.cos(rad);
}

/** The brace sampled as a canvas-space polyline, for hit testing and outlines. */
export function bracePolyline(el: BraceBox, segmentsPerCurl = 8): XY[] {
  const depth = braceDepthOf(el);
  const y0 = el.h / 2;
  const local: XY[] = [];
  if (depth === 0 || el.w <= 0) {
    local.push({ x: 0, y: y0 }, { x: Math.max(0, el.w), y: y0 });
  } else {
    const s = Math.sign(depth);
    const { rx, ry } = braceRadii(el.w, depth);
    const mid = el.w / 2;
    // Each curl is a quarter ellipse about a centre, swept between two angles
    // measured in the element frame with +y pointing toward the brace's point.
    const curl = (cx: number, cy: number, from: number, to: number): void => {
      for (let i = 0; i <= segmentsPerCurl; i++) {
        const t = from + ((to - from) * i) / segmentsPerCurl;
        local.push({ x: cx + rx * Math.cos(t), y: cy + s * ry * Math.sin(t) });
      }
    };
    const half = Math.PI / 2;
    curl(rx, y0, Math.PI, half);
    curl(mid - rx, y0 + 2 * s * ry, -half, 0);
    curl(mid + rx, y0 + 2 * s * ry, Math.PI, 3 * half);
    curl(el.w - rx, y0, half, 0);
  }
  return local.map((p) => toCanvas(el, p));
}
