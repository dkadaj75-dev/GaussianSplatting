/**
 * Measurement maths, formatting and API mapping (PLAN.md §4/§5, WP 3.2 + 5.2).
 *
 * Measurements are stored in **scene units** — the arbitrary scale SfM hands
 * back. Converting to metres is a presentation concern that depends on the
 * project's calibration, so it happens here at render time rather than being
 * baked into the stored value. That way re-calibrating a project instantly
 * re-labels every measurement ever taken in it, and a wrong calibration is
 * never destructive.
 *
 * The same rule extends to the WP 5.2 tools: a path stores its vertices, a
 * height stores the three points of its ground plane *plus* the measured
 * point, and an angle stores its vertex and two arms. Every magnitude is
 * recomputed from the geometry on read, so a row written by an older client is
 * still correct and a re-calibration still costs nothing.
 */

import {
  angleAtVertexDegrees,
  distanceToPlane,
  fitPlane,
  length3,
  planeLeverArm,
  polylineLength,
  polylineSegmentCount,
  projectOntoPlane,
  subtract3,
} from './geometry';
import type { Plane } from './geometry';
import type {
  Calibration,
  Measurement,
  MeasurementInput,
  MeasurementKind,
  Point3,
} from '../types';

/** `unit` we persist distances under; the magnitude is in SfM scene units. */
export const SCENE_UNIT = 'scene';

/**
 * `unit` for angles.
 *
 * The one measurement that is not a length: an angle is invariant under the
 * scene's unknown scale, so storing it in degrees loses nothing and saves
 * every reader from multiplying it by a calibration it must not apply.
 */
export const DEGREE_UNIT = 'deg';

/** Kinds this client can draw and label; other rows are ignored, not deleted. */
export const SUPPORTED_KINDS = ['distance', 'polyline', 'height', 'angle'] as const;
export type SupportedKind = (typeof SUPPORTED_KINDS)[number];

export function isSupportedKind(kind: MeasurementKind): kind is SupportedKind {
  return (SUPPORTED_KINDS as readonly MeasurementKind[]).includes(kind);
}

/** Kinds whose magnitude is a length in scene units (so a scale applies). */
export function isLengthKind(kind: MeasurementKind): boolean {
  return kind === 'distance' || kind === 'polyline' || kind === 'height' || kind === 'area';
}

export const MEASUREMENT_KIND_LABEL: Record<MeasurementKind, string> = {
  distance: 'Distance',
  polyline: 'Path',
  height: 'Height',
  angle: 'Angle',
  area: 'Area',
  scale_reference: 'Reference',
};

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

// --- Kind-aware geometry (WP 5.2) -------------------------------------------

/**
 * A stored measurement's geometry, resolved into something drawable.
 *
 * Discriminated on `kind` so the overlay and the report can render every tool
 * without re-deriving which point means what. `null` for a row whose points do
 * not survive validation — a hand-written row, or one from a future client.
 */
export type MeasurementGeometry =
  | { kind: 'distance'; a: Point3; b: Point3; value: number }
  | { kind: 'polyline'; points: Point3[]; value: number; segments: number }
  | {
      kind: 'height';
      planePoints: Point3[];
      plane: Plane;
      point: Point3;
      /** The measured point dropped onto the plane — the foot of the height line. */
      foot: Point3;
      value: number;
      leverArm: number;
    }
  | { kind: 'angle'; vertex: Point3; armA: Point3; armB: Point3; value: number };

/** Points of a measurement, filtered to well-formed triples. */
function validPoints(measurement: Measurement): Point3[] {
  return measurement.points.filter(isPoint3);
}

export function measurementGeometry(measurement: Measurement): MeasurementGeometry | null {
  const points = validPoints(measurement);

  switch (measurement.kind) {
    case 'distance': {
      if (points.length < 2) return null;
      const [a, b] = points;
      return { kind: 'distance', a, b, value: distance3(a, b) };
    }
    case 'polyline': {
      if (points.length < 2) return null;
      return {
        kind: 'polyline',
        points,
        value: polylineLength(points),
        segments: polylineSegmentCount(points),
      };
    }
    case 'height': {
      // [p1, p2, p3, target]: the ground plane travels with the measurement so
      // a reloaded scene can redraw and recheck it without a session plane.
      if (points.length < 4) return null;
      const planePoints = points.slice(0, 3);
      const plane = fitPlane(planePoints);
      if (!plane) return null;
      const point = points[3];
      return {
        kind: 'height',
        planePoints,
        plane,
        point,
        foot: projectOntoPlane(plane, point),
        value: distanceToPlane(plane, point),
        leverArm: planeLeverArm(plane, point),
      };
    }
    case 'angle': {
      // [vertex, armA, armB] — the corner first, matching the pick order the
      // prompt asks for.
      if (points.length < 3) return null;
      const [vertex, armA, armB] = points;
      const degrees = angleAtVertexDegrees(vertex, armA, armB);
      if (degrees === null) return null;
      return { kind: 'angle', vertex, armA, armB, value: degrees };
    }
    default:
      return null;
  }
}

/**
 * Scene-unit magnitude to display for a stored measurement (degrees for an
 * angle).
 *
 * Prefers recomputing from the points: a row written by an older client (or by
 * hand) may carry a stale `value`, and the geometry is the source of truth.
 */
export function measurementSceneValue(measurement: Measurement): number | null {
  const geometry = measurementGeometry(measurement);
  if (geometry) return geometry.value;
  return measurement.value ?? null;
}

// --- Create payloads (WP 5.2) -----------------------------------------------

/** A path of N vertices; `value` is the total length in scene units. */
export function polylineMeasurementInput(
  points: readonly Point3[],
  label: string,
): MeasurementInput & { value: number } {
  return {
    kind: 'polyline',
    points: [...points],
    value: polylineLength(points),
    unit: SCENE_UNIT,
    label,
  };
}

/**
 * A height above a ground plane.
 *
 * The three plane points are stored ahead of the measured one so the row is
 * self-contained: the session's ground plane lives only in memory, but a
 * height measurement keeps the plane it was taken against forever.
 */
export function heightMeasurementInput(
  planePoints: readonly [Point3, Point3, Point3],
  point: Point3,
  label: string,
): (MeasurementInput & { value: number }) | null {
  const plane = fitPlane(planePoints);
  if (!plane) return null;
  return {
    kind: 'height',
    points: [...planePoints, point],
    value: distanceToPlane(plane, point),
    unit: SCENE_UNIT,
    label,
  };
}

/** An angle at `vertex`; `value` is in degrees, `unit` is {@link DEGREE_UNIT}. */
export function angleMeasurementInput(
  vertex: Point3,
  armA: Point3,
  armB: Point3,
  label: string,
): (MeasurementInput & { value: number }) | null {
  const degrees = angleAtVertexDegrees(vertex, armA, armB);
  if (degrees === null) return null;
  return {
    kind: 'angle',
    points: [vertex, armA, armB],
    value: degrees,
    unit: DEGREE_UNIT,
    label,
  };
}

// --- Uncertainty-aware display (WP 5.2) --------------------------------------

/** A magnitude and its uncertainty, split so the UI can style them apart. */
export interface FormattedValue {
  /** e.g. `412 mm`, `2.50 m`, `5 units`, `92.4°`. */
  value: string;
  /** e.g. `± 6 mm`, or `null` when no uncertainty could be estimated. */
  uncertainty: string | null;
  /** The same figure as a fraction of the value, e.g. `±1.5 %`. */
  relative: string | null;
}

export interface RoundedPair {
  value: number;
  sigma: number;
  /** Decimal places both should be printed with. */
  decimals: number;
}

/**
 * Rounds a value and its uncertainty to the digits that actually mean
 * something.
 *
 * The uncertainty keeps one significant digit — two when it starts with a 1,
 * where one digit would throw away a third of the information — and the value
 * is rounded to that same decimal place. Printing "412.3847 mm ± 6 mm" would
 * claim four digits the measurement does not have.
 *
 * The uncertainty rounds **up** and the value to nearest: an error bar should
 * never shrink in the rounding.
 */
export function roundToUncertainty(value: number, sigma: number): RoundedPair | null {
  if (!Number.isFinite(value) || !Number.isFinite(sigma) || !(sigma > 0)) return null;

  const exponent = Math.floor(Math.log10(sigma));
  const lead = sigma / 10 ** exponent;
  const significantDigits = lead < 2 ? 2 : 1;
  const step = 10 ** (exponent - significantDigits + 1);
  const decimals = Math.max(0, significantDigits - 1 - exponent);

  // `toFixed` at the end sweeps up the float dust: 12 × 0.01 is not 0.12, and
  // a stray 0.12000000000000002 in an error bar looks like a bug to the reader.
  const clean = (raw: number) => Number(raw.toFixed(decimals));

  return {
    // The epsilon absorbs the noise that turns 6 into 6.000000000000001 and
    // would otherwise round a clean ±6 up to ±7.
    sigma: clean(Math.ceil(sigma / step - 1e-9) * step),
    value: clean(Math.round(value / step) * step),
    decimals,
  };
}

/** `±1.8 %`, with the same "one digit, two if it starts with 1" rule. */
export function formatRelative(relative: number | null | undefined): string | null {
  if (relative === null || relative === undefined || !Number.isFinite(relative) || relative <= 0) {
    return null;
  }
  const percent = relative * 100;
  const exponent = Math.floor(Math.log10(percent));
  const lead = percent / 10 ** exponent;
  return `±${Number(percent.toPrecision(lead < 2 ? 2 : 1))} %`;
}

interface LengthUnitStep {
  suffix: string;
  /** How many of this unit make a metre. */
  perMetre: number;
}

const METRE: LengthUnitStep = { suffix: 'm', perMetre: 1 };
const CENTIMETRE: LengthUnitStep = { suffix: 'cm', perMetre: 100 };
const MILLIMETRE: LengthUnitStep = { suffix: 'mm', perMetre: 1000 };

/**
 * The unit a length and its uncertainty are both readable in.
 *
 * Starts from the ladder {@link formatMetres} already uses, then steps a
 * sub-metre length down to millimetres when the uncertainty would otherwise
 * print as "0.6 cm" — "412 mm ± 6 mm" is what a site engineer writes down.
 * Metre-scale lengths stay in metres: nobody calls 12 m "1200 cm", however
 * fine the tolerance.
 */
function unitFor(metres: number, sigmaMetres: number | null): LengthUnitStep {
  const magnitude = Math.abs(metres);
  if (magnitude < 0.01) return MILLIMETRE;
  if (magnitude >= 1) return METRE;
  if (sigmaMetres !== null && sigmaMetres > 0 && sigmaMetres * CENTIMETRE.perMetre < 1) {
    return MILLIMETRE;
  }
  return CENTIMETRE;
}

function withDecimals(value: number, decimals: number): string {
  // `-0` is a real possibility once a tiny negative rounds to zero.
  const fixed = (value === 0 ? 0 : value).toFixed(decimals);
  return fixed === '-0' ? '0' : fixed;
}

/**
 * A length with its uncertainty, in metres if the scene has a scale and in
 * scene units if it does not.
 *
 * `sigmaScene` is in scene units like the value; pass `null` when nothing is
 * known about the uncertainty, and the ± is simply omitted rather than
 * guessed at.
 */
export function formatLengthWithUncertainty(
  sceneValue: number,
  sigmaScene: number | null,
  calibration: Calibration | null | undefined,
): FormattedValue {
  if (!Number.isFinite(sceneValue)) return { value: '—', uncertainty: null, relative: null };

  const relative =
    sigmaScene !== null && sigmaScene > 0 && Math.abs(sceneValue) > 0
      ? formatRelative(sigmaScene / Math.abs(sceneValue))
      : null;

  const metres = measurementMetres(sceneValue, calibration);
  if (metres === null) {
    // Uncalibrated: relative units, and the ± carries no unit of its own
    // because "units" is already spelled out on the value.
    const rounded = sigmaScene === null ? null : roundToUncertainty(sceneValue, sigmaScene);
    if (!rounded) return { value: formatSceneUnits(sceneValue), uncertainty: null, relative };
    return {
      value: `${withDecimals(rounded.value, rounded.decimals)} units`,
      uncertainty: `± ${withDecimals(rounded.sigma, rounded.decimals)}`,
      relative,
    };
  }

  const scale = calibration?.scale ?? 1;
  const sigmaMetres = sigmaScene === null ? null : Math.abs(sigmaScene * scale);
  const unit = unitFor(metres, sigmaMetres);
  const value = metres * unit.perMetre;

  const rounded =
    sigmaMetres === null ? null : roundToUncertainty(value, sigmaMetres * unit.perMetre);
  if (!rounded) return { value: formatMetres(metres), uncertainty: null, relative };

  return {
    value: `${withDecimals(rounded.value, rounded.decimals)} ${unit.suffix}`,
    uncertainty: `± ${withDecimals(rounded.sigma, rounded.decimals)} ${unit.suffix}`,
    relative,
  };
}

/** An angle in degrees; no calibration is involved — see `lib/uncertainty`. */
export function formatAngleWithUncertainty(
  degrees: number,
  sigmaDegrees: number | null,
): FormattedValue {
  if (!Number.isFinite(degrees)) return { value: '—', uncertainty: null, relative: null };
  const rounded = sigmaDegrees === null ? null : roundToUncertainty(degrees, sigmaDegrees);
  if (!rounded) {
    return { value: `${Number(degrees.toFixed(1))}°`, uncertainty: null, relative: null };
  }
  return {
    value: `${withDecimals(rounded.value, rounded.decimals)}°`,
    uncertainty: `± ${withDecimals(rounded.sigma, rounded.decimals)}°`,
    relative: null,
  };
}

/** Formats any supported measurement, choosing degrees or a length by kind. */
export function formatMeasurementValue(
  measurement: Measurement,
  sceneValue: number,
  sigma: number | null,
  calibration: Calibration | null | undefined,
): FormattedValue {
  return measurement.kind === 'angle'
    ? formatAngleWithUncertainty(sceneValue, sigma)
    : formatLengthWithUncertainty(sceneValue, sigma, calibration);
}

/** One-line description of what a row measured, for the list and the report. */
export function measurementDetail(measurement: Measurement): string {
  const geometry = measurementGeometry(measurement);
  if (!geometry) return MEASUREMENT_KIND_LABEL[measurement.kind];
  switch (geometry.kind) {
    case 'distance':
      return 'Point to point';
    case 'polyline':
      return `${geometry.segments} segment${geometry.segments === 1 ? '' : 's'}`;
    case 'height':
      return 'Above ground plane';
    case 'angle':
      return `Arms ${significant(length3(subtract3(geometry.armA, geometry.vertex)))} / ${significant(
        length3(subtract3(geometry.armB, geometry.vertex)),
      )} units`;
  }
}
