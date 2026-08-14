/**
 * Turning the live viewer into a picture (WP 5.3).
 *
 * The scene, its markers and its segments are all drawn by WebGL, but the
 * label chips are real DOM (see `measurementOverlay`) — crisp text beats a
 * canvas-texture sprite on a phone, and it costs nothing at render time. That
 * means a screenshot has to put the two back together: the WebGL frame goes
 * into a 2D canvas, and the chips are re-drawn on top at the positions the
 * overlay last projected them to.
 *
 * The timing constraint is the reason `composeFrame` takes an already-rendered
 * canvas rather than rendering itself: with `preserveDrawingBuffer` off (which
 * is what keeps the viewer fast on mobile GPUs), a WebGL drawing buffer is
 * only readable between the draw call and the browser's next composite. The
 * caller therefore renders and composes inside one task; {@link isFrameBlank}
 * catches the case where that window was missed anyway, so the user gets an
 * explanation instead of a black rectangle.
 */

export interface CaptureLabel {
  text: string;
  /** The ± line, drawn dimmer beside the value. */
  detail?: string | null;
  /** CSS pixels from the top-left of the source canvas. */
  x: number;
  y: number;
  /** `calibration` and `plane` labels get their own border colour. */
  tone?: 'measure' | 'pending' | 'calibration' | 'plane';
}

export interface CaptionInput {
  title: string;
  subtitle: string;
}

export interface ComposeFrameOptions {
  /** The WebGL canvas, rendered in this same task. */
  source: CanvasImageSource;
  /** Size of the source in CSS pixels. */
  width: number;
  height: number;
  /** Output scale; 2 gives a retina-sharp PNG from a 1x layout. */
  pixelRatio?: number;
  labels?: readonly CaptureLabel[];
  /** Bar drawn under the frame so the image stands alone in an email. */
  caption?: CaptionInput | null;
  /** Injected by tests; defaults to `document.createElement('canvas')`. */
  createCanvas?: (width: number, height: number) => HTMLCanvasElement;
}

const CAPTION_HEIGHT = 44;
const CHIP_FONT = '600 12px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const DETAIL_FONT = '400 12px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

const TONE_BORDER: Record<string, string> = {
  measure: 'rgba(255,255,255,0.25)',
  pending: 'rgba(255,255,255,0.25)',
  calibration: 'rgba(251,191,36,0.7)',
  plane: 'rgba(92,214,160,0.7)',
};

function defaultCreateCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** `roundRect` is recent; a plain rectangle is a fine fallback. */
function chipPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, 4);
  } else {
    ctx.rect(x, y, w, h);
  }
}

/**
 * Composites the rendered frame, the label chips and an optional caption bar
 * into a fresh 2D canvas. Returns `null` when a 2D context is unavailable.
 */
export function composeFrame(options: ComposeFrameOptions): HTMLCanvasElement | null {
  const ratio = Math.max(options.pixelRatio ?? 1, 0.1);
  const width = Math.max(Math.round(options.width), 1);
  const height = Math.max(Math.round(options.height), 1);
  const captionHeight = options.caption ? CAPTION_HEIGHT : 0;

  const create = options.createCanvas ?? defaultCreateCanvas;
  const canvas = create(Math.round(width * ratio), Math.round((height + captionHeight) * ratio));
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round((height + captionHeight) * ratio);

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.scale(ratio, ratio);
  // A JPEG has no alpha; without a ground the report image would come out with
  // black-on-black artefacts wherever the scene did not draw.
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height + captionHeight);
  ctx.drawImage(options.source, 0, 0, width, height);

  ctx.textBaseline = 'alphabetic';
  for (const label of options.labels ?? []) {
    if (!Number.isFinite(label.x) || !Number.isFinite(label.y)) continue;
    ctx.font = CHIP_FONT;
    const textWidth = ctx.measureText(label.text).width;
    ctx.font = DETAIL_FONT;
    const detailWidth = label.detail ? ctx.measureText(` ${label.detail}`).width : 0;

    const boxWidth = textWidth + detailWidth + 12;
    const boxHeight = 20;
    // Same anchoring as the DOM chip: centred above the point it belongs to.
    const boxX = label.x - boxWidth / 2;
    const boxY = label.y - boxHeight * 1.4;

    ctx.fillStyle = 'rgba(10,10,10,0.88)';
    chipPath(ctx, boxX, boxY, boxWidth, boxHeight);
    ctx.fill();
    ctx.strokeStyle = TONE_BORDER[label.tone ?? 'measure'] ?? TONE_BORDER.measure;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = CHIP_FONT;
    ctx.fillText(label.text, boxX + 6, boxY + 14);
    if (label.detail) {
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.font = DETAIL_FONT;
      ctx.fillText(` ${label.detail}`, boxX + 6 + textWidth, boxY + 14);
    }
  }

  if (options.caption) {
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, height, width, captionHeight);
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fillRect(0, height, width, 1);
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(options.caption.title, 12, height + 19);
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = '400 11px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(options.caption.subtitle, 12, height + 34);
  }

  return canvas;
}

/**
 * True when nothing was actually read out of the WebGL buffer.
 *
 * A rendered frame is opaque (the renderer clears with alpha 1), so a grid of
 * fully transparent samples means the drawing buffer had already been
 * discarded. A legitimately black scene is *not* blank by this test.
 */
export function isFrameBlank(canvas: HTMLCanvasElement, samples = 8): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx || canvas.width === 0 || canvas.height === 0) return true;
  try {
    for (let row = 0; row < samples; row += 1) {
      for (let column = 0; column < samples; column += 1) {
        const x = Math.min(Math.floor(((column + 0.5) / samples) * canvas.width), canvas.width - 1);
        const y = Math.min(Math.floor(((row + 0.5) / samples) * canvas.height), canvas.height - 1);
        if (ctx.getImageData(x, y, 1, 1).data[3] !== 0) return false;
      }
    }
  } catch {
    // A tainted canvas cannot be inspected; assume the frame is fine and let
    // the export proceed rather than refusing on a technicality.
    return false;
  }
  return true;
}

/** Decodes a `data:` URL into a Blob — the fallback path for `toBlob`. */
export function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const [, type = 'application/octet-stream', base64, payload] = match;
  if (!base64) return new Blob([decodeURIComponent(payload)], { type });
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** `canvas.toBlob` as a promise, falling back to `toDataURL` where it is missing. */
export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob | null> {
  if (typeof canvas.toBlob === 'function') {
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    });
  }
  if (typeof canvas.toDataURL === 'function') {
    return Promise.resolve(dataUrlToBlob(canvas.toDataURL(type, quality)));
  }
  return Promise.resolve(null);
}

/**
 * Hands the user a file.
 *
 * An anchor with an object URL is the only approach that works in every
 * browser this PWA targets, including iOS Safari, where a blob URL opened in a
 * new tab would be a dead end. The URL is revoked on the next tick — revoking
 * it synchronously races the download in Firefox.
 */
export function downloadBlob(blob: Blob, filename: string, doc: Document = document): void {
  const url = URL.createObjectURL(blob);
  const anchor = doc.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  doc.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** `balcony-anchor-detail-2026-08-14.pdf` — safe on every filesystem. */
export function reportFilename(name: string, extension: string, date: Date = new Date()): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'splatscene-scene';
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${slug}-${stamp}.${extension}`;
}
