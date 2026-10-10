import { grantSelf } from "./fixtures/authority.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase } from "../core/db.ts";
import { LocalPeregrineManager } from "../peregrine/local.ts";
import { readOwnedText, writeOwnedText } from "../peregrine/text.ts";
import {recordFixtureHostAvailable} from "./fixtures/host-condition.ts";

test("Node writes only its own Peregrine text with exact request dedupe", () => {
  const root = mkdtempSync(join(tmpdir(), "sidera-owned-text-"));
  const db = openDatabase(join(root, "state.sqlite"));
  db.prepare("INSERT INTO nodes VALUES ('astra', 'Astra', 'active', 'now')").run();
  db.prepare("INSERT INTO sessions VALUES ('session', 'astra', 'codex', 'codex-app-server', 'thread', 'active', 'now')").run();
  recordFixtureHostAvailable(db,"session");
  grantSelf(db,"astra");
  const manager = new LocalPeregrineManager(db, join(root, "peregrines"));
  try {
    const caller = { nodeId: "astra", sessionId: "session" };
    const input = { requestId: "write-one", fileName: "BILATERAL_R1_E2E.md", content: "# Review\n" };
    const first = writeOwnedText(db, manager, caller, input);
    assert.equal(readFileSync(first.path, "utf8"), input.content);
    assert.equal(readOwnedText(db, manager, caller, input.fileName).content, input.content);
    assert.throws(() => readOwnedText(db, manager,
      { nodeId: "other", sessionId: "session" }, input.fileName),
      { code: "not_found" });
    assert.throws(() => readOwnedText(db, manager,
      { nodeId: "astra", sessionId: "wrong" }, input.fileName),
      { code: "denied" });
    assert.throws(() => readOwnedText(db, manager, caller, "../outside"),
      { code: "conflict" });
    assert.equal(writeOwnedText(db, manager, caller, input).path, first.path);
    assert.throws(() => writeOwnedText(db, manager, caller, { ...input, content: "changed" }),
      { code: "conflict" });
    const revised = writeOwnedText(db, manager, caller, { requestId: "write-two",
      fileName: input.fileName, content: "# Revised\n", mode: "replace",
      expectedContent: input.content });
    assert.equal(revised.path, first.path);
    assert.equal(readFileSync(first.path, "utf8"), "# Revised\n");
    assert.throws(() => writeOwnedText(db, manager, caller, { requestId: "write-three",
      fileName: input.fileName, content: "bad", mode: "replace",
      expectedContent: input.content }), { code: "conflict" });
    assert.throws(() => writeOwnedText(db, manager, caller,
      { ...input, requestId: "escape", fileName: "../escape.md" }), { code: "conflict" });
    assert.throws(() => writeOwnedText(db, manager,
      { nodeId: "astra", sessionId: "wrong" }, { ...input, requestId: "wrong-session" }),
      { code: "denied" });
  } finally { db.close(); }
});
