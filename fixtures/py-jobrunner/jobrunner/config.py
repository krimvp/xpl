"""Loads config/default.yaml. The YAML subset is tiny, so it is parsed by hand."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

Scalar = str | int | float | bool
Sections = dict[str, dict[str, Scalar]]


class ConfigError(ValueError):
    """The config file is malformed or is missing a value."""


@dataclass(frozen=True)
class QueueConfig:
    name: str
    max_pending: int
    idle_delay_ms: int


@dataclass(frozen=True)
class WorkersConfig:
    count: int
    name_prefix: str
    timeout_ms: int


@dataclass(frozen=True)
class RetryConfig:
    max_retries: int
    base_delay_ms: int
    max_delay_ms: int


@dataclass(frozen=True)
class MetricsConfig:
    enabled: bool
    prefix: str
    print_summary: bool


@dataclass(frozen=True)
class Config:
    queue: QueueConfig
    workers: WorkersConfig
    retry: RetryConfig
    metrics: MetricsConfig


@dataclass(frozen=True)
class RunnerConfig:
    """The slice of configuration the runner needs."""

    idle_delay_ms: int
    timeout_ms: int
    retry: RetryConfig

    @classmethod
    def from_config(cls, config: Config) -> RunnerConfig:
        """Picks the values the runner needs out of a full config."""
        return cls(config.queue.idle_delay_ms, config.workers.timeout_ms, config.retry)


def parse_yaml(text: str) -> Sections:
    """Parses the YAML subset used by config/default.yaml.

    Top-level `section:` lines, each followed by indented `key: value` lines.
    Comments start with `#`.
    """
    sections: Sections = {}
    current: dict[str, Scalar] | None = None

    for number, raw in enumerate(text.splitlines(), start=1):
        line = re.sub(r"(^|\s)#.*$", "", raw).rstrip()
        if not line.strip():
            continue

        key, colon, value = line.partition(":")
        if not colon:
            raise ConfigError(f"config line {number}: expected 'key: value'")
        key, value = key.strip(), value.strip()

        if not line[0].isspace():
            if value:
                raise ConfigError(f"config line {number}: section {key!r} cannot have a value")
            current = sections[key] = {}
        elif current is None:
            raise ConfigError(f"config line {number}: {key!r} is outside any section")
        else:
            current[key] = _parse_scalar(value)
    return sections


def _parse_scalar(value: str) -> Scalar:
    if value in ("true", "false"):
        return value == "true"
    if re.fullmatch(r"-?\d+", value):
        return int(value)
    if re.fullmatch(r"-?\d+\.\d+", value):
        return float(value)
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def load_config(path: Path) -> Config:
    """Reads and validates a config file."""
    sections = parse_yaml(path.read_text(encoding="utf-8"))

    def text(section: str, key: str) -> str:
        return str(_lookup(sections, section, key))

    def number(section: str, key: str) -> int:
        value = _lookup(sections, section, key)
        if isinstance(value, bool) or not isinstance(value, int):
            raise ConfigError(f"config: {section}.{key} must be a whole number")
        return value

    def flag(section: str, key: str) -> bool:
        value = _lookup(sections, section, key)
        if not isinstance(value, bool):
            raise ConfigError(f"config: {section}.{key} must be true or false")
        return value

    return Config(
        queue=QueueConfig(text("queue", "name"), number("queue", "maxPending"), number("queue", "idleDelayMs")),
        workers=WorkersConfig(
            number("workers", "count"), text("workers", "namePrefix"), number("workers", "timeoutMs")
        ),
        retry=RetryConfig(number("retry", "maxRetries"), number("retry", "baseDelayMs"), number("retry", "maxDelayMs")),
        metrics=MetricsConfig(flag("metrics", "enabled"), text("metrics", "prefix"), flag("metrics", "printSummary")),
    )


def _lookup(sections: Sections, section: str, key: str) -> Scalar:
    try:
        return sections[section][key]
    except KeyError:
        raise ConfigError(f"config: missing {section}.{key}") from None
