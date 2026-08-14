"""Convert a COLMAP sparse model into the worker's 32-byte .splat records.

This is the same layout `worker/worker/backends/real.py::ply_to_splat` writes,
so the output loads in the app's own viewer unchanged.
"""
from __future__ import annotations
import struct, sys
from pathlib import Path
import numpy as np
import pycolmap

model_dir, out_path = Path(sys.argv[1]), Path(sys.argv[2])
model = pycolmap.Reconstruction(model_dir)

xyz, rgb = [], []
for point in model.points3D.values():
    # Drop poorly-triangulated points: they are the noise that makes a sparse
    # cloud look like static rather than a surface.
    if point.error > 3.0 or point.track.length() < 3:
        continue
    xyz.append(point.xyz)
    rgb.append(point.color)

xyz = np.asarray(xyz, dtype=np.float64)
rgb = np.asarray(rgb, dtype=np.uint8)
if len(xyz) == 0:
    raise SystemExit("no usable points")

centre = np.median(xyz, axis=0)
xyz -= centre
# Normalise so the scene sits at a predictable size for the viewer; the real
# pipeline keeps SfM units and relies on calibration instead.
radius = float(np.percentile(np.linalg.norm(xyz, axis=1), 90)) or 1.0
xyz /= radius

# Splat radius from local point spacing, so sparser regions get larger blobs
# and the cloud reads as a surface rather than as dots.
from scipy.spatial import cKDTree  # noqa: E402
tree = cKDTree(xyz)
dists, _ = tree.query(xyz, k=min(9, len(xyz)))
spacing = np.median(dists[:, 1:], axis=1)
scales = np.clip(spacing * 0.5, 0.002, 0.016)

with out_path.open("wb") as fh:
    for position, colour, scale in zip(xyz, rgb, scales):
        fh.write(
            struct.pack(
                "<3f3f4B4B",
                *position.astype(np.float32),
                scale, scale, scale,
                int(colour[0]), int(colour[1]), int(colour[2]), 235,
                255, 128, 128, 128,
            )
        )
print(f"RESULT splats {len(xyz)} -> {out_path} ({out_path.stat().st_size/1024:.0f} kB)")
