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
    server.registerTool('editlane_focus', {
      description: 'Get exact affected JS/TS files, direct imports, config parents, guidance and required check scripts. Use mode=edit to list consumers/tests for explicit follow-up rather than send their bodies. knownHashes only skips unchanged source already retained by you; omit hashes after context loss. All limits and omissions stay visible. Read affected contracts/tests before editing, then run required checks. No edits or commands are run.',
      inputSchema: z.object({ query: z.string().max(2000).optional(), files: z.array(z.string().max(1000)).max(20).optional(), budgetBytes: z.number().int().min(1).max(2_000_000).optional(), mode: z.enum(['full', 'edit']).optional(), knownHashes: z.record(z.string().max(1000), z.string().regex(/^[a-f0-9]{64}$/)).refine(value => Object.keys(value).length <= 1000).optional(), format: z.enum(['compact', 'plain']).optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, async input => {
      try {
        const packet = await engine.focus({ root, query: input.query ?? '', files: input.files ?? [], budgetBytes: input.budgetBytes ?? 24_000, mode: input.mode ?? 'full', ...(input.knownHashes ? { knownHashes: input.knownHashes } : {}) });
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
