#!/usr/bin/env node
// ============================================================
// ChatDesk MCP server — entry point.
//
// A stdio Model Context Protocol server that exposes the ChatDesk
// public API (`/api/v1`) as MCP tools, so an MCP client (Claude
// Desktop, Cursor, etc.) can drive a self-hosted WhatsApp CRM in
// natural language.
//
// Transport is stdio: logs MUST go to stderr, never stdout (stdout
// is the protocol channel). Configuration comes from the environment
// — see .env.example / README.md.
// ============================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { ChatdeskClient } from './client.js';
import { registerTools } from './tools/index.js';

// package.json version, kept in sync manually with the manifest.
const VERSION = '0.1.0';

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new ChatdeskClient(config);

  const server = new McpServer({ name: 'chatdesk-mcp', version: VERSION });
  const groups = registerTools(server, client, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Stderr only — stdout is reserved for the MCP protocol.
  console.error(
    `ChatDesk MCP server v${VERSION} ready — instance ${config.baseUrl}, ` +
      `tool groups: ${groups.join(', ')}` +
      (config.enableWrites ? '' : ' (read-only; set CHATDESK_ENABLE_WRITES to allow changes)'),
  );
}

main().catch((err) => {
  console.error(`Failed to start ChatDesk MCP server: ${(err as Error).message}`);
  process.exit(1);
});
