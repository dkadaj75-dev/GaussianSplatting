import { Suspense, lazy, useCallback, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAppStore } from '../store/useAppStore';
import { api, queryKeys } from '../lib/api';
import { useMeasureSession } from '../hooks/useMeasureSession';
import { MeasureTools } from '../components/MeasureTools';
import type { ReportCapture } from '../components/ExportSheet';
import type { ViewerCapture } from '../components/SplatViewer';
import { ViewerIcon } from '../components/icons';

// three.js + the splat renderer are several hundred KB; keep them off the
// Projects and Capture routes entirely.
const SplatViewer = lazy(() => import('../components/SplatViewer'));

const SUPPORTED = ['.ply', '.splat', '.ksplat', '.spz'];

function isPlausibleSplatUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  try {
    const { pathname } = new URL(trimmed, window.location.href);
    return SUPPORTED.some((extension) => pathname.toLowerCase().endsWith(extension));
  } catch {
    return false;
  }
}

export function ViewerPage() {
  const storedSrc = useAppStore((s) => s.viewerSrc);
  const setViewerSrc = useAppStore((s) => s.setViewerSrc);
  const [searchParams, setSearchParams] = useSearchParams();

  // `?src=` is the source of truth on this route: it makes a finished scene
  // linkable and survives a reload. The store mirrors it so the scene is still
  // there after a trip to another tab.
  const linkedSrc = searchParams.get('src');
  const viewerSrc = linkedSrc ?? storedSrc;
  const [draft, setDraft] = useState(viewerSrc ?? '');

  // `?project=` is optional. With it, measurements persist and the scene knows
  // its scale; without it the viewer is still a viewer (WP 3.2).
  const projectId = searchParams.get('project');

  const projectQuery = useQuery({
    queryKey: queryKeys.project(projectId ?? ''),
    queryFn: () => api.getProject(projectId ?? ''),
    enabled: Boolean(projectId),
  });

  // A project id that no longer resolves must not silently swallow
  // measurements into a project that isn't there.
  const resolvedProjectId = projectQuery.isError ? null : projectId;
  const session = useMeasureSession({
    projectId: resolvedProjectId,
    project: projectQuery.data,
  });

  // The export sheet pulls a frame at the moment it is pressed; the viewer
  // fills this in while a scene is loaded (WP 5.3).
  const captureRef = useRef<ViewerCapture | null>(null);
  const capture = useCallback<ReportCapture>(
    (options) => captureRef.current?.capture(options) ?? null,
    [],
  );

  const load = (value: string) => {
    setViewerSrc(value);
    const next: Record<string, string> = { src: value };
    if (projectId) next.project = projectId;
    setSearchParams(next, { replace: true });
  };

  const close = () => {
    setViewerSrc(null);
    setSearchParams({}, { replace: true });
  };

  const trimmed = draft.trim();
  const valid = isPlausibleSplatUrl(trimmed);

  return (
    <div className="flex h-full flex-col">
      <form
        className="flex shrink-0 items-center gap-2 border-b border-line bg-sunken px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) load(trimmed);
        }}
      >
        <label htmlFor="splat-url" className="sr-only">
          Splat URL
        </label>
        <input
          id="splat-url"
          type="url"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="https://example.com/scene.ksplat"
          className="min-h-touch min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 font-mono text-sm outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={!valid}
          className="min-h-touch shrink-0 rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent transition-opacity enabled:hover:opacity-90 disabled:opacity-40"
        >
          Load
        </button>
        {viewerSrc ? (
          <button
            type="button"
            onClick={close}
            className="min-h-touch shrink-0 rounded-lg border border-line px-3 text-sm font-medium transition-colors hover:bg-raised"
          >
            Close
          </button>
        ) : null}
      </form>

      <div className="relative min-h-0 flex-1">
        {viewerSrc ? (
          <Suspense
            fallback={
              <div className="grid size-full place-items-center bg-black text-sm text-muted">
                Loading renderer…
              </div>
            }
          >
            <SplatViewer
              key={viewerSrc}
              src={viewerSrc}
              pickEnabled={session.pickEnabled}
              onPick={session.handlePick}
              onSceneSpacing={session.reportSceneSpacing}
              overlayItems={session.overlayItems}
              captureRef={captureRef}
            >
              <MeasureTools
                session={session}
                projectName={projectQuery.data?.name}
                capture={capture}
              />
            </SplatViewer>
          </Suspense>
        ) : (
          <div className="grid size-full place-items-center overflow-y-auto p-6">
            <div className="max-w-md text-center">
              <ViewerIcon className="mx-auto size-10 text-muted" />
              <h1 className="mt-3 text-lg font-semibold tracking-tight">No scene loaded</h1>
              <p className="mt-2 text-sm text-muted">
                Paste a URL to a <code className="font-mono">.ply</code>,{' '}
                <code className="font-mono">.splat</code>,{' '}
                <code className="font-mono">.ksplat</code> or{' '}
                <code className="font-mono">.spz</code> file above, or{' '}
                <Link to="/" className="underline underline-offset-2 hover:text-content">
                  open a finished project
                </Link>{' '}
                from the Projects tab.
              </p>
              <p className="mt-4 text-xs text-muted">
                One finger orbits · two fingers pinch to zoom and pan · drag with the right mouse
                button to pan on desktop. The host must allow cross-origin requests.
              </p>
              <p className="mt-2 text-xs text-muted">
                Open a scene from its project to measure with a saved scale — a scene loaded by URL
                alone measures in relative units and keeps nothing.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default ViewerPage;
