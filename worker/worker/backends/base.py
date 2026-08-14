"""Interfaces shared by concrete pipeline implementations."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


ProgressCallback = Callable[[str, float, str], None]


@dataclass(frozen=True)
class JobContext:
    job_id: str
    project_id: str
    input_dir: Path
    work_dir: Path
    output_dir: Path
    params: dict


class PipelineBackend(ABC):
    """A backend for the five ordered scene-processing stages."""

    @abstractmethod
    def ingest(self, job: JobContext, progress: ProgressCallback) -> None:
        """Validate and prepare uploaded source images."""

    @abstractmethod
    def run_sfm(self, job: JobContext, progress: ProgressCallback) -> None:
        """Estimate camera poses and a sparse reconstruction."""

    @abstractmethod
    def train(self, job: JobContext, progress: ProgressCallback) -> None:
        """Train the Gaussian splat representation."""

    @abstractmethod
    def compress(self, job: JobContext, progress: ProgressCallback) -> None:
        """Compress the trained scene for delivery."""

    @abstractmethod
    def publish(self, job: JobContext, progress: ProgressCallback) -> None:
        """Place final artifacts in the job output directory."""
