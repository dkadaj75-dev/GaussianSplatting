/**
 * The viewer's measurement session (WP 3.2 + 3.3, extended by WP 5.2).
 *
 * Holds everything that spans the canvas and the toolbar: which tool taps go
 * to, the half-finished measurement, the ground plane, the calibration flow,
 * the uncertainty bookkeeping, and persistence.
 *
 * Persistence is conditional by design. The viewer is reachable with a bare
 * `?src=` URL (paste a splat, look at it), and there is no project to attach
 * measurements to in that case — so the session degrades to in-memory instead
 * of refusing to measure.
 *
 * Pick quality (how far the tap ray passed from the splat it snapped to, and
 * how densely packed the splats are there) is recorded per measurement while
 * the tab is open. It cannot be persisted — the API stores points, value, unit
 * and label, nothing else — so a measurement read back from the server reports
 * a weaker basis for its ± rather than pretending the picks were perfect. See
 * `lib/uncertainty`.
 */

import { useCallback, useMemo, useReducer, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryKeys } from '../lib/api';
import {
  calibrationReducer,
  calibrationRequest,
  initialCalibrationState,
  isCalibrationPicking,
} from '../lib/calibration';
import type { CalibrationAction, CalibrationState } from '../lib/calibration';
import { angleArcPoints, angleArcRadius, polylineLength } from '../lib/geometry';
import {
  cancelDraft,
  clearGroundPlane as clearPlane,
  canFinishTool,
  finishTool,
  hasDraft as hasDraftPoints,
  initialToolState,
  pickIntoTool,
  selectTool as selectToolState,
  toolPrompt,
  undoPick as undoToolPick,
} from '../lib/measureTools';
import type { CompletedDraft, GroundPlane, MeasureToolId, ToolState } from '../lib/measureTools';
import {
  distance3,
  formatMeasurement,
  formatMetres,
  isSupportedKind,
  measurementSceneValue,
  nextMeasurementLabel,
} from '../lib/measurements';
import {
  buildMeasurementRow,
  buildMeasurementRows,
  calibrationSummary as summariseCalibration,
  uncertaintyNotes,
} from '../lib/measurementRows';
import type { MeasurementRow } from '../lib/measurementRows';
import { calibrationRelativeSigma, pointSigma } from '../lib/uncertainty';
import type { PickQuality } from '../lib/uncertainty';
import type { OverlayItem } from '../lib/measurementOverlay';
import type { Calibration, Measurement, MeasurementInput, Point3, Project } from '../types';

export interface MeasureSessionOptions {
  /** `null` when the viewer was opened without a project (`?src=` only). */
  projectId: string | null;
  /** The fetched project, if any — the source of the calibration. */
  project?: Project | null;
}

/** Extra information a tap can carry (see `SplatViewer`). */
export interface PickInfo extends PickQuality {
  /** True when this tap was the second of a double-tap — finishes an open path. */
  doubleTap?: boolean;
}

export interface MeasureSession {
  measuring: boolean;
  toggleMeasuring: () => void;
  /** True while a tap should place a point rather than only orbit. */
  pickEnabled: boolean;
  handlePick: (point: Point3 | null, info?: PickInfo) => void;
  /**
   * The viewer's one-off measurement of how densely packed this scene's splats
   * are. It lets measurements taken in an *earlier* session carry a ± too,
   * flagged as borrowed rather than observed.
   */
  reportSceneSpacing: (spacing: number | null) => void;

  // --- tools (WP 5.2) --------------------------------------------------------
  tool: MeasureToolId;
  selectTool: (tool: MeasureToolId) => void;
  /** Coach text for exactly where the current tool is. */
  prompt: string;
  /** A path with enough points to close. */
  canFinish: boolean;
  finishPath: () => void;
  /** A tap has been placed that `undoPick` could take back. */
  hasDraft: boolean;
  undoPick: () => void;
  /** The session ground plane; in memory only — see `lib/measureTools`. */
  groundPlane: GroundPlane | null;
  clearGroundPlane: () => void;

  measurements: Measurement[];
  /** Measurements resolved for display: value, uncertainty and strings. */
  rows: MeasurementRow[];
  measurementsPending: boolean;
  /** Formats a stored scene-unit length for display (no uncertainty). */
  format: (sceneValue: number) => string;
  overlayItems: OverlayItem[];
  /** Footnotes explaining what the ± figures do and do not cover. */
  notes: string[];

  /** Whether measurements survive a reload. */
  persisted: boolean;
  /** Transient one-line feedback for the toolbar (hint or failure). */
  notice: string | null;
  dismissNotice: () => void;

  deleteMeasurement: (id: string) => void;
  clearAll: () => void;
  isClearing: boolean;

  calibration: Calibration | null;
  /** One line on where the scale came from and how well it is known. */
  calibrationSummary: string;
  /** The scale's relative 1σ, e.g. 0.018 — 0 when uncalibrated. */
  scaleRelativeSigma: number;
  calibrationState: CalibrationState;
  dispatchCalibration: (action: CalibrationAction) => void;
  startCalibration: () => void;
  submitCalibration: () => void;
  removeCalibration: () => void;
  isRemovingCalibration: boolean;
  /** Scene-unit length between the two calibration picks, for the sheet. */
  calibrationSceneLength: number | null;
}

/** A measurement that only ever lived in this tab. */
function localMeasurement(draft: CompletedDraft, label: string, index: number): Measurement {
  return {
    id: `local-${index}`,
    projectId: '',
    kind: draft.kind,
    points: draft.points,
    value: draft.value,
    unit: draft.unit,
    label,
    createdAt: new Date().toISOString(),
  };
}

function draftInput(draft: CompletedDraft, label: string): MeasurementInput {
  return {
    kind: draft.kind,
    points: draft.points,
    value: draft.value,
    unit: draft.unit,
    label,
  };
}

/** Median of the pick sigmas seen this session — the scene's typical pick quality. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

export function useMeasureSession({ projectId, project }: MeasureSessionOptions): MeasureSession {
  const queryClient = useQueryClient();
  const [measuring, setMeasuring] = useState(false);
  const [toolState, setToolState] = useState<ToolState>(() => initialToolState());
  const [inFlight, setInFlight] = useState<CompletedDraft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [local, setLocal] = useState<Measurement[]>([]);
  const localCounter = useRef(0);
  const [calibrationState, dispatchCalibration] = useReducer(
    calibrationReducer,
    initialCalibrationState,
  );

  // Pick quality, per measurement id, for as long as the tab is open. State
  // rather than a ref: the rows (and every ± in them) have to recompute the
  // moment a save resolves and tells us which id the picks belong to.
  const [sigmasById, setSigmasById] = useState<ReadonlyMap<string, readonly (number | null)[]>>(
    () => new Map(),
  );
  const observedSigmas = useRef<number[]>([]);
  const [observedSigma, setObservedSigma] = useState<number | null>(null);
  const [sceneSpacing, setSceneSpacing] = useState<number | null>(null);

  /**
   * Pick quality to assume for measurements whose own picks were not observed.
   *
   * Picks made in this session win: they include how far each tap landed from
   * the splat it snapped to, which the scene-wide probe cannot know. Failing
   * that, half the scene's typical splat spacing — the quantisation error a
   * pick cannot do better than.
   */
  const assumedSigma =
    observedSigma ?? (sceneSpacing !== null && sceneSpacing > 0 ? sceneSpacing / 2 : null);

  const calibration = project?.calibration ?? null;

  const measurementsQuery = useQuery({
    queryKey: queryKeys.measurements(projectId ?? ''),
    queryFn: () => api.listMeasurements(projectId ?? ''),
    enabled: Boolean(projectId),
  });

  const persisted = Boolean(projectId);
  const measurements = useMemo(
    () =>
      (persisted ? (measurementsQuery.data ?? []) : local).filter((measurement) =>
        isSupportedKind(measurement.kind),
      ),
    [persisted, measurementsQuery.data, local],
  );

  const rows = useMemo(
    () => buildMeasurementRows(measurements, { calibration, sigmasById, assumedSigma }),
    [measurements, calibration, sigmasById, assumedSigma],
  );

  const invalidateMeasurements = useCallback(async () => {
    if (!projectId) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.measurements(projectId) });
  }, [queryClient, projectId]);

  const rememberSigmas = useCallback((id: string, sigmas: readonly (number | null)[]) => {
    // Nothing was observed about these picks (a synthetic pick, or a viewer
    // build that reports no quality): leave the row without a geometric term
    // rather than recording a row of nulls that reads like data.
    if (sigmas.every((value) => value === null)) return;
    setSigmasById((previous) => new Map(previous).set(id, sigmas));
  }, []);

  const createMeasurement = useMutation({
    mutationFn: (draft: CompletedDraft) =>
      api.createMeasurement(
        projectId ?? '',
        draftInput(draft, nextMeasurementLabel(measurements)),
      ),
    // `onSettled` runs after `onSuccess` has awaited the refetch, so the
    // placeholder segment hands over to the stored one without a blink.
    onSuccess: async (created: Measurement, draft: CompletedDraft) => {
      rememberSigmas(created.id, draft.sigmas);
      await invalidateMeasurements();
    },
    onError: (error: unknown) =>
      setNotice(
        error instanceof Error ? `Could not save: ${error.message}` : 'Could not save the measurement.',
      ),
    onSettled: () => setInFlight(null),
  });

  const removeMeasurement = useMutation({
    mutationFn: (id: string) => api.deleteMeasurement(projectId ?? '', id),
    onSuccess: invalidateMeasurements,
    onError: (error: unknown) =>
      setNotice(error instanceof Error ? error.message : 'Could not delete the measurement.'),
  });

  const clearMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await api.deleteMeasurement(projectId ?? '', id);
    },
    onSuccess: invalidateMeasurements,
    onError: (error: unknown) =>
      setNotice(error instanceof Error ? error.message : 'Could not clear the measurements.'),
  });

  const saveCalibration = useMutation({
    mutationFn: (reference: { pointA: Point3; pointB: Point3; realDistanceM: number }) =>
      api.setCalibration(projectId ?? '', reference),
    onSuccess: (updated: Project) => {
      // Seed rather than invalidate: the PUT already returned the whole
      // project, so the badge and every label flip in the same tick.
      queryClient.setQueryData(queryKeys.project(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      dispatchCalibration({ type: 'succeeded' });
    },
    onError: (error: unknown) =>
      dispatchCalibration({
        type: 'failed',
        message: error instanceof Error ? error.message : 'Could not save the calibration.',
      }),
  });

  const removeCalibrationMutation = useMutation({
    mutationFn: () => api.clearCalibration(projectId ?? ''),
    onSuccess: (updated: Project) => {
      queryClient.setQueryData(queryKeys.project(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
    onError: (error: unknown) =>
      setNotice(error instanceof Error ? error.message : 'Could not remove the calibration.'),
  });

  const commit = useCallback(
    (draft: CompletedDraft) => {
      if (projectId) {
        setInFlight(draft);
        createMeasurement.mutate(draft);
        return;
      }
      localCounter.current += 1;
      const id = `local-${localCounter.current}`;
      rememberSigmas(id, draft.sigmas);
      setLocal((previous) => [
        ...previous,
        localMeasurement(draft, nextMeasurementLabel(previous), localCounter.current),
      ]);
    },
    [projectId, createMeasurement, rememberSigmas],
  );

  const applyTransition = useCallback(
    (transition: ReturnType<typeof pickIntoTool>) => {
      setToolState(transition.state);
      if (transition.notice !== null) setNotice(transition.notice);
      if (transition.completed) commit(transition.completed);
    },
    [commit],
  );

  const handlePick = useCallback(
    (point: Point3 | null, info?: PickInfo) => {
      if (point === null) {
        setNotice('Nothing to measure there — aim at a surface in the scene.');
        return;
      }
      setNotice(null);

      if (isCalibrationPicking(calibrationState.stage)) {
        dispatchCalibration({ type: 'pick', point });
        return;
      }
      if (!measuring) return;

      const sigma = info ? pointSigma(info) : null;
      if (sigma !== null && sigma > 0) {
        observedSigmas.current.push(sigma);
        setObservedSigma(median(observedSigmas.current));
      }

      // The second tap of a double-tap closes an open path instead of adding a
      // point on top of the one it just placed.
      if (info?.doubleTap && canFinishTool(toolState)) {
        applyTransition(finishTool(toolState));
        return;
      }

      applyTransition(pickIntoTool(toolState, point, sigma));
    },
    [calibrationState.stage, measuring, toolState, applyTransition],
  );

  const toggleMeasuring = useCallback(() => {
    setToolState((state) => cancelDraft(state));
    setNotice(null);
    dispatchCalibration({ type: 'cancel' });
    setMeasuring((on) => !on);
  }, []);

  const selectTool = useCallback((tool: MeasureToolId) => {
    setNotice(null);
    setMeasuring(true);
    dispatchCalibration({ type: 'cancel' });
    setToolState((state) => selectToolState(state, tool));
  }, []);

  const finishPath = useCallback(() => {
    applyTransition(finishTool(toolState));
  }, [applyTransition, toolState]);

  const undoPick = useCallback(() => {
    setNotice(null);
    setToolState((state) => undoToolPick(state));
  }, []);

  const clearGroundPlane = useCallback(() => {
    setNotice(null);
    setToolState((state) => clearPlane(state));
  }, []);

  const startCalibration = useCallback(() => {
    setToolState((state) => cancelDraft(state));
    setNotice(null);
    setMeasuring(false);
    dispatchCalibration({ type: 'start' });
  }, []);

  const submitCalibration = useCallback(() => {
    const request = calibrationRequest({ ...calibrationState, stage: 'entry' });
    dispatchCalibration({ type: 'submit' });
    if (!request) return;
    if (!projectId) {
      dispatchCalibration({
        type: 'failed',
        message: 'Open this scene from its project to save a calibration.',
      });
      return;
    }
    saveCalibration.mutate(request);
  }, [calibrationState, projectId, saveCalibration]);

  const removeCalibration = useCallback(() => {
    if (!projectId) return;
    removeCalibrationMutation.mutate();
  }, [projectId, removeCalibrationMutation]);

  const clearAll = useCallback(() => {
    setToolState((state) => cancelDraft(state));
    dispatchCalibration({ type: 'cancel' });
    if (!projectId) {
      setLocal([]);
      return;
    }
    const ids = measurements.map((measurement) => measurement.id);
    if (ids.length > 0) clearMutation.mutate(ids);
  }, [projectId, measurements, clearMutation]);

  const deleteMeasurement = useCallback(
    (id: string) => {
      if (!projectId) {
        setLocal((previous) => previous.filter((row) => row.id !== id));
        return;
      }
      removeMeasurement.mutate(id);
    },
    [projectId, removeMeasurement],
  );

  const format = useCallback(
    (sceneValue: number) => formatMeasurement(sceneValue, calibration),
    [calibration],
  );

  const overlayItems = useMemo<OverlayItem[]>(() => {
    const items: OverlayItem[] = [];

    for (const row of rows) {
      const item = overlayForRow(row);
      if (item) items.push(item);
    }

    // The POST is still in flight: keep the geometry on screen so the scene
    // never appears to swallow a finished measurement. Drawn through the same
    // path as a stored row, so an angle's arc and a height's plane are already
    // right while it saves.
    if (inFlight) {
      const item = overlayForRow(
        buildMeasurementRow(
          {
            id: 'in-flight',
            projectId: '',
            kind: inFlight.kind,
            points: inFlight.points,
            value: inFlight.value,
            unit: inFlight.unit,
            label: null,
            createdAt: '',
          },
          inFlight.sigmas,
          false,
          calibration,
        ),
      );
      if (item) items.push({ ...item, tone: 'pending' });
    }

    // The half-finished measurement, and the plane being defined.
    if (toolState.planePoints.length > 0) {
      items.push(draftOverlay('pending-plane', toolState.planePoints, null));
    } else if (toolState.points.length > 0) {
      const live =
        toolState.tool === 'polyline' && toolState.points.length >= 2
          ? format(polylineLength(toolState.points))
          : null;
      items.push(draftOverlay('pending-a', toolState.points, live));
    }

    // The session ground plane, while the tool that uses it is selected.
    if (toolState.plane && toolState.tool === 'height') {
      const [p1, p2, p3] = toolState.plane.points;
      items.push({
        id: 'ground-plane',
        tone: 'plane',
        a: p1,
        points: toolState.plane.points,
        guide: [p1, p2, p3, p1],
        label: 'Ground plane',
        anchor: toolState.plane.plane.origin,
      });
    }

    // The live calibration picks…
    const { pointA, pointB } = calibrationState;
    if (pointA) {
      items.push({
        id: 'calibration-draft',
        tone: 'calibration',
        a: pointA,
        b: pointB,
        label: pointB ? 'Reference' : null,
      });
    } else if (calibration?.reference) {
      // …or, once saved, the reference the scale came from. An ArUco
      // calibration has no picked pair, so there is nothing to draw.
      items.push({
        id: 'calibration-reference',
        tone: 'calibration',
        a: calibration.reference.pointA,
        b: calibration.reference.pointB,
        label: `Reference · ${formatMetres(calibration.reference.realDistanceM)}`,
      });
    }

    return items;
  }, [rows, inFlight, toolState, calibrationState, calibration, format]);

  const calibrationSceneLength =
    calibrationState.pointA && calibrationState.pointB
      ? distance3(calibrationState.pointA, calibrationState.pointB)
      : null;

  return {
    measuring,
    toggleMeasuring,
    pickEnabled: measuring || isCalibrationPicking(calibrationState.stage),
    handlePick,
    reportSceneSpacing: setSceneSpacing,

    tool: toolState.tool,
    selectTool,
    prompt: toolPrompt(toolState),
    canFinish: canFinishTool(toolState),
    finishPath,
    hasDraft: hasDraftPoints(toolState),
    undoPick,
    groundPlane: toolState.plane,
    clearGroundPlane,

    measurements,
    rows,
    measurementsPending: persisted && measurementsQuery.isPending,
    format,
    overlayItems,
    notes: useMemo(() => uncertaintyNotes(rows), [rows]),

    persisted,
    notice,
    dismissNotice: useCallback(() => setNotice(null), []),

    deleteMeasurement,
    clearAll,
    isClearing: clearMutation.isPending,

    calibration,
    calibrationSummary: summariseCalibration(calibration),
    scaleRelativeSigma: calibrationRelativeSigma(calibration),
    calibrationState,
    dispatchCalibration,
    startCalibration,
    submitCalibration,
    removeCalibration,
    isRemovingCalibration: removeCalibrationMutation.isPending,
    calibrationSceneLength,
  };
}

/** Overlay geometry for a stored measurement, by kind. */
function overlayForRow(row: MeasurementRow): OverlayItem | null {
  const { measurement, geometry, formatted } = row;
  if (!geometry) return null;

  const value = measurementSceneValue(measurement);
  const label =
    value === null
      ? measurement.label
      : `${measurement.label ? `${measurement.label} · ` : ''}${formatted.value}`;
  // `undefined`, never `null`: an absent ± must not show up as an empty span.
  const detail = formatted.uncertainty ?? undefined;

  switch (geometry.kind) {
    case 'distance':
      return { id: measurement.id, tone: 'measure', a: geometry.a, b: geometry.b, label, detail };

    case 'polyline':
      return {
        id: measurement.id,
        tone: 'measure',
        a: geometry.points[0],
        points: geometry.points,
        label,
        detail,
      };

    case 'height': {
      const [p1, p2, p3] = geometry.planePoints;
      return {
        id: measurement.id,
        tone: 'measure',
        a: geometry.point,
        b: geometry.foot,
        // The plane travels with the measurement, so show what it was measured
        // against rather than leaving a line hanging in space.
        guide: [p1, p2, p3, p1],
        label,
        detail,
      };
    }

    case 'angle':
      return {
        id: measurement.id,
        tone: 'measure',
        a: geometry.armA,
        points: [geometry.armA, geometry.vertex, geometry.armB],
        guide: angleArcPoints(
          geometry.vertex,
          geometry.armA,
          geometry.armB,
          angleArcRadius(geometry.vertex, geometry.armA, geometry.armB),
        ),
        label,
        detail,
        anchor: geometry.vertex,
      };
  }
}

/**
 * Overlay for points that are not a measurement yet.
 *
 * Kept minimal on purpose: with a single point the item is exactly
 * `{ id, tone, a }`, which is what a lone pending marker should be.
 */
function draftOverlay(id: string, points: readonly Point3[], label: string | null): OverlayItem {
  const item: OverlayItem = { id, tone: 'pending', a: points[0] };
  if (points.length > 1) item.points = points;
  if (label) item.label = label;
  return item;
}
