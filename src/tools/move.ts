import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TaigaClient } from "../client.js";

type Item = { id: number; order: number; raw: Record<string, any> };
type Outcome = { moved: boolean; noop?: string; order: number[]; verified?: boolean; [k: string]: unknown };

const asResult = (body: unknown, isError = false) => ({
  ...(isError ? { isError: true as const } : {}),
  content: [{ type: "text" as const, text: JSON.stringify(body) }],
});
const ids = (items: Item[]) => items.map((i) => i.id);

// Where the moved item lands: next to an anchor, on its before/after side.
function plan(items: Item[], id: number, a: { direction?: string; before_id?: number; after_id?: number }) {
  const idx = items.findIndex((i) => i.id === id);
  if (idx < 0) return { error: "not_in_container" as const };
  let anchor: Item | undefined;
  let side: "before" | "after";
  if (a.direction === "up" || a.direction === "down") {
    anchor = items[a.direction === "up" ? idx - 1 : idx + 1];
    side = a.direction === "up" ? "before" : "after";
    if (!anchor) return { noop: a.direction === "up" ? "already_first" : "already_last" };
  } else {
    side = a.before_id !== undefined ? "before" : "after";
    anchor = items.find((i) => i.id === (a.before_id ?? a.after_id));
    if (!anchor) return { error: "anchor_not_in_container" as const };
    if (anchor.id === id) return { error: "anchor_is_self" as const };
  }
  const rest = items.filter((i) => i.id !== id);
  const at = rest.findIndex((i) => i.id === anchor!.id) + (side === "after" ? 1 : 0);
  const seq = [...rest.slice(0, at), items[idx], ...rest.slice(at)];
  if (ids(seq).join() === ids(items).join()) return { noop: "already_in_place" };
  return { seq, anchor, side };
}

export function registerMoveTools(server: McpServer, client: TaigaClient) {
  const sortItems = (rows: any[], key: string, idKey = "id"): Item[] =>
    rows
      .map((raw, i) => ({ raw, i }))
      .sort((a, b) => (typeof a.raw[key] === "number" && typeof b.raw[key] === "number" ? a.raw[key] - b.raw[key] : 0) || a.i - b.i)
      .map(({ raw }) => ({ id: raw[idKey], order: raw[key], raw }));

  const readColumn = async (params: Record<string, unknown>) =>
    sortItems((await client.get("/tasks", { ...params, order_by: "taskboard_order" })) as any[], "taskboard_order");
  const bulk = (endpoint: string, body: Record<string, unknown>, seq: Item[]) =>
    client.post(`/tasks/${endpoint}`, { ...body, bulk_tasks: seq.map((t, i) => ({ task_id: t.id, order: i + 1 })) });

  server.tool(
    "taiga_move",
    "Move a Task, Story or Sprint by intent (direction up/down, or before_id/after_id), never by raw order numbers. kind task = move inside the Task's own taskboard column (same status and Sprint) by taskboard_order, the only Task position (container_id = the Task's Sprint); story_in_sprint (container_id = Sprint); story_in_epic (container_id = Epic); sprint is a typed limitation (no supported order API). Re-reads after writing and returns the verified order; boundary and in-place moves are no-ops with zero writes.",
    {
      kind: z.enum(["task", "story_in_sprint", "story_in_epic", "sprint"]),
      id: z.number().describe("ID of the item to move (Task, Story or Sprint ID)"),
      container_id: z.number().describe("Sprint ID for task/story_in_sprint; Epic ID for story_in_epic; Project ID for sprint"),
      direction: z.enum(["up", "down"]).optional(),
      before_id: z.number().optional().describe("Place the item right before this sibling ID"),
      after_id: z.number().optional().describe("Place the item right after this sibling ID"),
    },
    async ({ kind, id, container_id, direction, before_id, after_id }) => {
      const intents = [direction, before_id, after_id].filter((x) => x !== undefined).length;
      if (intents !== 1) return asResult({ moved: false, code: "invalid_intent", message: "Provide exactly one of direction, before_id, after_id." }, true);
      if (kind === "sprint") {
        return asResult({ moved: false, code: "sprint_order_unsupported", message: "This Taiga deployment has no supported Sprint-order API (Issue #89); Sprint position cannot be changed." }, true);
      }
      const a = { direction, before_id, after_id };
      const fail = (code: string) => asResult({ moved: false, code }, true);
      const done = async (p: ReturnType<typeof plan> & { seq: Item[] }, reread: () => Promise<Item[]>, extra: Record<string, unknown> = {}) => {
        const order = ids(await reread());
        // An attempted taskboard alignment that did not verify fails the whole move closed.
        const verified = order.join() === ids(p.seq).join() && extra.taskboard !== "unverified";
        return asResult({ moved: true, order, verified, ...extra }, !verified);
      };

      if (kind === "task") {
        const task = (await client.get(`/tasks/${id}`)) as any;
        if (task.milestone !== container_id) return fail("container_is_not_the_task_sprint");
        const col = { milestone: container_id, status: task.status };
        const items = await readColumn(col);
        const p = plan(items, id, a);
        if ("error" in p) return fail(p.error!);
        if ("noop" in p) return asResult({ moved: false, noop: p.noop, order: ids(items) });
        await bulk("bulk_update_taskboard_order", { project_id: task.project, status_id: task.status, milestone_id: container_id }, p.seq!);
        return done(p as any, async () => readColumn(col));
      }

      if (kind === "story_in_sprint") {
        const read = async () => sortItems((await client.get("/userstories", { milestone: container_id, order_by: "sprint_order" })) as any[], "sprint_order");
        const items = await read();
        const p = plan(items, id, a);
        if ("error" in p) return fail(p.error!);
        if ("noop" in p) return asResult({ moved: false, noop: p.noop, order: ids(items) });
        const sprint_order = p.side === "before" ? p.anchor!.order : p.anchor!.order + 1;
        await client.patch(`/userstories/${id}`, { sprint_order, version: items.find((i) => i.id === id)!.raw.version });
        return done(p as any, read);
      }

      // story_in_epic: the relation has no id of its own, it is addressed by the Story
      const read = async () => sortItems((await client.get(`/epics/${container_id}/related_userstories`)) as any[], "order", "user_story");
      const items = await read();
      const p = plan(items, id, a);
      if ("error" in p) return fail(p.error!);
      if ("noop" in p) return asResult({ moved: false, noop: p.noop, order: ids(items) });
      const order = p.side === "before" ? p.anchor!.order : p.anchor!.order + 1;
      await client.patch(`/epics/${container_id}/related_userstories/${id}`, { order });
      return done(p as any, read);
    },
  );
}
