export const text = (o: unknown, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: "text" as const, text: JSON.stringify(o) }] });
export const violation = (violations: string[]) => text({ code: "governance_violation", violations, message: "Rejected before any Taiga mutation." }, true);
export type ToolResult = ReturnType<typeof text>;

export const BASE = { task: "tasks", userstory: "userstories", epic: "epics" } as const;
export const STATUS_BASE = { task: "task-statuses", userstory: "userstory-statuses", epic: "epic-statuses" } as const;
