/**
 * Picking a 3D point on a Gaussian splat field (PLAN.md §4, WP 3.1).
 *
 * A splat cloud has no triangles to raycast against, so there is nothing for
 * `THREE.Raycaster` to hit. `@mkkellogg/gaussian-splats-3d` does ship an
 * internal `Raycaster` that walks an octree of splat ellipsoids, but as of
 * 0.4.7 it is **not exported** from the package entry point — only `Viewer`,
 * `DropInViewer`, the loaders and the enums are. So we do our own.
 *
 * The approach is the one PLAN.md §4 describes: take the nearest Gaussian
 * centres to the view ray, inside a screen-space radius, weighted towards the
 * camera. Everything here is pure arithmetic over an abstract centre source —
 * no three.js, no WebGL — so the tricky part (the thresholds and the ranking)
 * is unit-testable without a GPU.
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export type Point3 = [number, number, number];

/**
 * A random-access bag of splat centres.
 *
 * Deliberately not an array: a real scene has millions of centres living in a
 * GPU-backed buffer, and the renderer hands them out one at a time into a
 * scratch vector. `getCenter` must therefore write into `out` rather than
 * allocate.
 */
export interface SplatCenters {
  count: number;
  getCenter(index: number, out: Vec3Like): void;
}

/** The slice of `GaussianSplats3D.SplatMesh` picking needs. */
export interface SplatMeshLike {
  getSplatCount(includeSinceLastBuild?: boolean): number;
  getSplatCenter(index: number, out: Vec3Like, applySceneTransform?: boolean): void;
}

export interface PickOptions {
  /**
   * Catch radius as a fraction of the distance along the ray — i.e. a cone,
   * not a cylinder. This is what makes a finger-sized tap work both on a wall
   * 30 cm away and on one 30 m away. Use {@link angularRadiusForScreenRadius}
   * to derive it from a pixel radius.
   */
  angularRadius?: number;
  /** Floor for the catch radius, in scene units. Rescues picks very close to the camera. */
  minRadius?: number;
  /** Ceiling for the catch radius, in scene units. Stops far splats swallowing the screen. */
  maxRadius?: number;
  /** Ignore anything nearer than this along the ray (default 0 — i.e. behind the camera). */
  nearDistance?: number;
  /** Ignore anything further than this along the ray. */
  farDistance?: number;
  /**
   * How strongly to prefer splats near the camera over splats near the ray.
   * The score is `perpendicularDistance + depthWeight * distanceAlongRay`, so
   * a small value breaks ties towards the front surface without letting a
   * foreground splat 20° off-axis win.
   */
  depthWeight?: number;
  /**
   * Upper bound on centres examined per pick. Larger clouds are strided, which
   * keeps a tap on a 6-million-splat scene inside one frame. Surfaces are
   * dense enough that every N-th splat still describes them.
   */
  maxSamples?: number;
}

export interface SplatPick {
  /** Index into the centre source — the strided index actually examined. */
  index: number;
  /** The winning splat's centre, in the same space as the ray. */
  point: Point3;
  /** Perpendicular distance from the ray to that centre. */
  rayDistance: number;
  /** Distance from the ray origin to the closest point on the ray. */
  alongRay: number;
  /** `rayDistance + depthWeight * alongRay`; lower wins. */
  score: number;
  /** How many centres were examined (after striding) — useful for diagnostics. */
  sampled: number;
}

export const DEFAULT_PICK_OPTIONS = {
  /** ≈ 26 px at a 50° vertical field of view on an 800 px-tall viewport. */
  angularRadius: 0.03,
  minRadius: 0,
  maxRadius: Number.POSITIVE_INFINITY,
  nearDistance: 0,
  farDistance: Number.POSITIVE_INFINITY,
  depthWeight: 0.02,
  maxSamples: 200_000,
} satisfies Required<PickOptions>;

/**
 * Converts a comfortable tap radius in CSS pixels into the angular radius
 * {@link pickNearestSplat} wants.
 *
 * At distance `d` from a perspective camera, one screen height covers
 * `2·d·tan(fov/2)` world units, so a pixel is worth `2·tan(fov/2)/height` of
 * `d` — independent of `d`, which is exactly the property we need.
 */
export function angularRadiusForScreenRadius(
  screenRadiusPx: number,
  fovDegrees: number,
  viewportHeightPx: number,
): number {
  if (!(viewportHeightPx > 0) || !(fovDegrees > 0)) return DEFAULT_PICK_OPTIONS.angularRadius;
  const halfFov = (fovDegrees * Math.PI) / 360;
  return (2 * Math.tan(halfFov) * Math.max(screenRadiusPx, 0)) / viewportHeightPx;
}

/** Step between examined centres so that at most `maxSamples` are visited. */
export function pickStride(count: number, maxSamples: number): number {
  if (!Number.isFinite(count) || count <= 0) return 1;
  if (!Number.isFinite(maxSamples) || maxSamples <= 0) return 1;
  return Math.max(1, Math.ceil(count / maxSamples));
}

/** Wraps a flat `[x,y,z,x,y,z,…]` buffer or a list of triples for tests and fixtures. */
export function centersFromArray(source: ArrayLike<number> | readonly Point3[]): SplatCenters {
  const first: unknown = (source as ArrayLike<unknown>)[0];
  if (Array.isArray(first) || source.length === 0) {
    const triples = source as readonly Point3[];
    return {
      count: triples.length,
      getCenter(index, out) {
        const point = triples[index];
        out.x = point[0];
        out.y = point[1];
        out.z = point[2];
      },
    };
  }
  const flat = source as ArrayLike<number>;
  return {
    count: Math.floor(flat.length / 3),
    getCenter(index, out) {
      const base = index * 3;
      out.x = flat[base];
      out.y = flat[base + 1];
      out.z = flat[base + 2];
    },
  };
}

/**
 * Adapts a live `SplatMesh` to {@link SplatCenters}.
 *
 * `scratch` must be whatever vector type the renderer's `getSplatCenter`
 * expects to mutate (a `THREE.Vector3`); it is supplied by the caller so this
 * module stays free of a three.js import.
 */
export function centersFromSplatMesh(mesh: SplatMeshLike, scratch: Vec3Like): SplatCenters {
  return {
    count: mesh.getSplatCount(),
    getCenter(index, out) {
      mesh.getSplatCenter(index, scratch, true);
      out.x = scratch.x;
      out.y = scratch.y;
      out.z = scratch.z;
    },
  };
}

function normalized(direction: Vec3Like): Vec3Like {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!(length > 0)) return { x: 0, y: 0, z: -1 };
  return { x: direction.x / length, y: direction.y / length, z: direction.z / length };
}

/**
 * The splat centre a ray "hits", or `null` when the ray passes through empty
 * space.
 *
 * Returning `null` matters: silently snapping to the closest splat anywhere in
 * the scene would let a user place a measurement point on the sky.
 */
export function pickNearestSplat(
  origin: Vec3Like,
  direction: Vec3Like,
  centers: SplatCenters,
  options: PickOptions = {},
): SplatPick | null {
  const {
    angularRadius,
    minRadius,
    maxRadius,
    nearDistance,
    farDistance,
    depthWeight,
    maxSamples,
  } = { ...DEFAULT_PICK_OPTIONS, ...options };

  const count = Math.max(0, Math.floor(centers.count));
  if (count === 0) return null;

  const dir = normalized(direction);
  const stride = pickStride(count, maxSamples);
  const scratch: Vec3Like = { x: 0, y: 0, z: 0 };

  let best: SplatPick | null = null;
  let sampled = 0;

  for (let index = 0; index < count; index += stride) {
    centers.getCenter(index, scratch);
    sampled += 1;

    const dx = scratch.x - origin.x;
    const dy = scratch.y - origin.y;
    const dz = scratch.z - origin.z;

    const alongRay = dx * dir.x + dy * dir.y + dz * dir.z;
    if (!(alongRay >= nearDistance) || alongRay > farDistance) continue;

    // |d|² − (d·dir)² is the squared perpendicular distance; clamp away the
    // float noise that can make it a hair negative for a dead-centre hit.
    const perpendicularSq = Math.max(dx * dx + dy * dy + dz * dz - alongRay * alongRay, 0);
    const threshold = Math.min(Math.max(angularRadius * alongRay, minRadius), maxRadius);
    if (perpendicularSq > threshold * threshold) continue;

    const rayDistance = Math.sqrt(perpendicularSq);
    const score = rayDistance + depthWeight * alongRay;
    if (best !== null && score >= best.score) continue;

    best = {
      index,
      point: [scratch.x, scratch.y, scratch.z],
      rayDistance,
      alongRay,
      score,
      sampled: 0,
    };
  }

  return best === null ? null : { ...best, sampled };
}
