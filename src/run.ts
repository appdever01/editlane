import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { appendEvent } from './trace.js';

export async function runRecorded(argv: string[], journal: string, cwd: string, kind: 'command' | 'check'): Promise<number> {
  if (!argv[0]) throw new Error('Pass an executable and its arguments after --.');
  const key = JSON.stringify(argv);
  await appendEvent(journal, { timestamp: new Date().toISOString(), kind: 'start', key });
  const started = performance.now();
  const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['inherit', 'pipe', 'pipe'], shell: false });
  let bytes = 0;
  child.stdout.on('data', (data: Buffer) => { bytes += data.length; if (!process.stdout.write(data)) child.stdout.pause(); });
  child.stderr.on('data', (data: Buffer) => { bytes += data.length; if (!process.stderr.write(data)) child.stderr.pause(); });
  const resumeOut = () => child.stdout.resume();
  const resumeErr = () => child.stderr.resume();
  process.stdout.on('drain', resumeOut);
  process.stderr.on('drain', resumeErr);
  const forwardInterrupt = () => child.kill('SIGINT');
  const forwardTerminate = () => child.kill('SIGTERM');
  process.on('SIGINT', forwardInterrupt);
  process.on('SIGTERM', forwardTerminate);
  let code: number | null = null;
  let signal: NodeJS.Signals | null = null;
  try {
    [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
    });
  } catch (error) {
    await appendEvent(journal, { timestamp: new Date().toISOString(), kind, key, bytes,
      durationMs: Math.round(performance.now() - started), exitCode: 1, signal: 'spawn_error' });
    throw error;
  } finally {
    process.off('SIGINT', forwardInterrupt);
    process.off('SIGTERM', forwardTerminate);
    process.stdout.off('drain', resumeOut);
    process.stderr.off('drain', resumeErr);
  }
  await appendEvent(journal, { timestamp: new Date().toISOString(), kind, key, bytes, durationMs: Math.round(performance.now() - started),
    ...(code !== null ? { exitCode: code } : {}), ...(signal ? { signal } : {}) });
  return code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
}
