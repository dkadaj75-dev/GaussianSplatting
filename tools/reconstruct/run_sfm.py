"""Reconstruct a photo set with COLMAP's SfM (via pycolmap) on CPU."""

from __future__ import annotations

import shutil
import sys
import time
from pathlib import Path

import pycolmap

photos = Path(sys.argv[1] if len(sys.argv) > 1 else "photos")
work = Path(sys.argv[2] if len(sys.argv) > 2 else "sfm_work")
if work.exists():
    shutil.rmtree(work)
work.mkdir(parents=True)

database = work / "database.db"
started = time.time()

print("1/3 extracting features…", flush=True)
pycolmap.extract_features(database, photos)

print("2/3 matching…", flush=True)
pycolmap.match_exhaustive(database)

print("3/3 mapping…", flush=True)
maps = pycolmap.incremental_mapping(database, photos, work / "sparse")

if not maps:
    print("RESULT: no model reconstructed")
    raise SystemExit(1)

model = maps[0]
elapsed = time.time() - started
n_photos = len(list(photos.glob("*.jpg"))) + len(list(photos.glob("*.png")))
print(f"RESULT registered {model.num_reg_images()}/{n_photos} images")
print(f"RESULT points3D {model.num_points3D()}")
print(f"RESULT elapsed {elapsed:.1f}s")

(work / "sparse_model").mkdir(parents=True, exist_ok=True)
model.write(work / "sparse_model")
print(f"RESULT model written to {work / 'sparse_model'}")
