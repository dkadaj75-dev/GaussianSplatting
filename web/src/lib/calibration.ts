/**
 * The known-distance calibration flow (PLAN.md §5 path 2, WP 3.3).
 *
 * Modelled as a reducer rather than a pile of `useState` calls because the
 * flow spans two taps in a WebGL canvas *and* a bottom sheet, and because the
 * failure case matters: when the PUT is rejected the user must get their typed
 * value back, not an empty form and two lost picks.
 */

import { LENGTH_UNITS, calibrationScale, distance3 } from './measurements';
import type { LengthUnit } from './measurements';
import type { Point3 } from '../types';

export type CalibrationStage =
  /** Not calibrating. */
  | 'idle'
  /** Waiting for the first end of the known distance. */
  | 'pick-a'
  /** Waiting for the second end. */
  | 'pick-b'
  /** Both ends picked; the sheet is asking for the real length. */
  | 'entry'
  /** PUT in flight. */
  | 'saving';

export interface CalibrationState {
  stage: CalibrationStage;
  pointA: Point3 | null;
  pointB: Point3 | null;
  /** Raw sheet input, kept as text so "1." and "0.0" behave while typing. */
  distance: string;
  unit: LengthUnit;
  error: string | null;
}

export type CalibrationAction =
  | { type: 'start' }
  | { type: 'cancel' }
  | { type: 'pick'; point: Point3 }
  | { type: 'undo' }
  | { type: 'set-distance'; value: string }
  | { type: 'set-unit'; unit: LengthUnit }
  | { type: 'submit' }
  | { type: 'succeeded' }
  | { type: 'failed'; message: string };

export const initialCalibrationState: CalibrationState = {
  stage: 'idle',
  pointA: null,
  pointB: null,
  distance: '',
  unit: 'm',
  error: null,
};

/** Coach text for the current stage; `null` when the flow shows no prompt. */
export function calibrationPrompt(stage: CalibrationStage): string | null {
  switch (stage) {
    case 'pick-a':
      return 'Tap the first end of a known distance — a tape measure, a brick, a 1 m level.';
    case 'pick-b':
      return 'Tap the second end of that distance.';
    default:
      return null;
  }
}

/** True while the flow wants taps in the canvas routed to it. */
export function isCalibrationPicking(stage: CalibrationStage): boolean {
  return stage === 'pick-a' || stage === 'pick-b';
}

export type ParsedDistance = { ok: true; metres: number } | { ok: false; error: string };

/** Validates the sheet input. Rejects junk, zero and negatives with a reason. */
export function parseRealDistance(text: string, unit: LengthUnit): ParsedDistance {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed.length === 0) return { ok: false, error: 'Enter the real-world distance.' };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { ok: false, error: 'That is not a number.' };
  if (value <= 0) return { ok: false, error: 'The distance must be greater than zero.' };
  const metres = value * { m: 1, cm: 0.01, mm: 0.001 }[unit];
  if (!(metres > 0)) return { ok: false, error: 'The distance must be greater than zero.' };
  return { ok: true, metres };
}

/**
 * Everything the PUT needs, or `null` when the state is not submittable.
 * Also guards the degenerate case of both ends landing on the same splat,
 * which would divide by zero on the server.
 */
export function calibrationRequest(
  state: CalibrationState,
): { pointA: Point3; pointB: Point3; realDistanceM: number } | null {
  if (state.stage !== 'entry' && state.stage !== 'saving') return null;
  const { pointA, pointB } = state;
  if (!pointA || !pointB) return null;
  const parsed = parseRealDistance(state.distance, state.unit);
  if (!parsed.ok) return null;
  if (calibrationScale(pointA, pointB, parsed.metres) === null) return null;
  return { pointA, pointB, realDistanceM: parsed.metres };
}

/** Why the submit button is disabled, or `null` when it is not. */
export function calibrationBlocker(state: CalibrationState): string | null {
  const { pointA, pointB } = state;
  if (!pointA || !pointB) return 'Pick both ends first.';
  if (distance3(pointA, pointB) <= 0) return 'The two points are identical — pick them further apart.';
  const parsed = parseRealDistance(state.distance, state.unit);
  return parsed.ok ? null : parsed.error;
}

export function calibrationReducer(
  state: CalibrationState,
  action: CalibrationAction,
): CalibrationState {
  switch (action.type) {
    case 'start':
      return { ...initialCalibrationState, unit: state.unit, stage: 'pick-a' };

    case 'cancel':
      return { ...initialCalibrationState, unit: state.unit };

    case 'pick':
      if (state.stage === 'pick-a') {
        return { ...state, stage: 'pick-b', pointA: action.point, pointB: null, error: null };
      }
      if (state.stage === 'pick-b') {
        return { ...state, stage: 'entry', pointB: action.point, error: null };
      }
      return state;

    case 'undo':
      // Step back one tap; from the sheet this reopens the second pick.
      if (state.stage === 'entry') return { ...state, stage: 'pick-b', pointB: null, error: null };
      if (state.stage === 'pick-b') return { ...state, stage: 'pick-a', pointA: null, error: null };
      return state;

    case 'set-distance':
      // Clearing the error on edit keeps a stale server message from sticking
      // to a value the user has already corrected.
      return state.stage === 'saving' ? state : { ...state, distance: action.value, error: null };

    case 'set-unit':
      if (state.stage === 'saving') return state;
      return LENGTH_UNITS.includes(action.unit)
        ? { ...state, unit: action.unit, error: null }
        : state;

    case 'submit': {
      if (state.stage !== 'entry') return state;
      const blocker = calibrationBlocker(state);
      if (blocker) return { ...state, error: blocker };
      return { ...state, stage: 'saving', error: null };
    }

    case 'succeeded':
      return { ...initialCalibrationState, unit: state.unit };

    case 'failed':
      // Back to 'entry', not 'idle': the picks and the typed value survive so
      // the user can retry without redoing the two taps.
      return { ...state, stage: 'entry', error: action.message };

    default:
      return state;
  }
}
