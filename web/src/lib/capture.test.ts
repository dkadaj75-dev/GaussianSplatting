import { describe, expect, it, vi } from 'vitest';
import {
  canvasToBlob,
  composeFrame,
  dataUrlToBlob,
  downloadBlob,
  isFrameBlank,
  reportFilename,
} from './capture';

/**
 * A 2D context that records what was asked of it.
 *
 * jsdom has no canvas implementation, and pulling one in for a screenshot
 * helper would be a heavy dependency for very little; what matters here is
 * that the frame goes down first, the chips land on top of it in the right
 * places, and the caption is drawn — all of which are calls, not pixels.
 */
function fakeContext() {
  const calls: { op: string; args: unknown[] }[] = [];
  const record =
    (op: string) =>
    (...args: unknown[]) => {
      calls.push({ op, args });
    };
  return {
    calls,
    context: {
      canvas: null as unknown,
      scale: record('scale'),
      fillRect: record('fillRect'),
      drawImage: record('drawImage'),
      fillText: record('fillText'),
      beginPath: record('beginPath'),
      roundRect: record('roundRect'),
      rect: record('rect'),
      fill: record('fill'),
      stroke: record('stroke'),
      measureText: (text: string) => ({ width: text.length * 6 }),
      set font(_value: string) {},
      set fillStyle(_value: string) {},
      set strokeStyle(_value: string) {},
      set lineWidth(_value: number) {},
      set textBaseline(_value: string) {},
    } as unknown as CanvasRenderingContext2D,
  };
}

function fakeCanvas(context: CanvasRenderingContext2D | null) {
  return {
    width: 0,
    height: 0,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
}

const SOURCE = { nodeName: 'CANVAS' } as unknown as CanvasImageSource;

describe('composeFrame', () => {
  it('sizes the output for the pixel ratio and draws the frame first', () => {
    const { calls, context } = fakeContext();
    const canvas = fakeCanvas(context);

    const result = composeFrame({
      source: SOURCE,
      width: 390,
      height: 700,
      pixelRatio: 2,
      createCanvas: () => canvas,
    });

    expect(result).toBe(canvas);
    expect(canvas.width).toBe(780);
    expect(canvas.height).toBe(1400);
    expect(calls[0]).toEqual({ op: 'scale', args: [2, 2] });
    // An opaque ground first: a JPEG has no alpha to fall back on.
    expect(calls[1].op).toBe('fillRect');
    expect(calls[2]).toEqual({ op: 'drawImage', args: [SOURCE, 0, 0, 390, 700] });
  });

  it('draws each label chip centred above its point', () => {
    const { calls, context } = fakeContext();
    composeFrame({
      source: SOURCE,
      width: 400,
      height: 300,
      labels: [{ text: 'M1 · 412 mm', detail: '± 6 mm', x: 200, y: 150, tone: 'measure' }],
      createCanvas: () => fakeCanvas(context),
    });

    const chip = calls.find((call) => call.op === 'roundRect');
    expect(chip).toBeDefined();
    const [x, y, width] = chip!.args as number[];
    expect(x + width / 2).toBeCloseTo(200, 6);
    // Above the anchor, like the DOM chip it is standing in for.
    expect(y).toBeLessThan(150);

    const texts = calls.filter((call) => call.op === 'fillText').map((call) => call.args[0]);
    expect(texts).toContain('M1 · 412 mm');
    expect(texts).toContain(' ± 6 mm');
  });

  it('skips a label whose position is not a number', () => {
    const { calls, context } = fakeContext();
    composeFrame({
      source: SOURCE,
      width: 400,
      height: 300,
      labels: [{ text: 'M1', x: Number.NaN, y: 10 }],
      createCanvas: () => fakeCanvas(context),
    });
    expect(calls.some((call) => call.op === 'fillText')).toBe(false);
  });

  it('adds a caption bar under the frame so the picture stands alone', () => {
    const { calls, context } = fakeContext();
    const canvas = fakeCanvas(context);
    composeFrame({
      source: SOURCE,
      width: 400,
      height: 300,
      caption: { title: 'Balcony anchor detail', subtitle: '14 Aug 2026 · calibrated' },
      createCanvas: () => canvas,
    });

    expect(canvas.height).toBe(344);
    const texts = calls.filter((call) => call.op === 'fillText').map((call) => call.args[0]);
    expect(texts).toEqual(['Balcony anchor detail', '14 Aug 2026 · calibrated']);
  });

  it('gives up rather than throwing when there is no 2D context', () => {
    expect(
      composeFrame({
        source: SOURCE,
        width: 10,
        height: 10,
        createCanvas: () => fakeCanvas(null),
      }),
    ).toBeNull();
  });
});

describe('isFrameBlank', () => {
  function canvasWithAlpha(alpha: number) {
    return {
      width: 64,
      height: 64,
      getContext: () => ({
        getImageData: () => ({ data: [0, 0, 0, alpha] }),
      }),
    } as unknown as HTMLCanvasElement;
  }

  it('spots a frame the drawing buffer had already discarded', () => {
    expect(isFrameBlank(canvasWithAlpha(0))).toBe(true);
  });

  it('does not mistake a legitimately black scene for an empty one', () => {
    expect(isFrameBlank(canvasWithAlpha(255))).toBe(false);
  });

  it('treats an unreadable canvas as fine rather than blocking the export', () => {
    const tainted = {
      width: 10,
      height: 10,
      getContext: () => ({
        getImageData: () => {
          throw new Error('tainted');
        },
      }),
    } as unknown as HTMLCanvasElement;
    expect(isFrameBlank(tainted)).toBe(false);
  });

  it('is blank when there is nothing to read at all', () => {
    expect(isFrameBlank({ width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement)).toBe(
      true,
    );
  });
});

describe('dataUrlToBlob', () => {
  it('decodes base64 payloads', async () => {
    const blob = dataUrlToBlob('data:image/png;base64,QUJD');
    expect(blob?.type).toBe('image/png');
    expect(await blob!.text()).toBe('ABC');
  });

  it('decodes plain payloads and rejects junk', async () => {
    const blob = dataUrlToBlob('data:text/plain,hello%20there');
    expect(await blob!.text()).toBe('hello there');
    expect(dataUrlToBlob('not-a-data-url')).toBeNull();
  });
});

describe('canvasToBlob', () => {
  it('uses toBlob when the browser has it', async () => {
    const blob = new Blob(['x']);
    const canvas = {
      toBlob: (callback: (value: Blob | null) => void, type: string, quality?: number) => {
        expect(type).toBe('image/jpeg');
        expect(quality).toBe(0.82);
        callback(blob);
      },
    } as unknown as HTMLCanvasElement;
    await expect(canvasToBlob(canvas, 'image/jpeg', 0.82)).resolves.toBe(blob);
  });

  it('falls back to a data URL where toBlob is missing', async () => {
    const canvas = {
      toDataURL: () => 'data:image/png;base64,QUJD',
    } as unknown as HTMLCanvasElement;
    const blob = await canvasToBlob(canvas, 'image/png');
    expect(await blob!.text()).toBe('ABC');
  });

  it('resolves null when the browser can do neither', async () => {
    await expect(canvasToBlob({} as HTMLCanvasElement, 'image/png')).resolves.toBeNull();
  });
});

describe('downloadBlob', () => {
  it('clicks a temporary anchor and cleans up after itself', () => {
    vi.useFakeTimers();
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:mock-download');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.download).toBe('report.pdf');
      expect(this.href).toBe('blob:mock-download');
      // Still in the document at click time — Firefox ignores a detached one.
      expect(this.isConnected).toBe(true);
    });

    downloadBlob(new Blob(['%PDF']), 'report.pdf');

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(document.querySelector('a[download]')).toBeNull();
    // Revoked on the next tick, not synchronously: that would race the save.
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-download');
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
});

describe('reportFilename', () => {
  it('slugs the project name and stamps the date', () => {
    expect(reportFilename('Balcony anchor detail — Site A', 'pdf', new Date(2026, 7, 14))).toBe(
      'balcony-anchor-detail-site-a-2026-08-14.pdf',
    );
  });

  it('always produces a usable name', () => {
    expect(reportFilename('   ', 'png', new Date(2026, 0, 2))).toBe('splatscene-scene-2026-01-02.png');
    expect(reportFilename('///', 'png', new Date(2026, 0, 2))).toBe('splatscene-scene-2026-01-02.png');
    expect(reportFilename('x'.repeat(200), 'pdf', new Date(2026, 0, 2)).length).toBeLessThan(80);
  });
});
