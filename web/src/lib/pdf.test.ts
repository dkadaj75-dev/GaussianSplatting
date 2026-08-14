import { describe, expect, it } from 'vitest';
import { A4_HEIGHT, createPdf, textWidth, truncateToWidth, wrapText } from './pdf';

/** The file as a byte-per-character string, so offsets are indexes. */
function asLatin1(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

/**
 * Byte offsets from the cross-reference table, in object order.
 *
 * Anchored on `\nxref\n` rather than `xref`, which also lives inside the
 * `startxref` keyword at the end of the file.
 */
function xrefOffsets(text: string): number[] {
  const start = text.lastIndexOf('\nxref\n');
  const entries = [...text.slice(start).matchAll(/^(\d{10}) (\d{5}) ([nf]) $/gm)];
  return entries.filter((entry) => entry[3] === 'n').map((entry) => Number(entry[1]));
}

const FIXED_DATE = new Date(Date.UTC(2026, 7, 14, 9, 5, 0));

describe('document structure', () => {
  const bytes = createPdf({ now: FIXED_DATE }).build();
  const text = asLatin1(bytes);

  it('is a PDF, marked binary, and ends where it says', () => {
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    // The high-bit comment on line two keeps tools from mangling it as text.
    expect(bytes[9]).toBe(0x25);
    expect(bytes[10]).toBeGreaterThan(0x7f);
    expect(text.endsWith('%%EOF\n')).toBe(true);
  });

  it('has a catalog, a page tree, one page and both fonts', () => {
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('/Type /Pages');
    expect(text).toContain('/Kids [3 0 R] /Count 1');
    expect(text).toContain('/BaseFont /Helvetica /Encoding /WinAnsiEncoding');
    expect(text).toContain('/BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding');
    expect(text).toContain(`/MediaBox [0 0 595.28 ${A4_HEIGHT}]`);
  });

  it('points every cross-reference entry at its object — the thing that breaks first', () => {
    const offsets = xrefOffsets(text);
    expect(offsets.length).toBeGreaterThanOrEqual(6);
    offsets.forEach((offset, index) => {
      expect(text.slice(offset, offset + 10)).toMatch(new RegExp(`^${index + 1} 0 obj`));
    });
  });

  it('points startxref at the cross-reference table', () => {
    const startxref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
    expect(Number(/\/Size (\d+)/.exec(text)![1])).toBe(xrefOffsets(text).length + 1);
  });

  it('declares the true byte length of the content stream', () => {
    const declared = Number(/<< \/Length (\d+) >>\nstream\n/.exec(text)![1]);
    const start = text.indexOf('stream\n') + 'stream\n'.length;
    const end = text.indexOf('\nendstream', start);
    expect(end - start).toBe(declared);
  });

  it('records the creation date it was given', () => {
    expect(text).toContain('(D:20260814090500Z)');
  });
});

describe('drawing', () => {
  it('flips y so the caller can lay out from the top', () => {
    const pdf = createPdf({ now: FIXED_DATE });
    pdf.text(48, 100, 'Balcony anchor detail', { size: 18, bold: true });
    const text = asLatin1(pdf.build());
    // Baseline 100 from the top of an A4 page is 741.89 from the bottom.
    expect(text).toContain('/F2 18 Tf 1 0 0 1 48 741.89 Tm (Balcony anchor detail) Tj');
  });

  it('writes lines, filled rectangles and nothing for an unfilled one', () => {
    const pdf = createPdf({ now: FIXED_DATE });
    pdf.line(48, 100, 548, 100, { gray: 0.75, width: 0.5 });
    pdf.rect(48, 120, 100, 10, { fill: 0.9 });
    pdf.rect(48, 140, 100, 10);
    const text = asLatin1(pdf.build());
    expect(text).toContain('0.75 G 0.5 w 48 741.89 m 548 741.89 l S Q');
    expect(text).toContain('0.9 g 48 711.89 100 10 re f Q');
    expect(text.match(/re f/g)).toHaveLength(1);
  });

  it('escapes what would otherwise close a string early', () => {
    const pdf = createPdf({ now: FIXED_DATE });
    pdf.text(0, 0, 'Corner (north\\west) — 90°');
    const text = asLatin1(pdf.build());
    expect(text).toContain('(Corner \\(north\\\\west\\) ');
    // The degree sign survives as a single WinAnsi byte.
    expect(text).toContain(String.fromCharCode(0xb0));
  });

  it('replaces characters WinAnsi cannot carry instead of corrupting the file', () => {
    const pdf = createPdf({ now: FIXED_DATE });
    pdf.text(0, 0, 'Балкон ± 5 mm');
    const text = asLatin1(pdf.build());
    expect(text).toContain(`(?????? ${String.fromCharCode(0xb1)} 5 mm)`);
    const declared = Number(/<< \/Length (\d+) >>\nstream\n/.exec(text)![1]);
    const start = text.indexOf('stream\n') + 'stream\n'.length;
    expect(text.indexOf('\nendstream', start) - start).toBe(declared);
  });
});

describe('an embedded image', () => {
  // Not a real JPEG — the writer copies the bytes verbatim, which is the point.
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xff, 0xd9]);
  const pdf = createPdf({ image: { jpeg, width: 800, height: 450 }, now: FIXED_DATE });
  pdf.image(48, 200, 400, 225);
  const bytes = pdf.build();
  const text = asLatin1(bytes);

  it('declares a DCTDecode XObject of the right size', () => {
    expect(text).toContain(
      '/Subtype /Image /Width 800 /Height 450 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length 10',
    );
    expect(text).toContain('/XObject << /Im0 7 0 R >>');
  });

  it('embeds the bytes untouched and places the image', () => {
    const start = text.indexOf('/DCTDecode /Length 10 >>\nstream\n') + '/DCTDecode /Length 10 >>\nstream\n'.length;
    expect([...bytes.slice(start, start + jpeg.length)]).toEqual([...jpeg]);
    expect(text).toContain('q 400 0 0 225 48 416.89 cm /Im0 Do Q');
  });

  it('keeps the cross-reference table correct across the binary object', () => {
    xrefOffsets(text).forEach((offset, index) => {
      expect(text.slice(offset, offset + 10)).toMatch(new RegExp(`^${index + 1} 0 obj`));
    });
  });

  it('draws nothing when the document carries no image', () => {
    const empty = createPdf({ now: FIXED_DATE });
    empty.image(0, 0, 10, 10);
    const emptyText = asLatin1(empty.build());
    expect(emptyText).not.toContain('/Im0 Do');
    expect(emptyText).not.toContain('/XObject');
  });
});

describe('text metrics', () => {
  it('measures Helvetica, and bold wider than regular', () => {
    // Ten digits at 10 pt: 556/1000 each.
    expect(textWidth('0123456789', 10)).toBeCloseTo(55.6, 6);
    expect(textWidth('Measurements', 10, true)).toBeGreaterThan(textWidth('Measurements', 10));
    expect(textWidth('', 10)).toBe(0);
  });

  it('knows the width of the characters a report actually uses', () => {
    expect(textWidth('°', 10)).toBeCloseTo(4, 6);
    expect(textWidth('±', 10)).toBeCloseTo(5.84, 6);
  });

  it('wraps on words and leaves an over-long word intact', () => {
    const lines = wrapText('Calibrated automatically from a printed marker', 100, 10);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(0, -1)) expect(textWidth(line, 10)).toBeLessThanOrEqual(100);
    expect(wrapText('supercalifragilistic', 10, 10)).toEqual(['supercalifragilistic']);
    expect(wrapText('   ', 100, 10)).toEqual([]);
  });

  it('truncates with an ellipsis rather than overflowing a column', () => {
    expect(truncateToWidth('M1', 100, 9.5)).toBe('M1');
    const clipped = truncateToWidth('Balcony anchor detail, west corner', 60, 9.5);
    expect(clipped.endsWith('…')).toBe(true);
    expect(textWidth(clipped, 9.5)).toBeLessThanOrEqual(60);
  });
});

describe('WinAnsi punctuation', () => {
  it('keeps the em dash and the ellipsis this app writes everywhere', () => {
    const pdf = createPdf({ now: FIXED_DATE });
    pdf.text(0, 0, 'Balcony — Site A · 1 of 3…');
    const text = asLatin1(pdf.build());
    // 0x97 em dash, 0xb7 middle dot, 0x85 ellipsis — real glyphs, not '?'.
    expect(text).toContain(
      `(Balcony ${String.fromCharCode(0x97)} Site A ${String.fromCharCode(0xb7)} 1 of 3${String.fromCharCode(0x85)})`,
    );
  });
});
