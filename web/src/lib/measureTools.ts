/**
 * The measure-mode tool state machine (PLAN.md §4, WP 5.2).
 *
 * One session, four tools. Each tool is just "how many taps, what do they
 * mean, and when is a measurement finished", so the whole thing is a pure
 * transition function over an immutable state: `pickIntoTool` takes a tap and
 * hands back the next state plus, when the tap completed something, the
 * measurement to persist. No React, no API, no renderer — the awkward parts
 * (a third plane point landing in line with the first two, an angle arm on top
 * of its own vertex, a path finished with one point) are all reachable from a
 * test.
 *
 * Pick order is fixed and prompted at every step. The angle tool takes its
 * **vertex first**: "tap the corner, then a point along each edge" is the one
 * phrasing that cannot be misread, and it means the half-finished state always
 * has an obvious next instruction.
 *
 * The ground plane lives in this state — i.e. in memory, for as long as the
 * viewer is open. Each *height measurement* however stores its own three plane
 * points (see `heightMeasurementInput`), so nothing that was measured is lost
 * on reload; only the convenience of not re-picking the floor is.
 */

import { angleAtVertexDegrees, distanceToPlane, fitPlane, polylineLength } from './geometry';
import type { Plane } from './geometry';
import { DEGREE_UNIT, SCENE_UNIT, distance3 } from './measurements';
import type { SupportedKind } from './measurements';
import type { Point3 } from '../types';

export const MEASURE_TOOLS = ['distance', 'polyline', 'height', 'angle'] as const;
export type MeasureToolId = (typeof MEASURE_TOOLS)[number];

export interface MeasureToolDescriptor {
  id: MeasureToolId;
  /** Toolbar label — short enough for a segmented control on a 320 px phone. */
  label: string;
  /** Spoken name for screen readers and the button's title. */
  description: string;
}

export const MEASURE_TOOL_LIST: readonly MeasureToolDescriptor[] = [
  { id: 'distance', label: 'Distance', description: 'Distance between two points' },
  { id: 'polyline', label: 'Path', description: 'Length of a path through several points' },
  { id: 'height', label: 'Height', description: 'Height above a ground plane' },
  { id: 'angle', label: 'Angle', description: 'Angle between two edges' },
];

/** The session's ground plane, with the picks it was fitted from. */
export interface GroundPlane {
  plane: Plane;
  points: [Point3, Point3, Point3];
  /** 1σ of each of those picks, scene units; `null` where unknown. */
  sigmas: (number | null)[];
}

export interface ToolState {
  tool: MeasureToolId;
  /** Picks collected toward the measurement in progress. */
  points: Point3[];
  /** 1σ of each pick above, scene units, parallel array. */
  sigmas: (number | null)[];
  /** The session ground plane, or `null` until three points define one. */
  plane: GroundPlane | null;
  /** True while taps go into a new ground plane rather than a measurement. */
  definingPlane: boolean;
  /** Picks collected toward that plane. */
  planePoints: Point3[];
  planeSigmas: (number | null)[];
}

/** Everything needed to persist a finished measurement, minus its label. */
export interface CompletedDraft {
  kind: SupportedKind;
  points: Point3[];
  /** Scene units, or degrees for an angle. */
  value: number;
  unit: string;
  /** 1σ of each pick in `points`, scene units. */
  sigmas: (number | null)[];
}

export interface ToolTransition {
  state: ToolState;
  /** Set when this tap finished a measurement. */
  completed: CompletedDraft | null;
  /** One-line feedback for the toolbar: a rejected pick always explains itself. */
  notice: string | null;
}

export function initialToolState(tool: MeasureToolId = 'distance'): ToolState {
  return {
    tool,
    points: [],
    sigmas: [],
    plane: null,
    definingPlane: tool === 'height',
    planePoints: [],
    planeSigmas: [],
  };
}

/** Drops the half-finished measurement, keeping the tool and the ground plane. */
export function cancelDraft(state: ToolState): ToolState {
  return {
    ...state,
    points: [],
    sigmas: [],
    definingPlane: state.tool === 'height' && state.plane === null,
    planePoints: [],
    planeSigmas: [],
  };
}

export function selectTool(state: ToolState, tool: MeasureToolId): ToolState {
  if (!MEASURE_TOOLS.includes(tool)) return state;
  return cancelDraft({ ...state, tool });
}

/** Forgets the ground plane; the height tool then asks for a new one. */
export function clearGroundPlane(state: ToolState): ToolState {
  return cancelDraft({ ...state, plane: null });
}

/** How many picks the tool needs in total, or `null` for the open-ended path. */
export function toolPickCount(tool: MeasureToolId): number | null {
  switch (tool) {
    case 'distance':
      return 2;
    case 'angle':
      return 3;
    case 'height':
      return 1;
    case 'polyline':
      return null;
  }
}

/** True when a tap has been placed that {@link undoPick} could take back. */
export function hasDraft(state: ToolState): boolean {
  return state.points.length > 0 || state.planePoints.length > 0;
}

/** True when the path tool has enough points for `finishTool` to succeed. */
export function canFinishTool(state: ToolState): boolean {
  return state.tool === 'polyline' && !state.definingPlane && state.points.length >= 2;
}

/** Takes back the last tap, whether it went into a measurement or the plane. */
export function undoPick(state: ToolState): ToolState {
  if (state.definingPlane && state.planePoints.length > 0) {
    return {
      ...state,
      planePoints: state.planePoints.slice(0, -1),
      planeSigmas: state.planeSigmas.slice(0, -1),
    };
  }
  if (state.points.length > 0) {
    return { ...state, points: state.points.slice(0, -1), sigmas: state.sigmas.slice(0, -1) };
  }
  return state;
}

/** Coach text for exactly where the user is. Never empty — a tool always asks for something. */
export function toolPrompt(state: ToolState): string {
  if (state.definingPlane) {
    const placed = state.planePoints.length;
    if (placed === 0) return 'Ground plane: tap three points spread across the floor (1 of 3).';
    return `Ground plane: tap point ${placed + 1} of 3 on the floor.`;
  }

  switch (state.tool) {
    case 'distance':
      return state.points.length === 0
        ? 'Tap two points to measure. Drag to orbit — only a tap places a point.'
        : 'Tap the second point.';
    case 'polyline':
      return state.points.length === 0
        ? 'Tap along the path. Double-tap or press Finish when it is complete.'
        : `Tap the next corner — ${state.points.length} placed. Finish when done.`;
    case 'height':
      return 'Tap the point whose height above the ground plane you want.';
    case 'angle':
      if (state.points.length === 0) return 'Tap the corner of the angle first.';
      if (state.points.length === 1) return 'Tap a point along the first edge.';
      return 'Tap a point along the other edge.';
  }
}

function completedDistance(state: ToolState, point: Point3, sigma: number | null): ToolTransition {
  const first = state.points[0];
  if (distance3(first, point) <= 0) {
    return {
      state,
      completed: null,
      notice: 'Both points landed on the same spot — try again further apart.',
    };
  }
  return {
    state: { ...state, points: [], sigmas: [] },
    completed: {
      kind: 'distance',
      points: [first, point],
      value: distance3(first, point),
      unit: SCENE_UNIT,
      sigmas: [state.sigmas[0] ?? null, sigma],
    },
    notice: null,
  };
}

function completedAngle(state: ToolState, point: Point3, sigma: number | null): ToolTransition {
  const [vertex, armA] = state.points;
  const degrees = angleAtVertexDegrees(vertex, armA, point);
  if (degrees === null) {
    return {
      state,
      completed: null,
      notice: 'That point is on the corner — tap along the edge, away from it.',
    };
  }
  return {
    state: { ...state, points: [], sigmas: [] },
    completed: {
      kind: 'angle',
      points: [vertex, armA, point],
      value: degrees,
      unit: DEGREE_UNIT,
      sigmas: [state.sigmas[0] ?? null, state.sigmas[1] ?? null, sigma],
    },
    notice: null,
  };
}

function completedHeight(
  state: ToolState,
  ground: GroundPlane,
  point: Point3,
  sigma: number | null,
): ToolTransition {
  return {
    state: { ...state, points: [], sigmas: [] },
    completed: {
      kind: 'height',
      points: [...ground.points, point],
      value: distanceToPlane(ground.plane, point),
      unit: SCENE_UNIT,
      sigmas: [...ground.sigmas.slice(0, 3), sigma],
    },
    notice: null,
  };
}

/**
 * Applies a tap.
 *
 * `sigma` is the 1σ position uncertainty of the pick in scene units (from
 * `lib/uncertainty::pointSigma`); pass `null` when it is unknown and the
 * measurement simply reports a weaker basis for its ±.
 */
export function pickIntoTool(
  state: ToolState,
  point: Point3,
  sigma: number | null = null,
): ToolTransition {
  // --- defining the ground plane ---------------------------------------------
  if (state.definingPlane) {
    const points = [...state.planePoints, point];
    const sigmas = [...state.planeSigmas, sigma];

    if (points.length < 3) {
      return { state: { ...state, planePoints: points, planeSigmas: sigmas }, completed: null, notice: null };
    }

    const plane = fitPlane(points);
    if (!plane) {
      // Keep the two good picks: the user only has to replace the bad third.
      return {
        state: { ...state, planePoints: points.slice(0, 2), planeSigmas: sigmas.slice(0, 2) },
        completed: null,
        notice: 'Those three points are in a line — spread them out across the floor.',
      };
    }

    return {
      state: {
        ...state,
        plane: { plane, points: [points[0], points[1], points[2]], sigmas },
        definingPlane: false,
        planePoints: [],
        planeSigmas: [],
      },
      completed: null,
      // Says out loud what the state machine's comment says: the plane lives
      // in this tab only, while every height keeps a copy of the plane it used.
      notice: 'Ground plane set — kept until you leave the viewer. Now tap a point to measure.',
    };
  }

  // --- a measurement ---------------------------------------------------------
  switch (state.tool) {
    case 'distance':
      if (state.points.length === 0) {
        return { state: { ...state, points: [point], sigmas: [sigma] }, completed: null, notice: null };
      }
      return completedDistance(state, point, sigma);

    case 'polyline': {
      const previous = state.points[state.points.length - 1];
      if (previous && distance3(previous, point) <= 0) {
        return {
          state,
          completed: null,
          notice: 'That point landed on the previous one — tap a little further along.',
        };
      }
      return {
        state: { ...state, points: [...state.points, point], sigmas: [...state.sigmas, sigma] },
        completed: null,
        notice: null,
      };
    }

    case 'height': {
      if (!state.plane) {
        // Can only happen if the plane was cleared mid-gesture; ask for it again.
        return {
          state: { ...state, definingPlane: true, planePoints: [point], planeSigmas: [sigma] },
          completed: null,
          notice: 'Set a ground plane first — tap three points on the floor.',
        };
      }
      return completedHeight(state, state.plane, point, sigma);
    }

    case 'angle':
      if (state.points.length < 2) {
        if (state.points.length === 1 && distance3(state.points[0], point) <= 0) {
          return {
            state,
            completed: null,
            notice: 'That point is on the corner — tap along the edge, away from it.',
          };
        }
        return {
          state: { ...state, points: [...state.points, point], sigmas: [...state.sigmas, sigma] },
          completed: null,
          notice: null,
        };
      }
      return completedAngle(state, point, sigma);
  }
}

/**
 * Closes an open path (the Finish button, or a double-tap).
 *
 * A path of one point is not a measurement; saying so beats silently saving a
 * zero-length row.
 */
export function finishTool(state: ToolState): ToolTransition {
  if (state.tool !== 'polyline' || state.definingPlane) {
    return { state, completed: null, notice: null };
  }
  if (state.points.length < 2) {
    return {
      state,
      completed: null,
      notice: 'A path needs at least two points.',
    };
  }
  return {
    state: { ...state, points: [], sigmas: [] },
    completed: {
      kind: 'polyline',
      points: [...state.points],
      value: polylineLength(state.points),
      unit: SCENE_UNIT,
      sigmas: [...state.sigmas],
    },
    notice: null,
  };
}
