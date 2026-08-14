/**
 * Choosing which of a job's artifacts to open in the viewer.
 *
 * The worker publishes several representations of the same scene (a raw
 * `output.ply` plus compressed forms). Over a phone connection the compressed
 * ones are the difference between seconds and minutes, so preference order
 * matters — hence a tested function rather than an inline `find`.
 */

import type { Artifact } from '../types';

/** Formats the SplatViewer can load, best-first (PLAN.md §2). */
export const VIEWER_FORMAT_RANK: Record<string, number> = {
  splat: 1,
  ksplat: 2,
  spz: 3,
  ply: 4,
};

/** The worker's canonical compressed output; always wins when present. */
const PREFERRED_FILENAME = 'scene.splat';

function rank(artifact: Artifact): number {
  if (artifact.filename.toLowerCase() === PREFERRED_FILENAME) return 0;
  const format = (artifact.format || artifact.filename.split('.').pop() || '').toLowerCase();
  return VIEWER_FORMAT_RANK[format] ?? Number.POSITIVE_INFINITY;
}

/** Every artifact the viewer could display, best-first. */
export function viewableArtifacts(artifacts: Artifact[] | undefined | null): Artifact[] {
  return (artifacts ?? [])
    .filter((artifact) => Number.isFinite(rank(artifact)))
    .sort((a, b) => rank(a) - rank(b) || a.filename.localeCompare(b.filename));
}

/**
 * The artifact to open: `scene.splat` when the worker produced it, otherwise
 * the best remaining format (…`.ksplat`, `.spz`, then the raw `output.ply`).
 * Returns `null` when nothing is displayable.
 */
export function selectSceneArtifact(artifacts: Artifact[] | undefined | null): Artifact | null {
  return viewableArtifacts(artifacts)[0] ?? null;
}

/** Human-readable size for the artifact chip. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
