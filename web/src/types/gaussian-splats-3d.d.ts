/**
 * Minimal ambient types for `@mkkellogg/gaussian-splats-3d` (MIT), which ships
 * JavaScript only. Only the surface SplatScene actually uses is declared —
 * extend as more of the API gets used.
 */
declare module '@mkkellogg/gaussian-splats-3d' {
  import type { Camera, Object3D, Vector3, WebGLRenderer, Scene } from 'three';

  export const SceneFormat: {
    readonly Splat: 0;
    readonly KSplat: 1;
    readonly Ply: 2;
    readonly Spz: 3;
  };
  export type SceneFormatValue = (typeof SceneFormat)[keyof typeof SceneFormat];

  export const SceneRevealMode: { readonly Default: 0; readonly Gradual: 1; readonly Instant: 2 };
  export const RenderMode: { readonly Always: 0; readonly OnChange: 1; readonly Never: 2 };
  export const LogLevel: {
    readonly None: 0;
    readonly Error: 1;
    readonly Warning: 2;
    readonly Info: 3;
    readonly Debug: 4;
  };
  export const WebXRMode: { readonly None: 0; readonly VR: 1; readonly AR: 2 };

  /** Loader phase reported to `onProgress`: 0 Downloading, 1 Processing, 2 Done. */
  export type LoaderStatusValue = 0 | 1 | 2;

  export interface AbortablePromise<T> extends Promise<T> {
    abort(reason?: unknown): void;
  }

  export interface ViewerOptions {
    rootElement?: HTMLElement;
    renderer?: WebGLRenderer;
    camera?: Camera;
    threeScene?: Scene;
    selfDrivenMode?: boolean;
    useBuiltInControls?: boolean;
    ignoreDevicePixelRatio?: boolean;
    halfPrecisionCovariancesOnGPU?: boolean;
    sharedMemoryForWorkers?: boolean;
    gpuAcceleratedSort?: boolean;
    integerBasedSort?: boolean;
    dynamicScene?: boolean;
    antialiased?: boolean;
    enableSIMDInSort?: boolean;
    enableOptionalEffects?: boolean;
    freeIntermediateSplatData?: boolean;
    sphericalHarmonicsDegree?: 0 | 1 | 2;
    plyInMemoryCompressionLevel?: number;
    splatSortDistanceMapPrecision?: number;
    maxScreenSpaceSplatSize?: number;
    focalAdjustment?: number;
    kernel2DSize?: number;
    sceneFadeInRateMultiplier?: number;
    renderMode?: number;
    sceneRevealMode?: number;
    logLevel?: number;
    webXRMode?: number;
    cameraUp?: [number, number, number];
    initialCameraPosition?: [number, number, number];
    initialCameraLookAt?: [number, number, number];
  }

  export interface AddSplatSceneOptions {
    format?: SceneFormatValue;
    splatAlphaRemovalThreshold?: number;
    showLoadingUI?: boolean;
    progressiveLoad?: boolean;
    position?: [number, number, number];
    rotation?: [number, number, number, number];
    scale?: [number, number, number];
    headers?: Record<string, string>;
    onProgress?: (
      percentComplete: number,
      percentCompleteLabel: string,
      loaderStatus: LoaderStatusValue,
    ) => void;
  }

  export interface SplatMesh extends Object3D {
    getSplatCount(includeSinceLastBuild?: boolean): number;
    getSplatCenter(globalSplatIndex: number, outCenter: Vector3, applySceneTransform?: boolean): void;
    setSplatScale(splatScale?: number): void;
    getSplatScale(): number;
  }

  /** Three.js OrbitControls fork bundled with the renderer. */
  export interface SplatOrbitControls {
    target: Vector3;
    enabled: boolean;
    enableDamping: boolean;
    dampingFactor: number;
    enableZoom: boolean;
    enablePan: boolean;
    enableRotate: boolean;
    rotateSpeed: number;
    zoomSpeed: number;
    panSpeed: number;
    minDistance: number;
    maxDistance: number;
    minPolarAngle: number;
    maxPolarAngle: number;
    screenSpacePanning: boolean;
    touches: { ONE: number; TWO: number };
    mouseButtons: { LEFT: number; MIDDLE: number; RIGHT: number };
    update(): boolean;
    dispose(): void;
  }

  export class Viewer {
    constructor(options?: ViewerOptions);
    readonly splatMesh: SplatMesh | null;
    readonly controls: SplatOrbitControls | null;
    camera: Camera | null;
    renderer: WebGLRenderer | null;
    threeScene: Scene | null;
    addSplatScene(path: string, options?: AddSplatSceneOptions): AbortablePromise<void>;
    removeSplatScene(index: number, showLoadingUI?: boolean): Promise<void>;
    getSceneCount(): number;
    start(): void;
    stop(): void;
    update(renderer?: WebGLRenderer, camera?: Camera): void;
    render(): void;
    forceRenderNextFrame(): void;
    isDisposingOrDisposed(): boolean;
    dispose(): Promise<void>;
  }

  export class DropInViewer extends Object3D {
    constructor(options?: ViewerOptions);
    addSplatScene(path: string, options?: AddSplatSceneOptions): AbortablePromise<void>;
    dispose(): Promise<void>;
  }
}
