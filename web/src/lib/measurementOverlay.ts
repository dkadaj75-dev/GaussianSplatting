/**
 * In-scene rendering of measurement markers, segments and labels (WP 3.1/3.2).
 *
 * Three details drive the design:
 *
 * 1. **Occlusion.** `@mkkellogg/gaussian-splats-3d` renders its `threeScene`
 *    *first* and the splat mesh *after*, with `autoClear` off. Anything we put
 *    in `threeScene` therefore writes depth before the splats draw, so splats
 *    in front of a marker correctly cover it. Objects that must stay visible
 *    through geometry can't live there — they need a pass after the splats,
 *    which is what `ghostScene` + {@link MeasurementOverlay.renderGhost} are.
 * 2. **Constant screen size.** A marker scaled in world units is a boulder up
 *    close and invisible across the room. Every frame each marker is rescaled
 *    by its distance to the camera.
 * 3. **Legible labels.** Canvas-texture sprites go blurry the moment the DPR
 *    or the zoom changes. The chips are real DOM, projected onto the canvas
 *    each frame — crisp at any scale, and they inherit the app's typography.
 */

import * as THREE from 'three';
import type { Point3 } from '../types';

export type OverlayTone = 'measure' | 'pending' | 'calibration';

export interface OverlayItem {
  id: string;
  tone: OverlayTone;
  a: Point3;
  /** Absent while the user has only placed the first point. */
  b?: Point3 | null;
  /** Chip text at the segment midpoint (or at `a` for a lone point). */
  label?: string | null;
}

const TONE_COLOR: Record<OverlayTone, number> = {
  // Mirrors --color-accent (oklch(0.73 0.14 230)); the eye reads them as one.
  measure: 0x4cb8f0,
  pending: 0xffffff,
  // Amber, deliberately unlike a measurement: this segment is an input, not a result.
  calibration: 0xfbbf24,
};

/** Marker core radius and dark-ring radius, in CSS pixels. */
const CORE_PX = 4.5;
const RING_PX = 8.5;

interface MarkerHandle {
  group: THREE.Group;
}

interface ItemHandle {
  markers: MarkerHandle[];
  chip: HTMLDivElement | null;
  /** Where the chip sits: segment midpoint, or the lone point. */
  anchor: THREE.Vector3;
}

export class MeasurementOverlay {
  /** Depth-tested content; add to `viewer.threeScene`. */
  readonly group = new THREE.Group();

  /** Always-on-top content; rendered by {@link renderGhost} after the splats. */
  readonly ghostScene = new THREE.Scene();

  private readonly labelHost: HTMLElement;
  private readonly sphere = new THREE.SphereGeometry(1, 14, 10);
  private readonly disposables: { dispose(): void }[] = [];
  private items: ItemHandle[] = [];
  private pixelScale = 0.002;

  constructor(labelHost: HTMLElement) {
    this.labelHost = labelHost;
    this.group.name = 'measurement-overlay';
    // Ghost lines carry no depth of their own; keep them off the sorted path.
    this.ghostScene.name = 'measurement-overlay-ghost';
  }

  /**
   * Replaces everything on screen.
   *
   * A rebuild rather than a diff: a scene holds a handful of measurements, and
   * a rebuild cannot drift out of sync with the React state that drives it.
   */
  setItems(items: readonly OverlayItem[]): void {
    this.clear();

    for (const item of items) {
      const color = TONE_COLOR[item.tone];
      const handle: ItemHandle = { markers: [], chip: null, anchor: new THREE.Vector3() };
      const a = new THREE.Vector3().fromArray(item.a);
      const b = item.b ? new THREE.Vector3().fromArray(item.b) : null;

      handle.markers.push(this.addMarker(a));
      if (b) handle.markers.push(this.addMarker(b));

      if (b) {
        this.addSegment(a, b, color);
        handle.anchor.addVectors(a, b).multiplyScalar(0.5);
      } else {
        handle.anchor.copy(a);
      }

      if (item.label) handle.chip = this.addChip(item.label, item.tone);
      this.items.push(handle);
    }
  }

  /**
   * Per-frame pass: rescale markers to a constant pixel size and move the
   * label chips to their projected positions.
   */
  update(camera: THREE.PerspectiveCamera, width: number, height: number): void {
    if (height <= 0 || width <= 0) return;

    // World units per CSS pixel, per unit of distance from the camera.
    this.pixelScale = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / height;

    const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
    for (const item of this.items) {
      for (const marker of item.markers) {
        const distance = marker.group.position.distanceTo(cameraPosition);
        marker.group.scale.setScalar(Math.max(distance * this.pixelScale, 1e-6));
      }
      if (item.chip) this.placeChip(item.chip, item.anchor, camera, width, height);
    }
  }

  /**
   * Draws the always-on-top pass. Called after the viewer has rendered the
   * splats, with `autoClear` disabled so the existing frame survives.
   */
  renderGhost(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    if (this.ghostScene.children.length === 0) return;
    const savedAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.ghostScene, camera);
    renderer.autoClear = savedAutoClear;
  }

  dispose(): void {
    this.clear();
    this.sphere.dispose();
    this.group.removeFromParent();
  }

  // --- internals -------------------------------------------------------------

  private clear(): void {
    for (const item of this.items) item.chip?.remove();
    this.items = [];
    this.group.clear();
    this.ghostScene.clear();
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
  }

  private track<T extends { dispose(): void }>(resource: T): T {
    this.disposables.push(resource);
    return resource;
  }

  /**
   * White core inside a dark disc — the only combination that stays visible on
   * both a whitewashed wall and a dark void.
   */
  private addMarker(position: THREE.Vector3): MarkerHandle {
    const group = new THREE.Group();
    group.position.copy(position);

    const ring = new THREE.Mesh(
      this.sphere,
      this.track(
        new THREE.MeshBasicMaterial({ color: 0x0b0b0b, depthWrite: false, toneMapped: false }),
      ),
    );
    ring.scale.setScalar(RING_PX);
    ring.renderOrder = 0;

    const core = new THREE.Mesh(
      this.sphere,
      this.track(new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })),
    );
    core.scale.setScalar(CORE_PX);
    core.renderOrder = 1;

    group.add(ring, core);
    this.group.add(group);
    return { group };
  }

  private addSegment(a: THREE.Vector3, b: THREE.Vector3, color: number): void {
    const geometry = this.track(new THREE.BufferGeometry().setFromPoints([a, b]));

    // Depth-tested: hidden where the scene is genuinely in front of it.
    const solid = new THREE.Line(
      geometry,
      this.track(new THREE.LineBasicMaterial({ color, toneMapped: false })),
    );
    solid.renderOrder = 2;
    this.group.add(solid);

    // …and a faint copy that ignores depth, so a segment threaded behind a
    // pillar still reads as one measurement instead of two stray dots.
    const ghost = new THREE.Line(
      geometry,
      this.track(
        new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity: 0.4,
          depthTest: false,
          depthWrite: false,
          toneMapped: false,
        }),
      ),
    );
    this.ghostScene.add(ghost);
  }

  private addChip(text: string, tone: OverlayTone): HTMLDivElement {
    const chip = document.createElement('div');
    chip.className =
      'pointer-events-none absolute top-0 left-0 z-10 rounded-md border px-1.5 py-0.5 text-[11px] leading-tight font-semibold whitespace-nowrap tabular-nums shadow-lg';
    chip.style.background = 'rgba(10,10,10,0.88)';
    chip.style.color = '#fff';
    chip.style.borderColor =
      tone === 'calibration' ? 'rgba(251,191,36,0.7)' : 'rgba(255,255,255,0.25)';
    chip.style.willChange = 'transform';
    chip.textContent = text;
    this.labelHost.appendChild(chip);
    return chip;
  }

  private placeChip(
    chip: HTMLDivElement,
    anchor: THREE.Vector3,
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
  ): void {
    const projected = anchor.clone().project(camera);
    // z > 1 means the point is behind the near plane; projecting it would put
    // the chip in a mirrored position on screen.
    if (projected.z > 1) {
      chip.style.visibility = 'hidden';
      return;
    }
    chip.style.visibility = 'visible';
    const x = (projected.x * 0.5 + 0.5) * width;
    const y = (-projected.y * 0.5 + 0.5) * height;
    chip.style.transform = `translate(-50%,-140%) translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
  }
}
