# Gaussian Splatting Web App — Project Plan

**Working name:** SplatScene
**Goal:** A responsive web application (desktop + smartphone) where a user uploads a series of photos of a subject or place (a fish, a construction detail, a room corner…), the system reconstructs the scene in 3D using Gaussian Splatting, and the user can then navigate the scene interactively and take measurements inside it.

**Example use cases**

- **Construction review:** photograph a construction detail during a site visit, rebuild it in 3D back at the office, fly around it, measure clearances/dimensions, and verify nothing was missed.
- **Memory capture:** photograph a fishing spot (or the catch itself) and later "relive" the session by walking through the reconstructed scene.

---

## 1. High-Level Architecture

The system is split into a **web client** (capture, review, navigation, measurement) and a **processing backend** (photogrammetry + Gaussian splat training), connected by a REST/WebSocket API and object storage.

```
┌─────────────────────────────────────────────────────────────────┐
│  CLIENT (PWA, responsive — smartphone & desktop)                │
│                                                                 │
│  ┌──────────┐  ┌────────────┐  ┌───────────────────────────┐    │
│  │ Capture / │  │ Project /  │  │ 3D Viewer                 │    │
│  │ Upload UI │  │ Job list   │  │  - splat rendering        │    │
│  │ (camera + │  │ (progress, │  │  - orbit / fly / touch    │    │
│  │  gallery) │  │  status)   │  │  - measurement tools      │    │
│  └─────┬─────┘  └─────┬──────┘  └────────────┬──────────────┘    │
└────────┼──────────────┼─────────────────────┼───────────────────┘
         │ HTTPS upload │ REST + WebSocket    │ streamed .splat/.spz
┌────────▼──────────────▼─────────────────────▼───────────────────┐
│  API SERVER (FastAPI)                                           │
│   - auth, projects, photo sets, job orchestration               │
│   - progress events (WebSocket / SSE)                           │
└────────┬───────────────────────────────────────┬────────────────┘
         │ enqueue                               │ presigned URLs
┌────────▼────────────────────┐   ┌──────────────▼───────────────┐
│  WORKER (GPU or CPU node)   │   │  STORAGE                     │
│  1. Ingest & preprocess     │   │  - MinIO / local FS:         │
│  2. SfM: COLMAP / GLOMAP    │   │    photos, sparse models,    │
│  3. 3DGS training:          │   │    trained splats            │
│     OpenSplat / gsplat      │   │  - PostgreSQL (or SQLite):   │
│  4. Compress → .spz/.ksplat │   │    projects, jobs, measures  │
│  5. Scale calibration       │   └──────────────────────────────┘
└─────────────────────────────┘
```

### Processing pipeline (per photo set)

1. **Ingest** — validate photos, strip/record EXIF (focal length helps SfM), downscale very large images.
2. **Structure-from-Motion (SfM)** — COLMAP (or GLOMAP for faster global SfM) estimates camera poses and a sparse point cloud.
3. **Gaussian Splat training** — OpenSplat or gsplat trains the 3D Gaussian representation from posed images.
4. **Scale calibration** — resolve SfM's unknown scale (see §5, critical for measurements).
5. **Compression & export** — convert `.ply` output to compact `.spz` or `.ksplat` for fast mobile streaming.
6. **Publish** — store artifact, notify client via WebSocket; the viewer streams it progressively.

---

## 2. Tech Stack (all Open Source & free)

### Frontend

| Concern | Choice | License | Why |
|---|---|---|---|
| Framework | **React 18 + TypeScript + Vite** | MIT | Ecosystem, fast dev builds, strong typing for 3D math |
| 3D engine | **Three.js** | MIT | De-facto standard WebGL/WebGPU engine |
| Splat rendering | **@mkkellogg/gaussian-splats-3d** | MIT | Mature Three.js 3DGS renderer; loads `.ply`, `.splat`, `.ksplat`; progressive loading; works on mobile GPUs |
| Splat format | **.spz (Niantic)** and/or **.ksplat** | MIT | ~10× smaller than raw `.ply` — essential over mobile connections |
| UI components | **Tailwind CSS + shadcn/ui (Radix)** | MIT | Fast responsive layouts, accessible primitives |
| State / data | **Zustand + TanStack Query** | MIT | Simple client state + robust server-cache/upload handling |
| PWA | **vite-plugin-pwa (Workbox)** | MIT | Installable on phones, offline viewing of cached scenes |
| Camera capture | Native `<input type="file" capture>` + MediaDevices API | — | Zero-dependency photo capture on smartphones |

### Backend

| Concern | Choice | License | Why |
|---|---|---|---|
| API server | **FastAPI (Python 3.11+)** | MIT | Async, WebSockets, same language as ML tooling |
| Job queue | **Celery + Redis** (or Dramatiq) | BSD | Long-running GPU jobs, retries, progress reporting |
| SfM | **COLMAP** (+ **GLOMAP** optionally) | BSD-3 | Industry-standard open-source photogrammetry |
| 3DGS training | **OpenSplat** (AGPL-3.0) or **gsplat / Nerfstudio "splatfacto"** (Apache-2.0) | see §6 | OpenSplat runs on CUDA, ROCm, Metal *and* CPU; gsplat is fastest on NVIDIA GPUs |
| Alt. trainer | **Brush** (Apache-2.0/MIT) | — | Rust/WebGPU trainer; runs on almost any GPU, no CUDA required — good fallback/self-host story |
| Database | **PostgreSQL** (SQLite for dev) | PostgreSQL/PD | Projects, users, jobs, measurement annotations |
| Object storage | **MinIO** (or plain filesystem for single-node) | AGPL-3.0 | S3-compatible presigned uploads/downloads |
| Containerization | **Docker + docker-compose** | Apache-2.0 | Reproducible GPU worker images (CUDA base or CPU) |
| Image handling | **Pillow / OpenCV** | MIT-style/Apache | EXIF, downscaling, blur detection, marker detection |

### Deployment profiles

- **Self-hosted single machine** (recommended start): docker-compose with `web`, `api`, `worker`, `redis`, `postgres`, `minio`. A consumer NVIDIA GPU (≥8 GB VRAM) trains a typical 50–150 photo scene in ~5–30 min; OpenSplat's CPU mode works without any GPU (slower, but keeps the stack 100 % free).
- **Scale-out later:** move workers to any GPU cloud; nothing in the stack is proprietary.

---

## 3. Client Application Design (mobile-first)

### Screens

1. **Capture / Upload**
   - Take photos directly (phone camera) or pick from gallery; show a live counter and coverage tips ("orbit the subject, 60–70 % overlap, 30+ photos").
   - Client-side pre-checks: minimum count, blur warning (variance-of-Laplacian via a small WASM/canvas check), duplicate detection.
   - Chunked, resumable uploads (tus protocol or multipart with retry) — site visits often mean weak connectivity; allow "queue now, upload on Wi-Fi" via the PWA.
2. **Projects & Jobs**
   - Project = one scene (e.g. "Balcony anchor detail — Site A, 2026-08-14"). Shows pipeline stage (Ingest → SfM → Training → Ready), live progress, and failure diagnostics ("only 12 of 40 photos registered — add more overlapping shots of the left side").
3. **Viewer**
   - Streams the compressed splat progressively (usable view within seconds).
   - **Touch controls:** one-finger orbit, two-finger pan, pinch zoom, double-tap to set orbit pivot; optional device-orientation ("look around") mode for the reliving use case.
   - **Desktop controls:** orbit + WASD fly mode.
   - Source-photo overlay: tap a camera frustum to see the original photo registered in 3D — invaluable for construction review ("which photo shows this weld?").
4. **Measurement mode** (see §4)
5. **Share / Export** — read-only share links; export `.ply`/`.spz` and a PDF/PNG snapshot report with annotated measurements (construction hand-off).

### Responsiveness rules

- Layout: single-column, bottom toolbar on phones; side panels on ≥ md breakpoints.
- Rendering budget: cap splat count / use lower-detail `.ksplat` LOD on mobile GPUs; dynamic resolution scaling to hold 30+ fps; `devicePixelRatio` clamping.
- All viewer tools operable with touch only; hit targets ≥ 44 px.

---

## 4. Measurement System

Measurements are the differentiating feature and drive several design choices:

- **Picking:** raycast against the splat field (nearest Gaussian centers within a screen-space radius, depth-weighted) to get a robust 3D point under the cursor/finger; snap-assist using the SfM sparse points where available.
- **Tools:**
  - *Point-to-point distance* (primary tool),
  - *Polyline / path length*,
  - *Height relative to a defined ground plane*,
  - *Angle between two segments*,
  - *Area of a picked polygon* (v2).
- **Annotations:** measurements and text notes persist to the DB per project, render as labels in-scene, and appear in the export report.
- **Accuracy display:** every measurement shows an estimated uncertainty (derived from calibration residual + local point density) so a construction user knows whether "412 mm" means ±2 mm or ±20 mm.

## 5. Scale Calibration (making measurements real)

SfM reconstructions are **scale-ambiguous** — without extra information, distances are in arbitrary units. The plan supports three calibration paths, in order of preference:

1. **Printed fiducial marker (recommended):** user lays an ArUco/ChArUco board or a printed A4 target of known size in the scene; the worker detects it in the photos (OpenCV, Apache-2.0) and scales the reconstruction automatically. Ideal for construction details.
2. **Known-distance calibration:** in the viewer, the user picks two points with a known real-world distance (a tape measure in shot, a standard brick, a 1 m level) and enters the value; the app rescales the scene.
3. **EXIF/heuristic prior:** fallback rough scale from camera intrinsics — flagged clearly as "approximate, do not use for critical measurements".

The UI keeps a visible badge: **Calibrated (±x %) / Uncalibrated** on every scene.

---

## 6. Dependencies & Licensing Summary

All runtime dependencies are open source and free to use:

| Component | License | Note |
|---|---|---|
| React, Vite, Three.js, Zustand, TanStack Query, Tailwind, Radix | MIT | permissive |
| @mkkellogg/gaussian-splats-3d | MIT | permissive |
| .spz reference lib (Niantic) | MIT | permissive |
| FastAPI, Celery, Pillow | MIT/BSD | permissive |
| COLMAP, GLOMAP | BSD-3 | permissive |
| gsplat / Nerfstudio | Apache-2.0 | permissive; **needs CUDA** |
| Brush | Apache-2.0 / MIT | any GPU via WebGPU |
| OpenCV | Apache-2.0 | marker detection |
| PostgreSQL, Redis*, MinIO | PostgreSQL / RSAL-or-BSD / AGPL-3.0 | see notes |
| OpenSplat | AGPL-3.0 | copyleft — see below |

**Licensing notes**

- **OpenSplat (AGPL)** and **MinIO (AGPL)** are used as *standalone services/CLI tools invoked over process/S3 boundaries*, not linked into our code. AGPL obligations apply to those components themselves (whose sources are public). If the project must avoid AGPL entirely: use **gsplat (Apache)** or **Brush (Apache/MIT)** for training and **SeaweedFS (Apache)** or plain filesystem for storage.
- **Redis** ≥ 7.4 is dual-licensed (RSAL/SSPL); pin Redis 7.2 (BSD) or use **Valkey** (BSD-3, drop-in fork) to stay strictly open source.
- No proprietary SDKs, no paid APIs, no per-seat tools anywhere in the pipeline.

---

## 7. Development Process — Sub-Agents for Coding Tasks

**All coding tasks in this project should be executed using sub-agents** (Claude Code's Agent tool / Task-spawned subagents), with the main session acting as orchestrator and reviewer. Concretely:

- **Decompose per work package:** each item in the roadmap below is dispatched to a dedicated sub-agent with a self-contained brief (goal, files in scope, acceptance criteria, test command).
- **Parallelize independent tracks:** e.g. one sub-agent builds the upload UI while another writes the COLMAP worker wrapper and a third sets up the viewer — they touch disjoint parts of the tree and run concurrently (worktree isolation when they must mutate files in parallel).
- **Specialized roles:** exploration/research sub-agents (evaluate splat renderers, benchmark trainers), implementation sub-agents (feature code + unit tests), and review sub-agents (adversarial code review of each PR-sized change before merge).
- **Orchestrator responsibilities:** the main session keeps the architecture coherent, writes/updates interface contracts (API schemas, file formats) *before* dispatching agents, integrates results, and runs the end-to-end smoke test after each merge.
- **Definition of done per sub-agent task:** code + tests passing + short summary of decisions; no task is merged without the review sub-agent's pass.

---

## 8. Roadmap / Milestones

| # | Milestone | Deliverable |
|---|---|---|
| 0 | **Scaffolding** | Monorepo (`web/`, `api/`, `worker/`), docker-compose, CI (lint + tests) |
| 1 | **Viewer MVP** | Load a pre-made `.ply`/`.ksplat` splat, responsive touch navigation on a phone |
| 2 | **Pipeline MVP** | Upload photos → COLMAP → OpenSplat/gsplat → compressed splat → auto-appears in viewer; job progress via WebSocket |
| 3 | **Measurements v1** | Point picking, point-to-point distance, known-distance scale calibration, persisted annotations |
| 4 | **Field usability** | PWA install + offline queueing, resumable uploads, capture guidance & photo quality checks, failure diagnostics |
| 5 | **Measurements v2** | ArUco auto-scaling, ground plane, angles, polyline, uncertainty display, PDF/PNG report export |
| 6 | **Sharing & polish** | Read-only share links, source-photo frustum overlay, LOD/perf tuning for low-end phones |

**Primary risks & mitigations**

- *SfM failure on texture-poor subjects* (shiny fish, plain concrete): capture guidance UI, more-photos diagnostics, optional video-input frame extraction later.
- *Mobile GPU limits:* aggressive compression (.spz), LOD, dynamic resolution — addressed from Milestone 1.
- *Measurement trust:* calibration badge + uncertainty estimates so users never over-trust an uncalibrated scene.
