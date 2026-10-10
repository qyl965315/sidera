import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Read the actual local tool manifest. No Task, external probe or credential output.
const root = resolve(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(join(root, ".sidera-dev/sol/data/connection.json"), "utf8")) as {
  mcpPort: number; gptHttpToken: string;
};
const endpoint = `http://127.0.0.1:${config.mcpPort}/mcp`;
const client = new Client({ name: "sidera-local-manifest-diagnostic", version: "1" });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${config.gptHttpToken}` } },
  }));
  const result = await client.listTools();
  const report = { at: new Date().toISOString(), endpoint,
    tools: result.tools.map(tool => ({ name: tool.name, readOnly: tool.annotations?.readOnlyHint ?? null })),
    chiefDispatchStatusPresent: result.tools.some(tool => tool.name === "chief_dispatch_status"),
    externalProbePerformed: false, taskCreated: false,
    note: "This is the server manifest. ChatGPT connection metadata must be refreshed separately; local registration does not prove Host exposure." };
  const dir = join(root, ".sidera-dev/chief-ingress");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "local-tools.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await client.close(); }
