import { execute, repositoryRoot } from './files.js';

export async function metadata(rootInput: string, useRtk: boolean) {
  const root = await repositoryRoot(rootInput);
  const argv = useRtk ? ['git', 'log', '-n', '5'] : ['log', '-n', '5', '--oneline'];
  const { stdout } = await execute(useRtk ? 'rtk' : 'git', argv, { cwd: root, timeout: 10_000, maxBuffer: 1_000_000 });
  return { tool: useRtk ? 'rtk' : 'git', recentHistory: stdout,
    limit: 'Discovery metadata only. Use original git status and git diff for final review. No source or validation output was compressed.' };
}
