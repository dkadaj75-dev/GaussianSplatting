from __future__ import annotations

import json
import sys
import types
from pathlib import Path

import pytest

from worker.backends import ColmapOpenSplatBackend
from worker.backends.base import JobContext
from worker.calibration import (
    detect_markers,
    map_marker_corners_to_3d,
    parse_colmap_text_model,
    solve_scale_from_observations,
)


def marker(points):
    return {"points_3d": points}


def test_scale_solver_exact_square():
    result = solve_scale_from_observations([marker([(0, 0, 0), (2, 0, 0), (2, 2, 0), (0, 2, 0)])] * 2, 0.5)
    assert result == {"scale": 0.25, "residual": 0.0, "sample_count": 8}


def test_scale_solver_median_rejects_outlier_marker():
    good = marker([(0, 0, 0), (2, 0, 0), (2, 2, 0), (0, 2, 0)])
    outlier = marker([(0, 0, 0), (20, 0, 0), (20, 20, 0), (0, 20, 0)])
    result = solve_scale_from_observations([good, good, outlier], 1.0)
    assert result["scale"] == pytest.approx(0.5)
    assert result["residual"] == 0.0
    assert result["sample_count"] == 12


def test_scale_solver_reports_insufficient_and_degenerate_samples():
    insufficient = solve_scale_from_observations([marker([(0, 0, 0)] * 4)], 1.0)
    assert insufficient["scale"] is None
    assert "fewer than 6" in insufficient["reason"]
    degenerate = solve_scale_from_observations([marker([(0, 0, 0)] * 4)] * 2, 1.0)
    assert degenerate["scale"] is None
    assert "non-zero" in degenerate["reason"]


def test_colmap_parser_and_corner_mapping(tmp_path):
    (tmp_path / "points3D.txt").write_text("# points\n1 1 2 3 1 0 0 1 0\n2 4 5 6 1 0 0 1 1\n")
    (tmp_path / "images.txt").write_text(
        "# images\n1 1 0 0 0 0 0 0 1 photo.jpg\n10 10 1 100 100 -1 20 20 2\n"
    )
    model = parse_colmap_text_model(tmp_path)
    mapped = map_marker_corners_to_3d(
        {"marker_id": 7, "corners": [[11, 10], [20, 20], [75, 75], [100, 100]]}, "photo.jpg", model, pixel_radius=3
    )
    assert mapped["points_3d"] == [(1.0, 2.0, 3.0), (4.0, 5.0, 6.0), None, None]


def _job(tmp_path, params):
    input_dir, work_dir, output_dir = tmp_path / "input", tmp_path / "work", tmp_path / "output"
    input_dir.mkdir()
    work_dir.mkdir(); output_dir.mkdir()
    image = work_dir / "images" / "photo.jpg"; image.parent.mkdir(); image.write_bytes(b"image")
    (output_dir / "output.ply").write_text("ply\n")
    return JobContext("job", "project", input_dir, work_dir, output_dir, params)


def test_backend_manifest_has_null_calibration_without_marker_params(tmp_path):
    backend = ColmapOpenSplatBackend()
    backend.publish(_job(tmp_path, {}), lambda *_: None)
    assert json.loads((tmp_path / "output" / "manifest.json").read_text())["calibration"] is None


def test_backend_calibration_is_published_and_detector_failure_is_nonfatal(tmp_path, monkeypatch):
    # _run_auto_calibration checks import availability separately; a tiny module
    # keeps this integration test independent of an installed OpenCV wheel.
    monkeypatch.setitem(sys.modules, "cv2", types.ModuleType("cv2"))
    monkeypatch.setattr("worker.backends.real.parse_colmap_text_model", lambda _path: {
        "images": {"photo.jpg": [(0, 0, 1), (2, 0, 2), (2, 2, 3), (0, 2, 4)]},
        "points3d": {1: (0, 0, 0), 2: (2, 0, 0), 3: (2, 2, 0), 4: (0, 2, 0)},
    })
    monkeypatch.setattr("worker.backends.real.detect_markers", lambda *_args: [{"marker_id": 7, "corners": [[0, 0], [2, 0], [2, 2], [0, 2]]}] * 2)
    job = _job(tmp_path, {"marker_length_m": 1.0})
    messages = []
    backend = ColmapOpenSplatBackend()
    backend._run_auto_calibration(job, tmp_path, lambda *_event: messages.append(_event[2]))
    backend.publish(job, lambda *_: None)
    calibration = json.loads((tmp_path / "output" / "manifest.json").read_text())["calibration"]
    assert calibration["scale"] == pytest.approx(0.5)
    assert calibration["marker_dictionary"] == "DICT_4X4_50"
    assert any("auto-calibration:" in message for message in messages)

    monkeypatch.setattr("worker.backends.real.detect_markers", lambda *_args: (_ for _ in ()).throw(RuntimeError("bad detector")))
    backend._run_auto_calibration(job, tmp_path, lambda *_: None)
    backend.publish(job, lambda *_: None)
    assert json.loads((tmp_path / "output" / "manifest.json").read_text())["calibration"] is None


def test_detect_markers_against_real_opencv(tmp_path):
    """Exercise the actual cv2.aruco API, which the tests above monkeypatch.

    OpenCV moved marker detection from a free function to ``ArucoDetector``;
    detect_markers picks whichever the installed build exposes, so this is the
    only test that would catch that selection going wrong.
    """
    cv2 = pytest.importorskip("cv2")
    numpy = pytest.importorskip("numpy")

    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    canvas = numpy.full((500, 500), 255, numpy.uint8)
    canvas[100:400, 100:400] = cv2.aruco.generateImageMarker(dictionary, 7, 300)
    image_path = tmp_path / "marker.png"
    cv2.imwrite(str(image_path), canvas)

    detections = detect_markers(image_path, "DICT_4X4_50")
    assert len(detections) == 1
    assert detections[0]["marker_id"] == 7
    corners = detections[0]["corners"]
    assert len(corners) == 4
    # The marker occupies a known square, so corners must land on its outline.
    for x, y in corners:
        assert x == pytest.approx(100, abs=3) or x == pytest.approx(399, abs=3)
        assert y == pytest.approx(100, abs=3) or y == pytest.approx(399, abs=3)


def test_detect_markers_degrades_quietly(tmp_path):
    """A bad dictionary or unreadable image must never raise into the pipeline."""
    pytest.importorskip("cv2")
    missing = tmp_path / "nope.png"
    assert detect_markers(missing, "DICT_4X4_50") == []

    unreadable = tmp_path / "not-an-image.png"
    unreadable.write_bytes(b"definitely not a PNG")
    assert detect_markers(unreadable, "DICT_4X4_50") == []
    assert detect_markers(unreadable, "NOT_A_REAL_DICTIONARY") == []
