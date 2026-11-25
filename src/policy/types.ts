import type { ActorRole } from "../workflow/actor.js";
import type { ArtifactType, BlueprintMode, EntityKind } from "../workflow/policy.js";

// A slot is a fixed role or a per-Task field (Executor/Validator, matrix v2) the server reads as a fact.
export type Slot = ActorRole | { field: "executor" | "validator" };
// Facts about the one Task being decided: who currently holds each field.
export type Facts = Partial<Record<"executor" | "validator", ActorRole>>;

// A policy is data. Keys are the normalized status names the project really has; owner is a slot or null.
export interface TransitionRule { from: string; to: string; allow: Slot[]; artifact: ArtifactType; mode?: BlueprintMode }

export interface EntityPolicy {
  states: Record<string, { owner: Slot | null }>;
  // The targets whose arrival is governed by a typed artifact. Any other target is a plain (legacy) update.
  governed: "all" | string[];
  transitions: TransitionRule[];
}

// `operations` is the explicit permission list of the non-workflow writes (the catalog's baseline and bootstrap operations): which roles may call each.
// An operation that is not listed is denied; the workflow operations are decided by the transitions instead.
export interface Policy { schemaVersion: 1; roles: ActorRole[]; operations: Record<string, ActorRole[]>; entities: Record<EntityKind, EntityPolicy> }

export type Decision =
  | { kind: "typed"; artifact: ArtifactType; mode?: BlueprintMode; override: boolean }
  | { kind: "legacy" }
  | { kind: "denied"; reason: string };
