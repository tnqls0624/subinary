import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { FamilyApiClient } from './api-client';
import { loadConfig, type McpConfig } from './config';
import { registerAllTools } from './tools';

/**
 * Family Memory AI — stdio MCP server entry point (Phase 10 spec §2.5).
 *
 * Launched by Claude Code / Cursor as `node dist/main.js` with credentials in
 * env. It loads config, logs in to the API, registers the six tools, and speaks
 * MCP over stdio.
 *
 * PROTOCOL HYGIENE: stdout is reserved exclusively for the MCP JSON-RPC stream.
 * All diagnostics go to stderr via `console.error` — never `console.log`.
 */

const LOG_PREFIX = '[family-memory-mcp]';

/** stderr-only logger (never touches stdout, which carries the MCP protocol). */
function logError(message: string): void {
  console.error(`${LOG_PREFIX} ${message}`);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
  // 1) Load + validate configuration (value-free errors on failure).
  // `process.exit` returns `never`, so `config` is definitely assigned below.
  let config: McpConfig;
  try {
    config = loadConfig();
  } catch (err) {
    logError(`설정 오류: ${errMessage(err)}`);
    process.exit(1);
  }

  // 2) Authenticate up front so tool calls have a valid session.
  const client = new FamilyApiClient(config);
  try {
    await client.login();
  } catch (err) {
    logError(`로그인 실패: ${errMessage(err)}`);
    process.exit(1);
  }

  // 3) Build the server and register tools.
  const server = new McpServer({
    name: 'family-memory-ai',
    version: '0.1.0',
  });
  registerAllTools(server, client);

  // 4) Connect over stdio and stay alive.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logError('stdio MCP 서버 준비 완료 (도구 6개 등록됨)');

  // Graceful shutdown on termination signals.
  const shutdown = (signal: string): void => {
    logError(`${signal} 수신 — 종료합니다.`);
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  logError(`치명적 오류로 종료합니다: ${errMessage(err)}`);
  process.exit(1);
});
