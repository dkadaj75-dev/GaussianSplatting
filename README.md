# SplatScene

Photograph a subject — a construction detail, a room corner, a fish — and get
back a navigable 3D scene you can fly through and **measure inside**.

Photos are uploaded from a phone or desktop browser, reconstructed with
Structure-from-Motion + Gaussian Splatting on a worker node, compressed, and
streamed back to a WebGL viewer.

- **[PLAN.md](./PLAN.md)** — architecture, tech stack, measurement &
  scale-calibration design, licensing.
- **[ROADMAP.md](./ROADMAP.md)** — milestones broken into work packages.

Everything in the stack is open source and free to run (MIT / BSD / Apache,
with the AGPL components isolated behind process boundaries — see PLAN.md §6).

---

## Repository layout

```
web/      React + TS + Vite PWA (viewer, capture, measurements)   [WP 0.1]
api/      FastAPI server (projects, jobs, uploads, WS progress)   [WP 0.2]
worker/   Celery pipeline worker (COLMAP → 3DGS → compression)    [WP 0.3]
infra/    CI and deployment extras
```

Milestone 0 is in progress, so not every directory exists yet.

---

## Quickstart

### Full stack with Docker Compose

```bash
docker compose up --build
```

- web → http://localhost:5173
- api → http://localhost:8000 (interactive docs at `/docs`)

This runs the **fake pipeline**: uploads, job progress, the viewer and the
measurement tools all work end to end, but the scene is a placeholder rather
than a reconstruction of your photos. Nothing but Docker is required.

For real reconstruction, pick the worker that matches your machine — exactly
one worker may run, since they share a queue, and `--profile` replaces the
default in `.env`:

```bash
docker compose --profile gpu up --build   # NVIDIA GPU (see infra/README.md)
docker compose --profile cpu up --build   # no GPU: real, but slow
```

The first real build compiles OpenSplat and takes 20–60 minutes. Photos and
the dev SQLite database live in the `splat-data` volume, so they survive
`docker compose down`.

**Check a photo set before committing to a GPU run** — `tools/reconstruct/`
runs structure-from-motion on CPU in seconds and reports how many photos
registered, which is the single best predictor of whether a capture will
reconstruct at all. See `tools/reconstruct/README.md`.

### API only (local Python)

Requires Python 3.11+.

```bash
cd api
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt

cp .env.example .env          # optional; defaults work out of the box
DEV_MODE=1 uvicorn app.main:app --reload --port 8000
```

Then open http://localhost:8000/docs (OpenAPI UI) or
http://localhost:8000/healthz.

Run the tests:

```bash
cd api && pytest
```

### Web only (local Node)

Requires Node 20+.

```bash
cd web
npm install
npm run dev          # http://localhost:5173
```

The API allows `http://localhost:5173` by default; override with
`CORS_ORIGINS` (comma-separated) if you serve the client elsewhere.

---

## API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Liveness + version |
| `POST` / `GET` | `/api/projects` | Create / list projects |
| `GET` / `PATCH` / `DELETE` | `/api/projects/{id}` | Read / update / delete (cascades to photos, jobs, measurements) |
| `POST` / `GET` | `/api/projects/{id}/photos` | Multipart upload (repeated `files` field) / list |
| `DELETE` | `/api/projects/{id}/photos/{photo_id}` | Delete a photo and its file |
| `POST` / `GET` | `/api/projects/{id}/jobs` | Start a pipeline run / list runs |
| `GET` | `/api/jobs/{id}` | Job status |
| `POST` `GET` `PATCH` `DELETE` | `/api/projects/{id}/measurements[/{mid}]` | Measurement CRUD |
| `WS` | `/ws/jobs/{job_id}` | Live job progress |
| `POST` | `/api/dev/jobs/{id}/advance` | **Dev only** — step a job forward |

### Job progress over WebSocket

Connect to `ws://localhost:8000/ws/jobs/{job_id}`. The server sends the current
state immediately, then one frame per update:

```json
{"type": "snapshot", "job_id": "…", "project_id": "…", "stage": "sfm",
 "progress": 0.5, "status": "running", "message": null,
 "updated_at": "2026-08-14T10:00:00+00:00"}
```

`type` is `snapshot` (first frame), `created`/`progress` (updates), or `ping`
(keepalive every 25 s). Stages run `ingest → sfm → train → compress → publish`;
status is one of `queued | running | failed | done`. An unknown job closes the
socket with code `4004`.

### Demoing progress without a worker

With `DEV_MODE=1`, drive a job by hand:

```bash
PROJECT=$(curl -s -X POST localhost:8000/api/projects \
  -H 'content-type: application/json' -d '{"name":"Demo"}' | jq -r .id)
curl -s -X POST localhost:8000/api/projects/$PROJECT/photos -F files=@photo.jpg
JOB=$(curl -s -X POST localhost:8000/api/projects/$PROJECT/jobs \
  -H 'content-type: application/json' -d '{}' | jq -r .id)

# Watch it in another terminal, then step it forward:
curl -s -X POST localhost:8000/api/dev/jobs/$JOB/advance
```

---

## Configuration

All API settings are environment variables (see `api/.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `sqlite:///./data/splatscene.db` | SQLite for dev, PostgreSQL in production |
| `STORAGE_DIR` | `./data/photos` | Photos at `{STORAGE_DIR}/{project_id}/{photo_id}{ext}` |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated allowed browser origins |
| `DEV_MODE` | `0` | `1` exposes `/api/dev/*` — never enable in production |
| `ALLOWED_IMAGE_TYPES` | jpeg, png, webp, heic, heif | Upload content-type allowlist |
| `MAX_PHOTO_BYTES` | `52428800` (50 MiB) | Per-photo size cap |
| `REDIS_URL` | `redis://localhost:6379/0` | Celery broker (from WP 0.3) |

---

## Current status & integration points

The API is complete for Milestone 0 but two seams are deliberately stubbed,
each marked `INTEGRATION POINT` in the source:

- **Job queueing** (`api/app/job_service.py::enqueue_job`) — creating a job
  writes a `queued` row; the Celery dispatch lands in WP 0.3/0.4.
- **Progress pub/sub** (`api/app/events.py`) — an in-process `JobEventBus`
  fans events out today. Once the worker publishes from another process, it is
  replaced by a Redis-backed bus with the same interface; no route code
  changes.

A third seam, `api/app/storage.py::save_upload`, is where local-filesystem
storage becomes MinIO/S3 presigned uploads for multi-node deploys.

---

## Development process

Per PLAN.md §7, coding work packages are executed by sub-agents with the main
session orchestrating, integrating and reviewing. Definition of done for a
package: code + passing tests + a short summary of decisions.
