"""COLMAP and OpenSplat command-line pipeline implementation.

The module deliberately has no image or ML Python dependencies: COLMAP reads the
uploaded images and the small delivery-format converter uses :mod:`struct`.
"""

from __future__ import annotations

import json
import math
import os
import re
import shutil
import struct
import subprocess
from collections import deque
from pathlib import Path
from typing import Callable, Iterable

from .base import JobContext, PipelineBackend, ProgressCallback


class NotInstalledError(RuntimeError):
    """Raised when a required external processing executable is unavailable."""


_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp"}
_SH_C0 = 0.28209479177387814
_PLY_TYPES = {
    "char": "b", "int8": "b", "uchar": "B", "uint8": "B",
    "short": "h", "int16": "h", "ushort": "H", "uint16": "H",
    "int": "i", "int32": "i", "uint": "I", "uint32": "I",
    "float": "f", "float32": "f", "double": "d", "float64": "d",
}


def _sigmoid(value: float) -> float:
    if value >= 0:
        return 1.0 / (1.0 + math.exp(-value))
    exp_value = math.exp(value)
    return exp_value / (1.0 + exp_value)


def _byte(value: float) -> int:
    return max(0, min(255, int(round(value * 255))))


def ply_to_splat(source: Path, destination: Path) -> int:
    """Convert binary-little-endian 3DGS PLY to the 32-byte ``.splat`` layout.

    Records are deliberately retained in PLY order.  Sorting by opacity-volume
    can improve rendering in some viewers, but is intentionally deferred because
    it is not required by the format and can be expensive for large scenes.
    """
    with source.open("rb") as input_file:
        header_lines: list[str] = []
        while True:
            line = input_file.readline()
            if not line:
                raise ValueError("PLY header ended before end_header")
            try:
                decoded = line.decode("ascii").rstrip("\r\n")
            except UnicodeDecodeError as exc:
                raise ValueError("PLY header is not ASCII") from exc
            header_lines.append(decoded)
            if decoded == "end_header":
                break

        if not header_lines or header_lines[0] != "ply" or "format binary_little_endian 1.0" not in header_lines:
            raise ValueError("expected a binary_little_endian PLY")
        vertex_count = None
        properties: list[tuple[str, str]] = []
        in_vertex = False
        for line in header_lines[1:]:
            words = line.split()
            if words[:2] == ["element", "vertex"] and len(words) == 3:
                vertex_count, in_vertex = int(words[2]), True
            elif words[:1] == ["element"]:
                in_vertex = False
            elif in_vertex and words[:1] == ["property"]:
                if len(words) != 3 or words[1] == "list" or words[1] not in _PLY_TYPES:
                    raise ValueError("vertex properties must be scalar standard PLY types")
                properties.append((words[2], words[1]))
        if vertex_count is None:
            raise ValueError("PLY has no vertex element")
        required = {"x", "y", "z", "scale_0", "scale_1", "scale_2", "opacity", "rot_0", "rot_1", "rot_2", "rot_3", "f_dc_0", "f_dc_1", "f_dc_2"}
        names = {name for name, _type in properties}
        missing = sorted(required - names)
        if missing:
            raise ValueError("PLY lacks 3DGS fields: " + ", ".join(missing))
        record_format = "<" + "".join(_PLY_TYPES[data_type] for _name, data_type in properties)
        unpack = struct.Struct(record_format)
        if unpack.size == 0:
            raise ValueError("PLY vertex record is empty")

        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open("wb") as output_file:
            for _ in range(vertex_count):
                raw = input_file.read(unpack.size)
                if len(raw) != unpack.size:
                    raise ValueError("PLY ended before all vertex records")
                values = dict(zip((name for name, _type in properties), unpack.unpack(raw)))
                position = (float(values["x"]), float(values["y"]), float(values["z"]))
                scale = tuple(math.exp(float(values[f"scale_{index}"])) for index in range(3))
                color = tuple(_byte(0.5 + _SH_C0 * float(values[f"f_dc_{index}"])) for index in range(3))
                alpha = _byte(_sigmoid(float(values["opacity"])))
                quaternion = [float(values[f"rot_{index}"]) for index in range(4)]
                magnitude = math.sqrt(sum(component * component for component in quaternion))
                if magnitude == 0:
                    quaternion = [1.0, 0.0, 0.0, 0.0]
                else:
                    quaternion = [component / magnitude for component in quaternion]
                rotation = tuple(max(0, min(255, int(component * 128 + 128))) for component in quaternion)
                output_file.write(struct.pack("<3f3f4B4B", *position, *scale, *color, alpha, *rotation))
    return vertex_count


class ColmapOpenSplatBackend(PipelineBackend):
    """Run COLMAP SfM followed by OpenSplat training."""

    def __init__(self) -> None:
        self._registration_stats: dict[str, int] = {"input_images": 0, "registered_images": 0}

    @staticmethod
    def _require(executable: str) -> None:
        if shutil.which(executable) is None:
            package = "COLMAP >= 3.8" if executable == "colmap" else "OpenSplat"
            raise NotInstalledError(
                f"{executable!r} is not installed or not on PATH. Install {package}, "
                "or set PIPELINE_BACKEND=fake for local development."
            )

    @staticmethod
    def _gpu_enabled(job: JobContext) -> bool:
        value = job.params.get(
            "sift_use_gpu",
            job.params.get("use_gpu", os.environ.get("COLMAP_SIFT_USE_GPU", "0")),
        )
        return str(value).strip().lower() in {"1", "true", "yes", "on"}

    def _run(
        self, command: list[str], stage: str, start: float, end: float,
        progress: ProgressCallback, phase: str, parser: Callable[[str], float | None] | None = None,
    ) -> None:
        """Stream a command, retaining only useful tail diagnostics."""
        progress(stage, start, phase)
        recent: deque[str] = deque(maxlen=30)
        try:
            process = subprocess.Popen(
                command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace", bufsize=1,
            )
        except OSError as exc:
            raise RuntimeError(f"Could not start {command[0]!r}: {exc}") from exc
        assert process.stdout is not None
        for raw_line in process.stdout:
            line = raw_line.rstrip()
            if line:
                recent.append(line)
                fraction = parser(line) if parser else None
                if fraction is not None:
                    progress(stage, start + (end - start) * max(0.0, min(1.0, fraction)), line)
        return_code = process.wait()
        if return_code:
            tail = "\n".join(recent) or "(no command output)"
            raise RuntimeError(f"{phase} failed (exit {return_code}). Last COLMAP/OpenSplat output:\n{tail}")
        progress(stage, end, f"{phase} complete")

    @staticmethod
    def _processed_fraction(line: str) -> float | None:
        match = re.search(r"Processed file\s*\[\s*(\d+)\s*/\s*(\d+)\s*\]", line, re.I)
        if match and int(match.group(2)):
            return int(match.group(1)) / int(match.group(2))
        return None

    def ingest(self, job: JobContext, progress: ProgressCallback) -> None:
        progress("ingest", 0.0, "validating input images")
        image_dir = job.work_dir / "images"
        image_dir.mkdir(parents=True, exist_ok=True)
        usable = [path for path in sorted(job.input_dir.iterdir()) if path.is_file() and path.suffix.lower() in _IMAGE_EXTENSIONS and path.stat().st_size > 0]
        if len(usable) < 3:
            raise ValueError(f"Need at least 3 usable images; found {len(usable)} supported non-empty images in {job.input_dir}")
        for index, source in enumerate(usable, start=1):
            # Prefix prevents same-name uploads overwriting one another while preserving format.
            shutil.copy2(source, image_dir / f"{index:04d}_{source.name}")
            progress("ingest", index / len(usable), f"prepared image {index}/{len(usable)}")
        self._registration_stats = {"input_images": len(usable), "registered_images": 0}

    def run_sfm(self, job: JobContext, progress: ProgressCallback) -> None:
        self._require("colmap")
        database = job.work_dir / "database.db"
        images = job.work_dir / "images"
        sparse_root = job.work_dir / "sparse"
        sparse_root.mkdir(parents=True, exist_ok=True)
        self._run(["colmap", "feature_extractor", "--database_path", str(database), "--image_path", str(images), "--SiftExtraction.use_gpu", "1" if self._gpu_enabled(job) else "0"], "sfm", 0.0, 0.3, progress, "extracting COLMAP features", self._processed_fraction)
        matcher = "sequential_matcher" if job.params.get("matcher") == "sequential" else "exhaustive_matcher"
        self._run(["colmap", matcher, "--database_path", str(database)], "sfm", 0.3, 0.6, progress, "matching COLMAP features", self._processed_fraction)
        self._run(["colmap", "mapper", "--database_path", str(database), "--image_path", str(images), "--output_path", str(sparse_root)], "sfm", 0.6, 0.95, progress, "mapping COLMAP cameras", self._processed_fraction)
        models = sorted(path for path in sparse_root.iterdir() if path.is_dir())
        if not models:
            raise RuntimeError("COLMAP mapper produced no sparse model. Try more photos with stronger overlap and texture.")
        model = models[0]
        text_model = job.work_dir / "sparse_txt"
        self._run(["colmap", "model_converter", "--input_path", str(model), "--output_path", str(text_model), "--output_type", "TXT"], "sfm", 0.95, 1.0, progress, "converting sparse model to text")
        images_txt = text_model / "images.txt"
        if not images_txt.exists():
            raise RuntimeError("COLMAP model conversion did not produce images.txt; unable to inspect registration results.")
        def is_image_record(line: str) -> bool:
            fields = line.split()
            if len(fields) < 10:
                return False
            try:
                int(fields[0])
                [float(value) for value in fields[1:9]]
            except ValueError:
                return False
            # The following 2D-point line is a sequence of numeric triples;
            # image records instead have a filename in this position.
            return bool(Path(fields[9]).suffix)

        registered = sum(
            1 for line in images_txt.read_text(encoding="utf-8", errors="replace").splitlines()
            if line and not line.startswith("#") and is_image_record(line)
        )
        self._registration_stats["registered_images"] = registered
        total = self._registration_stats["input_images"]
        if total and registered / total < 0.6:
            progress("sfm", 1.0, f"warning: only {registered}/{total} photos registered - add more overlapping shots")

    def train(self, job: JobContext, progress: ProgressCallback) -> None:
        self._require("opensplat")
        iterations = int(job.params.get("iterations", 7000))
        if iterations <= 0:
            raise ValueError("iterations must be a positive integer")
        output = job.work_dir / "splat.ply"
        def step_fraction(line: str) -> float | None:
            match = re.search(r"(?:step|iter(?:ation)?)?\s*(\d+)\s*(?:/|of)\s*(\d+)", line, re.I)
            if match:
                return int(match.group(1)) / max(1, int(match.group(2)))
            match = re.search(r"(?:step|iter(?:ation)?)\s+(\d+)\b", line, re.I)
            return int(match.group(1)) / iterations if match else None
        self._run(["opensplat", str(job.work_dir), "-n", str(iterations), "-o", str(output)], "train", 0.0, 1.0, progress, "training OpenSplat model", step_fraction)
        if not output.is_file() or output.stat().st_size == 0:
            raise RuntimeError("OpenSplat completed without producing work_dir/splat.ply")

    def compress(self, job: JobContext, progress: ProgressCallback) -> None:
        source = job.work_dir / "splat.ply"
        if not source.is_file():
            raise RuntimeError("Cannot compress: OpenSplat output work_dir/splat.ply is missing")
        job.output_dir.mkdir(parents=True, exist_ok=True)
        destination_ply = job.output_dir / "output.ply"
        shutil.copy2(source, destination_ply)
        progress("compress", 0.25, "copied OpenSplat PLY")
        try:
            count = ply_to_splat(source, job.output_dir / "scene.splat")
        except (OSError, ValueError, struct.error, OverflowError) as exc:
            progress("compress", 1.0, f"PLY retained; scene.splat unavailable: {exc}")
            return
        progress("compress", 1.0, f"converted {count} splats to scene.splat (PLY order retained)")

    def publish(self, job: JobContext, progress: ProgressCallback) -> None:
        progress("publish", 0.0, "writing artifact manifest")
        artifacts = []
        for name, output_format in (("output.ply", "ply"), ("scene.splat", "splat")):
            path = job.output_dir / name
            if path.is_file():
                artifacts.append({"filename": name, "bytes": path.stat().st_size, "format": output_format})
        if not artifacts:
            raise RuntimeError("No output artifacts were available to publish")
        manifest = {"artifacts": artifacts, "registration": self._registration_stats}
        (job.output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        progress("publish", 1.0, "published scene artifacts")
