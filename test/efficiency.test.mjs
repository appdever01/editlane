import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decode } from '@toon-format/toon';
import { FocusEngine, renderPacket } from '../dist/context.js';
import { fixture } from './fixture.mjs';

const hashMap = packet => Object.fromEntries(packet.files.filter(file => file.role !== 'instruction').map(file => [file.path, file.sha256]));

test('compact metadata round trips and every source block stays exact', async t => {
  const { root } = await fixture(t);
  const packet = await new FocusEngine().focus({ root, files: ['src/tags.ts'] });
  const compact = renderPacket(packet, 'compact');
  const manifest = compact.slice(compact.indexOf('\n') + 1, compact.indexOf('\n\nFILE '));
  assert.deepEqual(decode(manifest), { ...packet, files: packet.files.map(({ source, ...file }) => file) });
  for (const file of packet.files) assert.ok(compact.includes(`FILE ${JSON.stringify(file.path)}\n${file.source}\nEND FILE ${JSON.stringify(file.path)}`));
  assert.ok(Buffer.byteLength(compact) < Buffer.byteLength(renderPacket(packet)));
});

test('edit mode defers only related bodies, keeps guidance and checks, and allows exact follow-up', async t => {
  const { root, files } = await fixture(t);
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'test/AGENTS.md'), 'Keep test fixtures exact.\n');
  const engine = new FocusEngine();
  const full = await engine.focus({ root, files: ['src/tags.ts'] });
  const edit = await engine.focus({ root, files: ['src/tags.ts'], mode: 'edit' });
  assert.deepEqual(edit.checks, full.checks);
  assert.equal(edit.files.find(file => file.path === 'src/tags.ts').source, files['src/tags.ts']);
  assert.equal(edit.files.find(file => file.path === 'src/normalize.ts').source, files['src/normalize.ts']);
  assert.ok(edit.files.some(file => file.path === 'test/AGENTS.md'));
  assert.deepEqual(edit.deferred.map(file => file.path).sort(), ['src/screen.ts', 'test/tags.test.ts']);
  for (const file of edit.deferred) {
    assert.ok(edit.omitted.some(omission => omission.path === file.path && /deferred/.test(omission.reason)));
    const expanded = await engine.focus({ root, files: [file.path], mode: 'edit' });
    assert.equal(expanded.files.find(entry => entry.path === file.path).source, files[file.path]);
  }
});

test('known hashes skip only current retained source, refresh same-size edits and always send guidance', async t => {
  const { root } = await fixture(t);
  const engine = new FocusEngine();
  const first = await engine.focus({ root, files: ['src/tags.ts'] });
  const knownHashes = hashMap(first);
  const second = await engine.focus({ root, files: ['src/tags.ts'], knownHashes, budgetBytes: 1 });
  assert.ok(second.files.every(file => file.role === 'instruction'));
  assert.equal(second.unchanged.length, Object.keys(knownHashes).length);
  assert.deepEqual(second.checks, first.checks);
  assert.deepEqual(second.omitted, []);
  const source = first.files.find(file => file.path === 'src/normalize.ts').source.replaceAll('value', 'input');
  await writeFile(path.join(root, 'src/normalize.ts'), source);
  const third = await engine.focus({ root, files: ['src/tags.ts'], knownHashes });
  assert.equal(third.files.find(file => file.path === 'src/normalize.ts').source, source);
  assert.ok(!third.unchanged.some(file => file.path === 'src/normalize.ts'));
  assert.ok(third.files.some(file => file.role === 'instruction'));
  await assert.rejects(engine.focus({ root, files: ['.env'], knownHashes: { '.env': 'a'.repeat(64) } }), /ignored|private/i);
  await assert.rejects(engine.focus({ root, files: ['src/tags.ts'], knownHashes: { 'src/tags.ts': 'bad' } }), /SHA-256/);
});

for (const parent of ['configs/base', 'configs/base.jsonc']) test(`literal parent ${parent} precedes .json fallback`, async t => {
  const source = '{"compilerOptions":{"paths":{"@literal/*":["lib/*"]}}}';
  const { root } = await fixture(t, {
    'tsconfig.json': JSON.stringify({ extends: './' + parent }),
    [parent]: source,
    [parent + '.json']: '{"compilerOptions":{"paths":{"@wrong/*":["wrong/*"]}}}',
    'src/tags.ts': 'import "@literal/value";',
    'configs/lib/value.ts': 'export const value = 1;',
  });
  const packet = await new FocusEngine().focus({ root, files: ['src/tags.ts'] });
  assert.equal(packet.files.find(file => file.path === parent).source, source);
  assert.ok(packet.files.some(file => file.path === 'configs/lib/value.ts'));
  assert.ok(!packet.files.some(file => file.path === parent + '.json'));
});

test('array-shaped parents are excluded with actionable warnings while local aliases work', async t => {
  const { root } = await fixture(t, {
    'tsconfig.json': '{"extends":"./configs/invalid.json","compilerOptions":{"paths":{"@local/*":["src/*"]}}}',
    'configs/invalid.json': '[]',
    'src/tags.ts': 'import "@local/normalize";',
  });
  const packet = await new FocusEngine().focus({ root, files: ['src/tags.ts'] });
  assert.ok(packet.files.some(file => file.path === 'src/normalize.ts'));
  assert.ok(packet.warnings.some(warning => /incomplete.*Invalid JSONC/.test(warning)));
  assert.ok(!packet.files.some(file => file.path === 'configs/invalid.json'));
});

test('parent provenance for verified alias consumers survives edit mode', async t => {
  const source = '{"compilerOptions":{"paths":{"@parent/*":["../src/*"]}}}';
  const { root } = await fixture(t, {
    'apps/web/jsconfig.json': '{"extends":"../../configs/consumer.json"}',
    'configs/consumer.json': source,
    'apps/web/screen.ts': 'import { tags } from "@parent/tags"; export const screen = tags;',
  });
  for (const mode of ['full', 'edit']) {
    const packet = await new FocusEngine().focus({ root, files: ['src/tags.ts'], mode });
    assert.equal(packet.files.find(file => file.path === 'configs/consumer.json').source, source);
    assert.equal([...packet.files, ...(packet.deferred ?? [])].find(file => file.path === 'apps/web/screen.ts').role, 'consumer');
  }
});

test('excluded literal parents cannot fall through to a competing allowed .json file', async t => {
  const { root } = await fixture(t, {
    '.gitignore': 'configs/base\n',
    'tsconfig.json': '{"extends":"./configs/base","compilerOptions":{"paths":{"@local/*":["src/*"]}}}',
    'configs/base': '{"compilerOptions":{"paths":{"@secret/*":["secret/*"]}}}',
    'configs/base.json': '{"compilerOptions":{"paths":{"@wrong/*":["wrong/*"]}}}',
    'src/tags.ts': 'import "@local/normalize";',
  });
  const packet = await new FocusEngine().focus({ root, files: ['src/tags.ts'] });
  assert.ok(packet.files.some(file => file.path === 'src/normalize.ts'));
  assert.ok(packet.warnings.some(warning => /parent configs\/base is missing or excluded/.test(warning)));
  assert.ok(!packet.files.some(file => /^configs\/base/.test(file.path)));
});

test('a directory at the literal parent path does not hide the optional JSON file', async t => {
  const source = '{"compilerOptions":{"paths":{"@parent/*":["lib/*"]}}}';
  const { root } = await fixture(t, {
    'tsconfig.json': '{"extends":"./configs/base"}',
    'configs/base/child.txt': 'directory fixture',
    'configs/base.json': source,
    'configs/lib/value.ts': 'export const value = 1;',
    'src/tags.ts': 'import "@parent/value";',
  });
  const packet = await new FocusEngine().focus({ root, files: ['src/tags.ts'] });
  assert.equal(packet.files.find(file => file.path === 'configs/base.json').source, source);
  assert.ok(packet.files.some(file => file.path === 'configs/lib/value.ts'));
});
