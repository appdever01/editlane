# CLI reference

Run commands from the Editlane checkout after building. In the examples, `/absolute/path/to/project` is the repository you want to inspect; file arguments are relative to that root.

## Commands

| Command | Purpose |
| --- | --- |
| `focus` | Gather a context packet for a task and affected files. |
| `serve` | Start the read-only stdio MCP server for one root. |
| `connection` | Print portable JSON MCP and Codex TOML configuration for an explicit root. |
| `doctor` | Verify a real local stdio connection, exact target source and outside-root refusal. |
| `usage` | Normalize reported input, cache and output counts from a native client JSONL trace. |
| `audit` | Analyze a normalized local session journal. |
| `record` | Append an explicit event to a journal. |
| `run` | Execute an argument list and record its result. |
| `metadata` | Read a bounded recent Git history listing. |
| `--help` / `--version` | Print usage or the current version. |

## Context packets

```sh
node dist/cli.js focus "fix tag filtering" --root /absolute/path/to/project --file src/tags.ts --budget 24000 --json
```

Replace `src/tags.ts` with an existing affected file. `--file` is repeatable. With no file arguments, filename ranking uses the task text and selects at most three anchors. A request with no useful match fails with a request for a file.

`--budget` is a source-byte budget, not a token budget. The default is 24,000 bytes. The accepted range is 1 to 2,000,000 bytes, with at most 20 requested anchors. Requested files must fit in full. Neighbors that do not fit appear in `omitted`, with reasons. Instructions are outside the source budget, with a separate safety limit; exceeding it fails rather than dropping guidance.

The default output separates metadata from exact source blocks. `--json` includes source in the structured response. Both formats include SHA-256 hashes, inclusion reasons, unresolved imports, discovery limits, metrics, and discovered package check scripts marked `not_run`.

Discovery is bounded: reverse search inspects at most 200 candidate files and nearby test discovery returns at most 20 matches. A packet can therefore miss consumers; inspect its warnings before relying on it.

`--mode edit` lists related consumer and test metadata in `deferred` and their retrieval requirement in `omitted`. Explicit targets, dependencies, configuration and scoped guidance still have exact bodies. Retrieve required deferred paths with another `--file` request. `--mode full` is the default and keeps the original whole-neighbor behavior.

`--compact` renders the metadata through the MIT TOON SDK and keeps source blocks exact. `--json` keeps the structured JSON format. The MCP tool defaults to compact output; set `format: "plain"` for the earlier text format.

`--knownHashes '{"src/tags.ts":"<64-character SHA-256>"}'` accepts at most 1000 retained source hashes. A matching current body appears in `unchanged`; a different body is returned normally. A caller must already retain that exact source. Guidance is always sent. Omit hashes after context loss. MCP takes the same map as `knownHashes`, and accepts `mode`, `format` and `budgetBytes` separately.

MCP callers can instead use `reuseRetained: true` while they retain the source returned earlier in that MCP session. The server remembers at most 1000 hashes of bodies it returned, verifies current content on every request, and returns changed bodies. Deferred bodies are never assumed retained. Omitting the flag or setting it to false resets remembered hashes; start that way after context loss. An earlier overlapping request cannot restore hashes after that reset. A new MCP session starts empty. Explicit `knownHashes` takes precedence and the combined map stays bounded. This option does not apply to the stateless CLI.

Nearest JSONC tsconfig/jsconfig ownership is preserved. Relative single-string inheritance loads at most 16 configs, tries literal parent filenames before optional `.json`, preserves option origins and replaces inherited paths maps with child maps. Exact loaded parent config context is included for targets and verified consumers. Missing, malformed, cyclic, ignored, private, symlinked, outside-root, package-name and array parents produce incomplete-resolution warnings; allowed local settings remain usable.

Use `--journal` to record a context request's query, fingerprint, elapsed time, and full output byte count. Its fingerprint covers returned and omitted file metadata, guidance, warnings, and checks. Timings do not affect the fingerprint.

## Session recording

These examples run against the Editlane checkout and create a journal in its ignored `.editlane/` directory:

```sh
node dist/cli.js record --journal .editlane/session.jsonl --kind start --key "inspect context discovery"
node dist/cli.js focus "inspect context discovery" --root . --file src/context.ts --budget 100000 --journal .editlane/session.jsonl
node dist/cli.js record --root . --journal .editlane/session.jsonl --kind read --key src/context.ts
```

After an actual edit, record it explicitly. The recorder does not perform the edit:

```sh
node dist/cli.js record --journal .editlane/session.jsonl --kind edit --key src/context.ts
node dist/cli.js run --root . --journal .editlane/session.jsonl --kind check -- npm run typecheck
node dist/cli.js audit --journal .editlane/session.jsonl
```

`record --kind read` hashes the current file content. Other events can supply `--fingerprint` when a valid content or search-scope fingerprint is available. Repeated events without a fingerprint are reported as unverifiable.

`run` executes the arguments after `--` without a shell, streams stdout and stderr unchanged, and preserves the child exit code. It forwards interruption signals and records failures, including failed launches. Shell pipelines and redirects are not parsed as commands. Use `--kind check` for validation; otherwise the event kind is `command`. Required checks still come from the repository and the task.

New journal files have mode `0600`; new parent directories use `0700`. Journals are limited to 10 MB. Existing non-private files and symlink journals are rejected. Arguments are recorded, so pass secrets through an appropriate environment mechanism rather than on the command line. Ignore your journal directory in every project that uses it.

### Event format

A journal contains one JSON object per line, in timestamp order. Required fields are:

| Field | Meaning |
| --- | --- |
| `timestamp` | ISO timestamp with a timezone. |
| `kind` | `start`, `read`, `search`, `context`, `edit`, `check`, or `command`. |
| `key` | A non-empty task, file, query, or command identifier. |

Optional fields are `fingerprint`, `durationMs`, `bytes`, `exitCode`, and `signal`. Search fingerprints must cover the query and searched content. See the [synthetic journal](../examples/session.jsonl) for a complete example.

The audit measures events that are present. Time to first edit starts at the first recorded event; it is `null` if no edit is recorded. A repeated unchanged call is a candidate for reuse and may still be justified. Recorded successful checks do not prove that every required check ran. Automatic hooks are not included in v0.1.

## Native usage

```sh
node dist/cli.js usage --client codex --trace /absolute/path/to/native-events.jsonl
```

Choose `codex`, `claude` or `cursor`. The reader accepts native JSONL events and experiment wrappers with an `event` object. Codex completed-turn input already includes cached input; Claude and Cursor report uncached input, cache reads and cache writes separately. Editlane sums those three categories for Claude and Cursor. Reasoning stays within output. See [Cursor's usage field definitions](https://cursor.com/docs/sdk/typescript).

Counts are summed across completed usage events. Missing or invalid categories remain `null`; interrupted, failed or inconsistent traces have `complete: false`. Malformed JSONL is rejected without a partial total. The file must be a regular UTF-8 file of at most 10 MB; symlink and private-file guards still apply. Keep native traces local, since they can contain source and prompts.

These counts include repeated cached context and are not a billing invoice. A completed usage record does not establish that a coding task passed its checks. Compare the same task, model, effort, checks and quality review before claiming savings.

## MCP server

```sh
node dist/cli.js serve --root /absolute/path/to/project
```

Register this as a local stdio server in your agent client. See the [README configuration example](../README.md#connect-your-agent). The server exposes only `editlane_focus` and `editlane_audit` and is pinned to the canonical root. The audit tool reads normalized `.jsonl` journals inside that root, including its `.editlane/` directory. Paths outside the root and symlink journals are rejected.

The CLI-only `run` command is not exposed through MCP. The host controls permissions and instruction precedence, and client-specific integration needs live testing.

## Optional RTK metadata

```sh
node dist/cli.js metadata --root /absolute/path/to/project --rtk
```

With `--rtk`, Editlane uses the external [RTK](https://github.com/rtk-ai/rtk) executable for a bounded recent-history listing. RTK must be installed and on your `PATH`; a missing executable or failed command is reported as an error. Without the flag, Editlane uses Git directly.

RTK is loaded only when requested. Source files, checks, and final diffs remain unchanged. Editlane does not install shell hooks or rewrite client commands.

[Back to the README](../README.md)
