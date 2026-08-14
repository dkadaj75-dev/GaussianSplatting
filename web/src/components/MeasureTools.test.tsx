import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../lib/queryClient';
import { useMeasureSession } from '../hooks/useMeasureSession';
import { MeasureTools } from './MeasureTools';
import { toProject } from '../lib/api';
import type { ApiCalibration } from '../lib/api';
import type { Point3 } from '../types';

const A: Point3 = [0, 0, 0];
const B: Point3 = [3, 4, 0];

const CALIBRATION: ApiCalibration = {
  scale: 0.5,
  method: 'known_distance',
  reference: { point_a: A, point_b: B, real_distance_m: 2.5 },
  calibrated_at: '2026-08-14T11:00:00Z',
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const STORED = {
  id: 'm1',
  project_id: 'p1',
  kind: 'distance' as const,
  points: [A, B],
  value: 5,
  unit: 'scene',
  label: 'M1',
  created_at: '2026-08-14T10:00:00Z',
};

/**
 * Mounts the toolbar over a real session — the point is that the two agree,
 * so a fake session object would test nothing.
 */
function Harness({
  projectId,
  calibration = null,
}: {
  projectId: string | null;
  calibration?: ApiCalibration | null;
}) {
  const session = useMeasureSession({
    projectId,
    project: toProject({
      id: 'p1',
      name: 'Balcony anchor detail',
      created_at: '2026-08-14T10:00:00Z',
      status: 'ready',
      photo_count: 3,
      calibration,
    }),
  });
  return <MeasureTools session={session} />;
}

function mount(props: { projectId: string | null; calibration?: ApiCalibration | null }) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness {...props} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('measure toolbar', () => {
  it('warns that units are relative until the scene is calibrated', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]));

    mount({ projectId: 'p1' });

    expect(await screen.findByTestId('calibration-badge')).toHaveTextContent(
      /uncalibrated — units are relative/i,
    );
  });

  it('reports the scale once the project has one', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]));

    mount({ projectId: 'p1', calibration: CALIBRATION });

    expect(await screen.findByTestId('calibration-badge')).toHaveTextContent(/^Calibrated$/);
    // scale 0.5 → one scene unit is half a metre.
    expect(screen.getByText((_text, element) => element?.textContent === '1 unit = 50 cm'))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument();
  });

  it('coaches through the calibration picks', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]));

    mount({ projectId: 'p1' });
    fireEvent.click(await screen.findByRole('button', { name: 'Calibrate' }));

    expect(screen.getByTestId('measure-prompt')).toHaveTextContent(/tap the first end/i);
  });

  it('explains the tap gesture while measuring, without covering the scene', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]));

    mount({ projectId: 'p1' });
    const measure = await screen.findByRole('button', { name: 'Measure' });
    expect(measure).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(measure);

    expect(measure).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('measure-prompt')).toHaveTextContent(/tap two points/i);
  });

  it('lists stored measurements with their value and a delete control', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_input, init) =>
        (init?.method ?? 'GET') === 'DELETE' ? jsonResponse(null, 204) : jsonResponse([STORED]),
      );

    mount({ projectId: 'p1', calibration: CALIBRATION });
    fireEvent.click(await screen.findByRole('button', { name: /^list/i }));

    expect(await screen.findByText('M1')).toBeInTheDocument();
    // 5 scene units at 0.5 m per unit.
    expect(screen.getByText('2.5 m')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /delete m1/i }));

    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'),
      ).toBe(true),
    );
  });

  it('says measurements are not saved when there is no project', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    mount({ projectId: null });
    fireEvent.click(screen.getByRole('button', { name: /^list/i }));

    expect(screen.getByText(/not saved/i)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('asks before clearing everything', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([STORED]));

    mount({ projectId: 'p1' });
    // Clear only asks when there is something to lose, so wait for the load.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^list/i })).toHaveTextContent('1'),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(screen.getByRole('button', { name: 'Clear all?' })).toBeInTheDocument();
  });
});
