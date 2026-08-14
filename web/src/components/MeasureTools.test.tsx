import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../lib/queryClient';
import { useMeasureSession } from '../hooks/useMeasureSession';
import { MeasureTools } from './MeasureTools';
import { toProject } from '../lib/api';
import type { ApiCalibration } from '../lib/api';
import type { MeasureSession } from '../hooks/useMeasureSession';
import type { ReportCapture } from './ExportSheet';
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
  onSession,
  capture,
}: {
  projectId: string | null;
  calibration?: ApiCalibration | null;
  /** Hands the live session to the test so it can place picks. */
  onSession?: (session: MeasureSession) => void;
  capture?: ReportCapture | null;
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
  onSession?.(session);
  return (
    <MeasureTools session={session} projectName="Balcony anchor detail" capture={capture} />
  );
}

function mount(props: {
  projectId: string | null;
  calibration?: ApiCalibration | null;
  onSession?: (session: MeasureSession) => void;
  capture?: ReportCapture | null;
}) {
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

// --- WP 5.2/5.3: tool switcher, uncertainty, export -------------------------

/** Grabs the live session so a test can place picks through it. */
function mountWithSession(props: {
  projectId: string | null;
  calibration?: ApiCalibration | null;
  capture?: ReportCapture | null;
}) {
  const box: { session: MeasureSession | null } = { session: null };
  const utils = mount({ ...props, onSession: (session) => (box.session = session) });
  return { ...utils, session: () => box.session! };
}

const QUALITY = { rayDistance: 0.01, spacing: 0.04 };

describe('tool switcher', () => {
  it('stays out of the way until the user is measuring', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]));
    mount({ projectId: 'p1' });

    expect(screen.queryByRole('group', { name: /measurement tool/i })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Measure' }));
    expect(screen.getByRole('group', { name: /measurement tool/i })).toBeInTheDocument();
  });

  it('offers the four tools as one compact row, distance selected', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]));
    mount({ projectId: 'p1' });
    fireEvent.click(await screen.findByRole('button', { name: 'Measure' }));

    const group = screen.getByRole('group', { name: /measurement tool/i });
    const tools = screen.getAllByRole('button', { name: /distance|path|height|angle/i });
    expect(tools).toHaveLength(4);
    expect(group).toContainElement(tools[0]);
    expect(tools[0]).toHaveAttribute('aria-pressed', 'true');
  });

  it('switches the prompt with the tool', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]));
    mount({ projectId: 'p1' });
    fireEvent.click(await screen.findByRole('button', { name: 'Measure' }));

    fireEvent.click(screen.getByRole('button', { name: 'Path' }));
    expect(screen.getByTestId('measure-prompt')).toHaveTextContent(/double-tap or press finish/i);

    fireEvent.click(screen.getByRole('button', { name: 'Angle' }));
    expect(screen.getByTestId('measure-prompt')).toHaveTextContent(/corner of the angle first/i);

    fireEvent.click(screen.getByRole('button', { name: 'Height' }));
    expect(screen.getByTestId('measure-prompt')).toHaveTextContent(/three points/i);
  });

  it('turns measure mode on when a tool is picked from cold', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]));
    const { session } = mountWithSession({ projectId: 'p1' });
    await waitFor(() => expect(session()).not.toBeNull());

    // The switcher is only reachable in measure mode, but selecting a tool
    // programmatically (or by tapping through) must not leave picking off.
    act(() => session().selectTool('angle'));
    expect(session().measuring).toBe(true);
    expect(session().pickEnabled).toBe(true);
  });

  it('offers Undo and Finish only when they apply', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]));
    const { session } = mountWithSession({ projectId: null });
    await waitFor(() => expect(session()).not.toBeNull());

    act(() => session().selectTool('polyline'));
    expect(screen.queryByRole('button', { name: /undo point/i })).not.toBeInTheDocument();

    act(() => session().handlePick(A));
    expect(screen.getByRole('button', { name: /undo point/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /finish path/i })).not.toBeInTheDocument();

    act(() => session().handlePick(B));
    fireEvent.click(screen.getByRole('button', { name: /finish path/i }));
    expect(screen.getByRole('button', { name: /^list/i })).toHaveTextContent('1');
  });

  it('offers a fresh ground plane once one is set', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]));
    const { session } = mountWithSession({ projectId: null });
    await waitFor(() => expect(session()).not.toBeNull());

    act(() => session().selectTool('height'));
    expect(screen.queryByRole('button', { name: /new ground plane/i })).not.toBeInTheDocument();

    for (const point of [[0, 0, 0], [2, 0, 0], [0, 0, 2]] as Point3[]) {
      act(() => session().handlePick(point));
    }
    fireEvent.click(screen.getByRole('button', { name: /new ground plane/i }));
    expect(screen.getByTestId('measure-prompt')).toHaveTextContent(/three points/i);
  });
});

describe('uncertainty in the UI', () => {
  it('states the scale tolerance beside the scale itself', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]));
    mount({ projectId: 'p1', calibration: CALIBRATION });

    expect(await screen.findByText('scale ±2 %')).toBeInTheDocument();
  });

  it('lists a measurement with its ± once the picks reported their quality', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]));
    const { session } = mountWithSession({ projectId: null, calibration: CALIBRATION });
    await waitFor(() => expect(session()).not.toBeNull());

    act(() => session().toggleMeasuring());
    act(() => session().handlePick(A, QUALITY));
    act(() => session().handlePick(B, QUALITY));

    fireEvent.click(screen.getByRole('button', { name: /^list/i }));
    // The value keeps its own element so it reads on its own…
    expect(screen.getByText('2.50 m')).toBeInTheDocument();
    // …with the ± as a separate, quieter qualifier.
    expect(screen.getByText(/^± 0\.0\d m \(±\d/)).toBeInTheDocument();
  });

  it('explains a row that has no ± instead of leaving it blank', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([STORED]));
    mount({ projectId: 'p1', calibration: CALIBRATION });

    fireEvent.click(await screen.findByRole('button', { name: /^list/i }));
    expect(await screen.findByText('· Point to point')).toBeInTheDocument();
    expect(screen.getByText(/only the scene scale/i)).toBeInTheDocument();
  });
});

describe('report export', () => {
  /** A canvas that can encode itself, standing in for the WebGL frame. */
  function fakeCanvas() {
    return {
      width: 800,
      height: 600,
      toBlob: (callback: (blob: Blob | null) => void, type: string) =>
        callback(new Blob([new Uint8Array([1, 2, 3])], { type })),
    } as unknown as HTMLCanvasElement;
  }

  it('offers both formats and says what the PDF holds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]));
    mount({ projectId: 'p1' });

    fireEvent.click(await screen.findByRole('button', { name: /^export/i }));
    expect(screen.getByRole('button', { name: /png snapshot/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pdf report/i })).toBeInTheDocument();
    expect(screen.getByText(/holds the screenshot, the scale and every measurement/i)).toBeInTheDocument();
  });

  it('downloads a PDF built from the current measurements', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([STORED]));
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    // The blob handed to the browser is what the user ends up with, so the
    // test follows it from `createObjectURL` through to the anchor's click.
    let captured: Blob | null = null;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((source: Blob | MediaSource) => {
      captured = source as Blob;
      return 'blob:report';
    });
    const saved: { name: string; blob: Blob }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved.push({ name: this.download, blob: captured! });
    });

    mount({ projectId: 'p1', calibration: CALIBRATION, capture: () => fakeCanvas() });
    fireEvent.click(await screen.findByRole('button', { name: /^export/i }));
    fireEvent.click(screen.getByRole('button', { name: /pdf report/i }));

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].name).toMatch(/^balcony-anchor-detail-\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(saved[0].blob.type).toBe('application/pdf');
    expect((await saved[0].blob.text()).startsWith('%PDF-1.4')).toBe(true);
    // The sheet closes itself once the file is on its way.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /pdf report/i })).not.toBeInTheDocument(),
    );
  });

  it('explains a frame it could not capture rather than saving a black PNG', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]));
    mount({ projectId: 'p1', capture: () => null });

    fireEvent.click(await screen.findByRole('button', { name: /^export/i }));
    fireEvent.click(screen.getByRole('button', { name: /png snapshot/i }));

    expect(await screen.findByText(/graphics buffer was already cleared/i)).toBeInTheDocument();
  });

  it('warns that a URL-only scene keeps nothing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]));
    mount({ projectId: null });

    fireEvent.click(screen.getByRole('button', { name: /^export/i }));
    expect(screen.getByText(/0 measurements/i)).toBeInTheDocument();
  });
});
