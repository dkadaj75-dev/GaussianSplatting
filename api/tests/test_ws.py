"""WebSocket progress channel, plus the event bus itself."""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from app.events import JobEventBus
from tests.conftest import upload_files


def _seed_job(sync_client: TestClient) -> dict:
    project = sync_client.post("/api/projects", json={"name": "WS demo"}).json()
    upload = sync_client.post(f"/api/projects/{project['id']}/photos", files=upload_files(1))
    assert upload.status_code == 201, upload.text
    job = sync_client.post(f"/api/projects/{project['id']}/jobs", json={})
    assert job.status_code == 201, job.text
    return job.json()


def test_ws_sends_snapshot_then_progress(sync_client: TestClient) -> None:
    job = _seed_job(sync_client)

    with sync_client.websocket_connect(f"/ws/jobs/{job['id']}") as ws:
        snapshot = ws.receive_json()
        assert snapshot["type"] == "snapshot"
        assert snapshot["job_id"] == job["id"]
        assert snapshot["status"] == "queued"
        assert snapshot["stage"] == "ingest"

        # Drive the job from the REST side; the event must arrive on the socket.
        advanced = sync_client.post(f"/api/dev/jobs/{job['id']}/advance").json()
        event = ws.receive_json()
        assert event["type"] == "progress"
        assert event["status"] == "running"
        assert event["stage"] == advanced["stage"]
        assert event["progress"] == advanced["progress"]

        sync_client.post(
            f"/api/dev/jobs/{job['id']}/advance",
            json={"stage": "publish", "progress": 1.0, "status": "done"},
        )
        final = ws.receive_json()
        assert final["status"] == "done"
        assert final["stage"] == "publish"
        assert final["progress"] == 1.0


def test_ws_unknown_job_closes(sync_client: TestClient) -> None:
    from starlette.websockets import WebSocketDisconnect

    from app.routers.ws import WS_CLOSE_JOB_NOT_FOUND

    with pytest.raises(WebSocketDisconnect) as excinfo:
        with sync_client.websocket_connect("/ws/jobs/does-not-exist") as ws:
            ws.receive_json()

    assert excinfo.value.code == WS_CLOSE_JOB_NOT_FOUND


async def test_event_bus_fans_out_to_all_subscribers() -> None:
    bus = JobEventBus()
    async with bus.subscribe("job-1") as first, bus.subscribe("job-1") as second:
        assert bus.subscriber_count("job-1") == 2
        delivered = await bus.publish("job-1", {"progress": 0.5})
        assert delivered == 2
        assert (await asyncio.wait_for(first.get(), 1))["progress"] == 0.5
        assert (await asyncio.wait_for(second.get(), 1))["progress"] == 0.5

    assert bus.subscriber_count("job-1") == 0


async def test_event_bus_isolates_jobs_and_survives_no_subscribers() -> None:
    bus = JobEventBus()
    assert await bus.publish("nobody-listening", {"progress": 1.0}) == 0

    async with bus.subscribe("job-a") as queue:
        await bus.publish("job-b", {"progress": 0.1})
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(queue.get(), 0.05)


async def test_event_bus_drops_oldest_when_subscriber_is_slow() -> None:
    """A browser that stops reading must not grow the server's memory."""
    from app.events import SUBSCRIBER_QUEUE_MAXSIZE

    bus = JobEventBus()
    async with bus.subscribe("job-1") as queue:
        for index in range(SUBSCRIBER_QUEUE_MAXSIZE + 10):
            await bus.publish("job-1", {"seq": index})

        assert queue.qsize() == SUBSCRIBER_QUEUE_MAXSIZE
        # The oldest events were dropped, the newest survive.
        assert queue.get_nowait()["seq"] == 10
