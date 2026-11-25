import { AsyncLocalStorage } from "node:async_hooks";
import type { ManagedPolicy } from "./runtime.js";

// The managed policy of the governed call that is running (the one held under the project's lock), visible to everything that call reaches without passing it
// down every function: undefined outside a managed call, so a legacy project and any code outside a governed call keep the legacy rules.
const managedCall = new AsyncLocalStorage<ManagedPolicy>();
export const runManaged = <T>(managed: ManagedPolicy, run: () => T): T => managedCall.run(managed, run);
export const activeManaged = (): ManagedPolicy | undefined => managedCall.getStore();
