import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { FocusEngine } from '../dist/context.js';
import { digest } from '../dist/files.js';
import { fixture } from './fixture.mjs';

test('explicit multilingual targets keep exact fresh source and expose dependency/check limits', async t => {
  const extra = {
    'service/main.py': 'from helper import run\nprint(run())\n',
    'service/main.go': 'package main\nimport "helper"\n',
    'service/main.rs': 'use helper::run;\n',
    'service/Main.java': 'import helper.Run;\n',
    'service/helper.py': 'def run(): return 1\n',
  };
  const { root } = await fixture(t, extra);
  const files = Object.keys(extra).filter(file => !file.endsWith('helper.py'));
  const engine = new FocusEngine();
  const first = await engine.focus({ root, files, mode: 'edit' });
  for (const file of files) {
    const entry = first.files.find(entry => entry.path === file);
    assert.equal(entry.role, 'target');
    assert.equal(entry.source, extra[file]);
    assert.equal(entry.sha256, digest(extra[file]));
    assert.ok(first.warnings.some(warning => warning.startsWith(`${file}:`) && warning.includes('required checks manually')));
  }
  assert.equal(first.files.some(entry => entry.path === 'service/helper.py'), false);
  assert.ok(first.files.some(entry => entry.role === 'instruction'));
  assert.ok(first.checks.every(check => check.status === 'not_run'));
  const changed = extra['service/main.py'].replace('run', 'job');
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(extra['service/main.py']));
  await writeFile(path.join(root, 'service/main.py'), changed);
  const second = await engine.focus({ root, files, knownHashes: Object.fromEntries(files.map(file => [file, digest(extra[file])])) });
  assert.equal(second.files.find(entry => entry.path === 'service/main.py').source, changed);
  assert.equal(second.unchanged.length, 3);
  assert.ok(second.warnings.some(warning => warning.startsWith('service/main.go:')));
  assert.ok(second.checks.every(check => check.status === 'not_run'));
});
