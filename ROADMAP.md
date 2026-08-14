# SplatScene — Development Roadmap

Companion to [PLAN.md](./PLAN.md). Milestones are broken into **work packages (WP)** sized for a single sub-agent run. Per the development process in PLAN.md §7, every coding WP is executed by a sub-agent (Claude Opus via the Agent tool, or Codex CLI via `codex exec`), with the orchestrator session integrating and reviewing.

**Agent legend:** `[OPUS]` = Claude Opus sub-agent · `[CODEX]` = Codex CLI sub-agent · `[ORCH]` = orchestrator (integration/review only)

**Repo layout (monorepo):**

```
web/      React + TS + Vite PWA (viewer, capture, measurements)
api/      FastAPI server (projects, jobs, uploads, WebSocket progress)
worker/   Celery pipeline worker (COLMAP → 3DGS training → compression)
infra/    docker-compose, Dockerfiles, CI
docs/     PLAN.md, ROADMAP.md, ADRs
```

---

## Milestone 0 — Scaffolding *(in progress)*

| WP | Agent | Deliverable | Acceptance |
|----|-------|-------------|------------|
| 0.1 | [OPUS] | `web/`: Vite + React + TS + Tailwind + PWA scaffold; routing (Projects / Capture / Viewer); Zustand + TanStack Query wired | `npm run build` passes; responsive shell renders on 375 px viewport |
| 0.2 | [OPUS] | `api/`: FastAPI app; models Project/PhotoSet/Job; REST CRUD; photo upload endpoint (multipart, local FS storage); WebSocket `/ws/jobs/{id}` progress channel; SQLite dev DB; `docker-compose.yml` + root README | `pytest` passes; `uvicorn` serves OpenAPI docs; compose file lints |
| 0.3 | [CODEX] | `worker/`: Celery app + Redis broker config; pipeline task skeleton with stages (ingest → sfm → train → compress → publish) emitting progress to Redis; COLMAP/OpenSplat invoked behind a `PipelineBackend` interface with a `FakeBackend` for tests | `pytest` passes with FakeBackend; a submitted job walks all stages and reports progress |
| 0.4 | [ORCH] | Integration: API enqueues to worker, progress reaches WebSocket; CI workflow (lint + tests for all three packages) | End-to-end smoke test green |

## Milestone 1 — Viewer MVP

| WP | Agent | Deliverable |
|----|-------|-------------|
| 1.1 | [OPUS] | Splat viewer component: `@mkkellogg/gaussian-splats-3d` in Three.js; loads `.ply`/`.ksplat`/`.splat` from URL; progressive loading UI |
| 1.2 | [OPUS] | Touch + desktop navigation: one-finger orbit, two-finger pan, pinch zoom, double-tap pivot; WASD fly mode; dynamic resolution scaling + DPR clamp for mobile |
| 1.3 | [CODEX] | Sample-scene fixture pipeline: script to fetch/convert a public-domain sample splat for dev & e2e tests |
| 1.4 | [ORCH] | Perf pass on low-end phone profile (Chrome DevTools throttling); review + merge |

## Milestone 2 — Pipeline MVP

| WP | Agent | Deliverable |
|----|-------|-------------|
| 2.1 | [CODEX] | Real `ColmapBackend`: feature extraction, matching, mapper; failure diagnostics (unregistered-image report) |
| 2.2 | [CODEX] | Real `TrainerBackend`: OpenSplat (CPU/GPU) with iteration progress parsing; gsplat variant behind the same interface |
| 2.3 | [OPUS] | Compression step: `.ply` → `.spz`/`.ksplat` conversion + artifact publishing to storage |
| 2.4 | [OPUS] | Frontend job flow: upload set → watch progress stages → auto-open finished scene in viewer |
| 2.5 | [ORCH] | GPU + CPU-only docker images; end-to-end test with a real 30-photo set |

## Milestone 3 — Measurements v1

| WP | Agent | Deliverable |
|----|-------|-------------|
| 3.1 | [OPUS] | Point picking on splats (screen-space nearest-Gaussian, depth-weighted) with visual marker |
| 3.2 | [OPUS] | Point-to-point distance tool + in-scene labels; measurement persistence (API + DB) |
| 3.3 | [CODEX] | Known-distance scale calibration: pick two points, enter real length, rescale scene; calibration badge state |
| 3.4 | [ORCH] | Accuracy validation against a ground-truth object; review + merge |

## Milestone 4 — Field usability

| WP | Agent | Deliverable |
|----|-------|-------------|
| 4.1 | [OPUS] | Capture guidance UI (coverage tips, photo counter, blur warning) |
| 4.2 | [CODEX] | Resumable/chunked uploads with offline queue (PWA background sync) |
| 4.3 | [OPUS] | Failure diagnostics surfaced in UI ("12/40 photos registered — reshoot left side") |

## Milestone 5 — Measurements v2

| WP | Agent | Deliverable |
|----|-------|-------------|
| 5.1 | [CODEX] | ArUco/ChArUco auto-scale detection in worker (OpenCV) |
| 5.2 | [OPUS] | Ground plane, angle, polyline tools; uncertainty display |
| 5.3 | [OPUS] | PDF/PNG annotated report export |

## Milestone 6 — Sharing & polish

| WP | Agent | Deliverable |
|----|-------|-------------|
| 6.1 | [OPUS] | Read-only share links |
| 6.2 | [OPUS] | Source-photo camera-frustum overlay in viewer |
| 6.3 | [CODEX] | LOD / perf tuning for low-end devices |

---

## Working agreements

- Interface contracts (API schemas, `PipelineBackend`, splat artifact layout) are written/updated by the orchestrator **before** dispatching agents on either side of a boundary.
- Parallel agents own disjoint directories; cross-cutting changes go through the orchestrator.
- Definition of done per WP: code + passing tests + brief decision summary; a review sub-agent passes over each WP before merge.
- Codex model policy per project convention: `gpt-5.6-terra` for scoped WPs, `gpt-5.6-sol` only for architecture-heavy or hard-debugging work.
