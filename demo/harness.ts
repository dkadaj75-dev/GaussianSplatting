/**
 * Offscreen render harness: load a `.splat` and photograph it from any angle.
 *
 * Used to turn a reconstruction into a set of review images without a browser
 * in front of a human — the same job the app's viewer does interactively, so
 * what you see here is what the app would show.
 *
 * Query params: `src` (url), `bg` (hex, default dark).
 * Drive it from an automation script via `window.__view(azimuthDeg,
 * elevationDeg, distanceMultiplier)`; `window.__ready` flips true once loaded.
 */

import * as THREE from 'three';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';

declare global {
  interface Window {
    __ready?: boolean;
    __error?: string;
    __splatCount?: number;
    __view?: (azimuthDeg: number, elevationDeg: number, distance?: number) => void;
  }
}

const params = new URLSearchParams(location.search);
const src = params.get('src') ?? '';
const background = Number.parseInt(params.get('bg') ?? '0b0f14', 16);

const host = document.getElementById('app') as HTMLDivElement;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(background, 1);
host.append(renderer.domElement);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 500);
camera.up.set(0, 1, 0);

const viewer = new GaussianSplats3D.Viewer({
  renderer,
  camera,
  rootElement: host,
  useBuiltInControls: false,
  sharedMemoryForWorkers: false,
  dynamicScene: false,
  antialiased: true,
  sphericalHarmonicsDegree: 0,
  logLevel: GaussianSplats3D.LogLevel.None,
  cameraUp: [0, 1, 0],
  initialCameraPosition: [0, 0, 3],
  initialCameraLookAt: [0, 0, 0],
});

const centre = new THREE.Vector3();
let radius = 1;

function measureScene(): void {
  const mesh = viewer.splatMesh;
  if (!mesh) return;
  const count = mesh.getSplatCount();
  window.__splatCount = count;
  if (!count) return;

  const scratch = new THREE.Vector3();
  const stride = Math.max(1, Math.floor(count / 8192));
  let sampled = 0;
  for (let index = 0; index < count; index += stride) {
    mesh.getSplatCenter(index, scratch, true);
    centre.add(scratch);
    sampled += 1;
  }
  centre.divideScalar(Math.max(1, sampled));

  const radii: number[] = [];
  for (let index = 0; index < count; index += stride) {
    mesh.getSplatCenter(index, scratch, true);
    radii.push(scratch.distanceTo(centre));
  }
  radii.sort((a, b) => a - b);
  radius = radii[Math.floor(radii.length * 0.92)] || 1;
}

window.__view = (azimuthDeg, elevationDeg, distance = 2.6) => {
  const azimuth = (azimuthDeg * Math.PI) / 180;
  const elevation = (elevationDeg * Math.PI) / 180;
  const r = radius * distance;
  camera.position.set(
    centre.x + r * Math.cos(elevation) * Math.cos(azimuth),
    centre.y + r * Math.sin(elevation),
    centre.z + r * Math.cos(elevation) * Math.sin(azimuth),
  );
  camera.lookAt(centre);
  camera.updateMatrixWorld();
  viewer.forceRenderNextFrame();
};

viewer
  .addSplatScene(src, { format: GaussianSplats3D.SceneFormat.Splat, showLoadingUI: false })
  .then(() => {
    measureScene();
    window.__view?.(35, 20);
    const loop = () => {
      requestAnimationFrame(loop);
      viewer.update();
      viewer.render();
    };
    loop();
    window.__ready = true;
  })
  .catch((error: unknown) => {
    window.__error = error instanceof Error ? error.message : String(error);
  });
