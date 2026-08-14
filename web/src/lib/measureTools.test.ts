import { describe, expect, it } from 'vitest';
import {
  MEASURE_TOOL_LIST,
  canFinishTool,
  cancelDraft,
  clearGroundPlane,
  finishTool,
  hasDraft,
  initialToolState,
  pickIntoTool,
  selectTool,
  toolPickCount,
  toolPrompt,
  undoPick,
} from './measureTools';
import type { ToolState } from './measureTools';
import type { Point3 } from '../types';

const A: Point3 = [0, 0, 0];
const B: Point3 = [3, 4, 0];
/** Three points on the y = 0 floor. */
const FLOOR: [Point3, Point3, Point3] = [
  [0, 0, 0],
  [2, 0, 0],
  [0, 0, 2],
];

/** Applies a sequence of taps, asserting nothing — the tests read the result. */
function tap(state: ToolState, points: readonly Point3[], sigma: number | null = 0.01) {
  let current = state;
  let completed = null as ReturnType<typeof pickIntoTool>['completed'];
  let notice: string | null = null;
  for (const point of points) {
    const transition = pickIntoTool(current, point, sigma);
    current = transition.state;
    if (transition.completed) completed = transition.completed;
    if (transition.notice) notice = transition.notice;
  }
  return { state: current, completed, notice };
}

describe('tool selection', () => {
  it('starts on distance, the tool from WP 3.2', () => {
    const state = initialToolState();
    expect(state.tool).toBe('distance');
    expect(state.definingPlane).toBe(false);
    expect(hasDraft(state)).toBe(false);
  });

  it('offers exactly the four tools the toolbar shows', () => {
    expect(MEASURE_TOOL_LIST.map((tool) => tool.id)).toEqual([
      'distance',
      'polyline',
      'height',
      'angle',
    ]);
    expect(toolPickCount('distance')).toBe(2);
    expect(toolPickCount('angle')).toBe(3);
    expect(toolPickCount('height')).toBe(1);
    // Open-ended: a path is finished by the user, not by a counter.
    expect(toolPickCount('polyline')).toBeNull();
  });

  it('drops a half-finished measurement when the tool changes', () => {
    const started = pickIntoTool(initialToolState(), A).state;
    expect(hasDraft(started)).toBe(true);
    expect(hasDraft(selectTool(started, 'angle'))).toBe(false);
  });

  it('asks for a ground plane the moment the height tool is picked', () => {
    const state = selectTool(initialToolState(), 'height');
    expect(state.definingPlane).toBe(true);
    expect(toolPrompt(state)).toMatch(/three points/i);
  });

  it('keeps the ground plane across a trip to another tool', () => {
    const withPlane = tap(selectTool(initialToolState(), 'height'), FLOOR).state;
    expect(withPlane.plane).not.toBeNull();
    const roundTrip = selectTool(selectTool(withPlane, 'distance'), 'height');
    expect(roundTrip.plane).toBe(withPlane.plane);
    expect(roundTrip.definingPlane).toBe(false);
  });

  it('ignores an unknown tool id rather than wedging the session', () => {
    const state = initialToolState();
    expect(selectTool(state, 'wobble' as never)).toBe(state);
  });
});

describe('distance tool', () => {
  it('completes on the second tap, in scene units', () => {
    const { completed } = tap(initialToolState(), [A, B]);
    expect(completed).toEqual({
      kind: 'distance',
      points: [A, B],
      value: 5,
      unit: 'scene',
      sigmas: [0.01, 0.01],
    });
  });

  it('rejects two taps on the same spot, keeping the first', () => {
    const first = pickIntoTool(initialToolState(), A);
    const second = pickIntoTool(first.state, A);
    expect(second.completed).toBeNull();
    expect(second.notice).toMatch(/same spot/i);
    expect(second.state.points).toEqual([A]);
  });

  it('prompts differently before and after the first tap', () => {
    expect(toolPrompt(initialToolState())).toMatch(/tap two points/i);
    expect(toolPrompt(pickIntoTool(initialToolState(), A).state)).toMatch(/second point/i);
  });
});

describe('path tool', () => {
  const path = selectTool(initialToolState(), 'polyline');

  it('collects points and only completes when finished', () => {
    const { state, completed } = tap(path, [A, B, [3, 4, 5]]);
    expect(completed).toBeNull();
    expect(state.points).toHaveLength(3);
    expect(canFinishTool(state)).toBe(true);

    const finish = finishTool(state);
    expect(finish.completed).toEqual({
      kind: 'polyline',
      points: [A, B, [3, 4, 5]],
      value: 10,
      unit: 'scene',
      sigmas: [0.01, 0.01, 0.01],
    });
    expect(finish.state.points).toEqual([]);
  });

  it('refuses to finish a path of one point', () => {
    const one = pickIntoTool(path, A).state;
    expect(canFinishTool(one)).toBe(false);
    const finish = finishTool(one);
    expect(finish.completed).toBeNull();
    expect(finish.notice).toMatch(/at least two points/i);
  });

  it('ignores a tap on the point just placed', () => {
    const twice = tap(path, [A, A]);
    expect(twice.state.points).toEqual([A]);
    expect(twice.notice).toMatch(/previous one/i);
  });

  it('counts the points it has in the prompt', () => {
    expect(toolPrompt(path)).toMatch(/double-tap or press finish/i);
    expect(toolPrompt(tap(path, [A, B]).state)).toMatch(/2 placed/);
  });

  it('does nothing when another tool is asked to finish', () => {
    const distance = initialToolState();
    expect(finishTool(distance)).toEqual({ state: distance, completed: null, notice: null });
  });
});

describe('height tool', () => {
  const height = selectTool(initialToolState(), 'height');

  it('takes three floor points, then measures one point against them', () => {
    const plane = tap(height, FLOOR);
    expect(plane.completed).toBeNull();
    expect(plane.state.definingPlane).toBe(false);
    expect(plane.notice).toMatch(/ground plane set/i);
    expect(toolPrompt(plane.state)).toMatch(/height above the ground plane/i);

    const measured = pickIntoTool(plane.state, [1, 2.5, 1], 0.02);
    expect(measured.completed).toEqual({
      kind: 'height',
      // The plane travels with the measurement so a reload can redraw it.
      points: [...FLOOR, [1, 2.5, 1]],
      value: 2.5,
      unit: 'scene',
      sigmas: [0.01, 0.01, 0.01, 0.02],
    });
  });

  it('rejects three collinear floor points and keeps the first two', () => {
    const collinear = tap(height, [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ]);
    expect(collinear.notice).toMatch(/in a line/i);
    expect(collinear.state.definingPlane).toBe(true);
    expect(collinear.state.planePoints).toHaveLength(2);

    // …and accepts a replacement third point without redoing the other two.
    const recovered = pickIntoTool(collinear.state, [0, 0, 2]);
    expect(recovered.state.plane).not.toBeNull();
  });

  it('asks for the plane again once it is cleared', () => {
    const withPlane = tap(height, FLOOR).state;
    const cleared = clearGroundPlane(withPlane);
    expect(cleared.plane).toBeNull();
    expect(cleared.definingPlane).toBe(true);
  });

  it('measures zero for a point on the plane rather than refusing', () => {
    const withPlane = tap(height, FLOOR).state;
    expect(pickIntoTool(withPlane, [1, 0, 1]).completed?.value).toBeCloseTo(0, 12);
  });
});

describe('angle tool', () => {
  const angle = selectTool(initialToolState(), 'angle');

  it('takes the corner first, then one point along each edge', () => {
    expect(toolPrompt(angle)).toMatch(/corner of the angle first/i);
    const vertex = pickIntoTool(angle, [0, 0, 0], 0.01);
    expect(toolPrompt(vertex.state)).toMatch(/first edge/i);
    const armA = pickIntoTool(vertex.state, [1, 0, 0], 0.01);
    expect(toolPrompt(armA.state)).toMatch(/other edge/i);

    const done = pickIntoTool(armA.state, [0, 1, 0], 0.02);
    expect(done.completed).toEqual({
      kind: 'angle',
      points: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      value: 90,
      // Degrees, not scene units: an angle does not care about the scale.
      unit: 'deg',
      sigmas: [0.01, 0.01, 0.02],
    });
  });

  it('rejects an edge point that landed on the corner', () => {
    const vertex = pickIntoTool(angle, [0, 0, 0]);
    const onCorner = pickIntoTool(vertex.state, [0, 0, 0]);
    expect(onCorner.completed).toBeNull();
    expect(onCorner.notice).toMatch(/on the corner/i);
    expect(onCorner.state.points).toHaveLength(1);

    const armA = pickIntoTool(vertex.state, [1, 0, 0]);
    const secondOnCorner = pickIntoTool(armA.state, [0, 0, 0]);
    expect(secondOnCorner.completed).toBeNull();
    expect(secondOnCorner.notice).toMatch(/on the corner/i);
    expect(secondOnCorner.state.points).toHaveLength(2);
  });
});

describe('undo and cancel', () => {
  it('takes back the last measurement point', () => {
    const two = tap(selectTool(initialToolState(), 'polyline'), [A, B]).state;
    const undone = undoPick(two);
    expect(undone.points).toEqual([A]);
    expect(undone.sigmas).toEqual([0.01]);
  });

  it('takes back the last ground-plane point', () => {
    const two = tap(selectTool(initialToolState(), 'height'), [FLOOR[0], FLOOR[1]]).state;
    expect(undoPick(two).planePoints).toEqual([FLOOR[0]]);
  });

  it('does nothing with nothing to undo', () => {
    const state = initialToolState();
    expect(undoPick(state)).toBe(state);
  });

  it('cancels the draft but never the ground plane', () => {
    const withPlane = tap(selectTool(initialToolState(), 'height'), FLOOR).state;
    const drafting = pickIntoTool(selectTool(withPlane, 'polyline'), A).state;
    const cancelled = cancelDraft(drafting);
    expect(cancelled.points).toEqual([]);
    expect(cancelled.plane).toBe(withPlane.plane);
  });
});

describe('picks with no measured quality', () => {
  it('records a null sigma rather than a zero, which would read as certainty', () => {
    const { completed } = tap(initialToolState(), [A, B], null);
    expect(completed?.sigmas).toEqual([null, null]);
  });
});
