import type pg from "pg";
import type { TaigaClient } from "../client.js";
import { mirrorProjects } from "../policy/mirror.js";
import { getProject, getVersion, listAudit, listProjects, listVersions, schemaVersion } from "../policy/queries.js";
import { approve, PolicyError, propose, reject, rollback, simulate } from "../policy/service.js";
import type { Policy } from "../policy/types.js";
import { norm } from "../workflow/policy.js";
import { approveBody, pageQuery, proposalsQuery, reconcileBody, proposeBody, rejectBody, rollbackBody, simulateBody, uuid } from "./schemas.js";

export interface ApiRequest { method: string; path: string; query: URLSearchParams; body: unknown }
export interface ApiResponse { status: number; body: unknown }

// The admin API has one principal: the authenticated PO. A role written in a request body is never read (the schemas reject extra keys).
const PO = "po" as const;
const ok = (body: unknown, status = 200): ApiResponse => ({ status, body });
const notFound = (what: string) => new PolicyError(404, "not_found", `${what} does not exist`);

// What the mirror needs to read Taiga: the PO's session and the instance it belongs to. Absent in a process that cannot reach Taiga.
export interface MirrorDeps { client: TaigaClient; baseUrl: string }
type Handler = (db: pg.Pool, p: string[], r: ApiRequest, mirror?: MirrorDeps) => Promise<ApiResponse>;
const routes: { method: string; pattern: RegExp; handle: Handler }[] = [];
const route = (method: string, pattern: string, handle: Handler) =>
  routes.push({ method, pattern: new RegExp(`^${pattern.replace(/:id/g, "([^/]+)").replace(/:revision/g, "(\\d+)")}$`), handle });
const projectId = (p: string[]) => uuid.parse(p[0]);

route("GET", "/health", async (db) => ok({ status: "ok", schema: await schemaVersion(db), build: process.env.TAIGA_MCP_BUILD ?? null }));
route("GET", "/projects", async (db, _p, r) => ok({ items: await listProjects(db, pageQuery.parse(Object.fromEntries(r.query))) }));
route("GET", "/projects/:id", async (db, p) => ok((await getProject(db, projectId(p))) ?? (() => { throw notFound("project"); })()));
route("GET", "/projects/:id/policies", async (db, p, r) => ok({ items: await listVersions(db, projectId(p), pageQuery.parse(Object.fromEntries(r.query))) }));
route("GET", "/projects/:id/policies/:revision", async (db, p) => ok((await getVersion(db, projectId(p), Number(p[1]))) ?? (() => { throw notFound("revision"); })()));
route("GET", "/projects/:id/proposals", async (db, p, r) => {
  const q = proposalsQuery.parse(Object.fromEntries(r.query));
  return ok({ items: await listVersions(db, projectId(p), q, q.state ?? "pending") });
});
route("GET", "/projects/:id/audit", async (db, p, r) => ok({ items: await listAudit(db, projectId(p), pageQuery.parse(Object.fromEntries(r.query))) }));
route("POST", "/projects/:id/simulate", async (db, p, r) => ok(await simulate(db, projectId(p), simulateBody.parse(r.body))));
route("POST", "/projects/:id/proposals", async (db, p, r) => ok(await propose(db, projectId(p), PO, proposeBody.parse(r.body).policy as Policy), 201));
route("POST", "/projects/:id/proposals/:revision/approve", async (db, p, r, mirror) => {
  const policyId = await policyIdOf(db, p);
  if (mirror) await requireTasksInKnownStates(db, mirror.client, projectId(p), policyId);
  return ok(await approve(db, projectId(p), PO, { policyId, ...approveBody.parse(r.body) }));
});
route("POST", "/projects/:id/proposals/:revision/reject", async (db, p, r) => ok(await reject(db, projectId(p), PO, { policyId: await policyIdOf(db, p), ...rejectBody.parse(r.body) })));
route("POST", "/reconcile", async (db, _p, r, mirror) => {
  if (!mirror) throw new PolicyError(503, "mirror_unavailable", "this process has no Taiga session to mirror from");
  return ok(await mirrorProjects(db, mirror.client, mirror.baseUrl, { apply: reconcileBody.parse(r.body ?? {}).apply }));
});
route("POST", "/projects/:id/rollback", async (db, p, r) => ok(await rollback(db, projectId(p), PO, rollbackBody.parse(r.body).toRevision), 201));

// An open Task sitting in a status the new policy does not know would be orphaned by the change: the approval is refused and the cards are listed.
async function requireTasksInKnownStates(db: pg.Pool, client: TaigaClient, project: string, policyId: string): Promise<void> {
  const { rows } = await db.query<{ taiga_project_id: string; payload: Policy }>(
    "SELECT b.taiga_project_id, v.payload FROM project_binding b JOIN policy_version v ON v.project_id = b.id WHERE b.id = $1 AND v.id = $2", [project, policyId]);
  if (!rows[0]) throw notFound("proposal");
  const known = new Set(Object.keys(rows[0].payload.entities.task.states));
  const open = (await client.get("/tasks", { project: Number(rows[0].taiga_project_id), status__is_closed: false })) as { ref: number; status_extra_info?: { name?: string } }[];
  const orphaned = open.filter((t) => !known.has(norm(t.status_extra_info?.name ?? "")));
  if (orphaned.length) throw new PolicyError(409, "tasks_in_unknown_state", `${orphaned.length} open Task(s) sit in a status this policy does not have: ${orphaned.map((t) => `#${t.ref}`).join(", ")}`);
}

// A proposal is addressed by its revision number in the URL, as the History screen shows it.
async function policyIdOf(db: pg.Pool, p: string[]): Promise<string> {
  const v = (await getVersion(db, projectId(p), Number(p[1]))) as { id: string } | null;
  if (!v) throw notFound("proposal");
  return v.id;
}

export function createAdminApi(pool: pg.Pool, mirror?: MirrorDeps) {
  return async (req: ApiRequest): Promise<ApiResponse> => {
    const candidates = routes.filter((r) => r.pattern.test(req.path));
    if (!candidates.length) throw notFound("route");
    const hit = candidates.find((r) => r.method === req.method);
    if (!hit) throw new PolicyError(405, "method_not_allowed", `${req.method} is not allowed here`);
    return hit.handle(pool, hit.pattern.exec(req.path)!.slice(1), req, mirror);
  };
}
