/**
 * MCP tools barrel — imports each tool module for its side-effect
 * `registerTools([...])` call, then starts the MCP server.
 *
 * Adding a new tool module: create the file, call `registerTools([...])`
 * at module scope, and append the import here. No central list.
 */
// OTel bootstrap FIRST: the MCP server is a separate process spawned by the
// SDK, so it must start its own SDK and join the host trace via OTEL_TRACEPARENT
// (forwarded into this process's env by src/index.ts). No-op when host tracing
// is off. Side-effect import only (ADR-0026).
import '../observability/init.js';

import { loadConfig } from '../config.js';
import './core.js';
import './scheduling.js';
import './interactive.js';
import './agents.js';
import './self-mod.js';
import './gateway.js';
import './classify-intent.js';
import './roster.js';
import './skill-loader.js';
import { startMcpServer } from './server.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

// The built-in MCP server is a separate process from src/index.ts, so the
// runner's in-memory config singleton is not shared with it. Load the mounted
// container.json here before any tool handler can call getConfig().
loadConfig();

startMcpServer().catch((err) => {
  log(`MCP server error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
