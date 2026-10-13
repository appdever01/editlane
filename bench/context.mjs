import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { FocusEngine, renderPacket } from '../dist/context.js';
import { inventory } from '../dist/files.js';

const root = await mkdtemp(path.join(tmpdir(), 'editlane-bench-'));
try {
  const sources = {
    'package.json': JSON.stringify({ scripts: { test: 'node --test', typecheck: 'tsc --noEmit' } }),
    'src/tags.ts': 'import { normalize } from "./normalize";\nexport const tags = (value: string) => normalize(value);\n',
    'src/normalize.ts': 'export const normalize = (value: string) => value.trim().toLowerCase();\n',
    'src/picker.ts': 'import { tags } from "./tags";\nexport const picker = tags("work");\n',
    'test/tags.test.ts': 'import { tags } from "../src/tags";\nexport const example = tags(" Work ");\n',
    'AGENTS.md': 'Run the tag regression tests and review the exact diff.\n',
  };
  for (let index = 0; index < 100; index++) {
    sources[`src/features/feature-${index}.ts`] = Array.from({ length: 100 }, (_, row) => `export function feature${index}Row${row}(value: number) { return value + ${index + row}; }`).join('\n') + '\n';
  }
  for (const [file, source] of Object.entries(sources)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), source);
  }
  const baselineStarted = performance.now();
  const baseline = await Promise.all((await inventory(root)).map(file => readFile(path.join(root, file))));
  const baselineMs = performance.now() - baselineStarted;
  const baselineBytes = baseline.reduce((total, bytes) => total + bytes.length, 0);
  const engine = new FocusEngine();
  const cold = await engine.focus({ root, files: ['src/tags.ts'] });
  const warm = await engine.focus({ root, files: ['src/tags.ts'] });
  const expected = new Set(Object.keys(sources).filter(file => !file.startsWith('src/features/')));
  assert.deepEqual(new Set(cold.files.map(file => file.path)), expected);
  for (const file of cold.files) assert.equal(file.source, sources[file.path]);
  assert.deepEqual(cold.checks.map(check => check.name), ['test', 'typecheck']);
  assert.deepEqual(cold.omitted, []);
  const focusedBytes = Buffer.byteLength(renderPacket(cold));
  process.stdout.write(JSON.stringify({
    fixture: '100 unrelated feature modules, one known affected tag module, dependency, consumer, test, package and guidance',
    files: Object.keys(sources).length,
    fullSnapshotBytes: baselineBytes,
    focusedPacketBytes: focusedBytes,
    focusedSourceBytes: cold.metrics.sourceBytes + cold.metrics.instructionBytes,
    packetByteReductionPercent: Math.round((1 - focusedBytes / baselineBytes) * 10000) / 100,
    fullSnapshotReadMs: Math.round(baselineMs * 100) / 100,
    focusedColdMs: cold.metrics.elapsedMs,
    focusedWarmMs: warm.metrics.elapsedMs,
    warmParseCacheHits: warm.metrics.cacheHits,
    exactExpectedFiles: true,
    checksRetained: true,
    limits: 'Synthetic known-file context benchmark, not an AI-session speedup, quality score or billed-token result. Full-repo snapshots are a comparison workload, not a reconstruction of any agent session.',
  }, null, 2) + '\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
