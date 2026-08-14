/**
 * The measurement report (WP 5.3, PLAN.md §3 "Share / Export").
 *
 * Two halves, deliberately apart:
 *
 * - {@link buildReport} turns the session's rows into the exact strings that
 *   will be printed. It is pure, so what the report says can be tested without
 *   producing a single byte of PDF.
 * - {@link renderReportPdf} lays those strings out on one A4 page with
 *   `lib/pdf`.
 *
 * The report is the artefact that leaves the app and gets forwarded to someone
 * who never saw the scene, so it is explicit about the things a bare number
 * would hide: where the scale came from, how well it is known, and which rows
 * carry an uncertainty that covers everything versus one that does not.
 */

import { A4_HEIGHT, A4_WIDTH, createPdf, truncateToWidth, wrapText } from './pdf';
import type { PdfImage } from './pdf';
import { calibrationSummary, uncertaintyNotes } from './measurementRows';
import type { MeasurementRow } from './measurementRows';
import { formatMetres } from './measurements';
import type { Calibration } from '../types';

export interface ReportRow {
  /** `M1`, or the kind when a row has no label. */
  label: string;
  /** `Distance`, `Path`, `Height`, `Angle`. */
  kind: string;
  value: string;
  /** `± 6 mm`, or `—` when no complete estimate exists. */
  uncertainty: string;
  detail: string;
  /** The ± leaned on pick quality borrowed from elsewhere in the scene. */
  assumed: boolean;
}

export interface ReportModel {
  title: string;
  subtitle: string;
  /** Where the scale came from and how well it is known (PLAN.md §5). */
  calibrationLine: string;
  /** `1 scene unit = 50 cm`, or `null` when uncalibrated. */
  scaleLine: string | null;
  rows: ReportRow[];
  /** Footnotes about what the ± figures cover. */
  notes: string[];
  /** Shown in place of the table when there is nothing to report. */
  emptyNote: string | null;
}

export interface BuildReportInput {
  projectName?: string | null;
  rows: readonly MeasurementRow[];
  calibration: Calibration | null | undefined;
  now?: Date;
  /** Appended to the notes, e.g. that a URL-only scene saves nothing. */
  extraNotes?: readonly string[];
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * `14 Aug 2026, 09:05` — local time, and unambiguous in every locale.
 *
 * Hand-rolled rather than `toLocaleString`, whose output depends on the ICU
 * data the browser shipped with; a report that reads differently on two phones
 * is a report two people cannot compare.
 */
export function formatReportDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function buildReport(input: BuildReportInput): ReportModel {
  const now = input.now ?? new Date();
  const rows = input.rows.map<ReportRow>((row) => ({
    label: row.measurement.label ?? row.kindLabel,
    kind: row.kindLabel,
    value: row.formatted.value,
    uncertainty: row.formatted.uncertainty ?? '—',
    detail: row.detail,
    assumed: row.uncertainty?.basis === 'assumed-spacing',
  }));

  const notes = [...uncertaintyNotes(input.rows), ...(input.extraNotes ?? [])];

  return {
    title: input.projectName?.trim() || 'SplatScene scene',
    subtitle: `Measurement report · ${formatReportDate(now)}`,
    calibrationLine: calibrationSummary(input.calibration),
    scaleLine: input.calibration
      ? `1 scene unit = ${formatMetres(input.calibration.scale)}`
      : null,
    rows,
    notes,
    emptyNote: rows.length === 0 ? 'No measurements were taken in this scene.' : null,
  };
}

// --- PDF layout --------------------------------------------------------------

const MARGIN = 48;
const CONTENT_WIDTH = A4_WIDTH - MARGIN * 2;
const ROW_HEIGHT = 15;
/** Column x offsets from the left margin, and the width each may occupy. */
const COLUMNS = {
  label: { x: 0, width: 62 },
  kind: { x: 66, width: 64 },
  value: { x: 134, width: 96 },
  uncertainty: { x: 236, width: 80 },
  detail: { x: 324, width: CONTENT_WIDTH - 324 },
};

export interface RenderReportOptions {
  /** The composited screenshot, already encoded as JPEG. */
  image?: PdfImage | null;
  now?: Date;
}

/**
 * Lays the report out on one A4 page.
 *
 * One page is a deliberate limit: a hand-off document that runs to three pages
 * of tables stops being read. If the measurements do not fit, the table is cut
 * and says how many rows were left out.
 */
export function renderReportPdf(
  model: ReportModel,
  options: RenderReportOptions = {},
): Uint8Array<ArrayBuffer> {
  const pdf = createPdf({
    image: options.image ?? null,
    title: `${model.title} — measurement report`,
    now: options.now,
  });

  let y = MARGIN + 6;

  pdf.text(MARGIN, y, model.title, { size: 18, bold: true });
  y += 16;
  pdf.text(MARGIN, y, model.subtitle, { size: 9.5, gray: 0.4 });
  y += 12;
  pdf.line(MARGIN, y, MARGIN + CONTENT_WIDTH, y, { gray: 0.75 });
  y += 18;

  // --- scale -----------------------------------------------------------------
  pdf.text(MARGIN, y, 'Scale', { size: 9, bold: true, gray: 0.25 });
  y += 13;
  for (const line of wrapText(model.calibrationLine, CONTENT_WIDTH, 10)) {
    pdf.text(MARGIN, y, line, { size: 10 });
    y += 13;
  }
  if (model.scaleLine) {
    pdf.text(MARGIN, y, model.scaleLine, { size: 10, gray: 0.35 });
    y += 13;
  }
  y += 8;

  // --- screenshot ------------------------------------------------------------
  if (options.image && options.image.width > 0 && options.image.height > 0) {
    const aspect = options.image.height / options.image.width;
    // Full content width unless that would make it too tall to leave room for
    // the table — the numbers are the point, the picture is the context.
    let drawnWidth = CONTENT_WIDTH;
    let drawnHeight = drawnWidth * aspect;
    if (drawnHeight > 300) {
      drawnHeight = 300;
      drawnWidth = drawnHeight / aspect;
    }
    const x = MARGIN + (CONTENT_WIDTH - drawnWidth) / 2;
    pdf.image(x, y, drawnWidth, drawnHeight);
    pdf.line(x, y + drawnHeight + 0.5, x + drawnWidth, y + drawnHeight + 0.5, { gray: 0.8 });
    y += drawnHeight + 22;
  }

  // --- table -----------------------------------------------------------------
  pdf.text(MARGIN, y, 'Measurements', { size: 9, bold: true, gray: 0.25 });
  y += 15;

  if (model.emptyNote) {
    pdf.text(MARGIN, y, model.emptyNote, { size: 10, gray: 0.4 });
    y += 16;
  } else {
    const header = [
      ['Label', COLUMNS.label],
      ['Type', COLUMNS.kind],
      ['Value', COLUMNS.value],
      ['Uncertainty', COLUMNS.uncertainty],
      ['Detail', COLUMNS.detail],
    ] as const;
    for (const [text, column] of header) {
      pdf.text(MARGIN + column.x, y, text, { size: 8, bold: true, gray: 0.45 });
    }
    y += 5;
    pdf.line(MARGIN, y, MARGIN + CONTENT_WIDTH, y, { gray: 0.8 });
    y += 12;

    // Leave room for the notes and the footer; whatever does not fit is counted.
    const available = A4_HEIGHT - MARGIN - 90 - model.notes.length * 11;
    const capacity = Math.max(1, Math.floor((available - y) / ROW_HEIGHT));
    const shown = model.rows.slice(0, capacity);

    for (const row of shown) {
      pdf.text(MARGIN, y, truncateToWidth(row.label, COLUMNS.label.width, 9.5, true), {
        size: 9.5,
        bold: true,
      });
      pdf.text(
        MARGIN + COLUMNS.kind.x,
        y,
        truncateToWidth(row.kind, COLUMNS.kind.width, 9.5),
        { size: 9.5, gray: 0.3 },
      );
      pdf.text(MARGIN + COLUMNS.value.x, y, row.value, { size: 9.5 });
      pdf.text(
        MARGIN + COLUMNS.uncertainty.x,
        y,
        row.assumed ? `~ ${row.uncertainty}` : row.uncertainty,
        { size: 9.5, gray: 0.3 },
      );
      pdf.text(
        MARGIN + COLUMNS.detail.x,
        y,
        truncateToWidth(row.detail, COLUMNS.detail.width, 9.5),
        { size: 9.5, gray: 0.3 },
      );
      y += ROW_HEIGHT;
      pdf.line(MARGIN, y - 10.5, MARGIN + CONTENT_WIDTH, y - 10.5, { gray: 0.9 });
    }

    const hidden = model.rows.length - shown.length;
    if (hidden > 0) {
      pdf.text(MARGIN, y + 2, `+ ${hidden} more measurement${hidden === 1 ? '' : 's'} in the app.`, {
        size: 9,
        gray: 0.45,
      });
      y += 16;
    }
  }

  // --- notes and footer ------------------------------------------------------
  y += 10;
  for (const note of model.notes) {
    for (const line of wrapText(`· ${note}`, CONTENT_WIDTH, 8)) {
      pdf.text(MARGIN, y, line, { size: 8, gray: 0.45 });
      y += 10;
    }
  }

  const footerY = A4_HEIGHT - MARGIN + 6;
  pdf.line(MARGIN, footerY - 12, MARGIN + CONTENT_WIDTH, footerY - 12, { gray: 0.85 });
  pdf.text(MARGIN, footerY, 'Generated by SplatScene — measurements are estimates, not survey data.', {
    size: 8,
    gray: 0.5,
  });

  return pdf.build();
}
