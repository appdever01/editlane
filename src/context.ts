import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { access } from 'node:fs/promises';
import { codePattern, digest, inventory, readExact, relativePath, repositoryRoot, resolveInside, reverseCandidates } from './files.js';
import { ImportCache, Resolver } from './graph.js';

export interface FocusOptions {
  root: string;
  query?: string;
  files?: string[];
  budgetBytes?: number;
}

export interface ContextFile {
  path: string;
  role: 'target' | 'dependency' | 'consumer' | 'test' | 'config' | 'instruction';
  reason: string;
  sha256: string;
  bytes: number;
  source: string;
}

export interface Packet {
  schemaVersion: 1;
  query: string;
  files: ContextFile[];
  omitted: { path: string; reason: string }[];
  warnings: string[];
  checks: { packageFile: string; name: string; command: string; status: 'not_run' }[];
  metrics: { elapsedMs: number; sourceBytes: number; instructionBytes: number; inventoryFiles: number; parsedFiles: number; cacheHits: number; returnedFiles: number };
}

const instructionNames = ['AGENTS.md', 'AGENTS.override.md', 'AGENT.md', 'CLAUDE.md', 'CLAUDE.local.md', 'CODEX.md'];
const isTest = (file: string) => /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|\.)|\.(?:test|spec)\.[^.]+$/i.test(file);
const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'of', 'to', 'in', 'on', 'this', 'fix', 'update', 'change', 'please', 'page', 'screen']);

function terms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter(term => term.length > 1 && !stopWords.has(term));
}

function rank(file: string, words: string[]): number {
  const base = path.basename(file).toLowerCase();
  return words.reduce((score, word) => score + (base.includes(word) ? 10 : file.toLowerCase().includes(word) ? 2 : 0), 0);
}

export class FocusEngine {
  private cache = new ImportCache();

  async focus(options: FocusOptions): Promise<Packet> {
    const started = performance.now();
    const beforeParsed = this.cache.parsed;
    const beforeHits = this.cache.hits;
    const root = await repositoryRoot(options.root);
    const files = await inventory(root);
    const available = new Set(files);
    const budget = options.budgetBytes ?? 24_000;
    if (!Number.isInteger(budget) || budget < 1 || budget > 2_000_000) throw new Error('The context budget must be 1–2,000,000 bytes.');
    const warnings = ['Context is a starting point, not proof of complete impact coverage. Follow unresolved imports and repository requirements before editing.'];
    const omitted: Packet['omitted'] = [];
    let anchors = [...new Set((options.files ?? []).map(file => relativePath(root, resolveInside(root, file))))];
    if (!anchors.length) {
      const words = terms(options.query ?? '');
      const ranked = files.filter(file => codePattern.test(file) && !isTest(file)).map(file => ({ file, score: rank(file, words) }))
        .filter(entry => entry.score > 0).sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
      if (!ranked.length) throw new Error('No confident filename match. Pass an affected file with --file; no broad source scan was performed.');
      anchors = ranked.slice(0, 3).map(entry => entry.file);
      warnings.push('Targets were selected by filename relevance. Confirm them before editing.');
      for (const entry of ranked.slice(3, 23)) omitted.push({ path: entry.file, reason: 'Additional filename match; pass --file to expand.' });
    }
    if (anchors.length > 20) throw new Error('Use at most 20 affected files per context request.');
    for (const file of anchors) {
      if (!available.has(file)) throw new Error(`Target is ignored, private, missing or outside discovery: ${file}`);
    }
    const resolver = new Resolver(root, available);
    const candidates = new Map<string, { role: ContextFile['role']; reason: string }>();
    const sources = new Map<string, string>();
    const packages = new Set<string>();
    const sourceFor = async (file: string) => {
      if (!sources.has(file)) sources.set(file, await readExact(root, file));
      return sources.get(file)!;
    };
    const add = (file: string, role: ContextFile['role'], reason: string) => {
      if (!candidates.has(file)) candidates.set(file, { role, reason });
    };
    for (const file of anchors) add(file, 'target', 'Explicit target or filename match.');
    for (const file of anchors) {
      const imports = this.cache.get(`${root}/${file}`, await sourceFor(file), file);
      warnings.push(...imports.warnings);
      for (const specifier of imports.specifiers) {
        const resolved = await resolver.resolve(file, specifier);
        if (resolved.file) add(resolved.file, isTest(resolved.file) ? 'test' : 'dependency', `Imported by ${file}: ${specifier}`);
        if (resolved.warning) warnings.push(resolved.warning);
      }
      const config = await resolver.configFor(file);
      if (config) {
        add(config.file, 'config', `Module resolution for ${file}.`);
        warnings.push(...config.warnings);
      }
      let directory = path.dirname(file);
      for (;;) {
        const packageFile = directory === '.' ? 'package.json' : `${directory}/package.json`;
        if (available.has(packageFile)) { packages.add(packageFile); add(packageFile, 'config', `Package scripts for ${file}.`); break; }
        if (directory === '.') break;
        directory = path.dirname(directory);
      }
    }
    const reverse = (await reverseCandidates(root, anchors)).filter(file => available.has(file) && !anchors.includes(file));
    if (reverse.length > 200) warnings.push(`Consumer candidates limited to 200 of ${reverse.length}; expand scope to finish impact analysis.`);
    for (const file of reverse.slice(200)) omitted.push({ path: file, reason: 'Consumer candidate limit; pass --file to inspect.' });
    for (const file of reverse.slice(0, 200)) {
      try {
        const imports = this.cache.get(`${root}/${file}`, await sourceFor(file), file);
        warnings.push(...imports.warnings);
        for (const specifier of imports.specifiers) {
          const resolved = await resolver.resolve(file, specifier);
          if (resolved.file && anchors.includes(resolved.file)) add(file, isTest(file) ? 'test' : 'consumer', `Imports ${resolved.file}.`);
        }
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
        omitted.push({ path: file, reason: 'Consumer could not be inspected.' });
      }
    }
    warnings.push('Reverse discovery uses target filenames as candidates; renamed aliases, barrels, runtime imports and package exports can require broader inspection.');
    const matchingTests = files.filter(file => isTest(file) && rank(file, anchors.map(anchor => path.basename(anchor).replace(/\.[^.]+$/, '').toLowerCase())) > 0);
    for (const file of matchingTests.slice(0, 20)) {
      add(file, 'test', 'Test filename matches an affected file.');
    }
    for (const file of matchingTests.slice(20).filter(file => !candidates.has(file))) omitted.push({ path: file, reason: 'Test candidate limit; pass --file to inspect.' });
    const returned: ContextFile[] = [];
    let sourceBytes = 0;
    for (const [file, metadata] of candidates) {
      let source: string;
      try { source = await sourceFor(file); } catch (error) {
        if (metadata.role === 'target') throw error;
        omitted.push({ path: file, reason: error instanceof Error ? error.message : String(error) });
        warnings.push(`${file}: related source was not included.`);
        continue;
      }
      const bytes = Buffer.byteLength(source);
      if (sourceBytes + bytes > budget) {
        if (metadata.role === 'target') throw new Error(`Affected files exceed the ${budget}-byte budget. Increase --budget; source was not truncated.`);
        omitted.push({ path: file, reason: 'Context budget; use --file or increase --budget to retrieve exact source.' });
        continue;
      }
      returned.push({ path: file, ...metadata, source, bytes, sha256: digest(source) });
      sourceBytes += bytes;
    }
    const instructions = new Set<string>();
    for (const file of returned.map(entry => entry.path)) {
      let directory = path.dirname(file);
      for (;;) {
        for (const name of instructionNames) {
          const instructionFile = directory === '.' ? name : `${directory}/${name}`;
          try { await access(resolveInside(root, instructionFile)); instructions.add(instructionFile); } catch {}
        }
        if (directory === '.') break;
        directory = path.dirname(directory);
      }
    }
    let instructionBytes = 0;
    for (const file of [...instructions].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))) {
      const source = await readExact(root, file);
      const bytes = Buffer.byteLength(source);
      instructionBytes += bytes;
      if (instructionBytes > 1_000_000) throw new Error('Applicable instructions exceed the safety limit; no instructions were silently dropped.');
      returned.push({ path: file, role: 'instruction', reason: `Repository guidance scoped to ${path.dirname(file)}; precedence is determined by the host.`, source, bytes, sha256: digest(source) });
    }
    const checks: Packet['checks'] = [];
    for (const file of packages) {
      try {
        const data = JSON.parse(await sourceFor(file)) as { scripts?: Record<string, unknown> };
        for (const [name, command] of Object.entries(data.scripts ?? {})) {
          if (/(?:test|lint|check|build|validate)/i.test(name) && typeof command === 'string') checks.push({ packageFile: file, name, command, status: 'not_run' });
        }
      } catch { warnings.push(`${file}: could not read package scripts; inspect required checks manually.`); }
    }
    return {
      schemaVersion: 1, query: options.query ?? '', files: returned, omitted, warnings: [...new Set(warnings)], checks,
      metrics: { elapsedMs: Math.round((performance.now() - started) * 100) / 100, sourceBytes, instructionBytes, inventoryFiles: files.length,
        parsedFiles: this.cache.parsed - beforeParsed, cacheHits: this.cache.hits - beforeHits, returnedFiles: returned.length },
    };
  }
}

export function renderPacket(packet: Packet): string {
  const sections = [JSON.stringify({ ...packet, files: packet.files.map(({ source, ...file }) => file) }, null, 2)];
  for (const file of packet.files) sections.push(`FILE ${JSON.stringify(file.path)} (${file.role}, sha256=${file.sha256}, bytes=${file.bytes})\n${file.source}\nEND FILE ${JSON.stringify(file.path)}`);
  return sections.join('\n\n');
}
