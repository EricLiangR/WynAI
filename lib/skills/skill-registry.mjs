import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SCOPE_RANK = Object.freeze({ system: 400, dataset: 300, organization: 200, user: 100 });

function normalizedSkill(input = {}) {
  const id = String(input.id || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/i.test(id)) throw new Error(`Skill ID 无效：${id}`);
  const version = String(input.version || '1.0.0').trim();
  return {
    schema: 'wynai.skill/v1',
    id,
    version,
    name: String(input.name || id).trim().slice(0, 120),
    scope: ['system', 'dataset', 'organization', 'user'].includes(input.scope) ? input.scope : 'dataset',
    datasetIds: [...new Set((input.datasetIds || []).map(String).filter(Boolean))].slice(0, 50),
    organizationIds: [...new Set((input.organizationIds || []).map(String).filter(Boolean))].slice(0, 50),
    userIds: [...new Set((input.userIds || []).map(String).filter(Boolean))].slice(0, 50),
    triggers: [...new Set((input.triggers || []).map(value => String(value).trim()).filter(Boolean))].slice(0, 100),
    metrics: Array.isArray(input.metrics) ? input.metrics.slice(0, 100) : [],
    businessEntities: Array.isArray(input.businessEntities) ? input.businessEntities.slice(0, 100).map(entity => ({
      id: String(entity?.id || entity?.name || entity?.field || '').trim().slice(0, 80),
      concept: String(entity?.concept || entity?.id || '').trim().slice(0, 80),
      name: String(entity?.name || entity?.id || '').trim().slice(0, 120),
      field: String(entity?.field || '').trim().slice(0, 200),
      synonyms: [...new Set((entity?.synonyms || []).map(value => String(value).trim()).filter(Boolean))].slice(0, 100),
    })).filter(entity => entity.id && entity.field) : [],
    workflows: Array.isArray(input.workflows) ? input.workflows.slice(0, 50) : [],
    forbidden: [...new Set((input.forbidden || []).map(value => String(value).trim()).filter(Boolean))].slice(0, 100),
    status: ['draft', 'approved', 'retired'].includes(input.status) ? input.status : 'draft',
  };
}

export class SkillRegistry {
  constructor(skills = []) {
    this.skills = new Map();
    skills.forEach(skill => this.register(skill));
  }

  register(skill) {
    const normalized = normalizedSkill(skill);
    this.skills.set(`${normalized.id}@${normalized.version}`, normalized);
    return normalized;
  }

  list() {
    return [...this.skills.values()];
  }

  get(id, version = null) {
    const normalizedId = String(id || '').trim();
    if (version != null) return this.skills.get(`${normalizedId}@${String(version).trim()}`) || null;
    return this.list().filter(skill => skill.id === normalizedId).sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true }))[0] || null;
  }

  versions(id) {
    return this.list().filter(skill => skill.id === String(id || '').trim()).sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true }));
  }

  resolve({ datasetId, organizationId = null, userId = null, question = '' } = {}) {
    const text = String(question).toLowerCase();
    return this.list()
      .filter(skill => skill.status !== 'retired')
      .filter(skill => skill.scope === 'system'
        || (skill.scope === 'dataset' && skill.datasetIds.includes(datasetId))
        || (skill.scope === 'organization' && skill.organizationIds.includes(organizationId))
        || (skill.scope === 'user' && skill.userIds.includes(userId)))
      .map(skill => ({ skill, triggerScore: skill.triggers.filter(trigger => text.includes(trigger.toLowerCase())).length }))
      .filter(item => item.triggerScore > 0 || item.skill.scope === 'system')
      .sort((a, b) => (SCOPE_RANK[b.skill.scope] - SCOPE_RANK[a.skill.scope]) || (b.triggerScore - a.triggerScore) || a.skill.id.localeCompare(b.skill.id))
      .map(item => item.skill);
  }

  detectConflicts(skills = []) {
    const conflicts = [];
    for (let index = 0; index < skills.length; index += 1) {
      for (let otherIndex = index + 1; otherIndex < skills.length; otherIndex += 1) {
        const left = skills[index];
        const right = skills[otherIndex];
        const leftMetrics = new Map((left.metrics || []).map(item => [item.name || item.id, item.definition || item.field]));
        for (const metric of right.metrics || []) {
          const key = metric.name || metric.id;
          if (leftMetrics.has(key) && leftMetrics.get(key) !== (metric.definition || metric.field)) {
            conflicts.push({ metric: key, left: left.id, right: right.id, reason: '同名指标定义冲突' });
          }
        }
      }
    }
    return conflicts;
  }

  resolveForQuestion({ datasetId, organizationId = null, userId = null, question = '' } = {}) {
    const skills = this.resolve({ datasetId, organizationId, userId, question });
    return {
      skills,
      conflicts: this.detectConflicts(skills),
      refs: skills.map(skill => `${skill.id}@${skill.version}`),
    };
  }
}

export { normalizedSkill };

export async function loadSkillsFromDirectory(directory) {
  const registry = new SkillRegistry();
  async function visit(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.toLowerCase() === 'skill.json') {
        const source = await readFile(path, 'utf8');
        registry.register(JSON.parse(source));
      }
    }
  }
  await visit(directory);
  return registry;
}
