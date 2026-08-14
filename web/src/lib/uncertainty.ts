/**
 * How much to trust a measurement (PLAN.md §4 "Accuracy display", §5, WP 5.2).
 *
 * A construction user needs to know whether "412 mm" means ±2 mm or ±20 mm.
 * Two things move that number:
 *
 * 1. **The scale** the scene was calibrated with. An ArUco solve reports the
 *    spread of its per-marker estimates (`residual`, a normalised median
 *    absolute deviation); a known-distance calibration reports nothing, so it
 *    carries a documented fixed term. This is a *relative* error: it scales
 *    every length in the scene by the same unknown factor.
 * 2. **Where the picked points actually are.** A tap snaps to the nearest
 *    Gaussian centre, so the point can be off by roughly half the local splat
 *    spacing, plus however far the winning splat sat from the tap ray. This is
 *    an *absolute* error: it dominates short measurements and is invisible on
 *    long ones.
 *
 * Both are estimates, and the whole point is to be honest about that:
 * {@link LengthUncertainty.basis} says which terms were actually available, so
 * the UI and the report can label a scale-only figure as such instead of
 * passing it off as the full story. Nothing here invents precision — the
 * unknown terms are reported missing, never assumed zero and never rounded
 * away.
 */

import type { Calibration } from '../types';

/** What a single pick tells us about its own accuracy (from `lib/picking`). */
export interface PickQuality {
  /** Perpendicular distance from the tap ray to the chosen splat centre, scene units. */
  rayDistance: number;
  /**
   * Local splat spacing at the pick — the median distance to the nearest few
   * neighbouring centres, in scene units. `null` when it could not be measured
   * (a cloud too small to have neighbours).
   */
  spacing: number | null;
}

/**
 * A known-distance calibration's assumed relative error: 2 %.
 *
 * PLAN.md §5 path 2 is a person picking the two ends of a tape measure, a
 * brick or a 1 m level and typing the length. Nothing about that is measured
 * by us, so the figure is a documented assumption rather than an observation.
 * It budgets roughly 1 % for the two picks landing on the nearest splat rather
 * than the true end of the reference (≈ 1 cm over a 1 m level) and roughly 1 %
 * for reading and typing the real length. Users who need better than 2 % on
 * the scale itself should print an ArUco target, which measures its own spread.
 */
export const KNOWN_DISTANCE_RELATIVE_SIGMA = 0.02;

/**
 * Floor under an ArUco residual: 0.5 %.
 *
 * The residual describes how well the per-marker estimates agreed with each
 * other, which says nothing about a bias they all share (a mis-measured print,
 * a marker not quite flat). Reporting ±0.05 % because two markers happened to
 * agree would be false precision.
 */
export const ARUCO_FLOOR_SIGMA = 0.005;

/**
 * Used when an ArUco calibration reports no residual, or only one sample.
 *
 * A single marker cannot disagree with anything, so its residual is either
 * absent or meaninglessly small; fall back to the same figure as a manual
 * calibration.
 */
export const ARUCO_SINGLE_SAMPLE_SIGMA = KNOWN_DISTANCE_RELATIVE_SIGMA;

/**
 * 1σ position uncertainty of one picked point, in scene units.
 *
 * Half the local splat spacing is the quantisation error of snapping to the
 * nearest Gaussian centre; the ray distance is how far that centre sat from
 * where the user actually aimed. They come from independent causes, so they
 * add in quadrature.
 */
export function pointSigma(quality: PickQuality): number | null {
  const ray = Number.isFinite(quality.rayDistance) ? Math.abs(quality.rayDistance) : null;
  const spacing =
    quality.spacing !== null && Number.isFinite(quality.spacing) && quality.spacing > 0
      ? quality.spacing
      : null;
  if (ray === null && spacing === null) return null;
  return Math.hypot((spacing ?? 0) / 2, ray ?? 0);
}

/** Relative 1σ of the scene's scale, or 0 when there is no scale to be wrong about. */
export function calibrationRelativeSigma(calibration: Calibration | null | undefined): number {
  if (!calibration || !Number.isFinite(calibration.scale)) return 0;
  if (calibration.method === 'aruco') {
    const samples = calibration.sampleCount ?? 0;
    const residual = calibration.residual;
    if (residual === null || residual === undefined || !Number.isFinite(residual) || samples < 2) {
      return ARUCO_SINGLE_SAMPLE_SIGMA;
    }
    return Math.max(Math.abs(residual), ARUCO_FLOOR_SIGMA);
  }
  return KNOWN_DISTANCE_RELATIVE_SIGMA;
}

/**
 * Which terms went into an estimate.
 *
 * - `full` — this measurement's own picks were measured.
 * - `assumed-spacing` — the picks were not (a measurement loaded from the API
 *   carries no pick metadata), so a typical pick quality from this session
 *   stood in.
 * - `scale-only` — nothing is known about the picks; only the calibration term
 *   is included, and the true error is larger.
 * - `none` — no scale and no picks: nothing can be said.
 */
export type UncertaintyBasis = 'full' | 'assumed-spacing' | 'scale-only' | 'none';

export interface LengthUncertainty {
  /** 1σ in scene units. */
  sigmaScene: number;
  /** `sigmaScene / value` — the same figure as a fraction, or `null` for a zero-length value. */
  relative: number | null;
  basis: UncertaintyBasis;
}

export interface LengthUncertaintyInput {
  /** The measured length, in scene units. */
  sceneValue: number;
  /**
   * 1σ of each picked point, scene units (see {@link pointSigma}). Empty or
   * omitted means the picks are unknown, which the basis reports.
   */
  pointSigmas?: readonly number[];
  /**
   * How many segments each point takes part in — 1 for the ends of a path, 2
   * for a vertex in the middle of one. A shared vertex moves both of its
   * segments, so its error counts twice.
   */
  weights?: readonly number[];
  calibration?: Calibration | null;
  /** True when `pointSigmas` are borrowed from other picks in the same scene. */
  assumed?: boolean;
}

function finiteSigmas(values: readonly number[] | undefined): number[] {
  return (values ?? []).filter((value) => Number.isFinite(value) && value >= 0);
}

/**
 * Uncertainty of a length (a distance or a path), in scene units.
 *
 * The picks contribute in quadrature — they are independent taps — and the
 * scale contributes proportionally. Point errors are treated as isotropic:
 * we do not know how a pick's error is oriented relative to what is being
 * measured, so the full magnitude is charged rather than a projection of it.
 * That is deliberately the pessimistic reading.
 */
export function lengthUncertainty(input: LengthUncertaintyInput): LengthUncertainty {
  const sigmas = finiteSigmas(input.pointSigmas);
  const relativeScale = calibrationRelativeSigma(input.calibration);
  const value = Number.isFinite(input.sceneValue) ? Math.abs(input.sceneValue) : 0;

  let geometricSq = 0;
  for (let i = 0; i < sigmas.length; i += 1) {
    const weight = input.weights?.[i];
    const w = weight !== undefined && Number.isFinite(weight) && weight > 0 ? weight : 1;
    geometricSq += (w * sigmas[i]) ** 2;
  }

  const scaleSigma = relativeScale * value;
  const sigmaScene = Math.sqrt(geometricSq + scaleSigma * scaleSigma);

  const basis: UncertaintyBasis =
    sigmas.length > 0
      ? input.assumed
        ? 'assumed-spacing'
        : 'full'
      : relativeScale > 0
        ? 'scale-only'
        : 'none';

  return {
    sigmaScene,
    relative: value > 0 ? sigmaScene / value : null,
    basis,
  };
}

/**
 * Weights for the points of a path: the ends move one segment, the vertices in
 * between move two.
 */
export function polylineWeights(pointCount: number): number[] {
  if (pointCount <= 0) return [];
  if (pointCount <= 2) return new Array<number>(pointCount).fill(1);
  return Array.from({ length: pointCount }, (_, index) =>
    index === 0 || index === pointCount - 1 ? 1 : 2,
  );
}

export interface AngleUncertaintyInput {
  /** Length of each arm from the vertex, scene units. */
  armLengthA: number;
  armLengthB: number;
  /** 1σ of the vertex pick and of each arm pick, scene units. */
  vertexSigma?: number | null;
  armSigmaA?: number | null;
  armSigmaB?: number | null;
}

/**
 * Uncertainty of an angle, in **degrees**.
 *
 * A point that is off by σ at the end of an arm of length L tilts that arm by
 * about σ/L radians; the vertex tilts both. Note what is missing: no
 * calibration term. Scaling a scene uniformly does not change any angle in it,
 * so an angle is exactly as trustworthy in an uncalibrated scene as in a
 * calibrated one.
 *
 * `null` when an arm has no length — there is no angle to be uncertain about.
 */
export function angleUncertaintyDegrees(input: AngleUncertaintyInput): number | null {
  const { armLengthA, armLengthB } = input;
  if (!(armLengthA > 0) || !(armLengthB > 0)) return null;

  const vertex = Math.abs(input.vertexSigma ?? 0);
  const a = Math.abs(input.armSigmaA ?? 0);
  const b = Math.abs(input.armSigmaB ?? 0);
  if (vertex === 0 && a === 0 && b === 0) return null;

  const radians = Math.sqrt(
    (a / armLengthA) ** 2 +
      (b / armLengthB) ** 2 +
      vertex * vertex * (1 / (armLengthA * armLengthA) + 1 / (armLengthB * armLengthB)),
  );
  return (radians * 180) / Math.PI;
}

export interface HeightUncertaintyInput {
  /** The height itself, scene units — only its magnitude matters. */
  height: number;
  /** 1σ of the measured point, scene units. */
  pointSigma?: number | null;
  /** 1σ of the picks that defined the ground plane, scene units. */
  planeSigmas?: readonly number[];
  /** Mean distance from the plane's centroid to its defining picks (`Plane.extent`). */
  planeExtent: number;
  /** In-plane distance from the plane's centroid to the measured point. */
  leverArm: number;
  calibration?: Calibration | null;
  /** True when the pick sigmas are borrowed from other picks in the same scene. */
  assumed?: boolean;
}

/**
 * Uncertainty of a height above a fitted plane, in scene units.
 *
 * Three things go wrong independently: the measured point's own position; the
 * plane sitting slightly too high or too low (the mean of its picks, so the
 * error shrinks as √n); and the plane being slightly tilted, which costs
 * nothing directly above the picks and more and more the further away the
 * measured point is. The last term is why {@link HeightUncertaintyInput.leverArm}
 * exists: a floor pinned down by three picks in one corner does not measure a
 * height in the far corner nearly as well as it looks like it does.
 */
export function heightUncertainty(input: HeightUncertaintyInput): LengthUncertainty {
  const planeSigmas = finiteSigmas(input.planeSigmas);
  const point = Math.abs(input.pointSigma ?? 0);
  const relativeScale = calibrationRelativeSigma(input.calibration);
  const height = Number.isFinite(input.height) ? Math.abs(input.height) : 0;

  const meanPlaneSigma =
    planeSigmas.length > 0
      ? planeSigmas.reduce((total, value) => total + value, 0) / planeSigmas.length
      : 0;
  const offsetSigma =
    planeSigmas.length > 0 ? meanPlaneSigma / Math.sqrt(planeSigmas.length) : 0;
  const tiltSigma =
    meanPlaneSigma > 0 && input.planeExtent > 0
      ? (meanPlaneSigma / input.planeExtent) * Math.max(input.leverArm, 0)
      : 0;

  const scaleSigma = relativeScale * height;
  const sigmaScene = Math.sqrt(
    point * point + offsetSigma * offsetSigma + tiltSigma * tiltSigma + scaleSigma * scaleSigma,
  );

  const known = point > 0 || planeSigmas.length > 0;
  const basis: UncertaintyBasis = known
    ? input.assumed
      ? 'assumed-spacing'
      : 'full'
    : relativeScale > 0
      ? 'scale-only'
      : 'none';

  return { sigmaScene, relative: height > 0 ? sigmaScene / height : null, basis };
}
