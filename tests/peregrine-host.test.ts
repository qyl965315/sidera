import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase } from "../core/db.ts";
import { CoreRpcServer } from "../core/rpc.ts";
import { callCore } from "../hythes/core-client.ts";
import { PeregrineHostHythe } from "../hythes/peregrine-host.ts";
import { LocalPeregrineManager } from "../peregrine/local.ts";
import { issueGrant } from "./fixtures/authority.ts";
import { CoreRuntime } from "./fixtures/execution.ts";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Real end-to-end proof of the built-in local executor: a Human-rooted Task is
 * admitted by Core, pinned to the local Operator's exact Session, delivered
 * across the real Effect boundary, executed as a bounded instruction inside a
 * contained workspace, and returned as durable, hash-bearing evidence — with no
 * private bridge, no cloud account and no third-party product.
 */
test("built-in local executor performs real dispatched work with hashed evidence and no replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "sidera-peregrine-host-"));
  const db = openDatabase(join(root, "sidera.sqlite"));
  const at = new Date().toISOString();
  for (const nodeId of ["chief", "local-bot"]) {
    db.prepare("INSERT INTO nodes VALUES (?, ?, 'active', ?)").run(nodeId, nodeId, at);
  }
  const manager = new LocalPeregrineManager(db, join(root, "peregrines"));
  const chiefHost = new PeregrineHostHythe({ hytheId: "chief-local-hythe", nodeId: "chief",
    sessionId: "chief-session", db, manager });
  const workerHost = new PeregrineHostHythe({ hytheId: "local-bot-hythe", nodeId: "local-bot",
    sessionId: "local-bot-session", db, manager });
  for (const [nodeId, hytheId] of [["chief", chiefHost.hytheId], ["local-bot", workerHost.hytheId]] as const) {
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?, 'peregrine-local', ?, 'active', ?)")
      .run(`${nodeId}-session`, nodeId, hytheId, `peregrine://${nodeId}`, at);
  }
  issueGrant(db, { kind: "human", id: "fixture" }, { subjectNodeId: "chief",
    capability: "task.dispatch", resourceScope: "node/local-bot" });
  issueGrant(db, { kind: "human", id: "fixture" }, { subjectNodeId: "local-bot",
    capability: "message.send", resourceScope: "node/chief" });
  const hythes = new Map([[chiefHost.hytheId, chiefHost], [workerHost.hytheId, workerHost]]);
  const runtime = new CoreRuntime(db, hythes);
  const rpc = new CoreRpcServer(db, runtime, hythes,
    { authenticate: token => token === "chief-core-token"
      ? { kind: "node" as const, nodeId: "chief", sessionId: "chief-session" } : null },
    undefined, root);
  const corePort = await rpc.listen(0);
  void runtime.receive("local-bot-session");
  const terminal = async (taskId: string, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const task = db.prepare("SELECT state FROM tasks WHERE task_id = ?").get(taskId) as { state: string };
      if (["completed", "failed"].includes(task.state)) return task.state;
      if (Date.now() > deadline) return task.state;
      await sleep(25);
    }
  };
  try {
    // ---- 1. Real task -> real file, with durable hashed evidence ----
    const writeInstruction = { protocolVersion: 1, op: "write_text",
      fileName: "SIDERA_LOCAL_OK.txt", content: "SIDERA_LOCAL_OK" };
    const firstRequest = randomUUID();
    const receipt = await callCore({ port: corePort, token: "chief-core-token" }, "task.dispatch",
      { requestId: firstRequest, centerNodeId: "local-bot", body: JSON.stringify(writeInstruction) }) as
      { task: { taskId: string }; run: { run_id: string } };
    assert.equal(await terminal(receipt.task.taskId), "completed", "the local Task completed");
    const run = db.prepare("SELECT turn_open FROM task_runs WHERE run_id = ?").get(receipt.run.run_id) as { turn_open: number };
    assert.equal(run.turn_open, 0, "the exact local Run was settled by its own result");
    const completed = db.prepare(`SELECT payload FROM events WHERE kind = 'local.executor.completed'
      ORDER BY rowid DESC LIMIT 1`).get() as { payload: string };
    const evidence = (JSON.parse(completed.payload) as { evidence: Record<string, unknown> }).evidence;
    assert.equal(evidence.status, "completed");
    assert.equal(evidence.op, "write_text");
    assert.equal(evidence.sha256, sha256("SIDERA_LOCAL_OK"));
    assert.equal(readFileSync(String(evidence.path), "utf8"), "SIDERA_LOCAL_OK",
      "the artifact is a real file on disk with the exact bytes");
    assert.ok(existsSync(String(evidence.path)));
    const result = db.prepare(`SELECT body, kind FROM messages WHERE task_id = ? AND kind = 'result'`)
      .get(receipt.task.taskId) as { body: string; kind: string } | undefined;
    assert.ok(result, "a canonical result message was recorded");
    assert.equal((JSON.parse(result!.body) as { status: string }).status, "completed");

    // ---- 2. The same requestId never executes a second time ----
    const replay = await callCore({ port: corePort, token: "chief-core-token" }, "task.dispatch",
      { requestId: firstRequest, centerNodeId: "local-bot", body: JSON.stringify(writeInstruction) }) as
      { task: { taskId: string } };
    assert.equal(replay.task.taskId, receipt.task.taskId, "idempotent replay keeps the original Task");
    assert.equal(db.prepare("SELECT count(*) n FROM tasks").get()?.n, 1);
    const startedForFirst = db.prepare(`SELECT count(*) n FROM events WHERE kind = 'local.executor.started'
      AND json_extract(payload, '$.taskId') = ?`).get(receipt.task.taskId) as { n: number };
    assert.equal(startedForFirst.n, 1, "the local action ran exactly once");

    // ---- 3. run_node executes a real bounded process and hashes its artifact ----
    const script = { fileName: "make-artifact.cjs",
      content: "require('node:fs').writeFileSync('artifact.txt','LOCAL-ARTIFACT');process.stdout.write('printed-line');" };
    const runInstruction = { protocolVersion: 1, op: "run_node", script, artifact: { fileName: "artifact.txt" } };
    const second = await callCore({ port: corePort, token: "chief-core-token" }, "task.dispatch",
      { requestId: randomUUID(), centerNodeId: "local-bot", body: JSON.stringify(runInstruction) }) as
      { task: { taskId: string }; run: { run_id: string } };
    assert.equal(await terminal(second.task.taskId), "completed");
    const completed2 = db.prepare(`SELECT payload FROM events WHERE kind = 'local.executor.completed'
      AND json_extract(payload, '$.taskId') = ?`).get(second.task.taskId) as { payload: string };
    const evidence2 = (JSON.parse(completed2.payload) as { evidence: Record<string, any> }).evidence;
    assert.equal(evidence2.status, "completed");
    assert.equal(evidence2.exitCode, 0, "the real child process exited successfully");
    assert.equal(evidence2.timedOut, false);
    assert.equal(evidence2.stdoutSha256, sha256("printed-line"), "stdout is hashed, not paraphrased");
    assert.equal(evidence2.artifact.sha256, sha256("LOCAL-ARTIFACT"));
    assert.equal(readFileSync(String(evidence2.artifact.path), "utf8"), "LOCAL-ARTIFACT");

    // ---- 4. A failed local process is never reported as success and never replayed ----
    const failing = { protocolVersion: 1, op: "run_node",
      script: { fileName: "fail.cjs", content: "process.exit(3);" }, artifact: { fileName: "never.txt" } };
    const third = await callCore({ port: corePort, token: "chief-core-token" }, "task.dispatch",
      { requestId: randomUUID(), centerNodeId: "local-bot", body: JSON.stringify(failing) }) as
      { task: { taskId: string }; run: { run_id: string } };
    for (let i = 0; i < 200; i++) {
      const r = db.prepare("SELECT turn_open FROM task_runs WHERE run_id = ?").get(third.run.run_id) as { turn_open: number };
      if (!r.turn_open) break;
      await sleep(25);
    }
    const failedRun = db.prepare("SELECT state, turn_open FROM task_runs WHERE run_id = ?").get(third.run.run_id) as
      { state: string; turn_open: number };
    assert.equal(failedRun.turn_open, 0, "the failed local turn is closed, not left silently open");
    assert.notEqual(failedRun.state, "completed", "a non-zero exit can never be a completed Run");
    const failedResult = db.prepare("SELECT 1 FROM messages WHERE task_id = ? AND kind = 'result'").get(third.task.taskId);
    assert.equal(failedResult, undefined, "no fabricated result exists for the failed process");
    const startedForThird = db.prepare(`SELECT count(*) n FROM events WHERE kind = 'local.executor.started'
      AND json_extract(payload, '$.taskId') = ?`).get(third.task.taskId) as { n: number };
    assert.equal(startedForThird.n, 1, "the failed action was not replayed");

    // ---- 5. Durable evidence survives a restart of the Host adapter ----
    const restarted = new PeregrineHostHythe({ hytheId: "local-bot-hythe", nodeId: "local-bot",
      sessionId: "local-bot-session", db, manager });
    const turn = await restarted.completedTurn("peregrine://local-bot", String(evidence.hostRef ?? "peregrine:restart"),
      String(evidence.messageId));
    assert.ok(turn, "completed evidence is readable after a restart");
    assert.equal((JSON.parse(turn!.body) as { sha256: string }).sha256, sha256("SIDERA_LOCAL_OK"));
  } finally {
    await workerHost.close(); await chiefHost.close();
    runtime.close(); await rpc.close(); db.close();
  }
});