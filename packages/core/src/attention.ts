/** Live managed-service attention. Never embedded in portable explanation snapshots. */
export interface WatchAttention {
  enabled: boolean;
  instanceId: string;
  watch: {
    state: "pending" | "building" | "current" | "failed" | "paused" | "stopped";
    stale: boolean;
    generation: number;
    index: { path: string; commit: string } | null;
    error: string | null;
  } | null;
  guides: {
    name: string;
    path: string | null;
    title: string;
    counts: { moved: number; drifted: number; missing: number } | null;
    elements: { id: string; file: string; status: "moved" | "drifted" | "missing" }[];
    errors: string[];
    revisionCommand: string;
  }[];
}
