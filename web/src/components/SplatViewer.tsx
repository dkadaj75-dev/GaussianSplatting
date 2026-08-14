import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import * as THREE from 'three';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';
import { AlertIcon } from './icons';
import { MeasurementOverlay } from '../lib/measurementOverlay';
import type { OverlayItem } from '../lib/measurementOverlay';
import {
  angularRadiusForScreenRadius,
  centersFromSplatMesh,
  pickNearestSplat,
} from '../lib/picking';
import type { Point3 } from '../types';

/** Mobile GPUs choke above 2x; PLAN.md §3 mandates the clamp. */
const MAX_DEVICE_PIXEL_RATIO = 2;

/**
 * How far a pointer may travel and still count as a tap rather than an orbit.
 * 8 px is below the noise floor of a deliberate drag but above the wobble of a
 * thumb pressing a phone screen.
 */
const TAP_SLOP_PX = 8;

/** Catch radius for a pick, in CSS pixels — roughly a fingertip. */
const TAP_RADIUS_PX = 22;

/** Splat centres examined per pick; larger clouds are strided (WP 3.1). */
const MAX_PICK_SAMPLES = 200_000;

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

  /**
   * Routes taps to {@link onPick} and shows the crosshair hint. Orbiting keeps
   * working — only a tap that did not drag is treated as a pick.
   */
  pickEnabled?: boolean;
  /** A tap resolved to this scene-space point, or `null` when it hit nothing. */
  onPick?: (point: Point3 | null) => void;
  /** Markers, segments and labels to draw in the scene. */
  overlayItems?: readonly OverlayItem[];
  /** Overlay UI (toolbar, panels, sheets) stacked above the canvas. */
  children?: ReactNode;
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
 *
 * Returns the radius it settled on: SfM scenes have no canonical scale, so
 * picking thresholds and marker sizes are expressed relative to it.
 */
function frameScene(
  mesh: GaussianSplats3D.SplatMesh,
  camera: THREE.PerspectiveCamera,
  controls: GaussianSplats3D.SplatOrbitControls,
): number | null {
  const splatCount = mesh.getSplatCount();
  if (splatCount === 0) return null;

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
  if (samples.length === 0) return null;
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
  return radius;
}

/**
 * Renders a Gaussian splat scene from `src`.
 *
 * Owns its own `WebGLRenderer` and camera (rather than letting the library
 * create them) so it can clamp the device pixel ratio, resize with the
 * container instead of the window, and recover from WebGL context loss.
 */
export function SplatViewer({
  src,
  className,
  cameraUp,
  onReady,
  onError,
  pickEnabled = false,
  onPick,
  overlayItems,
  children,
}: SplatViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const labelHostRef = useRef<HTMLDivElement>(null);
  const crosshairRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [percent, setPercent] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  /** Bumped when a fresh overlay exists, so the sync effect re-applies items. */
  const [overlayEpoch, setOverlayEpoch] = useState(0);

  const resetViewRef = useRef<(() => void) | null>(null);
  const flipUpRef = useRef<(() => void) | null>(null);
  const overlayRef = useRef<MeasurementOverlay | null>(null);

  // Keep the callbacks out of the effect's dependency list; they change identity
  // freely and re-creating the whole WebGL context for that would be absurd.
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  const onPickRef = useRef(onPick);
  const pickEnabledRef = useRef(pickEnabled);
  useEffect(() => {
    onReadyRef.current = onReady;
    onErrorRef.current = onError;
    onPickRef.current = onPick;
    pickEnabledRef.current = pickEnabled;
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

    // Scene scale, learnt from the framing pass. Picking thresholds and marker
    // sizes are relative to it because SfM output has no canonical unit.
    let sceneRadius = 1;
    const applyFraming = () => {
      const mesh = viewer?.splatMesh;
      if (!mesh || !controls) return;
      sceneRadius = frameScene(mesh, camera, controls) ?? sceneRadius;
    };

    resetViewRef.current = () => {
      applyFraming();
      viewer?.forceRenderNextFrame();
    };
    flipUpRef.current = () => {
      camera.up.negate();
      controls?.update();
      applyFraming();
      viewer?.forceRenderNextFrame();
    };

    // --- Measurement overlay (WP 3.1/3.2) ------------------------------------

    const overlay = labelHostRef.current ? new MeasurementOverlay(labelHostRef.current) : null;
    if (overlay && viewer?.threeScene) {
      viewer.threeScene.add(overlay.group);
      overlayRef.current = overlay;
      setOverlayEpoch((epoch) => epoch + 1);

      // The library renders `threeScene` and then the splats. Chaining the
      // always-on-top pass onto `render` is the only seam that lands *after*
      // the splats without forking the renderer's own loop.
      const baseRender = viewer.render.bind(viewer);
      viewer.render = () => {
        baseRender();
        if (renderer) overlay.renderGhost(renderer, camera);
      };
    }

    // Markers must hold a constant pixel size and the label chips must track
    // their anchors, both of which change every time the camera moves.
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      overlay?.update(camera, container.clientWidth, container.clientHeight);
    };
    frame = requestAnimationFrame(tick);

    // --- Picking (WP 3.1) ----------------------------------------------------

    const rayOrigin = new THREE.Vector3();
    const rayDirection = new THREE.Vector3();
    const pickScratch = new THREE.Vector3();

    const pickAt = (clientX: number, clientY: number): Point3 | null => {
      const mesh = viewer?.splatMesh;
      if (!mesh) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;

      const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);
      camera.updateMatrixWorld();
      rayOrigin.setFromMatrixPosition(camera.matrixWorld);
      rayDirection.set(ndcX, ndcY, 0.5).unproject(camera).sub(rayOrigin).normalize();

      const hit = pickNearestSplat(
        rayOrigin,
        rayDirection,
        centersFromSplatMesh(mesh, pickScratch),
        {
          angularRadius: angularRadiusForScreenRadius(TAP_RADIUS_PX, camera.fov, rect.height),
          // A floor keeps a tap landing right in front of the lens pickable;
          // a ceiling stops a distant tap swallowing a quarter of the scene.
          minRadius: sceneRadius * 0.002,
          maxRadius: sceneRadius * 0.25,
          nearDistance: camera.near,
          farDistance: camera.far,
          maxSamples: MAX_PICK_SAMPLES,
        },
      );
      return hit?.point ?? null;
    };

    const moveCrosshair = (clientX: number, clientY: number) => {
      const crosshair = crosshairRef.current;
      if (!crosshair) return;
      const rect = container.getBoundingClientRect();
      crosshair.style.opacity = '1';
      crosshair.style.transform = `translate(-50%,-50%) translate(${clientX - rect.left}px,${clientY - rect.top}px)`;
    };

    const hideCrosshair = () => {
      if (crosshairRef.current) crosshairRef.current.style.opacity = '0';
    };

    // A tap is a pointer that went down and came up in the same place, alone.
    // Anything else is an orbit, a pinch or a pan and must not place a point.
    const activePointers = new Set<number>();
    let candidate: { id: number; x: number; y: number } | null = null;

    const onPointerDown = (event: PointerEvent) => {
      activePointers.add(event.pointerId);
      // A second finger means a pinch or a two-finger pan; the gesture that was
      // shaping up as a tap is retroactively cancelled.
      candidate =
        activePointers.size === 1
          ? { id: event.pointerId, x: event.clientX, y: event.clientY }
          : null;
      if (pickEnabledRef.current) moveCrosshair(event.clientX, event.clientY);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (pickEnabledRef.current) moveCrosshair(event.clientX, event.clientY);
      if (!candidate || candidate.id !== event.pointerId) return;
      if (Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) > TAP_SLOP_PX) {
        candidate = null;
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      const tapped = candidate?.id === event.pointerId && activePointers.size === 1;
      activePointers.delete(event.pointerId);
      candidate = null;
      // A finger leaves no cursor behind, so the hint has to go with it.
      if (event.pointerType !== 'mouse') hideCrosshair();
      if (!tapped || !pickEnabledRef.current) return;
      onPickRef.current?.(pickAt(event.clientX, event.clientY));
    };

    const onPointerCancel = (event: PointerEvent) => {
      activePointers.delete(event.pointerId);
      candidate = null;
      hideCrosshair();
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('pointerleave', hideCrosshair);

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
          applyFraming();
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
      cancelAnimationFrame(frame);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('pointerleave', hideCrosshair);
      if (overlayRef.current === overlay) overlayRef.current = null;
      overlay?.dispose();
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

  // `overlayEpoch` re-runs this once the WebGL effect has built the overlay,
  // so items handed down before the scene existed still land.
  useEffect(() => {
    overlayRef.current?.setItems(overlayItems ?? []);
  }, [overlayItems, overlayEpoch]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  const loading = phase === 'downloading' || phase === 'processing';

  return (
    <div className={`relative size-full overflow-hidden bg-black ${className ?? ''}`}>
      <div
        ref={containerRef}
        className={`touch-canvas absolute inset-0 ${pickEnabled ? 'cursor-crosshair' : ''}`}
        data-testid="splat-canvas"
      />

      {/* Label chips live outside the canvas so they stay real, crisp text. */}
      <div
        ref={labelHostRef}
        className="pointer-events-none absolute inset-0 overflow-hidden"
        data-testid="measurement-labels"
      />

      {/* Follows the pointer in measure mode: shows *where* a tap would land. */}
      <div
        ref={crosshairRef}
        aria-hidden="true"
        className={`pointer-events-none absolute top-0 left-0 opacity-0 transition-opacity duration-150 ${
          pickEnabled ? '' : 'hidden'
        }`}
      >
        <svg width="34" height="34" viewBox="0 0 34 34" fill="none" aria-hidden="true">
          <circle cx="17" cy="17" r="10.5" stroke="rgba(0,0,0,0.55)" strokeWidth="3" />
          <circle cx="17" cy="17" r="10.5" stroke="rgba(255,255,255,0.85)" strokeWidth="1.25" />
          <path
            d="M17 3v7M17 24v7M3 17h7M24 17h7"
            stroke="rgba(0,0,0,0.55)"
            strokeWidth="3"
            strokeLinecap="round"
          />
          <path
            d="M17 3v7M17 24v7M3 17h7M24 17h7"
            stroke="rgba(255,255,255,0.85)"
            strokeWidth="1.25"
            strokeLinecap="round"
          />
        </svg>
      </div>

      {/* Tools only make sense over a scene that is actually on screen. */}
      {phase === 'ready' ? children : null}

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
