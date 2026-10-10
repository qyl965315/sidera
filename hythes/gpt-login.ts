import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import { GptUiBackend } from "./gpt-ui.ts";
import type { PeregrineRecord } from "../peregrine/local.ts";

/** Human-only first login in ordinary Chrome, without CDP or automation flags. */
export async function loginGptProfile(root = process.cwd()): Promise<void> {
  const config = JSON.parse(readFileSync(join(root, ".sidera-dev", "sol", "data", "connection.json"),
    "utf8")) as { gptNodeId: string; gptPeregrineId?: string; gptLocatorRef: string };
  const db = new DatabaseSync(join(root, ".sidera-dev", "sol", "data", "sidera.sqlite"));
  const selected = db.prepare(`SELECT conversation_ref FROM chief_conversations
    WHERE chief_node_id=? AND project_space_id='sidera-r1' AND state='active'`)
    .get(config.gptNodeId) as { conversation_ref: string } | undefined;
  const row = db.prepare("SELECT * FROM peregrines WHERE peregrine_id = ?")
    .get(config.gptPeregrineId ?? "") as Record<string, unknown> | undefined;
  db.close();
  const conversationRef = selected?.conversation_ref;
  if (!conversationRef || !/^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(conversationRef))
    throw new Error("Human must explicitly select an exact Chief Conversation before login");
  if (!row || row.owner_node_id !== config.gptNodeId || row.state !== "ready")
    throw new Error("GPT Peregrine profile is not ready for the configured Node");
  const domain: PeregrineRecord = {
    peregrineId: String(row.peregrine_id), ownerNodeId: String(row.owner_node_id),
    workspaceRef: String(row.workspace_ref), homeRef: String(row.home_ref),
    tempRef: String(row.temp_ref), state: "ready", backend: "local",
  };
  const profile = join(domain.homeRef, "chatgpt-browser-manual");
  mkdirSync(profile, { recursive: true });
  const executable = process.env.SIDERA_CHROME_EXE ??
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  // Sign-in is a normal Human Chrome session. Do not attach Playwright until
  // Chrome has closed and the dedicated profile's login is complete.
  const browser = spawn(executable, [`--user-data-dir=${profile}`, conversationRef], {
    cwd: domain.workspaceRef, windowsHide: false, stdio: "ignore",
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC,
      HOME: domain.homeRef, USERPROFILE: domain.homeRef,
      TEMP: domain.tempRef, TMP: domain.tempRef,
      APPDATA: join(domain.homeRef, "AppData", "Roaming"),
      LOCALAPPDATA: join(domain.homeRef, "AppData", "Local") },
  });
  process.stdout.write("Complete ChatGPT login in this ordinary, dedicated Chrome window.\n" +
    "Then close that window and press Enter here. Sidera will verify the exact conversation.\n");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { await prompt.question("Press Enter after closing the dedicated Chrome window: "); }
  finally { prompt.close(); }
  if (browser.exitCode === null) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        browser.off("exit", exited);
        reject(new Error("Dedicated Chrome is still open; close it before verification"));
      }, 30_000);
      const exited = () => { clearTimeout(timer); resolve(); };
      browser.once("exit", exited);
    });
  }
  const ui = new GptUiBackend({ domain, locatorRef: conversationRef,
    executablePath: executable, headless: false });
  try {
    await ui.initialize();
    if (ui.discover().availability !== "available")
      throw new Error("Dedicated profile cannot open the exact ChatGPT conversation after login");
    process.stdout.write("Dedicated profile login verified at the exact conversation.\n");
  } finally { await ui.close(); }
}

if (process.argv[1] && new URL(`file:///${process.argv[1].replaceAll("\\", "/")}`).href === import.meta.url)
  await loginGptProfile();
