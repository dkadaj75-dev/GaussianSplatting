#!/usr/bin/env python
"""End-to-end smoke check: REST → Celery → worker → Redis → WebSocket.

Driven by ``scripts/smoke.sh`` (which provides Redis and a running API); it can
also be pointed at any already-running stack:

    API_BASE_URL=http://localhost:8000 \
    STORAGE_DIR=/srv/api/data/photos \
    WORKER_PYTHON=worker/.venv/bin/python \
    python scripts/smoke_e2e.py

The Celery worker is started *after* the WebSocket is connected, so the run
deterministically observes the live event stream instead of racing the (very
fast) fake pipeline.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import httpx
from websockets.asyncio.client import connect

REPO_ROOT = Path(__file__).resolve().parent.parent

API_BASE_URL = os.environ.get("API_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
WS_BASE_URL = os.environ.get("WS_BASE_URL", API_BASE_URL.replace("http://", "ws://", 1))
STORAGE_DIR = Path(os.environ.get("STORAGE_DIR", REPO_ROOT / "api" / "data" / "photos"))
REDIS_URL = os.environ.get("REDIS_URL", "redis://127.0.0.1:6379/0")
WORKER_PYTHON = os.environ.get("WORKER_PYTHON", sys.executable)
WORKER_DIR = REPO_ROOT / "worker"
EXPECTED_STAGES = ["ingest", "sfm", "train", "compress", "publish"]
TIMEOUT_SECONDS = float(os.environ.get("SMOKE_TIMEOUT", "90"))

PNG = (
    b"\x89PNG\r\n\x1a\n"
    b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
    b"\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4"
    b"\x00\x00\x00\x00IEND\xaeB`\x82"
)


def step(message: str) -> None:
    print(f"  → {message}", flush=True)


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)
    print(f"  ✓ {message}", flush=True)


def start_worker() -> subprocess.Popen:
    env = {
        **os.environ,
        "REDIS_URL": REDIS_URL,
        "STORAGE_DIR": str(STORAGE_DIR),
        "PIPELINE_BACKEND": "fake",
    }
    return subprocess.Popen(
        [
            WORKER_PYTHON,
            "-m",
            "celery",
            "-A",
            "worker.tasks",
            "worker",
            "--loglevel=INFO",
            "--concurrency=1",
        ],
        cwd=WORKER_DIR,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )


async def main() -> int:
    async with httpx.AsyncClient(base_url=API_BASE_URL, timeout=30) as client:
        health = (await client.get("/healthz")).json()
        step(f"API up: version {health['version']}")

        project = (await client.post("/api/projects", json={"name": "Smoke — site A"})).json()
        step(f"project {project['id']}")

        upload = await client.post(
            f"/api/projects/{project['id']}/photos",
            files=[("files", ("smoke0.png", PNG, "image/png"))],
        )
        check(upload.status_code == 201, "photo uploaded")

        created = await client.post(f"/api/projects/{project['id']}/jobs", json={})
        check(created.status_code == 201, "job created")
        job = created.json()
        check(job["task_id"] is not None, f"API dispatched a Celery task ({job['task_id']})")
        check(job["status"] == "queued", "job starts queued")

        # Connect *before* the worker exists: the queued task cannot be consumed
        # yet, so every progress frame below is genuinely live.
        async with connect(f"{WS_BASE_URL}/ws/jobs/{job['id']}") as websocket:
            snapshot = json.loads(await asyncio.wait_for(websocket.recv(), timeout=10))
            check(snapshot["type"] == "snapshot", "websocket snapshot received")

            worker = start_worker()
            step("celery worker started; waiting for progress events")
            try:
                stages: list[str] = []
                statuses: list[str] = []
                deadline = asyncio.get_running_loop().time() + TIMEOUT_SECONDS
                final = None
                while final is None:
                    remaining = deadline - asyncio.get_running_loop().time()
                    if remaining <= 0:
                        raise TimeoutError("no terminal event within the smoke timeout")
                    frame = json.loads(await asyncio.wait_for(websocket.recv(), timeout=remaining))
                    if frame.get("type") == "ping":
                        continue
                    statuses.append(frame["status"])
                    if not stages or stages[-1] != frame["stage"]:
                        stages.append(frame["stage"])
                    print(
                        f"    ws ← {frame['stage']:<9} {frame['progress']:>4.0%} {frame['status']}",
                        flush=True,
                    )
                    if frame["status"] in ("done", "failed"):
                        final = frame
            finally:
                worker.terminate()
                try:
                    worker.wait(timeout=20)
                except subprocess.TimeoutExpired:  # pragma: no cover - slow shutdown
                    worker.kill()

        check(final["status"] == "done", "job finished with status=done over the websocket")
        check(stages == EXPECTED_STAGES, f"stages streamed in order: {stages}")
        check("running" in statuses, "running events were streamed while the pipeline worked")

        stored = (await client.get(f"/api/jobs/{job['id']}")).json()
        check(stored["status"] == "done", "job row persisted as done by the bridge")
        check(stored["progress"] == 1.0, "job row progress is 1.0")
        check(stored["finished_at"] is not None, "job row has finished_at")

        refreshed = (await client.get(f"/api/projects/{project['id']}")).json()
        check(refreshed["status"] == "ready", "project marked ready")

    artifact = (
        STORAGE_DIR / "projects" / project["id"] / "jobs" / job["id"] / "output" / "scene.splat"
    )
    check(artifact.exists(), f"worker artifact visible to the API at {artifact}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except (AssertionError, TimeoutError) as exc:
        print(f"  ✗ SMOKE FAILED: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
