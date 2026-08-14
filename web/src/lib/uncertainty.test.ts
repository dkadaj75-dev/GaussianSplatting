import { describe, expect, it } from 'vitest';
import {
  ARUCO_FLOOR_SIGMA,
  KNOWN_DISTANCE_RELATIVE_SIGMA,
  angleUncertaintyDegrees,
  calibrationRelativeSigma,
  heightUncertainty,
  lengthUncertainty,
  pointSigma,
  polylineWeights,
} from './uncertainty';
import type { Calibration } from '../types';

function manual(scale = 0.5): Calibration {
  return {
    scale,
    method: 'known_distance',
    reference: { pointA: [0, 0, 0], pointB: [3, 4, 0], realDistanceM: 5 * scale },
    calibratedAt: '2026-08-14T10:00:00Z',
  };
}

function aruco(overrides: Partial<Calibration> = {}): Calibration {
  return {
    scale: 0.5,
    method: 'aruco',
    reference: null,
    calibratedAt: '2026-08-14T10:00:00Z',
    residual: 0.018,
    sampleCount: 12,
    markerLengthM: 0.15,
    markerDictionary: 'DICT_4X4_50',
    ...overrides,
  };
}

describe('pointSigma', () => {
  it('combines the snap quantisation with how far off the ray the splat sat', () => {
    // Half the spacing, and the ray distance, in quadrature.
    expect(pointSigma({ rayDistance: 0.04, spacing: 0.06 })).toBeCloseTo(Math.hypot(0.03, 0.04), 12);
  });

  it('falls back to whichever term is known', () => {
    expect(pointSigma({ rayDistance: 0.04, spacing: null })).toBeCloseTo(0.04, 12);
    expect(pointSigma({ rayDistance: 0, spacing: 0.06 })).toBeCloseTo(0.03, 12);
  });

  it('rejects nonsense rather than propagating it', () => {
    expect(pointSigma({ rayDistance: Number.NaN, spacing: null })).toBeNull();
    expect(pointSigma({ rayDistance: Number.NaN, spacing: -1 })).toBeNull();
  });
});

describe('calibrationRelativeSigma', () => {
  it('is zero without a scale — an uncalibrated scene has no scale to be wrong about', () => {
    expect(calibrationRelativeSigma(null)).toBe(0);
    expect(calibrationRelativeSigma(undefined)).toBe(0);
  });

  it('uses the documented fixed term for a hand-entered distance', () => {
    expect(calibrationRelativeSigma(manual())).toBe(KNOWN_DISTANCE_RELATIVE_SIGMA);
  });

  it('uses the ArUco residual the worker reported', () => {
    expect(calibrationRelativeSigma(aruco())).toBeCloseTo(0.018, 12);
  });

  it('floors an implausibly tight ArUco residual — agreement is not accuracy', () => {
    expect(calibrationRelativeSigma(aruco({ residual: 0.0001 }))).toBe(ARUCO_FLOOR_SIGMA);
  });

  it('does not trust a residual from a single marker, or a missing one', () => {
    expect(calibrationRelativeSigma(aruco({ sampleCount: 1, residual: 0.0001 }))).toBe(
      KNOWN_DISTANCE_RELATIVE_SIGMA,
    );
    expect(calibrationRelativeSigma(aruco({ residual: null }))).toBe(
      KNOWN_DISTANCE_RELATIVE_SIGMA,
    );
  });

  it('ignores a corrupt scale', () => {
    expect(calibrationRelativeSigma({ ...manual(), scale: Number.NaN })).toBe(0);
  });
});

describe('lengthUncertainty', () => {
  it('adds the picks in quadrature and the scale proportionally', () => {
    const result = lengthUncertainty({
      sceneValue: 10,
      pointSigmas: [0.03, 0.04],
      calibration: manual(),
    });
    // sqrt(0.03² + 0.04²) = 0.05 from the picks; 2 % of 10 = 0.2 from the scale.
    expect(result.sigmaScene).toBeCloseTo(Math.hypot(0.05, 0.2), 12);
    expect(result.relative).toBeCloseTo(result.sigmaScene / 10, 12);
    expect(result.basis).toBe('full');
  });

  it('charges a shared vertex to both of its segments', () => {
    const weighted = lengthUncertainty({
      sceneValue: 10,
      pointSigmas: [0.1, 0.1, 0.1],
      weights: polylineWeights(3),
    });
    // Ends count once, the middle twice: sqrt(0.1² + 0.2² + 0.1²).
    expect(weighted.sigmaScene).toBeCloseTo(Math.hypot(0.1, 0.2, 0.1), 12);
  });

  it('is dominated by the picks on short measurements and by the scale on long ones', () => {
    const short = lengthUncertainty({ sceneValue: 0.1, pointSigmas: [0.02, 0.02], calibration: manual() });
    const long = lengthUncertainty({ sceneValue: 100, pointSigmas: [0.02, 0.02], calibration: manual() });
    expect(short.relative!).toBeGreaterThan(0.25);
    expect(long.relative!).toBeCloseTo(KNOWN_DISTANCE_RELATIVE_SIGMA, 3);
  });

  it('reports what it could not know instead of assuming zero', () => {
    expect(lengthUncertainty({ sceneValue: 5, calibration: manual() }).basis).toBe('scale-only');
    expect(lengthUncertainty({ sceneValue: 5 }).basis).toBe('none');
    expect(lengthUncertainty({ sceneValue: 5, pointSigmas: [0.01, 0.01], assumed: true }).basis).toBe(
      'assumed-spacing',
    );
  });

  it('has no relative figure for a zero-length measurement', () => {
    expect(lengthUncertainty({ sceneValue: 0, pointSigmas: [0.01] }).relative).toBeNull();
  });

  it('survives non-finite input', () => {
    const result = lengthUncertainty({
      sceneValue: Number.NaN,
      pointSigmas: [Number.NaN, 0.02],
      calibration: manual(),
    });
    expect(Number.isFinite(result.sigmaScene)).toBe(true);
  });
});

describe('polylineWeights', () => {
  it('is all ones for a segment and doubles the interior vertices of a path', () => {
    expect(polylineWeights(2)).toEqual([1, 1]);
    expect(polylineWeights(4)).toEqual([1, 2, 2, 1]);
    expect(polylineWeights(0)).toEqual([]);
  });
});

describe('angleUncertaintyDegrees', () => {
  it('is a pick error divided by the arm it acts on', () => {
    const degrees = angleUncertaintyDegrees({
      armLengthA: 1,
      armLengthB: 1,
      armSigmaA: 0.01,
      armSigmaB: 0,
      vertexSigma: 0,
    });
    expect(degrees).toBeCloseTo((0.01 * 180) / Math.PI, 12);
  });

  it('shrinks as the arms get longer — the same taps, a better angle', () => {
    const short = angleUncertaintyDegrees({ armLengthA: 0.2, armLengthB: 0.2, armSigmaA: 0.01, armSigmaB: 0.01 })!;
    const long = angleUncertaintyDegrees({ armLengthA: 2, armLengthB: 2, armSigmaA: 0.01, armSigmaB: 0.01 })!;
    expect(short).toBeCloseTo(long * 10, 6);
  });

  it('charges the vertex to both arms', () => {
    const vertexOnly = angleUncertaintyDegrees({ armLengthA: 1, armLengthB: 1, vertexSigma: 0.01 })!;
    const oneArm = angleUncertaintyDegrees({ armLengthA: 1, armLengthB: 1, armSigmaA: 0.01 })!;
    expect(vertexOnly).toBeCloseTo(oneArm * Math.SQRT2, 12);
  });

  it('has nothing to say without arms, or without any pick quality', () => {
    expect(angleUncertaintyDegrees({ armLengthA: 0, armLengthB: 1, armSigmaA: 0.01 })).toBeNull();
    expect(angleUncertaintyDegrees({ armLengthA: 1, armLengthB: 1 })).toBeNull();
  });
});

describe('heightUncertainty', () => {
  const base = {
    height: 2,
    pointSigma: 0.02,
    planeSigmas: [0.02, 0.02, 0.02],
    planeExtent: 1,
    leverArm: 0,
  };

  it('combines the point, the plane offset and the scale', () => {
    const result = heightUncertainty({ ...base, calibration: manual() });
    const offset = 0.02 / Math.sqrt(3);
    expect(result.sigmaScene).toBeCloseTo(Math.hypot(0.02, offset, 0.02 * 2), 12);
    expect(result.basis).toBe('full');
  });

  it('grows with the lever arm — a floor pinned in one corner does not measure the other', () => {
    const near = heightUncertainty(base).sigmaScene;
    const far = heightUncertainty({ ...base, leverArm: 10 }).sigmaScene;
    expect(far).toBeGreaterThan(near * 5);
  });

  it('grows when the plane picks are cramped together', () => {
    const spread = heightUncertainty({ ...base, planeExtent: 2, leverArm: 4 }).sigmaScene;
    const cramped = heightUncertainty({ ...base, planeExtent: 0.2, leverArm: 4 }).sigmaScene;
    expect(cramped).toBeGreaterThan(spread * 5);
  });

  it('falls back to scale-only when nothing is known about the picks', () => {
    const result = heightUncertainty({
      height: 2,
      planeSigmas: [],
      planeExtent: 1,
      leverArm: 0,
      calibration: manual(),
    });
    expect(result.basis).toBe('scale-only');
    expect(result.sigmaScene).toBeCloseTo(0.04, 12);
  });

  it('marks borrowed pick quality as assumed', () => {
    expect(heightUncertainty({ ...base, assumed: true }).basis).toBe('assumed-spacing');
  });
});
