import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const eventSchema = z.object({
  timestamp: z.iso.datetime({ offset: true }),
  kind: z.enum(['start', 'read', 'search', 'context', 'edit', 'check', 'command']),
  key: z.string().min(1).max(4000),
  fingerprint: z.string().max(128).optional(),
  durationMs: z.number().nonnegative().optional(),
  bytes: z.number().int().nonnegative().optional(),
  exitCode: z.number().int().optional(),
  signal: z.string().optional(),
}).strict();

export type TraceEvent = z.infer<typeof eventSchema>;

export async function readJournal(file: string): Promise<TraceEvent[]> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 10_000_000) throw new Error('Journal must be a regular file of at most 10 MB.');
    const source = await handle.readFile({ encoding: 'utf8' });
    const lines = source.split('\n').filter(line => line.trim());
    return lines.map((line, index) => {
      try { return eventSchema.parse(JSON.parse(line)); }
      catch { throw new Error(`Invalid normalized trace event on line ${index + 1}.`); }
    });
  } finally { await handle.close(); }
}

export async function appendEvent(file: string, input: TraceEvent): Promise<void> {
  const event = eventSchema.parse(input);
  const line = `${JSON.stringify(event)}\n`;
  await mkdir(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Journal is not a regular file.');
    if (info.size + Buffer.byteLength(line) > 10_000_000) throw new Error('Journal is full; start a new session file.');
    if ((info.mode & 0o077) !== 0) throw new Error('Journal permissions must be private (chmod 600).');
    await handle.writeFile(line);
  } finally { await handle.close(); }
}

export function auditEvents(inputs: TraceEvent[]) {
  const events = inputs.map(input => eventSchema.parse(input));
  for (let index = 1; index < events.length; index++) {
    if (Date.parse(events[index]!.timestamp) < Date.parse(events[index - 1]!.timestamp)) throw new Error('Trace timestamps must be in recorded order.');
  }
  const firstEdit = events.findIndex(event => event.kind === 'edit');
  const before = firstEdit < 0 ? events : events.slice(0, firstEdit);
  const seen = new Map<string, string>();
  const repeats: { index: number; kind: string; key: string; fingerprint: string }[] = [];
  let unverifiableRepeats = 0;
  const observed = new Set<string>();
  for (const [index, event] of before.entries()) {
    if (!['read', 'search', 'context'].includes(event.kind)) continue;
    const key = `${event.kind}\0${event.key}`;
    if (event.fingerprint && seen.get(key) === event.fingerprint) repeats.push({ index, kind: event.kind, key: event.key, fingerprint: event.fingerprint });
    else if (!event.fingerprint && observed.has(key)) unverifiableRepeats++;
    if (event.fingerprint) seen.set(key, event.fingerprint);
    else seen.delete(key);
    observed.add(key);
  }
  const checks = events.filter(event => event.kind === 'check');
  return {
    schemaVersion: 1,
    totalEvents: events.length,
    firstEditMs: firstEdit < 0 || !events[0] ? null : Date.parse(events[firstEdit]!.timestamp) - Date.parse(events[0].timestamp),
    callsBeforeFirstEdit: before.filter(event => ['read', 'search', 'context', 'command'].includes(event.kind)).length,
    repeatedUnchangedCalls: repeats,
    repeatedCallsWithoutFingerprint: unverifiableRepeats,
    observedReadBytes: before.reduce((total, event) => total + (['read', 'search', 'context'].includes(event.kind) ? event.bytes ?? 0 : 0), 0),
    recordedChecks: checks.map(event => ({ key: event.key, exitCode: event.exitCode ?? null, signal: event.signal ?? null })),
    failedChecks: checks.filter(event => event.exitCode !== undefined && event.exitCode !== 0 || event.signal).map(event => event.key),
    limits: [
      'Only events present in this normalized journal are measured. Native client tools are not intercepted.',
      'A repeated unchanged call is a candidate for reuse, not proof that the call was unnecessary.',
      'Fingerprints must cover source content, or the full search scope and query, to make reuse safe.',
      'Recorded successful checks do not prove that every required check was run. Bytes are not billed tokens.',
    ],
  };
}
