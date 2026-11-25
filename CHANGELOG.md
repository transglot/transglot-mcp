# @transglot/mcp

## 0.3.0

### Minor Changes

- a841180: New `add_language` tool: adds a target language to the project over `POST /v1/locales` and, unless
  `translate_now` is false, starts translating the existing strings into it (AI word quota). It
  answers with the canonical locale code, the run's `batch_id` for `get_batch_status`, and
  `backfill_skipped_reason` when the language was added but no run started. Needs a token with
  `manage`, created by someone who may add languages (a `token-creator-not-permitted` refusal
  carries a hint). `list_languages` no longer says languages cannot be added, and a `locale-rejected`
  refusal now carries a hint.

  Needs a transglot server with `POST /v1/locales`; an older one answers `not-found`.

### Patch Changes

- `--version`, the server version an MCP client sees and the version sent to the API now come from
  `package.json`. 0.2.0 reported itself as 0.1.0.

## 0.2.0

### Minor Changes

- 64f4e14: `push_file` takes an optional `metadata` string: a key-metadata sidecar, JSON keyed by key name,
  stating each key's `description` and `max_length` (`null` clears a field; an absent field is left
  alone). It rides a SOURCE-locale push, as its own file part.

  The result gains an optional `metadata` block, declared in the tool's `outputSchema`:
  `descriptions_updated`, `max_lengths_updated`, and the keys the sidecar named that the project does
  not have (`unknown_keys`, a sample, beside `unknown_keys_count`). A server that predates sidecars
  ignores the part and returns no block; the tool then adds `this server ignored the metadata sidecar`
  to `warnings`, so an agent is never told a sidecar landed when it did not. A refused sidecar
  (`metadata-invalid`) reports its field errors and how many were not listed.

  Needs a transglot server with key-metadata support; an older one ignores the field, as above.

### Patch Changes

- c66bfac: `upsert_translation` says what a plural is in a JSON project.

  A JSON file has no plural FORMS: an ICU plural or select is one string there. An agent that read
  "pass `plural_forms` for a plural key" and split `{count, plural, one {# item} other {# items}}`
  into a category map wrote a row the format cannot represent, and nothing in the tool's description
  said so. The description now states the rule and shows the shape, with selectors and argument names
  kept verbatim.

  Description only: no schema, no behaviour, no new tool.

- 042ada5: The npm page no longer links to a source repository readers cannot open. `package.json` named a
  private repository, so the Repository link on npmjs.com answered 404; the field is gone, and the
  homepage and support address stay. No code changes.

This changelog is maintained by [Changesets](https://github.com/changesets/changesets); new
entries are prepended on each release.

## 0.1.0

- Initial release: the MCP server that lets AI agents read/write translations,
  trigger AI batches, run QA, and manage the glossary over the public REST API.
