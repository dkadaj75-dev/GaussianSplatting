import { describe, expect, it, vi } from 'vitest';
import {
  angularRadiusForScreenRadius,
  centersFromArray,
  centersFromSplatMesh,
  estimateLocalSpacing,
  estimateSceneSpacing,
  pickNearestSplat,
  pickStride,
} from './picking';
import type { Point3, Vec3Like } from './picking';

const ORIGIN = { x: 0, y: 0, z: 0 };
/** Straight down -Z, the direction three.js cameras look by default. */
const FORWARD = { x: 0, y: 0, z: -1 };

describe('pickStride', () => {
  it('visits every splat while the cloud fits the budget', () => {
    expect(pickStride(1_000, 200_000)).toBe(1);
    expect(pickStride(200_000, 200_000)).toBe(1);
  });

  it('strides just enough to stay inside the budget', () => {
    expect(pickStride(400_000, 200_000)).toBe(2);
    expect(pickStride(6_000_000, 200_000)).toBe(30);
    // Never so coarse that the sample count exceeds the cap.
    expect(Math.ceil(6_000_000 / pickStride(6_000_000, 200_000))).toBeLessThanOrEqual(200_000);
  });

  it('degrades to 1 on nonsense input rather than dividing by zero', () => {
    expect(pickStride(0, 200_000)).toBe(1);
    expect(pickStride(100, 0)).toBe(1);
    expect(pickStride(Number.NaN, 200_000)).toBe(1);
  });
});

describe('angularRadiusForScreenRadius', () => {
  it('turns a pixel radius into a distance-independent cone', () => {
    // 50° fov over 800 px: one pixel is 2·tan(25°)/800 of the distance.
    const perPixel = (2 * Math.tan((50 * Math.PI) / 360)) / 800;
    expect(angularRadiusForScreenRadius(22, 50, 800)).toBeCloseTo(perPixel * 22, 12);
  });

  it('scales inversely with viewport height — the same tap is a bigger cone on a short screen', () => {
    expect(angularRadiusForScreenRadius(22, 50, 400)).toBeCloseTo(
      angularRadiusForScreenRadius(22, 50, 800) * 2,
      12,
    );
  });

  it('falls back to the default rather than returning Infinity for a zero-height viewport', () => {
    expect(angularRadiusForScreenRadius(22, 50, 0)).toBe(0.03);
  });
});

describe('centersFromArray', () => {
  it('reads a flat xyz buffer', () => {
    const centers = centersFromArray(new Float32Array([1, 2, 3, 4, 5, 6]));
    const out: Vec3Like = { x: 0, y: 0, z: 0 };
    expect(centers.count).toBe(2);
    centers.getCenter(1, out);
    expect(out).toEqual({ x: 4, y: 5, z: 6 });
  });

  it('reads a list of triples', () => {
    const centers = centersFromArray([
      [1, 2, 3],
      [4, 5, 6],
    ] as Point3[]);
    const out: Vec3Like = { x: 0, y: 0, z: 0 };
    expect(centers.count).toBe(2);
    centers.getCenter(0, out);
    expect(out).toEqual({ x: 1, y: 2, z: 3 });
  });
});

describe('pickNearestSplat', () => {
  it('returns the splat the ray passes through', () => {
    const centers = centersFromArray([
      [0, 0, -5],
      [3, 0, -5],
    ] as Point3[]);

    const hit = pickNearestSplat(ORIGIN, FORWARD, centers, { angularRadius: 0.05 });

    expect(hit).not.toBeNull();
    expect(hit?.point).toEqual([0, 0, -5]);
    expect(hit?.rayDistance).toBeCloseTo(0, 12);
    expect(hit?.alongRay).toBeCloseTo(5, 12);
  });

  it('returns null when the ray only sees empty space', () => {
    const centers = centersFromArray([[3, 0, -5]] as Point3[]);
    // 3 units off-axis at 5 units out is 60% of the distance — far outside a 5% cone.
    expect(pickNearestSplat(ORIGIN, FORWARD, centers, { angularRadius: 0.05 })).toBeNull();
  });

  it('ignores everything behind the camera', () => {
    const centers = centersFromArray([[0, 0, 5]] as Point3[]);
    expect(pickNearestSplat(ORIGIN, FORWARD, centers)).toBeNull();
  });

  it('scales the catch radius with distance so far taps still land', () => {
    // Both are 2% off-axis; only the cone (not a fixed radius) accepts both.
    const near = centersFromArray([[0.02, 0, -1]] as Point3[]);
    const far = centersFromArray([[2, 0, -100]] as Point3[]);
    const options = { angularRadius: 0.03 };

    expect(pickNearestSplat(ORIGIN, FORWARD, near, options)).not.toBeNull();
    expect(pickNearestSplat(ORIGIN, FORWARD, far, options)).not.toBeNull();
  });

  it('honours minRadius so a splat right in front of the lens is still pickable', () => {
    // 0.01 off-axis at 0.02 out: the cone alone is only 0.0006 wide there.
    const centers = centersFromArray([[0.01, 0, -0.02]] as Point3[]);

    expect(pickNearestSplat(ORIGIN, FORWARD, centers, { angularRadius: 0.03 })).toBeNull();
    expect(
      pickNearestSplat(ORIGIN, FORWARD, centers, { angularRadius: 0.03, minRadius: 0.05 }),
    ).not.toBeNull();
  });

  it('honours maxRadius so a distant tap cannot swallow the scene', () => {
    const centers = centersFromArray([[5, 0, -100]] as Point3[]);

    expect(pickNearestSplat(ORIGIN, FORWARD, centers, { angularRadius: 0.1 })).not.toBeNull();
    expect(
      pickNearestSplat(ORIGIN, FORWARD, centers, { angularRadius: 0.1, maxRadius: 1 }),
    ).toBeNull();
  });

  it('prefers the front surface when two candidates sit equally close to the ray', () => {
    const centers = centersFromArray([
      [0, 0, -20], // back wall
      [0, 0, -4], // the surface actually facing the camera
    ] as Point3[]);

    const hit = pickNearestSplat(ORIGIN, FORWARD, centers, { angularRadius: 0.05 });

    expect(hit?.point).toEqual([0, 0, -4]);
  });

  it('still prefers a dead-centre hit over a near-but-off-axis one at the same depth', () => {
    const centers = centersFromArray([
      [0.15, 0, -5], // grazing the edge of the cone
      [0, 0, -5.2], // slightly further, but under the finger
    ] as Point3[]);

    const hit = pickNearestSplat(ORIGIN, FORWARD, centers, {
      angularRadius: 0.05,
      depthWeight: 0.02,
    });

    expect(hit?.point).toEqual([0, 0, -5.2]);
  });

  it('respects nearDistance and farDistance clipping', () => {
    const centers = centersFromArray([
      [0, 0, -0.05],
      [0, 0, -500],
    ] as Point3[]);

    expect(
      pickNearestSplat(ORIGIN, FORWARD, centers, {
        angularRadius: 0.05,
        nearDistance: 0.1,
        farDistance: 100,
      }),
    ).toBeNull();
  });

  it('normalises the direction, so an unnormalised ray gives the same answer', () => {
    const centers = centersFromArray([[0.05, 0, -5]] as Point3[]);
    const options = { angularRadius: 0.05 };

    const unit = pickNearestSplat(ORIGIN, FORWARD, centers, options);
    const long = pickNearestSplat(ORIGIN, { x: 0, y: 0, z: -37 }, centers, options);

    expect(long?.alongRay).toBeCloseTo(unit?.alongRay ?? -1, 12);
    expect(long?.rayDistance).toBeCloseTo(unit?.rayDistance ?? -1, 12);
  });

  it('strides a huge cloud instead of walking all of it', () => {
    const count = 1_000_000;
    const getCenter = vi.fn((index: number, out: Vec3Like) => {
      // A wall at z = -5, with one splat dead ahead at a strided index.
      out.x = index === 600_000 ? 0 : 1000;
      out.y = 0;
      out.z = -5;
    });

    const hit = pickNearestSplat(
      ORIGIN,
      FORWARD,
      { count, getCenter },
      { angularRadius: 0.05, maxSamples: 200_000 },
    );

    expect(getCenter).toHaveBeenCalledTimes(200_000);
    expect(hit?.sampled).toBe(200_000);
    // Stride is 5, so index 600_000 is on the sampling grid and is found.
    expect(hit?.index).toBe(600_000);
  });

  it('misses splats that fall between strided samples — the documented trade-off', () => {
    const count = 1_000_000;
    const centers = {
      count,
      getCenter: (index: number, out: Vec3Like) => {
        out.x = index === 600_001 ? 0 : 1000;
        out.y = 0;
        out.z = -5;
      },
    };

    expect(pickNearestSplat(ORIGIN, FORWARD, centers, { maxSamples: 200_000 })).toBeNull();
    // With the budget raised to cover the cloud, the same splat is found.
    expect(
      pickNearestSplat(ORIGIN, FORWARD, centers, { maxSamples: count })?.index,
    ).toBe(600_001);
  });

  it('handles an empty cloud', () => {
    expect(pickNearestSplat(ORIGIN, FORWARD, centersFromArray([]), {})).toBeNull();
  });

  it('reports how many centres it examined', () => {
    const centers = centersFromArray([
      [0, 0, -5],
      [0, 0, -6],
      [0, 0, -7],
    ] as Point3[]);

    expect(pickNearestSplat(ORIGIN, FORWARD, centers, { angularRadius: 0.05 })?.sampled).toBe(3);
  });
});

describe('centersFromSplatMesh', () => {
  it('adapts the renderer mesh, reusing the caller-supplied scratch vector', () => {
    const scratch: Vec3Like = { x: 0, y: 0, z: 0 };
    const mesh = {
      getSplatCount: () => 2,
      getSplatCenter: (index: number, out: Vec3Like, applySceneTransform?: boolean) => {
        expect(applySceneTransform).toBe(true);
        out.x = index;
        out.y = index * 2;
        out.z = -5;
      },
    };

    const centers = centersFromSplatMesh(mesh, scratch);
    const out: Vec3Like = { x: 0, y: 0, z: 0 };
    centers.getCenter(1, out);

    expect(centers.count).toBe(2);
    expect(out).toEqual({ x: 1, y: 2, z: -5 });
  });
});

describe('estimateLocalSpacing', () => {
  /** A regular grid, 0.1 apart — a stand-in for a well-sampled surface. */
  function grid(step: number, size: number): Point3[] {
    const points: Point3[] = [];
    for (let x = 0; x < size; x += 1) {
      for (let y = 0; y < size; y += 1) points.push([x * step, y * step, 0]);
    }
    return points;
  }

  it('measures the distance to the nearest neighbours around a pick', () => {
    const centers = centersFromArray(grid(0.1, 9));
    const spacing = estimateLocalSpacing([0.4, 0.4, 0], centers);
    // Eight neighbours: four at 0.1, four at 0.1414 — the median is 0.1.
    expect(spacing).toBeCloseTo(0.1, 6);
  });

  it('grows with a sparser cloud, which is the whole point', () => {
    const dense = estimateLocalSpacing([0.4, 0.4, 0], centersFromArray(grid(0.1, 9)))!;
    const sparse = estimateLocalSpacing([1.6, 1.6, 0], centersFromArray(grid(0.4, 9)))!;
    expect(sparse).toBeCloseTo(dense * 4, 6);
  });

  it('ignores the picked centre itself and any duplicate of it', () => {
    const centers = centersFromArray([
      [0, 0, 0],
      [0, 0, 0],
      [0.2, 0, 0],
      [0, 0.2, 0],
    ]);
    expect(estimateLocalSpacing([0, 0, 0], centers)).toBeCloseTo(0.2, 12);
  });

  it('reports nothing when there is nothing to compare against', () => {
    expect(estimateLocalSpacing([0, 0, 0], centersFromArray([]))).toBeNull();
    expect(estimateLocalSpacing([0, 0, 0], centersFromArray([[0, 0, 0]]))).toBeNull();
  });

  it('honours the sample budget, so a pick stays inside one frame', () => {
    let visited = 0;
    const centers = {
      count: 1_000_000,
      getCenter(index: number, out: Vec3Like) {
        visited += 1;
        out.x = index * 0.001;
        out.y = 0;
        out.z = 0;
      },
    };
    estimateLocalSpacing([500, 0, 0], centers, { maxSamples: 1000 });
    expect(visited).toBeLessThanOrEqual(1000);
  });

  it('works with fewer neighbours than it asked for', () => {
    const centers = centersFromArray([
      [0, 0, 0],
      [0.3, 0, 0],
    ]);
    expect(estimateLocalSpacing([0, 0, 0], centers, { neighbours: 8 })).toBeCloseTo(0.3, 12);
  });
});

describe('estimateSceneSpacing', () => {
  /** Two clouds joined: a dense patch and a sparse one, ten units apart. */
  function mixedCloud(): Point3[] {
    const points: Point3[] = [];
    for (let x = 0; x < 10; x += 1) {
      for (let y = 0; y < 10; y += 1) points.push([x * 0.1, y * 0.1, 0]);
    }
    for (let x = 0; x < 10; x += 1) {
      for (let y = 0; y < 10; y += 1) points.push([10 + x * 0.5, y * 0.5, 0]);
    }
    return points;
  }

  it('reports the typical spacing, not the densest or the sparsest patch', () => {
    const spacing = estimateSceneSpacing(centersFromArray(mixedCloud()), { probes: 8 })!;
    expect(spacing).toBeGreaterThan(0.1);
    expect(spacing).toBeLessThan(0.5);
  });

  it('lands on the same order as a local estimate, erring high', () => {
    const grid: Point3[] = [];
    for (let x = 0; x < 12; x += 1) {
      for (let y = 0; y < 12; y += 1) grid.push([x * 0.2, y * 0.2, 0]);
    }
    const centers = centersFromArray(grid);
    const local = estimateLocalSpacing([1.2, 1.2, 0], centers)!;
    const scene = estimateSceneSpacing(centers, { probes: 6 })!;

    // Never optimistic: a probe that happens to land on the edge of the cloud
    // is missing neighbours on one side and reports a wider spacing, which is
    // the safe direction for an uncertainty to be wrong in.
    expect(scene).toBeGreaterThanOrEqual(local);
    expect(scene).toBeLessThan(local * 1.5);
  });

  it('reports nothing for a cloud with nothing to measure', () => {
    expect(estimateSceneSpacing(centersFromArray([]))).toBeNull();
    expect(estimateSceneSpacing(centersFromArray([[0, 0, 0]]))).toBeNull();
  });

  it('walks the cloud once, however many probes it uses', () => {
    let visited = 0;
    const centers = {
      count: 10_000,
      getCenter(index: number, out: Vec3Like) {
        visited += 1;
        out.x = index * 0.01;
        out.y = 0;
        out.z = 0;
      },
    };
    estimateSceneSpacing(centers, { probes: 12, maxSamples: 1000 });
    // One strided pass (1000) plus one read per probe to find where it is.
    expect(visited).toBeLessThanOrEqual(1000 + 12);
  });
});
