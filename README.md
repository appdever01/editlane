<h1 align="center">Editlane</h1>

<p align="center">Focused context for coding agents, with exact source and visible checks.</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-6366f1" alt="MIT license"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%E2%89%A522-339933" alt="Node.js 22 or newer"></a>
  <a href="#project-status"><img src="https://img.shields.io/badge/status-prototype-d97706" alt="Prototype"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#connect-your-agent">Connect your agent</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

A small fix can turn into dozens of searches before a coding agent makes its first edit. Editlane gathers the affected files and nearby contracts in one request, then helps you measure where the investigation spends time.

It runs locally through a CLI or a read-only MCP server. You keep your existing agent and model; Editlane needs no API key.

## Project status

**v0.1 is a working prototype for JavaScript and TypeScript.** The CLI and MCP server are implemented, and the server is tested with the official MCP stdio client. Read-only MCP requests have run successfully in Cursor, Claude Code, and Codex. Native editing benchmarks remain experimental. Model speed, billed token savings, and stronger code quality have not been established.

## Quick start

You need **Node.js 22+** and [ripgrep](https://github.com/BurntSushi/ripgrep) on your `PATH`. macOS and Linux are the initial targets. Install from source; the package has not been published to npm.

```sh
git clone https://github.com/appdever01/editlane.git
cd editlane
npm ci --ignore-scripts
npm run build
```

Try a context request against Editlane itself:

```sh
node dist/cli.js focus "inspect context discovery" --root . --file src/context.ts --budget 100000
```

This request returns the context module, its local dependencies and direct consumers, the matching test file, and the package configuration. The output starts with metadata, followed by whole source files. Discovered check scripts are marked `not_run`.

For your own project, point `--root` at its directory and `--file` at an affected file relative to that root. Repeat `--file` for more targets. Use `--json` for structured output. The [CLI reference](reference/cli.md) explains budgets, recording, and every command.

## What you get

| Capability | Behavior |
| --- | --- |
| Focused context | Affected files, direct local imports, verified direct consumers, and nearby tests. |
| Smaller first requests | Edit mode returns related paths for follow-up; retained hashes avoid resending unchanged bodies. |
| Compact metadata | TOON tables carry file metadata; source blocks keep their original content. |
| Exact source | Whole files with paths, inclusion reasons, byte counts, and SHA-256 hashes. |
| Visible gaps | Omitted files, unresolved imports, and discovery limits are included in the response. |
| Repository guidance | Applicable instruction files are returned separately with their directory scope. |
| Read-only MCP | Two tools for gathering context and auditing a recorded session. |
| Session evidence | Time to first edit, unchanged repeated calls, observed bytes, and recorded check results. |

The agent still needs to understand the code, follow affected contracts, make the edit, and run the required checks. Editlane discovers check scripts; it does not choose or execute them automatically.

## How it works

```mermaid
flowchart LR
  Task[Task and affected files] --> Search[ripgrep inventory]
  Search --> Graph[ast-grep import verification]
  Graph --> Packet[Whole files and explicit gaps]
  Packet --> Agent[CLI or read-only MCP]
  Journal[Local session events] --> Audit[First-edit and repeat report]
```

Start with a known file when you can. Editlane finds its direct dependencies, checks candidate consumers against parsed imports, and looks for nearby tests and configuration. Without `--file`, it ranks filenames against the task and asks for a file when it cannot find a useful match.

The source budget controls how much neighboring code is included. Requested files must fit in full; other files that do not fit are listed as omissions. Applicable instructions sit outside that budget and are never silently truncated. The host decides instruction precedence.

The MCP process keeps an in-memory AST cache keyed by content hashes. Every request reads current content, so even a same-size edit invalidates cached imports. Editlane does not maintain a persistent source index.

For a smaller first request, use `--mode edit --compact`. Targets, direct dependencies, configuration and guidance stay exact. Related consumers and tests appear in `deferred` with their paths, hashes and reasons. Request those paths before changing their contracts or relying on their tests. The default full mode still returns their bodies when the budget allows.

If your agent still has a file's exact source in its current context, it can pass that file's SHA-256 in `knownHashes`. Editlane reads the current file and returns an `unchanged` entry only when the hash matches. Changed files are sent again, and guidance and check scripts are always included. Omit retained hashes after context loss or when starting another session.

## Connect your agent

The server exposes `editlane_focus` and `editlane_audit`. Start it with:

```sh
node dist/cli.js serve --root /absolute/path/to/project
```

Register that command as a local stdio MCP server in your client. For clients using a `mcpServers` JSON configuration:

```json
{
  "mcpServers": {
    "editlane": {
      "command": "node",
      "args": [
        "/absolute/path/to/editlane/dist/cli.js",
        "serve",
        "--root",
        "/absolute/path/to/project"
      ]
    }
  }
}
```

Replace both absolute paths. The server is pinned to one repository root; update that path when connecting another project. Use an absolute Node executable path if your desktop client cannot find `node`.

Generate these paths and test the local server from any working directory:

```sh
node /absolute/path/to/editlane/dist/cli.js connection --root /absolute/path/to/project
node /absolute/path/to/editlane/dist/cli.js doctor --root /absolute/path/to/project --file src/tags.ts
```

`connection` prints a JSON MCP entry and a Codex TOML entry without changing settings. `doctor` starts the configured stdio server, verifies exact requested source and checks that outside-root access is refused. It checks the local connection; a client can still have separate authentication or provider network problems.

For **Cursor**, save the JSON above in your project's `.cursor/mcp.json`. The CLI can approve and inspect this specific server:

```sh
agent mcp enable editlane
agent mcp list-tools editlane
```

Use an explicit root path. The tested Cursor CLI did not expand `${workspaceFolder}` in server arguments. Its login is separate from the editor; run `agent login` if `agent status` says it is signed out.

For **Claude Code**, run this from your project's directory:

```sh
claude mcp add --transport stdio --scope local editlane -- node /absolute/path/to/editlane/dist/cli.js serve --root /absolute/path/to/project
claude mcp get editlane
```

For **Codex**, register the same local command:

```sh
codex mcp add editlane -- node /absolute/path/to/editlane/dist/cli.js serve --root /absolute/path/to/project
codex mcp get editlane
```

Start a new client session after registration or changing the project root, so it starts the server with the saved configuration. Keep your local client configuration private. These commands register the read-only server; Editlane does not change agent permissions, hooks or model settings.

Any agent with MCP stdio support can use the same server entry, regardless of its model provider. Agents with shell access can use the CLI. Client compatibility does not guarantee a speedup; task scope, model behavior and network time still matter.

Give your agent a request such as:

> Use Editlane with mode=edit for the known affected files. Reuse the exact source it returns, then retrieve deferred contracts and relevant tests in a scoped follow-up. Expand only for a concrete uncertainty. Make the smallest complete change, run the repository's required checks and review the diff.

A tiny task whose code is already known may need no context tool.

## Measure the investigation

Try the included synthetic session:

```sh
node dist/cli.js audit --journal examples/session.jsonl
```

It reports a first edit at nine seconds, three investigation calls, and one repeated read with an unchanged fingerprint. The recorded successful check is part of the fixture, not a check performed by the audit command.

For real sessions, the CLI can record explicit events and run commands with unchanged output and exit codes. Native client tools are not intercepted. See [session recording](reference/cli.md#session-recording) for the JSONL format and examples.

## Benchmark

```sh
npm test
npm run bench
```

The benchmark creates 100 unrelated modules and a small tag flow, then compares a full repository snapshot with a known-file context request. It verifies the expected files and retained check scripts before printing its measurements.

One development run produced:

| Measurement | Result |
| --- | ---: |
| Full repository snapshot | 693,268 bytes |
| Complete focused packet | 3,505 bytes |
| Packet size reduction | 99.49% |
| Cold context request | 27.92 ms |
| Warm context request | 13.98 ms |
| Plain snapshot read | 15.69 ms |

These are synthetic context measurements. Bytes are not billed tokens, and the cold request took longer than reading the snapshot. Real agent benchmarks need repeated tasks, unchanged acceptance tests, and a comparison of time to a correct edit.

Import reported usage from a native JSONL trace with `node dist/cli.js usage --client codex --trace /absolute/path/to/native-events.jsonl`. Claude and Cursor are also supported. The [usage reference](reference/cli.md#native-usage) explains cache accounting and incomplete traces; these totals are not a billing invoice.

## Limits and privacy

v0.1 resolves relative imports, extension substitutions, directory indexes, and nearest JSONC `tsconfig`/`jsconfig` aliases. Single relative `extends` chains support comments, trailing commas and up to 16 loaded configurations. Existing literal parent filenames take precedence over optional `.json` fallback. A child's paths map replaces the parent map; inherited paths and legacy baseUrl retain their declaring origins. Loaded parents used by targets and verified consumers appear as exact config context or explicit budget omissions.

Cycles, malformed parents, excluded paths, package-name or array inheritance produce incomplete-resolution warnings while preserving usable local settings. Workspace package exports, language-server references, recursive barrel expansion and computed imports remain incomplete. Reverse candidates are selected by affected filenames, so renamed aliases can escape discovery. Packets flag these limits; use them to decide where to investigate further.

Ignored files, common secret filenames, binary files, invalid UTF-8, symlinks, and paths outside the root are excluded. Applicable guidance is read separately. This is not a secret detector: ordinary source or guidance may still contain private information.

Keep packets and journals out of Git and shared logs. Context discovery makes no network requests, but your agent client can send the returned context to its model provider. Journals also record command arguments; keep credentials out of those arguments. See the [security policy](SECURITY.md).

## Contribute

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and the contribution workflow. Improvements to module resolution, additional client trace formats, and realistic agent benchmarks are useful next steps. Changes should reduce unnecessary calls while preserving exact source, affected consumers, and failed checks.

Report reproducible bugs through [issues](https://github.com/appdever01/editlane/issues/new/choose), ask questions in [Discussions](https://github.com/appdever01/editlane/discussions), and follow the [code of conduct](CODE_OF_CONDUCT.md).

## Credits and license

Editlane's planner, provenance, audit, and command recorder are original code released under the [MIT license](LICENSE).

It uses [ast-grep](https://github.com/ast-grep/ast-grep), [ripgrep](https://github.com/BurntSushi/ripgrep), [JSONC Parser](https://github.com/microsoft/node-jsonc-parser), [Zod](https://github.com/colinhacks/zod), [TOON](https://github.com/toon-format/toon) and the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk). [RTK](https://github.com/rtk-ai/rtk) is an optional integration for bounded Git history metadata.

[Serena](https://github.com/oraios/serena), [Headroom](https://github.com/headroomlabs-ai/headroom), [Repomix](https://github.com/yamadashy/repomix) and other projects informed the research. The [research notes](reference/research.md) explain what fits, the evidence limits and licensing choices. Those projects retain their own authorship and licenses. The [third-party notice](NOTICE.md) lists what ships and how it is used.
