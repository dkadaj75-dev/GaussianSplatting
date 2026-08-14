# SplatScene API image.
# Build from the repo root:  docker build -t splatscene-api ./api
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv/api

# Dependencies first so the layer caches across code changes.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Storage + SQLite live under /srv/api/data (mounted as a named volume in
# docker-compose so uploads survive container rebuilds).
RUN mkdir -p /srv/api/data/photos \
    && useradd --create-home --uid 10001 splat \
    && chown -R splat:splat /srv/api
USER splat

ENV DATABASE_URL=sqlite:////srv/api/data/splatscene.db \
    STORAGE_DIR=/srv/api/data/photos

EXPOSE 8000

# --proxy-headers so the client's scheme/host survive a reverse proxy.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
