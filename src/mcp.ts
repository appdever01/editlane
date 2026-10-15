import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { realpath } from 'node:fs/promises';
import { FocusEngine, renderPacket } from './context.js';
import { isPrivate, relativePath, repositoryRoot, resolveInside } from './files.js';
import { auditEvents, readJournal } from './trace.js';

export async function serve(rootInput: string): Promise<void> {
  const root = await repositoryRoot(rootInput);
  const engine = new FocusEngine();
  serveStdio(() => {
    const server = new McpServer({ name: 'editlane', version: '0.1.0' });
    const retained = new Map<string, string>();
    let epoch = Symbol();
    server.registerTool('editlane_focus', {
      description: `Bound to ${JSON.stringify(root)}; verify the returned root. Use native reads for small known-file tasks. For cross-file discovery, mode=edit returns exact JS/TS targets, direct imports/configs, guidance and not_run package checks; consumer/test bodies are deferred. mode=read returns only explicit files, their guidance and check commands, without expanding another graph: use it for justified follow-ups. Default full mode preserves graph behavior. Batch needed contracts; do not retrieve every candidate. reuseRetained=true skips only freshly hash-verified source already returned and still in your context. Omit it and knownHashes after context loss. Optional search=semble locates unknown targets with a prepared local CLI/model. Other languages need manual dependency/check inspection. Omissions and limits remain visible. No edits or checks run.`,
      inputSchema: z.object({ query: z.string().max(2000).optional(), files: z.array(z.string().max(1000)).max(20).optional(), budgetBytes: z.number().int().min(1).max(2_000_000).optional(), mode: z.enum(['full', 'edit', 'read']).optional(), search: z.enum(['filename', 'semble']).optional(), reuseRetained: z.boolean().optional(), knownHashes: z.record(z.string().max(1000), z.string().regex(/^[a-f0-9]{64}$/)).refine(value => Object.keys(value).length <= 1000).optional(), format: z.enum(['compact', 'plain']).optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, async input => {
      try {
        if (!input.reuseRetained) { retained.clear(); epoch = Symbol(); }
        const requestEpoch = epoch;
        const knownHashes: Record<string, string> = Object.assign(Object.create(null), input.knownHashes ?? {});
        let remaining = 1000 - Object.keys(knownHashes).length;
        if (input.reuseRetained) for (const [file, hash] of retained) {
          if (remaining > 0 && !Object.hasOwn(knownHashes, file)) { knownHashes[file] = hash; remaining--; }
        }
        const packet = await engine.focus({ root, query: input.query ?? '', files: input.files ?? [], budgetBytes: input.budgetBytes ?? 24_000, mode: input.mode ?? 'full', search: input.search ?? 'filename', knownHashes });
        for (const file of requestEpoch === epoch ? packet.files.filter(file => file.role !== 'instruction') : []) {
          retained.delete(file.path);
          if (retained.size >= 1000) retained.delete(retained.keys().next().value!);
          retained.set(file.path, file.sha256);
        }
        return { content: [{ type: 'text' as const, text: renderPacket(packet, input.format ?? 'compact') }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] };
      }
    });
    server.registerTool('editlane_audit', {
      description: 'Audit an existing normalized local JSONL journal for time to first edit, unchanged repeated calls and recorded failed checks. Does not monitor native client tools or enforce a search cap.',
      inputSchema: z.object({ journal: z.string().max(1000) }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, async ({ journal }) => {
      try {
        const file = relativePath(root, resolveInside(root, journal));
        if (!file.endsWith('.jsonl') || isPrivate(file.replace(/^\.editlane\//, ''))) throw new Error('Only a local normalized .jsonl journal can be audited.');
        if (await realpath(resolveInside(root, file)) !== resolveInside(root, file)) throw new Error('Symlink journals are excluded.');
        return { content: [{ type: 'text' as const, text: JSON.stringify(auditEvents(await readJournal(resolveInside(root, file)))) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] };
      }
    });
    return server;
  });
}
