import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createClient } from '../src/api.js';
import { createConnectorServer } from '../src/connector.js';
import { createServer } from '../src/server.js';

/**
 * Every tool result, read by a client that CHECKS it.
 *
 * The SDK `Client` validates `structuredContent` against the outputSchema the server advertised in
 * tools/list, and refuses a result that does not match with -32602. A connector runtime may do
 * the same. The server passes the API's JSON through, and the API returns more fields than the
 * schemas name: some it has always sent (`auto_translate`, a locale's `progress`, a batch's
 * `tm_served`), and others it will add later. A schema that forbids unknown fields therefore fails
 * a live tool call, not just a test.
 *
 * The payloads below are the real Laravel shapes (ProjectResource, EditorRow, BatchResource,
 * BatchFailures, GlossaryTermResource, PushResult, AddsLanguageOverApi, QaRunner::run,
 * ConnectorProjectsController::present). On top of those, every object at every level also gets a
 * field no server sends today, standing in for the next additive change.
 */

const FUTURE_FIELD = 'future_field';
const FUTURE_VALUE = 'a field a later server adds';

/** Maps whose keys are data (locales, plural categories, skip reasons), not field names. */
const RECORD_KEYS = new Set(['plural_forms', 'translations', 'language_breakdown', 'skipped_reasons']);

/** Adds FUTURE_FIELD to every object, top-level and nested, except inside the records above. */
function withFutureFields<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => withFutureFields(item)) as T;
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const entries = Object.entries(value).map(([key, field]: [string, unknown]) => [
    key,
    RECORD_KEYS.has(key) ? field : withFutureFields(field),
  ]);

  return { ...Object.fromEntries(entries), [FUTURE_FIELD]: FUTURE_VALUE } as T;
}

const progress = { total: 2, reviewed: 0, human: 2, ai: 0, empty: 0, translated: 2, humanBacked: 2, percent: 100 };

/** GET /v1/project, as the live smoke read it (Task 17), plus the future fields. */
const PROJECT = withFutureFields({
  id: 1,
  name: 'Alpha Web',
  slug: 'alpha-web',
  source_locale: 'en',
  locales: [
    { locale: 'en', name: 'English', rtl: false, is_source: true, progress: null },
    { locale: 'fr', name: 'French', rtl: false, is_source: false, progress },
  ],
  keys_count: 2,
  message_syntax: 'auto',
  icu_dialect: 'icu4c',
  auto_translate: false,
  first_run_pending: true,
});

/** EditorRow::for(), with the editor fields the schema does not name. */
const ROW = withFutureFields({
  row: {
    id: 7,
    name: 'home.title',
    description: 'Heading on the home page',
    is_plural: false,
    max_length: 40,
    tags: [{ id: 2, name: 'marketing' }],
    source_tokens: { kind: 'simple', spans: [{ start: 0, end: 7, kind: 'text' }] },
    source: { id: 11, content: 'Welcome', plural_forms: null, state: 'human_edited', stale: false },
    target: {
      id: 12,
      content: 'Bienvenue',
      plural_forms: { one: 'Bienvenue', other: 'Bienvenue' },
      state: 'ai_translated',
      stale: false,
      content_hash: '9f86d081884c7d65',
      needs_review: true,
      qa_score: 82,
      mqm_score: 90,
      qa_findings: [{ category: 'terminology', severity: 'minor', message: 'Prefer "Accueil".', suggestion: 'Accueil' }],
      ai_confidence: 77,
      authored_by_you: false,
    },
  },
});

/** BatchResource. */
const BATCH = withFutureFields({
  id: 9,
  status: 'completed_with_errors',
  trigger: 'manual_missing',
  total: 10,
  completed: 8,
  failed: 2,
  skipped: 1,
  skipped_reasons: { human_value_stands: 1 },
  tm_served: 3,
  language_breakdown: { fr: 10 },
  started_at: '2026-11-11T10:00:00+00:00',
  finished_at: '2026-11-11T10:01:00+00:00',
});

/** BatchController::show with include=failures. */
const BATCH_WITH_FAILURES = withFutureFields({
  ...BATCH,
  failures: [{ key: 'home.title', locale: 'fr', error: 'provider timeout' }],
});

/** GlossaryTermResource. */
const TERM = withFutureFields({
  id: 3,
  source_term: 'Dashboard',
  source_normalized: 'dashboard',
  part_of_speech: 'noun',
  notes: null,
  case_sensitive: false,
  do_not_translate: false,
  forbidden: false,
  status: 'active',
  confidence: null,
  translations: { fr: 'Tableau de bord' },
  created_by: 'api',
  created_at: '2026-11-11T10:00:00+00:00',
  updated_at: '2026-11-11T10:00:00+00:00',
});

const GLOSSARY_PAGE = withFutureFields({ data: [TERM], next_cursor: null });

/** AddsLanguageOverApi, 201. */
const ADDED_LANGUAGE = withFutureFields({
  language: { locale: 'pt_BR', name: 'Portuguese (Brazil)', native_name: 'Português (Brasil)', rtl: false },
  batch_id: 4821,
  backfill_skipped_reason: null,
});

/** QaRunner::run, 202. */
const QA_HANDLE = withFutureFields({ dispatched_jobs: 2, rows: 14 });

/** PushResult::toArray() with a sidecar block and a queued batch. */
const PUSH = withFutureFields({
  metadata: { descriptions_updated: 1, max_lengths_updated: 0, unknown_keys: ['ghost.key'], unknown_keys_count: 1 },
  keys_created: 2,
  keys_deleted: 0,
  source_updated: 1,
  translations_written: 3,
  conflicts: [{ key: 'home.title', locale: 'fr', reason: 'human_wins' }],
  unknown_keys: ['ghost.key'],
  warnings: ['something minor'],
  batch: { ...BATCH, status: 'pending', completed: 0, failed: 0, started_at: null, finished_at: null },
  quota_exceeded: false,
  translation_paused: null,
});

/** ConnectorProjectsController, as the live smoke read it. */
const CONNECTOR_PAGE = withFutureFields({
  data: [
    {
      id: 1,
      name: 'Alpha Web',
      workspace: { id: 1, name: 'Smoke Alpha' },
      source_locale: 'en',
      target_locales: ['fr'],
      abilities: ['read', 'write', 'pull', 'push', 'manage'],
    },
  ],
  next_cursor: null,
});

const PULLED = '{\n  "home.title": "Bienvenue"\n}\n';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** What the API answers, keyed by "METHOD /path?query" under /v1. An unknown route is a test bug. */
const ROUTES: Record<string, () => Response> = {
  'GET /project': () => jsonResponse(200, PROJECT),
  'POST /locales': () => jsonResponse(201, ADDED_LANGUAGE),
  'GET /translations?key=home.title&locale=fr': () => jsonResponse(200, ROW),
  'PUT /translations': () => jsonResponse(200, ROW),
  'POST /translate': () => jsonResponse(202, BATCH),
  'GET /batches/9?include=failures': () => jsonResponse(200, BATCH_WITH_FAILURES),
  'GET /batches': () => jsonResponse(200, [BATCH]),
  'POST /batches/9/retry-failed': () => jsonResponse(202, BATCH),
  'POST /batches/9/cancel': () => jsonResponse(200, BATCH),
  'POST /qa/run': () => jsonResponse(202, QA_HANDLE),
  'GET /glossary': () => jsonResponse(200, GLOSSARY_PAGE),
  'POST /glossary': () => jsonResponse(201, TERM),
  'PUT /glossary/3': () => jsonResponse(200, TERM),
  'DELETE /glossary/3': () => new Response(null, { status: 204 }),
  'GET /pull?format=json_flat&locale=fr': () =>
    new Response(PULLED, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="fr.json"',
        'X-Skipped-Keys': '1',
        'X-Omitted-Invalid-Icu-Keys': '0',
      },
    }),
  'POST /push': () => jsonResponse(200, PUSH),
  'GET /connector/projects': () => jsonResponse(200, CONNECTOR_PAGE),
};

const BASE_URL = 'https://api.transglot.test';

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const route = `${init?.method ?? 'GET'} ${url.pathname.replace(/^\/v1/, '')}${url.search}`;
  const reply = ROUTES[route];

  if (reply === undefined) {
    throw new Error(`The fake API has no route for ${route}.`);
  }

  return reply();
}) as typeof fetch;

interface Case {
  tool: string;
  args: Record<string, unknown>;
  /** The structuredContent the tool must hand back: the API's fields, every one kept. */
  expected: unknown;
}

const CASES: Case[] = [
  { tool: 'get_project', args: {}, expected: PROJECT },
  { tool: 'list_languages', args: {}, expected: { source_locale: 'en', languages: PROJECT.locales } },
  { tool: 'add_language', args: { locale: 'pt-BR' }, expected: ADDED_LANGUAGE },
  { tool: 'get_translation', args: { key: 'home.title', locale: 'fr' }, expected: ROW },
  { tool: 'upsert_translation', args: { key: 'home.title', locale: 'fr', value: 'Bienvenue' }, expected: ROW },
  { tool: 'translate_missing', args: {}, expected: BATCH },
  { tool: 'get_batch_status', args: { batch_id: 9, include_failures: true }, expected: BATCH_WITH_FAILURES },
  { tool: 'list_batches', args: {}, expected: { batches: [BATCH] } },
  { tool: 'retry_failed_batch', args: { batch_id: 9 }, expected: BATCH },
  { tool: 'cancel_batch', args: { batch_id: 9 }, expected: BATCH },
  { tool: 'run_qa', args: { scope: 'missing' }, expected: QA_HANDLE },
  { tool: 'glossary_list_terms', args: {}, expected: { terms: [TERM], next_cursor: null } },
  { tool: 'glossary_add_term', args: { source_term: 'Dashboard' }, expected: TERM },
  { tool: 'glossary_update_term', args: { term_id: 3, source_term: 'Dashboard' }, expected: TERM },
  { tool: 'glossary_delete_term', args: { term_id: 3 }, expected: { deleted: true, term_id: 3 } },
  {
    tool: 'pull_file',
    args: { format: 'json_flat', locale: 'fr' },
    expected: { content: PULLED, filename: 'fr.json', skipped_keys: 1, omitted_invalid_icu_keys: 0 },
  },
  { tool: 'push_file', args: { format: 'json_flat', locale: 'fr', content: PULLED }, expected: PUSH },
];

const CONNECTOR_CASES: Case[] = [
  ...CASES.map((c) => ({ ...c, args: { ...c.args, project: '1' } })),
  { tool: 'list_projects', args: {}, expected: { projects: CONNECTOR_PAGE.data, next_cursor: null } },
];

const MODES: { mode: string; build: () => McpServer; cases: Case[] }[] = [
  {
    mode: 'project token (stdio)',
    build: () =>
      createServer({
        api: createClient({ baseUrl: BASE_URL, token: 'tgl_secret', version: '0.1.0', fetchImpl: fakeFetch }),
        version: '0.1.0',
      }),
    cases: CASES,
  },
  {
    mode: 'connector token (hosted)',
    build: () => createConnectorServer({ baseUrl: BASE_URL, token: 'tglc_secret', version: '0.1.0', fetchImpl: fakeFetch }),
    cases: CONNECTOR_CASES,
  },
];

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as { text: string }[]).map((part) => part.text).join('\n');
}

/** The JSON paths, under one advertised schema, of every node that forbids unknown fields. */
function closedNodes(schema: unknown, path = '$'): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((item: unknown, index) => closedNodes(item, `${path}[${index}]`));
  }

  if (typeof schema !== 'object' || schema === null) {
    return [];
  }

  const here = (schema as { additionalProperties?: unknown }).additionalProperties === false ? [path] : [];

  return [...here, ...Object.entries(schema).flatMap(([key, child]: [string, unknown]) => closedNodes(child, `${path}.${key}`))];
}

describe.each(MODES)('$mode', ({ build, cases }) => {
  let client: Client;
  let tools: Awaited<ReturnType<Client['listTools']>>['tools'];

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'validating-client', version: '0.0.0' });
    await Promise.all([build().connect(serverTransport), client.connect(clientTransport)]);

    // tools/list is what arms the client's validation: it caches one validator per outputSchema.
    ({ tools } = await client.listTools());
  });

  afterAll(async () => {
    await client.close();
  });

  test('every tool with an output schema has a case here', () => {
    const withOutputSchema = tools.filter((tool) => tool.outputSchema !== undefined).map((tool) => tool.name);

    expect(withOutputSchema.length).toBeGreaterThan(0);
    expect([...withOutputSchema].sort()).toEqual(cases.map((c) => c.tool).sort());
  });

  test('no advertised output schema forbids unknown fields, at any depth', () => {
    // Catches an object no case below happens to reach, such as a nested block added later.
    const closed = tools.flatMap((tool) => closedNodes(tool.outputSchema).map((path) => `${tool.name} ${path}`));

    expect(closed).toEqual([]);
  });

  test.each(cases)('$tool keeps every field the API sends and passes the client check', async ({ tool, args, expected }) => {
    // A result that fails the client's check rejects here with -32602, before any assertion.
    const result = await client.callTool({ name: tool, arguments: args });

    expect(result.isError ?? false, textOf(result)).toBe(false);
    expect(result.structuredContent).toEqual(expected);
    expect(JSON.parse(textOf(result))).toEqual(expected);
  });
});
