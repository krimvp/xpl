import type { EventBus, JobCompleted } from "./bus.ts";

export interface Metrics {
  prefix: string;
  completed: number;
  totalDurationMs: number;
  completedByType: Map<string, number>;
}

export function createMetrics(prefix: string): Metrics {
  return { prefix, completed: 0, totalDurationMs: 0, completedByType: new Map() };
}

/** Handles "job.completed". Nothing calls this directly: it only runs when the bus delivers an event. */
export function onJobCompleted(metrics: Metrics, event: JobCompleted): void {
  metrics.completed += 1;
  metrics.totalDurationMs += event.durationMs;
  metrics.completedByType.set(event.type, (metrics.completedByType.get(event.type) ?? 0) + 1);
}

/** Wires the metrics handlers to the bus. */
export function registerMetrics(bus: EventBus, metrics: Metrics): void {
  bus.on<JobCompleted>("job.completed", (event) => onJobCompleted(metrics, event));
}

/** Renders the counters as `name value` lines, each name starting with the configured prefix. */
export function formatMetrics(metrics: Metrics): string[] {
  const lines = [
    `${metrics.prefix}.jobs.completed ${metrics.completed}`,
    `${metrics.prefix}.jobs.duration_ms_total ${metrics.totalDurationMs}`,
  ];
  for (const [type, count] of metrics.completedByType) {
    lines.push(`${metrics.prefix}.jobs.completed{type="${type}"} ${count}`);
  }
  return lines;
}
