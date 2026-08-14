import { describe, expect, it } from 'vitest';
import {
  angleArcPoints,
  angleArcRadius,
  angleAtVertexDegrees,
  centroid3,
  cross3,
  distanceToPlane,
  fitPlane,
  length3,
  normalize3,
  planeLeverArm,
  polylineLength,
  polylineSegmentCount,
  projectOntoPlane,
  signedDistanceToPlane,
  subtract3,
} from './geometry';
import type { Point3 } from '../types';

/** The XZ plane, y up — the shape of a floor in a Y-up scene. */
const FLOOR: Point3[] = [
  [0, 0, 0],
  [2, 0, 0],
  [0, 0, 2],
];

describe('fitPlane', () => {
  it('fits three points exactly', () => {
    const plane = fitPlane(FLOOR);
    expect(plane).not.toBeNull();
    // Unit normal along ±y; the sign follows the winding, not our expectation.
    expect(Math.abs(plane!.normal[1])).toBeCloseTo(1, 12);
    expect(Math.hypot(plane!.normal[0], plane!.normal[2])).toBeCloseTo(0, 12);
    expect(plane!.constant).toBeCloseTo(0, 12);
    for (const point of FLOOR) expect(distanceToPlane(plane!, point)).toBeCloseTo(0, 12);
  });

  it('reports the centroid and how far the picks spread around it', () => {
    const plane = fitPlane(FLOOR)!;
    expect(centroid3(FLOOR)).toEqual([2 / 3, 0, 2 / 3]);
    expect(plane.origin).toEqual([2 / 3, 0, 2 / 3]);
    // Mean distance from the centroid to the three corners.
    const expected =
      FLOOR.reduce((total, point) => total + length3(subtract3(point, plane.origin)), 0) / 3;
    expect(plane.extent).toBeCloseTo(expected, 12);
  });

  it('fits more than three points, letting a stray pick tilt rather than hijack', () => {
    const plane = fitPlane([...FLOOR, [2, 0, 2]])!;
    expect(Math.abs(plane.normal[1])).toBeCloseTo(1, 12);
    expect(plane.extent).toBeGreaterThan(0);
  });

  it('refuses three points in a line', () => {
    expect(
      fitPlane([
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ]),
    ).toBeNull();
  });

  it('refuses points that are only *nearly* in a line', () => {
    // 1 nm off a 2 m line: the normal exists numerically but means nothing.
    expect(
      fitPlane([
        [0, 0, 0],
        [1, 0, 0],
        [2, 1e-9, 0],
      ]),
    ).toBeNull();
  });

  it('accepts a legitimately thin triangle — 1 mm across a 1 m span', () => {
    expect(
      fitPlane([
        [0, 0, 0],
        [1, 0, 0],
        [0.5, 0.001, 0],
      ]),
    ).not.toBeNull();
  });

  it('refuses coincident points, too few points and non-finite input', () => {
    expect(fitPlane([[1, 1, 1], [1, 1, 1], [1, 1, 1]])).toBeNull();
    expect(fitPlane([[0, 0, 0], [1, 0, 0]])).toBeNull();
    expect(fitPlane([])).toBeNull();
    expect(fitPlane([[0, 0, 0], [1, 0, 0], [0, Number.NaN, 1]])).toBeNull();
  });
});

describe('distance to a plane', () => {
  const plane = fitPlane(FLOOR)!;

  it('is the perpendicular drop, in either direction', () => {
    expect(distanceToPlane(plane, [5, 1.6, -3])).toBeCloseTo(1.6, 12);
    expect(distanceToPlane(plane, [5, -1.6, -3])).toBeCloseTo(1.6, 12);
    expect(distanceToPlane(plane, [5, 0, -3])).toBeCloseTo(0, 12);
  });

  it('keeps a sign so "above" and "below" stay distinguishable', () => {
    const above = signedDistanceToPlane(plane, [0, 1, 0]);
    const below = signedDistanceToPlane(plane, [0, -1, 0]);
    expect(Math.sign(above)).toBe(-Math.sign(below));
    expect(Math.abs(above)).toBeCloseTo(1, 12);
  });

  it('projects a point onto the plane it hangs above', () => {
    const foot = projectOntoPlane(plane, [1, 2.5, 1]);
    expect(foot[1]).toBeCloseTo(0, 12);
    expect(foot[0]).toBeCloseTo(1, 12);
    expect(foot[2]).toBeCloseTo(1, 12);
    expect(distanceToPlane(plane, foot)).toBeCloseTo(0, 12);
  });

  it('measures the lever arm in the plane, ignoring the height', () => {
    // Directly over the centroid: no lever arm however high the point is.
    expect(planeLeverArm(plane, [2 / 3, 9, 2 / 3])).toBeCloseTo(0, 12);
    expect(planeLeverArm(plane, [2 / 3 + 3, 9, 2 / 3])).toBeCloseTo(3, 12);
  });
});

describe('polylineLength', () => {
  it('adds the segments up', () => {
    expect(
      polylineLength([
        [0, 0, 0],
        [3, 4, 0],
        [3, 4, 5],
      ]),
    ).toBe(10);
  });

  it('is zero for a path that has not started', () => {
    expect(polylineLength([])).toBe(0);
    expect(polylineLength([[1, 2, 3]])).toBe(0);
  });

  it('counts segments, never a negative number of them', () => {
    expect(polylineSegmentCount([])).toBe(0);
    expect(polylineSegmentCount([[0, 0, 0]])).toBe(0);
    expect(polylineSegmentCount([[0, 0, 0], [1, 0, 0], [2, 0, 0]])).toBe(2);
  });

  it('counts a doubled-back path at its full walked length', () => {
    expect(
      polylineLength([
        [0, 0, 0],
        [1, 0, 0],
        [0, 0, 0],
      ]),
    ).toBe(2);
  });
});

describe('angleAtVertexDegrees', () => {
  const VERTEX: Point3 = [0, 0, 0];

  it('measures a right angle', () => {
    expect(angleAtVertexDegrees(VERTEX, [1, 0, 0], [0, 1, 0])).toBeCloseTo(90, 12);
  });

  it('measures a straight line as 180° and a fold as 0°', () => {
    expect(angleAtVertexDegrees(VERTEX, [1, 0, 0], [-1, 0, 0])).toBeCloseTo(180, 12);
    expect(angleAtVertexDegrees(VERTEX, [1, 0, 0], [2, 0, 0])).toBeCloseTo(0, 12);
  });

  it('keeps its precision at the shallow angles construction actually has', () => {
    // acos of a normalised dot loses half its digits here; atan2 does not.
    const nearlyStraight = angleAtVertexDegrees(VERTEX, [1, 0, 0], [-1, 1e-6, 0]);
    expect(nearlyStraight).toBeCloseTo(180 - (1e-6 * 180) / Math.PI, 9);
  });

  it('is independent of arm length', () => {
    expect(angleAtVertexDegrees(VERTEX, [10, 0, 0], [0, 0.001, 0])).toBeCloseTo(90, 12);
  });

  it('refuses an arm with no length instead of returning NaN', () => {
    expect(angleAtVertexDegrees(VERTEX, VERTEX, [0, 1, 0])).toBeNull();
    expect(angleAtVertexDegrees(VERTEX, [1, 0, 0], VERTEX)).toBeNull();
    expect(angleAtVertexDegrees(VERTEX, VERTEX, VERTEX)).toBeNull();
  });
});

describe('angleArcPoints', () => {
  const VERTEX: Point3 = [1, 1, 1];

  it('draws an arc at a constant radius, from one arm to the other', () => {
    const arc = angleArcPoints(VERTEX, [2, 1, 1], [1, 2, 1], 0.5, 8);
    expect(arc).toHaveLength(9);
    for (const point of arc) {
      expect(length3(subtract3(point, VERTEX))).toBeCloseTo(0.5, 12);
    }
    expect(arc[0]).toEqual([1.5, 1, 1]);
    expect(arc[arc.length - 1][1]).toBeCloseTo(1.5, 12);
  });

  it('stays in the plane of the angle', () => {
    const normal = cross3([1, 0, 0], [0, 1, 0]);
    for (const point of angleArcPoints(VERTEX, [2, 1, 1], [1, 2, 1], 0.5, 6)) {
      const offset = subtract3(point, VERTEX);
      expect(offset[0] * normal[0] + offset[1] * normal[1] + offset[2] * normal[2]).toBeCloseTo(
        0,
        12,
      );
    }
  });

  it('produces no NaNs for parallel or anti-parallel arms', () => {
    for (const arm of [[2, 1, 1], [0, 1, 1]] as Point3[]) {
      const arc = angleArcPoints(VERTEX, [2, 1, 1], arm, 0.5, 4);
      expect(arc.every((point) => point.every(Number.isFinite))).toBe(true);
    }
  });

  it('returns nothing to draw for a degenerate angle or a zero radius', () => {
    expect(angleArcPoints(VERTEX, VERTEX, [1, 2, 1], 0.5)).toEqual([]);
    expect(angleArcPoints(VERTEX, [2, 1, 1], [1, 2, 1], 0)).toEqual([]);
  });

  it('sizes itself off the shorter arm so it cannot overshoot', () => {
    expect(angleArcRadius([0, 0, 0], [4, 0, 0], [0, 1, 0])).toBeCloseTo(0.25, 12);
  });
});

describe('vector helpers', () => {
  it('normalises, and refuses a zero vector', () => {
    expect(normalize3([0, 3, 4])).toEqual([0, 0.6, 0.8]);
    expect(normalize3([0, 0, 0])).toBeNull();
  });

  it('has no centroid for an empty set', () => {
    expect(centroid3([])).toBeNull();
  });
});
