import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevReload, watchSources } from "../dist/dev-reload.js";

// F2.7: the DEV restart trigger. It polls (the sources live on a network share) and fires once.
test("the watcher fires once when a source file changes, and not for an untouched one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reload-"));
  try {
    writeFileSync(join(dir, "a.ts"), "1");
    writeFileSync(join(dir, "b.ts"), "1");
    writeFileSync(join(dir, "notes.md"), "1");
    let fired = 0;
    watchSources([dir], () => { fired++; }, 50);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(fired, 0);
    utimesSync(join(dir, "notes.md"), new Date(), new Date(Date.now() + 5000));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(fired, 0, "a non-source file does not restart the process");
    utimesSync(join(dir, "a.ts"), new Date(), new Date(Date.now() + 5000));
    utimesSync(join(dir, "b.ts"), new Date(), new Date(Date.now() + 9000));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(fired, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the reload stream answers an event stream with one instance id per process", () => {
  const send = createDevReload();
  const seen: string[] = [];
  const res = { writeHead: (status: number, h: Record<string, string>) => { seen.push(`${status} ${h["content-type"]}`); }, write: (chunk: string) => { seen.push(chunk); } };
  send(res as never);
  send(res as never);
  assert.equal(seen[0], "200 text/event-stream");
  assert.equal(seen[1], seen[3], "the same process always sends the same id");
  assert.match(seen[1], /^data: \d+-\d+\n\n$/);
});
