export const PRODUCT_SKILLS = Object.freeze([
  Object.freeze({
    id: 'workspace-research',
    name: '工作区调研',
    description: '按用户问题检查已授权工作区中的相关文本，并在回答中标明相对路径。',
    instructions: [
      '用户已授权工作区后，先用 workspace_list 检查相关目录，再按需用 workspace_read 读取少量相关文本。',
      '只依据实际工具结果总结，并在引用工作区信息时标注相对文件路径。',
      '遇到未授权路径、超限或不支持的文件时，说明当前限制，不推断未读取的内容。'
    ].join(' ')
  })
]);

const productSkillIds = new Set(PRODUCT_SKILLS.map((skill) => skill.id));

export function normalizeEnabledSkillIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id) => typeof id === 'string' && productSkillIds.has(id)))];
}

export function setSkillEnabled(enabledIds, id, enabled) {
  if (!productSkillIds.has(id)) throw Object.assign(new Error('Skill is not provided by the product'), { code: 'skill_not_found' });
  if (typeof enabled !== 'boolean') throw Object.assign(new Error('Skill enabled state must be boolean'), { code: 'skill_enabled_invalid' });
  const next = new Set(normalizeEnabledSkillIds(enabledIds));
  if (enabled) next.add(id);
  else next.delete(id);
  return [...next];
}

export function buildSkillsSystemPrompt(enabledIds) {
  const enabled = new Set(normalizeEnabledSkillIds(enabledIds));
  return PRODUCT_SKILLS.filter((skill) => enabled.has(skill.id))
    .map((skill) => `## ${skill.name}\n${skill.instructions}`)
    .join('\n\n');
}

export function listProductSkills(enabledIds) {
  const enabled = new Set(normalizeEnabledSkillIds(enabledIds));
  return PRODUCT_SKILLS.map(({ id, name, description }) => ({ id, name, description, enabled: enabled.has(id) }));
}
