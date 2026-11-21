import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRODUCT_SKILLS,
  buildSkillsSystemPrompt,
  normalizeEnabledSkillIds,
  setSkillEnabled
} from '../src/runtime/skills.mjs';

test('product skills have stable identities and a built-in workspace research skill', () => {
  assert.deepEqual(PRODUCT_SKILLS.map((skill) => skill.id), ['workspace-research']);
  assert.ok(PRODUCT_SKILLS[0].name);
  assert.ok(PRODUCT_SKILLS[0].description);
  assert.ok(PRODUCT_SKILLS[0].instructions);
});

test('persisted skill state drops unknown, duplicate and malformed values', () => {
  assert.deepEqual(normalizeEnabledSkillIds(['unknown', 'workspace-research', 'workspace-research', null]), ['workspace-research']);
  assert.deepEqual(normalizeEnabledSkillIds({}), []);
  assert.deepEqual(normalizeEnabledSkillIds(null), []);
});

test('skill state updates accept only catalog IDs and boolean values', () => {
  assert.deepEqual(setSkillEnabled([], 'workspace-research', true), ['workspace-research']);
  assert.deepEqual(setSkillEnabled(['workspace-research'], 'workspace-research', false), []);
  assert.throws(() => setSkillEnabled([], 'user-provided-skill', true), { code: 'skill_not_found' });
  assert.throws(() => setSkillEnabled([], 'workspace-research', 'true'), { code: 'skill_enabled_invalid' });
});

test('Pi system prompt contains only enabled product skill instructions', () => {
  const disabledPrompt = buildSkillsSystemPrompt([]);
  const enabledPrompt = buildSkillsSystemPrompt(['workspace-research']);

  assert.equal(disabledPrompt, '');
  assert.match(enabledPrompt, /workspace_list/);
  assert.match(enabledPrompt, /workspace_read/);
  assert.match(enabledPrompt, /相对文件路径/);
  assert.doesNotMatch(enabledPrompt, /shell|execute arbitrary/i);
});

