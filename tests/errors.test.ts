import { afterEach, beforeEach, expect, test } from 'vitest';

import { createClient } from '../src/api.js';
import type { ApiClient } from '../src/api.js';
import { PROJECT_WIRE, catchApiError, fakeSleep, json, problem, startMockServer } from './helpers.js';
import type { MockServer } from './helpers.js';

let server: MockServer;
let sleeps: number[];
let client: ApiClient;

beforeEach(async () => {
  server = await startMockServer();
  const fake = fakeSleep();
  sleeps = fake.calls;
  client = createClient({ baseUrl: server.url, token: 'tgl_secret', version: '0.1.0', sleep: fake.sleep });
});

afterEach(async () => {
  await server.close();
});

test('401 unauthenticated maps to an actionable token hint', async () => {
  server.queue(problem(401, 'unauthenticated', 'Unauthenticated.'));

  const error = await catchApiError(client.project());

  expect(error.problem.slug).toBe('unauthenticated');
  expect(error.problem.status).toBe(401);
  expect(error.message).toContain('Unauthenticated.');
  expect(error.hint).toContain('TRANSGLOT_TOKEN');
});

test('403 missing-ability names the missing ability in the hint', async () => {
  server.queue(problem(403, 'missing-ability', 'The token is missing a required ability.', { ability: 'manage' }));

  const error = await catchApiError(client.translate({ scope: 'missing' }));

  expect(error.problem.slug).toBe('missing-ability');
  expect(error.hint).toContain('"manage"');
});

test('403 plan-limit surfaces the resource and the upgrade hint', async () => {
  server.queue(problem(403, 'plan-limit', 'The glossary requires a higher plan.', {
    resource: 'glossary',
    cap: 0,
    upgrade_hint: 'Upgrade to Team to use the glossary.',
  }));

  const error = await catchApiError(client.glossaryList({}));

  expect(error.problem.slug).toBe('plan-limit');
  expect(error.message).toContain('The glossary requires a higher plan.');
  expect(error.hint).toContain('Upgrade to Team to use the glossary.');
});

test('404 not-found maps with a check-the-id hint', async () => {
  server.queue(problem(404, 'not-found', 'Not found.'));

  const error = await catchApiError(client.batch(999));

  expect(error.problem.slug).toBe('not-found');
  expect(error.hint).toContain('id');
});

test('422 validation-failed flattens the field errors into the hint', async () => {
  server.queue(problem(422, 'validation-failed', 'The request is invalid.', {
    errors: { locale: ['The locale field is required.'], scope: ['The selected scope is invalid.'] },
  }));

  const error = await catchApiError(client.qaRun({ scope: 'all' }));

  expect(error.problem.slug).toBe('validation-failed');
  expect(error.hint).toContain('locale: The locale field is required.');
  expect(error.hint).toContain('scope: The selected scope is invalid.');
});

test('422 locale-not-configured keeps the server detail as the message', async () => {
  server.queue(problem(422, 'locale-not-configured', 'Locale "xx" is not configured on this project.'));

  const error = await catchApiError(client.pull({ format: 'json_flat', locale: 'xx' }));

  expect(error.problem.slug).toBe('locale-not-configured');
  expect(error.message).toBe('Locale "xx" is not configured on this project.');
});

/** Every digit a hint carries outside its formatted reset date. */
function digitsOutsideTheDate(text: string): string[] {
  return text.replace(/\b\d{1,2} [A-Z][a-z]{2} \d{4}\b/g, '').match(/\d/g) ?? [];
}

test('429 quota-exceeded names the stop and the reset date, and carries no figure (ACS-02)', async () => {
  // The server's shape since P3 (spec 4.10): {reason, scope, requested, resets_at}, and no used,
  // limit, plan or name. A reader of an MCP error may not be the payer.
  server.queue(problem(429, 'quota-exceeded', "The account's AI words for this cycle are used.", {
    quota: { reason: 'plan_allowance', scope: 'account', requested: 50, resets_at: '2026-11-01T00:00:00+00:00' },
  }));

  const error = await catchApiError(client.translate({ scope: 'missing' }));

  expect(error.problem.slug).toBe('quota-exceeded');
  expect(error.hint).toContain('1 Nov 2026');
  expect(error.hint).not.toContain('used ');
  expect(error.hint).not.toContain('?');
  expect(digitsOutsideTheDate(error.hint ?? '')).toEqual([]);
});

test('429 quota-exceeded says a spend cap and paused overage apart from the plan allowance, each without a figure', async () => {
  server.queue(problem(429, 'quota-exceeded', 'Spend cap.', {
    quota: { reason: 'spend_cap', scope: 'account', requested: 50, resets_at: '2026-11-01T00:00:00+00:00' },
  }));
  server.queue(problem(429, 'quota-exceeded', 'Paused.', {
    quota: { reason: 'overage_paused', scope: 'account', requested: 50, resets_at: null },
  }));

  const cap = await catchApiError(client.translate({ scope: 'missing' }));
  const paused = await catchApiError(client.translate({ scope: 'missing' }));

  expect(cap.hint).toContain('spend cap');
  expect(cap.hint).toContain('1 Nov 2026');
  expect(paused.hint).toContain('beyond the plan is paused');
  expect(digitsOutsideTheDate(cap.hint ?? '')).toEqual([]);
  expect(digitsOutsideTheDate(paused.hint ?? '')).toEqual([]);
});

test('a refusal of AI spend that is not the words maps to its own hint, never a payment or a figure', async () => {
  const cases: [number, string, string][] = [
    [403, 'ai-paused', 'paused'],
    [403, 'email-verification-required', 'confirms their email address'],
    [403, 'free-account-held', 'no AI words'],
    [403, 'workspace-read-only', 'read-only'],
    [403, 'workspace-closed', 'support'],
  ];

  for (const [status, slug, needle] of cases) {
    server.queue(problem(status, slug, 'Refused.'));

    const error = await catchApiError(client.translate({ scope: 'missing' }));

    expect(error.problem.slug).toBe(slug);
    expect(error.hint).toContain(needle);
    expect(error.hint?.toLowerCase()).not.toMatch(/payment|card|invoice|balance/);
    expect(digitsOutsideTheDate(error.hint ?? '')).toEqual([]);
  }
});

test('429 extract-cap-reached names whose cap ran out and when it resets, without the cap', async () => {
  server.queue(problem(429, 'extract-cap-reached', 'Used.', {
    cap: { kind: 'extract', scope: 'workspace', resets_at: '2026-11-01T00:00:00+00:00' },
  }));

  const error = await catchApiError(client.translate({ scope: 'missing' }));

  expect(error.hint).toContain('This workspace has used its share of glossary extractions for this cycle.');
  expect(error.hint).toContain('1 Nov 2026');
  expect(digitsOutsideTheDate(error.hint ?? '')).toEqual([]);
});

test('409 active-batch carries the running batch id and a poll hint', async () => {
  server.queue(problem(409, 'active-batch', 'An AI translation batch is already running for this project.', {
    batch_id: 41,
  }));

  const error = await catchApiError(client.translate({ scope: 'missing' }));

  expect(error.problem.slug).toBe('active-batch');
  expect(error.hint).toContain('41');
  expect(error.hint).toContain('get_batch_status');
});

test('429 rate-limited honors Retry-After and succeeds on the retry', async () => {
  server.queue(problem(429, 'rate-limited', 'Too many requests.', {}, { 'Retry-After': '7' }));
  server.queue(json(200, PROJECT_WIRE));

  const project = await client.project();

  expect(project).toEqual(PROJECT_WIRE);
  expect(sleeps).toEqual([7000]);
  expect(server.requests).toHaveLength(2);
});

test('429 rate-limited retries are bounded (2), then the error surfaces', async () => {
  server.queue(problem(429, 'rate-limited', 'Too many requests.', {}, { 'Retry-After': '1' }));
  server.queue(problem(429, 'rate-limited', 'Too many requests.', {}, { 'Retry-After': '1' }));
  server.queue(problem(429, 'rate-limited', 'Too many requests.', {}, { 'Retry-After': '1' }));

  const error = await catchApiError(client.project());

  expect(error.problem.slug).toBe('rate-limited');
  expect(sleeps).toEqual([1000, 1000]);
  expect(server.requests).toHaveLength(3);
});

test('Retry-After waits are capped at 60 seconds', async () => {
  server.queue(problem(429, 'rate-limited', 'Too many requests.', {}, { 'Retry-After': '3600' }));
  server.queue(json(200, PROJECT_WIRE));

  await client.project();

  expect(sleeps).toEqual([60_000]);
});

test('a non-JSON error body is a server error naming the HTTP status', async () => {
  server.queue({ status: 502, headers: { 'Content-Type': 'text/html' }, body: '<html>Bad Gateway</html>' });

  const error = await catchApiError(client.project());

  expect(error.problem.slug).toBe('non-problem-response');
  expect(error.message).toContain('502');
});

test('a network failure is surfaced as a reachability error, not a crash', async () => {
  const url = server.url;
  await server.close();
  const offline = createClient({ baseUrl: url, token: 'tgl_secret', version: '0.1.0' });

  const error = await catchApiError(offline.project());

  expect(error.problem.slug).toBe('network-error');
  expect(error.hint).toContain('reachable');
});

test('the token never appears in error messages, even when the server echoes it', async () => {
  server.queue(problem(400, 'weird', 'Rejected token tgl_secret for this project.'));

  const error = await catchApiError(client.project());

  expect(error.message).not.toContain('tgl_secret');
  expect(error.message).toContain('[redacted]');
});

test('422 metadata-invalid flattens the sidecar errors and says how many were not listed', async () => {
  server.queue(problem(422, 'metadata-invalid', 'The metadata sidecar is not valid.', {
    errors: [
      { path: 'cart.title.max_length', code: 'bad-max-length', message: 'A max_length is between 1 and 100000.' },
      { path: '', code: 'invalid-json', message: 'metadata.json:1:9: not valid JSON' },
    ],
    error_count: 12,
  }));

  const error = await catchApiError(client.push({ content: '{}', format: 'json_flat', locale: 'en', metadata: '{}' }));

  expect(error.problem.slug).toBe('metadata-invalid');
  expect(error.hint).toBe(
    'cart.title.max_length: A max_length is between 1 and 100000.; metadata.json:1:9: not valid JSON; and 10 more',
  );
});

test('403 token-creator-not-permitted says a new token is needed, and not to retry', async () => {
  server.queue(problem(403, 'token-creator-not-permitted', 'The person who created this token may not add languages to this project.'));

  const error = await catchApiError(client.addLanguage({ locale: 'de' }));

  expect(error.problem.slug).toBe('token-creator-not-permitted');
  expect(error.message).toBe('The person who created this token may not add languages to this project.');
  expect(error.hint).toMatch(/new token/);
  expect(error.hint).toMatch(/Do not retry/);
});

test('422 locale-rejected keeps the server detail and says where to look', async () => {
  server.queue(problem(422, 'locale-rejected', 'That language is already in this project.'));

  const error = await catchApiError(client.addLanguage({ locale: 'fr' }));

  expect(error.problem.slug).toBe('locale-rejected');
  expect(error.message).toBe('That language is already in this project.');
  expect(error.hint).toMatch(/list_languages/);
  expect(error.hint).toMatch(/BCP 47/);
});

test('422 plan-limit on the languages total says a used language is free, and never says to upgrade', async () => {
  // The account-total refusal carries no cap and no upgrade_hint: a token holder is not the payer.
  server.queue(problem(422, 'plan-limit', 'The account this workspace belongs to has no room for another language on its plan. Ask an account owner: Noor Haddad.', {
    resource: 'languages',
  }));

  const error = await catchApiError(client.addLanguage({ locale: 'es' }));

  expect(error.problem.slug).toBe('plan-limit');
  expect(error.hint).toMatch(/already uses can still be added/);
  expect(error.hint).not.toMatch(/upgrade/i);
  expect(error.hint).not.toMatch(/\d/);
});
