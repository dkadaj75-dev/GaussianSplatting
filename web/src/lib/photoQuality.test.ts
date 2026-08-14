import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_SIZE,
  BLUR_VARIANCE_THRESHOLD,
  DUPLICATE_HAMMING_THRESHOLD,
  HASH_BITS,
  assessGrayscale,
  assessPhoto,
  averageHash,
  findNearDuplicate,
  fitWithin,
  formatHash,
  hammingDistance,
  isBlurry,
  isNearDuplicate,
  isPhotoAnalysisSupported,
  laplacianVariance,
  toGrayscale,
} from './photoQuality';

/** Grayscale bitmap from a per-pixel function. */
function gray(width: number, height: number, at: (x: number, y: number) => number) {
  const data = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data[y * width + x] = at(x, y);
  }
  return data;
}

/** A horizontal sinusoid: long period = soft image, short period = crisp detail. */
function sinusoid(size: number, period: number) {
  return gray(size, size, (x) => 128 + 120 * Math.sin((2 * Math.PI * x) / period));
}

function rgbaFrom(values: readonly [number, number, number, number][]) {
  return new Uint8ClampedArray(values.flat());
}

describe('toGrayscale', () => {
  it('applies Rec. 601 luma weights', () => {
    const out = toGrayscale(
      rgbaFrom([
        [255, 255, 255, 255],
        [0, 0, 0, 255],
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
      ]),
    );

    expect(Array.from(out)).toEqual([255, 0, 76, 150, 29]);
  });

  it('produces one sample per pixel', () => {
    expect(toGrayscale(new Uint8ClampedArray(4 * 12))).toHaveLength(12);
  });
});

describe('laplacianVariance', () => {
  it('is zero for a flat image — no detail at all', () => {
    expect(laplacianVariance(gray(16, 16, () => 128), 16, 16)).toBe(0);
  });

  it('is zero for a linear ramp — a gradient carries no high frequencies', () => {
    expect(laplacianVariance(gray(16, 16, (x) => x * 8), 16, 16)).toBeCloseTo(0, 6);
  });

  it('is large for a checkerboard', () => {
    const checker = gray(16, 16, (x, y) => ((x + y) % 2 === 0 ? 255 : 0));
    expect(laplacianVariance(checker, 16, 16)).toBeGreaterThan(10_000);
  });

  it('rises monotonically as detail gets finer', () => {
    const scores = [64, 32, 16, 8, 4].map((period) =>
      laplacianVariance(sinusoid(64, period), 64, 64),
    );
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeGreaterThan(scores[i - 1]);
    }
  });

  it('returns zero rather than NaN for bitmaps with no interior', () => {
    expect(laplacianVariance(gray(2, 2, () => 40), 2, 2)).toBe(0);
    expect(laplacianVariance(new Uint8ClampedArray(0), 0, 0)).toBe(0);
    // Truncated buffer: refuse to read past the end.
    expect(laplacianVariance(new Uint8ClampedArray(9), 16, 16)).toBe(0);
  });
});

describe('blur threshold', () => {
  it('flags a soft frame and clears a detailed one', () => {
    const soft = assessGrayscale(sinusoid(64, 64), 64, 64);
    const crisp = assessGrayscale(sinusoid(64, 4), 64, 64);

    expect(soft.blurScore).toBeLessThan(BLUR_VARIANCE_THRESHOLD);
    expect(soft.isBlurry).toBe(true);
    expect(crisp.blurScore).toBeGreaterThan(BLUR_VARIANCE_THRESHOLD);
    expect(crisp.isBlurry).toBe(false);
  });

  it('treats the threshold itself as sharp enough', () => {
    expect(isBlurry(BLUR_VARIANCE_THRESHOLD)).toBe(false);
    expect(isBlurry(BLUR_VARIANCE_THRESHOLD - 0.001)).toBe(true);
  });
});

describe('averageHash', () => {
  it('sets one bit per 8x8 cell', () => {
    const hash = averageHash(gray(32, 32, (x) => (x < 16 ? 0 : 255)), 32, 32);
    // Right half above the mean, left half below: 4 set bits per row of 8.
    expect(hammingDistance(hash, 0n)).toBe(32);
    expect(formatHash(hash)).toHaveLength(HASH_BITS / 4);
  });

  it('is stable under a small exposure shift and mild noise', () => {
    const scene = (offset: number) =>
      gray(64, 64, (x, y) => 40 + offset + ((x * 3 + y * 7) % 5) + (x < 32 ? 0 : 120));

    const a = averageHash(scene(0), 64, 64);
    const b = averageHash(scene(12), 64, 64);

    expect(hammingDistance(a, b)).toBeLessThanOrEqual(DUPLICATE_HAMMING_THRESHOLD);
    expect(isNearDuplicate(a, b)).toBe(true);
  });

  it('separates genuinely different framings', () => {
    const left = averageHash(gray(64, 64, (x) => (x < 32 ? 255 : 0)), 64, 64);
    const top = averageHash(gray(64, 64, (_x, y) => (y < 32 ? 255 : 0)), 64, 64);

    expect(hammingDistance(left, top)).toBeGreaterThan(DUPLICATE_HAMMING_THRESHOLD);
    expect(isNearDuplicate(left, top)).toBe(false);
  });

  it('is survivable for degenerate input', () => {
    expect(averageHash(new Uint8ClampedArray(0), 0, 0)).toBe(0n);
    expect(averageHash(new Uint8ClampedArray(4), 16, 16)).toBe(0n);
  });
});

describe('hammingDistance', () => {
  it('counts differing bits', () => {
    expect(hammingDistance(0n, 0n)).toBe(0);
    expect(hammingDistance(0b1011n, 0b1110n)).toBe(2);
    // Every bit inverted.
    const all = (1n << 64n) - 1n;
    expect(hammingDistance(all, 0n)).toBe(HASH_BITS);
  });
});

describe('findNearDuplicate', () => {
  const earlier = [
    { id: 'a', hash: 0b1111n },
    { id: 'b', hash: (1n << 40n) | 0b101n },
  ];

  it('returns the first earlier photo within the threshold', () => {
    // One bit away from 'a'.
    expect(findNearDuplicate(0b1110n, earlier)?.id).toBe('a');
  });

  it('returns null when nothing is close', () => {
    const far = (1n << 63n) | (1n << 62n) | (1n << 61n) | (1n << 60n) | (1n << 59n) | (1n << 58n);
    expect(findNearDuplicate(far, earlier)).toBeNull();
    expect(findNearDuplicate(0b1111n, [])).toBeNull();
  });
});

describe('fitWithin', () => {
  it('caps the longest side and keeps the aspect ratio', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: ANALYSIS_SIZE, height: 192 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 192, height: ANALYSIS_SIZE });
  });

  it('never upscales, and never rounds a side to zero', () => {
    expect(fitWithin(100, 50)).toEqual({ width: 100, height: 50 });
    expect(fitWithin(1000, 2, 256)).toEqual({ width: 256, height: 1 });
    expect(fitWithin(0, 0)).toEqual({ width: 0, height: 0 });
  });
});

describe('assessPhoto in an environment without canvas', () => {
  it('reports analysis as unsupported under jsdom', () => {
    // jsdom implements neither createImageBitmap nor a 2D context; the capture
    // page relies on this being detectable rather than throwing.
    expect(isPhotoAnalysisSupported()).toBe(false);
  });

  it('resolves to null instead of throwing', async () => {
    await expect(assessPhoto(new Blob(['not an image']))).resolves.toBeNull();
  });
});
