/**
 * SplatScene offline demo.
 *
 * A published Artifact is a static page with no backend and no outbound
 * network, so this build drops the project/capture/job half of the app and
 * keeps the part that has to be felt on a real device: navigating a Gaussian
 * splat scene with a thumb, and measuring inside it.
 *
 * Everything below the UI is the same code the app ships — `pickNearestSplat`,
 * the measurement formatting and the calibration arithmetic are imported from
 * `web/src/lib`, not reimplemented — over scenes synthesised in the worker's
 * own `.splat` record layout.
 */

import * as THREE from 'three';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';

import {
  angularRadiusForScreenRadius,
  centersFromSplatMesh,
  pickNearestSplat,
  type Point3,
} from '../web/src/lib/picking';
import { DEMO_SCENES, type DemoScene } from './splatgen';

const TAP_SLOP_PX = 8;
const PICK_RADIUS_PX = 22;

type Phase = 'idle' | 'building' | 'loading' | 'ready' | 'error';

interface Measurement {
  id: number;
  a: Point3;
  b: Point3;
  sceneValue: number;
  label: string;
}

/* ---------------------------------------------------------------- formatting */

function formatMetres(metres: number): string {
  const abs = Math.abs(metres);
  if (abs < 0.01) return `${(metres * 1000).toPrecision(3)} mm`;
  if (abs < 1) return `${(metres * 100).toPrecision(3)} cm`;
  return `${metres.toPrecision(3)} m`;
}

function formatSceneUnits(value: number): string {
  return `${value.toPrecision(3)} su`;
}

function distance3(a: Point3, b: Point3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/* --------------------------------------------------------------- app state */

const state = {
  scene: DEMO_SCENES[0] as DemoScene,
  phase: 'idle' as Phase,
  measuring: false,
  calibrating: false,
  /** Metres per scene unit, or null while the scene is uncalibrated. */
  scale: null as number | null,
  pending: null as Point3 | null,
  measurements: [] as Measurement[],
  nextId: 1,
  sceneRadius: 1,
};

/* ------------------------------------------------------------------ helpers */

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clampedPixelRatio(): number {
  return Math.min(window.devicePixelRatio || 1, 2);
}

/* --------------------------------------------------------------------- DOM */

const root = document.getElementById('app') as HTMLDivElement;

const stage = element('div', 'stage');
const canvasHost = element('div', 'canvas-host');
const overlayLayer = element('div', 'overlay-layer');
const crosshair = element('div', 'crosshair');
const statusCard = element('div', 'status-card');
stage.append(canvasHost, overlayLayer, crosshair, statusCard);

const badge = element('button', 'badge');
badge.type = 'button';

const sceneBar = element('div', 'scene-bar');
const sceneButtons = DEMO_SCENES.map((scene) => {
  const button = element('button', 'chip', scene.name);
  button.type = 'button';
  button.addEventListener('click', () => {
    if (state.scene.id === scene.id) return;
    void loadScene(scene);
  });
  return button;
});
sceneBar.append(...sceneButtons, badge);

const hint = element('p', 'hint');

const toolbar = element('div', 'toolbar');
const measureButton = element('button', 'tool primary', 'Measure');
measureButton.type = 'button';
const calibrateButton = element('button', 'tool', 'Calibrate');
calibrateButton.type = 'button';
const clearButton = element('button', 'tool', 'Clear');
clearButton.type = 'button';
const resetButton = element('button', 'tool', 'Reset');
resetButton.type = 'button';
toolbar.append(measureButton, calibrateButton, clearButton, resetButton);

const list = element('div', 'list');

const sheet = element('div', 'sheet');
const sheetTitle = element('h2', undefined, 'Known distance');
const sheetBody = element('p', 'sheet-body');
const sheetInput = element('input', 'sheet-input');
sheetInput.type = 'number';
sheetInput.inputMode = 'decimal';
sheetInput.step = 'any';
sheetInput.min = '0';
sheetInput.placeholder = '150';
const unitSelect = element('select', 'sheet-unit');
for (const unit of ['mm', 'cm', 'm']) {
  const option = element('option', undefined, unit);
  option.value = unit;
  unitSelect.append(option);
}
unitSelect.value = 'mm';
const sheetError = element('p', 'sheet-error');
const sheetActions = element('div', 'sheet-actions');
const sheetCancel = element('button', 'tool', 'Cancel');
sheetCancel.type = 'button';
const sheetSave = element('button', 'tool primary', 'Set scale');
sheetSave.type = 'button';
sheetActions.append(sheetCancel, sheetSave);
const sheetRow = element('div', 'sheet-row');
sheetRow.append(sheetInput, unitSelect);
sheet.append(sheetTitle, sheetBody, sheetRow, sheetError, sheetActions);

const panel = element('div', 'panel');
panel.append(sceneBar, hint, toolbar, list);
root.append(stage, panel, sheet);

/* ------------------------------------------------------------ three.js side */

let renderer: THREE.WebGLRenderer | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let viewer: GaussianSplats3D.Viewer | null = null;
let overlayScene: THREE.Scene | null = null;
let objectUrl: string | null = null;
let frameHandle = 0;

const markerGroup = new THREE.Group();
const labelNodes = new Map<string, HTMLDivElement>();

function setStatus(text: string | null, tone: 'info' | 'error' = 'info'): void {
  statusCard.textContent = text ?? '';
  statusCard.classList.toggle('visible', Boolean(text));
  statusCard.classList.toggle('error', tone === 'error');
}

function disposeViewer(): void {
  if (frameHandle) cancelAnimationFrame(frameHandle);
  frameHandle = 0;
  labelNodes.forEach((node) => node.remove());
  labelNodes.clear();
  markerGroup.clear();
  if (viewer) {
    try {
      viewer.stop();
      void viewer.dispose();
    } catch {
      /* the viewer is being torn down; nothing useful to do here */
    }
    viewer = null;
  }
  if (renderer) {
    renderer.dispose();
    renderer.domElement.remove();
    renderer = null;
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  overlayScene = null;
  camera = null;
}

function frameScene(): void {
  const mesh = viewer?.splatMesh;
  if (!mesh || !camera) return;
  const count = mesh.getSplatCount();
  if (!count) return;

  const scratch = new THREE.Vector3();
  const centre = new THREE.Vector3();
  const stride = Math.max(1, Math.floor(count / 4096));
  const radii: number[] = [];
  let sampled = 0;
  for (let index = 0; index < count; index += stride) {
    mesh.getSplatCenter(index, scratch, true);
    centre.add(scratch);
    sampled += 1;
  }
  if (!sampled) return;
  centre.divideScalar(sampled);
  for (let index = 0; index < count; index += stride) {
    mesh.getSplatCenter(index, scratch, true);
    radii.push(scratch.distanceTo(centre));
  }
  radii.sort((a, b) => a - b);
  // A 90th percentile radius ignores the stray splats every reconstruction
  // scatters far behind the subject, which would otherwise frame it tiny.
  const radius = radii[Math.floor(radii.length * 0.9)] || 1;
  state.sceneRadius = radius;

  const distance = radius * 2.7;
  camera.position.set(centre.x + distance * 0.55, centre.y + distance * 0.42, centre.z + distance);
  camera.lookAt(centre);
  const controls = viewer?.controls;
  if (controls) {
    controls.target.copy(centre);
    controls.minDistance = distance / 60;
    controls.maxDistance = distance * 8;
    controls.update();
  }
}

/* --------------------------------------------------------------- overlay 3D */

function markerMesh(colour: number, radius: number): THREE.Group {
  const group = new THREE.Group();
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.9, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0x0b0f14, depthWrite: false, transparent: true, opacity: 0.75 }),
  );
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 12, 12),
    new THREE.MeshBasicMaterial({ color: colour }),
  );
  group.add(halo, core);
  return group;
}

function rebuildOverlay(): void {
  markerGroup.clear();
  labelNodes.forEach((node) => node.remove());
  labelNodes.clear();

  const radius = state.sceneRadius * 0.012;
  const draw = (a: Point3, b: Point3 | null, colour: number, key: string, text: string | null) => {
    const first = markerMesh(colour, radius);
    first.position.set(...a);
    markerGroup.add(first);
    if (!b) return;
    const second = markerMesh(colour, radius);
    second.position.set(...b);
    markerGroup.add(second);

    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(...a),
      new THREE.Vector3(...b),
    ]);
    markerGroup.add(
      new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: colour, linewidth: 2 })),
    );
    // A second, always-visible pass so the line still reads when the subject
    // occludes part of it — otherwise a measurement across a corner vanishes.
    markerGroup.add(
      new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({
          color: colour,
          transparent: true,
          opacity: 0.35,
          depthTest: false,
        }),
      ),
    );

    if (text) {
      const node = element('div', 'label', text);
      overlayLayer.append(node);
      labelNodes.set(key, node);
    }
  };

  for (const measurement of state.measurements) {
    draw(
      measurement.a,
      measurement.b,
      0x4ade80,
      `m${measurement.id}`,
      `${measurement.label} · ${describe(measurement.sceneValue)}`,
    );
  }
  if (state.pending) {
    draw(state.pending, null, state.calibrating ? 0xfbbf24 : 0x60a5fa, 'pending', null);
  }
}

function describe(sceneValue: number): string {
  return state.scale === null
    ? formatSceneUnits(sceneValue)
    : formatMetres(sceneValue * state.scale);
}

function projectLabels(): void {
  if (!camera || !renderer) return;
  const size = renderer.getSize(new THREE.Vector2());
  const vector = new THREE.Vector3();

  const place = (key: string, a: Point3, b: Point3) => {
    const node = labelNodes.get(key);
    if (!node) return;
    vector.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2).project(camera!);
    const behind = vector.z > 1;
    node.style.opacity = behind ? '0' : '1';
    node.style.transform = `translate(-50%, -50%) translate(${((vector.x + 1) / 2) * size.x}px, ${((1 - vector.y) / 2) * size.y}px)`;
  };

  for (const measurement of state.measurements) {
    place(`m${measurement.id}`, measurement.a, measurement.b);
  }
}

function scaleMarkers(): void {
  if (!camera) return;
  const cameraPosition = camera.position;
  for (const child of markerGroup.children) {
    if (!(child instanceof THREE.Group)) continue;
    const distance = cameraPosition.distanceTo(child.position);
    // Constant apparent size: a marker 10 m away must not become a dot.
    child.scale.setScalar(Math.max(0.35, distance / (state.sceneRadius * 3.2)));
  }
}

/* ----------------------------------------------------------------- picking */

function pickAt(clientX: number, clientY: number): Point3 | null {
  const mesh = viewer?.splatMesh;
  if (!mesh || !camera || !renderer) return null;

  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera);

  const scratch = new THREE.Vector3();
  const centers = centersFromSplatMesh(mesh, scratch);
  // fov in degrees — the helper converts; handing it radians silently yields a
  // catch radius ~60x too small and every tap misses.
  const angularRadius = angularRadiusForScreenRadius(PICK_RADIUS_PX, camera.fov, rect.height);

  const pick = pickNearestSplat(raycaster.ray.origin, raycaster.ray.direction, centers, {
    angularRadius,
    minRadius: state.sceneRadius * 0.004,
    maxRadius: state.sceneRadius * 0.25,
    farDistance: state.sceneRadius * 60,
    maxSamples: 220_000,
  });
  return pick ? pick.point : null;
}

function handlePick(point: Point3): void {
  if (!state.pending) {
    state.pending = point;
    render();
    return;
  }

  const a = state.pending;
  const sceneValue = distance3(a, point);
  state.pending = null;

  if (state.calibrating) {
    if (sceneValue <= 1e-9) {
      setStatus('Those two points are the same — pick two ends of the reference.', 'error');
      state.calibrating = false;
      render();
      return;
    }
    pendingCalibration = { sceneValue };
    openSheet();
    render();
    return;
  }

  state.measurements.push({
    id: state.nextId,
    a,
    b: point,
    sceneValue,
    label: `M${state.nextId}`,
  });
  state.nextId += 1;
  render();
}

/* ------------------------------------------------------------- calibration */

let pendingCalibration: { sceneValue: number } | null = null;

function openSheet(): void {
  sheetError.textContent = '';
  sheetInput.value = '';
  sheetBody.textContent =
    'How long is the distance you just picked, in the real world? Everything in the scene is then labelled in real units.';
  sheet.classList.add('open');
  sheetInput.focus();
}

function closeSheet(): void {
  sheet.classList.remove('open');
  pendingCalibration = null;
  state.calibrating = false;
  render();
}

sheetCancel.addEventListener('click', closeSheet);
sheetSave.addEventListener('click', () => {
  if (!pendingCalibration) return closeSheet();
  const typed = Number.parseFloat(sheetInput.value);
  if (!Number.isFinite(typed) || typed <= 0) {
    sheetError.textContent = 'Enter a distance greater than zero.';
    return;
  }
  const factor = unitSelect.value === 'mm' ? 0.001 : unitSelect.value === 'cm' ? 0.01 : 1;
  state.scale = (typed * factor) / pendingCalibration.sceneValue;
  closeSheet();
  setStatus(`Calibrated — 1 scene unit is ${formatMetres(state.scale)}.`);
  window.setTimeout(() => setStatus(null), 3200);
});

badge.addEventListener('click', () => {
  if (state.scale === null) {
    startCalibration();
    return;
  }
  state.scale = null;
  render();
  setStatus('Calibration removed — measurements are relative again.');
  window.setTimeout(() => setStatus(null), 2600);
});

function startCalibration(): void {
  if (state.phase !== 'ready') return;
  state.calibrating = true;
  state.measuring = true;
  state.pending = null;
  render();
}

/* ------------------------------------------------------------------ toolbar */

measureButton.addEventListener('click', () => {
  state.measuring = !state.measuring;
  state.calibrating = false;
  state.pending = null;
  render();
});

calibrateButton.addEventListener('click', startCalibration);

let clearArmed = 0;
clearButton.addEventListener('click', () => {
  const now = Date.now();
  if (now - clearArmed > 4000) {
    clearArmed = now;
    clearButton.textContent = 'Clear all?';
    window.setTimeout(() => {
      if (Date.now() - clearArmed >= 4000) clearButton.textContent = 'Clear';
    }, 4100);
    return;
  }
  clearArmed = 0;
  clearButton.textContent = 'Clear';
  state.measurements = [];
  state.pending = null;
  state.nextId = 1;
  render();
});

resetButton.addEventListener('click', () => {
  frameScene();
  viewer?.forceRenderNextFrame();
});

/* -------------------------------------------------------------- tap vs drag */

let candidate: { x: number; y: number; id: number } | null = null;

stage.addEventListener(
  'pointerdown',
  (event) => {
    if (!state.measuring || state.phase !== 'ready') return;
    if (candidate) {
      // A second finger means this is a pinch, not a tap.
      candidate = null;
      return;
    }
    candidate = { x: event.clientX, y: event.clientY, id: event.pointerId };
    crosshair.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`;
  },
  { passive: true },
);

stage.addEventListener(
  'pointermove',
  (event) => {
    if (!state.measuring) return;
    crosshair.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`;
    if (!candidate || event.pointerId !== candidate.id) return;
    if (Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) > TAP_SLOP_PX) {
      candidate = null;
    }
  },
  { passive: true },
);

const endTap = (event: PointerEvent) => {
  if (!candidate || event.pointerId !== candidate.id) {
    candidate = null;
    return;
  }
  const { x, y } = candidate;
  candidate = null;
  if (Math.hypot(event.clientX - x, event.clientY - y) > TAP_SLOP_PX) return;

  const point = pickAt(event.clientX, event.clientY);
  if (!point) {
    setStatus('Nothing there — aim at the surface.', 'error');
    window.setTimeout(() => setStatus(null), 1800);
    return;
  }
  handlePick(point);
};

stage.addEventListener('pointerup', endTap, { passive: true });
stage.addEventListener('pointercancel', () => {
  candidate = null;
});

/* -------------------------------------------------------------- render loop */

function render(): void {
  const ready = state.phase === 'ready';
  measureButton.classList.toggle('active', state.measuring);
  measureButton.textContent = state.measuring ? 'Measuring' : 'Measure';
  calibrateButton.classList.toggle('active', state.calibrating);
  stage.classList.toggle('measuring', state.measuring && ready);
  crosshair.classList.toggle('visible', state.measuring && ready);

  for (const [index, button] of sceneButtons.entries()) {
    button.classList.toggle('active', DEMO_SCENES[index].id === state.scene.id);
  }

  badge.textContent =
    state.scale === null ? 'Uncalibrated — relative units' : 'Calibrated — tap to clear';
  badge.className = `badge ${state.scale === null ? 'warn' : 'ok'}`;

  hint.textContent = state.calibrating
    ? state.pending
      ? 'Now tap the other end of the known distance.'
      : 'Tap one end of a distance you know in the real world.'
    : state.measuring
      ? state.pending
        ? 'Tap the second point.'
        : 'Tap a point on the surface to start measuring.'
      : state.scene.hint;

  list.replaceChildren();
  if (state.measurements.length) {
    for (const measurement of state.measurements) {
      const row = element('div', 'row');
      row.append(
        element('span', 'row-label', measurement.label),
        element('span', 'row-value', describe(measurement.sceneValue)),
      );
      const remove = element('button', 'row-remove', 'Remove');
      remove.type = 'button';
      remove.addEventListener('click', () => {
        state.measurements = state.measurements.filter((item) => item.id !== measurement.id);
        render();
      });
      row.append(remove);
      list.append(row);
    }
  }

  rebuildOverlay();
  viewer?.forceRenderNextFrame();
}

/* --------------------------------------------------------------- scene load */

async function loadScene(scene: DemoScene): Promise<void> {
  disposeViewer();
  state.scene = scene;
  state.phase = 'building';
  state.measurements = [];
  state.pending = null;
  state.nextId = 1;
  state.scale = null;
  state.measuring = false;
  state.calibrating = false;
  render();
  setStatus(`Building ${scene.name.toLowerCase()}…`);

  // Yield once so the status paints before the generator blocks the thread.
  await new Promise((resolve) => window.setTimeout(resolve, 16));

  let bytes: Uint8Array;
  try {
    bytes = scene.build();
  } catch (error) {
    state.phase = 'error';
    setStatus(error instanceof Error ? error.message : 'Could not build the scene.', 'error');
    return;
  }

  objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));

  try {
    renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  } catch {
    state.phase = 'error';
    setStatus('WebGL could not start on this device or browser.', 'error');
    return;
  }

  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.touchAction = 'none';
  const width = Math.max(canvasHost.clientWidth, 1);
  const height = Math.max(canvasHost.clientHeight, 1);
  renderer.setPixelRatio(clampedPixelRatio());
  renderer.setSize(width, height, false);
  renderer.setClearColor(0x070a0f, 1);
  canvasHost.append(canvas);

  camera = new THREE.PerspectiveCamera(52, width / height, 0.01, 500);
  camera.up.set(0, 1, 0);
  camera.position.set(0, 0, 3);

  canvas.addEventListener(
    'webglcontextlost',
    (event) => {
      event.preventDefault();
      state.phase = 'error';
      setStatus('The graphics context was lost. Reload the page to try again.', 'error');
    },
    false,
  );

  try {
    viewer = new GaussianSplats3D.Viewer({
      renderer,
      camera,
      rootElement: canvasHost,
      useBuiltInControls: true,
      // Avoids requiring cross-origin isolation (COOP/COEP) headers, which a
      // published artifact cannot set.
      sharedMemoryForWorkers: false,
      dynamicScene: false,
      antialiased: false,
      sphericalHarmonicsDegree: 0,
      logLevel: GaussianSplats3D.LogLevel.None,
      cameraUp: [0, 1, 0],
      initialCameraPosition: [0, 0, 3],
      initialCameraLookAt: [0, 0, 0],
    });
  } catch (error) {
    state.phase = 'error';
    setStatus(error instanceof Error ? error.message : 'Could not create the viewer.', 'error');
    return;
  }

  const controls = viewer.controls;
  if (controls) {
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.6;
    controls.screenSpacePanning = true;
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = Math.PI;
  }

  overlayScene = new THREE.Scene();
  overlayScene.add(markerGroup);

  state.phase = 'loading';
  setStatus('Loading scene…');

  // The library's AbortablePromise ignores the rejection handler passed to
  // `then`, so the failure path must be an explicit `.catch`, never `await`.
  viewer
    .addSplatScene(objectUrl, { format: GaussianSplats3D.SceneFormat.Splat, showLoadingUI: false })
    .then(() => {
      state.phase = 'ready';
      frameScene();
      setStatus(null);
      render();

      const loop = () => {
        frameHandle = requestAnimationFrame(loop);
        viewer?.controls?.update();
        viewer?.update();
        viewer?.render();
        if (renderer && camera && overlayScene) {
          scaleMarkers();
          // Drawn after the splats with the depth buffer intact, so markers
          // sit inside the scene rather than floating over it.
          renderer.autoClear = false;
          renderer.render(overlayScene, camera);
          renderer.autoClear = true;
        }
        projectLabels();
      };
      loop();
    })
    .catch((error: unknown) => {
      state.phase = 'error';
      setStatus(error instanceof Error ? error.message : 'The scene failed to load.', 'error');
    });
}

const applySize = () => {
  if (!renderer || !camera) return;
  const width = Math.max(canvasHost.clientWidth, 1);
  const height = Math.max(canvasHost.clientHeight, 1);
  renderer.setPixelRatio(clampedPixelRatio());
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  viewer?.forceRenderNextFrame();
};
new ResizeObserver(applySize).observe(canvasHost);
window.addEventListener('orientationchange', () => window.setTimeout(applySize, 120));

render();
void loadScene(DEMO_SCENES[0]);
