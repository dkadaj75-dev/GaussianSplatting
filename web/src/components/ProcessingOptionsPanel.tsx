/**
 * "Processing options" disclosure above the Start-processing button.
 *
 * Collapsed by default: the defaults are what almost everyone should run, and
 * a wall of tuning controls in front of the primary action would be its own
 * kind of failure. Open, it stays one narrow column of ≥44 px rows so it works
 * one-thumbed on a phone (PLAN.md §3).
 */

import { useId, useState } from 'react';
import {
  DOWNSCALE_CHOICES,
  MAX_ITERATIONS,
  MIN_ITERATIONS,
  PRESET_ITERATIONS,
  loadProcessingOptions,
  saveProcessingOptions,
  summariseJobParams,
  toJobParams,
} from '../lib/processingOptions';
import type { ProcessingOptions, QualityPreset } from '../lib/processingOptions';
import { ChevronIcon } from './icons';

export interface ProcessingOptionsPanelProps {
  /**
   * Whose options these are. Storage is the single source of truth — the panel
   * writes every edit straight back, and whoever starts the run reads it there
   * (`loadProcessingOptions`), so mount this with `key={projectId}`.
   */
  projectId: string;
  disabled?: boolean;
}

const FIELD =
  'mt-1 min-h-touch w-full rounded-lg border border-line bg-sunken px-3 text-sm outline-none focus:border-accent disabled:opacity-40';

const CHECKBOX_ROW = 'flex min-h-touch cursor-pointer items-center gap-3 text-sm';

const DOWNSCALE_LABEL: Record<number, string> = {
  1: 'Full resolution — sharpest, needs the most VRAM',
  2: 'Half — recommended for 8 GB GPUs',
  4: 'Quarter — fastest, softest detail',
};

export function ProcessingOptionsPanel({
  projectId,
  disabled = false,
}: ProcessingOptionsPanelProps) {
  const [options, setOptions] = useState<ProcessingOptions>(() =>
    loadProcessingOptions(projectId),
  );
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const qualityId = `${panelId}-quality`;
  const iterationsId = `${panelId}-iterations`;
  const downscaleId = `${panelId}-downscale`;
  const markerId = `${panelId}-marker`;

  const patch = (changes: Partial<ProcessingOptions>) => {
    const next = { ...options, ...changes };
    setOptions(next);
    saveProcessingOptions(projectId, next);
  };

  const summary = summariseJobParams(toJobParams(options));

  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-touch w-full items-center gap-2 rounded-lg px-3 text-xs font-medium text-muted transition-colors hover:bg-raised hover:text-content"
      >
        <ChevronIcon className={`size-4 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="shrink-0">Processing options</span>
        {summary ? (
          <span className="min-w-0 flex-1 truncate text-right text-[11px]">{summary}</span>
        ) : null}
      </button>

      {open ? (
        <div id={panelId} className="mt-2 flex flex-col gap-4 rounded-xl border border-line bg-raised p-3">
          <div>
            <label htmlFor={qualityId} className="block text-sm font-medium">
              Quality
            </label>
            <select
              id={qualityId}
              value={options.preset}
              disabled={disabled}
              onChange={(event) => patch({ preset: event.target.value as QualityPreset })}
              className={FIELD}
            >
              <option value="draft">Draft — {PRESET_ITERATIONS.draft} iterations</option>
              <option value="standard">Standard — {PRESET_ITERATIONS.standard} iterations</option>
              <option value="high">High — {PRESET_ITERATIONS.high} iterations</option>
              <option value="custom">Custom…</option>
            </select>
            {options.preset === 'custom' ? (
              <>
                <label htmlFor={iterationsId} className="mt-3 block text-sm font-medium">
                  Iterations
                </label>
                <input
                  id={iterationsId}
                  type="number"
                  inputMode="numeric"
                  min={MIN_ITERATIONS}
                  max={MAX_ITERATIONS}
                  step={500}
                  value={options.customIterations}
                  disabled={disabled}
                  onChange={(event) =>
                    patch({ customIterations: Number(event.target.value) })
                  }
                  className={FIELD}
                />
              </>
            ) : (
              <p className="mt-1 text-xs text-muted">
                Longer training sharpens detail; it does not fix photos that never aligned.
              </p>
            )}
          </div>

          <div>
            <label htmlFor={downscaleId} className="block text-sm font-medium">
              Image resolution
            </label>
            <select
              id={downscaleId}
              value={options.downscale}
              disabled={disabled}
              onChange={(event) => patch({ downscale: Number(event.target.value) })}
              className={FIELD}
            >
              {DOWNSCALE_CHOICES.map((factor) => (
                <option key={factor} value={factor}>
                  {DOWNSCALE_LABEL[factor]}
                </option>
              ))}
            </select>
          </div>

          <label className={CHECKBOX_ROW}>
            <input
              type="checkbox"
              checked={options.sequential}
              disabled={disabled}
              onChange={(event) => patch({ sequential: event.target.checked })}
              className="size-5 shrink-0 accent-accent"
            />
            <span>
              Photos taken in order (faster)
              <span className="mt-0.5 block text-xs text-muted">
                Matches each photo against its neighbours only — right for a walk-around, wrong for
                a shuffled set.
              </span>
            </span>
          </label>

          <div>
            <label className={CHECKBOX_ROW}>
              <input
                type="checkbox"
                checked={options.useMarker}
                disabled={disabled}
                onChange={(event) => patch({ useMarker: event.target.checked })}
                className="size-5 shrink-0 accent-accent"
              />
              <span>I placed a printed marker</span>
            </label>
            {options.useMarker ? (
              <>
                <label htmlFor={markerId} className="mt-1 block text-sm font-medium">
                  Marker size (mm)
                </label>
                <input
                  id={markerId}
                  type="number"
                  inputMode="decimal"
                  min={1}
                  step={1}
                  value={options.markerLengthMm}
                  disabled={disabled}
                  onChange={(event) => patch({ markerLengthMm: Number(event.target.value) })}
                  className={FIELD}
                />
                <p className="mt-1 text-xs text-muted">
                  The printed square’s edge length — this is what gives the scene real-world scale.
                </p>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default ProcessingOptionsPanel;
