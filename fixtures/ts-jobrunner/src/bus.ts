/** Payload of the "job.completed" topic, published by Worker.run. */
export interface JobCompleted {
  jobId: string;
  type: string;
  durationMs: number;
}

export type Listener<T = unknown> = (payload: T) => void;

/**
 * A minimal synchronous publish/subscribe bus. Topics are plain strings, so a
 * publisher and its subscribers share only a topic name and a payload shape.
 */
export class EventBus {
  private readonly listeners: Map<string, Listener[]> = new Map();

  /** Subscribes `listener` to `topic`. */
  on<T = unknown>(topic: string, listener: Listener<T>): void {
    const existing = this.listeners.get(topic) ?? [];
    this.listeners.set(topic, [...existing, listener as Listener]);
  }

  /** Delivers `payload` to every subscriber of `topic`. A throwing listener cannot break the emitter. */
  emit(topic: string, payload: unknown): void {
    for (const listener of this.listeners.get(topic) ?? []) {
      try {
        listener(payload);
      } catch (err) {
        console.error(`listener for "${topic}" threw:`, err);
      }
    }
  }
}
