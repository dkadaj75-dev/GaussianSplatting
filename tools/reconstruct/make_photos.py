"""Render synthetic 'photographs' of a textured box from an orbiting camera.

Purpose: prove the SfM path works in this environment end to end without
needing the user's photos yet. A textured box is a fair stand-in — it is
non-planar (planar scenes are degenerate for SfM) and carries dense
high-frequency texture, which is exactly what feature matching needs.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image

OUT = Path("photos")
W, H = 1024, 768
FOV_DEG = 55.0
N_VIEWS = 24
RNG = np.random.default_rng(7)


def texture(seed: int, size: int = 512) -> Image.Image:
    """High-frequency coloured noise with blobs — plenty of SIFT features."""
    rng = np.random.default_rng(seed)
    base = rng.integers(40, 215, size=(size // 8, size // 8, 3), dtype=np.uint8)
    img = Image.fromarray(base).resize((size, size), Image.BICUBIC)
    fine = rng.integers(0, 60, size=(size, size, 3), dtype=np.uint8)
    arr = np.clip(np.asarray(img).astype(np.int16) + fine - 30, 0, 255).astype(np.uint8)
    return Image.fromarray(arr)


# Unit box centred on the origin.
S = 0.5
CORNERS = {
    "nx": [(-S, -S, -S), (-S, -S, S), (-S, S, S), (-S, S, -S)],
    "px": [(S, -S, S), (S, -S, -S), (S, S, -S), (S, S, S)],
    "ny": [(-S, -S, -S), (S, -S, -S), (S, -S, S), (-S, -S, S)],
    "py": [(-S, S, S), (S, S, S), (S, S, -S), (-S, S, -S)],
    "nz": [(S, -S, -S), (-S, -S, -S), (-S, S, -S), (S, S, -S)],
    "pz": [(-S, -S, S), (S, -S, S), (S, S, S), (-S, S, S)],
}
NORMALS = {
    "nx": (-1, 0, 0), "px": (1, 0, 0),
    "ny": (0, -1, 0), "py": (0, 1, 0),
    "nz": (0, 0, -1), "pz": (0, 0, 1),
}
TEXTURES = {name: texture(i * 31 + 5) for i, name in enumerate(CORNERS)}


def look_at(eye: np.ndarray, target: np.ndarray) -> np.ndarray:
    """World->camera rotation, OpenCV convention (x right, y down, z forward)."""
    forward = target - eye
    forward /= np.linalg.norm(forward)
    world_up = np.array([0.0, 1.0, 0.0])
    right = np.cross(forward, world_up)
    if np.linalg.norm(right) < 1e-6:
        right = np.cross(forward, np.array([1.0, 0.0, 0.0]))
    right /= np.linalg.norm(right)
    down = np.cross(forward, right)
    return np.stack([right, down, forward])


def render(eye: np.ndarray, target: np.ndarray, path: Path) -> None:
    rotation = look_at(eye, target)
    focal = 0.5 * H / math.tan(math.radians(FOV_DEG) / 2)
    canvas = Image.new("RGB", (W, H), (18, 18, 22))

    faces = []
    for name, corners in CORNERS.items():
        centre = np.mean(np.array(corners), axis=0)
        normal = np.array(NORMALS[name], dtype=float)
        # Back-face cull: only faces turned towards the camera are photographed.
        if np.dot(normal, eye - centre) <= 0:
            continue
        faces.append((np.linalg.norm(centre - eye), name, corners))
    faces.sort(reverse=True)  # painter's algorithm: far faces first

    for _, name, corners in faces:
        projected = []
        ok = True
        for corner in corners:
            cam = rotation @ (np.array(corner, dtype=float) - eye)
            if cam[2] <= 1e-6:
                ok = False
                break
            projected.append((focal * cam[0] / cam[2] + W / 2, focal * cam[1] / cam[2] + H / 2))
        if not ok:
            continue

        tex = TEXTURES[name]
        # PIL maps the *destination* box back through the quad, so the quad is
        # given in the source image's coordinates for the destination bbox.
        xs = [p[0] for p in projected]
        ys = [p[1] for p in projected]
        bbox = (int(min(xs)) - 1, int(min(ys)) - 1, int(max(xs)) + 1, int(max(ys)) + 1)
        bw, bh = bbox[2] - bbox[0], bbox[3] - bbox[1]
        if bw <= 1 or bh <= 1:
            continue

        # Solve the inverse mapping by warping the texture onto the quad with a
        # perspective transform derived from the four correspondences.
        src = [(0, 0), (tex.width, 0), (tex.width, tex.height), (0, tex.height)]
        dst = [(p[0] - bbox[0], p[1] - bbox[1]) for p in projected]
        coeffs = perspective_coeffs(dst, src)
        warped = tex.transform((bw, bh), Image.PERSPECTIVE, coeffs, Image.BICUBIC)

        mask = Image.new("L", (bw, bh), 0)
        from PIL import ImageDraw

        ImageDraw.Draw(mask).polygon(dst, fill=255)
        canvas.paste(warped, (bbox[0], bbox[1]), mask)

    canvas.save(path, quality=94)


def perspective_coeffs(dst: list, src: list) -> tuple:
    """Coefficients mapping destination pixels back into the source image."""
    matrix = []
    for (dx, dy), (sx, sy) in zip(dst, src):
        matrix.append([dx, dy, 1, 0, 0, 0, -sx * dx, -sx * dy])
        matrix.append([0, 0, 0, dx, dy, 1, -sy * dx, -sy * dy])
    a = np.array(matrix, dtype=float)
    b = np.array(src, dtype=float).reshape(8)
    return tuple(np.linalg.solve(a, b))


def main() -> None:
    OUT.mkdir(exist_ok=True)
    target = np.zeros(3)
    for index in range(N_VIEWS):
        angle = 2 * math.pi * index / N_VIEWS
        elevation = 0.45 + 0.25 * math.sin(angle * 2)
        radius = 2.3
        eye = np.array(
            [radius * math.cos(angle), radius * elevation, radius * math.sin(angle)]
        )
        render(eye, target, OUT / f"view_{index:03d}.jpg")
    print(f"wrote {N_VIEWS} photos to {OUT.resolve()}")


if __name__ == "__main__":
    main()
