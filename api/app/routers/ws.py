"""WebSocket progress channel: ``/ws/jobs/{job_id}``.

Protocol (server → client, JSON text frames):

    {"type": "snapshot", "job_id": ..., "project_id": ..., "stage": "sfm",
     "progress": 0.5, "status": "running", "message": null,
     "updated_at": "2026-08-14T10:00:00Z"}

``type`` is ``snapshot`` for the first frame (current DB state, so a client
that connects late is immediately correct), ``created``/``progress`` for live
updates, and ``ping`` for keepalives. The server closes with code 4004 when
the job does not exist.

Clients are not expected to send anything; inbound frames are drained so a
disconnect is noticed promptly.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlmodel import Session

from app.db import get_engine
from app.events import job_event_bus
from app.job_service import job_to_event
from app.models import Job

router = APIRouter(tags=["jobs"])

# Keepalive interval; also bounds how long a dead peer stays subscribed.
PING_INTERVAL_SECONDS = 25.0

WS_CLOSE_JOB_NOT_FOUND = 4004


def _load_snapshot(job_id: str) -> dict[str, Any] | None:
    with Session(get_engine()) as session:
        job = session.get(Job, job_id)
        if job is None:
            return None
        return job_to_event(job, event_type="snapshot").model_dump(mode="json")


@router.websocket("/ws/jobs/{job_id}")
async def job_progress_socket(websocket: WebSocket, job_id: str) -> None:
    await websocket.accept()

    # Subscribe *before* reading the snapshot so no event slips through the
    # gap between the two.
    async with job_event_bus.subscribe(job_id) as queue:
        snapshot = await asyncio.to_thread(_load_snapshot, job_id)
        if snapshot is None:
            await websocket.close(code=WS_CLOSE_JOB_NOT_FOUND, reason="Job not found")
            return

        await websocket.send_json(snapshot)

        receiver = asyncio.create_task(_drain_incoming(websocket))
        try:
            while True:
                getter = asyncio.create_task(queue.get())
                done, _ = await asyncio.wait(
                    {getter, receiver},
                    timeout=PING_INTERVAL_SECONDS,
                    return_when=asyncio.FIRST_COMPLETED,
                )

                if receiver in done:
                    getter.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await getter
                    return  # client went away

                if getter in done:
                    await websocket.send_json(getter.result())
                    continue

                getter.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await getter
                await websocket.send_json({"type": "ping", "job_id": job_id})
        except WebSocketDisconnect:
            return
        except RuntimeError:
            # Starlette raises this when sending on an already-closed socket.
            return
        finally:
            receiver.cancel()
            with contextlib.suppress(asyncio.CancelledError, WebSocketDisconnect):
                await receiver


async def _drain_incoming(websocket: WebSocket) -> None:
    """Read and discard client frames; returns when the peer disconnects."""
    with contextlib.suppress(WebSocketDisconnect, RuntimeError):
        while True:
            await websocket.receive()
