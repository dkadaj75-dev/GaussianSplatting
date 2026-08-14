"""Fast deterministic backend used by tests and local development."""

from __future__ import annotations

import time
from pathlib import Path

from .base import JobContext, PipelineBackend, ProgressCallback


class FakeBackend(PipelineBackend):
    """Simulate pipeline work while producing a representative artifact layout."""

    sleep_seconds = 0.01

    def _simulate(self, stage: str, progress: ProgressCallback) -> None:
        progress(stage, 0.0, f"{stage} started")
        time.sleep(self.sleep_seconds)
        progress(stage, 0.5, f"{stage} in progress")
        time.sleep(self.sleep_seconds)
        progress(stage, 1.0, f"{stage} complete")

    @staticmethod
    def _write(path: Path, content: str = "") -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def ingest(self, job: JobContext, progress: ProgressCallback) -> None:
        self._simulate("ingest", progress)
        self._write(job.work_dir / "ingest" / "manifest.json", "{}\n")

    def run_sfm(self, job: JobContext, progress: ProgressCallback) -> None:
        self._simulate("sfm", progress)
        self._write(job.work_dir / "sfm" / "cameras.txt", "# fake cameras\n")

    def train(self, job: JobContext, progress: ProgressCallback) -> None:
        self._simulate("train", progress)
        self._write(job.work_dir / "train" / "output.ply", "ply\nformat ascii 1.0\nend_header\n")

    def compress(self, job: JobContext, progress: ProgressCallback) -> None:
        self._simulate("compress", progress)
        self._write(job.work_dir / "compress" / "scene.splat")

    def publish(self, job: JobContext, progress: ProgressCallback) -> None:
        self._simulate("publish", progress)
        self._write(job.output_dir / "output.ply", "ply\nformat ascii 1.0\nend_header\n")
        self._write(job.output_dir / "scene.splat")
