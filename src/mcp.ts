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
      description: 'Get whole affected JS/TS files, direct imports, consumers, nearby tests, scoped guidance and check scripts in one call. Omitted context and graph limits are explicit; no edits or commands are run.',
      inputSchema: z.object({ query: z.string().max(2000).optional(), files: z.array(z.string().max(1000)).max(20).optional(), budgetBytes: z.number().int().min(1).max(2_000_000).optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, async input => {
      try {
        const packet = await engine.focus({ root, query: input.query ?? '', files: input.files ?? [], budgetBytes: input.budgetBytes ?? 24_000 });
        return { content: [{ type: 'text' as const, text: renderPacket(packet) }] };
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
