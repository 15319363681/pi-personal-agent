import { test, expect } from 'vitest';
import { measureVersions } from '../src/versions.mjs';
test('host_and_actual_Electron_runtime_meet_Node_floor_and_Pi_versions', async () => {
  const v = await measureVersions();
  for (const node of [v.hostNode, v.runtime.node]) {
    const [major, minor] = node.split('.').map(Number);
    expect(major > 22 || (major === 22 && minor >= 19)).toBe(true);
  }
  expect(v.runtime.electron).toBe('45.3.3');
  expect(v.pi).toEqual(['1.5.2', '1.5.2', '1.5.2']);
  expect(v.runtime.type).toBe('utility');
});
