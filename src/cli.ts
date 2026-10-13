#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { FocusEngine, renderPacket } from './context.js';
import { digest, readExact, relativePath, repositoryRoot, resolveInside } from './files.js';
import { appendEvent, auditEvents, eventSchema, readJournal } from './trace.js';
import { runRecorded } from './run.js';

const help = `Editlane 0.1.0 — focused context, earlier edits, visible evidence.

editlane focus "fix tag filtering" --root . --file src/tags.ts [--budget 24000] [--mode edit] [--compact] [--json]
editlane focus "where are payment retries handled" --root . --search semble [--budget 100000]
editlane prepare-search
editlane serve --root .
editlane connection --root .
editlane doctor --root . --file src/tags.ts
editlane usage --client codex --trace native-events.jsonl
editlane audit --journal session.jsonl
editlane record --journal session.jsonl --kind read --key src/tags.ts --root .
editlane run --journal session.jsonl [--kind check] [--root .] -- npm test
editlane metadata --root . [--rtk]

Node 22+ and ripgrep are required. --file is repeatable. Context contains exact
source and may include local instructions. Keep packets and journals private.
The MCP server is read-only. Checks are discovered, never silently executed.
No client configuration is changed. No model or billing speedup is promised.
`;

async function main(): Promise<void> {
  const delimiter = process.argv.indexOf('--', 2);
  const commandArgs = delimiter < 0 ? [] : process.argv.slice(delimiter + 1);
  const parsed = parseArgs({ args: process.argv.slice(2, delimiter < 0 ? undefined : delimiter), allowPositionals: true, strict: true,
    options: { root: { type: 'string' }, file: { type: 'string', multiple: true }, budget: { type: 'string' }, json: { type: 'boolean' },
      client: { type: 'string' }, trace: { type: 'string' }, mode: { type: 'string' }, search: { type: 'string' }, compact: { type: 'boolean' }, knownHashes: { type: 'string' }, journal: { type: 'string' }, kind: { type: 'string' }, key: { type: 'string' }, fingerprint: { type: 'string' }, rtk: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' } } });
  const { values, positionals } = parsed;
  const command = positionals[0];
  if (values.version) { process.stdout.write('0.1.0\n'); return; }
  if (values.help || !command) { process.stdout.write(help); return; }
  const root = values.root ?? process.cwd();
  if (command === 'focus') {
    if (values.mode && !['edit', 'full'].includes(values.mode)) throw new Error('--mode must be edit or full.');
    if (values.search && !['filename', 'semble'].includes(values.search)) throw new Error('--search must be filename or semble.');
    const packet = await new FocusEngine().focus({ root, query: positionals.slice(1).join(' '), files: values.file ?? [], budgetBytes: Number(values.budget ?? 24000), mode: (values.mode ?? 'full') as 'edit' | 'full', search: (values.search ?? 'filename') as 'filename' | 'semble', ...(values.knownHashes ? { knownHashes: JSON.parse(values.knownHashes) } : {}) });
    const output = `${values.json ? JSON.stringify(packet, null, 2) : renderPacket(packet, values.compact ? 'compact' : 'plain')}\n`;
    process.stdout.write(output);
    if (values.journal) await appendEvent(values.journal, { timestamp: new Date().toISOString(), kind: 'context',
      key: JSON.stringify({ query: packet.query, files: values.file ?? [], budgetBytes: Number(values.budget ?? 24000), search: values.search ?? 'filename' }),
      fingerprint: digest(JSON.stringify({ ...packet, metrics: undefined, files: packet.files.map(({ source, ...file }) => file) })),
      bytes: Buffer.byteLength(output), durationMs: packet.metrics.elapsedMs });
  } else if (command === 'serve') {
    const { serve } = await import('./mcp.js');
    await serve(root);
  } else if (command === 'prepare-search') {
    const { prepareSearch } = await import('./search.js');
    process.stdout.write(`${JSON.stringify(await prepareSearch(), null, 2)}\n`);
  } else if (command === 'connection') {
    const { connection } = await import('./connection.js');
    process.stdout.write(`${JSON.stringify(await connection(root), null, 2)}\n`);
  } else if (command === 'doctor') {
    const { doctor } = await import('./connection.js');
    process.stdout.write(`${JSON.stringify(await doctor(root, values.file ?? []), null, 2)}\n`);
  } else if (command === 'usage') {
    if (!values.trace || !values.client || !['claude', 'codex', 'cursor'].includes(values.client)) throw new Error('--trace and --client (claude, codex or cursor) are required.');
    const { nativeUsage } = await import('./usage.js');
    process.stdout.write(`${JSON.stringify(await nativeUsage(values.trace, values.client as 'claude' | 'codex' | 'cursor'), null, 2)}\n`);
  } else if (command === 'audit') {
    if (!values.journal) throw new Error('--journal is required.');
    process.stdout.write(`${JSON.stringify(auditEvents(await readJournal(values.journal)), null, 2)}\n`);
  } else if (command === 'record') {
    if (!values.journal || !values.kind || !values.key) throw new Error('--journal, --kind and --key are required.');
    let fingerprint = values.fingerprint;
    if (values.kind === 'read') {
      const canonicalRoot = await repositoryRoot(root);
      const file = relativePath(canonicalRoot, resolveInside(canonicalRoot, values.key));
      fingerprint = digest(await readExact(canonicalRoot, file));
    }
    await appendEvent(values.journal, eventSchema.parse({ timestamp: new Date().toISOString(), kind: values.kind, key: values.key, ...(fingerprint ? { fingerprint } : {}) }));
  } else if (command === 'run') {
    if (!values.journal) throw new Error('--journal is required.');
    if (values.kind && !['check', 'command'].includes(values.kind)) throw new Error('--kind must be check or command for run.');
    process.exitCode = await runRecorded(commandArgs, values.journal, await repositoryRoot(root), values.kind === 'check' ? 'check' : 'command');
  } else if (command === 'metadata') {
    const { metadata } = await import('./metadata.js');
    process.stdout.write(`${JSON.stringify(await metadata(root, values.rtk ?? false), null, 2)}\n`);
  } else throw new Error(`Unknown command: ${command}. Use --help.`);
}

main().catch(error => { process.stderr.write(`Editlane: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
