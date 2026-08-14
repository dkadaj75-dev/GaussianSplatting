/**
 * Scene-space geometry for the measurement tools (PLAN.md §4, WP 5.2).
 *
 * Everything here is pure arithmetic over `Point3` triples — no three.js, no
 * React, no scene graph. The measurement tools are only as trustworthy as this
 * file, and the interesting cases are the degenerate ones (three points in a
 * line do not define a plane; a zero-length arm has no angle), so it lives
 * apart from the renderer where it can be tested exhaustively.
 *
 * Convention for planes matches `THREE.Plane`: the plane is the set of points
 * where `normal · x + constant = 0`, with `normal` a unit vector, so the signed
 * distance of any point is just `normal · p + constant`.
 */

import type { Point3 } from '../types';

export interface Plane {
  /** Unit normal. Its sign fixes which side counts as "above". */
  normal: Point3;
  /** `normal · x + constant = 0` on the plane. */
  constant: number;
  /** Centroid of the points the plane was fitted from — where it is anchored. */
  origin: Point3;
  /**
   * Mean distance from {@link origin} to those points: how much of the plane
   * the picks actually pinned down. A tight cluster fixes the height under
   * itself but says little about a point 10 m away, which is exactly what the
   * uncertainty model needs to know.
   */
  extent: number;
}

/**
 * How degenerate a point set may be and still define a plane.
 *
 * The test below compares a determinant of the (unnormalised) covariance
 * matrix — units of length⁴ — against the square of its trace, which is the
 * same units. The ratio comes out as roughly `(deviation / spread)²`, so 1e-12
 * rejects points that lie in a line to within a millionth of their own spread
 * while still accepting a legitimately thin triangle: a 1 m span picked 1 mm
 * off the line scores 1e-6, six orders of magnitude clear.
 */
const COLLINEAR_EPSILON = 1e-12;

function isFinitePoint(value: unknown): value is Point3 {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

export function subtract3(a: Point3, b: Point3): Point3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function add3(a: Point3, b: Point3): Point3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function scale3(a: Point3, factor: number): Point3 {
  return [a[0] * factor, a[1] * factor, a[2] * factor];
}

export function dot3(a: Point3, b: Point3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a: Point3, b: Point3): Point3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function length3(a: Point3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** Unit vector, or `null` for a zero-length input (which has no direction). */
export function normalize3(a: Point3): Point3 | null {
  const length = length3(a);
  if (!(length > 0)) return null;
  return [a[0] / length, a[1] / length, a[2] / length];
}

export function centroid3(points: readonly Point3[]): Point3 | null {
  if (points.length === 0) return null;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const point of points) {
    x += point[0];
    y += point[1];
    z += point[2];
  }
  const n = points.length;
  return [x / n, y / n, z / n];
}

/**
 * Least-squares plane through three or more points, or `null` when they do not
 * define one.
 *
 * The normal is the eigenvector of the covariance matrix with the smallest
 * eigenvalue — the direction the points vary in least. It is found in closed
 * form from the three 2×2 sub-determinants rather than by an eigen-solver: for
 * a 3×3 symmetric matrix that is exact, branch-free enough to reason about,
 * and about twenty lines.
 *
 * Order-independent by construction, which a polygon method (Newell) is not:
 * three taps on a floor arrive in whatever order the user's thumb chose, and
 * four of them must not cancel out into "no plane" because the path they trace
 * happens to cross itself.
 */
export function fitPlane(points: readonly Point3[]): Plane | null {
  if (points.length < 3 || !points.every(isFinitePoint)) return null;

  const origin = centroid3(points);
  if (!origin) return null;

  // Unnormalised covariance of the points about their centroid.
  let xx = 0;
  let xy = 0;
  let xz = 0;
  let yy = 0;
  let yz = 0;
  let zz = 0;
  for (const point of points) {
    const x = point[0] - origin[0];
    const y = point[1] - origin[1];
    const z = point[2] - origin[2];
    xx += x * x;
    xy += x * y;
    xz += x * z;
    yy += y * y;
    yz += y * z;
    zz += z * z;
  }

  const trace = xx + yy + zz;
  // Every pick landed on the same spot: there is no plane, not even a bad one.
  if (!(trace > 0)) return null;

  const detX = yy * zz - yz * yz;
  const detY = xx * zz - xz * xz;
  const detZ = xx * yy - xy * xy;
  const detMax = Math.max(detX, detY, detZ);

  // Collinear (or good as) picks: the "plane" would be an arbitrary rotation
  // about the line through them, and every height read off it noise.
  if (!(detMax > COLLINEAR_EPSILON * trace * trace)) return null;

  let direction: Point3;
  if (detMax === detX) {
    direction = [detX, xz * yz - xy * zz, xy * yz - xz * yy];
  } else if (detMax === detY) {
    direction = [xz * yz - xy * zz, detY, xy * xz - yz * xx];
  } else {
    direction = [xy * yz - xz * yy, xy * xz - yz * xx, detZ];
  }

  const normal = normalize3(direction);
  if (!normal) return null;

  const extent =
    points.reduce((total, point) => total + length3(subtract3(point, origin)), 0) / points.length;

  return { normal, constant: -dot3(normal, origin), origin, extent };
}

/** Signed distance: positive on the side the normal points at. */
export function signedDistanceToPlane(plane: Plane, point: Point3): number {
  return dot3(plane.normal, point) + plane.constant;
}

/** Perpendicular distance, sign discarded — a height is never negative. */
export function distanceToPlane(plane: Plane, point: Point3): number {
  return Math.abs(signedDistanceToPlane(plane, point));
}

/** The point directly below (or above) `point` on the plane. */
export function projectOntoPlane(plane: Plane, point: Point3): Point3 {
  const signed = signedDistanceToPlane(plane, point);
  return [
    point[0] - plane.normal[0] * signed,
    point[1] - plane.normal[1] * signed,
    point[2] - plane.normal[2] * signed,
  ];
}

/**
 * How far the measured point sits from the middle of the picks that defined
 * the plane, measured *in* the plane.
 *
 * This is the lever arm a tilt error acts through: a floor pinned down by
 * three picks a metre apart tells you very little about a point ten metres
 * away, and the uncertainty has to say so.
 */
export function planeLeverArm(plane: Plane, point: Point3): number {
  return length3(subtract3(projectOntoPlane(plane, point), plane.origin));
}

/** Total length of the path through `points`; 0 for fewer than two. */
export function polylineLength(points: readonly Point3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += length3(subtract3(points[i], points[i - 1]));
  }
  return total;
}

/** Number of segments in the path — one fewer than its vertices, never negative. */
export function polylineSegmentCount(points: readonly Point3[]): number {
  return Math.max(points.length - 1, 0);
}

/**
 * Angle at `vertex` between the arms to `armA` and `armB`, in degrees (0–180),
 * or `null` when an arm has no length.
 *
 * `atan2(|a × b|, a · b)` rather than `acos` of the normalised dot: acos loses
 * all its precision exactly where construction angles cluster — near 0° and
 * near 180°.
 */
export function angleAtVertexDegrees(vertex: Point3, armA: Point3, armB: Point3): number | null {
  const a = subtract3(armA, vertex);
  const b = subtract3(armB, vertex);
  const lengthA = length3(a);
  const lengthB = length3(b);
  if (!(lengthA > 0) || !(lengthB > 0)) return null;
  const radians = Math.atan2(length3(cross3(a, b)), dot3(a, b));
  return (radians * 180) / Math.PI;
}

/**
 * Points along the arc that shows the angle in the scene.
 *
 * Interpolates the two arm directions on the unit sphere (a slerp) so the arc
 * lies in the plane of the angle and every point is exactly `radius` from the
 * vertex. Returns `[]` for a degenerate angle rather than a spray of NaNs.
 */
export function angleArcPoints(
  vertex: Point3,
  armA: Point3,
  armB: Point3,
  radius: number,
  segments = 24,
): Point3[] {
  const a = normalize3(subtract3(armA, vertex));
  const b = normalize3(subtract3(armB, vertex));
  if (!a || !b || !(radius > 0)) return [];

  const cosine = Math.min(Math.max(dot3(a, b), -1), 1);
  const theta = Math.acos(cosine);
  const steps = Math.max(2, Math.floor(segments));
  const sinTheta = Math.sin(theta);
  const points: Point3[] = [];

  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    let direction: Point3;
    if (sinTheta < 1e-6) {
      // Arms are parallel or anti-parallel: the arc is a point (or undefined),
      // so a straight interpolation is both harmless and NaN-free.
      direction = normalize3(add3(scale3(a, 1 - t), scale3(b, t))) ?? a;
    } else {
      const wa = Math.sin((1 - t) * theta) / sinTheta;
      const wb = Math.sin(t * theta) / sinTheta;
      direction = normalize3(add3(scale3(a, wa), scale3(b, wb))) ?? a;
    }
    points.push(add3(vertex, scale3(direction, radius)));
  }

  return points;
}

/** A sensible arc radius: a quarter of the shorter arm, so it never overshoots. */
export function angleArcRadius(vertex: Point3, armA: Point3, armB: Point3): number {
  const lengthA = length3(subtract3(armA, vertex));
  const lengthB = length3(subtract3(armB, vertex));
  return Math.min(lengthA, lengthB) * 0.25;
}
