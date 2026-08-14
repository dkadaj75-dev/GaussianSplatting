"""Redis → WebSocket bridge (WP 0.4).

No Redis is involved: the subscriber's message source is injected, so the
parse → persist → republish path is exercised exactly as in production while
the tests stay hermetic.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import pytest
from sqlmodel import Session

from app.db import get_engine
from app.events import (
    JobEventBus,
    RedisEventBridge,
    parse_worker_event,
)
from app.models import Job, JobStage, JobStatus, Project, ProjectStatus


def worker_event(
    job_id: str,
    stage: str = "sfm",
    progress: float = 0.5,
    status: str = "running",
    message: str = "sfm in progress",
) -> str:
    """A payload shaped exactly like worker/worker/tasks.py emits."""
    return json.dumps(
        {
            "job_id": job_id,
            "stage": stage,
            "progress": progress,
            "status": status,
            "message": message,
            "ts": "2026-08-14T12:00:00+00:00",
        }
    )


def pmessage(payload: str | bytes) -> dict[str, Any]:
    """One redis-py pub/sub message, as ``pubsub.listen()`` yields them."""
    data = payload.encode() if isinstance(payload, str) else payload
    return {
        "type": "pmessage",
        "pattern": b"jobs:*",
        "channel": b"jobs:job-1",
        "data": data,
    }


async def stream(*messages: Any) -> AsyncIterator[Any]:
    for message in messages:
        yield message


@pytest.fixture
def seeded(env) -> tuple[str, str]:
    """A project + queued job straight in the DB (no HTTP round-trip needed)."""
    with Session(get_engine()) as session:
        project = Project(name="Bridge test")
        session.add(project)
        session.commit()
        session.refresh(project)
        job = Job(project_id=project.id)
        session.add(job)
        session.commit()
        session.refresh(job)
        return job.id, project.id


@pytest.fixture
def bus() -> JobEventBus:
    return JobEventBus()


@pytest.fixture
def bridge(bus: JobEventBus) -> RedisEventBridge:
    return RedisEventBridge("redis://unused:6379/0", bus=bus)


def load_job(job_id: str) -> Job:
    with Session(get_engine()) as session:
        job = session.get(Job, job_id)
        assert job is not None
        return job


def load_project(project_id: str) -> Project:
    with Session(get_engine()) as session:
        project = session.get(Project, project_id)
        assert project is not None
        return project


# --- parsing ----------------------------------------------------------------


def test_parse_maps_worker_vocabulary_to_api_enums():
    event = parse_worker_event(worker_event("job-1", stage="train", status="running"))
    assert event is not None
    assert event.job_id == "job-1"
    assert event.stage == JobStage.train
    assert event.status == JobStatus.running
    assert event.progress == 0.5


@pytest.mark.parametrize(
    ("worker_status", "expected"),
    [
        ("running", JobStatus.running),
        ("failed", JobStatus.failed),
        ("done", JobStatus.done),
    ],
)
def test_status_mapping(worker_status: str, expected: JobStatus):
    event = parse_worker_event(worker_event("job-1", status=worker_status))
    assert event is not None and event.status == expected


def test_parse_accepts_bytes_payloads():
    event = parse_worker_event(worker_event("job-1").encode())
    assert event is not None and event.job_id == "job-1"


def test_parse_clamps_progress():
    assert parse_worker_event(worker_event("job-1", progress=42.0)).progress == 1.0
    assert parse_worker_event(worker_event("job-1", progress=-3.0)).progress == 0.0


@pytest.mark.parametrize(
    "payload",
    [
        "not json at all",
        "[1, 2, 3]",
        json.dumps({"stage": "sfm"}),  # no job_id
        b"\xff\xfe binary",
    ],
)
def test_parse_rejects_unusable_payloads(payload):
    assert parse_worker_event(payload) is None


def test_parse_tolerates_unknown_stage_and_status():
    event = parse_worker_event(worker_event("job-1", stage="warp-drive", status="perplexed"))
    assert event is not None
    assert event.stage is None  # left untouched on the Job row
    assert event.status is None


# --- persist + republish ----------------------------------------------------


async def test_handle_raw_updates_job_and_republishes(bridge, bus, seeded):
    job_id, _ = seeded

    async with bus.subscribe(job_id) as queue:
        published = await bridge.handle_raw(worker_event(job_id, stage="train", progress=0.25))

        event = await asyncio.wait_for(queue.get(), timeout=1)

    assert published == event
    assert event["type"] == "progress"
    assert event["job_id"] == job_id
    assert event["stage"] == "train"
    assert event["progress"] == 0.25
    assert event["status"] == "running"
    assert event["message"] == "sfm in progress"

    job = load_job(job_id)
    assert job.stage == JobStage.train
    assert job.progress == 0.25
    assert job.status == JobStatus.running
    assert job.started_at is not None


async def test_terminal_done_event_marks_job_and_project(bridge, seeded):
    job_id, project_id = seeded

    await bridge.handle_raw(
        worker_event(job_id, stage="publish", progress=1.0, status="done", message="Complete")
    )

    job = load_job(job_id)
    assert job.status == JobStatus.done
    assert job.progress == 1.0
    assert job.finished_at is not None
    assert load_project(project_id).status == ProjectStatus.ready


async def test_failed_event_marks_job_and_project_failed(bridge, seeded):
    job_id, project_id = seeded

    await bridge.handle_raw(
        worker_event(job_id, stage="train", status="failed", message="GPU unavailable")
    )

    job = load_job(job_id)
    assert job.status == JobStatus.failed
    assert job.message == "GPU unavailable"
    assert job.finished_at is not None
    assert load_project(project_id).status == ProjectStatus.failed


async def test_unknown_job_is_dropped_without_publishing(bridge, bus, seeded):
    job_id, _ = seeded

    async with bus.subscribe("job-does-not-exist") as queue:
        assert await bridge.handle_raw(worker_event("job-does-not-exist")) is None
        assert queue.empty()

    # The real job is untouched.
    assert load_job(job_id).status == JobStatus.queued


async def test_malformed_payload_is_dropped(bridge, seeded):
    job_id, _ = seeded
    assert await bridge.handle_raw("}{ not json") is None
    assert load_job(job_id).status == JobStatus.queued


# --- consume loop -----------------------------------------------------------


async def test_consume_replays_a_full_pipeline_run(bridge, bus, seeded):
    job_id, project_id = seeded
    stages = ["ingest", "sfm", "train", "compress", "publish"]
    messages = [pmessage(worker_event(job_id, stage=stage, progress=1.0)) for stage in stages]
    messages.append(
        pmessage(worker_event(job_id, stage="publish", progress=1.0, status="done", message="ok"))
    )

    async with bus.subscribe(job_id) as queue:
        await bridge.consume(stream(*messages))
        received = [queue.get_nowait() for _ in range(queue.qsize())]

    assert [event["stage"] for event in received] == stages + ["publish"]
    assert [event["status"] for event in received][-1] == "done"
    assert load_job(job_id).status == JobStatus.done
    assert load_project(project_id).status == ProjectStatus.ready


async def test_consume_skips_subscribe_confirmations_and_bad_messages(bridge, bus, seeded):
    job_id, _ = seeded
    messages = [
        {"type": "psubscribe", "channel": b"jobs:*", "data": 1},
        "not a message dict",
        {"type": "pmessage", "channel": b"jobs:x", "data": None},
        pmessage("not json"),
        pmessage(worker_event(job_id, stage="compress", progress=0.75)),
    ]

    async with bus.subscribe(job_id) as queue:
        await bridge.consume(stream(*messages))
        assert queue.qsize() == 1
        event = queue.get_nowait()

    assert event["stage"] == "compress"
    assert load_job(job_id).stage == JobStage.compress


async def test_consume_survives_a_failing_handler(bridge, bus, seeded, monkeypatch):
    job_id, _ = seeded
    calls: list[str] = []

    original = bridge.handle_raw

    async def flaky(raw):
        calls.append("call")
        if len(calls) == 1:
            raise RuntimeError("transient DB blip")
        return await original(raw)

    monkeypatch.setattr(bridge, "handle_raw", flaky)

    await bridge.consume(stream(pmessage(worker_event(job_id)), pmessage(worker_event(job_id))))

    assert len(calls) == 2  # the loop kept going after the exception
    assert load_job(job_id).stage == JobStage.sfm


# --- lifecycle --------------------------------------------------------------


async def test_start_and_stop_are_clean(bus):
    """run() is stubbed: this covers task creation, cancellation and awaiting."""
    started = asyncio.Event()
    bridge = RedisEventBridge("redis://unused:6379/0", bus=bus)

    async def fake_run() -> None:
        started.set()
        await asyncio.sleep(3600)

    bridge.run = fake_run  # type: ignore[method-assign]

    await bridge.start()
    await asyncio.wait_for(started.wait(), timeout=1)
    await bridge.stop()

    assert bridge._task is None


async def test_run_reconnects_with_backoff(bus, monkeypatch):
    """A dropped connection is retried; the delay grows and never blocks stop()."""
    attempts = 0
    delays: list[float] = []

    class FakePubSub:
        async def psubscribe(self, pattern: str) -> None:
            return None

        def listen(self):
            async def _gen():
                nonlocal attempts
                attempts += 1
                if attempts <= 2:
                    raise ConnectionError("connection reset by peer")
                yield  # pragma: no cover
            return _gen()

        async def aclose(self) -> None:
            return None

    class FakeClient:
        def pubsub(self, **kwargs: Any) -> FakePubSub:
            return FakePubSub()

        async def aclose(self) -> None:
            return None

    monkeypatch.setattr("redis.asyncio.from_url", lambda url, **kwargs: FakeClient())

    bridge = RedisEventBridge(
        "redis://unused:6379/0", bus=bus, reconnect_delay=0.01, max_reconnect_delay=0.04
    )

    real_wait_for = asyncio.wait_for

    async def recording_wait_for(awaitable, timeout):
        delays.append(timeout)
        if len(delays) >= 2:
            bridge._stopping.set()
        return await real_wait_for(awaitable, timeout)

    # NB: patch through app.events (the module object is the real asyncio), so
    # bound the test with asyncio.timeout() rather than another wait_for call.
    monkeypatch.setattr("app.events.asyncio.wait_for", recording_wait_for)

    async with asyncio.timeout(5):
        await bridge.run()

    assert attempts == 2
    assert delays == [0.01, 0.02]  # exponential backoff
