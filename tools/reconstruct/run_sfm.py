"""Reconstruct a photo set with COLMAP's SfM (via pycolmap) on CPU.

Defaults are tuned for constrained environments — a WSL VM sharing a laptop's
RAM with Docker, or a small cloud box. Full-resolution SIFT across every CPU
thread can eat gigabytes per thread on 12 MP phone photos and get the process
OOM-killed ("Killed" with no traceback); capping image size and thread count
costs a little registration quality and buys back most of the memory.
"""

from __future__ import annotations

import argparse
import shutil
import time
from pathlib import Path

import pycolmap

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("photos", type=Path, help="folder of .jpg/.png photos")
parser.add_argument("work", type=Path, nargs="?", default=Path("sfm_work"))
parser.add_argument(
    "--max-image-size",
    type=int,
    default=1600,
    help="downscale longest image side before feature extraction "
    "(default 1600; raise to 3200 on a machine with plenty of RAM)",
)
parser.add_argument(
    "--threads",
    type=int,
    default=2,
    help="extraction/matching threads (default 2; each thread costs RAM)",
)
parser.add_argument(
    "--sequential",
    action="store_true",
    help="match consecutive photos only — faster for orbit/walk captures",
)
args = parser.parse_args()

if not args.photos.is_dir():
    raise SystemExit(f"photo folder does not exist: {args.photos}")

if args.work.exists():
    shutil.rmtree(args.work)
args.work.mkdir(parents=True)

database = args.work / "database.db"
started = time.time()

extraction = pycolmap.FeatureExtractionOptions()
extraction.max_image_size = args.max_image_size
extraction.num_threads = args.threads

print(
    f"1/3 extracting features… (max image size {args.max_image_size}, "
    f"{args.threads} threads)",
    flush=True,
)
pycolmap.extract_features(database, args.photos, extraction_options=extraction)

matching = pycolmap.FeatureMatchingOptions()
matching.num_threads = args.threads

if args.sequential:
    print("2/3 matching (sequential)…", flush=True)
    pycolmap.match_sequential(database, matching_options=matching)
else:
    print("2/3 matching…", flush=True)
    pycolmap.match_exhaustive(database, matching_options=matching)

print("3/3 mapping…", flush=True)
maps = pycolmap.incremental_mapping(database, args.photos, args.work / "sparse")

if not maps:
    print("RESULT: no model reconstructed — add more overlapping photos")
    raise SystemExit(1)

model = maps[0]
elapsed = time.time() - started
extensions = ("*.jpg", "*.jpeg", "*.png", "*.JPG", "*.JPEG", "*.PNG")
n_photos = sum(len(list(args.photos.glob(pattern))) for pattern in extensions)
print(f"RESULT registered {model.num_reg_images()}/{n_photos} images")
print(f"RESULT points3D {model.num_points3D()}")
print(f"RESULT elapsed {elapsed:.1f}s")

(args.work / "sparse_model").mkdir(parents=True, exist_ok=True)
model.write(args.work / "sparse_model")
print(f"RESULT model written to {args.work / 'sparse_model'}")
