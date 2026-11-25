// The one DEV-only reload path (same pattern as REACH). The admin listener answers an event stream with its own instance id; a page keeps
// it open and, when the process restarts, receives a different id and reloads once. The restart is triggered by the source watcher below,
// which polls file times because the sources live on a network share where inotify never sees a change made from another machine.
// systemd (Restart=always in the DEV unit) starts the process again and rebuilds dist first. Only TAIGA_MCP_DEV_RELOAD=1 creates any of this.
import { readdirSync, watchFile } from "node:fs";
import type { ServerResponse } from "node:http";
import path from "node:path";

export const DEV_RELOAD_PATH = "/admin/api/dev-reload";

export function createDevReload(): (res: ServerResponse) => void {
  const instance = `${process.pid}-${process.hrtime.bigint()}`; // differs for every process start, which is all the page compares
  return (res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(`data: ${instance}\n\n`);
  };
}

// Calls onChange once when any .ts file under the given directories changes (polled every second).
export function watchSources(dirs: readonly string[], onChange: () => void, intervalMs = 1000): void {
  let fired = false;
  for (const dir of dirs) {
    for (const file of readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"))) {
      watchFile(path.join(dir, file), { interval: intervalMs, persistent: false }, (now, before) => {
        if (fired || now.mtimeMs === before.mtimeMs) return;
        fired = true;
        onChange();
      });
    }
  }
}
