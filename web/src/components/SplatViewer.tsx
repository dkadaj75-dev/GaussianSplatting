import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';
import { AlertIcon } from './icons';

/** Mobile GPUs choke above 2x; PLAN.md §3 mandates the clamp. */
const MAX_DEVICE_PIXEL_RATIO = 2;

type Phase = 'idle' | 'downloading' | 'processing' | 'ready' | 'error';

const PHASE_LABEL: Record<Exclude<Phase, 'idle'>, string> = {
  downloading: 'Downloading splats',
  processing: 'Building scene',
  ready: 'Ready',
  error: 'Error',
};

export interface SplatViewerProps {
  /** URL of a `.ply`, `.splat`, `.ksplat` or `.spz` file. */
  src: string;
  className?: string;
  /** Scene up-axis. Most 3DGS exports are Y-down, hence the default. */
  cameraUp?: [number, number, number];
  onReady?: () => void;
  onError?: (message: string) => void;
}

/** Derives the loader format from the path, ignoring any query string or hash. */
function formatFromUrl(src: string): GaussianSplats3D.SceneFormatValue | undefined {
  let pathname = src;
  try {
    pathname = new URL(src, window.location.href).pathname;
  } catch {
    /* Relative or malformed — fall back to raw string matching. */
  }
  const lower = pathname.toLowerCase();
  if (lower.endsWith('.ply')) return GaussianSplats3D.SceneFormat.Ply;
  if (lower.endsWith('.ksplat')) return GaussianSplats3D.SceneFormat.KSplat;
  if (lower.endsWith('.splat')) return GaussianSplats3D.SceneFormat.Splat;
  if (lower.endsWith('.spz')) return GaussianSplats3D.SceneFormat.Spz;
  return undefined;
}

function clampedPixelRatio(): number {
  return Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
}

/**
 * Samples splat centres to find a sane camera framing for an arbitrary scene.
 * Uses a percentile radius so a few stray gaussians can't push the camera into
 * the next postcode.
 */
function frameScene(
  mesh: GaussianSplats3D.SplatMesh,
  camera: THREE.PerspectiveCamera,
  controls: GaussianSplats3D.SplatOrbitControls,
): void {
  const splatCount = mesh.getSplatCount();
  if (splatCount === 0) return;

  const sampleCount = Math.min(splatCount, 4096);
  const stride = Math.max(1, Math.floor(splatCount / sampleCount));
  const centre = new THREE.Vector3();
  const scratch = new THREE.Vector3();
  const samples: THREE.Vector3[] = [];

  for (let i = 0; i < splatCount; i += stride) {
    mesh.getSplatCenter(i, scratch, true);
    samples.push(scratch.clone());
    centre.add(scratch);
  }
  if (samples.length === 0) return;
  centre.divideScalar(samples.length);

  const distances = samples.map((s) => s.distanceTo(centre)).sort((a, b) => a - b);
  const radius = Math.max(distances[Math.floor(distances.length * 0.9)] ?? 1, 1e-3);

  const fovRadians = THREE.MathUtils.degToRad(camera.fov);
  const distance = (radius / Math.sin(fovRadians / 2)) * 1.1;

  // Approach along -Z, lifted slightly along the camera's up axis.
  const offset = new THREE.Vector3(0, 0, 1)
    .addScaledVector(camera.up, -0.35)
    .normalize()
    .multiplyScalar(distance);

  camera.position.copy(centre).add(offset);
  camera.near = Math.max(distance / 1000, 0.01);
  camera.far = distance * 20;
  camera.updateProjectionMatrix();
  controls.target.copy(centre);
  controls.minDistance = distance / 100;
  controls.maxDistance = distance * 10;
  controls.update();
}

/**
 * Renders a Gaussian splat scene from `src`.
 *
 * Owns its own `WebGLRenderer` and camera (rather than letting the library
 * create them) so it can clamp the device pixel ratio, resize with the
 * container instead of the window, and recover from WebGL context loss.
 */
export function SplatViewer({ src, className, cameraUp, onReady, onError }: SplatViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [percent, setPercent] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const resetViewRef = useRef<(() => void) | null>(null);
  const flipUpRef = useRef<(() => void) | null>(null);

  // Keep the callbacks out of the effect's dependency list; they change identity
  // freely and re-creating the whole WebGL context for that would be absurd.
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onReadyRef.current = onReady;
    onErrorRef.current = onError;
  });

  const upKey = (cameraUp ?? [0, -1, 0]).join(',');

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !src) return;

    let cancelled = false;
    let viewer: GaussianSplats3D.Viewer | null = null;
    let renderer: THREE.WebGLRenderer | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const fail = (text: string) => {
      if (cancelled) return;
      setPhase('error');
      setMessage(text);
      onErrorRef.current?.(text);
    };

    setPhase('downloading');
    setPercent(0);
    setMessage(null);

    try {
      renderer = new THREE.WebGLRenderer({
        antialias: false,
        precision: 'highp',
        powerPreference: 'high-performance',
      });
    } catch {
      fail('WebGL could not be initialised. Try a different browser or device.');
      return;
    }

    const canvas = renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'none';

    const width = Math.max(container.clientWidth, 1);
    const height = Math.max(container.clientHeight, 1);
    renderer.setPixelRatio(clampedPixelRatio());
    renderer.setSize(width, height, false);
    renderer.setClearColor(0x000000, 1);
    container.appendChild(canvas);

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
    const up = new THREE.Vector3().fromArray(upKey.split(',').map(Number)).normalize();
    camera.up.copy(up);
    camera.position.set(0, 0, 4);
    camera.lookAt(0, 0, 0);

    // Both a container resize and an orientation change surface here.
    const applySize = () => {
      if (!renderer) return;
      const w = Math.max(container.clientWidth, 1);
      const h = Math.max(container.clientHeight, 1);
      renderer.setPixelRatio(clampedPixelRatio());
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      viewer?.forceRenderNextFrame();
    };
    resizeObserver = new ResizeObserver(applySize);
    resizeObserver.observe(container);

    const onContextLost = (event: Event) => {
      event.preventDefault();
      viewer?.stop();
      fail('The graphics context was lost — the device may be low on memory. Reload the scene.');
    };
    canvas.addEventListener('webglcontextlost', onContextLost, false);

    try {
      viewer = new GaussianSplats3D.Viewer({
        renderer,
        camera,
        rootElement: container,
        useBuiltInControls: true,
        // Avoids requiring cross-origin isolation (COOP/COEP) headers.
        sharedMemoryForWorkers: false,
        dynamicScene: false,
        antialiased: false,
        sphericalHarmonicsDegree: 0,
        freeIntermediateSplatData: true,
        logLevel: GaussianSplats3D.LogLevel.None,
        sceneRevealMode: GaussianSplats3D.SceneRevealMode.Gradual,
        cameraUp: up.toArray() as [number, number, number],
        initialCameraPosition: [0, 0, 4],
        initialCameraLookAt: [0, 0, 0],
      });
    } catch (error) {
      // Fall through to the shared cleanup below rather than leaking the
      // renderer, canvas and observer we just created.
      fail(error instanceof Error ? error.message : 'Could not create the splat viewer.');
    }

    const controls = viewer?.controls ?? null;
    if (controls) {
      // One finger orbits, two fingers pinch-zoom and pan (PLAN.md §3).
      controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
      controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN,
      };
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.rotateSpeed = 0.6;
      controls.zoomSpeed = 0.9;
      controls.screenSpacePanning = true;
      // The default clamp forbids looking from directly above/below.
      controls.minPolarAngle = 0;
      controls.maxPolarAngle = Math.PI;
    }

    resetViewRef.current = () => {
      const mesh = viewer?.splatMesh;
      if (mesh && controls) frameScene(mesh, camera, controls);
      viewer?.forceRenderNextFrame();
    };
    flipUpRef.current = () => {
      camera.up.negate();
      controls?.update();
      const mesh = viewer?.splatMesh;
      if (mesh && controls) frameScene(mesh, camera, controls);
      viewer?.forceRenderNextFrame();
    };

    try {
      viewer
        ?.addSplatScene(src, {
          format: formatFromUrl(src),
          // We render our own progress UI instead of the library's overlay.
          showLoadingUI: false,
          progressiveLoad: true,
          splatAlphaRemovalThreshold: 5,
          onProgress: (progress, _label, status) => {
            if (cancelled) return;
            setPercent(Math.round(progress));
            setPhase(status === 0 ? 'downloading' : status === 1 ? 'processing' : 'ready');
          },
        })
        .then(() => {
          if (cancelled || !viewer) return;
          const mesh = viewer.splatMesh;
          if (mesh && controls) frameScene(mesh, camera, controls);
          viewer.start();
          setPhase('ready');
          setPercent(100);
          onReadyRef.current?.();
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          const text = error instanceof Error ? error.message : String(error);
          fail(
            `Could not load the scene: ${text}. Check the URL, the file format (.ply, .splat, .ksplat, .spz) and that the host allows cross-origin requests.`,
          );
        });
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Could not start the scene load.');
    }

    return () => {
      cancelled = true;
      resetViewRef.current = null;
      flipUpRef.current = null;
      canvas.removeEventListener('webglcontextlost', onContextLost);
      resizeObserver?.disconnect();
      resizeObserver = null;
      const disposingViewer = viewer;
      const disposingRenderer = renderer;
      viewer = null;
      renderer = null;
      void Promise.resolve(disposingViewer?.dispose())
        .catch(() => undefined)
        .finally(() => {
          disposingRenderer?.dispose();
          canvas.remove();
        });
    };
  }, [src, upKey, reloadToken]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  const loading = phase === 'downloading' || phase === 'processing';

  return (
    <div className={`relative size-full overflow-hidden bg-black ${className ?? ''}`}>
      <div ref={containerRef} className="touch-canvas absolute inset-0" data-testid="splat-canvas" />

      {loading ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 p-4">
          <div className="mx-auto max-w-sm rounded-xl border border-line bg-sunken/90 p-3 backdrop-blur-sm">
            <div className="flex items-center justify-between text-xs text-muted">
              <span>{PHASE_LABEL[phase]}</span>
              <span className="tabular-nums">{percent}%</span>
            </div>
            <div
              className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-raised"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Splat scene loading progress"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-150"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        </div>
      ) : null}

      {phase === 'error' ? (
        <div className="absolute inset-0 grid place-items-center p-6">
          <div className="max-w-sm rounded-xl border border-line bg-surface p-5 text-center">
            <AlertIcon className="mx-auto size-7 text-muted" />
            <p className="mt-3 text-sm font-medium">Scene could not be displayed</p>
            <p className="mt-1.5 text-xs break-words text-muted">{message}</p>
            <button
              type="button"
              onClick={reload}
              className="mt-4 min-h-touch w-full rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent"
            >
              Try again
            </button>
          </div>
        </div>
      ) : null}

      {phase === 'ready' ? (
        <div className="absolute top-3 right-3 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => resetViewRef.current?.()}
            className="min-h-touch rounded-lg border border-line bg-sunken/85 px-3 text-xs font-medium backdrop-blur-sm"
          >
            Reset view
          </button>
          <button
            type="button"
            onClick={() => flipUpRef.current?.()}
            className="min-h-touch rounded-lg border border-line bg-sunken/85 px-3 text-xs font-medium backdrop-blur-sm"
            title="Flip the scene's up axis if it loads upside down"
          >
            Flip up
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default SplatViewer;
