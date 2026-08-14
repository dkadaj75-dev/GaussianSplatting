"""Job progress pub/sub.

The API streams job progress to browsers over ``/ws/jobs/{job_id}``. Right now
publishers and subscribers live in the *same* process (the dev-advance endpoint
publishes, the WebSocket handler subscribes), so a plain asyncio fan-out is
enough.

================================ INTEGRATION POINT ============================
When the Celery worker (WP 0.3) becomes the publisher it runs in a *different*
process, so the in-process bus stops working. Replace ``JobEventBus`` with a
Redis-backed implementation that keeps this exact interface:

    class RedisJobEventBus:
        async def publish(self, job_id: str, event: dict) -> None:
            await redis.publish(f"jobs:{job_id}", json.dumps(event))

        @asynccontextmanager
        async def subscribe(self, job_id: str) -> AsyncIterator[asyncio.Queue]:
            pubsub = redis.pubsub()
            await pubsub.subscribe(f"jobs:{job_id}")
            ...  # pump messages into an asyncio.Queue, unsubscribe on exit

Then swap the ``job_event_bus`` singleton below (or bind it via a FastAPI
dependency) — no route code has to change.
===============================================================================
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

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


# Process-wide singleton. Swap this out for the Redis-backed bus (see the
# integration note at the top of this module).
job_event_bus = JobEventBus()
