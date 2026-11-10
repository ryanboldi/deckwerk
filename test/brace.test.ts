import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BRACE_DEPTH,
  braceDepthOf,
  braceDepthToward,
  bracePath,
  bracePolyline,
  braceTip,
} from '../src/shared/brace.js';
import { lineEndpoints } from '../src/renderer/editor/canvas.js';

/** A brace's geometry: two endpoints like a line, one point, four equal curls. */

const box = (over: Partial<{ x: number; y: number; w: number; h: number; rot: number; braceDepth: number }> = {}) =>
  ({ x: 100, y: 300, w: 400, h: 2, rot: 0, braceDepth: 60, ...over });

describe('curly brace geometry', () => {
  it('draws four quarter curls of one radius, the point at twice the radius off the chord', () => {
    // Depth 60: every curl has radius 30; the chord is y=1 in element pixels.
    expect(bracePath(400, 2, 60)).toBe(
      'M 0 1 A 30 30 0 0 0 30 31 L 170 31 A 30 30 0 0 1 200 61'
      + ' A 30 30 0 0 1 230 31 L 370 31 A 30 30 0 0 0 400 1',
    );
  });

  it('mirrors the drawing when the point is on the other side', () => {
    expect(bracePath(400, 2, -60)).toBe(
      'M 0 1 A 30 30 0 0 1 30 -29 L 170 -29 A 30 30 0 0 0 200 -59'
      + ' A 30 30 0 0 0 230 -29 L 370 -29 A 30 30 0 0 1 400 1',
    );
  });

  it('flattens the curls along a short chord rather than moving the point', () => {
    // 4 curls of radius 30 need 120px; on an 80px chord they are 20px wide.
    const d = bracePath(80, 2, 60);
    expect(d).toContain('A 20 30 0 0 1 40 61');
    expect(d.endsWith('80 1')).toBe(true);
  });

  it('is a straight line at zero depth', () => {
    expect(bracePath(400, 2, 0)).toBe('M 0 1 L 400 1');
  });

  it('falls back to the default depth', () => {
    expect(braceDepthOf({})).toBe(DEFAULT_BRACE_DEPTH);
    expect(braceDepthOf({ braceDepth: -12 })).toBe(-12);
  });

  it('puts the point on the perpendicular bisector of the endpoints, rotated with them', () => {
    const el = box({ rot: 90 });
    const { start, end } = lineEndpoints(el);
    const tip = braceTip(el);
    expect(Math.hypot(tip.x - start.x, tip.y - start.y))
      .toBeCloseTo(Math.hypot(tip.x - end.x, tip.y - end.y), 6);
    // Local +y is canvas −x at 90°.
    expect(tip.x).toBeCloseTo(300 - 60, 6);
    expect(tip.y).toBeCloseTo(301, 6);
  });

  it('reads the depth back from a dragged handle, along the normal only', () => {
    for (const rot of [0, 33, -120, 180]) {
      const el = box({ rot, braceDepth: 75 });
      expect(braceDepthToward(el, braceTip(el))).toBeCloseTo(75, 6);
      // Sliding the pointer along the chord does not change the depth.
      const rad = (rot * Math.PI) / 180;
      const slid = { x: braceTip(el).x + 50 * Math.cos(rad), y: braceTip(el).y + 50 * Math.sin(rad) };
      expect(braceDepthToward(el, slid)).toBeCloseTo(75, 6);
    }
    // Across the chord the sign flips: the brace points the other way.
    const el = box();
    expect(braceDepthToward(el, { x: 300, y: 301 - 40 })).toBeCloseTo(-40, 6);
  });

  it('samples a polyline from endpoint to endpoint through the point', () => {
    const el = box({ rot: 30 });
    const points = bracePolyline(el);
    const { start, end } = lineEndpoints(el);
    const tip = braceTip(el);
    expect(points[0].x).toBeCloseTo(start.x, 6);
    expect(points[0].y).toBeCloseTo(start.y, 6);
    expect(points.at(-1)!.x).toBeCloseTo(end.x, 6);
    expect(points.at(-1)!.y).toBeCloseTo(end.y, 6);
    expect(points.some((p) => Math.hypot(p.x - tip.x, p.y - tip.y) < 1e-6)).toBe(true);
  });
});
