import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../test/renderApp';
import { useAppStore } from '../store/useAppStore';
import { resetUploadQueue } from '../hooks/useUploadQueue';
import { createUploadQueue } from '../lib/uploadQueue';
import { createMemoryQueueStorage } from '../lib/uploadQueueStorage';

// --- Fake imaging ------------------------------------------------------------
//
// jsdom has neither createImageBitmap nor a 2D context, so the capture page
// would always take its "analysis unsupported" path. These stand-ins decode a
// photo into a known pixel pattern, which is enough to drive the real blur and
// duplicate maths in lib/photoQuality.

type FakeContext = {
  drawImage: (image: { tag: number }) => void;
  getImageData: (x: number, y: number, width: number, height: number) => { data: Uint8ClampedArray };
};

/** tag 1 = crisp, off-centre subject; tag 0 = flat, out-of-focus frame. */
function pixels(tag: number, width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value =
        tag === 0
          ? 128
          : ((x + y) % 2 === 0 ? 40 : 220) + Math.round((x / Math.max(1, width - 1)) * 30);
      const index = (y * width + x) * 4;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      data[index + 3] = 255;
    }
  }
  return data;
}

function installFakeImaging() {
  const hadBitmap = 'createImageBitmap' in globalThis;
  const originalBitmap = globalThis.createImageBitmap;
  const originalGetContext = HTMLCanvasElement.prototype.getContext;

  globalThis.createImageBitmap = (async (blob: Blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { width: 64, height: 64, tag: bytes[0] ?? 0, close() {} };
  }) as unknown as typeof createImageBitmap;

  let drawn: { tag: number } | null = null;
  const context: FakeContext = {
    drawImage: (image) => {
      drawn = image;
    },
    getImageData: (_x, _y, width, height) => ({ data: pixels(drawn?.tag ?? 0, width, height) }),
  };
  HTMLCanvasElement.prototype.getContext = (() =>
    context) as unknown as typeof originalGetContext;

  return () => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    if (hadBitmap) globalThis.createImageBitmap = originalBitmap;
    else delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
  };
}

// --- Helpers -----------------------------------------------------------------

function photo(name: string, tag: number): File {
  return new File([new Uint8Array([tag, 1, 2, 3])], name, { type: 'image/jpeg' });
}

function choosePhotos(files: File[]) {
  const input = screen.getByTestId('gallery-input') as HTMLInputElement;
  const list = {
    length: files.length,
    item: (index: number) => files[index] ?? null,
    ...Object.fromEntries(files.map((file, index) => [index, file])),
    [Symbol.iterator]: function* () {
      yield* files;
    },
  } as unknown as FileList;
  Object.defineProperty(input, 'files', { value: list, configurable: true, writable: true });
  fireEvent.change(input);
}

function setProjectId(value: string) {
  fireEvent.change(screen.getByPlaceholderText('Project ID'), { target: { value } });
}

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: online });
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
}

/** Installs a queue with a stubbed network, in place of the app-wide one. */
function installQueue(upload: ReturnType<typeof vi.fn>) {
  const queue = createUploadQueue({
    storage: createMemoryQueueStorage(),
    upload: upload as never,
  });
  resetUploadQueue(queue);
  void queue.start();
  return queue;
}

let restoreImaging: (() => void) | null = null;

beforeEach(() => {
  useAppStore.getState().reset();
  setOnline(true);
  // No API in unit tests: the project picker falls back to manual entry.
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
});

afterEach(() => {
  restoreImaging?.();
  restoreImaging = null;
  resetUploadQueue();
  setOnline(true);
  vi.restoreAllMocks();
});

describe('capture guidance', () => {
  it('shows the coverage checklist and colours the count by how many photos there are', async () => {
    renderApp('/capture');

    const checklist = screen.getByRole('list', { name: /coverage checklist/i });
    expect(within(checklist).getByText(/30\+ photos recommended/i)).toBeInTheDocument();
    expect(within(checklist).getByText(/orbit the subject/i)).toBeInTheDocument();
    expect(within(checklist).getByText(/60–70% overlap/i)).toBeInTheDocument();
    expect(within(checklist).getByText(/avoid changing zoom/i)).toBeInTheDocument();

    // Nothing selected yet: well short of a usable set.
    expect(screen.getByTestId('photo-count')).toHaveClass('text-danger');

    choosePhotos(Array.from({ length: 16 }, (_unused, index) => photo(`p${index}.jpg`, 1)));
    await waitFor(() => expect(screen.getByTestId('photo-count')).toHaveTextContent('16'));
    expect(screen.getByTestId('photo-count')).toHaveClass('text-warn');
    expect(screen.getByText(/14 more recommended/i)).toBeInTheDocument();

    choosePhotos(Array.from({ length: 14 }, (_unused, index) => photo(`q${index}.jpg`, 1)));
    await waitFor(() => expect(screen.getByTestId('photo-count')).toHaveTextContent('30'));
    expect(screen.getByTestId('photo-count')).toHaveClass('text-ok');
  });

  it('flags blurry and near-duplicate shots, and removes them in one tap', async () => {
    restoreImaging = installFakeImaging();
    renderApp('/capture');

    choosePhotos([photo('sharp.jpg', 1), photo('soft.jpg', 0), photo('sharp-again.jpg', 1)]);

    // Analysis runs one photo at a time, so the badges arrive over several ticks.
    expect(await screen.findByText('Blurry')).toBeInTheDocument();
    expect(await screen.findByText('Duplicate')).toBeInTheDocument();

    const summary = await screen.findByTestId('quality-summary');
    await waitFor(() => expect(summary).toHaveTextContent('1 blurry · 1 near-duplicate'));

    fireEvent.click(screen.getByRole('button', { name: /remove 2 flagged/i }));

    await waitFor(() => expect(screen.getByTestId('photo-count')).toHaveTextContent('1'));
    expect(screen.queryByText('Blurry')).not.toBeInTheDocument();
    expect(screen.queryByText('Duplicate')).not.toBeInTheDocument();
    expect(screen.getByTestId('quality-summary')).toHaveTextContent(/look sharp and distinct/i);
  });

  it('skips the checks quietly where the browser cannot decode photos', async () => {
    renderApp('/capture');
    choosePhotos([photo('a.jpg', 1)]);

    await waitFor(() => expect(screen.getByTestId('photo-count')).toHaveTextContent('1'));
    // No canvas in jsdom: no badges, no summary, and certainly no crash.
    expect(screen.queryByTestId('quality-summary')).not.toBeInTheDocument();
    expect(screen.queryByText('Blurry')).not.toBeInTheDocument();
  });
});

describe('capture upload queue', () => {
  it('holds photos for Wi-Fi while offline and sends them when the signal returns', async () => {
    const upload = vi.fn().mockResolvedValue({ uploaded: 2 });
    installQueue(upload);
    setOnline(false);

    renderApp('/capture');

    choosePhotos([photo('a.jpg', 1), photo('b.jpg', 1)]);
    await waitFor(() => expect(screen.getByTestId('photo-count')).toHaveTextContent('2'));
    setProjectId('p1');

    fireEvent.click(screen.getByRole('button', { name: /queue 2 photos for wi-fi/i }));

    const panel = await screen.findByTestId('queue-panel');
    await waitFor(() => expect(panel).toHaveTextContent(/waiting for wi-fi — 2 photos queued/i));
    expect(upload).not.toHaveBeenCalled();
    // The photos left the picker; the queue owns them now.
    expect(screen.getByTestId('photo-count')).toHaveTextContent('0');
    // And the shell says so from anywhere in the app (sidebar + mobile header).
    const indicators = await screen.findAllByTestId('queue-indicator');
    expect(indicators.length).toBeGreaterThan(0);
    expect(indicators[0]).toHaveTextContent(/waiting for wi-fi/i);

    setOnline(true);

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload.mock.calls[0][0]).toBe('p1');
    expect((upload.mock.calls[0][1] as File[]).map((file) => file.name)).toEqual([
      'a.jpg',
      'b.jpg',
    ]);
    await waitFor(() => expect(panel).toHaveTextContent(/uploaded 2 photos/i));
    // Nothing outstanding: the shell indicator disappears again.
    await waitFor(() => expect(screen.queryAllByTestId('queue-indicator')).toHaveLength(0));
  });

  it('offers retry and clear for a batch the server rejected', async () => {
    const upload = vi.fn().mockRejectedValue(
      Object.assign(new Error('Upload failed: Unsupported content type'), { status: 415 }),
    );
    installQueue(upload);

    renderApp('/capture');
    choosePhotos([photo('a.jpg', 1)]);
    await waitFor(() => expect(screen.getByTestId('photo-count')).toHaveTextContent('1'));
    setProjectId('p1');
    fireEvent.click(screen.getByRole('button', { name: /upload 1 photo/i }));

    const panel = await screen.findByTestId('queue-panel');
    // A 4xx is final: no retry storm, just an explanation.
    await waitFor(() => expect(panel).toHaveTextContent(/could not be uploaded/i));
    expect(panel).toHaveTextContent(/unsupported content type/i);
    expect(upload).toHaveBeenCalledTimes(1);

    upload.mockResolvedValue({ uploaded: 1 });
    fireEvent.click(screen.getByRole('button', { name: /retry 1 failed/i }));

    await waitFor(() => expect(panel).toHaveTextContent(/uploaded 1 photo/i));
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('cancels a single queued photo', async () => {
    const upload = vi.fn().mockResolvedValue({ uploaded: 0 });
    installQueue(upload);
    setOnline(false);

    renderApp('/capture');
    choosePhotos([photo('a.jpg', 1), photo('b.jpg', 1)]);
    await waitFor(() => expect(screen.getByTestId('photo-count')).toHaveTextContent('2'));
    setProjectId('p1');
    fireEvent.click(screen.getByRole('button', { name: /queue 2 photos for wi-fi/i }));

    const panel = await screen.findByTestId('queue-panel');
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel a.jpg' }));

    await waitFor(() => expect(panel).toHaveTextContent(/1 photo queued/i));
    expect(within(panel).queryByText('a.jpg')).not.toBeInTheDocument();
    expect(within(panel).getByText('b.jpg')).toBeInTheDocument();
  });
});
