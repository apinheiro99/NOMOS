import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { renderText } from "./render.js";

// The MCP SDK's tool registration is patched here, so the shapes it needs are named once.
export type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[]; [k: string]: unknown };
export type ToolHandler<A = Record<string, unknown>> = (args: A, extra: unknown) => Promise<ToolResult>;
export type ToolRegister<A = Record<string, unknown>> = (name: string, description: string, schema: Record<string, unknown>, handler: ToolHandler<A>) => unknown;

// Always kept so a projected read can still be used to mutate (version) and to be referenced (id, ref).
const KEEP = ["id", "ref", "version"];

export function projectFields(value: unknown, fields: string | undefined): unknown {
  const wanted = (fields ?? "").split(",").map((f) => f.trim()).filter(Boolean);
  if (wanted.length === 0) return value;
  const pick = (item: unknown): unknown => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const src = item as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of [...KEEP, ...wanted]) if (key in src) out[key] = src[key];
    return out;
  };
  return Array.isArray(value) ? value.map(pick) : pick(value);
}

// Projects a tool result; anything that is not a JSON text result (errors, empty content) is returned intact.
export function applyFields(res: ToolResult, fields: string | undefined): ToolResult {
  if (!fields || !res || res.isError) return res;
  const text = res.content?.[0]?.text;
  if (typeof text !== "string") return res;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return res;
  }
  return { ...res, content: [{ type: "text" as const, text: JSON.stringify(projectFields(parsed, fields)) }] };
}

const READ_TOOLS = /^taiga_((epics|userstories|tasks|issues|milestones)_(list|get|get_by_ref)|(userstory|task|issue|wiki)_history|search)$/;

// Decoration and ordering noise that compact reads drop; everything else is kept.
const NOISE = /extra_info|gravatar|photo|watchers|voters|is_watcher|is_voter|_order$|^order$/;

// History entries repeat each change as id-based `diff` and name-based `values_diff`; text keeps the readable one.
const HISTORY_NOISE = /^(values|snapshot|key|is_hidden|is_snapshot|comment_html)$/;

// `diff` is dropped only where `values_diff` already says the same; description edits exist only in `diff`, so they stay.
const dedupeHistory = (v: unknown): unknown => {
  if (!Array.isArray(v)) return v;
  return v.map((e) => {
    const entry = e as { diff?: object; values_diff?: object } | null;
    if (!entry || typeof entry !== "object" || !entry.diff || typeof entry.diff !== "object") return e;
    const seen = entry.values_diff && typeof entry.values_diff === "object" ? entry.values_diff : {};
    const only = Object.fromEntries(Object.entries(entry.diff).filter(([k]) => !(k in seen)));
    return { ...entry, diff: Object.keys(only).length ? only : undefined };
  });
};

const stripNoise = (v: unknown, extra?: RegExp): unknown => {
  if (Array.isArray(v)) return v.map((x) => stripNoise(x, extra));
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(
    Object.entries(v).filter(([k]) => !NOISE.test(k) && !extra?.test(k)).map(([k, x]) => [k, stripNoise(x, extra)]),
  );
};

// Shapes a read result. format=text (default) renders compact plain text without noise; format=json keeps the JSON,
// optionally projected by `fields` or stripped of noise by `compact`. Errors and non-JSON results pass through intact.
function shapeRead(res: ToolResult, format: "text" | "json", fields: string | undefined, compact: boolean | undefined, history: boolean): ToolResult {
  if (!res || res.isError) return res;
  const text = res.content?.[0]?.text;
  if (typeof text !== "string") return res;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return res;
  }
  if (fields) parsed = projectFields(parsed, fields);
  else if (compact || format === "text") {
    const historyText = format === "text" && history;
    parsed = stripNoise(historyText ? dedupeHistory(parsed) : parsed, historyText ? HISTORY_NOISE : undefined);
  }
  else return res;
  return { ...res, content: [{ type: "text" as const, text: format === "text" ? renderText(parsed) : JSON.stringify(parsed) }] };
}

// Adds `format` (text by default, or json) plus optional `fields` and `compact` to the read tools without touching each tool.
// An explicit `fields` wins over `compact`; `compact` only matters for format=json (text already drops the noise).
export function addFieldsParam(server: McpServer): void {
  const register = server.tool.bind(server) as unknown as ToolRegister;
  (server as unknown as { tool: ToolRegister }).tool = (name, description, schema, handler) => {
    if (!READ_TOOLS.test(name)) return register(name, description, schema, handler);
    const withFields = {
      ...schema,
      format: z.enum(["text", "json"]).optional().describe(
        "Response format. Default text: compact plain text with the same data, without JSON syntax or decoration noise. json: the raw JSON (use fields or compact to shrink it).",
      ),
      fields: z.string().optional().describe(
        "Comma-separated field names to return (id, ref and version are always kept). Wins over compact. Omit for the full entity.",
      ),
      compact: z.boolean().optional().describe(
        "With format=json: drop decoration and ordering noise (*_extra_info, avatars, watchers/voters, *_order) and keep the rest. Default false.",
      ),
    };
    const wrapped: ToolHandler = async (args, extra) => {
      const { format, fields, compact, ...rest } = args as { format?: "text" | "json"; fields?: string; compact?: boolean };
      return shapeRead(await handler(rest, extra), format ?? "text", fields, compact, /_history$/.test(name));
    };
    return register(name, description, withFields, wrapped);
  };
}

const WRITE_TOOLS = /^taiga_((epics|userstories|tasks|issues|milestones)_(create|update)|(userstory|task|issue|wiki)_comment_create)$/;
const COMPACT_FIELDS = "status,subject";

// Adds opt-in `compact` and `fields` to the main write tools; the default response is left untouched.
// An explicit `fields` wins over `compact`.
export function addCompactParam(server: McpServer): void {
  const register = server.tool.bind(server) as unknown as ToolRegister;
  (server as unknown as { tool: ToolRegister }).tool = (name, description, schema, handler) => {
    if (!WRITE_TOOLS.test(name)) return register(name, description, schema, handler);
    const withCompact = {
      ...schema,
      fields: z.string().optional().describe(
        "Comma-separated field names to return (id, ref and version are always kept). Wins over compact. Omit for the full entity.",
      ),
      compact: z.boolean().optional().describe(
        "Return only id, ref, version, status and subject instead of the full entity. Default false.",
      ),
    };
    const wrapped: ToolHandler = async (args, extra) => {
      const { compact, fields, ...rest } = args as { compact?: boolean; fields?: string };
      return applyFields(await handler(rest, extra), fields || (compact ? COMPACT_FIELDS : undefined));
    };
    return register(name, description, withCompact, wrapped);
  };
}
