import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { canonicalMcpServer } from "./canonical-mcp.ts";
const server=canonicalMcpServer({token:process.env.SIDERA_NODE_CORE_TOKEN ?? process.env.SIDERA_ASTRA_CORE_TOKEN ?? "",port:Number(process.env.SIDERA_CORE_PORT)});
await server.connect(new StdioServerTransport());
