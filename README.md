# transglot MCP server

[![npm](https://img.shields.io/npm/v/@transglot/mcp)](https://www.npmjs.com/package/@transglot/mcp)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE.md)

A Model Context Protocol (MCP) server for [transglot](https://transglot.ai), AI translation
management for software teams. It gives AI coding agents and assistants typed tools to read and
write translations, pull and push localization files in 20 formats, start AI translation batches,
run translation QA and manage the glossary, all over the transglot public REST API.

Use it to let an agent localize the feature it just built: add the strings, push the source file,
translate the missing locales, check QA and pull the results back into the repository.

- **Stdio server** on npm: `npx -y @transglot/mcp`, authenticated with a project access token.
- **Hosted remote server** at `https://api.transglot.ai/mcp` (Streamable HTTP with OAuth), for
  clients that support remote MCP servers. No token to paste.
- **17 tools** covering translations, languages, batches, QA, glossary and file import/export.

Links: [Website](https://transglot.ai) · [MCP docs](https://transglot.ai/docs/mcp/) ·
[npm](https://www.npmjs.com/package/@transglot/mcp) ·
[CLI](https://github.com/transglot/transglot-cli) ·
[GitHub Action](https://github.com/transglot/transglot-action)

This repository is a read-only mirror of the source published to npm, synced on every release.
Report issues at [transglot.ai/contact](https://transglot.ai/contact).

## Requirements

A project access token (`tgl_…`). Create one in the transglot web UI: in the project, open
Settings, choose the Project tab, then API keys. Minting a token needs the Starter plan or above.
Node.js 20 or later.

One server instance serves one project: the token is project-scoped, and the abilities on the
token (`read`, `write`, `pull`, `push`, `manage`) gate which tools succeed.

## Setup

Most MCP clients read an `mcpServers` block like this one. In Cursor it goes in
`.cursor/mcp.json`; other clients use their own MCP settings file.

```json
{
  "mcpServers": {
    "transglot": {
      "command": "npx",
      "args": ["-y", "@transglot/mcp"],
      "env": { "TRANSGLOT_TOKEN": "tgl_xxx" }
    }
  }
}
```

### Hosted server (OAuth, no token)

Add `https://api.transglot.ai/mcp` as a remote MCP server in your client and sign in with your
transglot login. You choose the workspaces the connection reaches and its abilities. One
connection reaches every project where you are the account Owner, an Admin or a Developer. The
tools are the same, plus `list_projects`; every other tool takes an optional `project` id. It
needs a workspace plan with API access (Starter and above). Full guide:
[transglot.ai/docs/mcp](https://transglot.ai/docs/mcp/).

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `TRANSGLOT_TOKEN` | yes | Project access token (Bearer). Never logged; redacted from every error message. |
| `TRANSGLOT_BASE_URL` | no | Server base URL for self-hosted installs. Defaults to `https://api.transglot.ai` (the API host; the web UI on `https://app.transglot.ai` serves no `/v1` paths). Plain `http://` is allowed for loopback hosts only. `TRANSGLOT_URL` (the CLI's variable) is honored as a fallback. |

## Tools

Read tools are free and side-effect-less; mutating tools state their effects in their descriptions so the agent (and you, via your client's approval flow) can decide. Tools marked **AI spend** consume the organization's AI word quota.

| Tool | Effect |
| --- | --- |
| `get_project` | Read project identity, configured locales, key count. |
| `list_languages` | Read the locale inventory. |
| `add_language` | Add a target language; unless `translate_now` is false, also translate the existing strings into it (**AI spend**). Needs `manage`. |
| `get_translation` | Read one key in one locale: value, workflow state, staleness, QA verdict. |
| `upsert_translation` | Create/overwrite one value (or plural forms) as a human edit. A source-locale edit may auto-queue an AI batch (**AI spend**). |
| `translate_missing` | Queue an AI batch filling missing target values; never overwrites human edits (**AI spend**). |
| `get_batch_status` | Poll a batch by id, optionally with its failed items. |
| `list_batches` | List recent batches; `active_only` finds the one blocking a new run. |
| `retry_failed_batch` | Re-queue a finished batch's failed items (**AI spend**). |
| `cancel_batch` | Stop a running batch; unspent reserved words return to the allowance. |
| `run_qa` | Run the agentic QA pass; findings land on each row (**AI spend**, plan-gated). |
| `glossary_list_terms` | List glossary terms, keyset-paginated via `next_cursor`. |
| `glossary_add_term` | Add an active term (do-not-translate / forbidden / required translations). |
| `glossary_update_term` | Full-replace a term by id. |
| `glossary_delete_term` | Permanently delete a term by id. |
| `pull_file` | Export one locale as a file (20 formats, optional `min_state` filter). |
| `push_file` | Import file content; `sync_removals` also deletes keys absent from a source file; optional `metadata` sidecar (key descriptions and length ceilings) on a source-locale push. |

Formats for `pull_file`/`push_file` (the upload filename defaults to `<locale>.<ext>`):

| Format | Extension | | Format | Extension |
| --- | --- | --- | --- | --- |
| `json_flat` | `.json` | | `csv` | `.csv` |
| `json_nested` | `.json` | | `xlsx` | `.xlsx` |
| `android_xml` | `.xml` | | `xliff_20` | `.xlf` |
| `ios_strings` | `.strings` | | `java_properties` | `.properties` |
| `ios_stringsdict` | `.stringsdict` | | `resx` | `.resx` |
| `flutter_arb` | `.arb` | | `markdown` | `.md` |
| `laravel_php` | `.php` | | `unity_csv` | `.csv` |
| `laravel_json` | `.json` | | `unreal_po` | `.po` |
| `xliff_12` | `.xlf` | | | |
| `ios_xcstrings` | `.xcstrings` | | | |
| `gettext_po` | `.po` | | | |
| `yaml` | `.yml` | | | |

`unity_csv` and `unreal_po` are the game engine formats (Unity string tables and
Unreal `.po` catalogs).

## Behavior

- **Transport**: stdio for this package (`npx @transglot/mcp`), with a project token; stdout is reserved for the protocol, diagnostics go to stderr, and `npx @transglot/mcp --help` prints usage. Streamable HTTP for the hosted connector at `https://api.transglot.ai/mcp`, with OAuth.
- **Errors**: RFC 7807 problems from the API surface as in-band tool errors, `slug (HTTP status): detail` plus a what-to-do-next hint (e.g. quota exceeded reports used/limit and says to raise the word limit).
- **Rate limits**: the API allows 60 requests/minute per token; transient 429s are retried automatically (honoring `Retry-After`, capped, max 2 retries) before an error is surfaced. The hosted connector gets 60/minute in each project and retries once, only when `Retry-After` is 10 s or less.
- **Security**: the token is sent only as the `Authorization` header and is redacted from any error text, even if a server echoes it back.

## Not covered

The public API has no endpoints for listing/searching keys, creating/deleting individual keys (keys are managed by pushing source files), or removing languages (done in the web UI), so there are no tools for those. Adding a language is covered by `add_language`. The API's webhook endpoints have no tools here; manage webhooks in the web UI or through the REST API.

## Development

```sh
npm ci
npm run typecheck
npm test        # vitest; builds dist/ once for the stdio ring
npm run build
```
