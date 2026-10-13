import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { FocusEngine } from '../dist/context.js';
import { Resolver } from '../dist/graph.js';
import { digest, inventory, repositoryRoot } from '../dist/files.js';
import { fixture } from './fixture.mjs';

async function resolverFor(root) {
  const canonical = await repositoryRoot(root);
  return new Resolver(canonical, new Set(await inventory(canonical)));
}

test('JSONC owners inherit multi-level relative configs and return exact parents or budget omissions', async t => {
  for (const name of ['tsconfig', 'jsconfig']) await t.test(name, async t => {
    const owner = `apps/web/${name}.json`;
    const target = 'apps/web/src/tags.ts';
    const chain = ['configs/shared/base.json', 'configs/middle.json', owner];
    const { root, files } = await fixture(t, {
      [owner]: '{ // owning config\n "extends": "../../configs/middle", "compilerOptions": { "strict": true, }, }',
      'configs/middle.json': '{ /* intermediate */ "extends": "./shared/base.json", }',
      'configs/shared/base.json': '{ // aliases without baseUrl\n "compilerOptions": { "paths": { "local/*": ["lib/*",], }, }, }',
      [target]: 'import "local/value"; export const tags = 1;',
      'configs/shared/lib/value.ts': 'export const value = 1;',
    });
    const engine = new FocusEngine();
    const packet = await engine.focus({ root, files: [target] });
    assert.ok(packet.files.some(file => file.path === 'configs/shared/lib/value.ts'));
    assert.deepEqual(packet.files.filter(file => chain.includes(file.path)).map(file => file.path), chain);
    for (const config of chain) {
      const returned = packet.files.find(file => file.path === config);
      assert.equal(returned.role, 'config');
      assert.equal(returned.source, files[config]);
      assert.equal(returned.bytes, Buffer.byteLength(files[config]));
      assert.equal(returned.sha256, digest(files[config]));
    }
    assert.equal(packet.warnings.some(warning => /resolution is incomplete|unresolved (?:local import|configured alias)/.test(warning)), false, packet.warnings.join('\n'));
    assert.ok(packet.checks.every(check => check.status === 'not_run'));
    const limited = await engine.focus({ root, files: [target], budgetBytes: Buffer.byteLength(files[target]) });
    for (const config of chain) assert.ok(limited.omitted.some(file => file.path === config && /budget/.test(file.reason)));
  });
});

test('paths declaration origins, effective baseUrl origins and whole-map child overrides are preserved', async t => {
  const cases = [
    { name: 'inherited paths without baseUrl', expected: 'configs/shared/lib/value.ts' },
    { name: 'parent baseUrl', baseOptions: { baseUrl: '../workspace' }, expected: 'configs/workspace/lib/value.ts' },
    { name: 'middle baseUrl', middleOptions: { baseUrl: '../workspace' }, expected: 'workspace/lib/value.ts' },
    { name: 'child baseUrl', baseOptions: { baseUrl: '../workspace' }, childOptions: { baseUrl: 'workspace' }, expected: 'apps/web/workspace/lib/value.ts' },
    { name: 'child paths without baseUrl', childOptions: { paths: { 'child/*': ['lib/*'] } }, specifier: 'child/value', expected: 'apps/web/lib/value.ts' },
    { name: 'child paths with inherited baseUrl', baseOptions: { baseUrl: '../workspace' }, childOptions: { paths: { 'child/*': ['lib/*'] } }, specifier: 'child/value', expected: 'configs/workspace/lib/value.ts' },
    { name: 'child paths and baseUrl', baseOptions: { baseUrl: '../workspace' }, childOptions: { baseUrl: 'workspace', paths: { 'child/*': ['lib/*'] } }, specifier: 'child/value', expected: 'apps/web/workspace/lib/value.ts' },
  ];
  for (const entry of cases) await t.test(entry.name, async t => {
    const { root } = await fixture(t, {
      'configs/shared/base.json': JSON.stringify({ compilerOptions: { paths: { 'local/*': ['lib/*'], 'parent-only': ['lib/value.ts'] }, ...entry.baseOptions } }),
      'configs/middle.json': JSON.stringify({ extends: './shared/base', compilerOptions: entry.middleOptions ?? {} }),
      'apps/web/tsconfig.json': JSON.stringify({ extends: '../../configs/middle.json', compilerOptions: entry.childOptions ?? {} }),
      'apps/web/src/tags.ts': 'export const tags = 1;',
      [entry.expected]: 'export const value = 1;',
    });
    const resolver = await resolverFor(root);
    const from = 'apps/web/src/tags.ts';
    assert.deepEqual(await resolver.resolve(from, entry.specifier ?? 'local/value'), { file: entry.expected });
    if (entry.childOptions?.paths) {
      assert.deepEqual(await resolver.resolve(from, 'local/value'), { external: 'local/value' });
      assert.deepEqual(await resolver.resolve(from, 'parent-only'), { external: 'parent-only' });
    } else assert.deepEqual(await resolver.resolve(from, 'parent-only'), { file: entry.expected });
    assert.deepEqual(await resolver.resolve(from, 'lib/value'), entry.baseOptions || entry.middleOptions || entry.childOptions?.baseUrl ? { file: entry.expected } : { external: 'lib/value' });
  });
});

test('an empty child paths map clears inherited aliases and keeps legacy baseUrl lookup', async t => {
  const { root } = await fixture(t, {
    'configs/base.json': '{"compilerOptions":{"baseUrl":"../src","paths":{"local/*":["*"]}}}',
    'tsconfig.json': '{"extends":"./configs/base","compilerOptions":{"paths":{}}}',
  });
  const resolver = await resolverFor(root);
  assert.deepEqual(await resolver.resolve('src/tags.ts', 'local/normalize'), { external: 'local/normalize' });
  assert.deepEqual(await resolver.resolve('src/tags.ts', 'normalize'), { file: 'src/normalize.ts' });
});

test('the nearest config still owns resolution, with tsconfig preferred at the same directory', async t => {
  const { root } = await fixture(t, {
    'apps/web/jsconfig.json': '{"extends":"../../configs/base.json"}',
    'configs/base.json': '{"compilerOptions":{"paths":{"local/*":["lib/*"]}}}',
    'configs/lib/value.ts': 'export const value = 1;',
    'apps/web/src/tags.ts': 'export const tags = 1;',
  });
  let resolver = await resolverFor(root);
  assert.deepEqual(await resolver.resolve('apps/web/src/tags.ts', 'local/value'), { file: 'configs/lib/value.ts' });
  assert.deepEqual(await resolver.resolve('apps/web/src/tags.ts', '@/normalize'), { external: '@/normalize' });
  await writeFile(path.join(root, 'apps/web/tsconfig.json'), '{"compilerOptions":{"paths":{}}}');
  resolver = await resolverFor(root);
  assert.equal((await resolver.configFor('apps/web/src/tags.ts')).file, 'apps/web/tsconfig.json');
  assert.deepEqual(await resolver.resolve('apps/web/src/tags.ts', 'local/value'), { external: 'local/value' });
});

test('fresh focus requests reflect same-length parent edits in aliases and exact source', async t => {
  const parent = '{"compilerOptions":{"paths":{"local/*":["one/*"]}}}';
  const { root } = await fixture(t, {
    'tsconfig.json': '{"extends":"./configs/base"}',
    'configs/base.json': parent,
    'src/tags.ts': 'import "local/value"; export const tags = 1;',
    'configs/one/value.ts': 'export const value = 1;',
    'configs/two/value.ts': 'export const value = 2;',
  });
  const engine = new FocusEngine();
  const before = await engine.focus({ root, files: ['src/tags.ts'] });
  assert.ok(before.files.some(file => file.path === 'configs/one/value.ts'));
  const changed = parent.replace('one', 'two');
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(parent));
  await writeFile(path.join(root, 'configs/base.json'), changed);
  const after = await engine.focus({ root, files: ['src/tags.ts'] });
  assert.ok(after.metrics.cacheHits > 0);
  assert.ok(after.files.some(file => file.path === 'configs/two/value.ts'));
  assert.equal(after.files.some(file => file.path === 'configs/one/value.ts'), false);
  const returned = after.files.find(file => file.path === 'configs/base.json');
  assert.equal(returned.source, changed);
  assert.notEqual(returned.sha256, before.files.find(file => file.path === 'configs/base.json').sha256);
});

test('missing, malformed and unsupported parents warn while child-local settings still resolve', async t => {
  const cases = [
    { name: 'missing', extends: './missing', warning: /missing.*excluded/ },
    { name: 'malformed JSONC', extends: './bad.json', parent: '{"compilerOptions":', warning: /Invalid JSONC/ },
    { name: 'non-object JSONC', extends: './bad.json', parent: '[]', warning: /Invalid JSONC/ },
    { name: 'package extends', extends: '@scope/config', warning: /single relative.*unsupported/ },
    { name: 'array extends', extends: ['./bad.json'], parent: '{}', warning: /single relative.*unsupported/ },
    { name: 'empty extends', extends: '', warning: /single relative.*unsupported/ },
    { name: 'absolute extends', extends: '/bad.json', warning: /single relative.*unsupported/ },
  ];
  for (const entry of cases) await t.test(entry.name, async t => {
    const { root } = await fixture(t, {
      'tsconfig.json': JSON.stringify({ extends: entry.extends, compilerOptions: { baseUrl: './src', paths: { 'local/*': ['*'] } } }),
      'src/tags.ts': 'import "local/normalize"; export const tags = 1;',
      ...(entry.parent === undefined ? {} : { 'bad.json': entry.parent }),
    });
    const packet = await new FocusEngine().focus({ root, files: ['src/tags.ts'] });
    assert.ok(packet.files.some(file => file.path === 'src/normalize.ts'));
    assert.ok(packet.warnings.some(warning => warning.includes('incomplete') && entry.warning.test(warning)), packet.warnings.join('\n'));
    assert.equal(packet.files.some(file => file.path === 'bad.json'), false);
    assert.ok(packet.checks.every(check => check.status === 'not_run'));
  });
});

test('a failed grandparent retains usable intermediate settings and returns only loaded configs', async t => {
  const { root } = await fixture(t, {
    'tsconfig.json': '{"extends":"./configs/middle"}',
    'configs/middle.json': '{"extends":"./broken","compilerOptions":{"paths":{"local/*":["lib/*"]}}}',
    'configs/broken.json': '{',
    'configs/lib/value.ts': 'export const value = 1;',
    'src/tags.ts': 'import "local/value"; export const tags = 1;',
  });
  const packet = await new FocusEngine().focus({ root, files: ['src/tags.ts'] });
  assert.ok(packet.files.some(file => file.path === 'configs/lib/value.ts'));
  assert.ok(packet.files.some(file => file.path === 'configs/middle.json' && file.role === 'config'));
  assert.equal(packet.files.some(file => file.path === 'configs/broken.json'), false);
  assert.ok(packet.warnings.some(warning => /middle.json.*incomplete.*broken.json/.test(warning)));
});

test('verified consumers include their inherited config context and incomplete-resolution warnings', async t => {
  const { root, files } = await fixture(t, {
    'apps/web/jsconfig.json': '{"extends":"../../configs/consumer"}',
    'configs/consumer.json': '{"extends":"./missing","compilerOptions":{"paths":{"local/*":["../src/*"]}}}',
    'apps/web/src/screen.ts': 'import { tags } from "local/tags"; export const screen = tags;',
  });
  const packet = await new FocusEngine().focus({ root, files: ['src/tags.ts'] });
  assert.ok(packet.files.some(file => file.path === 'apps/web/src/screen.ts' && file.role === 'consumer'));
  for (const config of ['configs/consumer.json', 'apps/web/jsconfig.json']) {
    assert.ok(packet.files.some(file => file.path === config && file.role === 'config' && file.source === files[config]));
  }
  assert.ok(packet.warnings.some(warning => /consumer.json.*incomplete.*missing.json/.test(warning)));
});

test('cycles and the 16-config traversal limit warn and preserve usable loaded settings', async t => {
  await t.test('cycle', async t => {
    const { root } = await fixture(t, {
      'tsconfig.json': '{"extends":"./configs/base","compilerOptions":{"paths":{"local/*":["src/*"]}}}',
      'configs/base.json': '{"extends":"../tsconfig.json","compilerOptions":{"paths":{"wrong/*":["*"]}}}',
      'src/tags.ts': 'import "local/normalize"; export const tags = 1;',
    });
    const packet = await new FocusEngine().focus({ root, files: ['src/tags.ts'] });
    assert.ok(packet.files.some(file => file.path === 'src/normalize.ts'));
    assert.equal(packet.files.filter(file => file.path === 'tsconfig.json').length, 1);
    assert.ok(packet.warnings.some(warning => /incomplete.*cycle.*tsconfig.json/.test(warning)));
  });
  await t.test('bounded chain', async t => {
    const extra = {
      'tsconfig.json': '{"extends":"./configs/1","compilerOptions":{"paths":{"local/*":["src/*"]}}}',
      'src/tags.ts': 'import "local/normalize"; export const tags = 1;',
      'configs/16.json': '\0',
    };
    for (let index = 1; index < 16; index++) extra[`configs/${index}.json`] = JSON.stringify({ extends: `./${index + 1}.json` });
    const { root } = await fixture(t, extra);
    const packet = await new FocusEngine().focus({ root, files: ['src/tags.ts'] });
    assert.ok(packet.files.some(file => file.path === 'src/normalize.ts'));
    assert.equal(packet.files.filter(file => /^(?:tsconfig.json|configs\/\d+.json)$/.test(file.path)).length, 16);
    assert.equal(packet.files.some(file => file.path === 'configs/16.json'), false);
    assert.ok(packet.warnings.some(warning => /incomplete.*16-config limit.*configs\/16.json/.test(warning)));
    assert.equal(packet.warnings.some(warning => /Binary/.test(warning)), false);
  });
});

test('ignored, private and symlinked parents are excluded without losing local aliases', async t => {
  for (const parent of ['ignored/base.json', '.openai/base.json', 'linked.json', 'linked/base.json']) await t.test(parent, async t => {
    const { root } = await fixture(t, {
      'tsconfig.json': JSON.stringify({ extends: `./${parent}`, compilerOptions: { paths: { 'local/*': ['src/*'] } } }),
      'src/tags.ts': 'import "local/normalize"; export const tags = 1;',
      'ignored/base.json': '\0',
      '.openai/base.json': '\0',
      'parents/base.json': '{"compilerOptions":{"paths":{"forbidden/*":["*"]}}}',
    });
    await symlink(path.join(root, 'parents/base.json'), path.join(root, 'linked.json'));
    await symlink(path.join(root, 'parents'), path.join(root, 'linked'));
    const packet = await new FocusEngine().focus({ root, files: ['src/tags.ts'] });
    assert.ok(packet.files.some(file => file.path === 'src/normalize.ts'));
    assert.equal(packet.files.some(file => file.path === parent || file.path === 'parents/base.json'), false);
    assert.ok(packet.warnings.some(warning => /incomplete/.test(warning) && /excluded|Symlinks/.test(warning)));
    assert.equal(packet.warnings.some(warning => /Binary/.test(warning)), false);
  });
});

test('parent traversal cannot read outside the selected root even if a parent exists there', async t => {
  const { root } = await fixture(t, {
    'project/tsconfig.json': '{"extends":"../outside.json","compilerOptions":{"paths":{"local/*":["src/*"]}}}',
    'project/src/tags.ts': 'import "local/value"; export const tags = 1;',
    'project/src/value.ts': 'export const value = 1;',
    'outside.json': '\0',
  });
  const packet = await new FocusEngine().focus({ root: path.join(root, 'project'), files: ['src/tags.ts'] });
  assert.ok(packet.files.some(file => file.path === 'src/value.ts'));
  assert.equal(packet.files.some(file => file.path.includes('outside.json')), false);
  assert.ok(packet.warnings.some(warning => /incomplete.*outside the repository/.test(warning)));
  assert.equal(packet.warnings.some(warning => /Binary/.test(warning)), false);
});

test('parent loading preserves source read limits and reports malformed option shapes', async t => {
  const cases = [
    { name: 'binary', parent: '\0', warning: /Binary file excluded/ },
    { name: 'invalid UTF-8', parent: Buffer.from([0xff]), warning: /encoded data.*encoding utf-8/ },
    { name: 'oversized', parent: ' '.repeat(512_001), warning: /512000-byte read limit/ },
    { name: 'invalid compilerOptions', parent: '{"compilerOptions":[]}', warning: /compilerOptions must be an object/ },
    { name: 'invalid baseUrl', parent: '{"compilerOptions":{"baseUrl":true}}', warning: /baseUrl must be a string/ },
    { name: 'invalid paths', parent: '{"compilerOptions":{"paths":[]}}', warning: /paths must be an object/ },
    { name: 'invalid path entries', parent: '{"compilerOptions":{"paths":{"bad":[1]}}}', warning: /paths entry bad must be an array of strings/ },
  ];
  for (const entry of cases) await t.test(entry.name, async t => {
    const { root } = await fixture(t, {
      'tsconfig.json': '{"extends":"./base","compilerOptions":{"paths":{"local/*":["src/*"]}}}',
      'base.json': entry.parent,
      'src/tags.ts': 'import "local/normalize"; export const tags = 1;',
    });
    const packet = await new FocusEngine().focus({ root, files: ['src/tags.ts'] });
    assert.ok(packet.files.some(file => file.path === 'src/normalize.ts'));
    assert.ok(packet.warnings.some(warning => entry.warning.test(warning) && warning.includes('incomplete')), packet.warnings.join('\n'));
  });
});
