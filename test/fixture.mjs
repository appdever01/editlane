import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function fixture(t, extra = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'editlane-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    '.gitignore': '.env\nignored/\nAGENTS.md\nsrc/AGENTS.md\n',
    'package.json': JSON.stringify({ scripts: { test: 'node --test', typecheck: 'tsc --noEmit', start: 'node app.js' } }),
    'tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }',
    'AGENTS.md': 'Keep all required checks.\n',
    'src/AGENTS.md': 'Preserve tag object identity.\n',
    'src/tags.ts': 'import { normalize } from "@/normalize";\nexport const tags = (value: string) => normalize(value);\n',
    'src/normalize.ts': 'export const normalize = (value: string) => value.trim();\n',
    'src/screen.ts': 'import { tags } from "./tags.js";\nexport const visible = tags("work");\n',
    'test/tags.test.ts': 'import { tags } from "../src/tags";\nexport const example = tags(" Work ");\n',
    'src/unrelated.ts': 'export const weather = "sunny";\n',
    'src/string-only.ts': 'export const text = "import from tags";\n',
    'ignored/hidden.ts': 'export const secret = "hidden";\n',
    '.env': 'SECRET=fake-test-value\n',
    ...extra,
  };
  for (const [file, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), source);
  }
  return { root, files };
}
