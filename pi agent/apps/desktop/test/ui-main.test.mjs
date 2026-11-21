import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('desktop UI refresh requests the public MCP server list', async () => {
  const source = await readFile(fileURLToPath(new URL('../src/ui/main.tsx', import.meta.url)), 'utf8');
  const refresh = source.match(/const refresh = async \(\) => \{([\s\S]*?)\n  \};/)?.[1] ?? '';
  assert.ok(refresh.includes("window.piAgent.request('mcp.servers.list')"), 'refresh must load saved MCP servers');
});


test('desktop plugin review binds confirmation to a tested version and exposes management controls', async () => {
  const main = await readFile(fileURLToPath(new URL('../src/ui/main.tsx', import.meta.url)), 'utf8');
  assert.match(main, /<PluginPanel/);
  const panel = await readFile(fileURLToPath(new URL('../src/ui/PluginPanel.tsx', import.meta.url)), 'utf8');
  for (const method of ['plugins.list', 'plugins.get', 'plugins.test', 'plugins.set_enabled', 'plugins.remove']) assert.ok(panel.includes(method), method);
  assert.match(panel, /confirm: true/);
  assert.match(panel, /version: detail.version/);
  assert.match(panel, /detail.testStatus !== 'passed'/);
  assert.match(panel, /type="checkbox"/);
  assert.match(panel, /detail.definition.source/);
  assert.match(panel, /detail.definition.inputSchema/);
  assert.match(panel, /detail.definition.tests/);
  assert.match(panel, /detail.tests.map/);
  assert.match(panel, /role="alertdialog"/);
});


test('document output review exposes exact content, provenance and a version-bound confirmation', async () => {
  const main = await readFile(fileURLToPath(new URL('../src/ui/main.tsx', import.meta.url)), 'utf8');
  assert.match(main, /<ArtifactPanel/);
  assert.match(main, /<DocumentSources/);
  const panel = await readFile(fileURLToPath(new URL('../src/ui/ArtifactPanel.tsx', import.meta.url)), 'utf8');
  for (const method of ['artifacts.list', 'artifacts.get', 'artifacts.create']) assert.ok(panel.includes(method), method);
  assert.match(panel, /sha256: detail.sha256/);
  assert.match(panel, /confirm: true/);
  assert.match(panel, /type="checkbox"/);
  assert.match(panel, /detail.content/);
  assert.match(panel, /role="alert"/);
});


test('desktop model management exposes profile lifecycle with revision-bound connection status', async () => {
  const main = await readFile(fileURLToPath(new URL('../src/ui/main.tsx', import.meta.url)), 'utf8');
  assert.match(main, /<ModelSettingsPanel/);
  assert.match(main, /settingId: activeModel/);
  const panel = await readFile(fileURLToPath(new URL('../src/ui/ModelSettingsPanel.tsx', import.meta.url)), 'utf8');
  for (const method of ['settings.get', 'settings.update', 'settings.test', 'settings.activate', 'settings.remove']) assert.ok(panel.includes(method), method);
  assert.match(panel, /role="alertdialog"/);
  assert.match(panel, /confirm: true/);
  assert.match(panel, /revision/);
  assert.match(panel, /autoComplete="new-password"/);
});
