# Worker container images

The default `docker compose up --build` intentionally keeps the lightweight
`worker/Dockerfile` and `PIPELINE_BACKEND=fake`; it needs neither COLMAP nor a
GPU. Real processing is opt-in.

| Profile | Contents | Choose it when |
|---|---|---|
| default | Fake worker | Developing and testing orchestration |
| `cpu` | Debian bookworm, COLMAP 3.8.1, CPU OpenSplat | No NVIDIA GPU is available |
| `gpu` | CUDA 12.4.1, jammy COLMAP 3.7, CUDA OpenSplat | An NVIDIA GPU is available |

CPU builds are estimated at 15–45 minutes and 2–4 GB; GPU builds at 20–60
minutes and 5–10 GB. These are estimates—network, cache, core count, and CUDA
architectures substantially affect both.

## CPU

Use a recent Docker Engine/Compose v2 host with about 8 GB of build memory:

```sh
docker compose --profile cpu build worker-cpu
docker compose stop worker
docker compose --profile cpu up worker-cpu
```

Profiles are additive: the unprofiled fake `worker` is still part of the stack.
Stop it before processing real jobs so fake and real consumers do not share the
same Celery queue.

## NVIDIA GPU

The host needs a CUDA-12.4-compatible NVIDIA driver and
[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html),
in addition to Docker Engine and Compose v2:

```sh
docker compose --profile gpu build worker-gpu
docker compose stop worker
docker compose --profile gpu up worker-gpu
```

OpenSplat is CUDA-enabled. Ubuntu 22.04's distribution COLMAP is nevertheless
3.7-2: below the worker's COLMAP >=3.8 target and not a CUDA-enabled COLMAP
build. Thus OpenSplat training can use the GPU while COLMAP feature extraction
remains CPU-only. Keep `COLMAP_SIFT_USE_GPU=0`. That setting works only after
replacing the package with a CUDA-enabled COLMAP >=3.8; setting it to `1` cannot
add GPU SIFT support to the packaged binary.

## Verify the images

The images use Celery as their entrypoint, so override it for tool checks:

```sh
docker compose --profile cpu run --rm --entrypoint colmap worker-cpu -h
docker compose --profile cpu run --rm --entrypoint opensplat worker-cpu --help
docker compose --profile gpu run --rm --entrypoint colmap worker-gpu -h
docker compose --profile gpu run --rm --entrypoint opensplat worker-gpu --help
docker compose --profile gpu run --rm --entrypoint nvidia-smi worker-gpu
```

OpenSplat defaults to upstream `main`, since upstream does not provide a stable
container release for this exact toolchain. A release build should pass a
tested immutable tag or commit through `OPENSPLAT_REF`. `WITH_OPENSPLAT=0` is a
documented escape hatch if upstream downloads or compilation are unavailable:

```sh
docker build -f infra/worker.cpu.Dockerfile \
  --build-arg WITH_OPENSPLAT=0 -t splatscene-worker-fake .
```

That image only supports `PIPELINE_BACKEND=fake`; real mode will correctly fail
its executable check. To return to the standard fake stack:

```sh
docker compose down
docker compose up --build
```

## License and verification status

OpenSplat is AGPL-3.0. It is invoked as a standalone CLI rather than linked
into SplatScene, but AGPL obligations still apply to OpenSplat itself and its
corresponding source must remain available when distributed or offered as a
network service. See PLAN.md section 6 for the policy and alternatives.

These Dockerfiles were desk-checked but could not be built here. OpenSplat
source compatibility, libtorch downloads, runtime shared-library closure, CUDA
architecture compatibility, GPU execution, and the real pipeline all require
verification on Docker/NVIDIA hosts.

## Running on a laptop GPU (8 GB, e.g. RTX 2070)

The `gpu` image already compiles OpenSplat for compute capability 7.5, so a
Turing card (RTX 20-series) is covered by the default
`CMAKE_CUDA_ARCHITECTURES=70;75;80;86;89` — no build argument needed.

**Driver.** CUDA 12.x minor-version compatibility means the 12.4 runtime works
with any driver from the 525 series upward (Linux) / 527 upward (Windows); it
does not require a 550 driver. Check with `nvidia-smi`.

**Windows hosts** run this through WSL2: install a recent NVIDIA Windows driver
(the WSL CUDA support is in the Windows driver, *not* inside WSL), then Docker
Desktop with the WSL2 backend and GPU support enabled. `nvidia-smi` must work
inside your WSL distro before Docker will pass the GPU through.

**VRAM is the real limit, and it is image area that consumes it.** Training
allocates per-pixel tensors across the whole photo set, so full-resolution phone
photos (12 MP+) will exhaust 8 GB long before the algorithm struggles. Pass
`downscale` with the job:

| Photos | Suggested `downscale` | Notes |
|---|---|---|
| 12 MP phone, 30–60 shots | `2` | Halves each side; the usual starting point on 8 GB |
| 12 MP phone, 100+ shots | `2`–`4` | More views means more resident data |
| ≤ 6 MP or pre-shrunk | `1` | Full resolution is usually fine |

`iterations` trades time for quality: 7000 (the default) gives a usable scene,
30000 is the reference-quality figure. On a mobile RTX 2070 expect roughly
10–25 minutes at 7000 for a 40-photo set, and proportionally longer at 30000.

If OpenSplat still runs out of memory, raise `downscale` before reducing
iterations — resolution costs memory, iterations cost only time. `trainer_args`
passes flags straight through to the binary for anything this interface does
not model (OpenSplat's options vary between releases, so check
`opensplat --help` in your image).

**COLMAP feature extraction stays on the CPU** in this image, because the
jammy package is not a CUDA build; leave `COLMAP_SIFT_USE_GPU=0`. SfM is
usually minutes, so this is rarely the bottleneck — training dominates.

Example job parameters for this class of machine:

```json
{ "iterations": 7000, "downscale": 2, "matcher": "sequential", "marker_length_m": 0.15 }
```

`"matcher": "sequential"` is worth using when the photos were taken as a walk
around the subject in order — it skips the all-pairs comparison and is markedly
faster on larger sets.
