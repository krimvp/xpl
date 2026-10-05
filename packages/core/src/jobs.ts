/** Portable job history and #30 revision review packets. Filesystem ownership stays in the CLI. */
import type { ArtifactIdentity, ReadinessReport } from "./readiness.js";
import type { FeedbackRequest, FeedbackStatus } from "./feedback.js";
import type { Issue } from "./validate.js";
import type { ResolveReport } from "./anchors.js";

export interface Job {
  id: string;
  scope: { kind: "revision"; guide: string; include: string[] };
  selectedRequestIds: string[];
  input: {
    revisionRunId: string;
    expected: ArtifactIdentity;
    index: string;
    requests: FeedbackRequest[];
  };
  state: "queued" | "running" | "completed" | "failed" | "cancelled" | "superseded" | "interrupted";
  createdAt: string;
  updatedAt: string;
  attempt: number;
  owner: {
    instanceId: string;
    attemptId: string;
    process?: { groupId: number; startTime: string };
  } | null;
  progress: { at: string; message: string }[];
  error: string | null;
  /** accepted is a display receipt derived from the matching done revision journal. */
  result: { revisionRunId: string; accepted?: boolean } | null;
  cleanup?: { groupId?: number; startTime?: string };
}
export interface RevisionDecision {
  id: string;
  status: Exclude<FeedbackStatus, "pending">;
  reason: string;
  reconciliation?: string;
  missing?: { id: string; action: "reanchor" | "remove" }[];
}
export interface RevisionChange {
  id: string;
  before: unknown;
  after: unknown;
}
export interface RevisionReview {
  ok: boolean;
  runId: string;
  state: "selected" | "proposed" | "reviewed" | "committing" | "committed" | "done";
  expected: ArtifactIdentity;
  index: string;
  previousArtifact: string;
  requests: (FeedbackRequest & { contextReason: string | null })[];
  include: string[];
  resolve: ResolveReport;
  decisions: RevisionDecision[];
  changes: RevisionChange[];
  proposals: { id: string; changes: RevisionChange[] }[];
  sourceBefore: RevisionSource[];
  source: RevisionSource[];
  issues: Issue[];
  readiness?: ReadinessReport;
}
export interface RevisionSource {
  file: string;
  side: "head" | "base";
  text: string | null;
}
export interface JobReviewAction {
  attemptId: string;
  decisions?: RevisionDecision[];
  accept?: boolean;
}
