/**
 * A minimal PDF writer — enough for a one-page measurement report (WP 5.3).
 *
 * Why hand-rolled rather than a library: the report is one page of Helvetica
 * text, a few rules and one screenshot, and a PDF is a text container with a
 * byte-offset table at the end. That is a couple of hundred lines, it adds no
 * npm dependency to a PWA that has to install over a site connection, and —
 * unlike `window.print()` — it produces an actual file the user can attach to
 * an email from a phone, which is the whole point of a construction hand-off
 * (PLAN.md §3 "Share / Export").
 *
 * The one genuinely fiddly part is the cross-reference table: every object's
 * byte offset has to be exact or the file will not open. So the document is
 * assembled as byte chunks with a running offset rather than as a string that
 * gets encoded at the end, and the tests read the offsets back out and check
 * that each one lands on its `N 0 obj`.
 *
 * Encoding is WinAnsi (Latin-1): the degree sign and ± that every measurement
 * needs are single bytes there, so no font embedding is required.
 */

/** A4 portrait, in PDF points (1/72"). */
export const A4_WIDTH = 595.28;
export const A4_HEIGHT = 841.89;

export interface PdfImage {
  /** Raw JPEG (`/DCTDecode`) bytes — exactly what `canvas.toBlob('image/jpeg')` gives. */
  jpeg: Uint8Array;
  width: number;
  height: number;
}

export interface TextOptions {
  size?: number;
  bold?: boolean;
  /** 0 = black, 1 = white. */
  gray?: number;
}

export interface LineOptions {
  width?: number;
  gray?: number;
}

export interface RectOptions {
  /** Fill grey; omit for no fill. */
  fill?: number;
}

export interface PdfDocument {
  /** Draws text with its **baseline** at `y`, measured from the top of the page. */
  text: (x: number, y: number, value: string, options?: TextOptions) => void;
  line: (x1: number, y1: number, x2: number, y2: number, options?: LineOptions) => void;
  rect: (x: number, y: number, width: number, height: number, options?: RectOptions) => void;
  /** Draws the document's image with its **top-left** at `x, y`. */
  image: (x: number, y: number, width: number, height: number) => void;
  /** The finished file. Typed with a plain `ArrayBuffer` so it goes straight into a `Blob`. */
  build: () => Uint8Array<ArrayBuffer>;
}

export interface PdfOptions {
  width?: number;
  height?: number;
  image?: PdfImage | null;
  title?: string;
  /** Overrides the creation date; supplied by tests for a byte-stable file. */
  now?: Date;
}

// --- Helvetica metrics -------------------------------------------------------
//
// Widths in 1/1000 em for ASCII 32–126, from the Adobe core-14 AFMs. They are
// only needed to wrap and right-align text, but "only" still means a number
// column that does not drift.

const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
  611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/**
 * WinAnsi is not Latin-1: 0x80–0x9F carry typographic punctuation instead of
 * control codes. This app's own strings are full of em dashes and middle dots,
 * so those get their real glyph rather than a `?`.
 */
const WINANSI: Record<number, number> = {
  0x2013: 0x96, // –
  0x2014: 0x97, // —
  0x2018: 0x91, // '
  0x2019: 0x92, // '
  0x201c: 0x93, // "
  0x201d: 0x94, // "
  0x2022: 0x95, // •
  0x2026: 0x85, // …
  0x20ac: 0x80, // €
  0x2122: 0x99, // ™
};

/** The non-ASCII characters a measurement report actually reaches for. */
const EXTRA_WIDTHS: Record<number, number> = {
  0xb0: 400, // degree sign
  0xb1: 584, // plus-minus
  0xb7: 278, // middle dot
  0xd7: 584, // multiplication sign
  0x2013: 556, // en dash
  0x2014: 1000, // em dash
  0x2018: 222,
  0x2019: 222,
  0x201c: 333,
  0x201d: 333,
  0x2022: 350,
  0x2026: 1000, // ellipsis
};

/** Width of `text` at `size` points, in points. */
export function textWidth(text: string, size: number, bold = false): number {
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  let total = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 32;
    const width =
      code >= 32 && code <= 126
        ? table[code - 32]
        : (EXTRA_WIDTHS[code] ?? (bold ? HELVETICA_BOLD[0] : HELVETICA[0]));
    total += width;
  }
  return (total * size) / 1000;
}

/** Greedy word wrap. Words longer than the line are left long rather than cut. */
export function wrapText(text: string, maxWidth: number, size: number, bold = false): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && textWidth(candidate, size, bold) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Shortens to fit, with an ellipsis, so a long label cannot invade the next column. */
export function truncateToWidth(text: string, maxWidth: number, size: number, bold = false): string {
  if (textWidth(text, size, bold) <= maxWidth) return text;
  let clipped = text;
  while (clipped.length > 1 && textWidth(`${clipped}…`, size, bold) > maxWidth) {
    clipped = clipped.slice(0, -1);
  }
  return `${clipped}…`;
}

// --- Byte plumbing -----------------------------------------------------------

/**
 * WinAnsi bytes. Anything the encoding cannot carry becomes `?` — a wrong
 * glyph is better than a corrupt file, and every string here comes from our
 * own formatters, which stay inside it.
 */
function latin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    bytes[i] = WINANSI[code] ?? (code <= 0xff ? code : 0x3f);
  }
  return bytes;
}

/** Escapes what a PDF literal string cannot contain. */
function pdfString(text: string): string {
  return text.replace(/[\r\n\t]/g, ' ').replace(/[\\()]/g, (match) => `\\${match}`);
}

function pdfDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

function concat(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Creates a one-page document.
 *
 * The page is drawn with a **top-left origin** (y grows downwards) because
 * every layout in this app thinks that way; the flip into PDF's bottom-left
 * space happens here, once.
 */
export function createPdf(options: PdfOptions = {}): PdfDocument {
  const width = options.width ?? A4_WIDTH;
  const height = options.height ?? A4_HEIGHT;
  const image = options.image ?? null;
  const content: string[] = [];

  const flip = (y: number) => height - y;
  const round = (value: number) => Number(value.toFixed(2));

  return {
    text(x, y, value, textOptions = {}) {
      const size = textOptions.size ?? 10;
      const gray = textOptions.gray ?? 0;
      const font = textOptions.bold ? '/F2' : '/F1';
      content.push(
        `BT ${gray} g ${font} ${size} Tf 1 0 0 1 ${round(x)} ${round(flip(y))} Tm (${pdfString(
          value,
        )}) Tj ET`,
      );
    },

    line(x1, y1, x2, y2, lineOptions = {}) {
      content.push(
        `q ${lineOptions.gray ?? 0} G ${lineOptions.width ?? 0.5} w ${round(x1)} ${round(
          flip(y1),
        )} m ${round(x2)} ${round(flip(y2))} l S Q`,
      );
    },

    rect(x, y, rectWidth, rectHeight, rectOptions = {}) {
      if (rectOptions.fill === undefined) return;
      content.push(
        `q ${rectOptions.fill} g ${round(x)} ${round(flip(y + rectHeight))} ${round(
          rectWidth,
        )} ${round(rectHeight)} re f Q`,
      );
    },

    image(x, y, imageWidth, imageHeight) {
      if (!image) return;
      content.push(
        `q ${round(imageWidth)} 0 0 ${round(imageHeight)} ${round(x)} ${round(
          flip(y + imageHeight),
        )} cm /Im0 Do Q`,
      );
    },

    build() {
      const stream = content.join('\n');
      const objects: Uint8Array[] = [];

      const push = (body: string, binary?: Uint8Array) => {
        objects.push(binary ? concat([latin1(body), binary, latin1('\nendstream\nendobj\n')]) : latin1(body));
      };

      const resources = [
        '/Font << /F1 5 0 R /F2 6 0 R >>',
        image ? '/XObject << /Im0 7 0 R >>' : '',
      ]
        .filter(Boolean)
        .join(' ');

      push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
      push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
      push(
        `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${round(width)} ${round(
          height,
        )}] /Resources << ${resources} >> /Contents 4 0 R >>\nendobj\n`,
      );
      push(
        `4 0 obj\n<< /Length ${latin1(stream).length} >>\nstream\n${stream}\nendstream\nendobj\n`,
      );
      push(
        '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n',
      );
      push(
        '6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n',
      );
      if (image) {
        push(
          `7 0 obj\n<< /Type /XObject /Subtype /Image /Width ${Math.round(
            image.width,
          )} /Height ${Math.round(image.height)} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${
            image.jpeg.length
          } >>\nstream\n`,
          image.jpeg,
        );
      }
      const infoNumber = objects.length + 1;
      push(
        `${infoNumber} 0 obj\n<< /Producer (SplatScene) /Title (${pdfString(
          options.title ?? 'Measurement report',
        )}) /CreationDate (${pdfDate(options.now ?? new Date())}) >>\nendobj\n`,
      );

      // A binary comment on line 2 tells every reader this is not plain text.
      const header = concat([latin1('%PDF-1.4\n'), new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])]);

      const offsets: number[] = [];
      let cursor = header.length;
      for (const object of objects) {
        offsets.push(cursor);
        cursor += object.length;
      }

      const count = objects.length + 1;
      let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
      for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
      const trailer =
        `trailer\n<< /Size ${count} /Root 1 0 R /Info ${infoNumber} 0 R >>\n` +
        `startxref\n${cursor}\n%%EOF\n`;

      return concat([header, ...objects, latin1(xref), latin1(trailer)]);
    },
  };
}
