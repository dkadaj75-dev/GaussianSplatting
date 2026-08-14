from __future__ import annotations

import json
import os
import stat
import struct
from pathlib import Path

import pytest

from worker.backends import ColmapOpenSplatBackend, JobContext, NotInstalledError
from worker.backends.real import _SH_C0, ply_to_splat


def write_ply(path: Path, rows: list[tuple[float, ...]]) -> None:
    names = ["x", "y", "z", "scale_0", "scale_1", "scale_2", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "rot_0", "rot_1", "rot_2", "rot_3"]
    header = "ply\nformat binary_little_endian 1.0\nelement vertex %d\n%s\nend_header\n" % (len(rows), "\n".join(f"property float {name}" for name in names))
    path.write_bytes(header.encode("ascii") + b"".join(struct.pack("<14f", *row) for row in rows))


def make_context(tmp_path: Path, *, image_count: int = 3, params: dict | None = None) -> JobContext:
    input_dir, work_dir, output_dir = tmp_path / "input", tmp_path / "work", tmp_path / "output"
    input_dir.mkdir()
    for number in range(image_count):
        (input_dir / f"photo-{number}.jpg").write_bytes(b"image")
    return JobContext("job", "project", input_dir, work_dir, output_dir, params or {})


@pytest.fixture
def stub_tools(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fixture_ply = tmp_path / "trained.ply"
    write_ply(fixture_ply, [(1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0)])
    colmap = bin_dir / "colmap"
    colmap.write_text(
        "#!/bin/sh\n"
        "case \"$1\" in\n"
        "feature_extractor) echo 'Processed file [3/3]' ;;\n"
        "exhaustive_matcher|sequential_matcher) echo 'matching complete' ;;\n"
        "mapper) [ \"${STUB_NO_MODEL:-0}\" = 1 ] || { out=''; shift; while [ $# -gt 0 ]; do [ \"$1\" = --output_path ] && { shift; out=$1; break; }; shift; done; mkdir -p \"$out/0\"; }; ;;\n"
        "model_converter) out=''; shift; while [ $# -gt 0 ]; do [ \"$1\" = --output_path ] && { shift; out=$1; break; }; shift; done; mkdir -p \"$out\"; printf '%s\\n' '# Image list' \"${STUB_IMAGES_LINE:-1 0 0 0 1 0 0 0 1 photo.jpg}\" > \"$out/images.txt\" ;;\n"
        "esac\n",
        encoding="utf-8",
    )
    opensplat = bin_dir / "opensplat"
    opensplat.write_text(
        "#!/bin/sh\necho 'Step 1: loss=1.0'\nout=''; while [ $# -gt 0 ]; do [ \"$1\" = -o ] && { shift; out=$1; break; }; shift; done\ncp \"$STUB_PLY\" \"$out\"\n",
        encoding="utf-8",
    )
    for script in (colmap, opensplat):
        script.chmod(script.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv("PATH", str(bin_dir) + os.pathsep + os.environ.get("PATH", ""))
    monkeypatch.setenv("STUB_PLY", str(fixture_ply))
    return bin_dir


def test_real_pipeline_success_emits_monotonic_progress_and_manifest(tmp_path, stub_tools):
    job = make_context(tmp_path, params={"iterations": 10})
    events = []
    backend = ColmapOpenSplatBackend()
    for operation in (backend.ingest, backend.run_sfm, backend.train, backend.compress, backend.publish):
        operation(job, lambda stage, value, message: events.append((stage, value, message)))
    assert [event[0] for event in events] == sorted((event[0] for event in events), key=("ingest", "sfm", "train", "compress", "publish").index)
    for stage in ("ingest", "sfm", "train", "compress", "publish"):
        values = [value for event_stage, value, _ in events if event_stage == stage]
        assert values == sorted(values)
    manifest = json.loads((job.output_dir / "manifest.json").read_text())
    assert manifest["registration"] == {"input_images": 3, "registered_images": 1}
    assert {item["filename"] for item in manifest["artifacts"]} == {"output.ply", "scene.splat"}


def test_low_registration_emits_capture_warning(tmp_path, stub_tools):
    job = make_context(tmp_path, image_count=4)
    events = []
    backend = ColmapOpenSplatBackend()
    backend.ingest(job, lambda *event: events.append(event))
    backend.run_sfm(job, lambda *event: events.append(event))
    assert any("only 1/4 photos registered" in message for _stage, _progress, message in events)


def test_missing_colmap_has_actionable_error(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", "")
    with pytest.raises(NotInstalledError, match="Install COLMAP >= 3.8.*PIPELINE_BACKEND=fake"):
        ColmapOpenSplatBackend().run_sfm(make_context(tmp_path), lambda *_: None)


def test_mapper_without_model_has_clear_error(tmp_path, stub_tools, monkeypatch):
    monkeypatch.setenv("STUB_NO_MODEL", "1")
    job = make_context(tmp_path)
    backend = ColmapOpenSplatBackend()
    backend.ingest(job, lambda *_: None)
    with pytest.raises(RuntimeError, match="produced no sparse model.*overlap"):
        backend.run_sfm(job, lambda *_: None)


def test_ply_to_splat_writes_two_exact_records(tmp_path):
    source, destination = tmp_path / "source.ply", tmp_path / "scene.splat"
    # The second quaternion exercises normalization before its byte encoding.
    write_ply(source, [(1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0), (4, 5, 6, 0.6931471805599453, 0, 0, 1 / _SH_C0, 0, 0, 100, 0, 2, 0, 0)])
    assert ply_to_splat(source, destination) == 2
    raw = destination.read_bytes()
    assert len(raw) == 64
    first = struct.unpack("<3f3f4B4B", raw[:32])
    second = struct.unpack("<3f3f4B4B", raw[32:])
    assert first[:6] == pytest.approx((1, 2, 3, 1, 1, 1))
    assert first[6:10] == (128, 128, 128, 128)
    assert first[10:] == (255, 128, 128, 128)
    assert second[:6] == pytest.approx((4, 5, 6, 2, 1, 1))
    assert second[6:10] == (255, 128, 128, 255)
    assert second[10:] == (128, 255, 128, 128)
