import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import { FocusEngine } from '../dist/context.js';
import { extractImports } from '../dist/graph.js';
import { fixture } from './fixture.mjs';

test('one packet contains exact target, alias dependency, verified consumers, tests and scoped instructions', async t => {
  const { root, files } = await fixture(t);
  const packet = await new FocusEngine().focus({ root, files: ['src/tags.ts'] });
  const byPath = new Map(packet.files.map(file => [file.path, file]));
  for (const file of ['src/tags.ts', 'src/normalize.ts', 'src/screen.ts', 'test/tags.test.ts', 'AGENTS.md', 'src/AGENTS.md', 'package.json', 'tsconfig.json']) {
    assert.equal(byPath.get(file)?.source, files[file]);
    assert.equal(byPath.get(file)?.bytes, Buffer.byteLength(files[file]));
    assert.match(byPath.get(file)?.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(byPath.get('src/screen.ts').role, 'consumer');
  assert.equal(byPath.get('test/tags.test.ts').role, 'test');
  for (const file of ['src/string-only.ts', 'src/unrelated.ts', '.env', 'ignored/hidden.ts']) assert.equal(byPath.has(file), false);
  assert.equal(packet.checks.length, 2);
  assert.ok(packet.checks.every(check => check.status === 'not_run'));
});

test('static imports, reexports, require and dynamic import are parsed, with computed imports flagged', () => {
  const imports = extractImports('module.ts', `import type { A } from './types'; export { B } from './barrel'; const c = require('./legacy'); const d = import('./dynamic'); const e = import(variable); const fake = "import './fake'";`);
  assert.deepEqual(imports.specifiers.sort(), ['./barrel', './dynamic', './legacy', './types']);
  assert.ok(imports.warnings.some(warning => warning.includes('computed')));
});

test('unchanged ASTs are cached and a same-length edit invalidates the dependency cache', async t => {
  const { root } = await fixture(t, { 'src/normalize.ts': 'export const normalize = (x: string) => x;', 'src/alternate.ts': 'export const normalize = (x: string) => x;' });
  const engine = new FocusEngine();
  await engine.focus({ root, files: ['src/tags.ts'] });
  const warm = await engine.focus({ root, files: ['src/tags.ts'] });
  assert.ok(warm.metrics.cacheHits > 0);
  const original = await readFile(path.join(root, 'src/tags.ts'), 'utf8');
  const updated = original.replace('@/normalize', '@/alternate');
  assert.equal(Buffer.byteLength(original), Buffer.byteLength(updated));
  await writeFile(path.join(root, 'src/tags.ts'), updated);
  const changed = await engine.focus({ root, files: ['src/tags.ts'] });
  assert.ok(changed.files.some(file => file.path === 'src/alternate.ts'));
  assert.equal(changed.files.some(file => file.path === 'src/normalize.ts'), false);
});

test('byte budgets list omitted neighbors and never truncate targets or scoped instructions', async t => {
  const { root, files } = await fixture(t);
  const budgetBytes = Buffer.byteLength(files['src/tags.ts']);
  const packet = await new FocusEngine().focus({ root, files: ['src/tags.ts'], budgetBytes });
  assert.equal(packet.files.find(file => file.path === 'src/tags.ts').source, files['src/tags.ts']);
  assert.ok(packet.files.some(file => file.role === 'instruction'));
  assert.ok(packet.omitted.some(file => file.path === 'src/normalize.ts'));
  assert.equal(packet.metrics.sourceBytes, budgetBytes);
  await assert.rejects(new FocusEngine().focus({ root, files: ['src/tags.ts'], budgetBytes: 1 }), /exceed.*budget/);
});

test('path traversal, ignored targets, secrets and symlink targets are rejected', async t => {
  const { root } = await fixture(t);
  await symlink(path.join(root, 'src/tags.ts'), path.join(root, 'src/link.ts'));
  for (const file of ['../outside.ts', '.env', 'ignored/hidden.ts', 'src/link.ts']) {
    await assert.rejects(new FocusEngine().focus({ root, files: [file] }));
  }
});

test('unresolved imports and inherited configuration are surfaced, not silently treated as complete', async t => {
  const { root } = await fixture(t, { 'src/tags.ts': 'import "./missing"; export const tags = 1;', 'tsconfig.json': '{"extends":"./base.json"}' });
  const packet = await new FocusEngine().focus({ root, files: ['src/tags.ts'] });
  assert.ok(packet.warnings.some(warning => warning.includes('unresolved local import')));
  assert.ok(packet.warnings.some(warning => warning.includes('inherited config resolution is incomplete') && warning.includes('base.json')));
});

test('filename discovery is bounded and refuses an ungrounded broad scan', async t => {
  const { root } = await fixture(t);
  const packet = await new FocusEngine().focus({ root, query: 'fix tags filtering' });
  assert.equal(packet.files.find(file => file.role === 'target').path, 'src/tags.ts');
  assert.ok(packet.warnings.some(warning => warning.includes('filename relevance')));
  await assert.rejects(new FocusEngine().focus({ root, query: 'do something amazing' }), /Pass an affected file/);
});

test('UTF-8 BOM, CRLF and non-ASCII source bytes survive unchanged', async t => {
  const source = '\ufeffexport const tags = "مرحبا";\r\n';
  const { root } = await fixture(t, { 'src/tags.ts': source });
  const packet = await new FocusEngine().focus({ root, files: ['src/tags.ts'] });
  const returned = packet.files.find(file => file.path === 'src/tags.ts');
  assert.deepEqual(Buffer.from(returned.source), await readFile(path.join(root, 'src/tags.ts')));
});

test('nested aliases and indexes resolve from the owning package rather than the workspace root', async t => {
  const { root } = await fixture(t, {
    'apps/mobile/tsconfig.json': '{"compilerOptions":{"paths":{"local/*":["src/*"]}}}',
    'apps/mobile/package.json': '{"scripts":{"test":"node --test mobile"}}',
    'apps/mobile/src/tags.ts': 'import { normalize } from "local/helpers"; export const tags = normalize;',
    'apps/mobile/src/helpers/index.ts': 'export const normalize = (value: string) => value;',
  });
  const packet = await new FocusEngine().focus({ root, files: ['apps/mobile/src/tags.ts'] });
  assert.ok(packet.files.some(file => file.path === 'apps/mobile/src/helpers/index.ts'));
  assert.equal(packet.checks[0].packageFile, 'apps/mobile/package.json');
});
