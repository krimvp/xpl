"""A tiny synchronous publish/subscribe bus keyed by topic name."""

from __future__ import annotations

import logging
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

log = logging.getLogger(__name__)

Listener = Callable[[Any], None]


@dataclass(frozen=True)
class JobCompleted:
    """Payload of the "job.completed" topic, published by Worker.run."""

    job_id: str
    kind: str
    duration_ms: float


class EventBus:
    """Publishers and subscribers share only a topic name and a payload shape."""

    def __init__(self) -> None:
        self._listeners: defaultdict[str, list[Listener]] = defaultdict(list)

    def on(self, topic: str, listener: Listener) -> None:
        """Subscribes `listener` to `topic`."""
        self._listeners[topic].append(listener)

    def emit(self, topic: str, payload: Any) -> None:
        """Delivers `payload` to every subscriber of `topic`. A failing listener cannot break the emitter."""
        for listener in list(self._listeners.get(topic, [])):
            try:
                listener(payload)
            except Exception:
                log.exception("listener for %r failed", topic)
