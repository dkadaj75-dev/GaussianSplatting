/**
 * Client-side photo pre-checks (PLAN.md §3: "blur warning … duplicate
 * detection").
 *
 * Two cheap signals, both computed from a small grayscale copy of the photo:
 *
 *   - **Blur** — variance of the 3×3 Laplacian. A sharp frame has lots of
 *     high-frequency energy and therefore a wide spread of Laplacian
 *     responses; a soft one has almost none.
 *   - **Near-duplicate** — a 64-bit average hash (8×8 "aHash") compared by
 *     Hamming distance. Two shots of the same thing from the same spot differ
 *     in only a handful of bits, and SfM gains nothing from the second one.
 *
 * The numeric core is pure and works on a `Uint8ClampedArray`, so it is unit
 * tested without a DOM. Only `assessPhoto` touches canvas/`createImageBitmap`,
 * and it degrades to `null` wherever those are missing (older browsers, jsdom)
 * rather than blocking the capture flow.
 */

/**
 * Longest side of the working copy, in pixels.
 *
 * Small enough that a 12 MP phone photo is analysed in a few milliseconds,
 * large enough that real defocus still reads as missing detail.
 */
export const ANALYSIS_SIZE = 256;

/**
 * Laplacian-variance below which a photo is called blurry.
 *
 * Calibrated for the {@link ANALYSIS_SIZE} grayscale downscale above, not for
 * full-resolution pixels — the two differ by orders of magnitude. Deliberately
 * conservative: it should catch a clearly soft frame, not argue with a
 * shallow-depth-of-field close-up. Note that a very dark or very flat subject
 * (plain concrete, an overcast sky) also scores low; the UI therefore *warns*
 * and lets the user keep the photo.
 */
export const BLUR_VARIANCE_THRESHOLD = 60;

/** Bits in a perceptual hash. */
export const HASH_BITS = 64;

/** Side of the average-hash grid; `HASH_SIDE² === HASH_BITS`. */
const HASH_SIDE = 8;

/**
 * Hamming distance (out of {@link HASH_BITS}) at or below which two photos are
 * treated as the same shot. 5/64 bits tolerates small camera shake and
 * exposure drift while still separating two genuinely different viewpoints.
 */
export const DUPLICATE_HAMMING_THRESHOLD = 5;

/** Rec. 601 luma, the same weighting OpenCV's `COLOR_RGB2GRAY` uses. */
export function toGrayscale(rgba: Uint8ClampedArray): Uint8ClampedArray {
  const gray = new Uint8ClampedArray(rgba.length / 4);
  for (let i = 0, p = 0; p < gray.length; i += 4, p += 1) {
    gray[p] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  }
  return gray;
}

/**
 * Variance of the 3×3 Laplacian `[[0,1,0],[1,-4,1],[0,1,0]]` over the interior
 * pixels of a grayscale bitmap. Higher means sharper. Returns 0 for a bitmap
 * too small to have an interior.
 */
export function laplacianVariance(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
): number {
  if (width < 3 || height < 3 || gray.length < width * height) return 0;

  let sum = 0;
  let sumSquares = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y += 1) {
    const row = y * width;
    for (let x = 1; x < width - 1; x += 1) {
      const index = row + x;
      const response =
        gray[index - width] +
        gray[index + width] +
        gray[index - 1] +
        gray[index + 1] -
        4 * gray[index];
      sum += response;
      sumSquares += response * response;
      count += 1;
    }
  }

  if (count === 0) return 0;
  const mean = sum / count;
  // Population variance; clamped because floating-point cancellation can push
  // a perfectly flat image a hair below zero.
  return Math.max(0, sumSquares / count - mean * mean);
}

/**
 * 64-bit average hash: box-downsample to 8×8, then set one bit per cell that
 * is at or above the mean. Robust to scale, mild blur and exposure shifts —
 * exactly the differences between two shots of the same subject.
 */
export function averageHash(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
): bigint {
  if (width < 1 || height < 1 || gray.length < width * height) return 0n;

  const cells = new Float64Array(HASH_BITS);
  for (let cellY = 0; cellY < HASH_SIDE; cellY += 1) {
    const y0 = Math.floor((cellY * height) / HASH_SIDE);
    const y1 = Math.max(y0 + 1, Math.floor(((cellY + 1) * height) / HASH_SIDE));
    for (let cellX = 0; cellX < HASH_SIDE; cellX += 1) {
      const x0 = Math.floor((cellX * width) / HASH_SIDE);
      const x1 = Math.max(x0 + 1, Math.floor(((cellX + 1) * width) / HASH_SIDE));
      let total = 0;
      let samples = 0;
      for (let y = y0; y < y1 && y < height; y += 1) {
        for (let x = x0; x < x1 && x < width; x += 1) {
          total += gray[y * width + x];
          samples += 1;
        }
      }
      cells[cellY * HASH_SIDE + cellX] = samples === 0 ? 0 : total / samples;
    }
  }

  let mean = 0;
  for (const value of cells) mean += value;
  mean /= HASH_BITS;

  let hash = 0n;
  for (let bit = 0; bit < HASH_BITS; bit += 1) {
    if (cells[bit] >= mean) hash |= 1n << BigInt(bit);
  }
  return hash;
}

/** Number of differing bits between two hashes, 0–{@link HASH_BITS}. */
export function hammingDistance(a: bigint, b: bigint): number {
  let difference = a ^ b;
  let bits = 0;
  while (difference !== 0n) {
    difference &= difference - 1n; // clears the lowest set bit
    bits += 1;
  }
  return bits;
}

/** Hex form of a hash — stable, loggable, and easy to assert on. */
export function formatHash(hash: bigint): string {
  return hash.toString(16).padStart(HASH_BITS / 4, '0');
}

export function isBlurry(blurScore: number): boolean {
  return blurScore < BLUR_VARIANCE_THRESHOLD;
}

export function isNearDuplicate(a: bigint, b: bigint): boolean {
  return hammingDistance(a, b) <= DUPLICATE_HAMMING_THRESHOLD;
}

export interface PhotoAssessment {
  /** Variance of the Laplacian; higher is sharper. */
  blurScore: number;
  /** `blurScore < BLUR_VARIANCE_THRESHOLD`. */
  isBlurry: boolean;
  /** 64-bit average hash for near-duplicate comparison. */
  hash: bigint;
  /** Size of the analysed downscale, not of the original photo. */
  width: number;
  height: number;
}

/** Both signals from an already-decoded grayscale bitmap. Pure. */
export function assessGrayscale(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
): PhotoAssessment {
  const blurScore = laplacianVariance(gray, width, height);
  return {
    blurScore,
    isBlurry: isBlurry(blurScore),
    hash: averageHash(gray, width, height),
    width,
    height,
  };
}

/**
 * The first photo (by list order) whose hash is within
 * {@link DUPLICATE_HAMMING_THRESHOLD} of `hash`, or `null`.
 *
 * Callers pass only the photos *before* the one being checked, so the earlier
 * shot is always the keeper and the later one is the flagged copy.
 */
export function findNearDuplicate<T extends { id: string; hash: bigint }>(
  hash: bigint,
  earlier: readonly T[],
): T | null {
  for (const candidate of earlier) {
    if (isNearDuplicate(hash, candidate.hash)) return candidate;
  }
  return null;
}

/** Target size preserving aspect ratio, longest side capped at `maxSize`. */
export function fitWithin(
  width: number,
  height: number,
  maxSize: number = ANALYSIS_SIZE,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, maxSize / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

// --- Browser bindings --------------------------------------------------------
//
// Everything below needs a DOM. It is deliberately the only part that does.

type Canvas2D = {
  width: number;
  height: number;
  getContext(id: '2d'): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
};

/**
 * Whether photo analysis can run at all.
 *
 * `false` in jsdom and in browsers without `createImageBitmap` — the capture
 * page then simply skips the checks instead of showing broken badges.
 */
export function isPhotoAnalysisSupported(): boolean {
  return (
    typeof createImageBitmap === 'function' &&
    (typeof OffscreenCanvas === 'function' ||
      typeof document?.createElement === 'function')
  );
}

function createCanvas(width: number, height: number): Canvas2D | null {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  if (typeof document?.createElement !== 'function') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Anything `createImageBitmap` accepts, plus a bitmap we already decoded. */
export type PhotoSource = Blob | ImageBitmap;

function isImageBitmap(source: PhotoSource): source is ImageBitmap {
  return typeof ImageBitmap === 'function' && source instanceof ImageBitmap;
}

/**
 * Decodes a photo, downscales it to {@link ANALYSIS_SIZE}, and returns its
 * blur score and perceptual hash.
 *
 * Returns `null` — never throws — when the environment cannot decode or draw
 * (no `createImageBitmap`, no 2D context, a corrupt file). A photo we cannot
 * judge is simply not judged.
 */
export async function assessPhoto(
  source: PhotoSource,
  options: { maxSize?: number } = {},
): Promise<PhotoAssessment | null> {
  const maxSize = options.maxSize ?? ANALYSIS_SIZE;
  let bitmap: ImageBitmap | null = null;
  const ownsBitmap = !isImageBitmap(source);

  try {
    if (isImageBitmap(source)) {
      bitmap = source;
    } else {
      if (typeof createImageBitmap !== 'function') return null;
      bitmap = await createImageBitmap(source);
    }

    const { width, height } = fitWithin(bitmap.width, bitmap.height, maxSize);
    if (width === 0 || height === 0) return null;

    const canvas = createCanvas(width, height);
    if (!canvas) return null;
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    const { data } = context.getImageData(0, 0, width, height);

    return assessGrayscale(toGrayscale(data), width, height);
  } catch {
    // A decode failure must not take the capture page down with it.
    return null;
  } finally {
    if (ownsBitmap) bitmap?.close?.();
  }
}
