import { describe, expect, it } from 'vitest';
import {
  buildMeasurementRow,
  buildMeasurementRows,
  calibrationSummary,
  measurementUncertainty,
  uncertaintyNotes,
} from './measurementRows';
import { measurementGeometry } from './measurements';
import type { Calibration, Measurement, Point3 } from '../types';

const A: Point3 = [0, 0, 0];
const B: Point3 = [3, 4, 0];
const FLOOR: Point3[] = [
  [0, 0, 0],
  [2, 0, 0],
  [0, 0, 2],
];

function manual(scale = 0.5): Calibration {
  return {
    scale,
    method: 'known_distance',
    reference: { pointA: A, pointB: B, realDistanceM: 5 * scale },
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

function measurement(overrides: Partial<Measurement> = {}): Measurement {
  return {
    id: 'm1',
    projectId: 'p1',
    kind: 'distance',
    points: [A, B],
    value: 5,
    unit: 'scene',
    label: 'M1',
    createdAt: '2026-08-14T10:00:00Z',
    ...overrides,
  };
}

describe('measurementUncertainty', () => {
  const geometry = (row: Measurement) => measurementGeometry(row);

  it('weights a path so its shared vertices count twice', () => {
    const row = measurement({ kind: 'polyline', points: [A, B, [3, 4, 5]] });
    const result = measurementUncertainty(geometry(row), [0.1, 0.1, 0.1], false, null);
    expect(result?.sigmaScene).toBeCloseTo(Math.hypot(0.1, 0.2, 0.1), 12);
  });

  it('charges a height for its plane as well as its point', () => {
    const row = measurement({ kind: 'height', points: [...FLOOR, [1, 2.5, 1]] });
    const result = measurementUncertainty(geometry(row), [0.02, 0.02, 0.02, 0.02], false, null);
    // Bigger than the point alone: the plane can be offset and tilted too.
    expect(result!.sigmaScene).toBeGreaterThan(0.02);
    expect(result!.basis).toBe('full');
  });

  it('reports an angle in degrees and never applies the scale to it', () => {
    const row = measurement({ kind: 'angle', points: [A, [1, 0, 0], [0, 1, 0]], unit: 'deg' });
    const withScale = measurementUncertainty(geometry(row), [0.01, 0.01, 0.01], false, manual());
    const without = measurementUncertainty(geometry(row), [0.01, 0.01, 0.01], false, null);
    expect(withScale?.sigmaScene).toBeCloseTo(without!.sigmaScene, 12);
    expect(withScale!.sigmaScene).toBeCloseTo(
      (Math.sqrt(0.01 ** 2 + 0.01 ** 2 + 0.01 ** 2 * 2) * 180) / Math.PI,
      9,
    );
  });

  it('says nothing about an angle whose picks were never measured', () => {
    const row = measurement({ kind: 'angle', points: [A, [1, 0, 0], [0, 1, 0]], unit: 'deg' });
    expect(measurementUncertainty(geometry(row), null, false, manual())).toEqual({
      sigmaScene: 0,
      relative: null,
      basis: 'none',
    });
  });

  it('discards a partial set of pick sigmas rather than mixing knowns with blanks', () => {
    const result = measurementUncertainty(geometry(measurement()), [0.02, null], false, manual());
    expect(result?.basis).toBe('scale-only');
  });

  it('has nothing to say about geometry it could not read', () => {
    expect(measurementUncertainty(null, [0.01], false, manual())).toBeNull();
  });
});

describe('buildMeasurementRow', () => {
  it('shows a ± when the picks were measured', () => {
    const row = buildMeasurementRow(measurement(), [0.02, 0.02], false, manual());
    expect(row.formatted.uncertainty).not.toBeNull();
    expect(row.formatted.value).toMatch(/m$/);
    expect(row.uncertainty?.basis).toBe('full');
    expect(row.kindLabel).toBe('Distance');
    expect(row.detail).toBe('Point to point');
  });

  it('shows no ± when only the scale is known — that figure would be an underestimate', () => {
    const row = buildMeasurementRow(measurement(), null, false, manual());
    expect(row.uncertainty?.basis).toBe('scale-only');
    expect(row.formatted.uncertainty).toBeNull();
    // …and the value keeps the plain formatting it had before WP 5.2.
    expect(row.formatted.value).toBe('2.5 m');
  });

  it('keeps an uncalibrated row in relative units', () => {
    const row = buildMeasurementRow(measurement(), [0.05, 0.05], false, null);
    expect(row.formatted.value).toMatch(/units$/);
    // Two 0.05 picks in quadrature is 0.0707, rounded up to one digit.
    expect(row.formatted.uncertainty).toBe('± 0.08');
  });

  it('falls back to the stored value for a row it cannot read', () => {
    const row = buildMeasurementRow(measurement({ points: [], value: 7 }), null, false, null);
    expect(row.geometry).toBeNull();
    expect(row.sceneValue).toBe(7);
    expect(row.formatted.value).toBe('7 units');
  });

  it('reports "—" for a row with neither geometry nor value', () => {
    const row = buildMeasurementRow(measurement({ points: [], value: null }), null, false, null);
    expect(row.formatted.value).toBe('—');
  });
});

describe('buildMeasurementRows', () => {
  const rows = [measurement({ id: 'own' }), measurement({ id: 'stored' })];

  it('prefers a measurement’s own picks over the scene average', () => {
    const built = buildMeasurementRows(rows, {
      calibration: manual(),
      sigmasById: new Map([['own', [0.01, 0.01]]]),
      assumedSigma: 0.5,
    });
    expect(built[0].uncertainty?.basis).toBe('full');
    expect(built[1].uncertainty?.basis).toBe('assumed-spacing');
    // The borrowed figure is the bigger one, and says so.
    expect(built[1].uncertainty!.sigmaScene).toBeGreaterThan(built[0].uncertainty!.sigmaScene);
  });

  it('leaves rows scale-only when no pick in the session has been measured', () => {
    const built = buildMeasurementRows(rows, { calibration: manual(), assumedSigma: null });
    expect(built.every((row) => row.uncertainty?.basis === 'scale-only')).toBe(true);
  });
});

describe('uncertaintyNotes', () => {
  it('explains each weaker basis once, in the order it is met', () => {
    const built = buildMeasurementRows([measurement({ id: 'a' }), measurement({ id: 'b' })], {
      calibration: manual(),
      sigmasById: new Map([['b', [0.01, 0.01]]]),
    });
    const notes = uncertaintyNotes(built);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/only the scene scale/i);
  });

  it('says nothing when every row carries a full estimate', () => {
    const built = buildMeasurementRows([measurement()], {
      calibration: manual(),
      sigmasById: new Map([['m1', [0.01, 0.01]]]),
    });
    expect(uncertaintyNotes(built)).toEqual([]);
  });
});

describe('calibrationSummary', () => {
  it('is explicit that an uncalibrated scene is relative', () => {
    expect(calibrationSummary(null)).toMatch(/uncalibrated — every value below is in relative/i);
  });

  it('names the marker and the spread for an automatic scale', () => {
    expect(calibrationSummary(aruco())).toBe(
      'Calibrated automatically from a 150 mm marker (12 observations), scale ±1.8 %.',
    );
  });

  it('flags the manual figure as an assumption', () => {
    expect(calibrationSummary(manual())).toBe(
      'Calibrated from a known distance entered by hand, scale ±2 % (assumed).',
    );
  });

  it('copes with an ArUco calibration that reported no marker size', () => {
    expect(calibrationSummary(aruco({ markerLengthM: null, sampleCount: 1 }))).toMatch(
      /printed marker \(1 observation\), scale ±2 %/,
    );
  });
});
