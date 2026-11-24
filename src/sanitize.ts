// What the MCP never exposes from a Taiga response: server-rendered *_html duplicates (description_html, blocked_note_html, ...),
// so responses carry each text once, and the extra position fields: Task `us_order` (taskboard_order is the only Task position) and
// Story `kanban_order` / `backlog_order` (sprint_order is the only Story position). `keep` lets an internal read keep named keys.
const HIDDEN_ORDER_KEYS = new Set(["us_order", "kanban_order", "backlog_order"]);
export function sanitizeResponse(value: unknown, keep: readonly string[] = []): unknown {
  if (Array.isArray(value)) return value.map((v) => sanitizeResponse(v, keep));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (key.endsWith("_html") || (HIDDEN_ORDER_KEYS.has(key) && !keep.includes(key))) continue;
      out[key] = sanitizeResponse(v, keep);
    }
    return out;
  }
  return value;
}
