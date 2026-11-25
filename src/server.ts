import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { ApiError, FORMAT_VALUES } from './api.js';
import type { ApiClient } from './api.js';

/**
 * The MCP tool surface: a thin, honest 1:1 mapping onto the public REST API.
 * Read tools are annotated read-only; every mutating tool's description states
 * exactly what it changes and what it spends, so the calling agent can decide.
 * No tool invents a server capability that the API does not have.
 */

/**
 * The supported formats, rendered for the `pull_file` / `push_file` prose.
 *
 * DERIVED, never hand-written: a tool description is what an agent reads to
 * decide whether it can do the job, so a description that names fewer formats
 * than the zod enum admits is a capability the agent will never reach for. This
 * used to be a hardcoded list of 8 while the enum admitted 18. Building it from
 * FORMAT_VALUES makes that class of drift impossible.
 */
const FORMAT_LIST = FORMAT_VALUES.join(', ');

// ---------------------------------------------------------------------------
// Output schema fragments (zod) — mirror the pinned wire types in api.ts.
// EVERY object here, and every tool's outputSchema itself, is a z.looseObject():
// the schema names the fields an agent can rely on, and accepts the rest. The
// tools hand back the API's JSON as it came, and the API sends fields these do
// not name (a locale's progress, a batch's tm_served) and will add more. A plain
// z.object() is advertised in tools/list with additionalProperties: false, and
// a client that checks structuredContent against it (the SDK Client does)
// refuses every such result. tests/output-validation.test.ts holds that line.
// ---------------------------------------------------------------------------

const localeSchema = z.looseObject({
  locale: z.string(),
  name: z.string(),
  rtl: z.boolean(),
  is_source: z.boolean(),
});

const cellSchema = z.looseObject({
  id: z.number().nullable(),
  content: z.string().nullable(),
  plural_forms: z.record(z.string(), z.string()).nullable(),
  state: z.string().nullable(),
  stale: z.boolean(),
});

const targetCellSchema = cellSchema.extend({
  needs_review: z.boolean(),
  qa_score: z.number().nullable(),
  qa_findings: z
    .array(
      z.looseObject({
        category: z.string(),
        severity: z.string(),
        message: z.string(),
        suggestion: z.string().optional(),
      }),
    )
    .nullable(),
});

const rowSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  is_plural: z.boolean(),
  max_length: z.number().nullable(),
  source: cellSchema,
  target: targetCellSchema,
});

const batchSchema = z.looseObject({
  id: z.number(),
  status: z.enum(['pending', 'processing', 'completed', 'completed_with_errors', 'failed', 'cancelled']),
  trigger: z.string(),
  total: z.number(),
  completed: z.number(),
  failed: z.number(),
  language_breakdown: z.record(z.string(), z.number()).nullable(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  failures: z.array(z.looseObject({ key: z.string(), locale: z.string(), error: z.string().nullable() })).optional(),
});

const glossaryTermSchema = z.looseObject({
  id: z.number(),
  source_term: z.string(),
  source_normalized: z.string(),
  part_of_speech: z.string().nullable(),
  notes: z.string().nullable(),
  case_sensitive: z.boolean(),
  do_not_translate: z.boolean(),
  forbidden: z.boolean(),
  status: z.string(),
  confidence: z.number().nullable(),
  translations: z.record(z.string(), z.string()),
  created_by: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});

/** Shared input fragment for glossary term writes (glossary_add_term / glossary_update_term). */
const glossaryTermInput = {
  source_term: z.string().max(255).describe('The term as it appears in the source language.'),
  part_of_speech: z.string().max(30).optional().describe('Optional part of speech, e.g. "noun".'),
  notes: z.string().max(2000).optional().describe('Optional usage notes shown to translators and the AI.'),
  case_sensitive: z.boolean().optional().describe('Match the term case-sensitively (default false).'),
  do_not_translate: z
    .boolean()
    .optional()
    .describe('Keep the source term verbatim in every language (brand names etc.). Clears translations.'),
  forbidden: z.boolean().optional().describe('Flag the term as forbidden. QA reports any use of it. Clears translations.'),
  translations: z
    .record(z.string(), z.string())
    .optional()
    .describe('Map of locale code to required translation, e.g. {"fr": "Tableau de bord"}. Ignored when do_not_translate or forbidden is set.'),
};

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

/** Success result: pretty JSON text for humans + structuredContent for schemas. */
/** The same words the CLI prints, so a person comparing the two sees one message. */
const IGNORED_SIDECAR = 'this server ignored the metadata sidecar';

export function ok(data: object): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

/**
 * Every API failure becomes an in-band MCP tool error the agent can act on:
 * "slug (HTTP status): server detail" plus the what-to-do-next hint. ApiError
 * messages are already token-redacted by the client.
 */
export function toolError(error: unknown): CallToolResult {
  let text: string;

  if (error instanceof ApiError) {
    const head = `${error.problem.slug} (HTTP ${error.problem.status}): ${error.message}`;
    text = error.hint === undefined ? head : `${head}\n${error.hint}`;
  } else {
    text = error instanceof Error ? error.message : String(error);
  }

  return { isError: true, content: [{ type: 'text', text }] };
}

export async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    return toolError(error);
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/** How the tools fit together, the same for a project token and a connection. */
export const TOOL_FLOW_INSTRUCTIONS =
  'Typical flow: get_project to discover locales (add_language adds one) -> get_translation/upsert_translation for single values, ' +
  'pull_file/push_file for whole files -> translate_missing to AI-fill gaps -> get_batch_status to poll. ' +
  'AI tools (translate_missing, retry_failed_batch, run_qa, and add_language unless translate_now is false) spend the organization word quota. ' +
  'Use cancel_batch to stop a running batch and return its unspent words to the allowance. ';

/** The stdio server's instructions: one project token, one project. */
const PROJECT_TOKEN_INSTRUCTIONS =
  'Tools for one transglot localization project (the token is project-scoped). ' +
  TOOL_FLOW_INSTRUCTIONS +
  'The API allows 60 requests per minute per token.';

/**
 * Every tool states all three hints, because a client reads a missing one as its default: not
 * read-only, destructive, and open-world. ChatGPT's directory review asks for explicit booleans.
 * No tool reaches beyond the person's own Transglot projects, so none is open-world.
 */
export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

export function writes(hints: { destructiveHint: boolean; idempotentHint?: boolean }): ToolAnnotations {
  return { readOnlyHint: false, openWorldHint: false, ...hints };
}

/**
 * Where the 17 tools are registered. The default is the server itself. Connector mode passes a
 * registrar that adds a `project` argument to each tool and runs it against that project.
 */
export type ToolRegistrar = (server: McpServer) => Pick<McpServer, 'registerTool'>;

export function createServer(opts: {
  api: ApiClient;
  version: string;
  /** Replaces the project-token instructions (connector mode explains `project` and list_projects). */
  instructions?: string;
  registrar?: ToolRegistrar;
}): McpServer {
  const { api } = opts;

  const server = new McpServer(
    { name: 'transglot', version: opts.version },
    { instructions: opts.instructions ?? PROJECT_TOKEN_INSTRUCTIONS },
  );

  // Every tool below keeps a literal `<x>.registerTool('<name>'` call: McpToolCountClaimTest
  // counts them in this file to check the number the marketing site states.
  const tools = opts.registrar?.(server) ?? server;

  tools.registerTool(
    'get_project',
    {
      title: 'Get project',
      description:
        'Read the current project: id, name, slug, source locale, every configured locale (with RTL flag and which one is the source), the total key count, and the message syntax and icu dialect. Free read with no side effects. Call it first to learn which locales exist before reading or writing translations.',
      inputSchema: {},
      outputSchema: z.looseObject({
        id: z.number(),
        name: z.string(),
        slug: z.string(),
        source_locale: z.string(),
        locales: z.array(localeSchema),
        keys_count: z.number(),
        message_syntax: z.enum(['legacy', 'auto', 'icu']).optional(),
        icu_dialect: z.enum(['icu4c', 'flutter']).optional(),
      }),
      annotations: READ_ONLY,
    },
    () => run(async () => ok(await api.project())),
  );

  tools.registerTool(
    'list_languages',
    {
      title: 'List languages',
      description:
        'List the locales configured on the project (code, display name, RTL flag, is_source) plus the source locale. Free read with no side effects. Use add_language to add one; removing a language is done in the transglot web UI.',
      inputSchema: {},
      outputSchema: z.looseObject({ source_locale: z.string(), languages: z.array(localeSchema) }),
      annotations: READ_ONLY,
    },
    () =>
      run(async () => {
        const project = await api.project();

        return ok({ source_locale: project.source_locale, languages: project.locales });
      }),
  );

  tools.registerTool(
    'add_language',
    {
      title: 'Add a language',
      description:
        'Add a target language to the project. Pass a BCP 47 tag ("de", "pt-BR", "zh-Hans"); the result carries the CANONICAL code (e.g. "pt_BR"), which is the one to use in every later call. Unless translate_now is false, it also starts an AI translation run of the existing strings into the new language, which SPENDS the organization AI word quota; the run happens only when the project translates on its own (auto_translate), whatever translate_now says, and otherwise batch_id and backfill_skipped_reason are both null. Poll get_batch_status with batch_id. A refused run does not refuse the add: the language is still added, batch_id is null and backfill_skipped_reason says why (quota_exceeded, translation_paused, nothing_to_translate). Fails with locale-rejected for an unknown code or a language the project already has, and plan-limit when the account plan has no room for another language. Each new language takes one of the language slots on the account plan (unless another project of the account already uses it), and it cannot be removed through the API, only in the transglot web UI, so do not add languages to experiment. Workspace admins are notified. Requires the "manage" ability.',
      inputSchema: {
        locale: z.string().min(1).max(35).describe('A BCP 47 tag, e.g. "de", "pt-BR" or "zh-Hans". Case and "-" or "_" do not matter.'),
        translate_now: z
          .boolean()
          .optional()
          .describe('Start translating the existing strings into it now (default true). Spends AI word quota.'),
      },
      outputSchema: z.looseObject({
        language: z.looseObject({ locale: z.string(), name: z.string(), native_name: z.string().nullable(), rtl: z.boolean() }),
        batch_id: z.number().nullable(),
        backfill_skipped_reason: z.enum(['quota_exceeded', 'translation_paused', 'nothing_to_translate']).nullable(),
      }),
      // Additive: it removes and overwrites nothing. Not idempotent in result: a second call with
      // the same locale is refused as a duplicate.
      annotations: writes({ destructiveHint: false }),
    },
    (args) => run(async () => ok(await api.addLanguage(args))),
  );

  tools.registerTool(
    'get_translation',
    {
      title: 'Get translation',
      description:
        'Read one translation key in one locale. Free read. Returns the full row: key metadata (name, description, is_plural, max_length) plus the source-locale cell and the requested locale\'s cell with its content or plural_forms, workflow state (ai_translated / human_edited / reviewed / null when missing), staleness flag, and the persisted QA verdict (needs_review, qa_score, qa_findings). Requires the "read" ability.',
      inputSchema: {
        key: z.string().max(500).describe('Exact key name, e.g. "checkout.title".'),
        locale: z.string().max(35).describe('A locale configured on the project, e.g. "fr" or "pt-BR".'),
      },
      outputSchema: z.looseObject({ row: rowSchema }),
      annotations: READ_ONLY,
    },
    (args) => run(async () => ok(await api.getTranslation(args))),
  );

  tools.registerTool(
    'upsert_translation',
    {
      title: 'Upsert translation',
      description:
        'Create or OVERWRITE the value of one existing key in one locale (it cannot create new keys; use push_file on the source locale for that). Pass `value` for a simple key, or `plural_forms` (CLDR category map, e.g. {"one": "...", "other": "..."}) for a plural key. Send exactly one of the two. A JSON project has no plural FORMS: an ICU plural or select there is ONE string, so send it as `value` with its selectors and argument names verbatim (e.g. {count, plural, one {# item} other {# items}}). `plural_forms` is for a key the project stores as separate forms (is_plural true, as gettext or Android do); splitting an ICU message into it writes a row the format cannot represent. The write is recorded as a human edit (state human_edited) and versioned server-side, so it wins over future AI batches. Overwriting the SOURCE locale marks targets stale and, if the project has auto-translate on, queues a background AI batch (spends AI word quota; its id is not returned, so check list_batches). Optional `reviewer` attributes the edit. Returns the fresh row. Requires the "write" ability.',
      inputSchema: {
        key: z.string().max(500).describe('Exact key name of an EXISTING key.'),
        locale: z.string().max(35).describe('A locale configured on the project.'),
        value: z.string().max(10_000).optional().describe('New value for a simple (non-plural) key. Use "" to clear.'),
        plural_forms: z
          .record(z.string(), z.string())
          .optional()
          .describe('New values for a plural key, keyed by CLDR plural category (one, few, many, other, ...).'),
        reviewer: z.string().max(120).optional().describe('Optional human reviewer name recorded on the edit.'),
      },
      outputSchema: z.looseObject({ row: rowSchema }),
      annotations: writes({ destructiveHint: true, idempotentHint: true }),
    },
    (args) =>
      run(async () => {
        if ((args.value === undefined) === (args.plural_forms === undefined)) {
          throw new Error(
            'Pass exactly one of `value` (simple key) or `plural_forms` (plural key). Read the key first with get_translation to see is_plural.',
          );
        }

        return ok(
          await api.putTranslation({
            key: args.key,
            locale: args.locale,
            content: args.value,
            plural_forms: args.plural_forms,
            reviewer: args.reviewer,
          }),
        );
      }),
  );

  tools.registerTool(
    'translate_missing',
    {
      title: 'Translate missing values with AI',
      description:
        'Start an AI translation batch that fills every MISSING target value and re-translates every STALE machine translation (one whose source text changed since), optionally restricted to given locales and/or numeric key_ids. A stale machine translation is replaced; human-edited and reviewed translations are never overwritten, stale or not. SPENDS the organization AI word quota (fails with quota-exceeded when exhausted) and conflicts with a running batch (active-batch, HTTP 409; the running batch id is in the error). Returns the queued batch immediately; poll get_batch_status with its id until the status is terminal (completed, completed_with_errors, failed, or cancelled). Requires the "manage" ability.',
      inputSchema: {
        locales: z.array(z.string().max(35)).max(200).optional().describe('Restrict to these target locales; omit for all.'),
        key_ids: z
          .array(z.number().int())
          .max(2000)
          .optional()
          .describe('Restrict to these numeric key ids (from get_translation row.id); omit for all keys.'),
      },
      outputSchema: batchSchema,
      // Destructive: the server's `missing` scope also re-translates a STALE value (its source
      // moved), replacing the machine translation that was there. Human edits are kept.
      annotations: writes({ destructiveHint: true }),
    },
    (args) =>
      run(async () => ok(await api.translate({ scope: 'missing', locales: args.locales, key_ids: args.key_ids }))),
  );

  tools.registerTool(
    'get_batch_status',
    {
      title: 'Get batch status',
      description:
        'Read one AI translation batch by id: status (pending / processing / completed / completed_with_errors / failed / cancelled), progress counters (total, completed, failed) and the per-language breakdown. Set include_failures to also list up to 100 failed items as {key, locale, error}. Free read. Poll this after translate_missing, retry_failed_batch, or a push that queued a batch. Be mindful of the 60 requests/minute limit when polling.',
      inputSchema: {
        batch_id: z.number().int().describe('The batch id returned by translate_missing, push_file, or list_batches.'),
        include_failures: z.boolean().optional().describe('Also return up to 100 failed items.'),
      },
      outputSchema: batchSchema,
      annotations: READ_ONLY,
    },
    (args) => run(async () => ok(await api.batch(args.batch_id, { failures: args.include_failures === true }))),
  );

  tools.registerTool(
    'list_batches',
    {
      title: 'List batches',
      description:
        'List the project\'s AI translation batches, most recent first (at most 50). Set active_only to return only running batches (status pending or processing), useful to find the batch that is blocking a new translate_missing call, or the auto-batch queued by a source-locale edit. Free read.',
      inputSchema: {
        active_only: z.boolean().optional().describe('Only batches still pending or processing.'),
      },
      outputSchema: z.looseObject({ batches: z.array(batchSchema) }),
      annotations: READ_ONLY,
    },
    (args) => run(async () => ok({ batches: await api.batches({ active: args.active_only === true }) })),
  );

  tools.registerTool(
    'retry_failed_batch',
    {
      title: 'Retry failed batch items',
      description:
        'Re-queue the FAILED items of a finished batch as a new AI translation batch. SPENDS AI word quota and conflicts with a running batch (active-batch, HTTP 409). Returns the new batch; poll get_batch_status with its id. Requires the "manage" ability.',
      inputSchema: {
        batch_id: z.number().int().describe('Id of the finished batch whose failed items should be retried.'),
      },
      outputSchema: batchSchema,
      // Destructive: it re-runs the failed pairs of the batch, which can include stale values the
      // new run then replaces, as translate_missing does.
      annotations: writes({ destructiveHint: true }),
    },
    (args) => run(async () => ok(await api.retryFailed(args.batch_id))),
  );

  tools.registerTool(
    'cancel_batch',
    {
      title: 'Cancel a running batch',
      description:
        'Stop a pending or processing AI translation batch. Queued chunks refuse to run, so this is how you STOP spend rather than cause it, and the batch\'s unspent reserved words go back to the cycle allowance (words already spent on the items it completed stay spent). Already-translated items are kept; the remaining items are marked failed, so retry_failed_batch resumes what was stopped. Idempotent: a batch that already finished comes back unchanged with its own status, never an error. Requires the "manage" ability.',
      inputSchema: {
        batch_id: z.number().int().describe('Id of the batch to stop.'),
      },
      outputSchema: batchSchema,
      // Not destructive: it overwrites and deletes no translation or term. Translated items are
      // kept and retry_failed_batch resumes the rest; it stops spend rather than causing it.
      annotations: writes({ destructiveHint: false, idempotentHint: true }),
    },
    (args) => run(async () => ok(await api.cancelBatch(args.batch_id))),
  );

  tools.registerTool(
    'run_qa',
    {
      title: 'Run AI QA pass',
      description:
        'Run the agentic QA pass over the project\'s target translations (plan-gated: requires a plan with quality mode). Scopes: "missing" = rows never QA\'d, "stale" = rows whose source changed since their last QA, "all" = every row, "selected" = only the given key_ids (a no-op without key_ids); optionally restrict locales. Incremental: rows already QA\'d against the current source are skipped. SPENDS AI word quota. Returns {dispatched_jobs, rows}; findings are persisted per row and appear in get_translation as needs_review / qa_score / qa_findings once the background jobs finish. Requires the "manage" ability.',
      inputSchema: {
        scope: z.enum(['missing', 'stale', 'all', 'selected']).describe('Which rows to QA.'),
        key_ids: z.array(z.number().int()).max(2000).optional().describe('Restrict to these numeric key ids.'),
        locales: z.array(z.string().max(35)).max(200).optional().describe('Restrict to these target locales.'),
      },
      outputSchema: z.looseObject({ dispatched_jobs: z.number(), rows: z.number() }),
      // Destructive: a row it checks again gets a new verdict (qa_score, qa_findings,
      // needs_review) in place of the old one. The translations themselves are not changed.
      annotations: writes({ destructiveHint: true }),
    },
    (args) => run(async () => ok(await api.qaRun(args))),
  );

  tools.registerTool(
    'glossary_list_terms',
    {
      title: 'List glossary terms',
      description:
        'List the project\'s glossary terms (plan-gated feature). Returns up to 100 terms per page with keyset pagination: pass the returned next_cursor to fetch the next page; next_cursor is null on the last page. Filter by status: "active" (default, enforced in AI translation and QA), "pending" (AI-extracted candidates awaiting review), or "rejected". Free read; requires the "read" ability.',
      inputSchema: {
        status: z.enum(['active', 'pending', 'rejected']).optional().describe('Term status filter (default "active").'),
        cursor: z.string().optional().describe('Opaque pagination cursor from a previous call\'s next_cursor.'),
      },
      outputSchema: z.looseObject({ terms: z.array(glossaryTermSchema), next_cursor: z.string().nullable() }),
      annotations: READ_ONLY,
    },
    (args) =>
      run(async () => {
        const page = await api.glossaryList(args);

        return ok({ terms: page.data, next_cursor: page.next_cursor });
      }),
  );

  tools.registerTool(
    'glossary_add_term',
    {
      title: 'Add glossary term',
      description:
        'Create a new glossary term with status "active". It immediately steers future AI translation and QA for this project. Set do_not_translate for terms that must stay verbatim (brand names), forbidden for terms QA must flag, or provide required per-locale translations. Plan-gated feature; requires the "manage" ability. Returns the created term (with its id).',
      inputSchema: glossaryTermInput,
      outputSchema: glossaryTermSchema,
      // Additive: it creates a term and changes no existing one.
      annotations: writes({ destructiveHint: false }),
    },
    (args) => run(async () => ok(await api.glossaryCreate(args))),
  );

  tools.registerTool(
    'glossary_update_term',
    {
      title: 'Update glossary term',
      description:
        'REPLACE a glossary term by id. This is a full replace, not a patch: send every field that should be kept; source_term is required and any omitted optional field resets to its default (false / empty). Read the term first via glossary_list_terms. Plan-gated feature; requires the "manage" ability. Returns the updated term.',
      inputSchema: { term_id: z.number().int().describe('Id of the term to replace.'), ...glossaryTermInput },
      outputSchema: glossaryTermSchema,
      annotations: writes({ destructiveHint: true, idempotentHint: true }),
    },
    (args) =>
      run(async () => {
        const { term_id, ...term } = args;

        return ok(await api.glossaryUpdate(term_id, term));
      }),
  );

  tools.registerTool(
    'glossary_delete_term',
    {
      title: 'Delete glossary term',
      description:
        'Permanently delete a glossary term by id. This cannot be undone; future AI translation and QA stop enforcing the term. Plan-gated feature; requires the "manage" ability.',
      inputSchema: { term_id: z.number().int().describe('Id of the term to delete.') },
      outputSchema: z.looseObject({ deleted: z.boolean(), term_id: z.number() }),
      annotations: writes({ destructiveHint: true, idempotentHint: true }),
    },
    (args) =>
      run(async () => {
        await api.glossaryDelete(args.term_id);

        return ok({ deleted: true, term_id: args.term_id });
      }),
  );

  tools.registerTool(
    'pull_file',
    {
      title: 'Pull (export) a translation file',
      description:
        `Export one locale's translations as a localization file and return its content as text. Free read. Formats: ${FORMAT_LIST}. Optional min_state exports only values that are human_edited-or-better, or reviewed only. skipped_keys counts entries the chosen format cannot represent (e.g. plural keys in json_flat, simple keys in ios_stringsdict). On a project set to icu message syntax the server also withholds entries whose translation is not valid ICU MessageFormat, and reports how many in omitted_invalid_icu_keys, which is absent when the server did not check. Requires the "pull" ability.`,
      inputSchema: {
        format: z.enum(FORMAT_VALUES).describe('The file format id.'),
        locale: z.string().max(35).describe('A locale configured on the project.'),
        min_state: z
          .enum(['human_edited', 'reviewed'])
          .optional()
          .describe('Export only values at or above this workflow state; omit to export everything.'),
      },
      // `omitted_invalid_icu_keys` is OPTIONAL and the handler spreads it only
      // when the server sent the header (ruling R8). A server from before the
      // ICU export gate omits it, and an agent told "0 omitted" by a server
      // that never checked would read a guarantee into a silence.
      outputSchema: z.looseObject({
        content: z.string(),
        filename: z.string().nullable(),
        skipped_keys: z.number(),
        omitted_invalid_icu_keys: z.number().optional(),
      }),
      annotations: READ_ONLY,
    },
    (args) =>
      run(async () => {
        const result = await api.pull(args);

        return ok({
          content: result.content,
          filename: result.filename,
          skipped_keys: result.skippedKeys,
          ...(result.omittedInvalidIcuKeys === undefined
            ? {}
            : { omitted_invalid_icu_keys: result.omittedInvalidIcuKeys }),
        });
      }),
  );

  tools.registerTool(
    'push_file',
    {
      title: 'Push (import) a translation file',
      description:
        `Import a localization file into one locale; pass the file content as a string (max 10 MB before JSON escaping, which can enlarge it, so a file with many non-ASCII characters may be refused below 10 MB). Formats: ${FORMAT_LIST}. ` +
        'Pushing the SOURCE locale creates new keys and updates source values; pushing a target locale writes translations for existing keys (unknown keys are reported, never created). Values are written as human edits, but the server keeps existing human edits over pushed values and reports them as conflicts. Mode "sync_removals" (source locale only) additionally DELETES every project key missing from the file. This is destructive; the default "merge" never deletes. When the project has auto-translate on, a push may queue an AI batch (returned in `batch`, quota permitting; see quota_exceeded, and translation_paused for any other stop on AI spend). Optional `metadata` (source locale only, and not for formats that carry descriptions in the file) is a JSON sidecar of key descriptions and length ceilings keyed by key name, e.g. {"cart.title": {"description": "Cart page heading", "max_length": 40}}; null clears a field, an absent field is left alone. The result then carries a `metadata` block, and a warning if the server ignored the sidecar. Requires the "push" ability.',
      inputSchema: {
        format: z.enum(FORMAT_VALUES).describe('The file format id, e.g. "json_flat".'),
        locale: z.string().max(35).describe('The locale the file contains.'),
        content: z.string().describe('The raw file content, exactly as it would sit on disk.'),
        filename: z.string().optional().describe('Optional upload filename; defaults to "<locale>.<ext>".'),
        mode: z
          .enum(['merge', 'sync_removals'])
          .optional()
          .describe('"merge" (default) never deletes; "sync_removals" deletes keys absent from a SOURCE-locale file.'),
        metadata: z
          .string()
          .max(1_048_576)
          .optional()
          .describe('Optional key-metadata sidecar (JSON text, max 1 MiB): {"<key>": {"description": string|null, "max_length": integer|null}}. Source-locale push only.'),
      },
      outputSchema: z.looseObject({
        keys_created: z.number(),
        keys_deleted: z.number(),
        source_updated: z.number(),
        translations_written: z.number(),
        conflicts: z.array(z.looseObject({ key: z.string(), locale: z.string(), reason: z.string() })),
        unknown_keys: z.array(z.string()),
        warnings: z.array(z.string()),
        batch: batchSchema.nullable(),
        quota_exceeded: z.boolean(),
        translation_paused: z.string().nullable().optional(),
        metadata: z
          .looseObject({
            descriptions_updated: z.number(),
            max_lengths_updated: z.number(),
            unknown_keys: z.array(z.string()),
            unknown_keys_count: z.number(),
          })
          .optional(),
      }),
      annotations: writes({ destructiveHint: true }),
    },
    (args) =>
      run(async () => {
        const result = await api.push(args);

        // An older server drops the part it does not know and answers 200 with no `metadata`
        // block. Said in the result, because otherwise the push reads as if it worked.
        if (args.metadata !== undefined && result.metadata === undefined) {
          return ok({ ...result, warnings: [...result.warnings, IGNORED_SIDECAR] });
        }

        return ok(result);
      }),
  );

  return server;
}
