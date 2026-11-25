import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ApiError } from '../src/api.js';

/** One request as the mock server saw it — method, path+query, headers, raw body. */
export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface QueuedResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export interface MockServer {
  url: string;
  requests: RecordedRequest[];
  /** FIFO responses; a request with an empty queue gets a 500 with a loud body. */
  queue(...responses: QueuedResponse[]): void;
  close(): Promise<void>;
}

/**
 * A REAL local HTTP server (loopback, ephemeral port) — the client under test uses
 * plain global fetch against it, so the wire (headers, multipart bodies, status
 * codes) is exercised for real. No external network is ever touched.
 */
export async function startMockServer(): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const pending: QueuedResponse[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: { ...req.headers },
        body: Buffer.concat(chunks).toString('utf8'),
      });

      const next = pending.shift() ?? { status: 500, body: JSON.stringify({ error: 'mock queue empty' }) };
      res.writeHead(next.status, { 'Content-Type': 'application/json', ...next.headers });
      res.end(next.body ?? '');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  let closed = false;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    queue: (...responses) => pending.push(...responses),
    close: () => {
      if (closed) {
        return Promise.resolve();
      }

      closed = true;

      return new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    },
  };
}

/** JSON 200-ish response for the queue. */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): QueuedResponse {
  return { status, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

/**
 * An RFC 7807 body exactly as ProblemRenderer emits it: NO `slug` field on the
 * wire — the slug rides in `type: "/problems/{slug}"`, and extensions are
 * TOP-LEVEL siblings of detail.
 */
export function problem(
  status: number,
  slug: string,
  detail: string,
  extensions: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): QueuedResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/problem+json', ...headers },
    body: JSON.stringify({
      type: `/problems/${slug}`,
      title: slug.charAt(0).toUpperCase() + slug.slice(1).replaceAll('-', ' '),
      status,
      detail,
      ...extensions,
    }),
  };
}

/** Awaits the promise and returns the ApiError it rejects with; fails on anything else. */
export async function catchApiError(promiseLike: Promise<unknown>): Promise<ApiError> {
  try {
    await promiseLike;
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }

    throw new Error(`Expected an ApiError, got: ${String(error)}`);
  }

  throw new Error('Expected an ApiError rejection, but the promise resolved.');
}

/** Fake sleep: resolves immediately and records every requested delay (ms). Never a real timer. */
export function fakeSleep(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];

  return {
    calls,
    sleep: (ms: number): Promise<void> => {
      calls.push(ms);

      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// Pinned REAL wire shapes — field names copied from the Laravel resources
// (ProjectResource, EditorRow, BatchResource, GlossaryTermResource, PushResult,
// QaRunner::run). If a test here disagrees with the server, the TEST is wrong.
// ---------------------------------------------------------------------------

export const PROJECT_WIRE = {
  id: 1,
  name: 'Demo',
  slug: 'demo',
  source_locale: 'en',
  locales: [
    { locale: 'en', name: 'English', rtl: false, is_source: true },
    { locale: 'fr', name: 'French', rtl: false, is_source: false },
  ],
  keys_count: 42,
};

/** EditorRow::for(...) — the exact {row: ...} envelope of GET/PUT /translations. */
export const ROW_WIRE = {
  row: {
    id: 7,
    name: 'home.title',
    description: null,
    is_plural: false,
    max_length: null,
    source: { id: 11, content: 'Welcome', plural_forms: null, state: 'human_edited', stale: false },
    target: {
      id: 12,
      content: 'Bienvenue',
      plural_forms: null,
      state: 'ai_translated',
      stale: false,
      needs_review: false,
      qa_score: null,
      qa_findings: null,
    },
  },
};

export const BATCH_WIRE = {
  id: 9,
  status: 'pending',
  trigger: 'manual_missing',
  total: 10,
  completed: 0,
  failed: 0,
  language_breakdown: { fr: 10 },
  started_at: null,
  finished_at: null,
};

export const GLOSSARY_TERM_WIRE = {
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
  created_at: '2026-07-07T00:00:00+00:00',
  updated_at: '2026-07-07T00:00:00+00:00',
};

export const PUSH_RESULT_WIRE = {
  keys_created: 2,
  keys_deleted: 0,
  source_updated: 1,
  translations_written: 3,
  conflicts: [{ key: 'a', locale: 'fr', reason: 'human_wins' }],
  unknown_keys: ['ghost.key'],
  warnings: ['something minor'],
  batch: null,
  quota_exceeded: false,
  translation_paused: null,
};

/** POST /v1/locales 201 body, exactly as the shared HTTP contract writes it. */
export const ADDED_LANGUAGE_WIRE = {
  language: { locale: 'pt_BR', name: 'Portuguese (Brazil)', native_name: 'Português (Brasil)', rtl: false },
  batch_id: 4821,
  backfill_skipped_reason: null,
};
