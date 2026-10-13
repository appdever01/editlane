import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { analyzeNativeUsage, nativeUsage } from '../dist/usage.js';
import { fixture } from './fixture.mjs';

const codex = { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 30, reasoning_output_tokens: 20 } };
const cursor = { type: 'result', subtype: 'success', usage: { inputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 10, outputTokens: 30, reasoningTokens: 20 } };
const claude = { type: 'result', subtype: 'success', usage: { input_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 10, output_tokens: 30 } };

test('native usage preserves distinct client cache semantics and never double counts reasoning', () => {
  const a = analyzeNativeUsage([codex], 'codex');
  assert.equal(a.inputTotal, 100);
  assert.equal(a.uncachedInput, 20);
  assert.equal(a.cacheReadInput, 80);
  assert.equal(a.cacheWriteInput, null);
  assert.equal(a.output, 30);
  assert.equal(a.reasoningOutput, 20);
  assert.equal(a.complete, true);
  for (const [client, event] of [['claude', claude], ['cursor', cursor]]) {
    const b = analyzeNativeUsage([{ elapsed_seconds: 12, event }], client);
    assert.equal(b.inputTotal, 110);
    assert.equal(b.output, 30);
    assert.equal(b.complete, true);
  }
});

test('missing, invalid or interrupted usage remains unknown and failures remain visible', () => {
  const empty = analyzeNativeUsage([{ type: 'turn.started' }], 'codex');
  assert.equal(empty.inputTotal, null);
  assert.equal(empty.output, null);
  assert.equal(empty.complete, false);
  const partial = analyzeNativeUsage([{ ...cursor, usage: { inputTokens: 7, outputTokens: 4 } }], 'cursor');
  assert.equal(partial.inputTotal, null);
  assert.equal(partial.uncachedInput, 7);
  assert.equal(partial.complete, false);
  const failed = analyzeNativeUsage([codex, { type: 'turn.failed' }], 'codex');
  assert.equal(failed.inputTotal, 100);
  assert.equal(failed.complete, false);
  assert.ok(failed.warnings.some(warning => /native failure/.test(warning)));
  const invalid = analyzeNativeUsage([{ ...claude, usage: { ...claude.usage, input_tokens: -1 } }], 'claude');
  assert.equal(invalid.inputTotal, null);
  const noOutput = analyzeNativeUsage([{ ...codex, usage: { input_tokens: 100, cached_input_tokens: 80 } }], 'codex');
  assert.equal(noOutput.complete, false);
  assert.equal(noOutput.output, null);
  const invalidCache = analyzeNativeUsage([{ ...codex, usage: { ...codex.usage, cached_input_tokens: 101 } }], 'codex');
  assert.equal(invalidCache.uncachedInput, null);
  assert.equal(invalidCache.complete, false);
  const invalidReasoning = analyzeNativeUsage([{ ...cursor, usage: { ...cursor.usage, reasoningTokens: 31 } }], 'cursor');
  assert.equal(invalidReasoning.complete, false);
  const overflow = analyzeNativeUsage(Array(2).fill({ ...codex, usage: { ...codex.usage, input_tokens: Number.MAX_SAFE_INTEGER } }), 'codex');
  assert.equal(overflow.inputTotal, null);
  assert.equal(overflow.complete, false);
});

test('multiple complete turns are summed, while malformed logs and symlinks are refused', async t => {
  const { root } = await fixture(t);
  const file = path.join(root, 'native.jsonl');
  await writeFile(file, JSON.stringify(codex) + '\n' + JSON.stringify(codex) + '\n');
  const summary = await nativeUsage(file, 'codex');
  assert.equal(summary.terminalEvents, 2);
  assert.equal(summary.inputTotal, 200);
  await symlink(file, path.join(root, 'linked.jsonl'));
  await assert.rejects(nativeUsage(path.join(root, 'linked.jsonl'), 'codex'), /Symlink/);
  await writeFile(file, JSON.stringify(codex) + '\n{unfinished');
  await assert.rejects(nativeUsage(file, 'codex'), /Invalid native JSONL.*No partial/);
});
