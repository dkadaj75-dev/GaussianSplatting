import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../lib/queryClient';
import { useMeasureSession } from './useMeasureSession';
import type { ApiCalibration, ApiMeasurement } from '../lib/api';
import { toProject } from '../lib/api';
import type { Point3, Project } from '../types';

const A: Point3 = [0, 0, 0];
const B: Point3 = [3, 4, 0];

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[] = [];

interface Route {
  match: (url: string, method: string) => boolean;
  body: unknown;
  status?: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function mockApi(routes: Route[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({
      url,
      method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    const route = routes.find((candidate) => candidate.match(url, method));
    if (!route) return jsonResponse({ detail: `No route for ${method} ${url}` }, 404);
    return jsonResponse(route.body, route.status);
  });
}

function apiMeasurement(overrides: Partial<ApiMeasurement> = {}): ApiMeasurement {
  return {
    id: 'm1',
    project_id: 'p1',
    kind: 'distance',
    points: [A, B],
    value: 5,
    unit: 'scene',
    label: 'M1',
    created_at: '2026-08-14T10:00:00Z',
    ...overrides,
  };
}

const CALIBRATION: ApiCalibration = {
  scale: 0.5,
  method: 'known_distance',
  reference: { point_a: A, point_b: B, real_distance_m: 2.5 },
  calibrated_at: '2026-08-14T11:00:00Z',
};

function apiProject(calibration: ApiCalibration | null = null) {
  return {
    id: 'p1',
    name: 'Balcony anchor detail',
    created_at: '2026-08-14T10:00:00Z',
    status: 'ready' as const,
    photo_count: 34,
    calibration,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderSession(projectId: string | null, project?: Project | null) {
  return renderHook(
    (props: { projectId: string | null; project?: Project | null }) => useMeasureSession(props),
    { wrapper, initialProps: { projectId, project } },
  );
}

/** Turns measure mode on and taps the two ends of a segment. */
async function measure(
  result: { current: ReturnType<typeof useMeasureSession> },
  a: Point3 = A,
  b: Point3 = B,
) {
  if (!result.current.measuring) await act(async () => result.current.toggleMeasuring());
  await act(async () => result.current.handlePick(a));
  await act(async () => result.current.handlePick(b));
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('measurement persistence', () => {
  it('POSTs a completed distance in the API schema', async () => {
    mockApi([
      { match: (url, method) => url.endsWith('/measurements') && method === 'GET', body: [] },
      {
        match: (url, method) => url.endsWith('/measurements') && method === 'POST',
        body: apiMeasurement(),
        status: 201,
      },
    ]);

    const { result } = renderSession('p1');
    await waitFor(() => expect(result.current.measurementsPending).toBe(false));
    await measure(result);

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST');

    expect(post?.url).toMatch(/\/api\/projects\/p1\/measurements$/);
    expect(post?.body).toEqual({
      kind: 'distance',
      points: [A, B],
      // 3-4-5: scene units, never the calibrated value.
      value: 5,
      unit: 'scene',
      label: 'M1',
    });
  });

  it('continues the auto-label from what the project already has', async () => {
    mockApi([
      {
        match: (url, method) => url.endsWith('/measurements') && method === 'GET',
        body: [apiMeasurement({ id: 'a', label: 'M1' }), apiMeasurement({ id: 'b', label: 'M2' })],
      },
      {
        match: (url, method) => url.endsWith('/measurements') && method === 'POST',
        body: apiMeasurement({ id: 'c', label: 'M3' }),
        status: 201,
      },
    ]);

    const { result } = renderSession('p1');
    await waitFor(() => expect(result.current.measurements).toHaveLength(2));
    await measure(result, [0, 0, 0], [1, 0, 0]);

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect((calls.find((call) => call.method === 'POST')?.body as { label: string }).label).toBe(
      'M3',
    );
  });

  it('renders stored measurements, ignoring non-distance rows', async () => {
    mockApi([
      {
        match: (url, method) => url.endsWith('/measurements') && method === 'GET',
        body: [apiMeasurement(), apiMeasurement({ id: 'ref', kind: 'scale_reference' })],
      },
    ]);

    const { result } = renderSession('p1');

    await waitFor(() => expect(result.current.measurements).toHaveLength(1));
    expect(result.current.overlayItems).toEqual([
      expect.objectContaining({ id: 'm1', tone: 'measure', a: A, b: B, label: 'M1 · 5 units' }),
    ]);
  });

  it('DELETEs a measurement from the list', async () => {
    mockApi([
      {
        match: (url, method) => url.endsWith('/measurements') && method === 'GET',
        body: [apiMeasurement()],
      },
      { match: (_url, method) => method === 'DELETE', body: null, status: 204 },
    ]);

    const { result } = renderSession('p1');
    await waitFor(() => expect(result.current.measurements).toHaveLength(1));
    await act(async () => result.current.deleteMeasurement('m1'));

    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true));
    expect(calls.find((call) => call.method === 'DELETE')?.url).toMatch(
      /\/api\/projects\/p1\/measurements\/m1$/,
    );
  });

  it('surfaces a failed save instead of losing it silently', async () => {
    mockApi([
      { match: (url, method) => url.endsWith('/measurements') && method === 'GET', body: [] },
      {
        match: (url, method) => url.endsWith('/measurements') && method === 'POST',
        body: { detail: 'Project p1 not found' },
        status: 404,
      },
    ]);

    const { result } = renderSession('p1');
    await waitFor(() => expect(result.current.measurementsPending).toBe(false));
    await measure(result);

    await waitFor(() => expect(result.current.notice).toMatch(/Project p1 not found/));
  });

  it('rejects two picks that landed on the same point', async () => {
    mockApi([
      { match: (url, method) => url.endsWith('/measurements') && method === 'GET', body: [] },
    ]);

    const { result } = renderSession('p1');
    await waitFor(() => expect(result.current.measurementsPending).toBe(false));
    await measure(result, A, A);

    expect(result.current.notice).toMatch(/same spot/i);
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });
});

describe('without a project context', () => {
  it('measures in memory and says so', async () => {
    const fetchSpy = mockApi([]);
    const { result } = renderSession(null);

    expect(result.current.persisted).toBe(false);
    await measure(result);

    expect(result.current.measurements).toHaveLength(1);
    expect(result.current.measurements[0].value).toBe(5);
    expect(result.current.measurements[0].label).toBe('M1');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('deletes and clears locally', async () => {
    mockApi([]);
    const { result } = renderSession(null);

    await measure(result);
    await measure(result, [0, 0, 0], [0, 0, 1]);
    expect(result.current.measurements).toHaveLength(2);

    await act(async () => result.current.deleteMeasurement(result.current.measurements[0].id));
    expect(result.current.measurements).toHaveLength(1);

    await act(async () => result.current.clearAll());
    expect(result.current.measurements).toHaveLength(0);
  });

  it('refuses to calibrate, pointing at the project route', async () => {
    mockApi([]);
    const { result } = renderSession(null);

    await act(async () => result.current.startCalibration());
    await act(async () => result.current.handlePick(A));
    await act(async () => result.current.handlePick(B));
    await act(async () => result.current.dispatchCalibration({ type: 'set-distance', value: '1' }));
    await act(async () => result.current.submitCalibration());

    expect(result.current.calibrationState.stage).toBe('entry');
    expect(result.current.calibrationState.error).toMatch(/open this scene from its project/i);
  });
});

describe('calibration', () => {
  it('PUTs the reference and closes the sheet on success', async () => {
    mockApi([
      { match: (url, method) => url.endsWith('/measurements') && method === 'GET', body: [] },
      {
        match: (url, method) => url.endsWith('/calibration') && method === 'PUT',
        body: apiProject(CALIBRATION),
      },
    ]);

    const { result } = renderSession('p1', toProject(apiProject()));
    await waitFor(() => expect(result.current.measurementsPending).toBe(false));

    await act(async () => result.current.startCalibration());
    expect(result.current.pickEnabled).toBe(true);

    await act(async () => result.current.handlePick(A));
    await act(async () => result.current.handlePick(B));
    expect(result.current.calibrationState.stage).toBe('entry');
    // 3-4-5 in scene units, about to be declared 2.5 m.
    expect(result.current.calibrationSceneLength).toBe(5);

    await act(async () => result.current.dispatchCalibration({ type: 'set-unit', unit: 'cm' }));
    await act(async () =>
      result.current.dispatchCalibration({ type: 'set-distance', value: '250' }),
    );
    await act(async () => result.current.submitCalibration());

    await waitFor(() => expect(result.current.calibrationState.stage).toBe('idle'));
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.url).toMatch(/\/api\/projects\/p1\/calibration$/);
    expect(put?.body).toEqual({ point_a: A, point_b: B, real_distance_m: 2.5 });
  });

  it('keeps the sheet open with its values when the API rejects it', async () => {
    mockApi([
      { match: (url, method) => url.endsWith('/measurements') && method === 'GET', body: [] },
      {
        match: (url, method) => url.endsWith('/calibration') && method === 'PUT',
        body: { detail: 'Calibration is not available on this server' },
        status: 404,
      },
    ]);

    const { result } = renderSession('p1', toProject(apiProject()));
    await waitFor(() => expect(result.current.measurementsPending).toBe(false));

    await act(async () => result.current.startCalibration());
    await act(async () => result.current.handlePick(A));
    await act(async () => result.current.handlePick(B));
    await act(async () => result.current.dispatchCalibration({ type: 'set-distance', value: '2.5' }));
    await act(async () => result.current.submitCalibration());

    await waitFor(() => expect(result.current.calibrationState.error).toMatch(/not available/i));
    expect(result.current.calibrationState.stage).toBe('entry');
    expect(result.current.calibrationState.pointA).toEqual(A);
    expect(result.current.calibrationState.distance).toBe('2.5');
  });

  it('relabels every measurement in metres once the project carries a scale', async () => {
    mockApi([
      {
        match: (url, method) => url.endsWith('/measurements') && method === 'GET',
        body: [apiMeasurement()],
      },
    ]);

    const { result, rerender } = renderSession('p1', toProject(apiProject()));
    await waitFor(() => expect(result.current.measurements).toHaveLength(1));
    expect(result.current.format(5)).toBe('5 units');

    // The project query refreshes with the calibration the PUT returned.
    rerender({ projectId: 'p1', project: toProject(apiProject(CALIBRATION)) });

    // 5 scene units × 0.5 m/unit.
    expect(result.current.format(5)).toBe('2.5 m');
    expect(result.current.overlayItems[0].label).toBe('M1 · 2.5 m');
  });

  it('draws the saved reference segment in its own tone', async () => {
    mockApi([
      { match: (url, method) => url.endsWith('/measurements') && method === 'GET', body: [] },
    ]);

    const { result } = renderSession('p1', toProject(apiProject(CALIBRATION)));
    await waitFor(() => expect(result.current.measurementsPending).toBe(false));

    expect(result.current.overlayItems).toEqual([
      {
        id: 'calibration-reference',
        tone: 'calibration',
        a: A,
        b: B,
        label: 'Reference · 2.5 m',
      },
    ]);
  });

  it('DELETEs the calibration when asked to remove it', async () => {
    mockApi([
      { match: (url, method) => url.endsWith('/measurements') && method === 'GET', body: [] },
      {
        match: (url, method) => url.endsWith('/calibration') && method === 'DELETE',
        body: apiProject(null),
      },
    ]);

    const { result } = renderSession('p1', toProject(apiProject(CALIBRATION)));
    await waitFor(() => expect(result.current.measurementsPending).toBe(false));
    await act(async () => result.current.removeCalibration());

    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true));
    expect(calls.find((call) => call.method === 'DELETE')?.url).toMatch(
      /\/api\/projects\/p1\/calibration$/,
    );
  });
});

describe('picking feedback', () => {
  it('nudges the user when a tap hits nothing', async () => {
    mockApi([
      { match: (url, method) => url.endsWith('/measurements') && method === 'GET', body: [] },
    ]);

    const { result } = renderSession('p1');
    await act(async () => result.current.toggleMeasuring());
    await act(async () => result.current.handlePick(null));

    expect(result.current.notice).toMatch(/nothing to measure/i);
    await act(async () => result.current.dismissNotice());
    expect(result.current.notice).toBeNull();
  });

  it('shows the first point as a pending marker until the second lands', async () => {
    mockApi([
      { match: (url, method) => url.endsWith('/measurements') && method === 'GET', body: [] },
    ]);

    const { result } = renderSession('p1');
    await act(async () => result.current.toggleMeasuring());
    await act(async () => result.current.handlePick(A));

    expect(result.current.overlayItems).toEqual([{ id: 'pending-a', tone: 'pending', a: A }]);
  });

  it('does not pick at all until a mode is on', async () => {
    mockApi([
      { match: (url, method) => url.endsWith('/measurements') && method === 'GET', body: [] },
    ]);

    const { result } = renderSession('p1');
    expect(result.current.pickEnabled).toBe(false);

    await act(async () => result.current.handlePick(A));
    expect(result.current.overlayItems).toHaveLength(0);
  });
});

// --- WP 5.2: the other three tools, and the ± ------------------------------

/** Three points on the y = 0 floor, spread out enough to define a plane. */
const FLOOR: Point3[] = [
  [0, 0, 0],
  [2, 0, 0],
  [0, 0, 2],
];

/** A pick that reports how good it was, the way SplatViewer does. */
const QUALITY = { rayDistance: 0.01, spacing: 0.04 };

describe('measurement tools', () => {
  it('POSTs a path as its vertices and total length', async () => {
    mockApi([
      { match: (url, method) => url.endsWith('/measurements') && method === 'GET', body: [] },
      {
        match: (url, method) => url.endsWith('/measurements') && method === 'POST',
        body: apiMeasurement({ id: 'p', kind: 'polyline', points: [A, B, [3, 4, 5]], value: 10 }),
        status: 201,
      },
    ]);

    const { result } = renderSession('p1');
    await waitFor(() => expect(result.current.measurementsPending).toBe(false));

    await act(async () => result.current.selectTool('polyline'));
    await act(async () => result.current.handlePick(A));
    await act(async () => result.current.handlePick(B));
    await act(async () => result.current.handlePick([3, 4, 5]));
    // Nothing is saved until the path is closed.
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    expect(result.current.canFinish).toBe(true);

    await act(async () => result.current.finishPath());
    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
      kind: 'polyline',
      points: [A, B, [3, 4, 5]],
      value: 10,
      unit: 'scene',
      label: 'M1',
    });
  });

  it('closes a path on a double-tap', async () => {
    mockApi([
      { match: (url, method) => url.endsWith('/measurements') && method === 'GET', body: [] },
      {
        match: (url, method) => url.endsWith('/measurements') && method === 'POST',
        body: apiMeasurement({ id: 'p', kind: 'polyline' }),
        status: 201,
      },
    ]);

    const { result } = renderSession('p1');
    await waitFor(() => expect(result.current.measurementsPending).toBe(false));

    await act(async () => result.current.selectTool('polyline'));
    await act(async () => result.current.handlePick(A));
    await act(async () => result.current.handlePick(B));
    await act(async () => result.current.handlePick(B, { ...QUALITY, doubleTap: true }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST')?.body as { points: Point3[] };
    // The second tap of the double-tap closes the path; it does not add a point.
    expect(post.points).toEqual([A, B]);
  });

  it('POSTs a height together with the plane it was measured against', async () => {
    mockApi([
      { match: (url, method) => url.endsWith('/measurements') && method === 'GET', body: [] },
      {
        match: (url, method) => url.endsWith('/measurements') && method === 'POST',
        body: apiMeasurement({ id: 'h', kind: 'height' }),
        status: 201,
      },
    ]);

    const { result } = renderSession('p1');
    await waitFor(() => expect(result.current.measurementsPending).toBe(false));

    await act(async () => result.current.selectTool('height'));
    expect(result.current.prompt).toMatch(/three points/i);
    for (const point of FLOOR) await act(async () => result.current.handlePick(point));
    expect(result.current.groundPlane).not.toBeNull();

    await act(async () => result.current.handlePick([1, 2.5, 1]));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
      kind: 'height',
      points: [...FLOOR, [1, 2.5, 1]],
      value: 2.5,
      unit: 'scene',
      label: 'M1',
    });
  });

  it('keeps the ground plane for the next height, and can forget it', async () => {
    mockApi([
      { match: (url, method) => url.endsWith('/measurements') && method === 'GET', body: [] },
    ]);

    const { result } = renderSession(null);
    await act(async () => result.current.selectTool('height'));
    for (const point of FLOOR) await act(async () => result.current.handlePick(point));
    await act(async () => result.current.handlePick([1, 2.5, 1]));
    expect(result.current.measurements).toHaveLength(1);

    // A second height needs one tap, not four.
    await act(async () => result.current.handlePick([1, 1, 1]));
    expect(result.current.measurements).toHaveLength(2);

    await act(async () => result.current.clearGroundPlane());
    expect(result.current.groundPlane).toBeNull();
    expect(result.current.prompt).toMatch(/three points/i);
  });

  it('rejects three ground-plane points in a line, keeping the good two', async () => {
    mockApi([]);
    const { result } = renderSession(null);

    await act(async () => result.current.selectTool('height'));
    await act(async () => result.current.handlePick([0, 0, 0]));
    await act(async () => result.current.handlePick([1, 0, 0]));
    await act(async () => result.current.handlePick([2, 0, 0]));

    expect(result.current.notice).toMatch(/in a line/i);
    expect(result.current.groundPlane).toBeNull();
    // The replacement third point finishes the plane on its own.
    await act(async () => result.current.handlePick([0, 0, 2]));
    expect(result.current.groundPlane).not.toBeNull();
  });

  it('POSTs an angle in degrees, vertex first', async () => {
    mockApi([
      { match: (url, method) => url.endsWith('/measurements') && method === 'GET', body: [] },
      {
        match: (url, method) => url.endsWith('/measurements') && method === 'POST',
        body: apiMeasurement({ id: 'a', kind: 'angle', unit: 'deg', value: 90 }),
        status: 201,
      },
    ]);

    const { result } = renderSession('p1');
    await waitFor(() => expect(result.current.measurementsPending).toBe(false));

    await act(async () => result.current.selectTool('angle'));
    expect(result.current.prompt).toMatch(/corner/i);
    await act(async () => result.current.handlePick([0, 0, 0]));
    await act(async () => result.current.handlePick([1, 0, 0]));
    await act(async () => result.current.handlePick([0, 1, 0]));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
      kind: 'angle',
      points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
      value: 90,
      unit: 'deg',
      label: 'M1',
    });
  });

  it('undoes the last point without leaving the tool', async () => {
    mockApi([]);
    const { result } = renderSession(null);

    await act(async () => result.current.selectTool('polyline'));
    await act(async () => result.current.handlePick(A));
    await act(async () => result.current.handlePick(B));
    expect(result.current.hasDraft).toBe(true);

    await act(async () => result.current.undoPick());
    expect(result.current.canFinish).toBe(false);
    await act(async () => result.current.undoPick());
    expect(result.current.hasDraft).toBe(false);
    expect(result.current.tool).toBe('polyline');
  });

  it('draws the draft path and the ground plane while they are being placed', async () => {
    mockApi([]);
    const { result } = renderSession(null);

    await act(async () => result.current.selectTool('polyline'));
    await act(async () => result.current.handlePick(A));
    await act(async () => result.current.handlePick(B));
    expect(result.current.overlayItems).toEqual([
      { id: 'pending-a', tone: 'pending', a: A, points: [A, B], label: '5 units' },
    ]);

    await act(async () => result.current.selectTool('height'));
    await act(async () => result.current.handlePick(FLOOR[0]));
    expect(result.current.overlayItems).toEqual([{ id: 'pending-plane', tone: 'pending', a: FLOOR[0] }]);
  });

  it('draws an angle with its arc and a height with its plane', async () => {
    mockApi([]);
    const { result } = renderSession(null);

    await act(async () => result.current.selectTool('angle'));
    await act(async () => result.current.handlePick([0, 0, 0]));
    await act(async () => result.current.handlePick([1, 0, 0]));
    await act(async () => result.current.handlePick([0, 1, 0]));

    const angle = result.current.overlayItems[0];
    // Drawn arm → vertex → arm, so the corner is where the lines meet.
    expect(angle.points).toEqual([[1, 0, 0], [0, 0, 0], [0, 1, 0]]);
    expect(angle.anchor).toEqual([0, 0, 0]);
    expect(angle.guide!.length).toBeGreaterThan(2);
    expect(angle.label).toBe('M1 · 90°');

    await act(async () => result.current.selectTool('height'));
    for (const point of FLOOR) await act(async () => result.current.handlePick(point));
    await act(async () => result.current.handlePick([1, 2.5, 1]));

    const height = result.current.overlayItems.find((item) => item.label?.startsWith('M2'))!;
    expect(height.a).toEqual([1, 2.5, 1]);
    // The drop line ends on the plane…
    expect(height.b).toEqual([1, 0, 1]);
    // …and the plane it was measured against is outlined.
    expect(height.guide).toEqual([...FLOOR, FLOOR[0]]);
  });
});

describe('uncertainty display', () => {
  it('shows a ± on the chip once the picks report their quality', async () => {
    mockApi([]);
    const { result } = renderSession(null, toProject(apiProject(CALIBRATION)));

    await act(async () => result.current.toggleMeasuring());
    await act(async () => result.current.handlePick(A, QUALITY));
    await act(async () => result.current.handlePick(B, QUALITY));

    const item = result.current.overlayItems[0];
    // 5 scene units at 0.5 m/unit, ± the picks and the 2 % manual scale.
    expect(item.label).toBe('M1 · 2.50 m');
    expect(item.detail).toMatch(/^± 0\.0\d m$/);
    expect(result.current.rows[0].uncertainty?.basis).toBe('full');
  });

  it('does not invent a ± for a stored row whose picks were never seen', async () => {
    mockApi([
      {
        match: (url, method) => url.endsWith('/measurements') && method === 'GET',
        body: [apiMeasurement()],
      },
    ]);

    const { result } = renderSession('p1', toProject(apiProject(CALIBRATION)));
    await waitFor(() => expect(result.current.rows).toHaveLength(1));

    expect(result.current.rows[0].uncertainty?.basis).toBe('scale-only');
    expect(result.current.overlayItems[0].detail).toBeUndefined();
    expect(result.current.notes[0]).toMatch(/only the scene scale/i);
  });

  it('reports the scale tolerance from an ArUco residual', async () => {
    mockApi([
      { match: (url, method) => url.endsWith('/measurements') && method === 'GET', body: [] },
    ]);

    const aruco: ApiCalibration = {
      scale: 0.5,
      method: 'aruco',
      calibrated_at: '2026-08-14T11:00:00Z',
      residual: 0.018,
      sample_count: 12,
      marker_length_m: 0.15,
      marker_dictionary: 'DICT_4X4_50',
    };
    const { result } = renderSession('p1', toProject(apiProject(aruco)));
    await waitFor(() => expect(result.current.measurementsPending).toBe(false));

    expect(result.current.scaleRelativeSigma).toBeCloseTo(0.018, 12);
    expect(result.current.calibrationSummary).toMatch(/150 mm marker \(12 observations\)/);
    // Nothing to draw: an ArUco scale has no picked reference pair.
    expect(result.current.overlayItems).toEqual([]);
  });
});

describe('scene-wide pick quality', () => {
  it('gives measurements from an earlier session a ±, marked as borrowed', async () => {
    mockApi([
      {
        match: (url, method) => url.endsWith('/measurements') && method === 'GET',
        body: [apiMeasurement()],
      },
    ]);

    const { result } = renderSession('p1', toProject(apiProject(CALIBRATION)));
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    // Nothing has been picked yet, so there is nothing to say about the picks.
    expect(result.current.rows[0].uncertainty?.basis).toBe('scale-only');

    // The viewer finishes probing the cloud: splats sit ~4 cm apart.
    await act(async () => result.current.reportSceneSpacing(0.04));

    expect(result.current.rows[0].uncertainty?.basis).toBe('assumed-spacing');
    expect(result.current.overlayItems[0].detail).toMatch(/^± /);
    expect(result.current.notes[0]).toMatch(/typical pick quality/i);
  });

  it('prefers the quality of real picks over the scene probe', async () => {
    mockApi([]);
    const { result } = renderSession(null);

    await act(async () => result.current.reportSceneSpacing(1));
    await act(async () => result.current.toggleMeasuring());
    await act(async () => result.current.handlePick(A, QUALITY));
    await act(async () => result.current.handlePick(B, QUALITY));

    // The measurement's own picks are known, so the probe does not apply to it.
    expect(result.current.rows[0].uncertainty?.basis).toBe('full');
    expect(result.current.rows[0].uncertainty!.sigmaScene).toBeLessThan(0.5);
  });
});
