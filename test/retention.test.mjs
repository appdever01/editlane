import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { writeFile } from 'node:fs/promises';
import { fixture } from './fixture.mjs';

async function connect(t, root) {
  const client = new Client({ name: 'editlane-retention-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/cli.js'), 'serve', '--root', root], stderr: 'pipe' }));
  return async args => (await client.callTool({ name: 'editlane_focus', arguments: args })).content[0].text;
}

const body = file => `FILE ${JSON.stringify(file)}\n`;

test('stdio retained reuse refreshes changes, preserves guidance/checks and never skips deferred source', async t => {
  const { root, files } = await fixture(t);
  const focus = await connect(t, root);
  const first = await focus({ files: ['src/tags.ts'], mode: 'edit' });
  assert.ok(first.includes(body('src/tags.ts')));
  assert.ok(!first.includes(body('src/screen.ts')));
  const followup = await focus({ files: ['src/tags.ts', 'src/screen.ts'], mode: 'edit', reuseRetained: true });
  assert.ok(!followup.includes(body('src/tags.ts')));
  assert.ok(followup.includes(body('src/screen.ts')));
  assert.ok(followup.includes(body('AGENTS.md')));
  assert.ok(followup.includes('not_run'));
  const source = files['src/tags.ts'].replaceAll('value', 'input');
  assert.equal(Buffer.byteLength(source), Buffer.byteLength(files['src/tags.ts']));
  await writeFile(path.join(root, 'src/tags.ts'), source);
  const changed = await focus({ files: ['src/tags.ts'], mode: 'edit', reuseRetained: true });
  assert.ok(changed.includes(body('src/tags.ts')));
  assert.ok(changed.includes(source));
  const refused = await focus({ files: ['../outside'], reuseRetained: true });
  assert.ok(refused.includes('outside'));
  const current = await focus({ files: ['src/tags.ts'], reuseRetained: true });
  assert.ok(!current.includes(body('src/tags.ts')));
  const override = await focus({ files: ['src/tags.ts'], reuseRetained: true, knownHashes: { 'src/tags.ts': '0'.repeat(64) } });
  assert.ok(override.includes(body('src/tags.ts')));
  const fullMap = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`other/${index}.ts`, 'a'.repeat(64)]));
  const bounded = await focus({ files: ['src/tags.ts'], reuseRetained: true, knownHashes: fullMap });
  assert.ok(bounded.includes(body('src/tags.ts')));
  assert.ok(bounded.includes('not_run'));
});

test('omitted reuse resets session retention and a fresh connection cannot inherit it', async t => {
  const { root } = await fixture(t);
  const focus = await connect(t, root);
  await focus({ files: ['src/tags.ts'], mode: 'edit' });
  await focus({ files: ['src/normalize.ts'], mode: 'edit' });
  const afterLoss = await focus({ files: ['src/tags.ts'], mode: 'edit', reuseRetained: true });
  assert.ok(afterLoss.includes(body('src/tags.ts')));
  const reset = await focus({ files: ['src/tags.ts'], mode: 'edit', reuseRetained: false });
  assert.ok(reset.includes(body('src/tags.ts')));
  const fresh = await connect(t, root);
  const other = await fresh({ files: ['src/tags.ts'], mode: 'edit', reuseRetained: true });
  assert.ok(other.includes(body('src/tags.ts')));
});
