# CPU reconstruction and review renders

Turns a folder of photos into a `.splat` scene and a set of review images,
without a GPU and without a system COLMAP install. Useful for checking a photo
set actually reconstructs before committing a GPU run, and for producing
"here is what we captured" images after a site visit.

**This is not Gaussian-splat training.** It runs COLMAP's structure-from-motion
(via the `pycolmap` wheels) and renders the resulting *sparse coloured point
cloud* through the app's own viewer. A trained 3DGS model — dense, smooth,
view-dependent — still requires `PIPELINE_BACKEND=real` on a GPU host (see
`infra/`). Expect a recognisable but grainy scene here, not a photoreal one.

## Use

```bash
python -m venv .venv && .venv/bin/pip install -r tools/reconstruct/requirements.txt

# 1. Reconstruct. Prints how many photos registered — the key quality signal.
.venv/bin/python tools/reconstruct/run_sfm.py /path/to/photos work/

# Memory-constrained by default (WSL, laptops sharing RAM with Docker):
# images are downscaled to 1600 px and extraction uses 2 threads. If the
# process still prints "Killed" (the kernel's out-of-memory killer), stop
# the Docker stack first (docker compose down) and/or lower further:
.venv/bin/python tools/reconstruct/run_sfm.py /path/to/photos work/ --max-image-size 1200
# On a roomy machine, raise quality/speed instead:
.venv/bin/python tools/reconstruct/run_sfm.py /path/to/photos work/ --max-image-size 3200 --threads 8
# Photos taken walking around the subject in order match much faster with:
.venv/bin/python tools/reconstruct/run_sfm.py /path/to/photos work/ --sequential

# 2. Convert the sparse model to the viewer's .splat layout.
.venv/bin/python tools/reconstruct/points_to_splat.py work/sparse_model scene.splat

# 3. Render review angles (needs the harness build: cd demo && npx vite build
#    --config vite.harness.config.ts, then copy scene.splat into dist-harness/).
node tools/reconstruct/shoot.mjs demo/dist-harness out/
```

`make_photos.py` renders a synthetic textured box from an orbiting camera; it
exists so the whole path can be exercised without a real photo set.

## Reading the result

`registered N/M images` is the number that matters. Well below M means the
photos lacked overlap or texture — the same diagnostic the worker surfaces in
the app. Fewer than ~3 usable views of a surface leaves a hole no renderer can
fill.
