# CPU real-backend image. Debian bookworm provides COLMAP 3.8.1 (3.8-1).
FROM python:3.11-slim-bookworm AS opensplat-builder
ARG WITH_OPENSPLAT=1
ARG OPENSPLAT_REF=main
ARG LIBTORCH_VERSION=2.4.1
RUN apt-get update && apt-get install -y --no-install-recommends build-essential ca-certificates cmake git libopencv-dev ninja-build unzip wget && rm -rf /var/lib/apt/lists/*
WORKDIR /build
# WITH_OPENSPLAT=0 keeps a fake-backend-capable image buildable if upstream
# compilation/downloads are unavailable. This path deliberately omits opensplat.
RUN mkdir -p /opt/opensplat/bin /opt/opensplat/lib && if [ "${WITH_OPENSPLAT}" = 1 ]; then \
      wget -q "https://download.pytorch.org/libtorch/cpu/libtorch-cxx11-abi-shared-with-deps-${LIBTORCH_VERSION}%2Bcpu.zip" -O libtorch.zip && unzip -q libtorch.zip && \
      git init src && git -C src remote add origin https://github.com/pierotofy/OpenSplat.git && git -C src fetch --depth 1 origin "${OPENSPLAT_REF}" && git -C src checkout --detach FETCH_HEAD && \
      cmake -S src -B src/build -GNinja -DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH=/build/libtorch -DGPU_RUNTIME=CPU && \
      cmake --build src/build --parallel && install -m 0755 src/build/opensplat /opt/opensplat/bin/opensplat && cp -a libtorch/lib/. /opt/opensplat/lib/; \
    elif [ "${WITH_OPENSPLAT}" != 0 ]; then echo "WITH_OPENSPLAT must be 0 or 1" >&2; exit 2; fi

FROM python:3.11-slim-bookworm AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 STORAGE_DIR=/srv/api/data/photos LD_LIBRARY_PATH=/opt/opensplat/lib
RUN apt-get update && apt-get install -y --no-install-recommends colmap libgomp1 libopencv-calib3d406 libopencv-core406 libopencv-highgui406 libopencv-imgproc406 && rm -rf /var/lib/apt/lists/* && \
    useradd --create-home --uid 10001 --shell /usr/sbin/nologin splat && mkdir -p /srv/worker /srv/api/data/photos && chown -R splat:splat /srv/worker /srv/api/data
WORKDIR /srv/worker
COPY worker/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY worker/worker ./worker
COPY --from=opensplat-builder /opt/opensplat /opt/opensplat
ENV PATH=/opt/opensplat/bin:${PATH}
USER splat
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 CMD celery -A worker.tasks inspect ping -d "celery@${HOSTNAME}" --timeout=5 || exit 1
ENTRYPOINT ["celery", "-A", "worker.tasks", "worker", "--loglevel=INFO"]
