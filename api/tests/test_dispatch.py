"""Queue dispatch gating (QUEUE_MODE) — WP 0.4.

The API must never import the worker package, so dispatch is verified purely
through the task *name* and args handed to a stand-in Celery client.
"""

from __future__ import annotations

from typing import Any

import pytest
from httpx import AsyncClient

from app import job_service
from app.config import QueueMode, get_settings
from app.job_service import CeleryDispatcher, NullDispatcher, enqueue_job, get_dispatcher
from app.models import Job, JobStage
from tests.conftest import upload_files


class FakeAsyncResult:
    def __init__(self, task_id: str) -> None:
        self.id = task_id


class FakeCelery:
    """Records send_task calls instead of touching a broker."""

    def __init__(self, task_id: str = "task-123") -> None:
        self.task_id = task_id
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def send_task(self, name: str, **kwargs: Any) -> FakeAsyncResult:
        self.calls.append((name, kwargs))
        return FakeAsyncResult(self.task_id)


@pytest.fixture(autouse=True)
def _reset_dispatcher():
    """Never leak a dispatcher (or its config cache) between tests."""
    job_service.set_dispatcher(None)
    yield
    job_service.set_dispatcher(None)


@pytest.fixture
def fake_celery(monkeypatch: pytest.MonkeyPatch) -> FakeCelery:
    fake = FakeCelery()
    monkeypatch.setattr(job_service, "_build_celery_app", lambda broker_url: fake)
    return fake


def _job() -> Job:
    return Job(id="job-1", project_id="project-1", stage=JobStage.ingest)


# --- selection --------------------------------------------------------------


def test_default_queue_mode_is_none(env):
    assert get_settings().queue_mode == QueueMode.none
    assert isinstance(get_dispatcher(), NullDispatcher)


def test_queue_mode_celery_selects_celery_dispatcher(env, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("QUEUE_MODE", "celery")
    monkeypatch.setenv("CELERY_BROKER_URL", "redis://broker:6379/1")
    get_settings.cache_clear()

    dispatcher = get_dispatcher()
    assert isinstance(dispatcher, CeleryDispatcher)
    assert dispatcher.broker_url == "redis://broker:6379/1"
    assert dispatcher.task_name == "worker.run_pipeline"


def test_broker_url_falls_back_to_redis_url(env, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("REDIS_URL", "redis://redis:6379/0")
    get_settings.cache_clear()
    assert get_settings().broker_url == "redis://redis:6379/0"


# --- dispatch behaviour -----------------------------------------------------


def test_queue_mode_none_does_not_dispatch(env, fake_celery: FakeCelery):
    assert enqueue_job(_job()) is None
    assert fake_celery.calls == []


def test_queue_mode_celery_calls_send_task(env, monkeypatch: pytest.MonkeyPatch, fake_celery):
    monkeypatch.setenv("QUEUE_MODE", "celery")
    get_settings.cache_clear()

    task_id = enqueue_job(_job())

    assert task_id == "task-123"
    assert len(fake_celery.calls) == 1
    name, kwargs = fake_celery.calls[0]
    assert name == "worker.run_pipeline"
    assert kwargs["args"] == ["job-1", "project-1", {"stage": "ingest"}]


def test_custom_task_name_and_queue_are_honoured(env, monkeypatch: pytest.MonkeyPatch, fake_celery):
    monkeypatch.setenv("QUEUE_MODE", "celery")
    monkeypatch.setenv("CELERY_TASK_NAME", "worker.other")
    monkeypatch.setenv("CELERY_QUEUE", "gpu")
    get_settings.cache_clear()

    enqueue_job(_job())

    name, kwargs = fake_celery.calls[0]
    assert name == "worker.other"
    assert kwargs["queue"] == "gpu"


def test_broker_failure_does_not_raise(env, monkeypatch: pytest.MonkeyPatch):
    class Exploding:
        def send_task(self, *args: Any, **kwargs: Any) -> Any:
            raise ConnectionError("broker down")

    monkeypatch.setenv("QUEUE_MODE", "celery")
    monkeypatch.setattr(job_service, "_build_celery_app", lambda broker_url: Exploding())
    get_settings.cache_clear()

    # The Job row is already committed; a broker outage leaves it 'queued'.
    assert enqueue_job(_job()) is None


def test_dispatcher_is_reused_across_calls(env, monkeypatch: pytest.MonkeyPatch, fake_celery):
    monkeypatch.setenv("QUEUE_MODE", "celery")
    get_settings.cache_clear()
    assert get_dispatcher() is get_dispatcher()


# --- through the REST endpoint ---------------------------------------------


async def test_create_job_endpoint_dispatches_and_stores_task_id(
    env, monkeypatch: pytest.MonkeyPatch, fake_celery: FakeCelery, client: AsyncClient
):
    monkeypatch.setenv("QUEUE_MODE", "celery")
    get_settings.cache_clear()

    project = (await client.post("/api/projects", json={"name": "Site A"})).json()
    await client.post(f"/api/projects/{project['id']}/photos", files=upload_files(1))

    response = await client.post(f"/api/projects/{project['id']}/jobs", json={})
    assert response.status_code == 201, response.text
    body = response.json()

    assert body["task_id"] == "task-123"
    assert body["status"] == "queued"
    name, kwargs = fake_celery.calls[0]
    assert name == "worker.run_pipeline"
    assert kwargs["args"] == [body["id"], project["id"], {"stage": "ingest"}]

    # The stored row carries the task id too (not just the response).
    stored = (await client.get(f"/api/jobs/{body['id']}")).json()
    assert stored["task_id"] == "task-123"


async def test_create_job_endpoint_does_not_dispatch_when_queue_mode_none(
    env, fake_celery: FakeCelery, client: AsyncClient
):
    project = (await client.post("/api/projects", json={"name": "Site B"})).json()
    await client.post(f"/api/projects/{project['id']}/photos", files=upload_files(1))

    response = await client.post(f"/api/projects/{project['id']}/jobs", json={})

    assert response.status_code == 201
    assert response.json()["task_id"] is None
    assert fake_celery.calls == []


async def test_dispatch_forwards_job_params(client, project_with_photo, monkeypatch):
    """Tuning like downscale/matcher must reach the worker's task args."""
    from app import job_service

    sent: dict = {}

    class FakeDispatcher:
        def dispatch(self, job):
            sent["params"] = dict(job.params or {})
            sent["job_id"] = job.id
            return "task-123"

    monkeypatch.setattr(job_service, "get_dispatcher", lambda *a, **k: FakeDispatcher())

    payload = {"params": {"downscale": 2, "matcher": "sequential", "iterations": 7000}}
    response = await client.post(f"/api/projects/{project_with_photo['id']}/jobs", json=payload)
    assert response.status_code == 201, response.text
    assert response.json()["params"] == payload["params"]
    assert sent["params"] == payload["params"]


async def test_job_params_are_bounded(client, project_with_photo):
    huge = {f"key{i}": "x" for i in range(40)}
    response = await client.post(f"/api/projects/{project_with_photo['id']}/jobs", json={"params": huge})
    assert response.status_code == 422
