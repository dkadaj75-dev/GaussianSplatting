import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROCESSING_OPTIONS,
  loadProcessingOptions,
  optionsStorageKey,
  parseProcessingOptions,
  resolveIterations,
  saveProcessingOptions,
  summariseJobParams,
  toJobParams,
} from './processingOptions';
import type { OptionsStorage, ProcessingOptions } from './processingOptions';

function options(overrides: Partial<ProcessingOptions> = {}): ProcessingOptions {
  return { ...DEFAULT_PROCESSING_OPTIONS, ...overrides };
}

/** In-memory `Storage` slice, so a test never depends on the jsdom global. */
function memoryStorage(seed: Record<string, string> = {}): OptionsStorage & {
  entries: Map<string, string>;
} {
  const entries = new Map(Object.entries(seed));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}

describe('toJobParams', () => {
  it('defaults to half resolution and the worker’s 7000 iterations', () => {
    expect(toJobParams(options())).toEqual({
      downscale: 2,
      iterations: 7000,
      matcher: 'exhaustive',
    });
  });

  it('maps each quality preset to its iteration count', () => {
    expect(toJobParams(options({ preset: 'draft' })).iterations).toBe(3000);
    expect(toJobParams(options({ preset: 'standard' })).iterations).toBe(7000);
    expect(toJobParams(options({ preset: 'high' })).iterations).toBe(30000);
  });

  it('uses the typed iterations only for the custom preset', () => {
    expect(resolveIterations(options({ preset: 'custom', customIterations: 12500 }))).toBe(12500);
    // A stale custom value must not leak into a named preset.
    expect(resolveIterations(options({ preset: 'draft', customIterations: 12500 }))).toBe(3000);
  });

  it('falls back to the default rather than asking the worker for 0 iterations', () => {
    expect(resolveIterations(options({ preset: 'custom', customIterations: 0 }))).toBe(7000);
    expect(resolveIterations(options({ preset: 'custom', customIterations: Number.NaN }))).toBe(
      7000,
    );
    // Clamped, so a fat-fingered 9 999 999 cannot queue a week of training.
    expect(resolveIterations(options({ preset: 'custom', customIterations: 9_999_999 }))).toBe(
      200_000,
    );
  });

  it('switches the matcher on the "photos taken in order" checkbox', () => {
    expect(toJobParams(options({ sequential: true })).matcher).toBe('sequential');
    expect(toJobParams(options({ sequential: false })).matcher).toBe('exhaustive');
  });

  it('converts the marker size from millimetres to metres', () => {
    expect(toJobParams(options({ useMarker: true, markerLengthMm: 150 })).marker_length_m).toBe(
      0.15,
    );
    expect(toJobParams(options({ useMarker: true, markerLengthMm: 42.5 })).marker_length_m).toBe(
      0.0425,
    );
  });

  it('omits the marker entirely unless the user says one is in the photos', () => {
    expect(toJobParams(options({ useMarker: false, markerLengthMm: 150 }))).not.toHaveProperty(
      'marker_length_m',
    );
    // Checked but blank: a marker "of no size" is worse than no marker at all.
    expect(toJobParams(options({ useMarker: true, markerLengthMm: 0 }))).not.toHaveProperty(
      'marker_length_m',
    );
  });
});

describe('processing options persistence', () => {
  it('round-trips the last-used options for a project', () => {
    const storage = memoryStorage();
    const chosen = options({
      preset: 'custom',
      customIterations: 15000,
      downscale: 1,
      sequential: true,
      useMarker: true,
      markerLengthMm: 200,
    });

    saveProcessingOptions('p1', chosen, storage);

    expect(storage.entries.has(optionsStorageKey('p1'))).toBe(true);
    expect(loadProcessingOptions('p1', storage)).toEqual(chosen);
  });

  it('keeps projects apart', () => {
    const storage = memoryStorage();
    saveProcessingOptions('p1', options({ downscale: 4 }), storage);

    expect(loadProcessingOptions('p1', storage).downscale).toBe(4);
    expect(loadProcessingOptions('p2', storage)).toEqual(DEFAULT_PROCESSING_OPTIONS);
  });

  it('degrades to defaults on corrupt or foreign stored values', () => {
    const storage = memoryStorage({ [optionsStorageKey('p1')]: '{not json' });
    expect(loadProcessingOptions('p1', storage)).toEqual(DEFAULT_PROCESSING_OPTIONS);

    expect(parseProcessingOptions(null)).toEqual(DEFAULT_PROCESSING_OPTIONS);
    expect(
      parseProcessingOptions({ preset: 'ultra', downscale: 3, markerLengthMm: -5 }),
    ).toEqual(DEFAULT_PROCESSING_OPTIONS);
  });

  it('survives storage being unavailable', () => {
    expect(() => saveProcessingOptions('p1', options(), null)).not.toThrow();
    expect(loadProcessingOptions('p1', null)).toEqual(DEFAULT_PROCESSING_OPTIONS);
  });
});

describe('summariseJobParams', () => {
  it('renders the chosen options as one line', () => {
    expect(
      summariseJobParams({ downscale: 2, iterations: 7000, matcher: 'sequential' }),
    ).toBe('Half res · 7000 iterations · sequential');
    expect(summariseJobParams({ downscale: 1, iterations: 30000, matcher: 'exhaustive' })).toBe(
      'Full res · 30000 iterations · exhaustive',
    );
    expect(summariseJobParams({ downscale: 4 })).toBe('Quarter res');
  });

  it('reports the marker back in millimetres', () => {
    expect(summariseJobParams({ downscale: 2, marker_length_m: 0.15 })).toBe(
      'Half res · 150 mm marker',
    );
  });

  it('says nothing about a job that carries no (or unusable) params', () => {
    expect(summariseJobParams(undefined)).toBeNull();
    expect(summariseJobParams({})).toBeNull();
    expect(summariseJobParams({ matcher: 'magic', iterations: 'lots' })).toBeNull();
  });
});
