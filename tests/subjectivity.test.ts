import { grantSelf } from "./fixtures/authority.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase } from "../core/db.ts";
import { getSubjectivity, reviseSubjectivity, wakeContext } from "../core/subjectivity.ts";

test("Node-authored Description and Explanation persist independently of evidence", () => {
  const path = join(tmpdir(), `sidera-subjectivity-${randomUUID()}.sqlite`);
  let db = openDatabase(path);
  try {
    const at = new Date().toISOString();
    db.prepare("INSERT INTO nodes VALUES ('agent','Test Agent','active',?)").run(at);
    db.prepare("INSERT INTO nodes VALUES ('other','Other Agent','active',?)").run(at);
    db.prepare("INSERT INTO sessions VALUES ('session','agent','fixture','fixture-host','exact','active',?)")
      .run(at);
    db.prepare("INSERT INTO events VALUES ('evidence','agent','experiment.detail',?,?)")
      .run(JSON.stringify({ detail: "blue" }), at);
    db.prepare("INSERT INTO responsibilities (responsibility_id,title,scope,owner_node_id,parent_responsibility_id,state,created_at,updated_at,accepted_at) VALUES ('duty','Persistent validation','small'," +
      "'agent',NULL,'active',?,?,?)").run(at, at, at);
    grantSelf(db,"agent");
    const caller = { nodeId: "agent", sessionId: "session" };
    const input = { requestId: "revision-1", expectedRevision: 0,
      description: "I remember the detail as green. I think I am a careful observer.",
      explanation: "My first impression may be colored by uncertainty." };
    assert.equal(reviseSubjectivity(db, caller, input).revision, 1);
    assert.equal(reviseSubjectivity(db, caller, input).revision, 1);
    assert.throws(() => reviseSubjectivity(db, caller, { ...input, requestId: "revision-2",
      expectedRevision: 0 }), /revision changed/);
    assert.equal(getSubjectivity(db, "other").revision, 0);
    assert.throws(() => reviseSubjectivity(db, { nodeId: "other", sessionId: "session" },
      { ...input, requestId: "cross-node-overwrite", expectedRevision: 0 }), { code: "denied" });
    db.close();
    db = openDatabase(path);
    const context = wakeContext(db, "agent");
    assert.match(context.subjectivity.description, /green/);
    assert.match(context.subjectivity.explanation, /uncertainty/);
    assert.equal(context.responsibilities[0]?.responsibilityId, "duty");
    assert.equal(JSON.stringify(context).includes("blue"), false);
    const audits = db.prepare("SELECT payload FROM events WHERE kind='subjectivity.revised'").all();
    assert.equal(audits.length, 1);
    assert.equal(JSON.stringify(audits).includes("green"), false);
  } finally {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = `${path}${suffix}`;
      if (existsSync(file)) unlinkSync(file);
    }
  }
});
