/**
 * One measurement, resolved for display (WP 5.2/5.3).
 *
 * The in-scene chip, the measurements list and the exported report must never
 * disagree about a number, so all three read the same rows built here: the
 * geometry recovered from the stored points, the magnitude recomputed from it,
 * the uncertainty derived from the calibration and the pick quality, and the
 * strings that come out of those.
 */

import {
  MEASUREMENT_KIND_LABEL,
  formatMeasurementValue,
  measurementDetail,
  measurementGeometry,
} from './measurements';
import type { FormattedValue, MeasurementGeometry } from './measurements';
import { length3, subtract3 } from './geometry';
import {
  angleUncertaintyDegrees,
  calibrationRelativeSigma,
  heightUncertainty,
  lengthUncertainty,
  polylineWeights,
} from './uncertainty';
import type { LengthUncertainty, UncertaintyBasis } from './uncertainty';
import type { Calibration, Measurement } from '../types';

export interface MeasurementRow {
  measurement: Measurement;
  /** `null` when the stored points do not describe the kind they claim. */
  geometry: MeasurementGeometry | null;
  /** Scene units, or degrees for an angle. */
  sceneValue: number | null;
  /** 1σ in the same unit as `sceneValue`, plus what it was derived from. */
  uncertainty: LengthUncertainty | null;
  formatted: FormattedValue;
  /** `Distance`, `Path`, `Height`, `Angle`. */
  kindLabel: string;
  /** `3 segments`, `Above ground plane`, … */
  detail: string;
}

/** How the ± should be read, or `null` when there is nothing to qualify. */
export const UNCERTAINTY_BASIS_NOTE: Record<UncertaintyBasis, string | null> = {
  full: null,
  'assumed-spacing':
    'Rows marked ~ were picked before this session: their ± uses a typical pick quality measured in this scene, not the original picks.',
  'scale-only':
    'Rows without a ± were picked before this session and no pick quality was recorded for them; only the scene scale below is known.',
  none: null,
};

/**
 * Uncertainty for one measurement, dispatched by kind.
 *
 * `sigmas` are the 1σ position uncertainties of the picks, in scene units and
 * parallel to `measurement.points`; pass `null` when they are unknown.
 * `assumed` marks sigmas that came from other picks in the same scene rather
 * than from this measurement's own.
 */
export function measurementUncertainty(
  geometry: MeasurementGeometry | null,
  sigmas: readonly (number | null)[] | null,
  assumed: boolean,
  calibration: Calibration | null | undefined,
): LengthUncertainty | null {
  if (!geometry) return null;
  const known = (sigmas ?? []).map((value) =>
    value !== null && Number.isFinite(value) && value >= 0 ? value : null,
  );
  const usable = known.every((value) => value !== null) ? (known as number[]) : null;

  switch (geometry.kind) {
    case 'distance':
      return lengthUncertainty({
        sceneValue: geometry.value,
        pointSigmas: usable ?? undefined,
        calibration,
        assumed,
      });

    case 'polyline':
      return lengthUncertainty({
        sceneValue: geometry.value,
        pointSigmas: usable ?? undefined,
        weights: polylineWeights(geometry.points.length),
        calibration,
        assumed,
      });

    case 'height':
      return heightUncertainty({
        height: geometry.value,
        pointSigma: usable?.[3] ?? null,
        planeSigmas: usable ? usable.slice(0, 3) : [],
        planeExtent: geometry.plane.extent,
        leverArm: geometry.leverArm,
        calibration,
        assumed,
      });

    case 'angle': {
      const armLengthA = length3(subtract3(geometry.armA, geometry.vertex));
      const armLengthB = length3(subtract3(geometry.armB, geometry.vertex));
      const degrees = angleUncertaintyDegrees({
        armLengthA,
        armLengthB,
        vertexSigma: usable?.[0] ?? null,
        armSigmaA: usable?.[1] ?? null,
        armSigmaB: usable?.[2] ?? null,
      });
      if (degrees === null) {
        // An angle carries no scale error at all, so with no pick quality
        // there is genuinely nothing to report — better than a fake ±.
        return { sigmaScene: 0, relative: null, basis: 'none' };
      }
      return {
        sigmaScene: degrees,
        relative: geometry.value > 0 ? degrees / geometry.value : null,
        basis: assumed ? 'assumed-spacing' : 'full',
      };
    }
  }
}

/**
 * Whether a ± should be printed at all.
 *
 * Only when every term is in it. A `scale-only` figure knows about the
 * calibration and nothing about the picks, so printing "2.50 m ± 5 cm" would
 * claim a tolerance the estimate cannot back — precisely the false precision
 * PLAN.md §4 exists to avoid. Those rows show the plain value, and the scale's
 * own tolerance is stated once for the whole scene (see
 * {@link calibrationSummary}) where it belongs.
 */
function showsUncertainty(uncertainty: LengthUncertainty | null): boolean {
  if (!uncertainty || !(uncertainty.sigmaScene > 0)) return false;
  return uncertainty.basis === 'full' || uncertainty.basis === 'assumed-spacing';
}

export function buildMeasurementRow(
  measurement: Measurement,
  sigmas: readonly (number | null)[] | null,
  assumed: boolean,
  calibration: Calibration | null | undefined,
): MeasurementRow {
  const geometry = measurementGeometry(measurement);
  const sceneValue = geometry ? geometry.value : (measurement.value ?? null);
  const uncertainty = measurementUncertainty(geometry, sigmas, assumed, calibration);

  const sigma = uncertainty && showsUncertainty(uncertainty) ? uncertainty.sigmaScene : null;
  const formatted =
    sceneValue === null
      ? { value: '—', uncertainty: null, relative: null }
      : formatMeasurementValue(measurement, sceneValue, sigma, calibration);

  return {
    measurement,
    geometry,
    sceneValue,
    uncertainty,
    formatted,
    kindLabel: MEASUREMENT_KIND_LABEL[measurement.kind],
    detail: measurementDetail(measurement),
  };
}

export interface RowBuildOptions {
  calibration: Calibration | null | undefined;
  /** Pick sigmas recorded for a measurement taken in this session, by id. */
  sigmasById?: ReadonlyMap<string, readonly (number | null)[]>;
  /**
   * Typical pick sigma for this scene, used for rows whose own picks were not
   * observed (anything loaded from the API). Flagged as assumed so the report
   * can say so.
   */
  assumedSigma?: number | null;
}

export function buildMeasurementRows(
  measurements: readonly Measurement[],
  options: RowBuildOptions,
): MeasurementRow[] {
  return measurements.map((measurement) => {
    const own = options.sigmasById?.get(measurement.id);
    if (own) return buildMeasurementRow(measurement, own, false, options.calibration);
    const assumed = options.assumedSigma;
    if (assumed !== null && assumed !== undefined && Number.isFinite(assumed) && assumed > 0) {
      return buildMeasurementRow(
        measurement,
        measurement.points.map(() => assumed),
        true,
        options.calibration,
      );
    }
    return buildMeasurementRow(measurement, null, false, options.calibration);
  });
}

/** Distinct footnotes for a set of rows, in the order the reader meets them. */
export function uncertaintyNotes(rows: readonly MeasurementRow[]): string[] {
  const notes: string[] = [];
  for (const row of rows) {
    const note = row.uncertainty ? UNCERTAINTY_BASIS_NOTE[row.uncertainty.basis] : null;
    if (note && !notes.includes(note)) notes.push(note);
  }
  return notes;
}

/** One line describing where the scene's scale came from (PLAN.md §5). */
export function calibrationSummary(calibration: Calibration | null | undefined): string {
  if (!calibration) return 'Uncalibrated — every value below is in relative scene units.';
  const relative = calibrationRelativeSigma(calibration);
  const percent = `±${Number((relative * 100).toPrecision(2))} %`;
  if (calibration.method === 'aruco') {
    const samples = calibration.sampleCount ?? 0;
    const marker = calibration.markerLengthM
      ? `${Number((calibration.markerLengthM * 1000).toPrecision(4))} mm marker`
      : 'printed marker';
    return `Calibrated automatically from a ${marker} (${samples} observation${
      samples === 1 ? '' : 's'
    }), scale ${percent}.`;
  }
  return `Calibrated from a known distance entered by hand, scale ${percent} (assumed).`;
}
