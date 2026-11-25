import { afterEach, beforeEach, expect, test } from 'vitest';

import { createClient } from '../src/api.js';
import type { ApiClient } from '../src/api.js';
import {
  ADDED_LANGUAGE_WIRE,
  BATCH_WIRE,
  GLOSSARY_TERM_WIRE,
  PROJECT_WIRE,
  PUSH_RESULT_WIRE,
  ROW_WIRE,
  json,
  startMockServer,
} from './helpers.js';
import type { MockServer } from './helpers.js';

let server: MockServer;
let client: ApiClient;

beforeEach(async () => {
  server = await startMockServer();
  client = createClient({ baseUrl: server.url, token: 'tgl_secret', version: '0.1.0' });
});

afterEach(async () => {
  await server.close();
});

test('sends bearer auth, accept and user-agent on every request', async () => {
  server.queue(json(200, PROJECT_WIRE));

  const project = await client.project();

  expect(project).toEqual(PROJECT_WIRE);
  const request = server.requests[0];
  expect(request.method).toBe('GET');
  expect(request.url).toBe('/v1/project');
  expect(request.headers.authorization).toBe('Bearer tgl_secret');
  expect(request.headers.accept).toBe('application/json');
  expect(request.headers['user-agent']).toBe('transglot-mcp/0.1.0');
});

test('a trailing slash on the base url never doubles', async () => {
  server.queue(json(200, PROJECT_WIRE));

  await createClient({ baseUrl: `${server.url}/`, token: 't', version: '0.1.0' }).project();

  expect(server.requests[0].url).toBe('/v1/project');
});

test('getTranslation queries key+locale and returns the exact row envelope', async () => {
  server.queue(json(200, ROW_WIRE));

  const result = await client.getTranslation({ key: 'home.title', locale: 'fr' });

  expect(server.requests[0].method).toBe('GET');
  expect(server.requests[0].url).toBe('/v1/translations?key=home.title&locale=fr');
  expect(result).toEqual(ROW_WIRE);
});

test('putTranslation PUTs a JSON body with content', async () => {
  server.queue(json(200, ROW_WIRE));

  await client.putTranslation({ key: 'home.title', locale: 'fr', content: 'Bienvenue' });

  const request = server.requests[0];
  expect(request.method).toBe('PUT');
  expect(request.url).toBe('/v1/translations');
  expect(request.headers['content-type']).toBe('application/json');
  expect(JSON.parse(request.body)).toEqual({ key: 'home.title', locale: 'fr', content: 'Bienvenue' });
});

test('putTranslation carries plural_forms and reviewer when given', async () => {
  server.queue(json(200, ROW_WIRE));

  await client.putTranslation({
    key: 'cart.items',
    locale: 'fr',
    plural_forms: { one: 'un article', other: '{count} articles' },
    reviewer: 'Ana',
  });

  expect(JSON.parse(server.requests[0].body)).toEqual({
    key: 'cart.items',
    locale: 'fr',
    plural_forms: { one: 'un article', other: '{count} articles' },
    reviewer: 'Ana',
  });
});

test('translate posts the scope body and returns the 202 batch', async () => {
  server.queue(json(202, BATCH_WIRE));

  const batch = await client.translate({ scope: 'missing', locales: ['fr'], key_ids: [7] });

  const request = server.requests[0];
  expect(request.method).toBe('POST');
  expect(request.url).toBe('/v1/translate');
  expect(JSON.parse(request.body)).toEqual({ scope: 'missing', locales: ['fr'], key_ids: [7] });
  expect(batch).toEqual(BATCH_WIRE);
});

test('translate omits absent optional fields from the body', async () => {
  server.queue(json(202, BATCH_WIRE));

  await client.translate({ scope: 'missing' });

  expect(JSON.parse(server.requests[0].body)).toEqual({ scope: 'missing' });
});

test('batch fetches by id; include=failures adds the query and surfaces failures', async () => {
  server.queue(json(200, BATCH_WIRE));
  server.queue(json(200, { ...BATCH_WIRE, failures: [{ key: 'a', locale: 'fr', error: 'boom' }] }));

  const plain = await client.batch(9);
  const withFailures = await client.batch(9, { failures: true });

  expect(server.requests[0].url).toBe('/v1/batches/9');
  expect(server.requests[1].url).toBe('/v1/batches/9?include=failures');
  expect(plain).toEqual(BATCH_WIRE);
  expect(withFailures.failures).toEqual([{ key: 'a', locale: 'fr', error: 'boom' }]);
});

test('batches lists all, or only active with ?status=active (bare JSON array)', async () => {
  server.queue(json(200, [BATCH_WIRE]));
  server.queue(json(200, []));

  const all = await client.batches();
  const active = await client.batches({ active: true });

  expect(server.requests[0].url).toBe('/v1/batches');
  expect(server.requests[1].url).toBe('/v1/batches?status=active');
  expect(all).toEqual([BATCH_WIRE]);
  expect(active).toEqual([]);
});

test('retryFailed posts to the retry endpoint and returns the new batch', async () => {
  server.queue(json(202, { ...BATCH_WIRE, id: 10, trigger: 'retry' }));

  const batch = await client.retryFailed(9);

  expect(server.requests[0].method).toBe('POST');
  expect(server.requests[0].url).toBe('/v1/batches/9/retry-failed');
  expect(batch.id).toBe(10);
});

test('qaRun posts the scope body and returns the job handle', async () => {
  server.queue(json(202, { dispatched_jobs: 2, rows: 55 }));

  const handle = await client.qaRun({ scope: 'all', locales: ['fr'] });

  expect(server.requests[0].method).toBe('POST');
  expect(server.requests[0].url).toBe('/v1/qa/run');
  expect(JSON.parse(server.requests[0].body)).toEqual({ scope: 'all', locales: ['fr'] });
  expect(handle).toEqual({ dispatched_jobs: 2, rows: 55 });
});

test('glossaryList returns the {data, next_cursor} page and passes status+cursor through', async () => {
  server.queue(json(200, { data: [GLOSSARY_TERM_WIRE], next_cursor: 'MTIz' }));
  server.queue(json(200, { data: [], next_cursor: null }));

  const first = await client.glossaryList({});
  const second = await client.glossaryList({ status: 'pending', cursor: 'MTIz' });

  expect(server.requests[0].url).toBe('/v1/glossary');
  expect(server.requests[1].url).toBe('/v1/glossary?status=pending&cursor=MTIz');
  expect(first).toEqual({ data: [GLOSSARY_TERM_WIRE], next_cursor: 'MTIz' });
  expect(second.next_cursor).toBeNull();
});

test('glossaryCreate posts the term and returns the 201 resource', async () => {
  server.queue(json(201, GLOSSARY_TERM_WIRE));

  const term = await client.glossaryCreate({ source_term: 'Dashboard', translations: { fr: 'Tableau de bord' } });

  expect(server.requests[0].method).toBe('POST');
  expect(server.requests[0].url).toBe('/v1/glossary');
  expect(JSON.parse(server.requests[0].body)).toEqual({ source_term: 'Dashboard', translations: { fr: 'Tableau de bord' } });
  expect(term).toEqual(GLOSSARY_TERM_WIRE);
});

test('glossaryUpdate PUTs the full term to /glossary/{id}', async () => {
  server.queue(json(200, { ...GLOSSARY_TERM_WIRE, notes: 'updated' }));

  const term = await client.glossaryUpdate(3, { source_term: 'Dashboard', notes: 'updated' });

  expect(server.requests[0].method).toBe('PUT');
  expect(server.requests[0].url).toBe('/v1/glossary/3');
  expect(term.notes).toBe('updated');
});

test('glossaryDelete DELETEs the term and tolerates the empty 204 body', async () => {
  server.queue({ status: 204 });

  await client.glossaryDelete(3);

  expect(server.requests[0].method).toBe('DELETE');
  expect(server.requests[0].url).toBe('/v1/glossary/3');
});

test('pull returns the file text, X-Skipped-Keys and the served filename', async () => {
  server.queue({
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="fr.json"',
      'X-Skipped-Keys': '3',
    },
    body: '{"home.title":"Bienvenue"}',
  });

  const result = await client.pull({ format: 'json_flat', locale: 'fr', min_state: 'reviewed' });

  expect(server.requests[0].url).toBe('/v1/pull?format=json_flat&locale=fr&min_state=reviewed');
  expect(result).toEqual({ content: '{"home.title":"Bienvenue"}', skippedKeys: 3, filename: 'fr.json' });
});

test('pull omits min_state when absent and defaults skippedKeys to 0', async () => {
  server.queue({ status: 200, body: '{}' });

  const result = await client.pull({ format: 'json_flat', locale: 'de' });

  expect(server.requests[0].url).toBe('/v1/pull?format=json_flat&locale=de');
  expect(result.skippedKeys).toBe(0);
  expect(result.filename).toBeNull();
});

test('push uploads multipart form data with file content, format, locale and mode', async () => {
  server.queue(json(200, PUSH_RESULT_WIRE));

  const result = await client.push({
    content: '{"home.title":"Welcome"}',
    filename: 'en.json',
    format: 'json_flat',
    locale: 'en',
    mode: 'sync_removals',
  });

  const request = server.requests[0];
  expect(request.method).toBe('POST');
  expect(request.url).toBe('/v1/push');
  expect(request.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
  expect(request.body).toContain('name="file"; filename="en.json"');
  expect(request.body).toContain('{"home.title":"Welcome"}');
  expect(request.body).toContain('name="format"');
  expect(request.body).toContain('json_flat');
  expect(request.body).toContain('name="locale"');
  expect(request.body).toContain('name="mode"');
  expect(request.body).toContain('sync_removals');
  expect(result).toEqual(PUSH_RESULT_WIRE);
});

test('push defaults the mode field to absent (server merges) and the filename to locale.ext', async () => {
  server.queue(json(200, PUSH_RESULT_WIRE));

  await client.push({ content: '{}', format: 'json_flat', locale: 'fr' });

  expect(server.requests[0].body).not.toContain('name="mode"');
  expect(server.requests[0].body).toContain('filename="fr.json"');
});

test('cancelBatch posts to the cancel endpoint and returns the batch', async () => {
  server.queue(json(200, { ...BATCH_WIRE, status: 'cancelled' }));

  const batch = await client.cancelBatch(9);

  expect(server.requests[0].method).toBe('POST');
  expect(server.requests[0].url).toBe('/v1/batches/9/cancel');
  expect(batch.status).toBe('cancelled');
});

test('addLanguage posts the locale and translate_now to /locales and returns the 201 body', async () => {
  server.queue(json(201, ADDED_LANGUAGE_WIRE));

  const added = await client.addLanguage({ locale: 'pt-BR', translate_now: false });

  const request = server.requests[0];
  expect(request.method).toBe('POST');
  expect(request.url).toBe('/v1/locales');
  expect(request.headers['content-type']).toBe('application/json');
  expect(JSON.parse(request.body)).toEqual({ locale: 'pt-BR', translate_now: false });
  expect(added).toEqual(ADDED_LANGUAGE_WIRE);
});

test('addLanguage leaves translate_now to the server when it is not given', async () => {
  server.queue(json(201, ADDED_LANGUAGE_WIRE));

  await client.addLanguage({ locale: 'de' });

  expect(JSON.parse(server.requests[0].body)).toEqual({ locale: 'de' });
});
