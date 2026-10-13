# Third-party components

Editlane's original code is licensed under MIT. Dependencies are installed separately through the committed npm lockfile and keep their license files. No upstream repositories have been copied or rebranded.

| Component | Use | Upstream license |
| --- | --- | --- |
| [ast-grep](https://github.com/ast-grep/ast-grep/blob/main/LICENSE) | `@ast-grep/napi` dependency; JavaScript and TypeScript import parsing | MIT |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | Server and client dependencies; stdio transport and connection diagnostics | Apache-2.0 |
| [TOON](https://github.com/toon-format/toon/blob/main/LICENSE) | `@toon-format/toon` 4.4.0 dependency; lossless metadata serialization | MIT; Copyright (c) 2025-PRESENT Johann Schopplich |
| [JSONC Parser](https://github.com/microsoft/node-jsonc-parser) | Local tsconfig/jsconfig parsing | MIT |
| [Zod](https://github.com/colinhacks/zod) | Trace and MCP input validation | MIT |
| [ripgrep](https://github.com/BurntSushi/ripgrep) | Required external executable; ignored-file discovery and scoped search | MIT or Unlicense |
| [RTK](https://github.com/rtk-ai/rtk/blob/develop/LICENSE) | Optional external executable; bounded metadata only | Apache-2.0 |

Serena, Headroom, Repomix, LLMLingua, Context7, Aider, GrepAI and Context Mode are research references, not bundled components. Serena's current application is GPL-3.0-or-later and its SolidLSP component is MIT; its upstream license states that combined distributions are subject to GPL. Context Mode's current Elastic License 2.0 includes hosted-service restrictions. Any future code reuse or redistribution needs a fresh license review. Commercially restricted code has not been included.

TypeScript and Node type declarations are build-time dependencies. Their upstream licenses remain applicable. npm packaging includes Editlane's built source, README, license, notice and synthetic examples; local context, personal instructions and session journals are excluded.
