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
