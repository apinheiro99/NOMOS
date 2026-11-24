import type { TaigaClient } from "../client.js";
import type { ActorContext, ActorRole } from "./actor.js";
import { rejection, type RejectInfo } from "./reject.js";

// Binds the MCP actor (transport-authenticated role) to the Taiga account this process is logged in as. Configuration owns the values:
// TAIGA_MCP_EXPECTED_ACCOUNT_GPT / _CLAUDE / _PO hold the Taiga username each role must authenticate as. Nothing set = binding off (legacy
// behaviour); any set = ON, and then a role without an expected account, or an account that differs, fails closed before a governed write.
const ROLES: ActorRole[] = ["gpt", "claude", "po"];
const expectedVar = (role: ActorRole) => `TAIGA_MCP_EXPECTED_ACCOUNT_${role.toUpperCase()}`;

export async function accountBindingProblem(client: TaigaClient, actor: ActorContext, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (!ROLES.some((r) => env[expectedVar(r)])) return null;
  const expected = env[expectedVar(actor.role)];
  if (!expected) return `account binding is on but ${expectedVar(actor.role)} is not configured for the ${actor.role} actor`;
  const username = await client.authenticatedUsername();
  return username === expected ? null : `the ${actor.role} actor is bound to Taiga account "${expected}" but this process authenticated as "${username}"`;
}

export async function bindingRejection(client: TaigaClient, actor: ActorContext, base: Omit<RejectInfo, "code" | "message">) {
  const problem = await accountBindingProblem(client, actor);
  return problem ? rejection({ ...base, code: "WORKFLOW_IDENTITY_MISMATCH", message: problem }) : null;
}
