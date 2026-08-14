/**
 * The viewer's measurement session (WP 3.2 + 3.3 frontend).
 *
 * Holds everything that spans the canvas and the toolbar: which mode taps go
 * to, the half-finished measurement, the calibration flow, and persistence.
 *
 * Persistence is conditional by design. The viewer is reachable with a bare
 * `?src=` URL (paste a splat, look at it), and there is no project to attach
 * measurements to in that case — so the session degrades to in-memory instead
 * of refusing to measure.
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
import {
  distance3,
  distanceEndpoints,
  distanceMeasurementInput,
  formatMeasurement,
  formatMetres,
  measurementSceneValue,
  nextMeasurementLabel,
} from '../lib/measurements';
import type { OverlayItem } from '../lib/measurementOverlay';
import type { Calibration, Measurement, Point3, Project } from '../types';

export interface MeasureSessionOptions {
  /** `null` when the viewer was opened without a project (`?src=` only). */
  projectId: string | null;
  /** The fetched project, if any — the source of the calibration. */
  project?: Project | null;
}

export interface MeasureSession {
  measuring: boolean;
  toggleMeasuring: () => void;
  /** True while a tap should place a point rather than only orbit. */
  pickEnabled: boolean;
  handlePick: (point: Point3 | null) => void;

  measurements: Measurement[];
  measurementsPending: boolean;
  /** Formats a stored scene-unit magnitude for display. */
  format: (sceneValue: number) => string;
  overlayItems: OverlayItem[];

  /** Whether measurements survive a reload. */
  persisted: boolean;
  /** Transient one-line feedback for the toolbar (hint or failure). */
  notice: string | null;
  dismissNotice: () => void;

  deleteMeasurement: (id: string) => void;
  clearAll: () => void;
  isClearing: boolean;

  calibration: Calibration | null;
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
function localMeasurement(a: Point3, b: Point3, label: string, index: number): Measurement {
  return {
    id: `local-${index}`,
    projectId: '',
    kind: 'distance',
    points: [a, b],
    value: distance3(a, b),
    unit: 'scene',
    label,
    createdAt: new Date().toISOString(),
  };
}

export function useMeasureSession({ projectId, project }: MeasureSessionOptions): MeasureSession {
  const queryClient = useQueryClient();
  const [measuring, setMeasuring] = useState(false);
  const [pendingA, setPendingA] = useState<Point3 | null>(null);
  const [inFlight, setInFlight] = useState<[Point3, Point3] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [local, setLocal] = useState<Measurement[]>([]);
  const localCounter = useRef(0);
  const [calibrationState, dispatchCalibration] = useReducer(
    calibrationReducer,
    initialCalibrationState,
  );

  const calibration = project?.calibration ?? null;

  const measurementsQuery = useQuery({
    queryKey: queryKeys.measurements(projectId ?? ''),
    queryFn: () => api.listMeasurements(projectId ?? ''),
    enabled: Boolean(projectId),
  });

  const persisted = Boolean(projectId);
  const measurements = useMemo(
    () =>
      (persisted ? (measurementsQuery.data ?? []) : local).filter(
        (measurement) => measurement.kind === 'distance',
      ),
    [persisted, measurementsQuery.data, local],
  );

  const invalidateMeasurements = useCallback(async () => {
    if (!projectId) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.measurements(projectId) });
  }, [queryClient, projectId]);

  const createMeasurement = useMutation({
    mutationFn: (points: [Point3, Point3]) =>
      api.createMeasurement(
        projectId ?? '',
        distanceMeasurementInput(points[0], points[1], nextMeasurementLabel(measurements)),
      ),
    // `onSettled` runs after `onSuccess` has awaited the refetch, so the
    // placeholder segment hands over to the stored one without a blink.
    onSuccess: invalidateMeasurements,
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

  const completeMeasurement = useCallback(
    (a: Point3, b: Point3) => {
      if (distance3(a, b) <= 0) {
        setNotice('Both points landed on the same spot — try again further apart.');
        return;
      }
      if (projectId) {
        setInFlight([a, b]);
        createMeasurement.mutate([a, b]);
        return;
      }
      localCounter.current += 1;
      setLocal((rows) => [
        ...rows,
        localMeasurement(a, b, nextMeasurementLabel(rows), localCounter.current),
      ]);
    },
    [projectId, createMeasurement],
  );

  const handlePick = useCallback(
    (point: Point3 | null) => {
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

      if (pendingA === null) {
        setPendingA(point);
        return;
      }
      setPendingA(null);
      completeMeasurement(pendingA, point);
    },
    [calibrationState.stage, measuring, pendingA, completeMeasurement],
  );

  const toggleMeasuring = useCallback(() => {
    setPendingA(null);
    setNotice(null);
    dispatchCalibration({ type: 'cancel' });
    setMeasuring((on) => !on);
  }, []);

  const startCalibration = useCallback(() => {
    setPendingA(null);
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
    setPendingA(null);
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
        setLocal((rows) => rows.filter((row) => row.id !== id));
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

    for (const measurement of measurements) {
      const endpoints = distanceEndpoints(measurement);
      if (!endpoints) continue;
      const value = measurementSceneValue(measurement);
      items.push({
        id: measurement.id,
        tone: 'measure',
        a: endpoints[0],
        b: endpoints[1],
        label:
          value === null
            ? measurement.label
            : `${measurement.label ? `${measurement.label} · ` : ''}${format(value)}`,
      });
    }

    // The POST is still in flight: keep the segment on screen so the scene
    // never appears to swallow a finished measurement.
    if (inFlight) {
      items.push({
        id: 'in-flight',
        tone: 'pending',
        a: inFlight[0],
        b: inFlight[1],
        label: format(distance3(inFlight[0], inFlight[1])),
      });
    }

    if (pendingA) items.push({ id: 'pending-a', tone: 'pending', a: pendingA });

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
    } else if (calibration) {
      // …or, once saved, the reference the scale came from.
      items.push({
        id: 'calibration-reference',
        tone: 'calibration',
        a: calibration.reference.pointA,
        b: calibration.reference.pointB,
        label: `Reference · ${formatMetres(calibration.reference.realDistanceM)}`,
      });
    }

    return items;
  }, [measurements, inFlight, pendingA, calibrationState, calibration, format]);

  const calibrationSceneLength =
    calibrationState.pointA && calibrationState.pointB
      ? distance3(calibrationState.pointA, calibrationState.pointB)
      : null;

  return {
    measuring,
    toggleMeasuring,
    pickEnabled: measuring || isCalibrationPicking(calibrationState.stage),
    handlePick,

    measurements,
    measurementsPending: persisted && measurementsQuery.isPending,
    format,
    overlayItems,

    persisted,
    notice,
    dismissNotice: useCallback(() => setNotice(null), []),

    deleteMeasurement,
    clearAll,
    isClearing: clearMutation.isPending,

    calibration,
    calibrationState,
    dispatchCalibration,
    startCalibration,
    submitCalibration,
    removeCalibration,
    isRemovingCalibration: removeCalibrationMutation.isPending,
    calibrationSceneLength,
  };
}
