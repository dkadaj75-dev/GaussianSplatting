/**
 * Processing options for a pipeline run (PLAN.md §2 "deployment profiles").
 *
 * The worker exposes a handful of knobs that materially change how a run
 * behaves — training length, the resolution the images are trained at, which
 * COLMAP matcher runs, and the size of a printed ArUco marker for auto-scale
 * (PLAN.md §5 path 1). This module owns the whole translation between the form
 * the user sees and the `params` object the API stores on the job, plus the
 * per-project memory of the last choices.
 *
 * Kept free of React so every rule here — preset → iterations, mm → metres,
 * what a malformed stored blob degrades to — is unit-testable on its own.
 */

export const QUALITY_PRESETS = ['draft', 'standard', 'high', 'custom'] as const;
export type QualityPreset = (typeof QUALITY_PRESETS)[number];

/** Training iterations behind each named preset; `custom` is free-form. */
export const PRESET_ITERATIONS: Record<Exclude<QualityPreset, 'custom'>, number> = {
  draft: 3000,
  standard: 7000,
  high: 30000,
};

/** Image downscale factors the picker offers. `1` trains at full resolution. */
export const DOWNSCALE_CHOICES = [1, 2, 4] as const;

export const MIN_ITERATIONS = 100;
export const MAX_ITERATIONS = 200_000;

export type Matcher = 'exhaustive' | 'sequential';

/** The form's state — UI units (millimetres), not wire units. */
export interface ProcessingOptions {
  preset: QualityPreset;
  /** Only read when `preset` is `custom`. */
  customIterations: number;
  downscale: number;
  /** Photos shot as a walk-around → COLMAP's sequential matcher. */
  sequential: boolean;
  useMarker: boolean;
  /** Printed marker edge length in **millimetres** — what a ruler reads. */
  markerLengthMm: number;
}

/**
 * Defaults aimed at the machine most people actually have: half resolution
 * keeps an 8 GB consumer GPU inside its VRAM budget (PLAN.md §2), and 7000
 * iterations is the worker's own default.
 */
export const DEFAULT_PROCESSING_OPTIONS: ProcessingOptions = {
  preset: 'standard',
  customIterations: PRESET_ITERATIONS.standard,
  downscale: 2,
  sequential: false,
  useMarker: false,
  markerLengthMm: 100,
};

/**
 * What the API stores on a job and hands to the worker. A type alias rather
 * than an interface so it stays assignable to the `Record<string, unknown>`
 * JSON body `lib/api.ts` sends.
 */
export type JobParams = {
  downscale: number;
  iterations: number;
  matcher: Matcher;
  /** Omitted unless the user says a printed marker is in the photos. */
  marker_length_m?: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Iterations the run will actually use, preset or hand-typed. */
export function resolveIterations(options: ProcessingOptions): number {
  if (options.preset !== 'custom') return PRESET_ITERATIONS[options.preset];
  const typed = Math.round(options.customIterations);
  if (!Number.isFinite(typed) || typed <= 0) return PRESET_ITERATIONS.standard;
  return clamp(typed, MIN_ITERATIONS, MAX_ITERATIONS);
}

/** Metres, rounded to the micrometre so 150 mm never becomes 0.15000000000000002. */
export function millimetresToMetres(mm: number): number {
  return Math.round(mm * 1000) / 1_000_000;
}

/** The form as the API's `params` object. */
export function toJobParams(options: ProcessingOptions): JobParams {
  const params: JobParams = {
    downscale: normaliseDownscale(options.downscale),
    iterations: resolveIterations(options),
    matcher: options.sequential ? 'sequential' : 'exhaustive',
  };
  // A marker length of zero would tell the worker to look for a marker of no
  // size, which is worse than not mentioning one at all.
  if (options.useMarker && Number.isFinite(options.markerLengthMm) && options.markerLengthMm > 0) {
    params.marker_length_m = millimetresToMetres(options.markerLengthMm);
  }
  return params;
}

function normaliseDownscale(value: number): number {
  const factor = Math.round(value);
  if (!Number.isFinite(factor) || factor < 1) return DEFAULT_PROCESSING_OPTIONS.downscale;
  return factor;
}

// --- Persistence -------------------------------------------------------------
//
// Per project, because "the last run of this scene" is the setting a re-run
// wants back — not whatever some other project was tuned to.

export const STORAGE_PREFIX = 'splatscene:processing-options:';

export function optionsStorageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId}`;
}

/** The slice of `Storage` we need — so tests can pass a plain object. */
export type OptionsStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Storage of last resort, for private modes and hardened browsers where
 * touching `localStorage` throws: the choices then live as long as the tab
 * does, which still beats the form resetting under the user mid-session.
 */
const memoryEntries = new Map<string, string>();

const MEMORY_STORAGE: OptionsStorage = {
  getItem: (key) => memoryEntries.get(key) ?? null,
  setItem: (key, value) => {
    memoryEntries.set(key, value);
  },
};

function defaultStorage(): OptionsStorage {
  try {
    return typeof localStorage === 'undefined' ? MEMORY_STORAGE : localStorage;
  } catch {
    return MEMORY_STORAGE;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Rebuilds the form state from whatever is in storage, field by field: a blob
 * written by an older (or newer) build must degrade to the defaults rather than
 * poison the form or throw on the way to rendering the page.
 */
export function parseProcessingOptions(raw: unknown): ProcessingOptions {
  if (!isRecord(raw)) return { ...DEFAULT_PROCESSING_OPTIONS };

  const preset = QUALITY_PRESETS.includes(raw.preset as QualityPreset)
    ? (raw.preset as QualityPreset)
    : DEFAULT_PROCESSING_OPTIONS.preset;

  const storedDownscale = Math.round(readNumber(raw.downscale, NaN));
  const downscale = (DOWNSCALE_CHOICES as readonly number[]).includes(storedDownscale)
    ? storedDownscale
    : DEFAULT_PROCESSING_OPTIONS.downscale;

  const customIterations = clamp(
    Math.round(readNumber(raw.customIterations, DEFAULT_PROCESSING_OPTIONS.customIterations)),
    MIN_ITERATIONS,
    MAX_ITERATIONS,
  );

  const markerLengthMm = readNumber(
    raw.markerLengthMm,
    DEFAULT_PROCESSING_OPTIONS.markerLengthMm,
  );

  return {
    preset,
    customIterations,
    downscale,
    sequential: raw.sequential === true,
    useMarker: raw.useMarker === true,
    markerLengthMm: markerLengthMm > 0 ? markerLengthMm : DEFAULT_PROCESSING_OPTIONS.markerLengthMm,
  };
}

export function loadProcessingOptions(
  projectId: string,
  storage: OptionsStorage | null = defaultStorage(),
): ProcessingOptions {
  if (!storage || !projectId) return { ...DEFAULT_PROCESSING_OPTIONS };
  try {
    const stored = storage.getItem(optionsStorageKey(projectId));
    return stored ? parseProcessingOptions(JSON.parse(stored)) : { ...DEFAULT_PROCESSING_OPTIONS };
  } catch {
    // Unreadable storage or corrupt JSON: the defaults are always a valid run.
    return { ...DEFAULT_PROCESSING_OPTIONS };
  }
}

export function saveProcessingOptions(
  projectId: string,
  options: ProcessingOptions,
  storage: OptionsStorage | null = defaultStorage(),
): void {
  if (!storage || !projectId) return;
  try {
    storage.setItem(optionsStorageKey(projectId), JSON.stringify(options));
  } catch {
    /* Quota or a blocked store — remembering the choices is a nicety, never a
       reason to fail starting the job. */
  }
}

// --- Display -----------------------------------------------------------------

/** Short label for a downscale factor, e.g. `2` → "Half res". */
export function describeDownscale(factor: number): string {
  if (factor === 1) return 'Full res';
  if (factor === 2) return 'Half res';
  if (factor === 4) return 'Quarter res';
  return `1/${factor} res`;
}

/**
 * One line describing how a run was configured, e.g.
 * "Half res · 7000 iterations · sequential · 100 mm marker".
 *
 * Reads `job.params`, which is free-form JSON on the API side and absent
 * entirely on jobs started before options existed — so every key is optional
 * and anything unrecognised is simply left out. `null` when there is nothing
 * worth saying.
 */
export function summariseJobParams(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const parts: string[] = [];

  const downscale = raw.downscale;
  if (typeof downscale === 'number' && Number.isFinite(downscale) && downscale >= 1) {
    parts.push(describeDownscale(Math.round(downscale)));
  }

  const iterations = raw.iterations;
  if (typeof iterations === 'number' && Number.isFinite(iterations) && iterations > 0) {
    parts.push(`${Math.round(iterations)} iterations`);
  }

  if (raw.matcher === 'sequential' || raw.matcher === 'exhaustive') {
    parts.push(raw.matcher);
  }

  const marker = raw.marker_length_m;
  if (typeof marker === 'number' && Number.isFinite(marker) && marker > 0) {
    parts.push(`${Math.round(marker * 1000)} mm marker`);
  }

  return parts.length > 0 ? parts.join(' · ') : null;
}
