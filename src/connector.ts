/**
 * Connector mode: the same 17 tools, reached with a connector token (`tglc_`) instead of a project
 * token. One connection reaches many projects, so each tool gains an optional `project` argument,
 * sent as the `X-Transglot-Project` header, and `list_projects` says which ids there are.
 *
 * BUILT ONCE PER HTTP REQUEST by the HTTP entry, so everything cached here (the single-project
 * lookup) lives exactly as long as one request. Nothing is shared between two servers.
 *
 * SECURITY: the token goes only into the API clients, which send it as the Authorization header
 * and redact it from every error, as in stdio mode.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { ApiError, createClient, createConnectorClient } from './api.js';
import type { ApiClient } from './api.js';
import { READ_ONLY, TOOL_FLOW_INSTRUCTIONS, createServer, ok, run, toolError } from './server.js';
import type { ToolRegistrar } from './server.js';

export interface ConnectorServerOptions {
  baseUrl: string;
  token: string;
  version: string;
  fetchImpl?: typeof fetch;
  /**
   * Called each time a call finds the connection itself dead (`unauthenticated`), so the caller
   * can drop what it cached about the token. It may be async. Whatever it throws or rejects with
   * is dropped: the tool result still says to reconnect.
   */
  onUnauthenticated?: () => void | Promise<unknown>;
}

const CONNECTOR_INSTRUCTIONS = (
  'Tools for the transglot localization projects this connection can reach. ' +
  'Call list_projects first: it lists each project id with its languages and the abilities you have there. ' +
  'Pass that id as the project argument of every other tool. It can be left out only when the connection reaches exactly one project. ' +
  TOOL_FLOW_INSTRUCTIONS
).trimEnd();

const PROJECT_ARGUMENT = z
  .string()
  .optional()
  .describe('The id of the project to work on, from list_projects, e.g. "42". Leave it out only when this connection reaches exactly one project.');

/**
 * Digits only. fetch itself refuses a header value with a line break in it, which would reach the
 * agent as a network error; anything else is the server's to answer (`not-found`).
 */
const PROJECT_ID = /^[0-9]+$/;

/** The single-project lookup asks for two: one says "this one", two say "name it". */
const LOOKUP_LIMIT = 2;

const NOT_A_PROJECT_ID = 'The project argument must be a project id (digits only), as list_projects lists them, e.g. "42".';
const SEVERAL_PROJECTS =
  'This connection reaches more than one project, so the project argument is required. Call list_projects and pass the id of the project to work on.';
const NO_PROJECT =
  'This connection reaches no project, so there is nothing to work on. Call list_projects to check again. To reach more, reconnect Transglot in your client and include another workspace, or ask for access in Transglot.';

/** GET /v1/connector/projects, one row. Mirrors ConnectorProject in api.ts; loose as in server.ts. */
const connectorProjectSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  workspace: z.looseObject({ id: z.number(), name: z.string() }),
  source_locale: z.string(),
  target_locales: z.array(z.string()),
  abilities: z.array(z.string()),
});

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type ToolBody = (args: Record<string, unknown>, extra: ToolExtra) => CallToolResult | Promise<CallToolResult>;

interface ToolConfig {
  title?: string;
  description?: string;
  inputSchema?: z.ZodRawShape;
  outputSchema?: z.ZodRawShape | z.ZodType;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

/**
 * THE CLIENT OF THE CALL IN FLIGHT. `run(client, fn)` runs one tool call, and `api` reads that
 * call's client at the moment the tool touches it. AsyncLocalStorage follows each call through its
 * own awaits, so two calls in flight at once each see their own client; nothing is held in a
 * variable another call could overwrite. Read outside a call, `api` throws rather than reach for
 * some other call's project. Every promise a method returns passes through `onResult` first; a
 * method that returns a plain value hands it back as it is.
 */
export function createCallScope(onResult: <T>(result: Promise<T>) => Promise<T> = (result) => result): {
  api: ApiClient;
  run<T>(client: ApiClient, fn: () => T): T;
} {
  const store = new AsyncLocalStorage<ApiClient>();

  const api = new Proxy({} as ApiClient, {
    get(_target, property) {
      const client = store.getStore();

      if (client === undefined) {
        throw new Error('The connector API client was used outside a tool call.');
      }

      const value: unknown = Reflect.get(client, property);

      if (typeof value !== 'function') {
        return value;
      }

      return (...args: unknown[]) => {
        const result: unknown = (value as (...a: unknown[]) => unknown).apply(client, args);

        return isThenable(result) ? onResult(Promise.resolve(result)) : result;
      };
    },
  });

  return { api, run: (client, fn) => store.run(client, fn) };
}

/**
 * Adds an optional `project` argument to every tool's input and strips it again before the tool's
 * own body sees its arguments, so it can never ride into a request body or query. The body then
 * runs through `runIn(project, body)`, which picks the project and the client.
 *
 * It refuses, at registration, a tool it cannot extend safely: one whose inputSchema is a whole zod
 * schema (spreading one does not add a key), or one that already takes a `project` argument of its
 * own (which this would silently replace and then strip).
 */
export function projectRegistrar(
  runIn: (project: string | undefined, body: () => CallToolResult | Promise<CallToolResult>) => Promise<CallToolResult>,
): ToolRegistrar {
  return (server) => {
    function registerTool(name: string, config: ToolConfig, body: ToolBody): RegisteredTool {
      const shape = config.inputSchema ?? {};

      if (typeof (shape as { safeParse?: unknown }).safeParse === 'function') {
        throw new Error(`Connector mode needs ${name}'s inputSchema as a raw zod shape.`);
      }

      if (Object.hasOwn(shape, 'project')) {
        throw new Error(`Connector mode adds the project argument itself, and ${name} already has one.`);
      }

      return server.registerTool(
        name,
        { ...config, inputSchema: { ...shape, project: PROJECT_ARGUMENT } },
        (args, extra) => {
          const { project, ...rest } = args as Record<string, unknown> & { project?: string };

          return runIn(project, () => body(rest, extra));
        },
      );
    }

    // The SDK's registerTool is generic over each tool's zod shapes; this wrapper takes any raw
    // shape and hands it on unchanged but for `project`, so it is cast once, here.
    return { registerTool: registerTool as unknown as McpServer['registerTool'] };
  };
}

export function createConnectorServer(opts: ConnectorServerOptions): McpServer {
  const connector = createConnectorClient(opts);

  /**
   * Tells the caller about a dead connection. The hook runs for its side effect only: a throw or a
   * rejection from it is dropped, so it can neither replace the reconnect hint in the tool result
   * nor leave an unhandled rejection in a long-running process.
   */
  function noticeDeadConnection(): void {
    try {
      const outcome: unknown = opts.onUnauthenticated?.();

      if (isThenable(outcome)) {
        outcome.then(undefined, () => undefined);
      }
    } catch {
      // Dropped on purpose; see above.
    }
  }

  /** Lets an error go on to the tool result, after telling the caller if it is a dead connection. */
  function notifyIfUnauthenticated<T>(promise: Promise<T>): Promise<T> {
    return promise.catch((error: unknown) => {
      if (error instanceof ApiError && error.problem.slug === 'unauthenticated') {
        noticeDeadConnection();
      }

      throw error;
    });
  }

  const scope = createCallScope(notifyIfUnauthenticated);

  /*
   * THE ONLY PROJECT, when a call names none. Asked once per server (so once per HTTP request),
   * shared by calls in flight together. A failed lookup is forgotten, so the next call asks again;
   * an answer, including "none" or "several", is kept for the life of the server.
   */
  let lookup: Promise<{ id: string } | { refusal: string }> | undefined;

  function onlyProject(): Promise<{ id: string } | { refusal: string }> {
    if (lookup !== undefined) {
      return lookup;
    }

    const current = notifyIfUnauthenticated(connector.projects(undefined, LOOKUP_LIMIT)).then((page) => {
      if (page.data.length === 0) {
        return { refusal: NO_PROJECT };
      }

      if (page.data.length > 1 || page.next_cursor !== null) {
        return { refusal: SEVERAL_PROJECTS };
      }

      return { id: String(page.data[0].id) };
    });

    lookup = current;
    current.catch(() => {
      if (lookup === current) {
        lookup = undefined;
      }
    });

    return current;
  }

  /** The project id a call acts on, or a throw the tool result reports. */
  async function projectFor(given: string | undefined): Promise<string> {
    if (given !== undefined) {
      if (!PROJECT_ID.test(given)) {
        throw new Error(NOT_A_PROJECT_ID);
      }

      return given;
    }

    const only = await onlyProject();

    if ('refusal' in only) {
      throw new Error(only.refusal);
    }

    return only.id;
  }

  const registrar = projectRegistrar(async (project, body) => {
    let id: string;

    try {
      id = await projectFor(project);
    } catch (error) {
      return toolError(error);
    }

    const client = createClient({
      baseUrl: opts.baseUrl,
      token: opts.token,
      version: opts.version,
      fetchImpl: opts.fetchImpl,
      project: id,
    });

    return scope.run(client, body);
  });

  const server = createServer({ api: scope.api, version: opts.version, instructions: CONNECTOR_INSTRUCTIONS, registrar });

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        'List the transglot projects this connection can work on now, up to 50 per page. Each comes with its id, name, workspace, source locale, target locales, and the abilities a call there acts with (read, write, pull, push, manage): the connected person\'s role in that project, narrowed to what was allowed when Transglot was connected. Pass a project\'s id as the project argument of the other tools, as a string such as "42". Pass next_cursor back as cursor for the next page; it is null on the last page. Free read with no side effects.',
      inputSchema: {
        cursor: z.string().optional().describe('Opaque pagination cursor from a previous call\'s next_cursor.'),
      },
      outputSchema: z.looseObject({ projects: z.array(connectorProjectSchema), next_cursor: z.string().nullable() }),
      annotations: READ_ONLY,
    },
    (args) =>
      run(async () => {
        const page = await notifyIfUnauthenticated(connector.projects(args.cursor));

        return ok({ projects: page.data, next_cursor: page.next_cursor });
      }),
  );

  return server;
}
