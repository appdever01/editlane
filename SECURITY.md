# Security policy

## Supported versions

Editlane is a prototype. Security fixes target the current `main` branch. No release branches or npm releases are maintained yet.

## Report a vulnerability

Use [GitHub's private vulnerability reporting form](https://github.com/appdever01/editlane/security/advisories/new). Keep exploit details and sensitive files out of public issues and discussions.

Include the affected commit or version, operating system, Node.js version, steps to reproduce, and the impact you observed. A minimal synthetic example is preferable to a real private repository. Remove credentials and personal information from logs and journals before sharing them.

Reports will be reviewed by the maintainer. This project has no guaranteed response time or paid bug bounty. If a fix requires coordinated disclosure, discuss that in the private report.

## Data and execution boundaries

Context discovery runs locally without network requests. It returns exact source and applicable repository guidance, which your agent client may send to its model provider. Treat the response as private repository data.

File discovery respects ignores and excludes common secret filenames, symlinks, binary files, and paths outside the selected root. These filters are not a secret detector. Ordinary source and guidance can contain sensitive information.

The MCP server exposes read-only context and audit tools. The CLI's `run` command executes the argument list you provide and records it locally. It is not a sandbox. Keep credentials out of command arguments, protect journals, and keep generated context out of Git and shared logs.
