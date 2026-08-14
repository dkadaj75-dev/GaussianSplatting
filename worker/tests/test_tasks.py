from __future__ import annotations

import pytest

from worker.backends import FakeBackend
from worker.config import Settings
from worker.tasks import InMemoryPublisher, run_pipeline


def settings(tmp_path):
    return Settings(
        redis_url="redis://unused:6379/0",
        storage_dir=tmp_path,
        pipeline_backend="fake",
    )


def run_task_directly(monkeypatch, tmp_path, backend, publisher):
    """Call Celery's underlying task function without a broker."""
    monkeypatch.setattr("worker.tasks.get_settings", lambda: settings(tmp_path))
    monkeypatch.setattr("worker.tasks.get_backend", lambda _settings: backend)
    monkeypatch.setattr("worker.tasks.get_publisher", lambda _settings: publisher)
    return run_pipeline.run("job-1", "project-1", {"quality": "test"})


def test_fake_pipeline_runs_stages_in_order_and_publishes_artifacts(tmp_path, monkeypatch):
    publisher = InMemoryPublisher()
    result = run_task_directly(monkeypatch, tmp_path, FakeBackend(), publisher)

    ordered_stages = []
    for event in publisher.events:
        if event["status"] == "running" and (not ordered_stages or ordered_stages[-1] != event["stage"]):
            ordered_stages.append(event["stage"])
    assert ordered_stages == ["ingest", "sfm", "train", "compress", "publish"]
    assert publisher.events[-1]["status"] == "done"
    assert publisher.events[-1]["stage"] == "publish"

    for stage in ordered_stages:
        values = [event["progress"] for event in publisher.events if event["stage"] == stage and event["status"] == "running"]
        assert values == sorted(values)
        assert values[-1] == 1.0

    output_dir = tmp_path / "projects" / "project-1" / "jobs" / "job-1" / "output"
    assert result["output_dir"] == str(output_dir)
    assert (output_dir / "output.ply").exists()
    assert (output_dir / "scene.splat").exists()


class FailingBackend(FakeBackend):
    def train(self, job, progress):
        progress("train", 0.25, "training started")
        raise RuntimeError("GPU unavailable")


def test_failure_publishes_failed_event_and_reraises(tmp_path, monkeypatch):
    publisher = InMemoryPublisher()

    with pytest.raises(RuntimeError, match="GPU unavailable"):
        monkeypatch.setattr("worker.tasks.get_settings", lambda: settings(tmp_path))
        monkeypatch.setattr("worker.tasks.get_backend", lambda _settings: FailingBackend())
        monkeypatch.setattr("worker.tasks.get_publisher", lambda _settings: publisher)
        run_pipeline.run("job-2", "project-1", {})

    failed = publisher.events[-1]
    assert failed["status"] == "failed"
    assert failed["stage"] == "train"
    assert failed["message"] == "GPU unavailable"
