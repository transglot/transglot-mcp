import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';

import { createClient, createConnectorClient } from '../src/api.js';
import type { ApiClient } from '../src/api.js';
import { createCallScope, createConnectorServer, projectRegistrar } from '../src/connector.js';
import {
  GLOSSARY_TERM_WIRE,
  PROJECT_WIRE,
  PUSH_RESULT_WIRE,
  ROW_WIRE,
  catchApiError,
  fakeSleep,
  json,
  problem,
  startMockServer,
} from './helpers.js';
import type { MockServer } from './helpers.js';

/** One row of GET /v1/connector/projects, field for field as ConnectorProjectsController::present() writes it. */
const CONNECTOR_PROJECT_WIRE = {
  id: 42,
  name: 'Demo',
  workspace: { id: 3, name: 'Acme' },
  source_locale: 'en',
  target_locales: ['fr'],
  abilities: ['read', 'write', 'pull', 'push', 'manage'],
};

/** GET /v1/connector/session, as ConnectorSessionController writes it. */
const SESSION_WIRE = {
  data: {
    user: { name: 'Ada' },
    client: { name: 'Example client', verified: false },
    workspaces: [{ id: 3, name: 'Acme', reachable: true, reason: null }],
    abilities: ['read', 'write'],
    access_expires_at: '2026-11-12T10:00:00+00:00',
  },
};

/** The stdio tool surface, in registration order. Connector mode adds list_projects after it. */
const PROJECT_TOOLS = [
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

let http: MockServer;
let clients: Client[];
let mcp: Client;

async function connect(opts: { onUnauthenticated?: () => void; fetchImpl?: typeof fetch } = {}): Promise<Client> {
  const server = createConnectorServer({ baseUrl: http.url, token: 'tglc_secret', version: '0.1.0', ...opts });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);

  return client;
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as { text: string }[]).map((part) => part.text).join('\n');
}

beforeEach(async () => {
  http = await startMockServer();
  clients = [];
  mcp = await connect();
});

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await http.close();
});

test('connector mode adds an optional project argument to all 17 tools and adds list_projects', async () => {
  const { tools } = await mcp.listTools();

  expect(tools.map((tool) => tool.name)).toEqual([...PROJECT_TOOLS, 'list_projects']);

  for (const tool of tools.filter((t) => t.name !== 'list_projects')) {
    expect(tool.inputSchema.properties?.project, `${tool.name} takes project`).toMatchObject({ type: 'string' });
    expect(tool.inputSchema.required ?? [], `${tool.name} keeps project optional`).not.toContain('project');
  }

  // The tool's own arguments are untouched beside it.
  const getTranslation = tools.find((tool) => tool.name === 'get_translation');
  expect(getTranslation?.inputSchema.required).toEqual(['key', 'locale']);

  const listProjects = tools.find((tool) => tool.name === 'list_projects');
  expect(Object.keys(listProjects?.inputSchema.properties ?? {})).toEqual(['cursor']);
  expect(listProjects?.inputSchema.required ?? []).toEqual([]);
  expect(listProjects?.title).toBe('List projects');
  expect(listProjects?.annotations?.readOnlyHint).toBe(true);
});

test('the connector instructions say to call list_projects and pass project', () => {
  const instructions = mcp.getInstructions() ?? '';

  expect(instructions).toContain('list_projects');
  expect(instructions).toContain('project argument');
  // The stdio sentence would tell the agent the token is one project, which a connection is not.
  expect(instructions).not.toContain('project-scoped');
  expect(instructions).toContain('cancel_batch');
});

test('every tool in connector mode carries a title and states all three hints', async () => {
  const { tools } = await mcp.listTools();

  expect(tools).toHaveLength(18);

  for (const tool of tools) {
    expect(tool.title, `${tool.name} has a title`).toEqual(expect.any(String));
    expect(tool.title?.length ?? 0, `${tool.name} has a title`).toBeGreaterThan(0);

    // A client reads a missing hint as its default: not read-only, destructive, open-world.
    // ChatGPT's directory review asks for all three as explicit booleans.
    const hints = tool.annotations ?? {};
    expect(typeof hints.readOnlyHint, `${tool.name} states readOnlyHint`).toBe('boolean');
    expect(typeof hints.destructiveHint, `${tool.name} states destructiveHint`).toBe('boolean');
    expect(hints.openWorldHint, `${tool.name} reaches only the person's own projects`).toBe(false);

    if (hints.readOnlyHint === true) {
      expect(hints.destructiveHint, `${tool.name} is read-only, so not destructive`).toBe(false);
    }
  }
});

test('the project argument is sent as X-Transglot-Project and stripped from the body', async () => {
  http.queue(
    json(201, GLOSSARY_TERM_WIRE),
    json(200, GLOSSARY_TERM_WIRE),
    json(200, ROW_WIRE),
    json(200, PUSH_RESULT_WIRE),
  );

  const results = [
    // Passes its arguments whole to the body.
    await mcp.callTool({ name: 'glossary_add_term', arguments: { project: '42', source_term: 'Dashboard' } }),
    // Spreads the rest of its arguments into the body.
    await mcp.callTool({ name: 'glossary_update_term', arguments: { project: '42', term_id: 3, source_term: 'Board' } }),
    // Builds a query string.
    await mcp.callTool({ name: 'get_translation', arguments: { project: '42', key: 'home.title', locale: 'fr' } }),
    // Builds a multipart form.
    await mcp.callTool({ name: 'push_file', arguments: { project: '42', format: 'json_flat', locale: 'en', content: '{}' } }),
  ];

  for (const result of results) {
    expect(result.isError ?? false, textOf(result)).toBe(false);
  }

  // A named project needs no lookup: four calls, four requests.
  expect(http.requests).toHaveLength(4);

  for (const request of http.requests) {
    expect(request.headers['x-transglot-project']).toBe('42');
    expect(request.headers.authorization).toBe('Bearer tglc_secret');
  }

  // The two glossary bodies are the ones a leaked `project` would land in: those tools pass their
  // arguments on whole. The query and the form below are built field by field, so they pin the
  // header on those request shapes rather than the stripping.
  expect(JSON.parse(http.requests[0].body)).toEqual({ source_term: 'Dashboard' });
  expect(http.requests[1].url).toBe('/v1/glossary/3');
  expect(JSON.parse(http.requests[1].body)).toEqual({ source_term: 'Board' });
  expect(http.requests[2].url).toBe('/v1/translations?key=home.title&locale=fr');
  expect(http.requests[3].body).toContain('name="format"');
  expect(http.requests[3].body).not.toContain('name="project"');
});

test('a single reachable project is used when project is omitted', async () => {
  http.queue(
    json(200, { data: [CONNECTOR_PROJECT_WIRE], next_cursor: null }),
    json(200, PROJECT_WIRE),
    json(200, PROJECT_WIRE),
  );

  const first = await mcp.callTool({ name: 'get_project', arguments: {} });
  const second = await mcp.callTool({ name: 'list_languages', arguments: {} });

  expect(first.structuredContent).toEqual(PROJECT_WIRE);
  expect(second.isError ?? false).toBe(false);
  // One lookup for the server instance, asking for a page of two (enough to tell one from
  // several), then each call goes to the project it found.
  expect(http.requests.map((request) => request.url)).toEqual(['/v1/connector/projects?limit=2', '/v1/project', '/v1/project']);
  expect(http.requests[0].headers['x-transglot-project']).toBeUndefined();
  expect(http.requests[1].headers['x-transglot-project']).toBe('42');
  expect(http.requests[2].headers['x-transglot-project']).toBe('42');
});

test('the single project lookup is not shared across server instances', async () => {
  http.queue(
    json(200, { data: [CONNECTOR_PROJECT_WIRE], next_cursor: null }),
    json(200, PROJECT_WIRE),
    json(200, { data: [{ ...CONNECTOR_PROJECT_WIRE, id: 43 }], next_cursor: null }),
    json(200, PROJECT_WIRE),
  );
  const other = await connect();

  await mcp.callTool({ name: 'get_project', arguments: {} });
  await other.callTool({ name: 'get_project', arguments: {} });

  expect(http.requests.map((request) => request.url)).toEqual([
    '/v1/connector/projects?limit=2',
    '/v1/project',
    '/v1/connector/projects?limit=2',
    '/v1/project',
  ]);
  expect(http.requests[1].headers['x-transglot-project']).toBe('42');
  expect(http.requests[3].headers['x-transglot-project']).toBe('43');
});

test('several projects and no project argument returns a tool error naming list_projects', async () => {
  http.queue(json(200, { data: [CONNECTOR_PROJECT_WIRE, { ...CONNECTOR_PROJECT_WIRE, id: 43 }], next_cursor: null }));

  const result = await mcp.callTool({ name: 'get_project', arguments: {} });

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain('list_projects');
  expect(textOf(result)).toMatch(/more than one project/i);
  expect(http.requests).toHaveLength(1);
});

test('one project with a next page is not a single project', async () => {
  http.queue(json(200, { data: [CONNECTOR_PROJECT_WIRE], next_cursor: 'NDI' }));

  const result = await mcp.callTool({ name: 'get_project', arguments: {} });

  expect(result.isError).toBe(true);
  expect(textOf(result)).toMatch(/more than one project/i);
  expect(textOf(result)).toContain('list_projects');
  expect(http.requests).toHaveLength(1);
});

test('a connection that reaches no project says so and names list_projects', async () => {
  http.queue(json(200, { data: [], next_cursor: null }));

  const result = await mcp.callTool({ name: 'get_project', arguments: {} });

  expect(result.isError).toBe(true);
  expect(textOf(result)).toMatch(/reaches no project/i);
  expect(textOf(result)).toContain('list_projects');
  // Role-neutral: a connection whose only workspace is blocked lands here too, and an admin
  // cannot lift a block (only an Owner of the account can).
  expect(textOf(result)).toContain('ask for access in Transglot');
  expect(textOf(result)).not.toMatch(/admin/i);
  expect(http.requests).toHaveLength(1);
});

test('a project argument that is not a project id is refused before any request', async () => {
  const result = await mcp.callTool({ name: 'get_project', arguments: { project: 'demo' } });

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain('list_projects');
  expect(http.requests).toHaveLength(0);
});

test('connector-project-not-reachable surfaces its reason', async () => {
  // The detail is ConnectorProblem's own sentence for `cut-off`. It never says "cut-off", so the
  // reason assertion below can only pass if the reason itself is surfaced.
  const detail = 'An admin turned off connected apps for you on this project. Ask an admin to allow them again.';
  http.queue(problem(403, 'connector-project-not-reachable', detail, { reason: 'cut-off' }));

  const result = await mcp.callTool({ name: 'get_project', arguments: { project: '7' } });

  expect(result.isError).toBe(true);
  const text = textOf(result);
  expect(text).toContain('connector-project-not-reachable (HTTP 403)');
  expect(text).toContain(detail);
  expect(text).toContain('cut-off');
  expect(text).toContain('list_projects');
});

test('connector-project-required names list_projects', async () => {
  http.queue(problem(400, 'connector-project-required', 'Name the project with the X-Transglot-Project header, set to its id.'));

  const result = await mcp.callTool({ name: 'get_project', arguments: { project: '7' } });

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain('connector-project-required (HTTP 400)');
  expect(textOf(result).split('\n')[1]).toContain('list_projects');
});

test('missing-ability in connector mode points at the role, never at a new token', async () => {
  http.queue(problem(403, 'missing-ability', 'The token is missing a required ability.', { ability: 'manage' }));

  const result = await mcp.callTool({ name: 'translate_missing', arguments: { project: '42' } });

  expect(result.isError).toBe(true);
  const hint = textOf(result).split('\n')[1] ?? '';
  expect(hint).toContain('"manage"');
  // Cause one: the person's role, which a workspace admin changes.
  expect(hint).toMatch(/role in this project/i);
  expect(hint).toMatch(/workspace admin/i);
  // Cause two: the ability was not allowed when connecting, which reconnecting with it fixes.
  expect(hint).toMatch(/not allowed when Transglot was connected/i);
  expect(hint).toMatch(/reconnect Transglot in your client and allow it/i);
  expect(hint).not.toMatch(/token/i);
});

test('a dead connection calls onUnauthenticated and says to reconnect', async () => {
  const onUnauthenticated = vi.fn();
  const client = await connect({ onUnauthenticated });
  http.queue(
    problem(403, 'missing-ability', 'The token is missing a required ability.', { ability: 'manage' }),
    problem(401, 'unauthenticated', 'Unauthenticated.'),
  );

  const refused = await client.callTool({ name: 'translate_missing', arguments: { project: '42' } });

  // Another refusal is not a dead connection.
  expect(refused.isError).toBe(true);
  expect(onUnauthenticated).not.toHaveBeenCalled();

  const dead = await client.callTool({ name: 'get_project', arguments: { project: '42' } });

  expect(dead.isError).toBe(true);
  expect(textOf(dead)).toContain('unauthenticated (HTTP 401)');
  expect(textOf(dead)).toMatch(/reconnect Transglot in your client/i);
  expect(textOf(dead)).not.toContain('TRANSGLOT_TOKEN');
  expect(onUnauthenticated).toHaveBeenCalledTimes(1);
});

test('onUnauthenticated also fires from the single project lookup and from list_projects', async () => {
  const onUnauthenticated = vi.fn();
  const client = await connect({ onUnauthenticated });
  http.queue(problem(401, 'unauthenticated', 'Unauthenticated.'), problem(401, 'unauthenticated', 'Unauthenticated.'));

  const lookup = await client.callTool({ name: 'get_project', arguments: {} });

  expect(lookup.isError).toBe(true);
  expect(textOf(lookup)).toMatch(/reconnect Transglot in your client/i);
  expect(onUnauthenticated).toHaveBeenCalledTimes(1);

  const listed = await client.callTool({ name: 'list_projects', arguments: {} });

  expect(listed.isError).toBe(true);
  expect(textOf(listed)).toMatch(/reconnect Transglot in your client/i);
  expect(onUnauthenticated).toHaveBeenCalledTimes(2);
});

/** Runs fn and returns every rejection the process saw go unhandled while it ran. */
async function unhandledRejectionsDuring(fn: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', listener);

  try {
    await fn();
    // Node reports an unhandled rejection after the microtask queue drains; give it a turn.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off('unhandledRejection', listener);
  }

  return seen;
}

test('a throwing onUnauthenticated hook leaves the tool error and the reconnect hint intact', async () => {
  const onUnauthenticated = vi.fn(() => {
    throw new Error('cache eviction failed');
  });
  const client = await connect({ onUnauthenticated });
  http.queue(problem(401, 'unauthenticated', 'Unauthenticated.'));

  const result = await client.callTool({ name: 'get_project', arguments: { project: '42' } });

  expect(onUnauthenticated).toHaveBeenCalledTimes(1);
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain('unauthenticated (HTTP 401)');
  expect(textOf(result)).toMatch(/reconnect Transglot in your client/i);
  expect(textOf(result)).not.toContain('cache eviction failed');
});

test('a rejecting onUnauthenticated hook leaves the tool error intact and no unhandled rejection', async () => {
  // A plain function, not vi.fn: a vitest spy attaches its own handler to a promise it returns
  // (to record how it settled), which would hide the very unhandled rejection this looks for.
  let calls = 0;
  const onUnauthenticated = (): Promise<void> => {
    calls++;

    return Promise.reject(new Error('cache eviction failed'));
  };
  const client = await connect({ onUnauthenticated });
  http.queue(problem(401, 'unauthenticated', 'Unauthenticated.'));
  let text = '';

  const unhandled = await unhandledRejectionsDuring(async () => {
    const result = await client.callTool({ name: 'get_project', arguments: { project: '42' } });
    text = textOf(result);
  });

  expect(calls).toBe(1);
  expect(text).toMatch(/reconnect Transglot in your client/i);
  expect(text).not.toContain('cache eviction failed');
  expect(unhandled).toEqual([]);
});

test('a failed single project lookup is tried again on the next call', async () => {
  http.queue(
    problem(503, 'service-unavailable', 'Down for a moment.'),
    json(200, { data: [CONNECTOR_PROJECT_WIRE], next_cursor: null }),
    json(200, PROJECT_WIRE),
  );

  const failed = await mcp.callTool({ name: 'get_project', arguments: {} });
  const retried = await mcp.callTool({ name: 'get_project', arguments: {} });

  expect(failed.isError).toBe(true);
  expect(retried.structuredContent).toEqual(PROJECT_WIRE);
  expect(http.requests.map((request) => request.url)).toEqual([
    '/v1/connector/projects?limit=2',
    '/v1/connector/projects?limit=2',
    '/v1/project',
  ]);
});

test('list_projects returns the projects with their abilities and next_cursor, and passes the cursor through', async () => {
  http.queue(
    json(200, { data: [CONNECTOR_PROJECT_WIRE], next_cursor: 'NDI' }),
    json(200, { data: [], next_cursor: null }),
  );

  const first = await mcp.callTool({ name: 'list_projects', arguments: {} });
  const second = await mcp.callTool({ name: 'list_projects', arguments: { cursor: 'NDI' } });

  const page = { projects: [CONNECTOR_PROJECT_WIRE], next_cursor: 'NDI' };
  expect(first.isError ?? false).toBe(false);
  expect(first.structuredContent).toEqual(page);
  // The same pretty JSON text every other tool returns beside its structured content.
  expect(textOf(first)).toBe(JSON.stringify(page, null, 2));
  expect(second.structuredContent).toEqual({ projects: [], next_cursor: null });

  expect(http.requests[0].url).toBe('/v1/connector/projects');
  expect(http.requests[1].url).toBe('/v1/connector/projects?cursor=NDI');

  for (const request of http.requests) {
    expect(request.headers['x-transglot-project']).toBeUndefined();
    expect(request.headers.authorization).toBe('Bearer tglc_secret');
  }
});

test('concurrent calls each reach their own project', async () => {
  let lookups = 0;

  // Answers each call with the project its header names, the slow ones last, so the answers
  // come back in a different order than the calls went out.
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);

    if (url.includes('/v1/connector/projects')) {
      lookups++;
      await new Promise((resolve) => setTimeout(resolve, 15));

      return Response.json({ data: [{ ...CONNECTOR_PROJECT_WIRE, id: 5 }], next_cursor: null });
    }

    const project = new Headers(init?.headers).get('X-Transglot-Project') ?? 'none';
    await new Promise((resolve) => setTimeout(resolve, project === '1' ? 20 : 0));

    return Response.json({ ...PROJECT_WIRE, id: Number(project), name: `Project ${project}` });
  };
  const client = await connect({ fetchImpl });

  const asked = [undefined, '1', '2', undefined, '1', '3'];
  const results = await Promise.all(
    asked.map((project) =>
      client.callTool({ name: 'get_project', arguments: project === undefined ? {} : { project } }),
    ),
  );

  expect(results.map((result) => (result.structuredContent as { id: number }).id)).toEqual([5, 1, 2, 5, 1, 3]);
  // The calls that named no project shared one lookup.
  expect(lookups).toBe(1);
});

test('the call scope gives each call its own client, across its own awaits', async () => {
  // Every tool body touches `api` before its first await, so the concurrent tool calls above
  // cannot tell this apart from a shared "current client" variable. These bodies await first.
  const scope = createCallScope();
  const named = (name: string) => ({ project: () => Promise.resolve({ ...PROJECT_WIRE, name }) }) as unknown as ApiClient;

  const slow = scope.run(named('A'), async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));

    return (await scope.api.project()).name;
  });
  const fast = scope.run(named('B'), async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));

    return (await scope.api.project()).name;
  });

  expect(await Promise.all([slow, fast])).toEqual(['A', 'B']);
  expect(() => scope.api.project()).toThrow(/outside a tool call/);
});

test('the call scope hands back a plain value as it is, and only promises go through onResult', async () => {
  // onResult calls .catch, so a plain value reaching it would be a TypeError.
  let wrapped = 0;
  const scope = createCallScope(<T>(result: Promise<T>): Promise<T> => {
    wrapped++;

    return result.catch((error: unknown) => Promise.reject(error));
  });
  const client = { label: () => 'plain', project: () => Promise.resolve(PROJECT_WIRE) } as unknown as ApiClient;

  const label = scope.run(client, () => (scope.api as unknown as { label(): string }).label());
  const project = await scope.run(client, () => scope.api.project());

  expect(label).toBe('plain');
  expect(project).toEqual(PROJECT_WIRE);
  expect(wrapped).toBe(1);
});

test('the project registrar refuses a tool that already takes a project argument', () => {
  const registrar = projectRegistrar(async (_project, body) => body());
  const tools = registrar(new McpServer({ name: 'test', version: '0.0.0' }));

  expect(() =>
    tools.registerTool('own_project', { inputSchema: { project: z.number() } }, () => ({ content: [] })),
  ).toThrow(/own_project already has one/);
});

test('the project registrar refuses a whole zod schema as inputSchema', () => {
  const registrar = projectRegistrar(async (_project, body) => body());
  const tools = registrar(new McpServer({ name: 'test', version: '0.0.0' }));

  expect(() =>
    tools.registerTool('whole_schema', { inputSchema: z.object({ key: z.string() }) }, () => ({ content: [] })),
  ).toThrow(/raw zod shape/);
});

test('connector-mode hints for an unreachable server, a non-API answer and a rate limit name no env var or token', async () => {
  const unreachable = createClient({ baseUrl: 'http://127.0.0.1:9', token: 'tglc_secret', version: '0.1.0', project: '42' });
  const network = await catchApiError(unreachable.project());

  http.queue(
    { status: 502, headers: { 'Content-Type': 'text/html' }, body: '<html>Bad gateway</html>' },
    problem(429, 'rate-limited', 'Too many requests.', {}, { 'Retry-After': '1' }),
    problem(429, 'rate-limited', 'Too many requests.', {}, { 'Retry-After': '1' }),
    problem(429, 'rate-limited', 'Too many requests.', {}, { 'Retry-After': '1' }),
  );
  const connector = createClient({
    baseUrl: http.url,
    token: 'tglc_secret',
    version: '0.1.0',
    project: '42',
    sleep: () => Promise.resolve(),
  });
  const notAnApi = await catchApiError(connector.project());
  const limited = await catchApiError(connector.project());

  expect(network.problem.slug).toBe('network-error');
  expect(network.hint).toBe('Transglot could not be reached. Try again in a moment.');
  expect(notAnApi.problem.slug).toBe('non-problem-response');
  expect(notAnApi.hint).toMatch(/not an API response/);
  expect(limited.problem.slug).toBe('rate-limited');
  expect(limited.hint).toMatch(/60 requests a minute in each project/);
  expect(limited.hint).toMatch(/120 a minute/);

  for (const hint of [network.hint, notAnApi.hint, limited.hint]) {
    expect(hint).not.toMatch(/TRANSGLOT_BASE_URL|token/i);
  }
});

test('a connector-mode network error names no address; a project token keeps the stdio message', async () => {
  // fetch's own reason can name the host it failed to reach, as a DNS error does.
  const refuse: typeof fetch = () => Promise.reject(new TypeError('getaddrinfo ENOTFOUND api.internal.svc at http://10.1.2.3:8000'));
  const timeOut: typeof fetch = () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  const baseUrl = 'http://api.internal.svc:8000';

  const project = await catchApiError(createClient({ baseUrl, token: 'tglc_secret', version: '0.1.0', project: '42', fetchImpl: refuse }).project());
  const session = await catchApiError(createConnectorClient({ baseUrl, token: 'tglc_secret', version: '0.1.0', fetchImpl: refuse }).session());
  const slow = await catchApiError(createConnectorClient({ baseUrl, token: 'tglc_secret', version: '0.1.0', fetchImpl: timeOut }).projects());

  expect(project.message).toBe('Could not reach the Transglot API.');
  expect(session.message).toBe('Could not reach the Transglot API.');
  expect(slow.message).toBe('The Transglot API did not answer in time.');

  expect(project.hint).toBe('Transglot could not be reached. Try again in a moment.');
  expect(session.hint).toBe('Transglot could not be reached. Try again in a moment.');
  // A timeout left the building: the call may have landed, so it is not "could not be reached".
  expect(slow.hint).toBe('The request may or may not have been applied. Check before retrying a write.');

  for (const error of [project, session, slow]) {
    expect(error.problem.slug).toBe('network-error');
    expect(`${error.message} ${error.hint}`).not.toMatch(/internal|10\.1\.2\.3|8000|http/);
  }

  // A project token (stdio) keeps the message it always had, byte for byte.
  const stdio = await catchApiError(createClient({ baseUrl, token: 'tgl_secret', version: '0.1.0', fetchImpl: refuse }).project());
  expect(stdio.message).toBe('Network error calling http://api.internal.svc:8000/v1/project: getaddrinfo ENOTFOUND api.internal.svc at http://10.1.2.3:8000');
});

test('connector mode retries a 429 once, and only when the API asks for 10 s or less', async () => {
  const limited = (seconds: string) => problem(429, 'rate-limited', 'Too many requests.', {}, { 'Retry-After': seconds });

  // One retry, then the error.
  const once = fakeSleep();
  http.queue(limited('1'), limited('1'));
  const client = createClient({ baseUrl: http.url, token: 'tglc_secret', version: '0.1.0', project: '42', sleep: once.sleep });
  const twice = await catchApiError(client.project());

  expect(twice.problem.slug).toBe('rate-limited');
  expect(once.calls).toEqual([1000]);
  expect(http.requests).toHaveLength(2);
  expect(twice.hint).toMatch(/Try again in 1 second\.$/);
  expect(twice.hint).not.toMatch(/after retries/);

  // 10 s is waited out.
  const ten = fakeSleep();
  http.queue(limited('10'), json(200, PROJECT_WIRE));
  await createClient({ baseUrl: http.url, token: 'tglc_secret', version: '0.1.0', project: '42', sleep: ten.sleep }).project();
  expect(ten.calls).toEqual([10_000]);

  // Over 10 s is not waited at all: the error comes back at once.
  const eleven = fakeSleep();
  http.requests.length = 0;
  http.queue(limited('11'));
  const atOnce = await catchApiError(createClient({ baseUrl: http.url, token: 'tglc_secret', version: '0.1.0', project: '42', sleep: eleven.sleep }).project());
  expect(eleven.calls).toEqual([]);
  expect(http.requests).toHaveLength(1);
  expect(atOnce.hint).toMatch(/Try again in 11 seconds\.$/);
  expect(atOnce.retryAfterS).toBe(11);

  // A wild Retry-After reaches the agent capped at an hour.
  const wild = fakeSleep();
  http.queue(limited('1000000000'));
  const capped = await catchApiError(createClient({ baseUrl: http.url, token: 'tglc_secret', version: '0.1.0', project: '42', sleep: wild.sleep }).project());
  expect(wild.calls).toEqual([]);
  expect(capped.hint).toMatch(/Try again in 3600 seconds\.$/);

  // The connection-wide routes keep the same budget, and retries: 0 turns retrying off.
  const projects = fakeSleep();
  http.queue(limited('30'));
  await catchApiError(createConnectorClient({ baseUrl: http.url, token: 'tglc_secret', version: '0.1.0', sleep: projects.sleep }).projects());
  expect(projects.calls).toEqual([]);

  const session = fakeSleep();
  http.queue(limited('1'));
  const noRetry = await catchApiError(
    createConnectorClient({ baseUrl: http.url, token: 'tglc_secret', version: '0.1.0', sleep: session.sleep, retries: 0 }).session(),
  );
  expect(session.calls).toEqual([]);
  expect(noRetry.retryAfterS).toBe(1);
});

test('createClient sends X-Transglot-Project only when a project is set', async () => {
  http.queue(json(200, PROJECT_WIRE), json(200, PROJECT_WIRE));

  await createClient({ baseUrl: http.url, token: 'tgl_secret', version: '0.1.0' }).project();
  await createClient({ baseUrl: http.url, token: 'tglc_secret', version: '0.1.0', project: '42' }).project();

  expect(http.requests[0].headers['x-transglot-project']).toBeUndefined();
  expect(http.requests[1].headers['x-transglot-project']).toBe('42');
});

test('createConnectorClient reads the session and pages the projects', async () => {
  http.queue(
    json(200, SESSION_WIRE),
    json(200, { data: [CONNECTOR_PROJECT_WIRE], next_cursor: null }),
    json(200, { data: [], next_cursor: null }),
  );
  const connector = createConnectorClient({ baseUrl: `${http.url}/`, token: 'tglc_secret', version: '0.1.0' });

  const session = await connector.session();
  const page = await connector.projects('NDI');
  await connector.projects('NDI', 2);

  expect(session).toEqual(SESSION_WIRE.data);
  expect(page).toEqual({ data: [CONNECTOR_PROJECT_WIRE], next_cursor: null });
  expect(http.requests.map((request) => request.url)).toEqual([
    '/v1/connector/session',
    '/v1/connector/projects?cursor=NDI',
    '/v1/connector/projects?cursor=NDI&limit=2',
  ]);

  for (const request of http.requests) {
    expect(request.method).toBe('GET');
    expect(request.headers.authorization).toBe('Bearer tglc_secret');
    expect(request.headers['user-agent']).toBe('transglot-mcp/0.1.0');
    expect(request.headers['x-transglot-project']).toBeUndefined();
  }
});

test('a refused session is an unauthenticated ApiError that says to reconnect', async () => {
  http.queue(problem(401, 'unauthenticated', 'Unauthenticated.'));
  const connector = createConnectorClient({ baseUrl: http.url, token: 'tglc_secret', version: '0.1.0' });

  const error = await catchApiError(connector.session());

  expect(error.problem.slug).toBe('unauthenticated');
  expect(error.problem.status).toBe(401);
  expect(error.hint).toMatch(/reconnect Transglot in your client/i);
});
