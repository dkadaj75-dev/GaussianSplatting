/**
 * Measure-mode UI layered over the splat canvas (WP 3.2/3.3, extended by 5.2/5.3).
 *
 * Mobile-first: one row of ≥44 px controls pinned to the bottom, the list, the
 * calibration sheet and the export sheet as bottom sheets that cap at half the
 * viewport. The scene stays visible behind everything — a measurement tool
 * that hides the thing being measured is worthless on a phone.
 *
 * The four tools live in a segmented control that only appears while measuring
 * rather than in the main bar. Nine full-width buttons would not fit a 320 px
 * phone, and the tools are a mode *within* measuring: showing them only there
 * says so without a word of explanation.
 */

import { useEffect, useState } from 'react';
import { LENGTH_UNITS, formatMetres } from '../lib/measurements';
import type { LengthUnit } from '../lib/measurements';
import { calibrationBlocker, calibrationPrompt } from '../lib/calibration';
import { MEASURE_TOOL_LIST } from '../lib/measureTools';
import type { MeasureToolId } from '../lib/measureTools';
import {
  AlertIcon,
  AngleIcon,
  CheckIcon,
  DistanceIcon,
  DownloadIcon,
  HeightIcon,
  PathIcon,
  TrashIcon,
  UndoIcon,
} from './icons';
import { ExportSheet } from './ExportSheet';
import type { ReportCapture } from './ExportSheet';
import type { MeasureSession } from '../hooks/useMeasureSession';

const TOOL_BUTTON =
  'flex min-h-touch flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 text-[11px] font-semibold transition-colors';

const TOOL_ICON: Record<MeasureToolId, typeof DistanceIcon> = {
  distance: DistanceIcon,
  polyline: PathIcon,
  height: HeightIcon,
  angle: AngleIcon,
};

/** PLAN.md §5: every scene carries a visible trust signal. */
export function CalibrationBadge({
  session,
  className = '',
}: {
  session: MeasureSession;
  className?: string;
}) {
  const calibrated = session.calibration !== null;
  return (
    <span
      data-testid="calibration-badge"
      title={session.calibrationSummary}
      className={`pointer-events-none inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold backdrop-blur-sm ${
        calibrated
          ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300'
          : 'border-amber-400/40 bg-amber-500/15 text-amber-300'
      } ${className}`}
    >
      <span
        className={`size-1.5 rounded-full ${calibrated ? 'bg-emerald-400' : 'bg-amber-400'}`}
        aria-hidden="true"
      />
      {calibrated ? 'Calibrated' : 'Uncalibrated — units are relative'}
    </span>
  );
}

/**
 * The four tools, as a segmented control.
 *
 * Icon over label at 44 px tall: four of these fit a 320 px screen with room
 * to spare, which four full-width buttons in the main bar would not.
 */
function ToolSwitcher({ session }: { session: MeasureSession }) {
  return (
    <div
      role="group"
      aria-label="Measurement tool"
      className="pointer-events-auto flex overflow-hidden rounded-lg border border-line bg-surface/90 backdrop-blur-sm"
    >
      {MEASURE_TOOL_LIST.map((tool) => {
        const Icon = TOOL_ICON[tool.id];
        const active = session.tool === tool.id;
        return (
          <button
            key={tool.id}
            type="button"
            aria-pressed={active}
            title={tool.description}
            onClick={() => session.selectTool(tool.id)}
            className={`flex min-h-touch flex-1 flex-col items-center justify-center gap-0.5 border-r border-line px-1 py-1 text-[10px] font-semibold transition-colors last:border-r-0 ${
              active ? 'bg-accent text-on-accent' : 'text-muted hover:bg-raised hover:text-content'
            }`}
          >
            <Icon className="size-4" />
            {tool.label}
          </button>
        );
      })}
    </div>
  );
}

/** Undo / Finish / re-pick the floor — only the ones that currently apply. */
function DraftActions({ session }: { session: MeasureSession }) {
  const showPlaneReset = session.tool === 'height' && session.groundPlane !== null;
  if (!session.hasDraft && !session.canFinish && !showPlaneReset) return null;

  return (
    <div className="pointer-events-auto flex gap-2">
      {session.hasDraft ? (
        <button
          type="button"
          onClick={session.undoPick}
          className={`${TOOL_BUTTON} border-line bg-surface/90 backdrop-blur-sm hover:bg-raised`}
        >
          <UndoIcon className="size-4" />
          Undo point
        </button>
      ) : null}
      {showPlaneReset ? (
        <button
          type="button"
          onClick={session.clearGroundPlane}
          className={`${TOOL_BUTTON} border-line bg-surface/90 backdrop-blur-sm hover:bg-raised`}
        >
          New ground plane
        </button>
      ) : null}
      {session.canFinish ? (
        <button
          type="button"
          onClick={session.finishPath}
          className={`${TOOL_BUTTON} border-accent bg-accent text-on-accent`}
        >
          <CheckIcon className="size-4" />
          Finish path
        </button>
      ) : null}
    </div>
  );
}

function MeasurementList({ session, onClose }: { session: MeasureSession; onClose: () => void }) {
  return (
    <div className="pointer-events-auto max-h-[45vh] overflow-y-auto rounded-t-2xl border-t border-line bg-surface/95 backdrop-blur-sm">
      <div className="sticky top-0 flex items-center justify-between border-b border-line bg-surface/95 px-4 py-2.5">
        <h2 className="text-sm font-semibold">Measurements</h2>
        <button
          type="button"
          onClick={onClose}
          className="min-h-touch rounded-lg px-3 text-xs font-medium text-muted transition-colors hover:text-content"
        >
          Close
        </button>
      </div>

      {session.measurementsPending ? (
        <p className="px-4 py-6 text-center text-xs text-muted">Loading measurements…</p>
      ) : session.rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted">
          No measurements yet. Turn on Measure, then tap two points in the scene.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {session.rows.map((row) => (
            <li key={row.measurement.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  <span>{row.measurement.label ?? row.kindLabel}</span>
                  <span className="ml-1.5 text-[11px] font-normal text-muted">{row.kindLabel}</span>
                </p>
                <p className="mt-0.5 text-xs tabular-nums text-muted">
                  {/* Value and ± in separate spans: the uncertainty is a
                      qualifier, and reads as one. */}
                  <span className="text-content">{row.formatted.value}</span>
                  {row.formatted.uncertainty ? (
                    <span className="ml-1">
                      {row.uncertainty?.basis === 'assumed-spacing' ? '~' : ''}
                      {row.formatted.uncertainty}
                      {row.formatted.relative ? ` (${row.formatted.relative})` : ''}
                    </span>
                  ) : (
                    <span className="ml-1 text-muted">· {row.detail}</span>
                  )}
                </p>
              </div>
              <button
                type="button"
                aria-label={`Delete ${row.measurement.label ?? 'measurement'}`}
                onClick={() => session.deleteMeasurement(row.measurement.id)}
                className="grid size-touch shrink-0 place-items-center rounded-lg border border-line text-muted transition-colors hover:bg-raised hover:text-content"
              >
                <TrashIcon className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {session.notes.map((note) => (
        <p key={note} className="border-t border-line px-4 py-2 text-[11px] text-muted">
          {note}
        </p>
      ))}

      {session.persisted ? null : (
        <p className="border-t border-line px-4 py-2.5 text-[11px] text-muted">
          Not saved — this scene was opened by URL. Open it from its project to keep measurements.
        </p>
      )}
    </div>
  );
}

function CalibrationSheet({ session }: { session: MeasureSession }) {
  const { calibrationState: state, dispatchCalibration: dispatch } = session;
  const blocker = calibrationBlocker(state);
  const saving = state.stage === 'saving';

  return (
    <div className="pointer-events-auto rounded-t-2xl border-t border-line bg-surface/95 p-4 backdrop-blur-sm">
      <h2 className="text-sm font-semibold">Known-distance calibration</h2>
      <p className="mt-1 text-xs text-muted">
        How far apart are the two points you picked in the real world?
        {session.calibrationSceneLength === null
          ? null
          : ` They are ${session.calibrationSceneLength.toPrecision(3)} scene units apart.`}
      </p>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          session.submitCalibration();
        }}
      >
        <label htmlFor="calibration-distance" className="sr-only">
          Real-world distance
        </label>
        <input
          id="calibration-distance"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          autoFocus
          disabled={saving}
          value={state.distance}
          onChange={(event) => dispatch({ type: 'set-distance', value: event.target.value })}
          placeholder="1.00"
          className="min-h-touch min-w-0 flex-1 rounded-lg border border-line bg-sunken px-3 font-mono text-sm outline-none focus:border-accent"
        />
        <div className="flex shrink-0 overflow-hidden rounded-lg border border-line" role="group" aria-label="Unit">
          {LENGTH_UNITS.map((unit: LengthUnit) => (
            <button
              key={unit}
              type="button"
              aria-pressed={state.unit === unit}
              disabled={saving}
              onClick={() => dispatch({ type: 'set-unit', unit })}
              className={`min-h-touch w-11 text-xs font-semibold transition-colors ${
                state.unit === unit ? 'bg-accent text-on-accent' : 'text-muted hover:bg-raised'
              }`}
            >
              {unit}
            </button>
          ))}
        </div>
      </form>

      {state.error ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs break-words text-amber-300">
          <AlertIcon className="mt-0.5 size-4 shrink-0" />
          {state.error}
        </p>
      ) : null}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => dispatch({ type: 'cancel' })}
          className="min-h-touch flex-1 rounded-lg border border-line text-sm font-medium transition-colors hover:bg-raised"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => dispatch({ type: 'undo' })}
          className="min-h-touch flex-1 rounded-lg border border-line text-sm font-medium transition-colors hover:bg-raised disabled:opacity-40"
        >
          Re-pick
        </button>
        <button
          type="button"
          disabled={saving || blocker !== null}
          onClick={() => session.submitCalibration()}
          className="min-h-touch flex-[1.4] rounded-lg bg-accent text-sm font-semibold text-on-accent transition-opacity enabled:hover:opacity-90 disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Set scale'}
        </button>
      </div>
    </div>
  );
}

export interface MeasureToolsProps {
  session: MeasureSession;
  /** Project name for the exported report's title. */
  projectName?: string | null;
  /** Pulls a composited frame out of the viewer (WP 5.3). */
  capture?: ReportCapture | null;
}

export function MeasureTools({ session, projectName, capture }: MeasureToolsProps) {
  const [panel, setPanel] = useState<'list' | 'export' | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const calibrating = calibrationPrompt(session.calibrationState.stage);
  const prompt = calibrating ?? (session.measuring ? session.prompt : null);
  const sheetOpen =
    session.calibrationState.stage === 'entry' || session.calibrationState.stage === 'saving';
  const scalePercent = session.scaleRelativeSigma > 0
    ? `±${Number((session.scaleRelativeSigma * 100).toPrecision(2))} %`
    : null;

  // A half-pressed "Clear all?" must not survive a mode change or a new pick.
  useEffect(() => {
    if (!confirmClear) return;
    const timer = setTimeout(() => setConfirmClear(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmClear]);

  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
      <div className="safe-top flex flex-col items-start gap-1.5 p-3 pr-28">
        <CalibrationBadge session={session} />
        {session.calibration ? (
          <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-line bg-black/70 px-2.5 py-1 text-[11px] text-muted backdrop-blur-sm">
            <span className="tabular-nums">1 unit = {formatMetres(session.calibration.scale)}</span>
            {/* The scale's own tolerance, stated once for the scene rather than
                smuggled into every measurement (PLAN.md §5). */}
            {scalePercent ? (
              <span
                className={`tabular-nums ${session.scaleRelativeSigma > 0.05 ? 'text-warn' : 'text-muted'}`}
                title={session.calibrationSummary}
              >
                scale {scalePercent}
              </span>
            ) : null}
            <button
              type="button"
              disabled={session.isRemovingCalibration}
              onClick={session.removeCalibration}
              className="rounded px-1 py-0.5 font-medium text-content underline underline-offset-2 disabled:opacity-40"
            >
              {session.isRemovingCalibration ? 'Removing…' : 'Remove'}
            </button>
          </div>
        ) : null}
      </div>

      <div className="safe-bottom flex flex-col gap-2">
        {prompt ? (
          <div className="px-3">
            <p
              data-testid="measure-prompt"
              className={`pointer-events-none mx-auto max-w-sm rounded-lg border bg-black/80 px-3 py-2 text-center text-xs font-medium backdrop-blur-sm ${
                calibrating
                  ? 'border-amber-400/40 text-amber-200'
                  : 'border-line font-normal text-muted'
              }`}
            >
              {prompt}
            </p>
          </div>
        ) : null}

        {session.notice ? (
          <div className="px-3">
            <button
              type="button"
              onClick={session.dismissNotice}
              className="pointer-events-auto mx-auto flex w-full max-w-sm items-start gap-1.5 rounded-lg border border-line bg-black/80 px-3 py-2 text-left text-xs break-words text-muted backdrop-blur-sm"
            >
              <AlertIcon className="mt-0.5 size-4 shrink-0" />
              {session.notice}
            </button>
          </div>
        ) : null}

        {panel === 'list' ? <MeasurementList session={session} onClose={() => setPanel(null)} /> : null}
        {panel === 'export' ? (
          <ExportSheet
            session={session}
            projectName={projectName}
            capture={capture}
            onClose={() => setPanel(null)}
          />
        ) : null}
        {sheetOpen ? <CalibrationSheet session={session} /> : null}

        {sheetOpen || panel !== null ? null : session.measuring && !calibrating ? (
          <div className="flex flex-col gap-2 px-2">
            <DraftActions session={session} />
            <ToolSwitcher session={session} />
          </div>
        ) : null}

        {sheetOpen ? null : (
          <div className="pointer-events-auto flex gap-1.5 border-t border-line bg-surface/90 p-2 backdrop-blur-sm">
            <button
              type="button"
              aria-pressed={session.measuring}
              onClick={session.toggleMeasuring}
              className={`${TOOL_BUTTON} ${
                session.measuring
                  ? 'border-accent bg-accent text-on-accent'
                  : 'border-line text-content hover:bg-raised'
              }`}
            >
              Measure
            </button>
            <button
              type="button"
              onClick={session.startCalibration}
              className={`${TOOL_BUTTON} ${
                calibrating ? 'border-amber-400/60 bg-amber-500/20 text-amber-200' : 'border-line hover:bg-raised'
              }`}
            >
              Calibrate
            </button>
            <button
              type="button"
              disabled={session.isClearing}
              onClick={() => {
                if (!confirmClear && session.measurements.length > 0) {
                  setConfirmClear(true);
                  return;
                }
                setConfirmClear(false);
                session.clearAll();
              }}
              className={`${TOOL_BUTTON} ${
                confirmClear ? 'border-amber-400/60 bg-amber-500/20 text-amber-200' : 'border-line hover:bg-raised'
              } disabled:opacity-40`}
            >
              {session.isClearing ? 'Clearing…' : confirmClear ? 'Clear all?' : 'Clear'}
            </button>
            <button
              type="button"
              aria-expanded={panel === 'list'}
              onClick={() => setPanel((open) => (open === 'list' ? null : 'list'))}
              className={`${TOOL_BUTTON} border-line hover:bg-raised`}
            >
              List
              <span className="rounded-full bg-raised px-1.5 text-[10px] tabular-nums">
                {session.measurements.length}
              </span>
            </button>
            <button
              type="button"
              aria-expanded={panel === 'export'}
              onClick={() => setPanel((open) => (open === 'export' ? null : 'export'))}
              className={`${TOOL_BUTTON} border-line hover:bg-raised`}
            >
              <DownloadIcon className="size-4" />
              Export
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default MeasureTools;
