import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, chmod, readFile, symlink, utimes, stat } from 'node:fs/promises';
import { FocusEngine } from '../dist/context.js';
import { fixture } from './fixture.mjs';

async function backend(t, source) {
  const { root } = await fixture(t);
  const executable = path.join(root, 'mock-search.mjs');
  await writeFile(executable, `#!${process.execPath}\n${source}`);
  await chmod(executable, 0o700);
  const previous = process.env.EDITLANE_SEMBLE_BIN;
  process.env.EDITLANE_SEMBLE_BIN = executable;
  t.after(() => { if (previous === undefined) delete process.env.EDITLANE_SEMBLE_BIN; else process.env.EDITLANE_SEMBLE_BIN = previous; });
}

test('optional search indexes guarded snapshots only, returns fresh original source and cleans up', async t => {
  const { root, files } = await fixture(t, { 'service/receipt.py': 'def paid(): return "first"\n', '.env.ts': 'private', 'secret.local.ts': 'private', 'linked-real.py': 'def helper(): return 1\n', 'binary.py': Buffer.from([0]), 'invalid.py': Buffer.from([255]), 'large.py': 'x'.repeat(512001) });
  await symlink(path.join(root, 'linked-real.py'), path.join(root, 'linked.py'));
  const log = path.join(root, 'snapshot-path.txt');
  await backend(t, `import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
const args=process.argv.slice(2), snapshot=args.at(-1);
for(const file of ['.env.ts','secret.local.ts','ignored/hidden.ts','linked.py','AGENTS.md','binary.py','invalid.py','large.py']) if(existsSync(path.join(snapshot,file))) process.exit(2);
if(process.env.HF_HUB_OFFLINE!=='1' || process.env.SEMBLE_INDEX_WORKERS!=='0' || process.env.OPENBLAS_NUM_THREADS!=='2' || !args.includes('--')) process.exit(3);
writeFileSync(${JSON.stringify(log)},snapshot);
const source=readFileSync(path.join(snapshot,'service/receipt.py'),'utf8');
if(!source.includes('return')) process.exit(4);
console.log(JSON.stringify({results:[{file_path:'service/receipt.py',source:'stale fake snippet'}]}));
`);
  const engine = new FocusEngine();
  const first = await engine.focus({ root, query: '--help', search: 'semble', mode: 'edit' });
  assert.equal(first.files.find(file => file.path === 'service/receipt.py').source, files['service/receipt.py']);
  assert.ok(first.files.some(file => file.path === 'AGENTS.md'));
  assert.ok(first.checks.some(check => check.name === 'test' && check.status === 'not_run'));
  assert.ok(first.warnings.some(warning => warning.includes('fresh guarded snapshot')));
  for (const file of ['binary.py', 'invalid.py', 'large.py']) assert.ok(first.omitted.some(entry => entry.path === file));
  await assert.rejects(stat(await readFile(log, 'utf8')), { code: 'ENOENT' });
  const target = path.join(root, 'service/receipt.py');
  const info = await stat(target);
  const changed = files['service/receipt.py'].replace('first', 'later');
  await writeFile(target, changed);
  await utimes(target, info.atime, info.mtime);
  const second = await engine.focus({ root, query: 'payment receipt', search: 'semble' });
  assert.equal(second.files.find(file => file.path === 'service/receipt.py').source, changed);
  assert.ok(second.warnings.some(warning => warning.includes('required checks manually')));
});

test('known files bypass optional search and invalid provider results fail without a partial packet', async t => {
  const { root } = await fixture(t);
  await backend(t, 'process.exit(8);');
  const packet = await new FocusEngine().focus({ root, files: ['src/tags.ts'], search: 'semble' });
  assert.ok(packet.files.some(file => file.path === 'src/tags.ts'));
  await assert.rejects(new FocusEngine().focus({ root, query: 'tags', search: 'semble' }), /Optional Semble lookup failed/);
  await assert.rejects(new FocusEngine().focus({ root, query: '', search: 'semble' }), /non-empty query/);
  await assert.rejects(new FocusEngine().focus({ root, search: 'other' }), /Search backend/);
  for (const output of ['{', '{}', '{"results":[{"file_path":"../outside.py"}]}', '{"results":[{"file_path":"/absolute.py"}]}', '{"results":[{"file_path":"ignored/hidden.ts"}]}', '{"results":[]}']) {
    await writeFile(process.env.EDITLANE_SEMBLE_BIN, `#!${process.execPath}\nconsole.log(${JSON.stringify(output)});\n`);
    await assert.rejects(new FocusEngine().focus({ root, query: 'tags', search: 'semble' }), /Semble|outside/);
  }
});
