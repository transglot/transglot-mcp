#!/usr/bin/env node
/**
 * @transglot/mcp — stdio entry point.
 *
 * stdout is the MCP protocol channel: NOTHING but JSON-RPC may ever be written
 * to it while serving (diagnostics go to stderr). --help/--version print to
 * stdout and exit before the transport starts, so they never mix with protocol.
 *
 * SECURITY: TRANSGLOT_TOKEN is read once and handed to the API client; it is
 * never echoed to any stream.
 */
import { createRequire } from 'node:module';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createClient } from './api.js';
import { DEFAULT_APP_URL, DEFAULT_BASE_URL, loadConfig } from './config.js';
import { createServer } from './server.js';

// Read from the package's own package.json (one level up from dist/ and from src/), so the
// version a client sees can never lag the published one. A hard-coded string did: 0.2.0
// shipped reporting 0.1.0.
const { version: VERSION } = createRequire(import.meta.url)('../package.json') as { version: string };

// One JSON-RPC line on stdin may hold this much. push_file takes 10 MB of content, which JSON
// escaping and the envelope grow past the SDK's 10 MiB default; 32 MiB leaves headroom.
const STDIO_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

const USAGE = `transglot-mcp ${VERSION}: MCP server for transglot (stdio transport)

Exposes the transglot public API as MCP tools so AI agents can read and
write translations, pull/push localization files, trigger AI translation
batches, run QA, and manage the glossary for ONE project.

Usage:
  npx @transglot/mcp            start the server on stdio (for MCP clients)
  npx @transglot/mcp --help     print this help
  npx @transglot/mcp --version  print the version

Environment:
  TRANSGLOT_TOKEN      (required) project access token. Create one in the
                          transglot web UI (${DEFAULT_APP_URL}) under project
                          settings -> access tokens. The token IS the project;
                          abilities on the token (read/write/pull/push/manage)
                          gate the tools.
  TRANSGLOT_BASE_URL   base URL of the API (default ${DEFAULT_BASE_URL}; set for
                          self-hosted installs). Note this is the api host, NOT
                          the web UI above. They are separate. TRANSGLOT_URL,
                          the CLI's variable, is honored as a fallback.

Client configuration snippets (Cursor and other MCP clients) live in the
package README: https://www.npmjs.com/package/@transglot/mcp
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);

    return;
  }

  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${VERSION}\n`);

    return;
  }

  let config: ReturnType<typeof loadConfig>;

  try {
    config = loadConfig(process.env);
  } catch (error) {
    process.stderr.write(`transglot-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;

    return;
  }

  const api = createClient({ baseUrl: config.baseUrl, token: config.token, version: VERSION });
  const server = createServer({ api, version: VERSION });

  await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: STDIO_MAX_MESSAGE_BYTES }));
  process.stderr.write(`transglot-mcp ${VERSION} serving ${config.baseUrl} on stdio\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`transglot-mcp: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
