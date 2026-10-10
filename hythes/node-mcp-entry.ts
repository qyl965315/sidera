import { readFileSync } from "node:fs";
// Per-Node Core binding stays in the Host's private connection file. Account
// credentials are neither needed nor copied into MCP process parameters/logs.
const path = process.argv[2];
if (!path) throw new Error("Node MCP private connection path is required");
const value = JSON.parse(readFileSync(path, "utf8")) as { token: string; port: number };
if (typeof value.token !== "string" || !value.token || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535)
  throw new Error("Invalid Node Core binding");
process.env.SIDERA_NODE_CORE_TOKEN = value.token;
process.env.SIDERA_CORE_PORT = String(value.port);
await import("./peregrine-mcp.ts");
