import { Lang, parse } from '@ast-grep/napi';
import { parse as parseJson, type ParseError } from 'jsonc-parser';
import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { codePattern, digest, readExact, relativePath, resolveInside } from './files.js';

export interface Imports {
  specifiers: string[];
  warnings: string[];
}

export function extractImports(file: string, source: string): Imports {
  if (!codePattern.test(file)) return { specifiers: [], warnings: [] };
  const language = /\.[jt]sx$/i.test(file) ? Lang.Tsx : /\.[cm]?ts$/i.test(file) ? Lang.TypeScript : Lang.JavaScript;
  const root = parse(language, source).root();
  const specifiers = new Set<string>();
  const warnings: string[] = [];
  const take = (text: string | undefined) => {
    if (!text) return;
    if ((text.startsWith('"') || text.startsWith("'")) && !text.slice(1, -1).includes('\\')) specifiers.add(text.slice(1, -1));
    else warnings.push(`${file}: computed or escaped import requires manual inspection.`);
  };
  for (const node of root.findAll({ rule: { any: [{ kind: 'import_statement' }, { kind: 'export_statement' }] } })) {
    take(node.field('source')?.text());
  }
  for (const node of root.findAll({ rule: { kind: 'call_expression' } })) {
    if (['require', 'import'].includes(node.field('function')?.text() ?? '')) take(node.field('arguments')?.children().find(child => child.isNamed())?.text());
  }
  if (root.find({ rule: { kind: 'ERROR' } })) warnings.push(`${file}: parser found a syntax error; the dependency graph may be incomplete.`);
  return { specifiers: [...specifiers], warnings: [...new Set(warnings)] };
}

export class ImportCache {
  private entries = new Map<string, { hash: string; imports: Imports }>();
  parsed = 0;
  hits = 0;

  get(file: string, source: string, displayFile = file): Imports {
    const hash = digest(source);
    const cached = this.entries.get(file);
    if (cached?.hash === hash) {
      this.hits++;
      return cached.imports;
    }
    const imports = extractImports(displayFile, source);
    if (this.entries.size >= 1000) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(file, { hash, imports });
    this.parsed++;
    return imports;
  }
}

export interface Resolution {
  file?: string;
  warning?: string;
  external?: string;
}

interface Config {
  file: string;
  files: string[];
  base: string;
  paths: Record<string, string[]>;
  pathsBase: string;
  baseUrl: boolean;
  warnings: string[];
}

const maxConfigChain = 16;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export class Resolver {
  private configs = new Map<string, Promise<Config | undefined>>();
  constructor(private root: string, private files: Set<string>) {}

  async configFor(file: string): Promise<Config | undefined> {
    let directory = path.dirname(file);
    for (;;) {
      for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const configPath = directory === '.' ? name : `${directory}/${name}`;
        if (this.files.has(configPath)) {
          if (!this.configs.has(configPath)) this.configs.set(configPath, this.loadConfig(configPath));
          return this.configs.get(configPath);
        }
      }
      if (directory === '.') return undefined;
      directory = path.dirname(directory);
    }
  }

  private async loadConfig(file: string, ancestors: string[] = []): Promise<Config> {
    const errors: ParseError[] = [];
    const data: unknown = parseJson((await readExact(this.root, file)).replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });
    if (errors.length || !isRecord(data)) throw new Error(`Invalid JSONC configuration: ${file}`);
    const warnings: string[] = [];
    const chain = [...ancestors, file];
    const incomplete = (reason: string) => warnings.push(`${file}: inherited config resolution is incomplete: ${reason}. Check the extends chain or inspect inherited aliases manually.`);
    let parent: Config | undefined;
    if (Object.hasOwn(data, 'extends')) {
      if (typeof data.extends !== 'string' || !/^\.\.?\//.test(data.extends)) {
        incomplete('extends must be a single relative path (./ or ../); package names, arrays and absolute paths are unsupported');
      } else {
        let parentFile = relativePath(this.root, path.resolve(this.root, path.dirname(file), data.extends));
        try {
          resolveInside(this.root, parentFile);
          let exists = this.files.has(parentFile);
          if (!exists) {
            try { const info = await lstat(resolveInside(this.root, parentFile)); exists = info.isFile() || info.isSymbolicLink(); }
            catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
          }
          if (!exists && !data.extends.endsWith('.json')) parentFile += '.json';
          if (chain.includes(parentFile)) incomplete(`cycle detected: ${[...chain, parentFile].join(' -> ')}`);
          else if (chain.length >= maxConfigChain) incomplete(`${maxConfigChain}-config limit reached before ${parentFile}`);
          else if (!this.files.has(parentFile)) incomplete(`parent ${parentFile} is missing or excluded by discovery (ignored, private or symlinked)`);
          else parent = await this.loadConfig(parentFile, chain);
        } catch (error) {
          incomplete(`could not load parent ${parentFile}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    const directory = path.resolve(this.root, path.dirname(file));
    const options = isRecord(data.compilerOptions) ? data.compilerOptions : {};
    if (data.compilerOptions !== undefined && !isRecord(data.compilerOptions)) warnings.push(`${file}: compilerOptions must be an object; alias resolution is incomplete. Check compilerOptions.`);
    let paths = parent?.paths ?? {};
    let pathsBase = parent?.pathsBase ?? directory;
    if (Object.hasOwn(options, 'paths')) {
      paths = {};
      pathsBase = directory;
      if (isRecord(options.paths)) {
        const entries = Object.entries(options.paths).filter(([key, values]) => {
          if (Array.isArray(values) && values.every(value => typeof value === 'string')) return true;
          warnings.push(`${file}: paths entry ${key} must be an array of strings; alias resolution is incomplete. Check compilerOptions.paths.`);
          return false;
        });
        paths = Object.fromEntries(entries) as Record<string, string[]>;
      } else warnings.push(`${file}: paths must be an object; alias resolution is incomplete. Check compilerOptions.paths.`);
    }
    if (options.baseUrl !== undefined && typeof options.baseUrl !== 'string') warnings.push(`${file}: baseUrl must be a string; alias resolution is incomplete. Check compilerOptions.baseUrl.`);
    const baseUrl = typeof options.baseUrl === 'string' || (parent?.baseUrl ?? false);
    const base = typeof options.baseUrl === 'string' ? path.resolve(directory, options.baseUrl) : parent?.baseUrl ? parent.base : pathsBase;
    return { file, files: [...(parent?.files ?? []), file], base, paths, pathsBase, baseUrl, warnings: [...(parent?.warnings ?? []), ...warnings] };
  }

  private resolveCandidate(absolute: string): string | undefined {
    const relative = relativePath(this.root, absolute);
    try { resolveInside(this.root, relative); } catch { return undefined; }
    const candidates = [relative, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.scss'].map(ext => `${relative}${ext}`),
      ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].map(ext => `${relative}/index${ext}`)];
    if (/\.[cm]?js$/.test(relative)) {
      const stem = relative.replace(/\.[cm]?js$/, '');
      candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
    }
    return candidates.find(candidate => this.files.has(candidate));
  }

  async resolve(from: string, specifier: string): Promise<Resolution> {
    if (specifier.startsWith('.')) {
      const file = this.resolveCandidate(path.resolve(this.root, path.dirname(from), specifier));
      return file ? { file } : { warning: `${from}: unresolved local import ${specifier}.` };
    }
    const config = await this.configFor(from);
    if (config) {
      for (const [pattern, replacements] of Object.entries(config.paths).sort(([a], [b]) => b.replace('*', '').length - a.replace('*', '').length)) {
        const [prefix, suffix] = pattern.split('*');
        const matches = pattern.includes('*') ? specifier.startsWith(prefix!) && specifier.endsWith(suffix ?? '') && specifier.length >= prefix!.length + (suffix?.length ?? 0) : specifier === pattern;
        if (!matches) continue;
        const wildcard = pattern.includes('*') ? specifier.slice(prefix!.length, suffix ? -suffix.length : undefined) : '';
        for (const replacement of replacements) {
          const file = this.resolveCandidate(path.resolve(config.base, replacement.replace('*', wildcard)));
          if (file) return { file };
        }
        return { warning: `${from}: unresolved configured alias ${specifier}.` };
      }
      if (config.baseUrl) {
        const file = this.resolveCandidate(path.resolve(config.base, specifier));
        if (file) return { file };
      }
    }
    return { external: specifier };
  }
}
