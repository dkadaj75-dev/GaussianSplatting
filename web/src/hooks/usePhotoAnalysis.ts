/**
 * Runs the capture-time photo checks (`lib/photoQuality`) over the pending
 * photo list without ever blocking the UI.
 *
 * A 40-photo set means 40 decodes; done in one go that is a visible freeze on a
 * phone. So photos are analysed **one at a time**, yielding to the browser
 * between each — `requestIdleCallback` where it exists, a macrotask otherwise —
 * and every photo carries its own pending state so the grid can show progress
 * instead of appearing stuck.
 *
 * Where the platform cannot analyse at all (no `createImageBitmap`, no 2D
 * canvas), the hook reports `supported: false` and the page simply omits the
 * badges.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  assessPhoto,
  findNearDuplicate,
  isPhotoAnalysisSupported,
} from '../lib/photoQuality';
import type { PendingPhoto } from '../types';

/** Per-photo lifecycle: queued → being analysed → judged (or given up on). */
export type PhotoCheckState = 'pending' | 'analyzing' | 'done' | 'skipped';

interface PhotoCheck {
  state: PhotoCheckState;
  blurScore: number | null;
  isBlurry: boolean;
  hash: bigint | null;
}

export interface PhotoAnalysis {
  state: PhotoCheckState;
  blurScore: number | null;
  isBlurry: boolean;
  /** Id of the earlier photo this one near-duplicates, if any. */
  duplicateOf: string | null;
  duplicateOfName: string | null;
  /** True when the photo has a warning worth showing. */
  flagged: boolean;
}

export interface PhotoAnalysisReport {
  /** One entry per photo currently in the list. */
  analyses: Record<string, PhotoAnalysis>;
  /** False when the browser cannot decode photos for analysis. */
  supported: boolean;
  /** Photos not yet judged. */
  remaining: number;
  blurryIds: string[];
  duplicateIds: string[];
  /** Blurry ∪ duplicate, in list order — what "remove flagged" acts on. */
  flaggedIds: string[];
}

const IDLE_TIMEOUT_MS = 200;

/** Hands the main thread back between photos. */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => resolve(), { timeout: IDLE_TIMEOUT_MS });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

const SKIPPED: PhotoCheck = { state: 'skipped', blurScore: null, isBlurry: false, hash: null };
const ANALYZING: PhotoCheck = { state: 'analyzing', blurScore: null, isBlurry: false, hash: null };
const PENDING: PhotoCheck = { state: 'pending', blurScore: null, isBlurry: false, hash: null };

export function usePhotoAnalysis(photos: readonly PendingPhoto[]): PhotoAnalysisReport {
  // Resolved once: the capability cannot change during a session, and reading
  // it lazily keeps the module import side-effect free.
  const [supported] = useState(isPhotoAnalysisSupported);

  // The ref is the synchronous source of truth (a loop must see its own writes
  // before React has re-rendered); the state object exists to trigger renders.
  const checksRef = useRef<Map<string, PhotoCheck>>(new Map());
  const [checks, setChecks] = useState<Record<string, PhotoCheck>>({});

  const photosRef = useRef(photos);
  useEffect(() => {
    photosRef.current = photos;
  });

  /**
   * Publishes one result. Also drops entries for photos that have since been
   * removed — pruning here rather than in an effect keeps every state update
   * on the async path, where it cannot cascade a render.
   */
  const commit = useCallback((id: string, check: PhotoCheck) => {
    const checks = checksRef.current;
    checks.set(id, check);
    const live = new Set(photosRef.current.map((photo) => photo.id));
    for (const key of checks.keys()) {
      if (!live.has(key)) checks.delete(key);
    }
    const next: Record<string, PhotoCheck> = {};
    for (const [key, value] of checks) next[key] = value;
    setChecks(next);
  }, []);

  useEffect(() => {
    if (!supported || photos.length === 0) return;

    const checks = checksRef.current;
    let cancelled = false;

    const nextPhoto = () => photosRef.current.find((photo) => !checks.has(photo.id)) ?? null;

    const run = async () => {
      // Let the new thumbnails paint before any decoding starts.
      await yieldToBrowser();

      for (let photo = nextPhoto(); photo && !cancelled; photo = nextPhoto()) {
        commit(photo.id, ANALYZING);

        const assessment = await assessPhoto(photo.file);
        if (cancelled) return;

        commit(
          photo.id,
          assessment
            ? {
                state: 'done',
                blurScore: assessment.blurScore,
                isBlurry: assessment.isBlurry,
                hash: assessment.hash,
              }
            : SKIPPED,
        );

        await yieldToBrowser();
        if (cancelled) return;
      }
    };

    void run();

    return () => {
      cancelled = true;
      // A photo caught mid-flight would otherwise stay 'analyzing' forever.
      for (const [id, check] of checks) {
        if (check.state === 'analyzing') checks.delete(id);
      }
    };
  }, [photos, supported, commit]);

  return useMemo(() => {
    const analyses: Record<string, PhotoAnalysis> = {};
    const blurryIds: string[] = [];
    const duplicateIds: string[] = [];
    const flaggedIds: string[] = [];
    const seen: { id: string; hash: bigint }[] = [];
    let remaining = 0;

    for (const photo of photos) {
      // Where analysis cannot run at all, every photo is simply "not judged".
      const check = !supported ? SKIPPED : (checks[photo.id] ?? PENDING);

      // Duplicates are derived per render rather than stored: removing the
      // keeper must un-flag the copies that pointed at it.
      let duplicateOf: PendingPhoto | null = null;
      if (check.hash !== null) {
        const match = findNearDuplicate(check.hash, seen);
        if (match) {
          duplicateOf = photos.find((candidate) => candidate.id === match.id) ?? null;
        } else {
          seen.push({ id: photo.id, hash: check.hash });
        }
      }

      const flagged = check.isBlurry || duplicateOf !== null;
      analyses[photo.id] = {
        state: check.state,
        blurScore: check.blurScore,
        isBlurry: check.isBlurry,
        duplicateOf: duplicateOf?.id ?? null,
        duplicateOfName: duplicateOf?.name ?? null,
        flagged,
      };

      if (check.state === 'pending' || check.state === 'analyzing') remaining += 1;
      if (check.isBlurry) blurryIds.push(photo.id);
      if (duplicateOf) duplicateIds.push(photo.id);
      if (flagged) flaggedIds.push(photo.id);
    }

    return { analyses, supported, remaining, blurryIds, duplicateIds, flaggedIds };
  }, [photos, checks, supported]);
}
