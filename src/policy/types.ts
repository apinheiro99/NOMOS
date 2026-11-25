import type { ActorRole } from "../workflow/actor.js";
import type { ArtifactType, BlueprintMode, EntityKind } from "../workflow/policy.js";

// A policy is data. Keys are the normalized status names the project really has; owner is a role or null (Done/Cancelled).
export interface TransitionRule { from: string; to: string; allow: ActorRole[]; artifact: ArtifactType; mode?: BlueprintMode }

export interface EntityPolicy {
  states: Record<string, { owner: ActorRole | null }>;
  // The targets whose arrival is governed by a typed artifact. Any other target is a plain (legacy) update.
  governed: "all" | string[];
  transitions: TransitionRule[];
}

export interface Policy { schemaVersion: 1; roles: ActorRole[]; entities: Record<EntityKind, EntityPolicy> }

export type Decision =
  | { kind: "typed"; artifact: ArtifactType; mode?: BlueprintMode; override: boolean }
  | { kind: "legacy" }
  | { kind: "denied"; reason: string };
