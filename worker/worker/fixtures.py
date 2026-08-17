"""Procedural placeholder scene for the fake backend.

The fake pipeline exists so the whole stack can be exercised without COLMAP or
a GPU — which only works if the artifact it publishes actually loads in the
viewer. A zero-byte file fails there with a misleading loader error, so the
fake backend publishes this small deterministic scene instead: a checkered
floor, a box and a sphere, in both delivery formats.

Both writers emit the exact layouts the real pipeline produces: the 32-byte
``.splat`` record (`<3f 3f 4B 4B`) and the binary 3DGS PLY that
:func:`worker.backends.real.ply_to_splat` consumes — so the fake artifacts are
also fixtures for the real converter.
"""

from __future__ import annotations

import math
import struct
from pathlib import Path

_SH_C0 = 0.28209479177387814

# (x, y, z), (sx, sy, sz), (r, g, b), alpha  — scene units, bytes for colour.
Record = tuple[tuple[float, float, float], tuple[float, float, float], tuple[int, int, int], int]


def _lcg(seed: int):
    state = seed & 0xFFFFFFFF
    while True:
        state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
        yield state / 0x100000000


def placeholder_records(seed: int = 20260814) -> list[Record]:
    """A recognisable little scene: checkered floor, blue box, orange sphere."""
    random = _lcg(seed)
    records: list[Record] = []

    def jitter(amount: float) -> float:
        return (next(random) - 0.5) * 2 * amount

    # Floor: 40x40 checker tiles.
    for ix in range(40):
        for iz in range(40):
            dark = (ix + iz) % 2 == 0
            base = 96 if dark else 168
            records.append(
                (
                    (ix * 0.05 - 1.0 + jitter(0.004), -0.3 + jitter(0.003), iz * 0.05 - 1.0 + jitter(0.004)),
                    (0.022, 0.008, 0.022),
                    (base, base, base + 6),
                    235,
                )
            )

    # Box: surface shells of a 0.5-unit cube left of centre.
    steps = 14
    for ix in range(steps):
        for iy in range(steps):
            for iz in range(steps):
                on_surface = 0 in (ix, iy, iz) or steps - 1 in (ix, iy, iz)
                if not on_surface:
                    continue
                shade = 1 + jitter(0.15)
                records.append(
                    (
                        (-0.45 + ix * 0.5 / (steps - 1), -0.3 + iy * 0.5 / (steps - 1), -0.25 + iz * 0.5 / (steps - 1)),
                        (0.016, 0.016, 0.016),
                        (
                            max(0, min(255, round(106 * shade))),
                            max(0, min(255, round(134 * shade))),
                            max(0, min(255, round(182 * shade))),
                        ),
                        240,
                    )
                )

    # Sphere: Fibonacci shell right of centre.
    count = 1400
    for index in range(count):
        y = 1 - (index / (count - 1)) * 2
        ring = math.sqrt(max(0.0, 1 - y * y))
        theta = index * 2.399963229728653
        shade = 1 + jitter(0.12)
        records.append(
            (
                (0.45 + math.cos(theta) * ring * 0.22, 0.02 + y * 0.22, math.sin(theta) * ring * 0.22),
                (0.014, 0.014, 0.014),
                (
                    max(0, min(255, round(224 * shade))),
                    max(0, min(255, round(138 * shade))),
                    max(0, min(255, round(74 * shade))),
                ),
                242,
            )
        )

    return records


def write_splat(path: Path, records: list[Record]) -> int:
    """Write the 32-byte-per-splat ``.splat`` layout (identity rotations)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as fh:
        for position, scale, colour, alpha in records:
            fh.write(struct.pack("<3f3f4B4B", *position, *scale, *colour, alpha, 255, 128, 128, 128))
    return len(records)


def _logit(value: float) -> float:
    clamped = min(max(value, 1e-4), 1 - 1e-4)
    return math.log(clamped / (1 - clamped))


def write_3dgs_ply(path: Path, records: list[Record]) -> int:
    """Write a binary 3DGS PLY carrying the same scene.

    Inverse of the real converter's mapping: bytes → SH DC terms, alpha →
    logit, scale → log, so ``ply_to_splat`` reproduces the records.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    properties = [
        "x", "y", "z",
        "f_dc_0", "f_dc_1", "f_dc_2",
        "opacity",
        "scale_0", "scale_1", "scale_2",
        "rot_0", "rot_1", "rot_2", "rot_3",
    ]
    header = "\n".join(
        ["ply", "format binary_little_endian 1.0", f"element vertex {len(records)}"]
        + [f"property float {name}" for name in properties]
        + ["end_header", ""]
    )
    with path.open("wb") as fh:
        fh.write(header.encode("ascii"))
        for position, scale, colour, alpha in records:
            f_dc = tuple((channel / 255 - 0.5) / _SH_C0 for channel in colour)
            fh.write(
                struct.pack(
                    "<14f",
                    *position,
                    *f_dc,
                    _logit(alpha / 255),
                    *(math.log(component) for component in scale),
                    1.0, 0.0, 0.0, 0.0,
                )
            )
    return len(records)
