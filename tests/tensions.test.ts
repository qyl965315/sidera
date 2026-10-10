import { grantSelf } from "./fixtures/authority.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, unlinkSync } from "node:fs";
import { openDatabase } from "../core/db.ts";
import { createResponsibility, acceptResponsibility, completeResponsibility, transferResponsibility, deferResponsibility } from "./fixtures/organization.ts";
import { listTensions, mutateTension } from "../core/tensions.ts";
import { reviseSubjectivity, wakeContext } from "../core/subjectivity.ts";

test("accepted public commitment derives persistent tension; private revision cannot erase it", () => {
  const file = join(tmpdir(), `sidera-tension-${randomUUID()}.sqlite`);
  let db = openDatabase(file);
  try {
    const at = new Date().toISOString();
    for (const node of ["owner","next"]) {
      db.prepare("INSERT INTO nodes VALUES (?,?,'active',?)").run(node,node,at);
      db.prepare("INSERT INTO sessions VALUES (?,?,'fixture','fixture',?,'active',?)").run(`${node}-session`,node,node,at);
    }
    for(const node of ["owner","next"])grantSelf(db,node);
    const owner = { kind: "node", nodeId: "owner", sessionId: "owner-session" } as const;
    const next = { kind: "node", nodeId: "next", sessionId: "next-session" } as const;
    const human = { kind: "human", id: "fixture" } as const;
    const duty = createResponsibility(db,human,{requestId:"proposal",title:"Deliver a reviewed artifact",scope:"small",ownerNodeId:"owner"});
    assert.equal(duty.acceptance,"proposed");
    assert.equal(listTensions(db,"owner").length,0);
    acceptResponsibility(db,owner,{requestId:"accept",responsibilityId:duty.responsibilityId});
    const tension = listTensions(db,"owner")[0];
    assert.equal(tension.kind,"commitment");
    assert.throws(() => mutateTension(db,owner,{requestId:"erase",tensionId:tension.tensionId,status:"resolved"}),{code:"denied"});
    reviseSubjectivity(db,owner,{requestId:"private",expectedRevision:0,description:"I feel finished.",explanation:"This is only my impression."});
    assert.equal(listTensions(db,"owner")[0].status,"open");
    const personal = mutateTension(db,owner,{requestId:"notice",kind:"evidence",statement:"My impression may be wrong.",sourceRefs:[{kind:"responsibility",id:duty.responsibilityId}]});
    assert.throws(() => mutateTension(db,next,{requestId:"overwrite",tensionId:personal.tensionId,statement:"I decide your mind."}),{code:"denied"});
    db.close(); db = openDatabase(file);
    assert.equal(wakeContext(db,"owner").tensions.length,2);
    assert.equal(listTensions(db,"owner")[0].tensionId,tension.tensionId);
    assert.throws(() => deferResponsibility(db,owner,{requestId:"self-defer",responsibilityId:duty.responsibilityId,reason:"I prefer to forget."}),{code:"denied"});
    const deferred = deferResponsibility(db,human,{requestId:"pm-defer",responsibilityId:duty.responsibilityId,reason:"deferred by Project Manager"});
    assert.equal(deferred.state,"waiting");
    assert.equal(deferred.acceptance,"accepted");
    assert.equal(listTensions(db,"owner").find(item=>item.kind==="commitment")?.status,"waiting");
    assert.throws(() => mutateTension(db,owner,{requestId:"erase-deferred",tensionId:tension.tensionId,status:"resolved"}),{code:"denied"});
    db.close(); db = openDatabase(file);
    assert.equal(wakeContext(db,"owner").responsibilities[0].status,"waiting");
    // A formal transfer can move a deferred commitment without erasing its history.
    transferResponsibility(db,human,{requestId:"transfer",responsibilityId:duty.responsibilityId,expectedOwnerNodeId:"owner",nextOwnerNodeId:"next"});
    assert.equal(listTensions(db,"owner").find(item=>item.kind==="commitment")?.status,"relinquished");
    assert.equal(listTensions(db,"next").length,0);
    assert.equal(wakeContext(db,"next").proposals[0].status,"waiting");
    const accepted = acceptResponsibility(db,next,{requestId:"next-accept",responsibilityId:duty.responsibilityId});
    assert.equal(accepted.state,"waiting");
    assert.equal(accepted.deferredReason,"deferred by Project Manager");
    assert.equal(listTensions(db,"next")[0].status,"waiting");
    assert.throws(() => completeResponsibility(db,next,{requestId:"complete",responsibilityId:duty.responsibilityId,expectedOwnerNodeId:"next"}),{code:"conflict"});
    assert.throws(() => mutateTension(db,next,{requestId:"clear-waiting",tensionId:listTensions(db,"next")[0].tensionId,status:"resolved"}),{code:"denied"});
  } finally {
    db.close();
    for (const suffix of ["","-wal","-shm"]) if (existsSync(file+suffix)) unlinkSync(file+suffix);
  }
});
