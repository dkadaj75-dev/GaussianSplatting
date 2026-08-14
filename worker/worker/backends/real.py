"""Milestone-2 placeholder for the COLMAP/OpenSplat command-line backend."""

from __future__ import annotations

import shutil

from .base import JobContext, PipelineBackend, ProgressCallback


class NotInstalledError(RuntimeError):
    """Raised when a required external processing executable is unavailable."""


class ColmapOpenSplatBackend(PipelineBackend):
    """Command-line backend reserved for the real Milestone-2 pipeline."""

    @staticmethod
    def _require(executable: str) -> None:
        if shutil.which(executable) is None:
            raise NotInstalledError(
                f"{executable!r} is not installed or is not available on PATH; "
                "use PIPELINE_BACKEND=fake for local development."
            )

    def ingest(self, job: JobContext, progress: ProgressCallback) -> None:
        # TODO(M2): validate/downscale images and record EXIF metadata.
        raise NotImplementedError("Real ingest will be implemented in Milestone 2")

    def run_sfm(self, job: JobContext, progress: ProgressCallback) -> None:
        self._require("colmap")
        # TODO(M2): invoke COLMAP feature extraction, matching, and mapper safely.
        raise NotImplementedError("COLMAP execution will be implemented in Milestone 2")

    def train(self, job: JobContext, progress: ProgressCallback) -> None:
        self._require("opensplat")
        # TODO(M2): invoke OpenSplat and parse its progress output.
        raise NotImplementedError("OpenSplat execution will be implemented in Milestone 2")

    def compress(self, job: JobContext, progress: ProgressCallback) -> None:
        # TODO(M2): convert PLY output to the selected web delivery format.
        raise NotImplementedError("Real compression will be implemented in Milestone 2")

    def publish(self, job: JobContext, progress: ProgressCallback) -> None:
        # TODO(M2): publish artifacts to configured object/local storage.
        raise NotImplementedError("Real publishing will be implemented in Milestone 2")
