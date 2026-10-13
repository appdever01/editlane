import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { stat, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendEvent, auditEvents, readJournal } from '../dist/trace.js';
import { fixture } from './fixture.mjs';

const event = (seconds, kind, key, fingerprint) => ({ timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString(), kind, key, ...(fingerprint ? { fingerprint } : {}) });

test('audit distinguishes unchanged repeats, changed content and unverified repeats before first edit', () => {
  const events = [event(0, 'start', 'task'), event(1, 'read', 'tags', 'a'), event(2, 'read', 'tags', 'a'), event(3, 'read', 'tags', 'b'), event(4, 'read', 'unknown'), event(5, 'read', 'unknown'), event(6, 'edit', 'tags'), event(7, 'read', 'tags', 'b')];
  const report = auditEvents(events);
  assert.equal(report.firstEditMs, 6000);
  assert.equal(report.callsBeforeFirstEdit, 5);
  assert.equal(report.repeatedUnchangedCalls.length, 1);
  assert.equal(report.repeatedCallsWithoutFingerprint, 1);
});

test('failed and unfinished checks stay visible and no first edit is invented', () => {
  const report = auditEvents([{ ...event(0, 'check', 'test'), exitCode: 7 }, event(1, 'check', 'build')]);
  assert.equal(report.firstEditMs, null);
  assert.deepEqual(report.failedChecks, ['test']);
  assert.equal(report.recordedChecks[1].exitCode, null);
  assert.throws(() => auditEvents([event(2, 'read', 'a'), event(1, 'read', 'b')]), /recorded order/);
});

test('journal creation is private, round trips events, and refuses symlinks and malformed traces', async t => {
  const { root } = await fixture(t);
  const journal = path.join(root, 'session.jsonl');
  await appendEvent(journal, event(0, 'read', 'tags', 'hash'));
  assert.equal((await stat(journal)).mode & 0o777, 0o600);
  assert.equal((await readJournal(journal)).length, 1);
  await symlink(journal, path.join(root, 'linked.jsonl'));
  await assert.rejects(appendEvent(path.join(root, 'linked.jsonl'), event(1, 'read', 'tags')));
  await writeFile(journal, '{broken');
  await assert.rejects(readJournal(journal), /line 1/);
});

test('CLI command recording preserves stdout, stderr and a failing exit status exactly', async t => {
  const { root } = await fixture(t);
  const cli = path.resolve('dist/cli.js');
  const journal = path.join(root, 'check.jsonl');
  const result = await promisify(execFile)(process.execPath, [cli, 'run', '--root', root, '--journal', journal, '--kind', 'check', '--', process.execPath, '-e', 'process.stdout.write("out\\n"); process.stderr.write("failure\\n"); process.exitCode = 7;']).catch(error => error);
  assert.equal(result.code, 7);
  assert.equal(result.stdout, 'out\n');
  assert.equal(result.stderr, 'failure\n');
  const events = await readJournal(journal);
  assert.equal(events.at(-1).exitCode, 7);
  assert.equal(auditEvents(events).failedChecks.length, 1);
});

test('a missing executable remains a recorded failure', async t => {
  const { root } = await fixture(t);
  const journal = path.join(root, 'missing.jsonl');
  const result = await promisify(execFile)(process.execPath, [path.resolve('dist/cli.js'), 'run', '--root', root, '--journal', journal, '--kind', 'check', '--', 'editlane-no-such-executable']).catch(error => error);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ENOENT/);
  assert.equal(auditEvents(await readJournal(journal)).failedChecks.length, 1);
});

test('context fingerprint changes when omitted impact changes even if returned source is identical', async t => {
  const { root, files } = await fixture(t);
  const journal = path.join(root, 'context.jsonl');
  const args = [path.resolve('dist/cli.js'), 'focus', '--root', root, '--file', 'src/tags.ts', '--budget', String(Buffer.byteLength(files['src/tags.ts'])), '--journal', journal, '--json'];
  const run = () => promisify(execFile)(process.execPath, args);
  const first = await run();
  await run();
  await writeFile(path.join(root, 'src/new-consumer.ts'), 'import { tags } from "./tags"; export const result = tags("home");');
  await run();
  const events = await readJournal(journal);
  assert.equal(events[0].bytes, Buffer.byteLength(first.stdout));
  assert.equal(events[0].fingerprint, events[1].fingerprint);
  assert.notEqual(events[1].fingerprint, events[2].fingerprint);
  assert.equal(auditEvents(events).repeatedUnchangedCalls.length, 1);
});
