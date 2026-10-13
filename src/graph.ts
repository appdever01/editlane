import { Lang, parse } from '@ast-grep/napi';
import { parse as parseJson, type ParseError } from 'jsonc-parser';
import path from 'node:path';
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
  base: string;
  paths: Record<string, string[]>;
  baseUrl: boolean;
  warnings: string[];
}

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

  private async loadConfig(file: string): Promise<Config> {
    const errors: ParseError[] = [];
    const data = parseJson(await readExact(this.root, file), errors) as { extends?: unknown; compilerOptions?: { baseUrl?: unknown; paths?: unknown } } | undefined;
    const warnings: string[] = [];
    if (errors.length || !data || typeof data !== 'object') throw new Error(`Invalid JSONC configuration: ${file}`);
    if (data.extends) warnings.push(`${file}: inherited tsconfig settings are not resolved in v0.1.`);
    const options = data.compilerOptions ?? {};
    const paths: Record<string, string[]> = {};
    if (options.paths && typeof options.paths === 'object') {
      for (const [key, values] of Object.entries(options.paths)) {
        if (Array.isArray(values) && values.every(value => typeof value === 'string')) paths[key] = values;
      }
    }
    const base = path.resolve(this.root, path.dirname(file), typeof options.baseUrl === 'string' ? options.baseUrl : '.');
    return { file, base, paths, baseUrl: typeof options.baseUrl === 'string', warnings };
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
