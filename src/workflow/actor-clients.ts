import { TaigaClient, credentialsFromEnv } from "../client.js";
import { accountBindingProblem } from "./account-binding.js";
import { actorFor, type ActorConfig, type ActorRole } from "./actor.js";

// One Taiga session per actor, so Taiga itself records who acted. An actor that can authenticate to the MCP must own a Taiga account:
// a missing one is a startup error, never a silent fall back to somebody else's session.
export function loadActorClients(actors: ActorConfig, env: NodeJS.ProcessEnv = process.env): Map<ActorRole, TaigaClient> {
  return new Map([...actors.tokens.keys()].map((role) => [role, new TaigaClient(credentialsFromEnv(env, role))]));
}

// Logs every actor in and checks it is the account the configuration expects for that role (when account binding is on).
export async function verifyActorAccounts(clients: Map<ActorRole, TaigaClient>, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  for (const [role, client] of clients) {
    const problem = await accountBindingProblem(client, actorFor(role), env);
    if (problem) throw new Error(problem);
  }
}
