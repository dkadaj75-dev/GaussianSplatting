import { describe, expect, it } from 'vitest';
import {
  calibrationBlocker,
  calibrationPrompt,
  calibrationReducer,
  calibrationRequest,
  initialCalibrationState,
  isCalibrationPicking,
  parseRealDistance,
} from './calibration';
import type { CalibrationAction, CalibrationState } from './calibration';
import type { Point3 } from '../types';

const A: Point3 = [0, 0, 0];
const B: Point3 = [3, 4, 0];

/** Replays a script of actions from the initial state. */
function run(...actions: CalibrationAction[]): CalibrationState {
  return actions.reduce(calibrationReducer, initialCalibrationState);
}

describe('parseRealDistance', () => {
  it('accepts a plain number in the chosen unit', () => {
    expect(parseRealDistance('1.5', 'm')).toEqual({ ok: true, metres: 1.5 });
    expect(parseRealDistance('150', 'cm')).toEqual({ ok: true, metres: 1.5 });
    expect(parseRealDistance('1500', 'mm')).toEqual({ ok: true, metres: 1.5 });
  });

  it('accepts a comma decimal separator', () => {
    expect(parseRealDistance('1,5', 'm')).toEqual({ ok: true, metres: 1.5 });
  });

  it('explains why it refused, rather than failing silently', () => {
    expect(parseRealDistance('', 'm')).toEqual({
      ok: false,
      error: 'Enter the real-world distance.',
    });
    expect(parseRealDistance('one metre', 'm')).toEqual({ ok: false, error: 'That is not a number.' });
    expect(parseRealDistance('0', 'm').ok).toBe(false);
    expect(parseRealDistance('-2', 'm').ok).toBe(false);
  });
});

describe('calibration flow', () => {
  it('starts idle and picks nothing', () => {
    expect(initialCalibrationState.stage).toBe('idle');
    expect(isCalibrationPicking('idle')).toBe(false);
    expect(calibrationPrompt('idle')).toBeNull();
  });

  it('walks pick A → pick B → entry', () => {
    const afterStart = run({ type: 'start' });
    expect(afterStart.stage).toBe('pick-a');
    expect(isCalibrationPicking(afterStart.stage)).toBe(true);
    expect(calibrationPrompt(afterStart.stage)).toMatch(/first end/i);

    const afterA = calibrationReducer(afterStart, { type: 'pick', point: A });
    expect(afterA.stage).toBe('pick-b');
    expect(afterA.pointA).toEqual(A);
    expect(calibrationPrompt(afterA.stage)).toMatch(/second end/i);

    const afterB = calibrationReducer(afterA, { type: 'pick', point: B });
    expect(afterB.stage).toBe('entry');
    expect(afterB.pointB).toEqual(B);
    // The sheet is up, so taps stop being routed into the canvas.
    expect(isCalibrationPicking(afterB.stage)).toBe(false);
  });

  it('ignores picks outside the picking stages', () => {
    const idle = calibrationReducer(initialCalibrationState, { type: 'pick', point: A });
    expect(idle).toBe(initialCalibrationState);
  });

  it('submits once a valid distance is typed', () => {
    const state = run(
      { type: 'start' },
      { type: 'pick', point: A },
      { type: 'pick', point: B },
      { type: 'set-unit', unit: 'cm' },
      { type: 'set-distance', value: '250' },
    );

    expect(calibrationBlocker(state)).toBeNull();
    expect(calibrationRequest(state)).toEqual({
      pointA: A,
      pointB: B,
      realDistanceM: 2.5,
    });

    const saving = calibrationReducer(state, { type: 'submit' });
    expect(saving.stage).toBe('saving');
    expect(saving.error).toBeNull();
  });

  it('refuses to submit an unparseable distance and says why', () => {
    const state = run(
      { type: 'start' },
      { type: 'pick', point: A },
      { type: 'pick', point: B },
      { type: 'set-distance', value: 'about a metre' },
    );

    expect(calibrationBlocker(state)).toBe('That is not a number.');
    expect(calibrationRequest(state)).toBeNull();

    const rejected = calibrationReducer(state, { type: 'submit' });
    expect(rejected.stage).toBe('entry');
    expect(rejected.error).toBe('That is not a number.');
  });

  it('refuses two picks that landed on the same splat', () => {
    const state = run(
      { type: 'start' },
      { type: 'pick', point: A },
      { type: 'pick', point: A },
      { type: 'set-distance', value: '1' },
    );

    expect(calibrationBlocker(state)).toMatch(/identical/i);
    expect(calibrationRequest(state)).toBeNull();
  });

  it('keeps the picks and the typed value when the API rejects the save', () => {
    const saving = run(
      { type: 'start' },
      { type: 'pick', point: A },
      { type: 'pick', point: B },
      { type: 'set-distance', value: '2.5' },
      { type: 'submit' },
    );

    const failed = calibrationReducer(saving, { type: 'failed', message: '503 Service Unavailable' });

    expect(failed.stage).toBe('entry');
    expect(failed.error).toBe('503 Service Unavailable');
    expect(failed.pointA).toEqual(A);
    expect(failed.pointB).toEqual(B);
    expect(failed.distance).toBe('2.5');
    // …and a retry is immediately possible.
    expect(calibrationRequest(failed)).not.toBeNull();
  });

  it('clears the error as soon as the user edits the value', () => {
    const failed = run(
      { type: 'start' },
      { type: 'pick', point: A },
      { type: 'pick', point: B },
      { type: 'set-distance', value: 'x' },
      { type: 'submit' },
    );
    expect(failed.error).not.toBeNull();

    expect(calibrationReducer(failed, { type: 'set-distance', value: '1' }).error).toBeNull();
  });

  it('locks the form while the request is in flight', () => {
    const saving = run(
      { type: 'start' },
      { type: 'pick', point: A },
      { type: 'pick', point: B },
      { type: 'set-distance', value: '1' },
      { type: 'submit' },
    );

    expect(calibrationReducer(saving, { type: 'set-distance', value: '9' })).toBe(saving);
    expect(calibrationReducer(saving, { type: 'set-unit', unit: 'mm' })).toBe(saving);
  });

  it('steps back one pick at a time with undo', () => {
    const entry = run({ type: 'start' }, { type: 'pick', point: A }, { type: 'pick', point: B });

    const backToB = calibrationReducer(entry, { type: 'undo' });
    expect(backToB.stage).toBe('pick-b');
    expect(backToB.pointB).toBeNull();
    expect(backToB.pointA).toEqual(A);

    const backToA = calibrationReducer(backToB, { type: 'undo' });
    expect(backToA.stage).toBe('pick-a');
    expect(backToA.pointA).toBeNull();
  });

  it('resets on success and on cancel, but remembers the unit choice', () => {
    const state = run(
      { type: 'start' },
      { type: 'pick', point: A },
      { type: 'pick', point: B },
      { type: 'set-unit', unit: 'mm' },
      { type: 'set-distance', value: '1200' },
    );

    for (const action of [{ type: 'succeeded' }, { type: 'cancel' }] as CalibrationAction[]) {
      const done = calibrationReducer(state, action);
      expect(done.stage).toBe('idle');
      expect(done.pointA).toBeNull();
      expect(done.pointB).toBeNull();
      expect(done.distance).toBe('');
      expect(done.unit).toBe('mm');
    }
  });

  it('rejects an unknown unit instead of corrupting the conversion', () => {
    const state = run({ type: 'start' });
    expect(
      calibrationReducer(state, { type: 'set-unit', unit: 'furlong' as never }),
    ).toBe(state);
  });
});
