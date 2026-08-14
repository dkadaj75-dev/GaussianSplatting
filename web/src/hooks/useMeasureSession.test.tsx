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
