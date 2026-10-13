import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const execute = promisify(execFile);
export const codePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
export const ignoredGlobs = ['!.git', '!node_modules', '!dist', '!build', '!coverage', '!.editlane', '!.openai', '!.local-notes'];

export function isPrivate(file: string): boolean {
  return file.split(/[\\/]/).some(part => /^\.env(?:\.|$)/i.test(part) || /^(?:\.git|\.openai|\.editlane|\.local-notes|node_modules)$/.test(part))
    || /(?:\.(?:pem|key|p12|pfx)|credentials\.json|secrets?(?:\.local)?\.[^/]+)$/i.test(file);
}

export async function repositoryRoot(input: string): Promise<string> {
  const root = await realpath(input);
  if (!(await stat(root)).isDirectory()) throw new Error('The repository root must be a directory.');
  return root;
}

export function resolveInside(root: string, file: string): string {
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the repository or is not a file: ${file}`);
  }
  return absolute;
}

export function relativePath(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/');
}

export async function readExact(root: string, file: string, maxBytes = 512_000): Promise<string> {
  const absolute = resolveInside(root, file);
  if (isPrivate(file)) throw new Error(`Private file excluded: ${file}`);
  if (await realpath(absolute) !== absolute) throw new Error(`Symlinks are excluded: ${file}`);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Not a regular file: ${file}`);
    if (info.size > maxBytes) throw new Error(`File exceeds the ${maxBytes}-byte read limit: ${file}`);
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw new Error(`File grew beyond the read limit: ${file}`);
    if (bytes.includes(0)) throw new Error(`Binary file excluded: ${file}`);
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return source;
  } finally {
    await handle.close();
  }
}

export function digest(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

export async function inventory(root: string): Promise<string[]> {
  try {
    const { stdout } = await execute('rg', ['--files', '--hidden', '--no-require-git', '-0', ...ignoredGlobs.flatMap(glob => ['-g', glob])], {
      cwd: root, maxBuffer: 8_000_000, timeout: 15_000,
    });
    return stdout.split('\0').filter(file => file && !isPrivate(file)).sort();
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return [];
    throw new Error('File discovery failed. Install ripgrep (rg) and check repository access.', { cause: error });
  }
}

export async function reverseCandidates(root: string, anchors: string[]): Promise<string[]> {
  const needles = [...new Set(anchors.map(file => path.basename(file).replace(/\.[^.]+$/, '')).filter(Boolean))];
  if (!needles.length) return [];
  try {
    const { stdout } = await execute('rg', ['-l', '-0', '-F', '--hidden', '--no-require-git', '-g', '*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}',
      ...ignoredGlobs.flatMap(glob => ['-g', glob]), ...needles.flatMap(needle => ['-e', needle]), '--', '.'], {
      cwd: root, maxBuffer: 8_000_000, timeout: 15_000,
    });
    return stdout.split('\0').filter(Boolean).map(file => file.replace(/^\.\//, '')).sort();
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return [];
    throw new Error('Consumer search failed; no complete context packet was produced.', { cause: error });
  }
}
