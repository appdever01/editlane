import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { digest, inventory, readExact, repositoryRoot, relativePath, resolveInside } from './files.js';

export async function connection(rootInput: string) {
  const root = await repositoryRoot(rootInput);
  const args = [fileURLToPath(new URL('./cli.js', import.meta.url)), 'serve', '--root', root];
  return {
    root,
    mcp: { mcpServers: { editlane: { command: process.execPath, args } } },
    codex: `[mcp_servers.editlane]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(args)}\nenabled = true`,
    next: 'Merge only the editlane entry into your client configuration, preserve other settings, and start a new client session. The server is pinned to this root; no workspace placeholder is needed.',
    compatibility: 'Any client with MCP stdio support can use the mcp entry. Other agents can use the focus CLI; this command does not change settings or grant permissions.',
  };
}

export async function doctor(rootInput: string, targets: string[]) {
  const config = await connection(rootInput);
  const available = await inventory(config.root);
  const files = targets.length ? targets.map(file => relativePath(config.root, resolveInside(config.root, file))) : available.includes('package.json') ? ['package.json'] : available.slice(0, 1);
  if (!files.length) throw new Error('No discoverable source to verify. Supply --file with an allowed project file.');
  if (files.some(file => !available.includes(file))) throw new Error('The doctor target is missing, ignored, private or outside discovery.');
  const expected = await Promise.all(files.map(async file => ({ file, source: await readExact(config.root, file) })));
  const transport = new StdioClientTransport({ ...config.mcp.mcpServers.editlane, stderr: 'pipe' });
  const client = new Client({ name: 'editlane-doctor', version: '0.1.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const result = await client.callTool({ name: 'editlane_focus', arguments: { files, budgetBytes: 2_000_000, format: 'plain' } }, { timeout: 15_000 });
    const text = result.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '';
    if (result.isError || expected.some(({ file, source }) => !text.includes(`FILE ${JSON.stringify(file)} (target, sha256=${digest(source)}, bytes=${Buffer.byteLength(source)})\n${source}\nEND FILE ${JSON.stringify(file)}`))) throw new Error('Stdio connection did not return the exact requested source. Check the root and read limits.');
    const refused = await client.callTool({ name: 'editlane_focus', arguments: { files: ['../editlane-outside-root-probe'] } });
    if (!refused.isError) throw new Error('Outside-root refusal failed.');
    return { root: config.root, transport: 'stdio', connected: true, exactFiles: files, outsideRootRejected: true, tools: tools.tools.map(tool => tool.name), limit: 'Local MCP transport verified. Client authentication and provider network reliability require a separate native-client run.' };
  } finally {
    await client.close();
  }
}
