import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { FocusEngine } from '../dist/context.js';
import { fixture } from './fixture.mjs';

test('read follow-ups return exact requested contracts without another graph or unrelated guidance', async t => {
  const { root, files } = await fixture(t);
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'test/AGENTS.md'), 'Keep regression coverage.\n');
  const engine = new FocusEngine();
  const first = await engine.focus({ root, files: ['src/tags.ts'], mode: 'edit' });
  const packet = await engine.focus({ root, files: ['test/tags.test.ts'], mode: 'read' });
  assert.deepEqual(packet.files.map(file => file.path).sort(), ['AGENTS.md', 'test/AGENTS.md', 'test/tags.test.ts']);
  assert.equal(packet.files.find(file => file.path === 'test/tags.test.ts').source, files['test/tags.test.ts']);
  assert.deepEqual(packet.checks, first.checks);
  assert.equal(packet.metrics.parsedFiles, 0);
  assert.equal(packet.metrics.cacheHits, 0);
  assert.ok(packet.warnings.some(warning => /not discovered/.test(warning)));
  assert.equal(packet.deferred, undefined);
  await assert.rejects(engine.focus({ root, query: 'tags', mode: 'read' }), /explicit files/);
  await assert.rejects(engine.focus({ root, files: ['test/tags.test.ts'], mode: 'read', budgetBytes: 1 }), /exceed.*budget/);
});

test('read mode preserves source and package-check freshness while skipping only retained bodies', async t => {
  const { root } = await fixture(t);
  const engine = new FocusEngine();
  const first = await engine.focus({ root, files: ['src/tags.ts'], mode: 'read' });
  const knownHashes = Object.fromEntries(first.files.map(file => [file.path, file.sha256]));
  await writeFile(path.join(root, 'package.json'), '{"scripts":{"test":"node --test --test-concurrency=2"}}');
  await writeFile(path.join(root, 'src/AGENTS.md'), 'Updated source guidance.\n');
  const second = await engine.focus({ root, files: ['src/tags.ts'], mode: 'read', knownHashes });
  assert.equal(second.unchanged[0].path, 'src/tags.ts');
  assert.equal(second.files.find(file => file.path === 'src/AGENTS.md').source, 'Updated source guidance.\n');
  assert.deepEqual(second.checks, [{ packageFile: 'package.json', name: 'test', command: 'node --test --test-concurrency=2', status: 'not_run' }]);
  const source = '\ufeffexport const tags = "مرحبا";\r\n';
  await writeFile(path.join(root, 'src/tags.ts'), source);
  const third = await engine.focus({ root, files: ['src/tags.ts'], mode: 'read', knownHashes });
  assert.equal(third.files.find(file => file.path === 'src/tags.ts').source, source);
  assert.equal(third.unchanged, undefined);
});

test('read mode keeps root, ignore, private, symlink, binary, UTF-8 and size guards', async t => {
  const { root } = await fixture(t, { 'binary.ts': Buffer.from([0]), 'invalid.ts': Buffer.from([255]), 'large.ts': 'x'.repeat(512001) });
  await symlink(path.join(root, 'src/tags.ts'), path.join(root, 'link.ts'));
  for (const file of ['../outside.ts', '.env', 'ignored/hidden.ts', 'link.ts', 'binary.ts', 'invalid.ts', 'large.ts']) {
    await assert.rejects(new FocusEngine().focus({ root, files: [file], mode: 'read' }));
  }
});

test('CLI and fresh MCP sessions support read mode and explicit retained-source reset', async t => {
  const { root, files } = await fixture(t);
  const cli = path.resolve('dist/cli.js');
  const result = await promisify(execFile)(process.execPath, [cli, 'focus', '--root', root, '--file', 'src/tags.ts', '--mode', 'read', '--json']);
  const packet = JSON.parse(result.stdout);
  assert.equal(packet.files.find(file => file.role === 'target').source, files['src/tags.ts']);
  assert.ok(packet.files.every(file => ['target', 'instruction'].includes(file.role)));
  const client = new Client({ name: 'editlane-read-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'serve', '--root', root], stderr: 'pipe' }));
  for (const [reuseRetained, expected] of [[false, true], [true, false], [false, true]]) {
    const response = await client.callTool({ name: 'editlane_focus', arguments: { files: ['src/tags.ts'], mode: 'read', reuseRetained } });
    assert.ok(!response.isError);
    assert.equal(response.content[0].text.includes(files['src/tags.ts']), expected);
    assert.ok(!response.content[0].text.includes(files['src/normalize.ts']));
    assert.ok(response.content[0].text.includes('not discovered'));
  }
});
