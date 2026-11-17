import { readdir } from 'node:fs/promises';

export async function collectWorkspaceReport(workspace, root, goal) {
  const entries = [];
  for (const name of await readdir(root)) {
    if (name === 'agent.sqlite' || name.endsWith('.sqlite-wal') || name.endsWith('.sqlite-shm')) continue;
    try {
      const item = await workspace.read(name);
      if (item.status === 'ok') entries.push(`- ${name} (${item.data.length} bytes)`);
    } catch {}
  }
  return ['# Pi Personal Agent report', '', `Goal: ${goal}`, '', '## Workspace sources', ...(entries.length ? entries : ['- No readable files found'])].join('\n') + '\n';
}
