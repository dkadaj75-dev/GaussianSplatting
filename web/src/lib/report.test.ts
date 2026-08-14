import { describe, expect, it } from 'vitest';
import { buildReport, formatReportDate, renderReportPdf } from './report';
import { buildMeasurementRows } from './measurementRows';
import type { Calibration, Measurement, Point3 } from '../types';

const A: Point3 = [0, 0, 0];
const B: Point3 = [3, 4, 0];
const FLOOR: Point3[] = [
  [0, 0, 0],
  [2, 0, 0],
  [0, 0, 2],
];
/** Local time on purpose: the report prints what the user's phone says. */
const NOW = new Date(2026, 7, 14, 9, 5);

function manual(scale = 0.5): Calibration {
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
    unit: 'scene',
    label: 'M1',
    createdAt: '2026-08-14T10:00:00Z',
    ...overrides,
  };
}

const MEASUREMENTS = [
  measurement(),
  measurement({ id: 'm2', kind: 'polyline', label: 'M2', points: [A, B, [3, 4, 5]] }),
  measurement({ id: 'm3', kind: 'height', label: 'M3', points: [...FLOOR, [1, 2.5, 1]] }),
  measurement({
    id: 'm4',
    kind: 'angle',
    label: 'M4',
    unit: 'deg',
    points: [A, [1, 0, 0], [0, 1, 0]],
  }),
];

function rows(calibration: Calibration | null, withPicks = true) {
  return buildMeasurementRows(MEASUREMENTS, {
    calibration,
    sigmasById: withPicks
      ? new Map(MEASUREMENTS.map((row) => [row.id, row.points.map(() => 0.02)]))
      : new Map(),
  });
}

describe('formatReportDate', () => {
  it('is unambiguous in every locale, with no dependence on ICU data', () => {
    expect(formatReportDate(NOW)).toBe('14 Aug 2026, 09:05');
    expect(formatReportDate(new Date(2026, 11, 1, 23, 59))).toBe('1 Dec 2026, 23:59');
  });
});

describe('buildReport', () => {
  it('titles the report after the project and dates it', () => {
    const model = buildReport({ projectName: 'Balcony anchor detail', rows: [], calibration: null, now: NOW });
    expect(model.title).toBe('Balcony anchor detail');
    expect(model.subtitle).toBe('Measurement report · 14 Aug 2026, 09:05');
  });

  it('falls back to a name when the scene has no project', () => {
    expect(buildReport({ projectName: '  ', rows: [], calibration: null, now: NOW }).title).toBe(
      'SplatScene scene',
    );
  });

  it('states the calibration and the scale, or says they are relative', () => {
    const calibrated = buildReport({ rows: [], calibration: manual(), now: NOW });
    expect(calibrated.calibrationLine).toMatch(/known distance entered by hand, scale ±2 %/);
    expect(calibrated.scaleLine).toBe('1 scene unit = 50 cm');

    const uncalibrated = buildReport({ rows: [], calibration: null, now: NOW });
    expect(uncalibrated.calibrationLine).toMatch(/relative scene units/i);
    expect(uncalibrated.scaleLine).toBeNull();
  });

  it('turns every kind into a table row with a value and a ±', () => {
    const model = buildReport({ rows: rows(manual()), calibration: manual(), now: NOW });
    expect(model.rows).toEqual([
      {
        label: 'M1',
        kind: 'Distance',
        value: '2.50 m',
        uncertainty: '± 0.06 m',
        detail: 'Point to point',
        assumed: false,
      },
      {
        label: 'M2',
        kind: 'Path',
        value: '5.00 m',
        uncertainty: '± 0.11 m',
        detail: '2 segments',
        assumed: false,
      },
      {
        label: 'M3',
        kind: 'Height',
        value: '1.25 m',
        uncertainty: '± 0.03 m',
        detail: 'Above ground plane',
        assumed: false,
      },
      {
        label: 'M4',
        kind: 'Angle',
        // Degrees, untouched by the scale.
        value: '90°',
        uncertainty: '± 3°',
        detail: 'Arms 1 / 1 units',
        assumed: false,
      },
    ]);
  });

  it('keeps values relative and still reports the ± when the scene has no scale', () => {
    const model = buildReport({ rows: rows(null), calibration: null, now: NOW });
    expect(model.rows[0].value).toMatch(/units$/);
    expect(model.rows[0].uncertainty).toBe('± 0.03');
  });

  it('prints an em dash, not a fake tolerance, when the picks are unknown', () => {
    const model = buildReport({ rows: rows(manual(), false), calibration: manual(), now: NOW });
    expect(model.rows.map((row) => row.uncertainty)).toEqual(['—', '—', '—', '—']);
    expect(model.notes[0]).toMatch(/only the scene scale/i);
  });

  it('marks rows whose ± leaned on borrowed pick quality', () => {
    const borrowed = buildMeasurementRows(MEASUREMENTS, {
      calibration: manual(),
      assumedSigma: 0.02,
    });
    const model = buildReport({ rows: borrowed, calibration: manual(), now: NOW });
    expect(model.rows.every((row) => row.assumed)).toBe(true);
    expect(model.notes[0]).toMatch(/typical pick quality/i);
  });

  it('says so when there is nothing to report, and carries extra notes through', () => {
    const model = buildReport({
      rows: [],
      calibration: null,
      now: NOW,
      extraNotes: ['This scene was opened by URL.'],
    });
    expect(model.emptyNote).toMatch(/no measurements/i);
    expect(model.notes).toContain('This scene was opened by URL.');
  });

  it('labels a row that never got one', () => {
    const model = buildReport({
      rows: buildMeasurementRows([measurement({ label: null })], { calibration: null }),
      calibration: null,
      now: NOW,
    });
    expect(model.rows[0].label).toBe('Distance');
  });
});

describe('renderReportPdf', () => {
  function asText(bytes: Uint8Array): string {
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return text;
  }

  const model = buildReport({
    projectName: 'Balcony anchor detail',
    rows: rows(manual()),
    calibration: manual(),
    now: NOW,
  });

  it('prints the title, the date, the scale and every measurement', () => {
    const text = asText(renderReportPdf(model, { now: NOW }));
    expect(text).toContain('(Balcony anchor detail) Tj');
    expect(text).toContain('(Measurement report ');
    expect(text).toContain('(1 scene unit = 50 cm) Tj');
    for (const label of ['M1', 'M2', 'M3', 'M4']) expect(text).toContain(`(${label}) Tj`);
    expect(text).toContain('(2.50 m) Tj');
    expect(text).toContain('(Above ground plane) Tj');
    // The uncertainty column, ± as a single WinAnsi byte.
    expect(text).toContain(`(${String.fromCharCode(0xb1)} 0.06 m) Tj`);
  });

  it('is a valid single-page PDF with its cross-reference table intact', () => {
    const text = asText(renderReportPdf(model, { now: NOW }));
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text).toContain('/Count 1');
    const offsets = [...text.slice(text.lastIndexOf('\nxref\n')).matchAll(/^(\d{10}) \d{5} n $/gm)];
    offsets.forEach((entry, index) => {
      expect(text.slice(Number(entry[1]), Number(entry[1]) + 10)).toMatch(
        new RegExp(`^${index + 1} 0 obj`),
      );
    });
  });

  it('embeds a screenshot when one was captured', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const text = asText(
      renderReportPdf(model, { image: { jpeg, width: 800, height: 450 }, now: NOW }),
    );
    expect(text).toContain('/Filter /DCTDecode');
    expect(text).toContain('/Im0 Do');
  });

  it('drops the table to one page and says how many rows it cut', () => {
    const many = Array.from({ length: 200 }, (_, index) =>
      measurement({ id: `m${index}`, label: `M${index}` }),
    );
    const bigModel = buildReport({
      rows: buildMeasurementRows(many, { calibration: manual() }),
      calibration: manual(),
      now: NOW,
    });
    const text = asText(renderReportPdf(bigModel, { now: NOW }));
    expect(text).toMatch(/\(\+ \d+ more measurements in the app\.\) Tj/);
  });

  it('prints the empty note instead of an empty table', () => {
    const empty = buildReport({ rows: [], calibration: null, now: NOW });
    const text = asText(renderReportPdf(empty, { now: NOW }));
    expect(text).toContain('(No measurements were taken in this scene.) Tj');
    expect(text).not.toContain('(Uncertainty) Tj');
  });
});
