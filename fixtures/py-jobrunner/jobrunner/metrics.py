"""Metrics that are fed by bus events, never by direct calls from the worker."""

from __future__ import annotations

from dataclasses import dataclass, field

from .bus import EventBus, JobCompleted


@dataclass
class Metrics:
    prefix: str
    completed: int = 0
    total_duration_ms: float = 0.0
    completed_by_kind: dict[str, int] = field(default_factory=dict)


def on_job_completed(metrics: Metrics, event: JobCompleted) -> None:
    """Handles "job.completed". Nothing calls this directly: it only runs when the bus delivers an event."""
    metrics.completed += 1
    metrics.total_duration_ms += event.duration_ms
    metrics.completed_by_kind[event.kind] = metrics.completed_by_kind.get(event.kind, 0) + 1


def register_metrics(bus: EventBus, metrics: Metrics) -> None:
    """Wires the metrics handlers to the bus."""
    bus.on("job.completed", lambda event: on_job_completed(metrics, event))


def format_metrics(metrics: Metrics) -> list[str]:
    """Renders the counters as `name value` lines, each name starting with the configured prefix."""
    lines = [
        f"{metrics.prefix}.jobs.completed {metrics.completed}",
        f"{metrics.prefix}.jobs.duration_ms_total {round(metrics.total_duration_ms)}",
    ]
    for kind, count in metrics.completed_by_kind.items():
        lines.append(f'{metrics.prefix}.jobs.completed{{kind="{kind}"}} {count}')
    return lines
