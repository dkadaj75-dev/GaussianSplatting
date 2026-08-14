# SplatScene worker

Run locally from this directory:

```sh
pip install -r requirements-dev.txt
celery -A worker.tasks worker --loglevel=INFO
```

Configuration is supplied through environment variables:

- `REDIS_URL` — broker, result backend, and progress Redis connection; defaults to `redis://localhost:6379/0`.
- `STORAGE_DIR` — local job storage root; defaults to `./data`.
- `PIPELINE_BACKEND` — `fake` (default) or `real`. The fake backend creates small placeholder artifacts and needs no GPU tooling. The real backend runs COLMAP followed by OpenSplat.
- `COLMAP_SIFT_USE_GPU` — set to `1`, `true`, `yes`, or `on` to let COLMAP use GPU SIFT. It defaults to `0` so the real backend is CPU-portable. Per-job `sift_use_gpu` (or `use_gpu`) takes precedence.

## Real backend

Set `PIPELINE_BACKEND=real` on a worker that has these executables available on
`PATH`:

- [COLMAP](https://colmap.github.io/) **>= 3.8** (`colmap` command)
- [OpenSplat](https://github.com/pierotofy/OpenSplat) (`opensplat` command)

The worker validates and copies supported non-empty uploads (`jpg`, `jpeg`,
`png`, `tif`, `tiff`, `bmp`, `webp`) to `work/images/`; at least three are
required. It then runs COLMAP feature extraction, matching, mapping, and text
model conversion. The default matcher is exhaustive; pass
`{"matcher": "sequential"}` for sequential capture sets. OpenSplat receives
the COLMAP work directory and defaults to 7,000 iterations; override it with
`{"iterations": 12000}`. The real backend reports missing executables with an
install hint; use `PIPELINE_BACKEND=fake` when developing without them.

Successful jobs leave these API-served files in `output/`:

```
output/
  output.ply       # OpenSplat's original PLY
  scene.splat      # generated when the PLY has standard 3DGS fields
  manifest.json
```

`scene.splat` contains 32-byte records (position, scale, RGBA, quaternion).
The stdlib converter reads binary-little-endian 3DGS PLY, transforms SH DC,
opacity, logarithmic scale, and rotation fields, and intentionally keeps PLY
order rather than sorting splats. If a PLY is not in that expected form, the
pipeline still publishes `output.ply` and records a progress message explaining
why `.splat` was not produced.

`manifest.json` has this shape:

```json
{
  "artifacts": [
    {"filename": "output.ply", "bytes": 1234, "format": "ply"},
    {"filename": "scene.splat", "bytes": 1024, "format": "splat"}
  ],
  "registration": {"input_images": 40, "registered_images": 12}
}
```

`worker.run_pipeline(job_id, project_id, params)` processes `ingest`, `sfm`, `train`, `compress`, then `publish`. Progress is JSON pub/sub on `jobs:{job_id}`:

```json
{
  "job_id": "...",
  "stage": "train",
  "progress": 0.5,
  "status": "running",
  "message": "train in progress",
  "ts": "2026-08-14T12:00:00+00:00"
}
```

`status` is `running`, `failed`, or `done`. The final successful event has `status: "done"`.
