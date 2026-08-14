/**
 * Report export (WP 5.3, PLAN.md §3 "Share / Export").
 *
 * Two buttons, because they answer two different questions: a PNG is what you
 * paste into a chat message from the site, a PDF is what you attach to the
 * hand-off email. Both are produced entirely on the device — nothing about a
 * measurement report needs a round trip, and the field user may well have no
 * signal.
 */

import { useState } from 'react';
import { canvasToBlob, downloadBlob, reportFilename } from '../lib/capture';
import type { CaptionInput } from '../lib/capture';
import { buildReport, formatReportDate, renderReportPdf } from '../lib/report';
import { AlertIcon, DownloadIcon, SpinnerIcon } from './icons';
import type { MeasureSession } from '../hooks/useMeasureSession';

/** Pulls a composited frame from the viewer. `null` when it cannot be read. */
export type ReportCapture = (options: {
  caption?: CaptionInput | null;
}) => HTMLCanvasElement | null;

export interface ExportSheetProps {
  session: MeasureSession;
  /** Project name, when the scene was opened from one. */
  projectName?: string | null;
  capture?: ReportCapture | null;
  onClose: () => void;
}

const CAPTURE_FAILED =
  'The scene could not be captured — the graphics buffer was already cleared. Try again without switching tabs.';

const SHEET_BUTTON =
  'flex min-h-touch flex-1 items-center justify-center gap-2 rounded-lg border text-sm font-semibold transition-colors disabled:opacity-40';

export function ExportSheet({ session, projectName, capture, onClose }: ExportSheetProps) {
  const [busy, setBusy] = useState<'png' | 'pdf' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const title = projectName?.trim() || 'SplatScene scene';

  /** The bar under a PNG, so the picture still says what it is once forwarded. */
  const captionFor = (at: Date): CaptionInput => ({
    title,
    subtitle: `${formatReportDate(at)} · ${
      session.calibration ? 'calibrated' : 'uncalibrated — relative units'
    }`,
  });

  const extraNotes = session.persisted
    ? []
    : ['This scene was opened by URL: its measurements exist only in the browser tab.'];

  const exportPng = async () => {
    setBusy('png');
    setError(null);
    setNote(null);
    const now = new Date();
    try {
      const canvas = capture?.({ caption: captionFor(now) });
      if (!canvas) {
        setError(CAPTURE_FAILED);
        return;
      }
      const blob = await canvasToBlob(canvas, 'image/png');
      if (!blob) {
        setError('This browser would not encode the image.');
        return;
      }
      downloadBlob(blob, reportFilename(title, 'png', now));
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The snapshot could not be saved.');
    } finally {
      setBusy(null);
    }
  };

  const exportPdf = async () => {
    setBusy('pdf');
    setError(null);
    setNote(null);
    const now = new Date();
    try {
      // No caption bar here: the PDF prints the same facts as real text above
      // the picture, where they can be selected and searched.
      const canvas = capture?.({ caption: null });
      const jpeg = canvas ? await canvasToBlob(canvas, 'image/jpeg', 0.82) : null;
      if (canvas && !jpeg) setNote('The screenshot could not be encoded; the report has no image.');
      if (!canvas) setNote('The scene could not be captured; the report has no image.');

      const bytes = renderReportPdf(
        buildReport({
          projectName: title,
          rows: session.rows,
          calibration: session.calibration,
          now,
          extraNotes,
        }),
        {
          image:
            jpeg && canvas
              ? {
                  jpeg: new Uint8Array(await jpeg.arrayBuffer()),
                  width: canvas.width,
                  height: canvas.height,
                }
              : null,
          now,
        },
      );

      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), reportFilename(title, 'pdf', now));
      if (!canvas) return;
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The report could not be generated.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="pointer-events-auto rounded-t-2xl border-t border-line bg-surface/95 p-4 backdrop-blur-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Export report</h2>
          <p className="mt-1 text-xs text-muted">
            {session.rows.length} measurement{session.rows.length === 1 ? '' : 's'} ·{' '}
            {session.calibration ? 'real-world units' : 'relative scene units'}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="min-h-touch shrink-0 rounded-lg px-3 text-xs font-medium text-muted transition-colors hover:text-content"
        >
          Close
        </button>
      </div>

      {error ? (
        <p className="mt-3 flex items-start gap-1.5 text-xs break-words text-danger">
          <AlertIcon className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      ) : null}
      {note ? <p className="mt-3 text-xs break-words text-warn">{note}</p> : null}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void exportPng()}
          className={`${SHEET_BUTTON} border-line hover:bg-raised`}
        >
          {busy === 'png' ? (
            <SpinnerIcon className="size-4 animate-spin" />
          ) : (
            <DownloadIcon className="size-4" />
          )}
          PNG snapshot
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void exportPdf()}
          className={`${SHEET_BUTTON} border-accent bg-accent text-on-accent enabled:hover:opacity-90`}
        >
          {busy === 'pdf' ? (
            <SpinnerIcon className="size-4 animate-spin" />
          ) : (
            <DownloadIcon className="size-4" />
          )}
          PDF report
        </button>
      </div>

      <p className="mt-2 text-[11px] text-muted">
        The PDF holds the screenshot, the scale and every measurement with its uncertainty.
      </p>
    </div>
  );
}

export default ExportSheet;
