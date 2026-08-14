/**
 * Live job progress over `ws://…/ws/jobs/{id}`.
 *
 * Field conditions (PLAN.md §3) mean the socket *will* drop, so the hook:
 *   - reconnects with backoff while the job is not terminal,
 *   - gives up on the socket after `MAX_SOCKET_FAILURES` connections that never
 *     delivered a frame, and polls `GET /api/jobs/{id}` instead,
 *   - stops everything as soon as the job reaches `done` / `failed`.
 *
 * The event-folding rules live in `lib/jobProgress.ts`; this file owns only the
 * connection lifecycle.
 */

import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { wsUrl } from '../lib/env';
import { applyJobEvent, isTerminal } from '../lib/jobProgress';
import type { Job } from '../types';

/** Consecutive silent connections before falling back to polling. */
export const MAX_SOCKET_FAILURES = 3;
/** Backoff between reconnect attempts, milliseconds. */
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000];
export const POLL_INTERVAL_MS = 5000;

export type JobConnection =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'polling'
  | 'closed';

export interface JobProgress {
  job: Job | null;
  connection: JobConnection;
  /** Set while updates are degraded or unavailable; cleared on recovery. */
  error: string | null;
}

export interface UseJobProgressOptions {
  /** Seed state (e.g. the row from `GET /api/projects/{id}/jobs`). */
  initialJob?: Job | null;
  /** Set false to keep the socket closed (job already finished, tab hidden…). */
  enabled?: boolean;
  /** Called once when the job reaches `done` or `failed`. */
  onSettled?: (job: Job) => void;
}

export function useJobProgress(
  jobId: string | null | undefined,
  { initialJob = null, enabled = true, onSettled }: UseJobProgressOptions = {},
): JobProgress {
  const seedFor = (id: string | null | undefined, seed: Job | null) =>
    seed && id && seed.id === id ? seed : null;

  const [job, setJob] = useState<Job | null>(() => seedFor(jobId, initialJob));
  const [connection, setConnection] = useState<JobConnection>('idle');
  const [error, setError] = useState<string | null>(null);

  // The job currently displayed, readable from socket callbacks without
  // re-running the effect.
  const jobRef = useRef(job);
  // Switching jobs resets the view *during render* rather than in an effect,
  // so no frame ever shows the previous job's progress.
  const [watchedId, setWatchedId] = useState<string | null>(jobId ?? null);
  if ((jobId ?? null) !== watchedId) {
    const seeded = seedFor(jobId, initialJob);
    setWatchedId(jobId ?? null);
    setJob(seeded);
    setConnection('idle');
    setError(null);
  }

  // Mirrors the rendered state into refs the socket callbacks can read. Runs
  // before the connection effect below (declaration order), so a freshly reset
  // job is already visible when a new subscription starts.
  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    jobRef.current = job;
    onSettledRef.current = onSettled;
  });

  useEffect(() => {
    if (!jobId || !enabled) return;

    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let failures = 0;
    let settled = false;

    const current = jobRef.current;
    let latest: Job | null = current && current.id === jobId ? current : null;

    const publish = (next: Job | null) => {
      if (!next || next === latest) return;
      latest = next;
      jobRef.current = next;
      setJob(next);
      if (isTerminal(next.status) && !settled) {
        settled = true;
        onSettledRef.current?.(next);
      }
    };

    const finished = () => latest !== null && isTerminal(latest.status);

    const clearTimers = () => {
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      if (pollTimer !== undefined) clearInterval(pollTimer);
      reconnectTimer = undefined;
      pollTimer = undefined;
    };

    const closeSocket = () => {
      if (!socket) return;
      // Detach first: a close we initiated must not trigger a reconnect.
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        /* Already closing. */
      }
      socket = null;
    };

    const stop = () => {
      clearTimers();
      closeSocket();
      if (!cancelled) setConnection('closed');
    };

    const poll = async () => {
      try {
        const fresh = await api.getJob(jobId);
        if (cancelled) return;
        setError(null);
        publish(fresh);
        if (isTerminal(fresh.status)) stop();
      } catch (fetchError) {
        if (cancelled) return;
        setError(
          fetchError instanceof Error ? fetchError.message : 'Could not reach the API.',
        );
      }
    };

    const startPolling = () => {
      clearTimers();
      closeSocket();
      if (cancelled) return;
      // `connection: 'polling'` is the signal that live updates are gone; an
      // error is reserved for a request that actually failed.
      setConnection('polling');
      void poll();
      pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    };

    const connect = () => {
      if (cancelled || finished()) return;
      if (typeof WebSocket === 'undefined') {
        startPolling();
        return;
      }

      setConnection(failures === 0 ? 'connecting' : 'reconnecting');

      let delivered = false;
      try {
        socket = new WebSocket(wsUrl(`/ws/jobs/${encodeURIComponent(jobId)}`));
      } catch {
        socket = null;
        failures += 1;
        scheduleRetry();
        return;
      }

      socket.onopen = () => {
        if (!cancelled) setError(null);
      };

      socket.onmessage = (event: MessageEvent) => {
        if (cancelled) return;
        delivered = true;
        failures = 0;
        setConnection('live');
        setError(null);
        publish(applyJobEvent(latest, (event as MessageEvent<string>).data));
        if (finished()) stop();
      };

      socket.onerror = () => {
        // Browsers always follow an error with a close; handled there.
      };

      socket.onclose = () => {
        socket = null;
        if (cancelled) return;
        if (finished()) {
          stop();
          return;
        }
        failures = delivered ? 1 : failures + 1;
        scheduleRetry();
      };
    };

    const scheduleRetry = () => {
      if (cancelled || finished()) return;
      if (failures >= MAX_SOCKET_FAILURES) {
        startPolling();
        return;
      }
      setConnection('reconnecting');
      const delay = RECONNECT_DELAYS_MS[Math.min(failures, RECONNECT_DELAYS_MS.length - 1)];
      reconnectTimer = setTimeout(connect, delay);
    };

    if (latest && isTerminal(latest.status)) {
      // Nothing to watch; `connection` is derived as 'closed' below.
      settled = true;
    } else {
      connect();
    }

    return () => {
      cancelled = true;
      clearTimers();
      closeSocket();
    };
  }, [jobId, enabled]);

  // Derived so the reported state cannot lag behind the job it describes.
  const effectiveConnection: JobConnection =
    !jobId || !enabled ? 'idle' : isTerminal(job?.status) ? 'closed' : connection;

  return { job, connection: effectiveConnection, error };
}
