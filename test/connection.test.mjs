import test from 'node:test';
import assert from 'node:assert/strict';
import { connection, doctor } from '../dist/connection.js';
import { repositoryRoot } from '../dist/files.js';
import { fixture } from './fixture.mjs';

test('connection snippets pin the same absolute root for every MCP client', async t => {
  const { root } = await fixture(t);
  const config = await connection(root);
  assert.equal(config.root, await repositoryRoot(root));
  assert.deepEqual(config.mcp.mcpServers.editlane.args.slice(-2), ['--root', config.root]);
  assert.ok(config.codex.includes(JSON.stringify(config.mcp.mcpServers.editlane.args)));
  await assert.rejects(repositoryRoot('${workspaceFolder}'), /did not expand.*absolute --root/);
});

test('doctor verifies real stdio source and boundaries before reporting connected', async t => {
  const { root } = await fixture(t);
  const checked = await doctor(root, ['src/tags.ts']);
  assert.equal(checked.connected, true);
  assert.equal(checked.outsideRootRejected, true);
  assert.deepEqual(checked.exactFiles, ['src/tags.ts']);
  await assert.rejects(doctor(root, ['ignored/hidden.ts']), /ignored/);
  await assert.rejects(doctor(root, ['../outside.ts']), /outside/);
});
