import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { createClient } from '../src/api.js';
import { createServer } from '../src/server.js';
import {
  ADDED_LANGUAGE_WIRE,
  BATCH_WIRE,
  GLOSSARY_TERM_WIRE,
  PROJECT_WIRE,
  PUSH_RESULT_WIRE,
  ROW_WIRE,
  json,
  problem,
  startMockServer,
} from './helpers.js';
import type { MockServer } from './helpers.js';

let http: MockServer;
let mcp: Client;

beforeEach(async () => {
  http = await startMockServer();
  const api = createClient({ baseUrl: http.url, token: 'tgl_secret', version: '0.1.0' });
  const server = createServer({ api, version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  mcp = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
});

afterEach(async () => {
  await mcp.close();
  await http.close();
});

const EXPECTED_TOOLS = [
  'get_project',
  'list_languages',
  'add_language',
  'get_translation',
  'upsert_translation',
  'translate_missing',
  'get_batch_status',
  'list_batches',
  'retry_failed_batch',
  'cancel_batch',
  'run_qa',
  'glossary_list_terms',
  'glossary_add_term',
  'glossary_update_term',
  'glossary_delete_term',
  'pull_file',
  'push_file',
];

test('lists exactly the shipped tools, in a stable order', async () => {
  const { tools } = await mcp.listTools();

  expect(tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
});

test('the full tool surface (descriptions + JSON Schema inputs) is pinned', async () => {
  const { tools } = await mcp.listTools();

  const surface = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }));

  expect(surface).toMatchSnapshot();
});

test('read tools are annotated read-only; mutating tools are not', async () => {
  const { tools } = await mcp.listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const readOnly = ['get_project', 'list_languages', 'get_translation', 'get_batch_status', 'list_batches', 'glossary_list_terms', 'pull_file'];

  for (const name of readOnly) {
    expect(byName.get(name)?.annotations?.readOnlyHint, `${name} should be read-only`).toBe(true);
  }

  const mutating = ['add_language', 'upsert_translation', 'translate_missing', 'retry_failed_batch', 'cancel_batch', 'run_qa', 'glossary_add_term', 'glossary_update_term', 'glossary_delete_term', 'push_file'];

  for (const name of mutating) {
    expect(byName.get(name)?.annotations?.readOnlyHint ?? false, `${name} must not claim read-only`).toBe(false);
  }

  // Descriptions of mutating tools must state their effects for the agent.
  expect(byName.get('upsert_translation')?.description).toMatch(/overwrit/i);
  expect(byName.get('translate_missing')?.description).toMatch(/quota/i);
  expect(byName.get('add_language')?.description).toMatch(/quota/i);
  expect(byName.get('add_language')?.description).toMatch(/"manage"/);
  // Additive: it never removes or overwrites anything, so it must not be flagged destructive.
  expect(byName.get('add_language')?.annotations?.destructiveHint).toBe(false);
  expect(byName.get('glossary_delete_term')?.description).toMatch(/permanent/i);
  expect(byName.get('push_file')?.description).toMatch(/delete/i);

  // Cancelling ENDS spend rather than causing it, and the agent must not read it as destructive.
  expect(byName.get('cancel_batch')?.description).toMatch(/stop/i);
  expect(byName.get('cancel_batch')?.annotations?.idempotentHint).toBe(true);
});

test('the served instructions point at cancel_batch as the way out of a running batch', () => {
  // Matches the TOOL NAME only: the surrounding wording is free to change, but an agent that is
  // told AI tools spend quota must also be told which tool stops the spending.
  const instructions = mcp.getInstructions() ?? '';

  expect(instructions).toContain('cancel_batch');
});

test('get_project returns the project as structured content', async () => {
  http.queue(json(200, PROJECT_WIRE));

  const result = await mcp.callTool({ name: 'get_project', arguments: {} });

  expect(result.isError ?? false).toBe(false);
  expect(result.structuredContent).toEqual(PROJECT_WIRE);
});

test('get_project passes through message_syntax and icu_dialect when the server sends them', async () => {
  // PROJECT_WIRE (above) omits these fields, and still validates: that is the older-server
  // case, since both are optional in the output schema.
  const wireWithIcuFields = { ...PROJECT_WIRE, message_syntax: 'icu', icu_dialect: 'flutter' };
  http.queue(json(200, wireWithIcuFields));

  const result = await mcp.callTool({ name: 'get_project', arguments: {} });

  expect(result.isError ?? false).toBe(false);
  expect(result.structuredContent).toEqual(wireWithIcuFields);
});

test('list_languages projects the locales out of GET /project', async () => {
  http.queue(json(200, PROJECT_WIRE));

  const result = await mcp.callTool({ name: 'list_languages', arguments: {} });

  expect(result.structuredContent).toEqual({
    source_locale: 'en',
    languages: PROJECT_WIRE.locales,
  });
});

test('get_translation hits the wire with key+locale and returns the row', async () => {
  http.queue(json(200, ROW_WIRE));

  const result = await mcp.callTool({ name: 'get_translation', arguments: { key: 'home.title', locale: 'fr' } });

  expect(http.requests[0].url).toBe('/v1/translations?key=home.title&locale=fr');
  expect(result.structuredContent).toEqual(ROW_WIRE);
});

test('upsert_translation writes a simple value', async () => {
  http.queue(json(200, ROW_WIRE));

  const result = await mcp.callTool({
    name: 'upsert_translation',
    arguments: { key: 'home.title', locale: 'fr', value: 'Bienvenue' },
  });

  expect(http.requests[0].method).toBe('PUT');
  expect(JSON.parse(http.requests[0].body)).toEqual({ key: 'home.title', locale: 'fr', content: 'Bienvenue' });
  expect(result.structuredContent).toEqual(ROW_WIRE);
});

test('upsert_translation rejects value+plural_forms together, without touching the API', async () => {
  const result = await mcp.callTool({
    name: 'upsert_translation',
    arguments: { key: 'k', locale: 'fr', value: 'x', plural_forms: { other: 'y' } },
  });

  expect(result.isError).toBe(true);
  expect(String((result.content as { text: string }[])[0].text)).toMatch(/exactly one of/i);
  expect(http.requests).toHaveLength(0);
});

test('upsert_translation rejects a call with neither value nor plural_forms', async () => {
  const result = await mcp.callTool({ name: 'upsert_translation', arguments: { key: 'k', locale: 'fr' } });

  expect(result.isError).toBe(true);
  expect(http.requests).toHaveLength(0);
});

test('translate_missing posts scope=missing and returns the queued batch', async () => {
  http.queue(json(202, BATCH_WIRE));

  const result = await mcp.callTool({ name: 'translate_missing', arguments: { locales: ['fr'] } });

  expect(JSON.parse(http.requests[0].body)).toEqual({ scope: 'missing', locales: ['fr'] });
  expect(result.structuredContent).toEqual(BATCH_WIRE);
});

test('get_batch_status passes include_failures through', async () => {
  http.queue(json(200, { ...BATCH_WIRE, failures: [] }));

  const result = await mcp.callTool({ name: 'get_batch_status', arguments: { batch_id: 9, include_failures: true } });

  expect(http.requests[0].url).toBe('/v1/batches/9?include=failures');
  expect(result.structuredContent).toEqual({ ...BATCH_WIRE, failures: [] });
});

test('list_batches wraps the bare array for structured output', async () => {
  http.queue(json(200, [BATCH_WIRE]));

  const result = await mcp.callTool({ name: 'list_batches', arguments: { active_only: true } });

  expect(http.requests[0].url).toBe('/v1/batches?status=active');
  expect(result.structuredContent).toEqual({ batches: [BATCH_WIRE] });
});

test('run_qa returns the dispatched job handle', async () => {
  http.queue(json(202, { dispatched_jobs: 3, rows: 81 }));

  const result = await mcp.callTool({ name: 'run_qa', arguments: { scope: 'stale' } });

  expect(JSON.parse(http.requests[0].body)).toEqual({ scope: 'stale' });
  expect(result.structuredContent).toEqual({ dispatched_jobs: 3, rows: 81 });
});

test('glossary_list_terms surfaces next_cursor and passes the cursor through', async () => {
  http.queue(json(200, { data: [GLOSSARY_TERM_WIRE], next_cursor: 'NDI=' }));
  http.queue(json(200, { data: [], next_cursor: null }));

  const first = await mcp.callTool({ name: 'glossary_list_terms', arguments: {} });
  const second = await mcp.callTool({ name: 'glossary_list_terms', arguments: { cursor: 'NDI=', status: 'pending' } });

  expect(first.structuredContent).toEqual({ terms: [GLOSSARY_TERM_WIRE], next_cursor: 'NDI=' });
  expect(http.requests[1].url).toBe('/v1/glossary?status=pending&cursor=NDI%3D');
  expect(second.structuredContent).toEqual({ terms: [], next_cursor: null });
});

test('glossary_add_term creates and glossary_update_term replaces', async () => {
  http.queue(json(201, GLOSSARY_TERM_WIRE));
  http.queue(json(200, GLOSSARY_TERM_WIRE));

  const created = await mcp.callTool({
    name: 'glossary_add_term',
    arguments: { source_term: 'Dashboard', translations: { fr: 'Tableau de bord' } },
  });
  const updated = await mcp.callTool({
    name: 'glossary_update_term',
    arguments: { term_id: 3, source_term: 'Dashboard', do_not_translate: true },
  });

  expect(http.requests[0].method).toBe('POST');
  expect(http.requests[1].method).toBe('PUT');
  expect(http.requests[1].url).toBe('/v1/glossary/3');
  expect(created.structuredContent).toEqual(GLOSSARY_TERM_WIRE);
  expect(updated.structuredContent).toEqual(GLOSSARY_TERM_WIRE);
});

test('glossary_delete_term reports the deletion', async () => {
  http.queue({ status: 204 });

  const result = await mcp.callTool({ name: 'glossary_delete_term', arguments: { term_id: 3 } });

  expect(http.requests[0].method).toBe('DELETE');
  expect(result.structuredContent).toEqual({ deleted: true, term_id: 3 });
});

test('pull_file returns content, filename and skipped_keys', async () => {
  http.queue({
    status: 200,
    headers: { 'Content-Disposition': 'attachment; filename="fr.json"', 'X-Skipped-Keys': '2' },
    body: '{"a":"b"}',
  });

  const result = await mcp.callTool({ name: 'pull_file', arguments: { format: 'json_flat', locale: 'fr' } });

  expect(result.structuredContent).toEqual({ content: '{"a":"b"}', filename: 'fr.json', skipped_keys: 2 });
});

/**
 * Ruling R8: the field rides only when the server sent the header, so an older
 * server (and the case above, whose fake sends none) reports nothing rather than
 * a confident 0. The fake sends BOTH counters at different values, because a
 * field wired to X-Skipped-Keys would otherwise be indistinguishable.
 */
test('pull_file reports the omitted invalid ICU count when the server sends it', async () => {
  http.queue({
    status: 200,
    headers: {
      'Content-Disposition': 'attachment; filename="fr.json"',
      'X-Skipped-Keys': '2',
      'X-Omitted-Invalid-Icu-Keys': '5',
    },
    body: '{"a":"b"}',
  });

  const result = await mcp.callTool({ name: 'pull_file', arguments: { format: 'json_flat', locale: 'fr' } });

  expect(result.structuredContent).toEqual({
    content: '{"a":"b"}',
    filename: 'fr.json',
    skipped_keys: 2,
    omitted_invalid_icu_keys: 5,
  });
});

test('push_file uploads the content and returns the diff summary', async () => {
  http.queue(json(200, PUSH_RESULT_WIRE));

  const result = await mcp.callTool({
    name: 'push_file',
    arguments: { format: 'json_flat', locale: 'en', content: '{"a":"b"}' },
  });

  expect(http.requests[0].headers['content-type']).toMatch(/^multipart\/form-data/);
  expect(http.requests[0].body).not.toContain('name="metadata"');
  // No sidecar sent, so no warning about one, even though this response has no metadata block.
  expect(result.structuredContent).toEqual(PUSH_RESULT_WIRE);
});

const SIDECAR = '{"cart.title":{"description":"Cart page heading","max_length":40}}';
const METADATA_WIRE = { descriptions_updated: 1, max_lengths_updated: 1, unknown_keys: [], unknown_keys_count: 0 };

test('push_file sends a metadata sidecar as a file part, and returns what it changed', async () => {
  http.queue(json(200, { ...PUSH_RESULT_WIRE, metadata: METADATA_WIRE }));

  const result = await mcp.callTool({
    name: 'push_file',
    arguments: { format: 'json_flat', locale: 'en', content: '{"cart.title":"Cart"}', metadata: SIDECAR },
  });

  // A FILE part: the server refuses a plain `metadata` field with metadata-invalid.
  expect(http.requests[0].body).toContain('name="metadata"; filename="metadata.json"');
  expect(http.requests[0].body).toContain(SIDECAR);
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toEqual({ ...PUSH_RESULT_WIRE, metadata: METADATA_WIRE });
});

test('push_file says when the server ignored the sidecar', async () => {
  // A server without B1 drops the unknown part and answers 200 with no metadata block.
  http.queue(json(200, PUSH_RESULT_WIRE));

  const result = await mcp.callTool({
    name: 'push_file',
    arguments: { format: 'json_flat', locale: 'en', content: '{}', metadata: SIDECAR },
  });

  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toEqual({
    ...PUSH_RESULT_WIRE,
    warnings: ['something minor', 'this server ignored the metadata sidecar'],
  });
});

test('an API problem surfaces as an MCP tool error with the actionable hint', async () => {
  http.queue(problem(429, 'quota-exceeded', "The account's AI words for this cycle are used.", {
    quota: { reason: 'plan_allowance', scope: 'account', requested: 5, resets_at: '2026-11-01T00:00:00+00:00' },
  }));

  const result = await mcp.callTool({ name: 'translate_missing', arguments: {} });

  expect(result.isError).toBe(true);
  const text = String((result.content as { text: string }[])[0].text);
  expect(text).toContain('quota-exceeded');
  expect(text).toContain('1 Nov 2026');
});

test('tool errors never contain the token', async () => {
  http.queue(problem(400, 'weird', 'echoing tgl_secret back at you'));

  const result = await mcp.callTool({ name: 'get_project', arguments: {} });

  expect(result.isError).toBe(true);
  const text = String((result.content as { text: string }[])[0].text);
  expect(text).not.toContain('tgl_secret');
});

test('invalid enum input is rejected by the schema before any HTTP call', async () => {
  // `toml` is not a FileFormat and never has been. This previously used `yaml`,
  // which only "passed" because FORMAT_VALUES was missing it — asserting a bug
  // (an unreachable real format) as a feature. Use a sentinel we won't implement.
  const result = await mcp.callTool({ name: 'pull_file', arguments: { format: 'toml', locale: 'fr' } });

  expect(result.isError).toBe(true);
  expect(http.requests).toHaveLength(0);
});

test('push_file declares the metadata block in its outputSchema, as optional', async () => {
  // The SDK passes undeclared structured fields through, so only this case notices a result
  // shape the schema does not state. A client that reads the schema must learn the block exists.
  const { tools } = await mcp.listTools();
  const output = tools.find((tool) => tool.name === 'push_file')?.outputSchema as {
    properties: Record<string, { type?: string; properties?: Record<string, unknown> }>;
    required?: string[];
  };

  expect(Object.keys(output.properties.metadata?.properties ?? {}).sort()).toEqual([
    'descriptions_updated',
    'max_lengths_updated',
    'unknown_keys',
    'unknown_keys_count',
  ]);
  expect(output.required ?? []).not.toContain('metadata');
});

test('add_language posts to /locales and returns the canonical locale and batch id', async () => {
  http.queue(json(201, ADDED_LANGUAGE_WIRE));

  const result = await mcp.callTool({ name: 'add_language', arguments: { locale: 'pt-BR' } });

  expect(result.isError ?? false).toBe(false);
  expect(result.structuredContent).toEqual(ADDED_LANGUAGE_WIRE);
  expect(http.requests[0].method).toBe('POST');
  expect(http.requests[0].url).toBe('/v1/locales');
  expect(JSON.parse(http.requests[0].body)).toEqual({ locale: 'pt-BR' });
});

test('add_language passes translate_now through, and reports a skipped run as data, not an error', async () => {
  const skipped = { ...ADDED_LANGUAGE_WIRE, batch_id: null, backfill_skipped_reason: 'quota_exceeded' };
  http.queue(json(201, skipped));

  const result = await mcp.callTool({ name: 'add_language', arguments: { locale: 'de', translate_now: true } });

  expect(result.isError ?? false).toBe(false);
  expect(result.structuredContent).toEqual(skipped);
  expect(JSON.parse(http.requests[0].body)).toEqual({ locale: 'de', translate_now: true });
});

test('add_language surfaces a refusal as a tool error with the hint', async () => {
  http.queue(problem(422, 'locale-rejected', 'Unknown locale: use a BCP-47 tag like de, pt-BR, or zh-Hans.'));

  const result = await mcp.callTool({ name: 'add_language', arguments: { locale: 'klingon' } });

  expect(result.isError).toBe(true);
  const text = (result.content as { text: string }[])[0].text;
  expect(text).toContain('locale-rejected (HTTP 422)');
  expect(text).toContain('list_languages');
});

test('add_language refuses an over-long locale in the schema, before any HTTP call', async () => {
  const result = await mcp.callTool({ name: 'add_language', arguments: { locale: 'x'.repeat(36) } });

  expect(result.isError).toBe(true);
  expect(http.requests).toHaveLength(0);
});

test('list_languages no longer tells the agent that languages cannot be added', async () => {
  const { tools } = await mcp.listTools();
  const description = tools.find((tool) => tool.name === 'list_languages')?.description ?? '';

  expect(description).not.toMatch(/cannot add/i);
  expect(description).toContain('add_language');
  expect(mcp.getInstructions() ?? '').toContain('add_language');
});
