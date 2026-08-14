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

/** Neighbours averaged into a spacing estimate. Enough to survive one outlier. */
const SPACING_NEIGHBOURS = 8;

export interface SpacingOptions {
  /** Same budget as a pick, so a spacing estimate costs one more pass, not more. */
  maxSamples?: number;
  /** How many nearest neighbours to median over. */
  neighbours?: number;
}

/**
 * Local splat spacing around `point`, in scene units — the median distance to
 * its nearest few neighbouring centres.
 *
 * This is the resolution of a pick: a tap snaps to a Gaussian centre, so the
 * true surface point can be about half a spacing away in any direction. It
 * feeds the density half of the uncertainty estimate (PLAN.md §4).
 *
 * Deliberately measured over the **same strided sample** the pick itself used
 * rather than the full cloud. Correcting for the stride would report the
 * spacing of splats the picker never looked at, which is not the resolution
 * the user actually got.
 *
 * Returns `null` when the cloud is too small to have neighbours. Allocates one
 * fixed-size scratch array, nothing per centre.
 */
export function estimateLocalSpacing(
  point: Point3,
  centers: SplatCenters,
  options: SpacingOptions = {},
): number | null {
  const maxSamples = options.maxSamples ?? DEFAULT_PICK_OPTIONS.maxSamples;
  const wanted = Math.max(1, Math.floor(options.neighbours ?? SPACING_NEIGHBOURS));

  const count = Math.max(0, Math.floor(centers.count));
  if (count === 0) return null;

  const stride = pickStride(count, maxSamples);
  const scratch: Vec3Like = { x: 0, y: 0, z: 0 };
  // Ascending list of the closest distances seen so far, fixed length.
  const nearest = new Float64Array(wanted).fill(Number.POSITIVE_INFINITY);
  let found = 0;

  for (let index = 0; index < count; index += stride) {
    centers.getCenter(index, scratch);
    const dx = scratch.x - point[0];
    const dy = scratch.y - point[1];
    const dz = scratch.z - point[2];
    const distanceSq = dx * dx + dy * dy + dz * dz;
    // The picked centre itself (and any exact duplicate of it) says nothing
    // about spacing.
    if (!(distanceSq > 0)) continue;
    if (distanceSq >= nearest[wanted - 1]) continue;

    let slot = wanted - 1;
    while (slot > 0 && nearest[slot - 1] > distanceSq) {
      nearest[slot] = nearest[slot - 1];
      slot -= 1;
    }
    nearest[slot] = distanceSq;
    found = Math.min(found + 1, wanted);
  }

  if (found === 0) return null;
  // Median of what we found — one splat sitting unusually close (a duplicate
  // of the surface) must not halve the reported spacing.
  const middle = nearest[Math.floor((found - 1) / 2)];
  return Number.isFinite(middle) ? Math.sqrt(middle) : null;
}

export interface SceneSpacingOptions extends SpacingOptions {
  /** How many places in the cloud to measure spacing at. */
  probes?: number;
}

/**
 * Typical splat spacing across the whole scene, in scene units.
 *
 * Measures {@link estimateLocalSpacing} at a handful of places spread through
 * the cloud and takes the median, so one dense probe (or one in the middle of
 * a sparse background) does not set the figure for the scene.
 *
 * Runs as **one** pass over the strided sample, updating every probe as it
 * goes: the memory read is what costs, not the arithmetic. That keeps a
 * scene-wide estimate to roughly the price of a single pick, which is why the
 * viewer can afford to run it once a scene finishes loading and give every
 * measurement an uncertainty before the user has picked anything.
 */
export function estimateSceneSpacing(
  centers: SplatCenters,
  options: SceneSpacingOptions = {},
): number | null {
  const maxSamples = options.maxSamples ?? DEFAULT_PICK_OPTIONS.maxSamples;
  const wanted = Math.max(1, Math.floor(options.neighbours ?? SPACING_NEIGHBOURS));
  const probeCount = Math.max(1, Math.floor(options.probes ?? 12));

  const count = Math.max(0, Math.floor(centers.count));
  if (count < 2) return null;

  const stride = pickStride(count, maxSamples);
  const scratch: Vec3Like = { x: 0, y: 0, z: 0 };

  // Probe points, spread evenly through the cloud's index order. Splat files
  // are not spatially sorted, but they are not adversarially ordered either.
  const probes: Point3[] = [];
  for (let i = 0; i < probeCount; i += 1) {
    const index = Math.min(count - 1, Math.floor(((i + 0.5) * count) / probeCount));
    centers.getCenter(index, scratch);
    probes.push([scratch.x, scratch.y, scratch.z]);
  }

  const nearest = probes.map(() => new Float64Array(wanted).fill(Number.POSITIVE_INFINITY));
  const found = new Int32Array(probes.length);

  for (let index = 0; index < count; index += stride) {
    centers.getCenter(index, scratch);
    for (let p = 0; p < probes.length; p += 1) {
      const probe = probes[p];
      const dx = scratch.x - probe[0];
      const dy = scratch.y - probe[1];
      const dz = scratch.z - probe[2];
      const distanceSq = dx * dx + dy * dy + dz * dz;
      if (!(distanceSq > 0)) continue;
      const list = nearest[p];
      if (distanceSq >= list[wanted - 1]) continue;
      let slot = wanted - 1;
      while (slot > 0 && list[slot - 1] > distanceSq) {
        list[slot] = list[slot - 1];
        slot -= 1;
      }
      list[slot] = distanceSq;
      found[p] = Math.min(found[p] + 1, wanted);
    }
  }

  const spacings: number[] = [];
  for (let p = 0; p < probes.length; p += 1) {
    if (found[p] === 0) continue;
    const middle = nearest[p][Math.floor((found[p] - 1) / 2)];
    if (Number.isFinite(middle)) spacings.push(Math.sqrt(middle));
  }
  if (spacings.length === 0) return null;

  spacings.sort((a, b) => a - b);
  return spacings[Math.floor((spacings.length - 1) / 2)];
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
