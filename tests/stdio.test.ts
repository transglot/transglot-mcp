import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { beforeAll, expect, test } from 'vitest';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(pkgRoot, 'dist', 'index.js');
const pkgVersion = (JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as { version: string }).version;

// The true-stdio ring: these tests exercise the BUILT server binary, so build it
// once up front (idempotent; CI also builds, this just makes bare `npm test` work).
beforeAll(() => {
  execFileSync(join(pkgRoot, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.build.json'], { cwd: pkgRoot });
  expect(existsSync(entry)).toBe(true);
}, 120_000);

test('boots over stdio and lists the tools', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      ...process.env,
      TRANSGLOT_TOKEN: 'tgl_test',
      TRANSGLOT_BASE_URL: 'http://127.0.0.1:9', // never dialed: listing tools makes no HTTP call
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test', version: '0.0.0' });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();

    expect(tools).toHaveLength(17);
    expect(client.getServerVersion()?.name).toBe('transglot');
  } finally {
    await client.close();
  }
}, 30_000);

test('--help prints usage (env vars + client snippets pointer) and exits 0', () => {
  const result = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8' });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('TRANSGLOT_TOKEN');
  expect(result.stdout).toContain('TRANSGLOT_BASE_URL');
  expect(result.stdout).toContain('stdio');
});

test('--version prints the package version', () => {
  const result = spawnSync(process.execPath, [entry, '--version'], { encoding: 'utf8' });

  expect(result.status).toBe(0);
  // package.json, not a literal: a literal here is how 0.2.0 shipped saying 0.1.0 and stayed green.
  expect(result.stdout.trim()).toBe(pkgVersion);
});

test('a missing TRANSGLOT_TOKEN fails fast on stderr, never on stdout', () => {
  const env = { ...process.env };
  delete env.TRANSGLOT_TOKEN;
  const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', env });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('TRANSGLOT_TOKEN');
  expect(result.stdout).toBe(''); // stdout is the MCP protocol channel — keep it clean
});

// push_file takes up to 10 MB of content. Escaped into a JSON-RPC line, that is more than 10 MiB,
// the stdio read cap the SDK added in 1.30; at that cap the transport closed and the session died.
test('a push_file line over 10 MiB reaches the API and the session survives', async () => {
  // A flat JSON file of about 9.5 MiB. Its quotes and newlines escape to over 10 MiB on the wire.
  const rows: string[] = [];

  for (let i = 0, size = 0; size < 9.5 * 1024 * 1024; i++) {
    const row = `  "screen.${i}.title": "Value number ${i}",`;
    rows.push(row);
    size += row.length + 1;
  }

  const content = `{\n${rows.join('\n')}\n  "end": "end"\n}\n`;

  expect(content.length).toBeLessThan(10 * 1000 * 1000);
  expect(JSON.stringify(content).length).toBeGreaterThan(10 * 1024 * 1024);

  const received: { url: string | undefined; bytes: number; hasTail: boolean }[] = [];
  const api = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      received.push({ url: req.url, bytes: body.length, hasTail: body.includes('"end": "end"') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          keys_created: rows.length + 1,
          keys_deleted: 0,
          source_updated: 0,
          translations_written: 0,
          conflicts: [],
          unknown_keys: [],
          warnings: [],
          batch: null,
          quota_exceeded: false,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      ...process.env,
      TRANSGLOT_TOKEN: 'tgl_test',
      TRANSGLOT_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test', version: '0.0.0' });

  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'push_file', arguments: { format: 'json_flat', locale: 'en', content } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ keys_created: rows.length + 1 });
    expect(received).toHaveLength(1);
    expect(received[0]?.url).toBe('/v1/push');
    expect(received[0]?.bytes).toBeGreaterThan(content.length);
    expect(received[0]?.hasTail).toBe(true);

    // Still the same session: it answers the next request.
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(17);
  } finally {
    await client.close();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
}, 60_000);
