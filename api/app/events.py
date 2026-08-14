"""Job progress pub/sub.

The API streams job progress to browsers over ``/ws/jobs/{job_id}``. Subscribers
(the WebSocket handler) always read from the in-process :class:`JobEventBus`; the
publisher is either in-process (the dev-advance endpoint) or the Celery worker,
whose Redis events are pulled in by the :class:`RedisEventBridge` below.

================================ INTEGRATION POINT (resolved, WP 0.4) =========
The Celery worker publishes progress as JSON on the Redis channel
``jobs:{job_id}`` from a *different* process, so the in-process bus alone is no
longer enough.

Rather than replacing ``JobEventBus`` with a Redis-backed bus (which would open
one Redis subscription per connected browser), the API runs a single
``RedisEventBridge`` per process: it ``PSUBSCRIBE jobs:*`` once, writes each
worker event to the Job row, and republishes the canonical ``JobEvent`` onto the
in-process bus below. ``/ws/jobs/{job_id}`` therefore works unchanged, and the
frames a client sees are identical whoever produced them.

    worker ──publish──> redis jobs:{id} ──> RedisEventBridge ──> JobEventBus ──> /ws

Enabled with ``EVENT_SOURCE=redis`` (default ``inprocess`` keeps dev and the
test-suite Redis-free); wired into the app lifespan in ``app.main``.
===============================================================================
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import AsyncIterable, AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from sqlmodel import Session

from app.db import get_engine
from app.models import Job, JobStage, JobStatus

logger = logging.getLogger(__name__)

# Bounded per-subscriber queue: a browser that stops reading must never grow
# the server's memory without limit. Oldest events are dropped first.
SUBSCRIBER_QUEUE_MAXSIZE = 100


class JobEventBus:
    """In-process, per-job fan-out of progress events.

    Each subscriber gets its own bounded queue; publishing never blocks on a
    slow consumer.
    """

    def __init__(self) -> None:
        self._subscribers: dict[str, set[asyncio.Queue[dict[str, Any]]]] = {}
        self._lock = asyncio.Lock()

    async def publish(self, job_id: str, event: dict[str, Any]) -> int:
        """Deliver ``event`` to every subscriber of ``job_id``.

        Returns the number of subscribers the event was offered to.
        """
        async with self._lock:
            queues = list(self._subscribers.get(job_id, ()))

        for queue in queues:
            if queue.full():
                # Drop the oldest event rather than stalling the publisher.
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:  # pragma: no cover - race, harmless
                    pass
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:  # pragma: no cover - race, harmless
                pass
        return len(queues)

    @asynccontextmanager
    async def subscribe(self, job_id: str) -> AsyncIterator[asyncio.Queue[dict[str, Any]]]:
        """Async context manager yielding a queue of events for one job."""
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=SUBSCRIBER_QUEUE_MAXSIZE)
        async with self._lock:
            self._subscribers.setdefault(job_id, set()).add(queue)
        try:
            yield queue
        finally:
            async with self._lock:
                subscribers = self._subscribers.get(job_id)
                if subscribers is not None:
                    subscribers.discard(queue)
                    if not subscribers:
                        del self._subscribers[job_id]

    def subscriber_count(self, job_id: str) -> int:
        return len(self._subscribers.get(job_id, ()))


# Process-wide singleton, fed by the dev-advance endpoint and (with
# EVENT_SOURCE=redis) by the RedisEventBridge below.
job_event_bus = JobEventBus()


# --- Worker → API bridge ----------------------------------------------------

# Channel the worker publishes on: jobs:{job_id} (worker/README.md).
WORKER_CHANNEL_PATTERN = "jobs:*"

# Worker status vocabulary → the API's JobStatus enum. The worker only ever
# reports these three; anything else is ignored (status left untouched) rather
# than crashing the bridge.
WORKER_STATUS_MAP: dict[str, JobStatus] = {
    "running": JobStatus.running,
    "failed": JobStatus.failed,
    "done": JobStatus.done,
    "queued": JobStatus.queued,
}

RECONNECT_DELAY_SECONDS = 1.0
RECONNECT_DELAY_MAX_SECONDS = 30.0


@dataclass(frozen=True)
class WorkerEvent:
    """One progress event as published by the worker (worker/README.md)."""

    job_id: str
    stage: JobStage | None
    progress: float | None
    status: JobStatus | None
    message: str | None


def parse_worker_event(raw: str | bytes | bytearray) -> WorkerEvent | None:
    """Parse a worker payload, or return ``None`` if it is unusable.

    Defensive by design: a malformed or half-known message from a worker of a
    different version must never kill the subscriber loop.
    """
    if isinstance(raw, bytes | bytearray):
        try:
            raw = raw.decode("utf-8")
        except UnicodeDecodeError:
            logger.warning("Discarding non-UTF-8 worker event")
            return None
    try:
        payload = json.loads(raw)
    except (ValueError, TypeError):
        logger.warning("Discarding malformed worker event: %.200r", raw)
        return None
    if not isinstance(payload, dict):
        return None

    job_id = payload.get("job_id")
    if not isinstance(job_id, str) or not job_id:
        logger.warning("Discarding worker event without job_id")
        return None

    stage: JobStage | None = None
    raw_stage = payload.get("stage")
    if isinstance(raw_stage, str):
        try:
            stage = JobStage(raw_stage)
        except ValueError:
            logger.warning("Unknown worker stage %r for job %s", raw_stage, job_id)

    progress: float | None = None
    raw_progress = payload.get("progress")
    if isinstance(raw_progress, int | float) and not isinstance(raw_progress, bool):
        progress = max(0.0, min(1.0, float(raw_progress)))

    status: JobStatus | None = None
    raw_status = payload.get("status")
    if isinstance(raw_status, str):
        status = WORKER_STATUS_MAP.get(raw_status.strip().lower())
        if status is None:
            logger.warning("Unknown worker status %r for job %s", raw_status, job_id)

    message = payload.get("message")
    if message is not None and not isinstance(message, str):
        message = str(message)

    return WorkerEvent(
        job_id=job_id,
        stage=stage,
        progress=progress,
        status=status,
        message=message,
    )


class RedisEventBridge:
    """Subscribes to the worker's Redis channels and feeds the in-process bus.

    Split into three testable pieces:

    * :meth:`handle_event` — DB write + republish for one parsed event,
    * :meth:`consume` — drive it from *any* async message source (a fake in
      tests, ``pubsub.listen()`` in production),
    * :meth:`run` — connect/reconnect loop with exponential backoff.
    """

    def __init__(
        self,
        redis_url: str,
        *,
        bus: JobEventBus | None = None,
        pattern: str = WORKER_CHANNEL_PATTERN,
        reconnect_delay: float = RECONNECT_DELAY_SECONDS,
        max_reconnect_delay: float = RECONNECT_DELAY_MAX_SECONDS,
    ) -> None:
        self.redis_url = redis_url
        self.bus = bus if bus is not None else job_event_bus
        self.pattern = pattern
        self.reconnect_delay = reconnect_delay
        self.max_reconnect_delay = max_reconnect_delay
        self._task: asyncio.Task[None] | None = None
        self._stopping = asyncio.Event()

    # --- event handling ---------------------------------------------------

    def _apply_to_job(self, event: WorkerEvent) -> dict[str, Any] | None:
        """Persist one event; returns the JobEvent payload to republish.

        Runs in a worker thread (SQLModel/SQLite are synchronous).
        """
        # Imported here: app.job_service imports this module, so a module-level
        # import would be circular.
        from app.job_service import (  # noqa: PLC0415 - deliberate lazy import
            apply_job_update,
            job_to_event,
            sync_project_status,
        )

        with Session(get_engine()) as session:
            job = session.get(Job, event.job_id)
            if job is None:
                logger.warning("Worker event for unknown job %s — dropped", event.job_id)
                return None
            job = apply_job_update(
                session,
                job,
                stage=event.stage,
                progress=event.progress,
                status=event.status,
                message=event.message,
            )
            sync_project_status(session, job)
            return job_to_event(job).model_dump(mode="json")

    async def handle_event(self, event: WorkerEvent) -> dict[str, Any] | None:
        """Apply a parsed event and republish it; returns the published payload."""
        payload = await asyncio.to_thread(self._apply_to_job, event)
        if payload is None:
            return None
        await self.bus.publish(event.job_id, payload)
        return payload

    async def handle_raw(self, raw: str | bytes | bytearray) -> dict[str, Any] | None:
        """Parse + handle one raw worker payload."""
        event = parse_worker_event(raw)
        if event is None:
            return None
        return await self.handle_event(event)

    async def consume(self, messages: AsyncIterable[Any]) -> None:
        """Consume a redis-py pub/sub message stream (or any equivalent).

        Accepts the message dicts redis-py yields; subscription confirmations
        and anything unparseable are skipped. One bad event never stops the
        stream.
        """
        async for message in messages:
            if self._stopping.is_set():
                return
            if not isinstance(message, dict):
                continue
            if message.get("type") not in ("message", "pmessage"):
                continue  # subscribe/psubscribe confirmations
            data = message.get("data")
            if data is None:
                continue
            try:
                await self.handle_raw(data)
            except asyncio.CancelledError:
                raise
            except Exception:  # pragma: no cover - defensive
                logger.exception("Failed to handle worker event")

    # --- connection lifecycle --------------------------------------------

    async def run(self) -> None:
        """Subscribe and consume forever, reconnecting with exponential backoff."""
        # Lazy import so the API only needs redis when EVENT_SOURCE=redis.
        import redis.asyncio as redis_asyncio  # noqa: PLC0415 - deliberate lazy import

        loop = asyncio.get_running_loop()
        delay = self.reconnect_delay
        while not self._stopping.is_set():
            connected_at = loop.time()
            try:
                client = redis_asyncio.from_url(self.redis_url)
                pubsub = client.pubsub(ignore_subscribe_messages=True)
                try:
                    await pubsub.psubscribe(self.pattern)
                    logger.info("Subscribed to Redis %s on %s", self.pattern, self.redis_url)
                    await self.consume(pubsub.listen())
                finally:
                    with contextlib.suppress(Exception):
                        await pubsub.aclose()
                    with contextlib.suppress(Exception):
                        await client.aclose()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("Redis event bridge disconnected: %s", exc)

            if self._stopping.is_set():
                return

            # A connection that stayed up comfortably longer than the backoff
            # window counts as healthy, so the next outage starts from scratch.
            if loop.time() - connected_at >= self.max_reconnect_delay:
                delay = self.reconnect_delay
            logger.info("Reconnecting to Redis in %.1fs", delay)
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._stopping.wait(), timeout=delay)
            delay = min(delay * 2, self.max_reconnect_delay)

    async def start(self) -> None:
        """Launch the subscriber as a background task."""
        if self._task is not None:  # pragma: no cover - defensive
            return
        self._stopping.clear()
        self._task = asyncio.create_task(self.run(), name="redis-event-bridge")

    async def stop(self) -> None:
        """Signal shutdown and await the background task."""
        self._stopping.set()
        task = self._task
        self._task = None
        if task is None:
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
