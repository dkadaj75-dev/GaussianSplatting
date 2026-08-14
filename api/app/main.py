"""SplatScene API — FastAPI application factory and entrypoint.

Run locally with:  uvicorn app.main:app --reload
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.config import Settings, get_settings
from app.db import init_db
from app.routers import dev, jobs, measurements, photos, projects, ws
from app.schemas import HealthResponse

DESCRIPTION = """
Backend for **SplatScene** — upload photos, run the Gaussian-splatting
pipeline, navigate and measure the reconstructed scene.

See `PLAN.md` and `ROADMAP.md` in the repository root.
"""


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    init_db()
    settings.storage_dir.expanduser().mkdir(parents=True, exist_ok=True)
    yield


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    app = FastAPI(
        title="SplatScene API",
        description=DESCRIPTION,
        version=__version__,
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(projects.router)
    app.include_router(photos.router)
    app.include_router(jobs.router)
    app.include_router(measurements.router)
    app.include_router(dev.router)
    app.include_router(ws.router)

    @app.get("/healthz", response_model=HealthResponse, tags=["meta"])
    def healthz() -> HealthResponse:
        current = get_settings()
        return HealthResponse(status="ok", version=__version__, dev_mode=current.dev_mode)

    return app


app = create_app()
