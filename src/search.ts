import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute, readExact, relativePath, resolveInside } from './files.js';

const searchable = /\.(?:[cm]?[jt]s|[jt]sx|py|go|rs|java|c|h|cc|cpp|hpp|cs|rb|php|swift|kt|kts|scala|sh|bash|zsh|lua|sql|vue|svelte)$/i;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

async function searchOutput(snapshot: string, query: string, offline: boolean): Promise<string> {
  try {
    const { stdout } = await execute(process.env.EDITLANE_SEMBLE_BIN ?? 'semble', ['search', '--format', 'json', '--top-k', '3', '--max-snippet-lines', '0', '--', query, snapshot], {
      cwd: snapshot, timeout: offline ? 30_000 : 120_000, maxBuffer: 2_000_000,
      env: { ...process.env, HF_HUB_OFFLINE: offline ? '1' : '0', SEMBLE_CACHE_LOCATION: path.join(snapshot, '.cache'), SEMBLE_INDEX_WORKERS: '0', TOKENIZERS_PARALLELISM: 'false', OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2', MKL_NUM_THREADS: '2' },
    });
    return stdout;
  } catch (error) {
    const failure = error as { code?: unknown; signal?: unknown };
    throw new Error(`Optional Semble lookup failed (${failure.signal ?? failure.code ?? 'unknown status'}). Install semble==0.6.2, configure EDITLANE_SEMBLE_BIN if needed and run editlane prepare-search. No partial packet was returned.`);
  }
}

export async function prepareSearch() {
  const snapshot = await mkdtemp(path.join(tmpdir(), 'editlane-prepare-'));
  try {
    await writeFile(path.join(snapshot, 'ready.py'), 'def ready(): return True\n', { mode: 0o600 });
    const stdout = await searchOutput(snapshot, 'ready', false);
    let result: unknown;
    try { result = JSON.parse(stdout); } catch { throw new Error('Semble preparation returned invalid JSON.'); }
    if (!record(result) || !Array.isArray(result.results) || !result.results.some(entry => record(entry) && entry.file_path === 'ready.py')) throw new Error('Semble preparation did not verify the local model.');
    return { prepared: true, fixture: 'one harmless generated Python file', limit: 'Model setup may download public embeddings. Repository searches run offline; this does not verify coding quality.' };
  } finally { await rm(snapshot, { recursive: true, force: true }); }
}

export async function semanticTargets(root: string, files: string[], query: string) {
  if (!query.trim() || query.length > 2000) throw new Error('Semble search needs a non-empty query of at most 2000 characters.');
  const eligible = files.filter(file => searchable.test(file));
  if (eligible.length > 5000) throw new Error('Semble snapshot exceeds 5000 source files. Narrow the root or pass explicit affected files.');
  const snapshot = await mkdtemp(path.join(tmpdir(), 'editlane-search-'));
  const copied = new Set<string>();
  const omitted: { path: string; reason: string }[] = [];
  let bytes = 0;
  try {
    for (const file of eligible) {
      let source: string;
      try { source = await readExact(root, file); } catch (error) {
        omitted.push({ path: file, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
      bytes += Buffer.byteLength(source);
      if (bytes > 32_000_000) throw new Error('Semble snapshot exceeds 32 MB. Narrow the root or pass explicit affected files.');
      const target = resolveInside(snapshot, file);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, source, { mode: 0o600 });
      copied.add(file);
    }
    if (!copied.size) throw new Error('No permitted readable source is available for Semble search. Pass an explicit affected file.');
    const stdout = await searchOutput(snapshot, query, true);
    let result: unknown;
    try { result = JSON.parse(stdout); } catch { throw new Error('Semble returned invalid JSON; no source packet was returned.'); }
    if (!record(result) || !Array.isArray(result.results) || result.results.length > 3) throw new Error('Semble returned an invalid result list; no source packet was returned.');
    const anchors: string[] = [];
    for (const entry of result.results) {
      if (!record(entry) || typeof entry.file_path !== 'string') throw new Error('Semble returned an invalid target; no source packet was returned.');
      if (path.isAbsolute(entry.file_path)) throw new Error('Semble returned an absolute target; no source packet was returned.');
      const file = relativePath(snapshot, resolveInside(snapshot, entry.file_path));
      if (!copied.has(file)) throw new Error('Semble returned a target outside the guarded snapshot; no source packet was returned.');
      if (!anchors.includes(file)) anchors.push(file);
    }
    if (!anchors.length) throw new Error('Semble found no candidate targets. Pass an explicit affected file.');
    return { anchors, omitted, warnings: ['Targets were selected by optional Semble search of a fresh guarded snapshot. Confirm relevance before editing; dependencies and tests can require further inspection. Returned source is read from the current repository, not cached snippets.'] };
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
}
