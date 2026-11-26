import { PROJECT_PROFILE } from "../../dist/project-profile.js";
import type { TaigaAccess } from "../../dist/policy/service.js";

// Taiga as the approval sees it: the project's status vocabulary per entity (the canonical profile plus a "Limbo" status no policy lists, id 99) and the cards,
// given per collection as [ref, status name]. A name the vocabulary lacks becomes a status id Taiga does not list; the name "(none)" a card with no status at all.
const LISTS = { tasks: "task-statuses", userstories: "userstory-statuses", epics: "epic-statuses" } as const;
const statusesOf = (list: string) => [...PROJECT_PROFILE[list].map((s, i) => ({ id: i + 1, name: s.name, is_closed: !!s.is_closed })), { id: 99, name: "Limbo", is_closed: false }];

export interface FakeHooks { policyAt?: TaigaAccess["runtime"]["policyAt"]; statuses?: (list: string) => unknown; cards?: (path: string) => unknown; before?: () => Promise<void>; calls?: string[] }
export function fakeTaiga(baseUrl = "http://t", cards: Record<string, [number, string][]> = {}, hooks: FakeHooks = {}): TaigaAccess {
  const idOf = (path: keyof typeof LISTS, name: string) => statusesOf(LISTS[path]).find((s) => s.name === name)?.id ?? 12345;
  return {
    baseUrl,
    runtime: { policyAt: hooks.policyAt ?? (async () => "legacy") },
    client: {
      get: async (path: string) => { hooks.calls?.push(`GET ${path}`); await hooks.before?.(); return hooks.statuses ? hooks.statuses(path.slice(1)) : statusesOf(path.slice(1)); },
      getAll: async (path: string) => {
        hooks.calls?.push(`GETALL ${path}`);
        const key = path.slice(1) as keyof typeof LISTS;
        return hooks.cards ? hooks.cards(key) : (cards[key] ?? []).map(([ref, name]) => (name === "(none)" ? { ref } : { ref, status: idOf(key, name) }));
      },
    } as never,
  };
}
