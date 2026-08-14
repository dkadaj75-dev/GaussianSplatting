"""Optional ArUco scale calibration helpers.

OpenCV is intentionally imported only by :func:`detect_markers`: all model
parsing and scale solving remains usable in minimal worker installations.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Iterable


DEFAULT_DICTIONARY = "DICT_4X4_50"


def _result(*, scale: float | None, residual: float | None, sample_count: int, reason: str | None = None) -> dict[str, Any]:
    value: dict[str, Any] = {"scale": scale, "residual": residual, "sample_count": sample_count}
    if reason:
        value["reason"] = reason
    return value


def detect_markers(image_path: str | Path, dictionary_name: str = DEFAULT_DICTIONARY) -> list[dict[str, Any]]:
    """Return detected ArUco markers, or an empty list when OpenCV is absent.

    Invalid input and unavailable dictionaries are treated as no detections so
    automatic calibration can never make the reconstruction fail.
    """
    try:
        import cv2  # type: ignore[import-not-found]
    except ImportError:
        return []
    aruco = getattr(cv2, "aruco", None)
    dictionary_id = getattr(aruco, dictionary_name, None) if aruco is not None else None
    if dictionary_id is None:
        return []
    image = cv2.imread(str(image_path))
    if image is None:
        return []
    try:
        dictionary = aruco.getPredefinedDictionary(dictionary_id)
        parameters = aruco.DetectorParameters()
        if hasattr(aruco, "ArucoDetector"):
            corners, ids, _rejected = aruco.ArucoDetector(dictionary, parameters).detectMarkers(image)
        else:
            corners, ids, _rejected = aruco.detectMarkers(image, dictionary, parameters=parameters)
    except (AttributeError, TypeError, ValueError):
        return []
    if ids is None:
        return []
    return [
        {"marker_id": int(marker_id), "corners": [[float(x), float(y)] for x, y in corner.reshape(4, 2)]}
        for marker_id, corner in zip(ids.reshape(-1), corners)
    ]


def _point(value: Any) -> tuple[float, float, float] | None:
    try:
        if value is None or len(value) != 3:
            return None
        point = tuple(float(component) for component in value)
    except (TypeError, ValueError):
        return None
    return point if all(math.isfinite(component) for component in point) else None


def solve_scale_from_observations(observations: Iterable[dict[str, Any]], marker_length_m: float) -> dict[str, Any]:
    """Estimate meters-per-scene-unit from mapped ArUco corners.

    Each observation is a marker dictionary containing ``points_3d`` (or the
    alias ``corners_3d``), a four-item sequence aligned to the detected marker
    corners.  The median across marker edge estimates makes the result robust
    to an occasional bad reconstructed marker.
    """
    try:
        marker_length = float(marker_length_m)
    except (TypeError, ValueError):
        return _result(scale=None, residual=None, sample_count=0, reason="marker length must be a positive number")
    if not math.isfinite(marker_length) or marker_length <= 0:
        return _result(scale=None, residual=None, sample_count=0, reason="marker length must be a positive number")

    # The public helper accepts both the grouped form produced by
    # ``map_marker_corners_to_3d`` and a flat, one-dictionary-per-corner form.
    # The latter is convenient for callers that construct correspondences while
    # iterating detector output.
    grouped: list[dict[str, Any]] = []
    flat: dict[tuple[Any, Any], list[Any]] = {}
    for observation in observations:
        if not isinstance(observation, dict):
            continue
        if "points_3d" in observation or "corners_3d" in observation:
            grouped.append(observation)
            continue
        if "point_3d" in observation and "corner_index" in observation:
            key = (observation.get("image_name", observation.get("image_id")), observation.get("marker_id"))
            corners = flat.setdefault(key, [None, None, None, None])
            try:
                corner_index = int(observation["corner_index"])
            except (TypeError, ValueError):
                continue
            if 0 <= corner_index < 4:
                corners[corner_index] = observation["point_3d"]
    grouped.extend({"points_3d": points} for points in flat.values())

    usable_corners = 0
    scales: list[float] = []
    for observation in grouped:
        raw_points = observation.get("points_3d", observation.get("corners_3d", [])) if isinstance(observation, dict) else []
        points = [_point(point) for point in raw_points] if isinstance(raw_points, (list, tuple)) else []
        usable_corners += sum(point is not None for point in points)
        if len(points) != 4 or any(point is None for point in points):
            continue
        quad = [point for point in points if point is not None]
        lengths = [math.dist(quad[index], quad[(index + 1) % 4]) for index in range(4)]
        edge = _median(lengths)
        if edge > 0 and math.isfinite(edge):
            scales.append(marker_length / edge)
    if usable_corners < 6:
        return _result(scale=None, residual=None, sample_count=usable_corners, reason="fewer than 6 marker corners mapped to sparse points")
    if not scales:
        return _result(scale=None, residual=None, sample_count=usable_corners, reason="no complete marker with non-zero reconstructed edges")
    scale = _median(scales)
    mad = _median([abs(value - scale) for value in scales])
    # A dimensionless normalized MAD is convenient for the UI as a percentage.
    residual = mad / scale if scale else None
    return _result(scale=scale, residual=residual, sample_count=usable_corners)


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    middle = len(ordered) // 2
    return ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2


def parse_colmap_text_model(model_dir: str | Path) -> dict[str, Any]:
    """Parse enough of COLMAP's TXT model to associate image keypoints to 3D."""
    directory = Path(model_dir)
    images_path, points_path = directory / "images.txt", directory / "points3D.txt"
    if not images_path.is_file() or not points_path.is_file():
        return {"images": {}, "points3d": {}, "reason": "COLMAP images.txt or points3D.txt is missing"}
    points3d: dict[int, tuple[float, float, float]] = {}
    images: dict[str, list[tuple[float, float, int]]] = {}
    try:
        for line in points_path.read_text(encoding="utf-8", errors="replace").splitlines():
            fields = line.split()
            if not fields or fields[0].startswith("#") or len(fields) < 4:
                continue
            try:
                point_id = int(fields[0]); xyz = tuple(float(value) for value in fields[1:4])
            except ValueError:
                continue
            if all(math.isfinite(value) for value in xyz):
                points3d[point_id] = xyz  # type: ignore[assignment]
        lines = images_path.read_text(encoding="utf-8", errors="replace").splitlines()
        index = 0
        while index < len(lines):
            header = lines[index].strip(); index += 1
            if not header or header.startswith("#"):
                continue
            fields = header.split()
            if len(fields) < 10:
                continue
            try:
                int(fields[0]); [float(value) for value in fields[1:9]]
            except ValueError:
                continue
            name = fields[9]
            point_line = lines[index].strip() if index < len(lines) else ""
            index += 1
            keypoints: list[tuple[float, float, int]] = []
            values = point_line.split()
            for offset in range(0, len(values) - 2, 3):
                try:
                    keypoints.append((float(values[offset]), float(values[offset + 1]), int(values[offset + 2])))
                except ValueError:
                    continue
            images[name] = keypoints
    except OSError as exc:
        return {"images": {}, "points3d": {}, "reason": f"could not read COLMAP TXT model: {exc}"}
    return {"images": images, "points3d": points3d}


def map_marker_corners_to_3d(detection: dict[str, Any], image_name: str, model: dict[str, Any], pixel_radius: float = 12.0) -> dict[str, Any]:
    """Attach nearest valid sparse points to one marker detection's corners."""
    mapped = dict(detection)
    mapped["image_name"] = image_name
    try:
        radius_squared = float(pixel_radius) ** 2
    except (TypeError, ValueError):
        radius_squared = 12.0 ** 2
    keypoints = model.get("images", {}).get(image_name, [])
    points3d = model.get("points3d", {})
    result: list[tuple[float, float, float] | None] = []
    for corner in detection.get("corners", []):
        try:
            x, y = float(corner[0]), float(corner[1])
        except (TypeError, ValueError, IndexError):
            result.append(None); continue
        nearest: tuple[float, float, float] | None = None
        distance = radius_squared
        for key_x, key_y, point_id in keypoints:
            point = points3d.get(point_id)
            candidate_distance = (key_x - x) ** 2 + (key_y - y) ** 2
            if point is not None and candidate_distance <= distance:
                nearest, distance = point, candidate_distance
        result.append(nearest)
    mapped["points_3d"] = result
    return mapped
