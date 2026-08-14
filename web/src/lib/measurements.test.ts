import { describe, expect, it } from 'vitest';
import {
  SCENE_UNIT,
  calibrationScale,
  distance3,
  distanceEndpoints,
  distanceMeasurementInput,
  formatMeasurement,
  formatMetres,
  formatSceneUnits,
  fromMetres,
  measurementMetres,
  measurementSceneValue,
  midpoint3,
  nextMeasurementLabel,
  toMetres,
} from './measurements';
import type { Calibration, Measurement, Point3 } from '../types';

const A: Point3 = [0, 0, 0];
const B: Point3 = [3, 4, 0];

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
