# CUDA real-backend image. Host: compatible NVIDIA driver + Container Toolkit.
# Jammy apt COLMAP is 3.7/CPU-only: see infra/README.md before using real jobs.
FROM nvidia/cuda:12.4.1-devel-ubuntu22.04 AS opensplat-builder
ARG WITH_OPENSPLAT=1
ARG OPENSPLAT_REF=main
ARG LIBTORCH_VERSION=2.4.1
ARG CMAKE_CUDA_ARCHITECTURES=70;75;80;86;89
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends build-essential ca-certificates cmake git libopencv-dev ninja-build unzip wget && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN mkdir -p /opt/opensplat/bin /opt/opensplat/lib && if [ "${WITH_OPENSPLAT}" = 1 ]; then \
      wget -q "https://download.pytorch.org/libtorch/cu124/libtorch-cxx11-abi-shared-with-deps-${LIBTORCH_VERSION}%2Bcu124.zip" -O libtorch.zip && unzip -q libtorch.zip && \
      git init src && git -C src remote add origin https://github.com/pierotofy/OpenSplat.git && git -C src fetch --depth 1 origin "${OPENSPLAT_REF}" && git -C src checkout --detach FETCH_HEAD && \
      cmake -S src -B src/build -GNinja -DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH=/build/libtorch -DCMAKE_CUDA_ARCHITECTURES="${CMAKE_CUDA_ARCHITECTURES}" -DCUDA_TOOLKIT_ROOT_DIR=/usr/local/cuda -DGPU_RUNTIME=CUDA && \
      cmake --build src/build --parallel && install -m 0755 src/build/opensplat /opt/opensplat/bin/opensplat && cp -a libtorch/lib/. /opt/opensplat/lib/; \
    elif [ "${WITH_OPENSPLAT}" != 0 ]; then echo "WITH_OPENSPLAT must be 0 or 1" >&2; exit 2; fi

# Jammy has Python 3.10, so compile the worker's required Python 3.11 once and
# copy the /usr/local installation into the slim CUDA runtime stage.
FROM nvidia/cuda:12.4.1-devel-ubuntu22.04 AS python-builder
ARG PYTHON_VERSION=3.11.9
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends build-essential ca-certificates curl libbz2-dev libffi-dev libgdbm-dev liblzma-dev libncursesw5-dev libreadline-dev libsqlite3-dev libssl-dev tk-dev uuid-dev xz-utils zlib1g-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl -fsSLO "https://www.python.org/ftp/python/${PYTHON_VERSION}/Python-${PYTHON_VERSION}.tgz" && tar -xzf "Python-${PYTHON_VERSION}.tgz" && cd "Python-${PYTHON_VERSION}" && ./configure --enable-optimizations --enable-shared --with-ensurepip=install && make -j"$(nproc)" && make install

FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04 AS runtime
ARG DEBIAN_FRONTEND=noninteractive
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 STORAGE_DIR=/srv/api/data/photos LD_LIBRARY_PATH=/opt/opensplat/lib:/usr/local/lib:/usr/local/cuda/lib64
# Ubuntu 22.04 provides COLMAP 3.7-2. It is CPU-capable but below the worker's
# >=3.8 target; its packaged build does not make COLMAP_SIFT_USE_GPU work.
RUN apt-get update && apt-get install -y --no-install-recommends colmap libbz2-1.0 libffi8 libgdbm6 libgomp1 liblzma5 libncursesw6 libopencv-calib3d4.5d libopencv-core4.5d libopencv-highgui4.5d libopencv-imgproc4.5d libreadline8 libsqlite3-0 libssl3 tk uuid-runtime zlib1g && rm -rf /var/lib/apt/lists/* && \
    useradd --create-home --uid 10001 --shell /usr/sbin/nologin splat && mkdir -p /srv/worker /srv/api/data/photos && chown -R splat:splat /srv/worker /srv/api/data
COPY --from=python-builder /usr/local /usr/local
WORKDIR /srv/worker
COPY worker/requirements.txt ./requirements.txt
RUN python3.11 -m pip install --no-cache-dir -r requirements.txt
COPY worker/worker ./worker
COPY --from=opensplat-builder /opt/opensplat /opt/opensplat
ENV PATH=/opt/opensplat/bin:/usr/local/bin:${PATH}
USER splat
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 CMD celery -A worker.tasks inspect ping -d "celery@${HOSTNAME}" --timeout=5 || exit 1
ENTRYPOINT ["celery", "-A", "worker.tasks", "worker", "--loglevel=INFO"]
