/**
 * The single HTTP client every MCP tool goes through. A thin, typed wrapper over
 * the transglot public REST API (`/v1`, Bearer project token, RFC 7807
 * problem+json errors) — the same contract the CLI consumes.
 *
 * SECURITY: the token is sent ONLY as the Authorization header. It is never
 * logged, and every error message is passed through {@link redactSecret} so a
 * server that echoes it back can never leak it into agent-visible output.
 */

/**
 * Mirrors App\Enums\FileFormat, in case order.
 *
 * SOURCE OF TRUTH: `app/Enums/FileFormat.php` in this repo. These values gate
 * the `pull_file` / `push_file` zod enums, so an id missing here makes a format
 * the API happily serves unreachable to an agent (the call is rejected by the
 * schema before any HTTP request, which reads to the agent as "not supported").
 * A stale id here does the opposite: it passes the schema and fails at the API.
 *
 * `tests/format-parity.test.ts` parses the PHP enum and fails on either drift.
 * When a codec lands on the server, add its id here AND its extension below.
 */
export const FORMAT_VALUES = [
  'json_flat',
  'json_nested',
  'android_xml',
  'ios_strings',
  'ios_stringsdict',
  'flutter_arb',
  'laravel_php',
  'laravel_json',
  'xliff_12',
  'ios_xcstrings',
  'gettext_po',
  'yaml',
  'csv',
  'xlsx',
  'xliff_20',
  'java_properties',
  'resx',
  'markdown',
  'unity_csv',
  'unreal_po',
] as const;

export type FileFormat = (typeof FORMAT_VALUES)[number];

/**
 * `FileFormat::extension()` parity, used to default the multipart upload
 * filename. A wrong entry uploads well-formed content under a name the server
 * side may sniff differently, so it is pinned against the PHP match arms in
 * `tests/format-parity.test.ts`. The `Record` type makes a missing entry a
 * typecheck failure as soon as an id is added to FORMAT_VALUES.
 */
export const FORMAT_EXTENSIONS: Record<FileFormat, string> = {
  json_flat: 'json',
  json_nested: 'json',
  android_xml: 'xml',
  ios_strings: 'strings',
  ios_stringsdict: 'stringsdict',
  flutter_arb: 'arb',
  laravel_php: 'php',
  laravel_json: 'json',
  xliff_12: 'xlf',
  ios_xcstrings: 'xcstrings',
  gettext_po: 'po',
  yaml: 'yml',
  csv: 'csv',
  xlsx: 'xlsx',
  xliff_20: 'xlf',
  java_properties: 'properties',
  resx: 'resx',
  markdown: 'md',
  unity_csv: 'csv',
  unreal_po: 'po',
};

// ---------------------------------------------------------------------------
// Wire types (field names match the Laravel resources exactly)
// ---------------------------------------------------------------------------

export interface ProjectInfo {
  id: number;
  name: string;
  slug: string;
  source_locale: string;
  locales: { locale: string; name: string; rtl: boolean; is_source: boolean }[];
  keys_count: number;
  message_syntax?: 'legacy' | 'auto' | 'icu';
  icu_dialect?: 'icu4c' | 'flutter';
}

export interface TranslationCell {
  id: number | null;
  content: string | null;
  plural_forms: Record<string, string> | null;
  state: string | null;
  stale: boolean;
}

export interface QaFinding {
  category: string;
  severity: string;
  message: string;
  suggestion?: string;
}

export interface TargetCell extends TranslationCell {
  needs_review: boolean;
  qa_score: number | null;
  qa_findings: QaFinding[] | null;
}

/** EditorRow::for(...) — the {row} payload of GET/PUT /translations. */
export interface EditorRow {
  id: number;
  name: string;
  description: string | null;
  is_plural: boolean;
  max_length: number | null;
  source: TranslationCell;
  target: TargetCell;
}

export type BatchStatus = 'pending' | 'processing' | 'completed' | 'completed_with_errors' | 'failed' | 'cancelled';

export interface Batch {
  id: number;
  status: BatchStatus;
  trigger: string;
  total: number;
  completed: number;
  failed: number;
  language_breakdown: Record<string, number> | null;
  started_at: string | null;
  finished_at: string | null;
  failures?: { key: string; locale: string; error: string | null }[];
}

export interface QaHandle {
  dispatched_jobs: number;
  rows: number;
}

export interface GlossaryTerm {
  id: number;
  source_term: string;
  source_normalized: string;
  part_of_speech: string | null;
  notes: string | null;
  case_sensitive: boolean;
  do_not_translate: boolean;
  forbidden: boolean;
  status: string;
  confidence: number | null;
  translations: Record<string, string>;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface GlossaryTermInput {
  source_term: string;
  part_of_speech?: string | null;
  notes?: string | null;
  case_sensitive?: boolean;
  do_not_translate?: boolean;
  forbidden?: boolean;
  translations?: Record<string, string>;
}

export interface PushResult {
  keys_created: number;
  keys_deleted: number;
  source_updated: number;
  translations_written: number;
  conflicts: { key: string; locale: string; reason: string }[];
  unknown_keys: string[];
  warnings: string[];
  batch: Batch | null;
  /** True when the account's words (the plan allowance or the spend cap) stopped the auto-translate run. */
  quota_exceeded: boolean;
  /**
   * The code of any other stop on AI spend that stopped the auto-translate run (`ai-paused`,
   * `email-verification-required`, `free-account-held`, ...), or null. Absent on a server older
   * than this field.
   */
  translation_paused?: string | null;
  /** What a metadata sidecar did; present only when one was sent AND the server understood it. */
  metadata?: PushMetadata;
}

/** B1's `KeyMetadataApplyResult::toArray()`. `unknown_keys` is a sample; the count is not capped. */
export interface PushMetadata {
  descriptions_updated: number;
  max_lengths_updated: number;
  unknown_keys: string[];
  unknown_keys_count: number;
}

export type TranslateScope = 'missing' | 'selected' | 'stale' | 'all';

/** POST /v1/locales 201 body (the server's shared add-language contract). */
export interface AddedLanguage {
  language: { locale: string; name: string; native_name: string | null; rtl: boolean };
  /** The run translating the existing strings into it, or null when nothing is translating. */
  batch_id: number | null;
  /**
   * Why a run that was asked for did not start. Null when one started, when none was asked for, or
   * when the project does not translate on its own (then batch_id is null too).
   */
  backfill_skipped_reason: 'quota_exceeded' | 'translation_paused' | 'nothing_to_translate' | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Parsed RFC 7807 body. slug is derived from `type: "/problems/{slug}"` — never a wire field. */
export interface Problem {
  slug: string;
  status: number;
  title: string;
  detail?: string;
  extensions: Record<string, unknown>;
}

/**
 * Every API failure the tools surface. `message` is the (redacted) server detail;
 * `hint` is the what-to-do-next line an agent can act on.
 */
export class ApiError extends Error {
  /**
   * The API's Retry-After, in seconds, when the refusal carried a numeric one. The HTTP entry
   * passes it on when the session check is rate-limited.
   */
  retryAfterS?: number;

  constructor(
    readonly problem: Problem,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Replaces every occurrence of the secret in text with "[redacted]". */
export function redactSecret(text: string, secret: string): string {
  return secret === '' ? text : text.replaceAll(secret, '[redacted]');
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ApiClient {
  project(): Promise<ProjectInfo>;
  addLanguage(p: { locale: string; translate_now?: boolean }): Promise<AddedLanguage>;
  getTranslation(q: { key: string; locale: string }): Promise<{ row: EditorRow }>;
  putTranslation(p: {
    key: string;
    locale: string;
    content?: string;
    plural_forms?: Record<string, string>;
    reviewer?: string;
  }): Promise<{ row: EditorRow }>;
  translate(p: { scope: TranslateScope; key_ids?: number[]; locales?: string[] }): Promise<Batch>;
  batch(id: number, opts?: { failures?: boolean }): Promise<Batch>;
  batches(opts?: { active?: boolean }): Promise<Batch[]>;
  retryFailed(id: number): Promise<Batch>;
  cancelBatch(id: number): Promise<Batch>;
  qaRun(p: { scope: TranslateScope; key_ids?: number[]; locales?: string[] }): Promise<QaHandle>;
  glossaryList(q: { status?: 'active' | 'pending' | 'rejected'; cursor?: string }): Promise<{
    data: GlossaryTerm[];
    next_cursor: string | null;
  }>;
  glossaryCreate(term: GlossaryTermInput): Promise<GlossaryTerm>;
  glossaryUpdate(id: number, term: GlossaryTermInput): Promise<GlossaryTerm>;
  glossaryDelete(id: number): Promise<void>;
  pull(q: { format: FileFormat; locale: string; min_state?: 'human_edited' | 'reviewed' }): Promise<{
    content: string;
    skippedKeys: number;
    filename: string | null;
    /**
     * How many entries the ICU export gate withheld because their translation
     * would not render. UNDEFINED, never 0, when the server sent no
     * X-Omitted-Invalid-Icu-Keys header: a server from before that gate never
     * checked, and reporting 0 for it would read as a guarantee it cannot make.
     */
    omittedInvalidIcuKeys?: number;
  }>;
  push(p: {
    content: string;
    format: FileFormat;
    locale: string;
    filename?: string;
    mode?: 'merge' | 'sync_removals';
    /** A key-metadata sidecar's JSON text, sent as its own FILE part. */
    metadata?: string;
  }): Promise<PushResult>;
}

/** GET /v1/connector/session's `data`: whose connection this is, and which workspaces it reaches now. */
export interface ConnectorSession {
  user: { name: string };
  client: { name: string; verified: boolean };
  workspaces: { id: number; name: string; reachable: boolean; reason: string | null }[];
  abilities: string[];
  access_expires_at: string | null;
}

/** One row of GET /v1/connector/projects: a project the connection can work on now. */
export interface ConnectorProject {
  id: number;
  name: string;
  workspace: { id: number; name: string };
  source_locale: string;
  target_locales: string[];
  /** The abilities a call to this project acts with: the person's role there, narrowed by the connection. */
  abilities: string[];
}

/** The two connector routes, which need the connector token and no project. */
export interface ConnectorApi {
  session(): Promise<ConnectorSession>;
  /** One page of reachable projects. `limit` is the page size: the server defaults to 50 and allows at most 100. */
  projects(cursor?: string, limit?: number): Promise<{ data: ConnectorProject[]; next_cursor: string | null }>;
}

const REQUEST_TIMEOUT_MS = 30_000;

/** The most seconds a rate-limited hint ever tells an agent to wait. */
const RETRY_AGAIN_CAP_S = 3600;

/**
 * Whose refusals these are. `token` is a project token (`tgl_`), which the person reissues to fix
 * a missing ability, and whose server they configure. `connector` is a connection (`tglc_`), whose
 * abilities follow the person's role in each project and what they allowed when connecting, which
 * only the client can renew, and whose server address the person never sets. So a few hints say
 * other things.
 */
type HintMode = 'token' | 'connector';

/** How a client answers a 429: how many retries, and the longest Retry-After it waits out. */
interface RateLimitPolicy {
  retries: number;
  maxWaitS: number;
  /** A Retry-After over maxWaitS: true waits maxWaitS and retries anyway, false gives up at once. */
  clamp: boolean;
}

/**
 * A project token (stdio) retries twice and cuts a longer wait to 60 s. A connection serves a
 * hosted client that has a request timeout of its own, so it retries once, and only when the API
 * asks for 10 s or less: a longer wait returns the rate-limited error at once.
 */
const RATE_LIMIT: Record<HintMode, RateLimitPolicy> = {
  token: { retries: 2, maxWaitS: 60, clamp: true },
  connector: { retries: 1, maxWaitS: 10, clamp: false },
};

/** A Retry-After header in seconds, when it is a positive number; anything else is undefined. */
function retryAfterSeconds(header: string | null): number | undefined {
  const seconds = Number(header ?? '');

  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

/**
 * The message for a server that could not be reached at all. A project token names the URL it
 * called and fetch's reason, for the person who set TRANSGLOT_BASE_URL. A connection names
 * neither: the hosted service calls the API at an address of its own, which may be internal, and
 * fetch's reason can name that host too (a DNS error does). A timeout is said apart, so an agent
 * does not read a write that may have landed as one that never left.
 */
function unreachableMessage(mode: HintMode, url: string, error: unknown): string {
  if (mode === 'connector') {
    return isTimeout(error) ? 'The Transglot API did not answer in time.' : 'Could not reach the Transglot API.';
  }

  const reason = error instanceof Error ? error.message : String(error);

  return `Network error calling ${url}: ${reason}`;
}

/**
 * The hint for a server that could not be reached at all. A connection's timeout says the call may
 * have landed, since the request did leave.
 */
function unreachableHint(mode: HintMode, error: unknown): string {
  if (mode === 'token') {
    return 'Check TRANSGLOT_BASE_URL and that the server is reachable.';
  }

  return isTimeout(error)
    ? 'The request may or may not have been applied. Check before retrying a write.'
    : 'Transglot could not be reached. Try again in a moment.';
}

/** The hint for an answer that is not an API response (not JSON, or no problem type). */
function notAnApiHint(mode: HintMode): string {
  return mode === 'connector'
    ? 'Transglot answered with something that is not an API response. Try again in a moment.'
    : 'Check that TRANSGLOT_BASE_URL points at a transglot server.';
}

interface SenderOptions {
  baseUrl: string;
  token: string;
  version: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  project?: string;
  mode: HintMode;
  /** Overrides the mode's rate-limit retries (see RATE_LIMIT). The HTTP entry's session check sets 0. */
  retries?: number;
}

/**
 * One request with the shared headers + 30s timeout. Non-2xx parses
 * problem+json; `rate-limited` is retried HERE, within the mode's budget
 * (RATE_LIMIT), so tools rarely see a transient 429. Everything else throws the
 * slug-mapped ApiError with an agent-actionable hint.
 */
function createSender(opts: SenderOptions): (path: string, init: { method: string; body?: FormData | string }) => Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const base = `${opts.baseUrl.replace(/\/+$/, '')}/v1`;
  const redact = (text: string): string => redactSecret(text, opts.token);
  const policy = RATE_LIMIT[opts.mode];
  const retries = opts.retries ?? policy.retries;

  return async function send(path, init) {
    const url = `${base}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.token}`,
      Accept: 'application/json',
      'User-Agent': `transglot-mcp/${opts.version}`,
    };

    if (opts.project !== undefined) {
      headers['X-Transglot-Project'] = opts.project;
    }

    // A JSON string body needs the explicit content type; FormData must NOT get
    // one (fetch writes the multipart boundary itself).
    if (typeof init.body === 'string') {
      headers['Content-Type'] = 'application/json';
    }

    for (let attempt = 0; ; attempt++) {
      let response: Response;

      try {
        response = await fetchImpl(url, {
          method: init.method,
          body: init.body,
          headers,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw new ApiError(
          { slug: 'network-error', status: 0, title: 'Network error', extensions: {} },
          redact(unreachableMessage(opts.mode, url, error)),
          unreachableHint(opts.mode, error),
        );
      }

      if (response.ok) {
        return response;
      }

      // From the header, whatever the body: a proxy's non-JSON 429 or 503 keeps its Retry-After.
      const retryAfterS = retryAfterSeconds(response.headers.get('Retry-After'));
      let problem: Problem;

      try {
        problem = await parseProblem(response, redact, opts.mode);
      } catch (error) {
        if (error instanceof ApiError) {
          error.retryAfterS = retryAfterS;
        }

        throw error;
      }

      if (problem.slug === 'rate-limited' && attempt < retries) {
        const waitS = retryAfterS ?? 1;

        if (waitS <= policy.maxWaitS || policy.clamp) {
          await sleep(Math.min(waitS, policy.maxWaitS) * 1000);
          continue;
        }
      }

      const error = toApiError(problem, opts.mode, retryAfterS);
      error.retryAfterS = retryAfterS;

      throw error;
    }
  };
}

export function createClient(opts: {
  baseUrl: string;
  token: string;
  version: string;
  /**
   * The project a connector token (`tglc_`) acts on, sent as `X-Transglot-Project`. Set only for
   * a connector client: a project token is its project and never sends it. Setting it also gives
   * the client's refusals the connector hints.
   */
  project?: string;
  fetchImpl?: typeof fetch; // injected in tests
  sleep?: (ms: number) => Promise<void>; // injected in tests (Retry-After waits)
}): ApiClient {
  const send = createSender({ ...opts, mode: opts.project === undefined ? 'token' : 'connector' });

  async function getJson<T>(path: string): Promise<T> {
    const response = await send(path, { method: 'GET' });

    return (await response.json()) as T;
  }

  async function sendJson<T>(path: string, method: 'POST' | 'PUT', body: Record<string, unknown>): Promise<T> {
    const response = await send(path, { method, body: JSON.stringify(body) });

    return (await response.json()) as T;
  }

  return {
    project: () => getJson<ProjectInfo>('/project'),

    addLanguage: (p) => sendJson<AddedLanguage>('/locales', 'POST', compact(p)),

    getTranslation: (q) =>
      getJson<{ row: EditorRow }>(`/translations?${new URLSearchParams({ key: q.key, locale: q.locale }).toString()}`),

    putTranslation: (p) => sendJson<{ row: EditorRow }>('/translations', 'PUT', compact(p)),

    translate: (p) => sendJson<Batch>('/translate', 'POST', compact(p)),

    batch: (id, opts2) => getJson<Batch>(`/batches/${id}${opts2?.failures === true ? '?include=failures' : ''}`),

    batches: (opts2) => getJson<Batch[]>(`/batches${opts2?.active === true ? '?status=active' : ''}`),

    retryFailed: async (id) => {
      const response = await send(`/batches/${id}/retry-failed`, { method: 'POST' });

      return (await response.json()) as Batch;
    },

    cancelBatch: async (id) => {
      const response = await send(`/batches/${id}/cancel`, { method: 'POST' });

      return (await response.json()) as Batch;
    },

    qaRun: (p) => sendJson<QaHandle>('/qa/run', 'POST', compact(p)),

    glossaryList: (q) => {
      const params = new URLSearchParams();

      if (q.status !== undefined) {
        params.set('status', q.status);
      }

      if (q.cursor !== undefined) {
        params.set('cursor', q.cursor);
      }

      const query = params.size > 0 ? `?${params.toString()}` : '';

      return getJson<{ data: GlossaryTerm[]; next_cursor: string | null }>(`/glossary${query}`);
    },

    glossaryCreate: (term) => sendJson<GlossaryTerm>('/glossary', 'POST', compact(term)),

    glossaryUpdate: (id, term) => sendJson<GlossaryTerm>(`/glossary/${id}`, 'PUT', compact(term)),

    glossaryDelete: async (id) => {
      await send(`/glossary/${id}`, { method: 'DELETE' }); // 204 — never parse the body
    },

    async pull(q) {
      const params = new URLSearchParams({ format: q.format, locale: q.locale });

      if (q.min_state !== undefined) {
        params.set('min_state', q.min_state);
      }

      const response = await send(`/pull?${params.toString()}`, { method: 'GET' });
      const content = await response.text();
      const skipped = Number(response.headers.get('X-Skipped-Keys') ?? '0');
      const disposition = response.headers.get('Content-Disposition') ?? '';
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? null;

      // Absent header -> absent field. `Number(null)` is 0 and `Number('')` is 0,
      // so the presence test is on the header itself, not on the parsed number.
      const omittedHeader = response.headers.get('X-Omitted-Invalid-Icu-Keys');
      const omitted = omittedHeader === null ? Number.NaN : Number(omittedHeader);

      return {
        content,
        skippedKeys: Number.isFinite(skipped) ? skipped : 0,
        filename,
        ...(Number.isFinite(omitted) ? { omittedInvalidIcuKeys: omitted } : {}),
      };
    },

    async push(p) {
      const filename = p.filename ?? `${p.locale}.${FORMAT_EXTENSIONS[p.format]}`;
      const form = new FormData();
      form.set('file', new Blob([p.content], { type: 'text/plain' }), filename);
      form.set('format', p.format);
      form.set('locale', p.locale);

      if (p.mode !== undefined) {
        form.set('mode', p.mode);
      }

      // A FILE part, never a field: the server refuses a plain `metadata` field outright.
      if (p.metadata !== undefined) {
        form.set('metadata', new Blob([p.metadata], { type: 'application/json' }), 'metadata.json');
      }

      const response = await send('/push', { method: 'POST', body: form });

      return (await response.json()) as PushResult;
    },
  };
}

/**
 * The connector routes (`/v1/connector/*`) for a connector token. They name no project, so this
 * client sends no `X-Transglot-Project`; a call into one project goes through
 * {@link createClient} with `project` set.
 */
export function createConnectorClient(opts: {
  baseUrl: string;
  token: string;
  version: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>; // injected in tests (Retry-After waits)
  /** Rate-limit retries, instead of connector mode's one. The HTTP entry's session check sets 0. */
  retries?: number;
}): ConnectorApi {
  const send = createSender({ ...opts, mode: 'connector' });

  return {
    async session() {
      const response = await send('/connector/session', { method: 'GET' });

      return ((await response.json()) as { data: ConnectorSession }).data;
    },

    async projects(cursor, limit) {
      const params = new URLSearchParams();

      if (cursor !== undefined) {
        params.set('cursor', cursor);
      }

      if (limit !== undefined) {
        params.set('limit', String(limit));
      }

      const query = params.size > 0 ? `?${params.toString()}` : '';
      const response = await send(`/connector/projects${query}`, { method: 'GET' });

      return (await response.json()) as { data: ConnectorProject[]; next_cursor: string | null };
    },
  };
}

/** Drops undefined values so optional fields never ride the wire as null. */
function compact(record: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

/** Parses an RFC 7807 body; non-JSON or type-less bodies are server errors outright. */
async function parseProblem(response: Response, redact: (text: string) => string, mode: HintMode): Promise<Problem> {
  let body: unknown;

  try {
    body = await response.json();
  } catch {
    throw new ApiError(
      { slug: 'non-problem-response', status: response.status, title: 'Unexpected response', extensions: {} },
      `Server returned HTTP ${response.status} with a non-JSON body.`,
      notAnApiHint(mode),
    );
  }

  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const typeField = typeof record.type === 'string' ? record.type : '';
  const match = typeField.match(/^\/problems\/(.+)$/);

  if (match === null) {
    throw new ApiError(
      { slug: 'non-problem-response', status: response.status, title: 'Unexpected response', extensions: {} },
      `Server returned HTTP ${response.status} without a problem type.`,
      notAnApiHint(mode),
    );
  }

  // Extensions (errors, ability, quota, batch_id, keys, …) ride as TOP-LEVEL
  // siblings of detail — collect everything that is not an RFC 7807 base key.
  const extensions: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (key !== 'type' && key !== 'title' && key !== 'status' && key !== 'detail') {
      extensions[key] = value;
    }
  }

  return {
    slug: match[1],
    status: response.status,
    title: typeof record.title === 'string' ? redact(record.title) : `HTTP ${response.status}`,
    detail: typeof record.detail === 'string' ? redact(record.detail) : undefined,
    extensions,
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An ISO instant as the server writes a date in its own sentences: "3 Nov 2026", in UTC. */
function utcDate(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') {
    return null;
  }

  const at = new Date(value);

  return Number.isNaN(at.getTime()) ? null : `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
}

/** " They reset on 3 Nov 2026." or nothing, when the server sent no reset date. */
function resetSentence(resetsAt: unknown): string {
  const date = utcDate(resetsAt);

  return date === null ? '' : ` They reset on ${date}.`;
}

/**
 * The AI cap sentence of spec 4.12.2 for `cap: {kind, scope, resets_at}`: whose cap ran out and
 * when it resets, never the cap, the share or the count used.
 */
function capSentence(cap: unknown): string {
  const fields = (typeof cap === 'object' && cap !== null ? cap : {}) as Record<string, unknown>;
  const what = fields.kind === 'assistant' ? 'AI assistant requests' : fields.kind === 'extract' ? 'glossary extractions' : 'AI suggestions';
  const used = fields.scope === 'workspace'
    ? `This workspace has used its share of ${what} for this cycle.`
    : `The account this workspace belongs to has used its ${what} for this cycle.`;

  return `${used}${resetSentence(fields.resets_at)}`;
}

/**
 * The hints that differ for a connection. Its abilities are the person's role in each project,
 * narrowed to the abilities allowed when Transglot was connected, not a token they can reissue,
 * and a dead connection is renewed by the client, not by an env var.
 */
function connectorHint(problem: Problem, retryAfterS: number | undefined): string | undefined {
  switch (problem.slug) {
    case 'unauthenticated':
      return 'The Transglot connection has expired or was disconnected. Reconnect Transglot in your client, then try again.';
    // Either half of the narrowing can be the one missing it, and only the person can tell which.
    case 'missing-ability':
      return `This connection cannot use the "${String(problem.extensions.ability ?? 'required')}" ability in this project, for one of two reasons. The connected person's role in this project may not allow it: a workspace admin can change their role in the Transglot console. Or it was not allowed when Transglot was connected: reconnect Transglot in your client and allow it. Do not retry until one of those is done.`;
    case 'token-creator-not-permitted':
      return "The connected person's role may no longer add languages to this project. A workspace admin can change their role in the Transglot console. Do not retry until then.";
    // A connection call is throttled as its own row on the project (`throttle:api`, push and
    // cancel apart), and the connector routes as the whole connection (`throttle:connector`).
    // Said without "after retries": a wait over 10 s is not retried at all.
    case 'rate-limited':
      return `Rate-limited. The API allows this connection 60 requests a minute in each project, and 120 a minute across list_projects and the other connection-wide calls. ${retryAgain(retryAfterS)}`;
    default:
      return undefined;
  }
}

/**
 * "Try again in 30 seconds." when the API said when, else "Try again shortly." The figure is
 * capped at an hour, so a wild Retry-After never reaches the agent as it is.
 */
function retryAgain(retryAfterS: number | undefined): string {
  if (retryAfterS === undefined) {
    return 'Try again shortly.';
  }

  const seconds = Math.min(Math.ceil(retryAfterS), RETRY_AGAIN_CAP_S);

  return `Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`;
}

/** slug → agent-actionable hint. Message is the server's (redacted) detail. */
function toApiError(problem: Problem, mode: HintMode, retryAfterS?: number): ApiError {
  const message = problem.detail ?? problem.title;
  const connector = mode === 'connector' ? connectorHint(problem, retryAfterS) : undefined;

  if (connector !== undefined) {
    return new ApiError(problem, message, connector);
  }

  switch (problem.slug) {
    case 'unauthenticated':
      return new ApiError(problem, message, 'Check TRANSGLOT_TOKEN. Create a project access token in the transglot web UI (project settings → access tokens).');
    case 'missing-ability':
      return new ApiError(problem, message, `The token lacks the "${String(problem.extensions.ability ?? 'required')}" ability. Issue a token that has it.`);
    // A connector call that named no project. The MCP server always names one, so this reads as
    // a bug or an old client, and the hint says where an id comes from.
    case 'connector-project-required':
      return new ApiError(problem, message, 'Pass the project argument, set to a project id from list_projects.');
    // The detail (the message) is the server's sentence for the reason; the reason itself rides
    // in the hint, so an agent can tell a role from a cut-off without parsing prose.
    case 'connector-project-not-reachable':
      return new ApiError(
        problem,
        message,
        `Reason: ${String(problem.extensions.reason ?? 'unknown')}. list_projects lists the projects this connection can work on now.`,
      );
    case 'plan-limit': {
      // An account total, refused with no figure and no upgrade_hint: the token's holder is not
      // the payer, and the cap counts DISTINCT languages, so one another project uses is free.
      if (problem.extensions.resource === 'languages') {
        return new ApiError(problem, message, "The account's plan has no room for another language. A language another project of this account already uses can still be added; otherwise an account owner can change the plan in the Transglot console. Do not retry with other new languages.");
      }

      const upgrade = typeof problem.extensions.upgrade_hint === 'string' ? problem.extensions.upgrade_hint : 'Upgrade the organization plan to use this feature.';

      return new ApiError(problem, message, upgrade);
    }
    /*
     * The account's words (spec 4.10). The server states WHICH stop and when it lifts, never a
     * figure, a plan or a name, because the reader of an agent's error may not be the payer
     * (ACS-02). The hint follows suit: no used, no limit, no fallback "?" standing in for them.
     */
    case 'quota-exceeded': {
      const quota = (problem.extensions.quota ?? {}) as Record<string, unknown>;
      const reset = resetSentence(quota.resets_at);

      switch (quota.reason) {
        case 'spend_cap':
          return new ApiError(problem, message, `This run would pass the account's spend cap.${reset} An account owner can raise the cap in the Transglot console. Do not retry until then.`);
        case 'overage_paused':
          return new ApiError(problem, message, "Usage beyond the plan is paused for this account, and this run needs more words than the plan has left. An account owner can see why in the Transglot console.");
        default:
          return new ApiError(problem, message, `The account's AI words for this cycle are used.${reset} An account owner can change the plan in the Transglot console. Do not retry until then.`);
      }
    }
    // The other stops on AI spend (spec 4.10). Each says what a token's holder can do, which is
    // to ask someone in the console; none names a payment, a figure or a person.
    case 'ai-paused':
      return new ApiError(problem, message, 'AI translation is paused for this workspace. An account owner can see why in the Transglot console. Do not retry until it is resolved.');
    case 'email-verification-required':
      return new ApiError(problem, message, 'AI translation starts when an owner of this account confirms their email address in Transglot.');
    case 'free-account-held':
      return new ApiError(problem, message, 'This account has no AI words. An account owner can see why in the Transglot console.');
    case 'workspace-read-only':
      return new ApiError(problem, message, 'The workspace is read-only, so nothing in it can be translated now. Reads and exports still work.');
    case 'workspace-closed':
      return new ApiError(problem, message, 'The workspace is not available. Contact support.');
    case 'suggest-cap-reached':
    case 'assistant-cap-reached':
    case 'extract-cap-reached':
      return new ApiError(problem, message, capSentence(problem.extensions.cap));
    case 'not-found':
      return new ApiError(problem, message, 'Check the id. It may not exist or may belong to a different project.');
    case 'rate-limited': // only reached after the in-client retries are exhausted
      return new ApiError(problem, message, 'Still rate-limited after retries (the API allows 60 requests/minute per token). Try again shortly.');
    case 'active-batch': {
      const id = String(problem.extensions.batch_id ?? '?');

      return new ApiError(problem, `${message} (batch #${id})`, `Poll get_batch_status with batch_id ${id} until it finishes, then retry.`);
    }
    case 'token-creator-not-permitted':
      return new ApiError(problem, message, 'The person who created this token may no longer add languages to the project. Ask someone who can add languages in the Transglot console to create a new token with the manage ability. Do not retry with this token.');
    case 'locale-rejected':
      return new ApiError(problem, message, 'Pass a BCP 47 tag such as "de", "pt-BR" or "zh-Hans". list_languages shows the languages the project already has, the source language included.');
    case 'validation-failed':
      return new ApiError(problem, message, flattenErrors(problem.extensions.errors));
    case 'metadata-invalid':
      return new ApiError(
        problem,
        message,
        flattenMetadataErrors(problem.extensions.errors, problem.extensions.error_count),
      );
    default:
      return problem.status >= 500
        ? new ApiError(problem, message, 'Server error. Retry; if it persists, check the server status.')
        : new ApiError(problem, message);
  }
}

function flattenErrors(errors: unknown): string | undefined {
  if (typeof errors !== 'object' || errors === null) {
    return undefined;
  }

  const lines: string[] = [];

  for (const [field, messages] of Object.entries(errors)) {
    lines.push(`${field}: ${Array.isArray(messages) ? messages.join(' ') : String(messages)}`);
  }

  return lines.length > 0 ? lines.join('; ') : undefined;
}

/**
 * A sidecar refusal as one hint: `path: message` per error, then how many were not listed. The
 * server sends at most fifty errors beside their uncapped count.
 */
function flattenMetadataErrors(errors: unknown, errorCount: unknown): string | undefined {
  if (!Array.isArray(errors)) {
    return undefined;
  }

  const lines: string[] = [];

  for (const error of errors) {
    if (typeof error !== 'object' || error === null) {
      continue;
    }

    const record = error as Record<string, unknown>;
    const path = typeof record.path === 'string' ? record.path : '';
    const text = typeof record.message === 'string' ? record.message : String(record.code ?? 'invalid');
    lines.push(path === '' ? text : `${path}: ${text}`);
  }

  const count = typeof errorCount === 'number' && Number.isInteger(errorCount) ? errorCount : lines.length;

  if (count > lines.length) {
    lines.push(`and ${count - lines.length} more`);
  }

  return lines.length > 0 ? lines.join('; ') : undefined;
}
