import type { ArtifactType } from "../workflow/policy.js";

// The artifacts a transition may require. The type below fails the build if one is added to ArtifactType and not listed here.
export const ARTIFACT_TYPES = [
  "implementation_blueprint", "execution_handoff", "validation_approval",
  "human_decision_request", "blocker_report", "po_decision", "workflow_request", "request_resume",
  "story_start", "story_validation_handoff", "story_validation_approval", "story_correction",
] as const satisfies readonly ArtifactType[];

type Unlisted = Exclude<ArtifactType, (typeof ARTIFACT_TYPES)[number]>;
export const everyArtifactIsListed: [Unlisted] extends [never] ? true : never = true;
