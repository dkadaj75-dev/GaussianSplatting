import { describe, expect, it } from 'vitest';
import {
  DEGREE_UNIT,
  SCENE_UNIT,
  angleMeasurementInput,
  calibrationScale,
  distance3,
  distanceEndpoints,
  distanceMeasurementInput,
  formatAngleWithUncertainty,
  formatLengthWithUncertainty,
  formatMeasurement,
  formatMetres,
  formatRelative,
  formatSceneUnits,
  fromMetres,
  heightMeasurementInput,
  isLengthKind,
  isSupportedKind,
  measurementDetail,
  measurementGeometry,
  measurementMetres,
  measurementSceneValue,
  midpoint3,
  nextMeasurementLabel,
  polylineMeasurementInput,
  roundToUncertainty,
  toMetres,
} from './measurements';
import type { Calibration, Measurement, Point3 } from '../types';

const A: Point3 = [0, 0, 0];
const B: Point3 = [3, 4, 0];

/** Three points on the y = 0 floor. */
const FLOOR: [Point3, Point3, Point3] = [
  [0, 0, 0],
  [2, 0, 0],
  [0, 0, 2],
];

function calibration(scale: number): Calibration {
  return {
    scale,
    method: 'known_distance',
    reference: { pointA: A, pointB: B, realDistanceM: 5 * scale },
    calibratedAt: '2026-08-14T10:00:00Z',
  };
}

function measurement(overrides: Partial<Measurement> = {}): Measurement {
  return {
    id: 'm1',
    projectId: 'p1',
    kind: 'distance',
    points: [A, B],
    value: 5,
    unit: SCENE_UNIT,
    label: 'M1',
    createdAt: '2026-08-14T10:00:00Z',
    ...overrides,
  };
}

describe('geometry', () => {
  it('measures euclidean distance', () => {
    expect(distance3(A, B)).toBe(5);
    expect(distance3(A, A)).toBe(0);
  });

  it('finds the midpoint the label hangs from', () => {
    expect(midpoint3(A, B)).toEqual([1.5, 2, 0]);
  });
});

describe('unit conversion', () => {
  it('converts entered lengths to metres', () => {
    expect(toMetres(2.5, 'm')).toBe(2.5);
    expect(toMetres(250, 'cm')).toBeCloseTo(2.5, 12);
    expect(toMetres(2500, 'mm')).toBeCloseTo(2.5, 12);
  });

  it('round-trips back out of metres', () => {
    for (const unit of ['m', 'cm', 'mm'] as const) {
      expect(fromMetres(toMetres(7, unit), unit)).toBeCloseTo(7, 9);
    }
  });
});

describe('formatMetres', () => {
  it('uses millimetres below a centimetre', () => {
    expect(formatMetres(0.0084)).toBe('8.4 mm');
    expect(formatMetres(0.0005)).toBe('0.5 mm');
  });

  it('uses centimetres between a centimetre and a metre', () => {
    expect(formatMetres(0.01)).toBe('1 cm');
    expect(formatMetres(0.421)).toBe('42.1 cm');
    expect(formatMetres(0.999)).toBe('99.9 cm');
  });

  it('uses metres with three significant digits above a metre', () => {
    expect(formatMetres(1)).toBe('1 m');
    expect(formatMetres(1.2345)).toBe('1.23 m');
    expect(formatMetres(12.345)).toBe('12.3 m');
    expect(formatMetres(123.45)).toBe('123 m');
  });

  it('never renders NaN or Infinity at a user', () => {
    expect(formatMetres(Number.NaN)).toBe('—');
    expect(formatMetres(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatSceneUnits', () => {
  it('spells the unit out so a bare number is never read as metres', () => {
    expect(formatSceneUnits(1.23456)).toBe('1.23 units');
    expect(formatSceneUnits(0.004)).toBe('0.004 units');
    expect(formatSceneUnits(Number.NaN)).toBe('—');
  });
});

describe('formatMeasurement', () => {
  it('stays in relative units without a calibration', () => {
    expect(formatMeasurement(2, null)).toBe('2 units');
    expect(formatMeasurement(2, undefined)).toBe('2 units');
  });

  it('converts to metres with one', () => {
    // 1 scene unit = 0.5 m, so a 2-unit measurement is a metre.
    expect(formatMeasurement(2, calibration(0.5))).toBe('1 m');
    // …and a small one lands in centimetres.
    expect(formatMeasurement(0.4, calibration(0.5))).toBe('20 cm');
    // …and a tiny one in millimetres.
    expect(formatMeasurement(0.01, calibration(0.5))).toBe('5 mm');
  });

  it('ignores a corrupt scale rather than printing nonsense', () => {
    const broken = { ...calibration(1), scale: Number.NaN };
    expect(formatMeasurement(2, broken)).toBe('2 units');
    expect(measurementMetres(2, broken)).toBeNull();
  });
});

describe('calibrationScale', () => {
  it('is metres per scene unit', () => {
    // 5 scene units are known to be 2.5 m.
    expect(calibrationScale(A, B, 2.5)).toBeCloseTo(0.5, 12);
  });

  it('refuses degenerate input instead of returning Infinity', () => {
    expect(calibrationScale(A, A, 1)).toBeNull();
    expect(calibrationScale(A, B, 0)).toBeNull();
    expect(calibrationScale(A, B, -1)).toBeNull();
  });
});

describe('nextMeasurementLabel', () => {
  it('starts at M1', () => {
    expect(nextMeasurementLabel([])).toBe('M1');
  });

  it('continues past the highest number, not the count', () => {
    const rows = [
      measurement({ id: 'a', label: 'M1' }),
      measurement({ id: 'b', label: 'M3' }),
    ];
    expect(nextMeasurementLabel(rows)).toBe('M4');
  });

  it('ignores hand-written labels', () => {
    const rows = [
      measurement({ id: 'a', label: 'Ceiling height' }),
      measurement({ id: 'b', label: null }),
    ];
    expect(nextMeasurementLabel(rows)).toBe('M1');
  });
});

describe('distanceMeasurementInput', () => {
  it('maps to the API schema: scene units, both points, auto label', () => {
    expect(distanceMeasurementInput(A, B, 'M2')).toEqual({
      kind: 'distance',
      points: [A, B],
      value: 5,
      unit: 'scene',
      label: 'M2',
    });
  });

  it('persists the scene-unit magnitude, never the calibrated one', () => {
    // Calibration is presentation-only: re-calibrating must relabel, not rewrite.
    const input = distanceMeasurementInput(A, B, 'M1');
    expect(input.value).toBe(distance3(A, B));
    expect(input.unit).toBe(SCENE_UNIT);
  });
});

describe('reading stored measurements', () => {
  it('recovers both endpoints', () => {
    expect(distanceEndpoints(measurement())).toEqual([A, B]);
  });

  it('rejects a row that lost its geometry', () => {
    expect(distanceEndpoints(measurement({ points: [] }))).toBeNull();
    expect(distanceEndpoints(measurement({ points: [A] }))).toBeNull();
  });

  it('recomputes the magnitude from the points, distrusting a stale value', () => {
    expect(measurementSceneValue(measurement({ value: 999 }))).toBe(5);
  });

  it('falls back to the stored value when the points are unusable', () => {
    expect(measurementSceneValue(measurement({ points: [], value: 7 }))).toBe(7);
    expect(measurementSceneValue(measurement({ points: [], value: null }))).toBeNull();
  });
});

// --- WP 5.2: the other three tools ------------------------------------------

describe('kinds', () => {
  it('knows which kinds this client can draw', () => {
    expect(isSupportedKind('distance')).toBe(true);
    expect(isSupportedKind('polyline')).toBe(true);
    expect(isSupportedKind('height')).toBe(true);
    expect(isSupportedKind('angle')).toBe(true);
    expect(isSupportedKind('scale_reference')).toBe(false);
  });

  it('knows which magnitudes a scale applies to', () => {
    expect(isLengthKind('distance')).toBe(true);
    expect(isLengthKind('height')).toBe(true);
    // An angle is invariant under the scene's unknown scale.
    expect(isLengthKind('angle')).toBe(false);
  });
});

describe('measurementGeometry', () => {
  it('reads a path and recomputes its length', () => {
    const geometry = measurementGeometry(
      measurement({ kind: 'polyline', points: [A, B, [3, 4, 5]], value: 999 }),
    );
    expect(geometry).toMatchObject({ kind: 'polyline', value: 10, segments: 2 });
  });

  it('reads a height, its plane and where the drop line lands', () => {
    const geometry = measurementGeometry(
      measurement({ kind: 'height', points: [...FLOOR, [1, 2.5, 1]] }),
    );
    expect(geometry?.kind).toBe('height');
    if (geometry?.kind !== 'height') throw new Error('expected a height');
    expect(geometry.value).toBeCloseTo(2.5, 12);
    expect(geometry.foot[1]).toBeCloseTo(0, 12);
    expect(geometry.leverArm).toBeGreaterThan(0);
  });

  it('reads an angle from vertex-first points', () => {
    const geometry = measurementGeometry(
      measurement({ kind: 'angle', points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], unit: 'deg' }),
    );
    expect(geometry).toMatchObject({ kind: 'angle', value: 90 });
  });

  it('returns nothing for a row whose points do not match its kind', () => {
    expect(measurementGeometry(measurement({ kind: 'polyline', points: [A] }))).toBeNull();
    // A height needs its three plane points *and* the measured one.
    expect(measurementGeometry(measurement({ kind: 'height', points: [...FLOOR] }))).toBeNull();
    // …and a plane those three points cannot define.
    expect(
      measurementGeometry(
        measurement({ kind: 'height', points: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 1, 0]] }),
      ),
    ).toBeNull();
    expect(
      measurementGeometry(measurement({ kind: 'angle', points: [A, A, [0, 1, 0]] })),
    ).toBeNull();
    expect(measurementGeometry(measurement({ kind: 'area', points: [A, B] }))).toBeNull();
  });

  it('falls back to the stored value when the geometry is unreadable', () => {
    expect(measurementSceneValue(measurement({ kind: 'polyline', points: [A], value: 7 }))).toBe(7);
  });
});

describe('create payloads for the new tools', () => {
  it('persists a path as its vertices and total length, in scene units', () => {
    expect(polylineMeasurementInput([A, B, [3, 4, 5]], 'M2')).toEqual({
      kind: 'polyline',
      points: [A, B, [3, 4, 5]],
      value: 10,
      unit: SCENE_UNIT,
      label: 'M2',
    });
  });

  it('persists a height together with the plane it was taken against', () => {
    expect(heightMeasurementInput(FLOOR, [1, 2.5, 1], 'M3')).toEqual({
      kind: 'height',
      points: [...FLOOR, [1, 2.5, 1]],
      value: 2.5,
      unit: SCENE_UNIT,
      label: 'M3',
    });
  });

  it('refuses a height whose plane points are in a line', () => {
    expect(
      heightMeasurementInput([[0, 0, 0], [1, 0, 0], [2, 0, 0]], [0, 1, 0], 'M4'),
    ).toBeNull();
  });

  it('persists an angle in degrees, vertex first', () => {
    expect(angleMeasurementInput([0, 0, 0], [1, 0, 0], [0, 1, 0], 'M5')).toEqual({
      kind: 'angle',
      points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
      value: 90,
      unit: DEGREE_UNIT,
      label: 'M5',
    });
  });

  it('refuses an angle with no arm', () => {
    expect(angleMeasurementInput([0, 0, 0], [0, 0, 0], [0, 1, 0], 'M6')).toBeNull();
  });
});

describe('measurementDetail', () => {
  it('says what each row measured', () => {
    expect(measurementDetail(measurement())).toBe('Point to point');
    expect(measurementDetail(measurement({ kind: 'polyline', points: [A, B, [3, 4, 5]] }))).toBe(
      '2 segments',
    );
    expect(measurementDetail(measurement({ kind: 'polyline', points: [A, B] }))).toBe('1 segment');
    expect(measurementDetail(measurement({ kind: 'height', points: [...FLOOR, [0, 1, 0]] }))).toBe(
      'Above ground plane',
    );
    expect(
      measurementDetail(measurement({ kind: 'angle', points: [[0, 0, 0], [2, 0, 0], [0, 1, 0]] })),
    ).toMatch(/^Arms 2 \/ 1 units$/);
  });

  it('degrades to the kind for a row it cannot read', () => {
    expect(measurementDetail(measurement({ kind: 'polyline', points: [] }))).toBe('Path');
  });
});

// --- WP 5.2: uncertainty-aware display --------------------------------------

describe('roundToUncertainty', () => {
  it('keeps one significant digit of the uncertainty, two when it starts with 1', () => {
    expect(roundToUncertainty(412.3847, 6.2)).toEqual({ value: 412, sigma: 7, decimals: 0 });
    expect(roundToUncertainty(12.3456, 0.12)).toEqual({ value: 12.35, sigma: 0.12, decimals: 2 });
  });

  it('rounds the uncertainty up and the value to nearest', () => {
    // An error bar must never shrink in the rounding.
    expect(roundToUncertainty(100, 4.1)!.sigma).toBe(5);
    expect(roundToUncertainty(104, 10)!.value).toBe(104);
  });

  it('does not let float noise inflate a clean figure', () => {
    expect(roundToUncertainty(0.412, 0.006000000000000001)!.sigma).toBeCloseTo(0.006, 12);
  });

  it('has nothing to do without a positive uncertainty', () => {
    expect(roundToUncertainty(1, 0)).toBeNull();
    expect(roundToUncertainty(1, Number.NaN)).toBeNull();
    expect(roundToUncertainty(Number.NaN, 1)).toBeNull();
  });
});

describe('formatRelative', () => {
  it('is a percentage with meaningful digits only', () => {
    expect(formatRelative(0.018)).toBe('±1.8 %');
    expect(formatRelative(0.02)).toBe('±2 %');
    expect(formatRelative(0.005)).toBe('±0.5 %');
    expect(formatRelative(0.5)).toBe('±50 %');
  });

  it('says nothing when there is nothing to say', () => {
    expect(formatRelative(null)).toBeNull();
    expect(formatRelative(0)).toBeNull();
    expect(formatRelative(Number.NaN)).toBeNull();
  });
});

describe('formatLengthWithUncertainty', () => {
  it('reads like a site note: 412 mm ± 6 mm', () => {
    // 0.824 scene units at 0.5 m/unit = 412 mm, ±6 mm.
    expect(formatLengthWithUncertainty(0.824, 0.012, calibration(0.5))).toEqual({
      value: '412 mm',
      uncertainty: '± 6 mm',
      relative: '±1.5 %',
    });
  });

  it('stays in metres above a metre, however fine the tolerance', () => {
    // Nobody writes 1200 cm.
    expect(formatLengthWithUncertainty(24, 0.4, calibration(0.5)).value).toBe('12.0 m');
    expect(formatLengthWithUncertainty(24, 0.4, calibration(0.5)).uncertainty).toBe('± 0.2 m');
  });

  it('shows only the digits the uncertainty supports', () => {
    expect(formatLengthWithUncertainty(5, 0.1, calibration(0.5))).toEqual({
      value: '2.50 m',
      uncertainty: '± 0.05 m',
      relative: '±2 %',
    });
  });

  it('keeps relative units relative, with a unitless ±', () => {
    // ±0.10, not ±0.1: an uncertainty starting with a 1 keeps two digits, and
    // the value follows it to the same decimal place.
    expect(formatLengthWithUncertainty(5, 0.1, null)).toEqual({
      value: '5.00 units',
      uncertainty: '± 0.10',
      relative: '±2 %',
    });
  });

  it('omits the ± entirely when nothing is known about it', () => {
    expect(formatLengthWithUncertainty(5, null, calibration(0.5))).toEqual({
      value: '2.5 m',
      uncertainty: null,
      relative: null,
    });
    expect(formatLengthWithUncertainty(5, null, null).value).toBe('5 units');
  });

  it('never renders NaN at a user', () => {
    expect(formatLengthWithUncertainty(Number.NaN, 1, calibration(0.5)).value).toBe('—');
  });
});

describe('formatAngleWithUncertainty', () => {
  it('shows degrees with a matching tolerance', () => {
    expect(formatAngleWithUncertainty(92.37, 0.8)).toEqual({
      value: '92.4°',
      uncertainty: '± 0.8°',
      relative: null,
    });
  });

  it('falls back to one decimal without an uncertainty', () => {
    expect(formatAngleWithUncertainty(90, null).value).toBe('90°');
    expect(formatAngleWithUncertainty(92.37, null).value).toBe('92.4°');
    expect(formatAngleWithUncertainty(Number.NaN, null).value).toBe('—');
  });
});
