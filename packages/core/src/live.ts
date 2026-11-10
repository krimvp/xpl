/**
 * What `xpl live` reports at `GET /api/live` (ARCHITECTURE §5, "xpl live"). Type-only, like `WatchAttention`: the
 * CLI fills it in, the viewer reads it. Never embedded in a saved page.
 */
export interface LiveStatus {
  schema: "xpl-live@1";
  /** The guide `xpl live` keeps (its name: `live` by default). */
  guide: string;
  /**
   * `building`: an edit settled and a cycle runs (index, move the guide, record the change, draft); `watching`: the
   * last cycle finished and the guide matches the code; `failed`: the last cycle failed, the guide keeps the last
   * good state, and the next edit tries again.
   */
  state: "watching" | "building" | "failed";
  /** When the guide last matched the code (ISO time); null before the first cycle finished. */
  updatedAt: string | null;
  /** The commit id of the index the guide is on (`wt-35af5f4417` for a working tree); null before the first cycle. */
  index: string | null;
  /**
   * What the change is measured from. `rev` is what chose it: the `--since` revision, the default branch whose merge
   * base it is (`origin/main`), or `HEAD` at the first start. Null outside git or before the first commit.
   */
  base: { rev: string; sha: string; how: "since" | "merge-base" | "start" } | null;
  /** The recorded change (`explainer.change`) in numbers; null when the code is the code of the base. */
  change: { files: number; added: number; removed: number } | null;
  explanation: {
    /** `none`: nothing is spawned (the user's own agent writes, `reference/live.md`); `claude`: the installed CLI. */
    backend: "none" | "claude";
    /** `off` with backend none; `idle` between runs; `running` while one runs; `failed` after a run that failed. */
    state: "off" | "idle" | "running" | "failed";
    /** When a run of this process last applied an explanation (ISO time); null otherwise. */
    explainedAt: string | null;
    /**
     * The code moved since the explanation was written: the index commit differs from the one of the last applied
     * explanation (this process's run, else the `provenance.commit` of `tour:live`). False without a change.
     */
    stale: boolean;
    /** Why the last run failed; null otherwise. */
    error: string | null;
  };
  /** Why the last cycle failed (with `state: "failed"`); null otherwise. */
  error: string | null;
}

/** The tour the live agent writes and refreshes: what the change does to the architecture, part by part. */
export const LIVE_TOUR_ID = "tour:live";
