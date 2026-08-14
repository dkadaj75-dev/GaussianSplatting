import { describe, expect, it, vi } from 'vitest';
import {
  angularRadiusForScreenRadius,
  centersFromArray,
  centersFromSplatMesh,
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
