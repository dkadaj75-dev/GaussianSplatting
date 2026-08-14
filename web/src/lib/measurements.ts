/**
 * Measurement maths, formatting and API mapping (PLAN.md §4/§5, WP 3.2).
 *
 * Measurements are stored in **scene units** — the arbitrary scale SfM hands
 * back. Converting to metres is a presentation concern that depends on the
 * project's calibration, so it happens here at render time rather than being
 * baked into the stored value. That way re-calibrating a project instantly
 * re-labels every measurement ever taken in it, and a wrong calibration is
 * never destructive.
 */

import type { Calibration, Measurement, MeasurementInput, Point3 } from '../types';

/** `unit` we persist distances under; the magnitude is in SfM scene units. */
export const SCENE_UNIT = 'scene';

export const LENGTH_UNITS = ['m', 'cm', 'mm'] as const;
export type LengthUnit = (typeof LENGTH_UNITS)[number];

const UNIT_IN_METRES: Record<LengthUnit, number> = { m: 1, cm: 0.01, mm: 0.001 };

/** Converts a user-entered length to metres. */
export function toMetres(value: number, unit: LengthUnit): number {
  return value * UNIT_IN_METRES[unit];
}

/** Converts metres back into `unit` (for pre-filling the calibration sheet). */
export function fromMetres(metres: number, unit: LengthUnit): number {
  return metres / UNIT_IN_METRES[unit];
}

export function distance3(a: Point3, b: Point3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function midpoint3(a: Point3, b: Point3): Point3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

/** `1.23`, not `1.23000000001` — trailing zeros dropped. */
function significant(value: number, digits = 3): string {
  return String(Number(value.toPrecision(digits)));
}

function rounded(value: number, decimals = 1): string {
  return String(Number(value.toFixed(decimals)));
}

/**
 * Real-world length, picking the unit a person would say out loud.
 *
 * Below a centimetre nobody writes "0.008 m", and above a metre nobody writes
 * "123.4 cm". Three significant digits is the honest ceiling: a known-distance
 * calibration off by a millimetre over a metre already costs 0.1 %.
 */
export function formatMetres(metres: number): string {
  if (!Number.isFinite(metres)) return '—';
  const magnitude = Math.abs(metres);
  if (magnitude < 0.01) return `${rounded(metres * 1000)} mm`;
  if (magnitude < 1) return `${rounded(metres * 100)} cm`;
  return `${significant(metres)} m`;
}

/** Uncalibrated length. Spelled out because "1.23" alone reads as metres. */
export function formatSceneUnits(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${significant(value)} units`;
}

/** Metres for a scene-unit magnitude, or `null` when the project has no scale. */
export function measurementMetres(
  sceneValue: number,
  calibration: Calibration | null | undefined,
): number | null {
  if (!calibration || !Number.isFinite(calibration.scale)) return null;
  return sceneValue * calibration.scale;
}

/** The label shown on the in-scene chip and in the measurements list. */
export function formatMeasurement(
  sceneValue: number,
  calibration: Calibration | null | undefined,
): string {
  const metres = measurementMetres(sceneValue, calibration);
  return metres === null ? formatSceneUnits(sceneValue) : formatMetres(metres);
}

/** Scale a known-distance pair implies: metres per scene unit. */
export function calibrationScale(a: Point3, b: Point3, realDistanceM: number): number | null {
  const sceneDistance = distance3(a, b);
  if (!(sceneDistance > 0) || !(realDistanceM > 0)) return null;
  return realDistanceM / sceneDistance;
}

const AUTO_LABEL = /^M(\d+)$/;

/**
 * Next free auto label (`M1`, `M2`, …).
 *
 * Takes the highest existing number rather than the count, so deleting `M2`
 * out of `M1 M2 M3` doesn't mint a duplicate `M3`.
 */
export function nextMeasurementLabel(existing: readonly Measurement[]): string {
  let highest = 0;
  for (const measurement of existing) {
    const match = AUTO_LABEL.exec(measurement.label ?? '');
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `M${highest + 1}`;
}

/**
 * Builds the create payload for a finished two-point distance.
 *
 * `value` is the scene-unit length and `unit` is {@link SCENE_UNIT}; the API
 * stores both verbatim (`api/app/schemas.py::MeasurementCreate`).
 */
export function distanceMeasurementInput(
  a: Point3,
  b: Point3,
  label: string,
): MeasurementInput & { value: number } {
  return {
    kind: 'distance',
    points: [a, b],
    value: distance3(a, b),
    unit: SCENE_UNIT,
    label,
  };
}

/** The two endpoints of a distance measurement, or `null` if it is malformed. */
export function distanceEndpoints(measurement: Measurement): [Point3, Point3] | null {
  const [a, b] = measurement.points;
  if (!isPoint3(a) || !isPoint3(b)) return null;
  return [a, b];
}

export function isPoint3(value: unknown): value is Point3 {
  return (
    Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

/**
 * Scene-unit magnitude to display for a stored measurement.
 *
 * Prefers recomputing from the points: a row written by an older client (or by
 * hand) may carry a stale `value`, and the geometry is the source of truth.
 */
export function measurementSceneValue(measurement: Measurement): number | null {
  const endpoints = distanceEndpoints(measurement);
  if (endpoints) return distance3(endpoints[0], endpoints[1]);
  return measurement.value ?? null;
}
