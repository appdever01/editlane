# Contributing to Editlane

Thanks for helping with Editlane. Useful contributions include reproducible bug reports, clearer documentation, import-resolution fixes, and benchmarks that measure real coding tasks.

For a large change, open an issue first so the scope can be discussed. Small fixes can go straight to a pull request. Ask usage questions in [Discussions](https://github.com/appdever01/editlane/discussions). Report vulnerabilities through the [security policy](SECURITY.md).

## Set up a checkout

You need Node.js 22+ and [ripgrep](https://github.com/BurntSushi/ripgrep) on your `PATH`. Fork the repository, then replace `YOUR_USERNAME` below:

```sh
git clone https://github.com/YOUR_USERNAME/editlane.git
cd editlane
git remote add upstream https://github.com/appdever01/editlane.git
npm ci --ignore-scripts
npm run build
git switch -c fix/describe-the-change
```

Use the [README demo](README.md#quick-start) to try the CLI. Avoid global installs while developing; run `node dist/cli.js` from your checkout.

## Find the relevant code

| Location | Responsibility |
| --- | --- |
| `src/files.ts`, `src/graph.ts`, `src/context.ts` | File access, import resolution, and context packets. |
| `src/trace.ts`, `src/run.ts` | Journal validation, audits, and command recording. |
| `src/cli.ts`, `src/mcp.ts`, `src/metadata.ts` | CLI, read-only MCP, and optional metadata integration. |
| `test/` | Focused regression tests and MCP integration tests. |
| `bench/context.mjs` | Reproducible synthetic context benchmark. |
| `reference/` | Public command and session-format documentation. |

## Keep the behavior dependable

Changes must preserve exact source, content-sensitive cache invalidation, explicit omissions, root boundaries, and recorded failures. Keep MCP read-only. Required checks must remain visible, and command output and exit codes must pass through unchanged.

Add a focused regression test for a behavior fix, including the failure case that exposed it. Use small synthetic fixtures, not real credentials, private code, or client transcripts. A new provider or dependency needs a clear reason, license compatibility, and tests for its failure path. Credit upstream work in [NOTICE.md](NOTICE.md).

For performance changes, report the fixture, environment, baseline, and complete packet size. Check that affected files and required checks are still present. Bytes, tokens, and time to a correct edit are different measurements; make claims only about what the experiment measured.

## Check your change

Run the relevant focused tests first. For example, a context change can be checked with:

```sh
npm run build
node --test --test-concurrency=2 test/context.test.mjs
```

Before submitting behavior changes, run:

```sh
npm run typecheck
npm test
npm run bench
git diff --check
```

The test runner uses at most two workers. The repository has no separate lint command. The CI workflow is configured for Node.js 22 and 24. For documentation-only changes, check links, Markdown, and every command you changed; a full behavioral test run is unnecessary unless the examples expose a code issue.

## Open a pull request

Keep the diff focused and explain the problem, resulting behavior, and checks you actually ran. Include any remaining limitation. Update public documentation when a command or contract changes. Do not include generated packets, journals, private instructions, or unrelated cleanup.

Use the pull request template and link the relevant issue if one exists. Contributions are licensed under the project's [MIT license](LICENSE); no contributor agreement is required. Follow the [code of conduct](CODE_OF_CONDUCT.md) in issues, discussions, and reviews.
