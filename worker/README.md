# SplatScene worker

Run locally from this directory:

```sh
pip install -r requirements-dev.txt
celery -A worker.tasks worker --loglevel=INFO
```

Configuration is supplied through environment variables:

- `REDIS_URL` — broker, result backend, and progress Redis connection; defaults to `redis://localhost:6379/0`.
- `STORAGE_DIR` — local job storage root; defaults to `./data`.
- `PIPELINE_BACKEND` — `fake` (default) or `real`. The fake backend creates small placeholder artifacts and needs no GPU tooling. The real backend is a Milestone-2 stub and reports missing `colmap`/`opensplat` executables clearly.

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
