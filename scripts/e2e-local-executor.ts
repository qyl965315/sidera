/**
 * Product-path E2E for the built-in local executor.
 *
 * Drives the real workbench HTTP API (the same routes the Desktop UI uses)
 * against an isolated temporary profile: configure -> declare Human -> add the
 * built-in executor -> review and admit the permission package -> start Core ->
 * submit one bounded local instruction -> verify the real artifact, the
 * canonical Task/Run state and the durable evidence.
 *
 * The review confirmation here is a test-harness response, exactly like the
 * packaged smoke driver: it is NOT a claim of real Human consent.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "../core/db.ts";
import { LocalSetup } from "../core/local-setup.ts";
import { startWorkbench } from "./local-launcher.ts";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const evidenceDir = process.argv[2] ?? resolve(import.meta.dirname, "..", "delivery",
  "2026-10-sidera-full-release", "SIDERA_E2E_EVIDENCE", "local-executor");
mkdirSync(evidenceDir, { recursive: true });
const steps: Array<Record<string, unknown>> = [];
const record = (step: string, value: Record<string, unknown>) => {
  steps.push({ at: new Date().toISOString(), step, ...value });
  process.stdout.write(JSON.stringify({ step, ...value }) + "\n");
};
const root = mkdtempSync(join(tmpdir(), "sidera-product-e2e-"));
const corePort = 48241, mcpPort = 48242, uiPort = 48240;
const setup = new LocalSetup(root); setup.bootstrap();
await setup.configure({ corePort, mcpPort });
record("configured", { root, corePort, mcpPort, uiPort });
const human = await setup.createHuman({ label: "E2E Local Human" });
record("human-declared", { humanId: human.humanId });
const executor = await setup.addLocalExecutor({ label: "Built-in Local Executor" });
record("local-executor-added", { nodeId: executor.nodeId, hostKind: executor.hostKind });
const review = setup.profile({ humanId: human.humanId, mode: "workspace" });
const native = setup.nativeReview({ reviewId: review.reviewId });
const applied = native.apply();
record("permission-package-admitted", { reviewId: review.reviewId,
  statement: native.statement.slice(0, 160), applied: Boolean(applied), testHarnessConfirmation: true });
const confirmations: string[] = [];
const workbench = await startWorkbench(root, uiPort, { approveHuman: async statement => {
  confirmations.push(statement); return true; } });
const post = async (path: string, body: unknown) => {
  const response = await fetch(`http://127.0.0.1:${uiPort}${path}`, { method: "POST",
    headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${uiPort}` },
    body: JSON.stringify(body) });
  return { status: response.status, value: await response.json() as Record<string, unknown> };
};
try {
  let status: Record<string, any> | null = null;
  for (let i = 0; i < 120; i++) {
    const response = await fetch(`http://127.0.0.1:${uiPort}/api/setup/status`);
    status = await response.json() as Record<string, any>;
    if (status?.runtime?.ready) break;
    await sleep(250);
  }
  record("core-ready", { ready: Boolean(status?.runtime?.ready), nodes: status?.nodes?.length ?? 0,
    authority: status?.authority?.state ?? null });
  const fileName = "PRODUCT_E2E_OK.txt", content = "PRODUCT_E2E_OK";
  const execution = await post("/api/setup/local-execute", { humanId: human.humanId, fileName, content });
  const executionValue = execution.value as Record<string, any>;
  record("local-execute-requested", { httpStatus: execution.status, state: String(executionValue.state ?? ""),
    requestId: String(executionValue.requestId ?? ""), code: executionValue.code ?? null,
    nativeConfirmations: confirmations.length });
  const snapshotUrl = `http://127.0.0.1:${uiPort}/api/r1/snapshot`;
  let taskState: string | null = null, taskId: string | null = null;
  for (let i = 0; i < 240; i++) {
    const snapshot = await fetch(snapshotUrl).then(r => r.json()).catch(() => null) as
      { tasks?: Array<{ id: string; state: string }> } | null;
    const tasks = snapshot?.tasks ?? [];
    const newest = tasks[tasks.length - 1];
    if (newest) { taskId = newest.id; taskState = newest.state; }
    if (newest && ["completed", "failed"].includes(newest.state)) break;
    await sleep(250);
  }
  // Read evidence only after the run settled; no second connection is held
  // open while Core executes.
  const db = openDatabase(join(root, ".sidera-dev", "sol", "data", "sidera.sqlite"));
  let evidence: Record<string, any> | null = null;
  try {
    const row = db.prepare(`SELECT payload FROM events WHERE kind = 'local.executor.completed'
      ORDER BY rowid DESC LIMIT 1`).get() as { payload: string } | undefined;
    if (row) evidence = (JSON.parse(row.payload) as { evidence: Record<string, any> }).evidence;
  } finally { db.close(); }
  const artifactOk = Boolean(evidence?.path && existsSync(evidence.path) && readFileSync(String(evidence.path), "utf8") === content);
  record("task-result", { taskId, taskState, op: evidence?.op ?? null, sha256: evidence?.sha256 ?? null,
    artifactPath: evidence?.path ?? null, artifactOk, externalAccountsRequired: false });
  const summary = { product: "Sidera", flow: "workbench-api -> core -> peregrine-local",
    result: taskState === "completed" && artifactOk ? "PASS" : "FAIL",
    fileName, contentSha256: evidence?.sha256 ?? null, evidencePath: evidence?.path ?? null,
    corePort, uiPort, capturedAt: new Date().toISOString(), testHarnessConfirmation: true };
  writeFileSync(join(evidenceDir, "LOCAL_EXECUTOR_E2E.json"), JSON.stringify({ summary, steps }, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ summary }) + "\n");
  await post("/api/setup/core-stop", {}).catch(() => {});
  // Fetch keep-alive sockets can keep server.close() pending; the run is complete.
  process.exit(summary.result === "PASS" ? 0 : 1);
} finally {
  await workbench.close().catch(() => {});
}
