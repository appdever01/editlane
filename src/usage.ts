import path from 'node:path';
import { readExact, repositoryRoot } from './files.js';

export type NativeClient = 'claude' | 'codex' | 'cursor';
export interface NativeUsage {
  client: NativeClient;
  terminalEvents: number;
  complete: boolean;
  inputTotal: number | null;
  uncachedInput: number | null;
  cacheReadInput: number | null;
  cacheWriteInput: number | null;
  output: number | null;
  reasoningOutput: number | null;
  warnings: string[];
}

type Event = Record<string, unknown>;
const record = (value: unknown): value is Event => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const total = (values: (number | null)[]): number | null => {
  if (!values.length || values.some(value => value === null)) return null;
  return count(values.reduce<number>((sum, value) => sum + value!, 0));
};

export function analyzeNativeUsage(input: unknown[], client: NativeClient): NativeUsage {
  if (!['claude', 'codex', 'cursor'].includes(client)) throw new Error('Choose claude, codex or cursor for native usage normalization.');
  const events = input.filter(record).map(event => record(event.event) ? event.event : event);
  const terminal = events.filter(event => client === 'codex' ? event.type === 'turn.completed' : event.type === 'result');
  const usages = terminal.map(event => record(event.usage) ? event.usage : {});
  const read = usages.map(usage => count(usage[client === 'claude' ? 'cache_read_input_tokens' : client === 'codex' ? 'cached_input_tokens' : 'cacheReadTokens']));
  const write = usages.map(usage => count(usage[client === 'claude' ? 'cache_creation_input_tokens' : client === 'codex' ? 'cache_write_input_tokens' : 'cacheWriteTokens']));
  const direct = usages.map(usage => count(usage[client === 'cursor' ? 'inputTokens' : 'input_tokens']));
  const aggregate = client === 'codex' ? direct : direct.map((value, index) => total([value, read[index]!, write[index]!]));
  const uncached = client === 'codex' ? direct.map((value, index) => value !== null && read[index] !== null && read[index] !== undefined && read[index]! <= value ? value - read[index]! : null) : direct;
  const output = usages.map(usage => count(usage[client === 'cursor' ? 'outputTokens' : 'output_tokens']));
  const reasoning = usages.map(usage => count(usage[client === 'codex' ? 'reasoning_output_tokens' : client === 'cursor' ? 'reasoningTokens' : 'reasoning_output_tokens']));
  const invalidCache = client === 'codex' && direct.some((value, index) => value !== null && read[index] !== null && read[index] !== undefined && read[index]! > value);
  const invalidReasoning = reasoning.some((value, index) => value !== null && output[index] !== null && output[index] !== undefined && value > output[index]!);
  const failed = events.some(event => ['turn.failed', 'error'].includes(String(event.type)) || event.type === 'result' && (event.is_error === true || event.subtype !== 'success'));
  const warnings = ['Native reported input includes repeated cached context; these counts are not a billing invoice or proof of code quality. Reasoning is a subset of output, never added twice.'];
  if (!terminal.length) warnings.push('No completed native usage event. Missing counts remain unknown.');
  if (aggregate.some(value => value === null)) warnings.push('An input category was missing or invalid; total input is unknown.');
  if (output.some(value => value === null)) warnings.push('An output count was missing or invalid; total output is unknown.');
  if (invalidCache) warnings.push('Cached input exceeds total input; uncached input is unknown.');
  if (invalidReasoning) warnings.push('Reasoning exceeds output; the reported usage is inconsistent.');
  if (terminal.length && total(aggregate) === null && aggregate.every(value => value !== null)) warnings.push('Summed input exceeds the safe integer range; total input is unknown.');
  if (failed) warnings.push('The trace contains a native failure; terminal counts alone do not prove completion.');
  return { client, terminalEvents: terminal.length, complete: terminal.length > 0 && !failed && !invalidCache && !invalidReasoning && total(aggregate) !== null && total(output) !== null, inputTotal: total(aggregate), uncachedInput: total(uncached), cacheReadInput: total(read), cacheWriteInput: total(write), output: total(output), reasoningOutput: total(reasoning), warnings };
}

export async function nativeUsage(fileInput: string, client: NativeClient): Promise<NativeUsage> {
  const absolute = path.resolve(fileInput);
  const root = await repositoryRoot(path.dirname(absolute));
  const source = await readExact(root, path.basename(absolute), 10_000_000);
  const input = source.split('\n').filter(line => line.trim()).map((line, index) => {
    try { return JSON.parse(line) as unknown; }
    catch { throw new Error(`Invalid native JSONL event at non-empty line ${index + 1}. No partial token total was returned.`); }
  });
  return analyzeNativeUsage(input, client);
}
