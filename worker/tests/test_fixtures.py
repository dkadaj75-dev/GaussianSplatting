"""The fake backend's placeholder artifacts must be genuinely loadable."""

from __future__ import annotations

import struct

from worker.backends.real import ply_to_splat
from worker.fixtures import placeholder_records, write_3dgs_ply, write_splat


def test_placeholder_scene_is_deterministic_and_nonempty():
    records = placeholder_records()
    assert len(records) > 3000
    assert records == placeholder_records()


def test_splat_file_is_valid_32_byte_records(tmp_path):
    path = tmp_path / "scene.splat"
    count = write_splat(path, placeholder_records())

    size = path.stat().st_size
    assert size == count * 32 and size > 0

    # First record parses to finite floats and sane bytes.
    x, y, z, sx, sy, sz, r, g, b, a, *rot = struct.unpack("<3f3f4B4B", path.read_bytes()[:32])
    assert all(abs(v) < 10 for v in (x, y, z))
    assert all(0 < s < 1 for s in (sx, sy, sz))
    assert all(0 <= c <= 255 for c in (r, g, b, a))


def test_ply_round_trips_through_the_real_converter(tmp_path):
    """The placeholder PLY is a fixture for ply_to_splat: converting it must
    reproduce the .splat file the fake backend publishes, byte for byte."""
    records = placeholder_records()
    ply, direct, converted = tmp_path / "output.ply", tmp_path / "direct.splat", tmp_path / "conv.splat"
    write_3dgs_ply(ply, records)
    write_splat(direct, records)

    assert ply_to_splat(ply, converted) == len(records)

    direct_bytes, converted_bytes = direct.read_bytes(), converted.read_bytes()
    assert len(direct_bytes) == len(converted_bytes)
    # Colour/alpha survive the byte→SH→byte round trip within one count;
    # positions and rotations must be exact.
    for offset in range(0, len(direct_bytes), 32):
        d = struct.unpack("<3f3f4B4B", direct_bytes[offset : offset + 32])
        c = struct.unpack("<3f3f4B4B", converted_bytes[offset : offset + 32])
        assert d[:3] == c[:3]
        assert all(abs(dv - cv) < 1e-6 for dv, cv in zip(d[3:6], c[3:6]))
        assert all(abs(dv - cv) <= 1 for dv, cv in zip(d[6:10], c[6:10]))
        assert d[10:] == c[10:]
