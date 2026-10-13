import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { writeFile, realpath } from 'node:fs/promises';
import { fixture } from './fixture.mjs';
import { appendEvent } from '../dist/trace.js';
import { decode } from '@toon-format/toon';

test('real stdio client lists two read-only tools, retrieves fresh source and rejects outside-root journals', async t => {
  const { root } = await fixture(t);
  const client = new Client({ name: 'editlane-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/cli.js'), 'serve', '--root', root], stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 2);
  assert.ok(listed.tools.every(tool => tool.annotations.readOnlyHint));
  const first = await client.callTool({ name: 'editlane_focus', arguments: { files: ['src/tags.ts'] } });
  assert.equal(first.isError, undefined);
  assert.ok(first.content[0].text.includes('src/normalize.ts'));
  await writeFile(path.join(root, 'src/tags.ts'), 'export const tags = "changed";');
  const second = await client.callTool({ name: 'editlane_focus', arguments: { files: ['src/tags.ts'] } });
  assert.ok(second.content[0].text.includes('export const tags = "changed";'));
  const refused = await client.callTool({ name: 'editlane_audit', arguments: { journal: '../outside.jsonl' } });
  assert.equal(refused.isError, true);
  await appendEvent(path.join(root, '.editlane/session.jsonl'), { timestamp: new Date().toISOString(), kind: 'read', key: 'tags', fingerprint: 'one' });
  const audit = await client.callTool({ name: 'editlane_audit', arguments: { journal: '.editlane/session.jsonl' } });
  assert.equal(audit.isError, undefined);
  assert.equal(JSON.parse(audit.content[0].text).totalEvents, 1);
});

test('same-named files in separate projects always identify the configured canonical root', async t => {
  const left = await fixture(t, { 'src/tags.ts': 'export const tags = "left";\n' });
  const right = await fixture(t, { 'src/tags.ts': 'export const tags = "right";\n' });
  const client = new Client({ name: 'editlane-root-check', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/cli.js'), 'serve', '--root', left.root], stderr: 'pipe' }));
  for (const reuseRetained of [false, true]) {
    const result = await client.callTool({ name: 'editlane_focus', arguments: { files: ['src/tags.ts'], mode: 'edit', reuseRetained } });
    assert.ok(!result.isError);
    const text = result.content[0].text;
    const manifest = decode(text.slice(text.indexOf('\n') + 1).split('\n\nFILE ')[0]);
    assert.equal(manifest.root, await realpath(left.root));
    assert.notEqual(manifest.root, await realpath(right.root));
    assert.ok(!text.includes(right.files['src/tags.ts']));
    if (!reuseRetained) assert.ok(text.includes(left.files['src/tags.ts']));
  }
});
