import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizedSkill } from '../lib/skills/skill-registry.mjs';

test('领域 Skill 诊断配置包含证据、风险、行动和边界', async () => {
  for (const path of ['skills/sales/skill.json', 'skills/laboratory/skill.json', 'skills/retail/skill.json']) {
    const skill = normalizedSkill(JSON.parse(await readFile(path, 'utf8')));
    assert.ok(skill.diagnostics.length, path);
    assert.ok(skill.diagnostics[0].requiredEvidence.length, path);
    assert.ok(skill.diagnostics[0].riskRules.length, path);
    assert.ok(skill.diagnostics[0].playbook.length, path);
    assert.ok(skill.evaluationRefs.length, path);
  }
});
