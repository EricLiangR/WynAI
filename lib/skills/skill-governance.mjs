import { randomUUID } from 'node:crypto';
import { normalizedSkill } from './skill-registry.mjs';

function actorValue(value, fallback = 'system') {
  return String(value || fallback).trim().slice(0, 120) || fallback;
}

function auditId() {
  return `skill-audit-${randomUUID()}`;
}

/** Version and lifecycle controls for locally managed Skills. */
export class SkillGovernanceService {
  constructor({ registry, overridePersistence = null, auditPersistence = null } = {}) {
    if (!registry) throw new Error('Skill Governance 需要 SkillRegistry');
    this.registry = registry;
    this.overridePersistence = overridePersistence;
    this.auditPersistence = auditPersistence;
    this.audit = [];
  }

  async init() {
    if (this.overridePersistence) {
      const overrides = (await this.overridePersistence.init()).sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
      for (const item of overrides) {
        if (item?.kind === 'skill-override' && item.skill) this.registry.register(item.skill);
      }
    }
    if (this.auditPersistence) this.audit = (await this.auditPersistence.init()).slice(0, 1000);
    return this;
  }

  list() {
    return this.registry.list();
  }

  versions(id) {
    return this.registry.versions(id);
  }

  async record(action, skill, { actor = 'system', reason = '' } = {}) {
    const event = {
      id: auditId(),
      schema: 'wynai.skill-audit/v1',
      kind: 'skill-audit',
      action,
      skillRef: skill ? `${skill.id}@${skill.version}` : null,
      status: skill?.status || null,
      actor: actorValue(actor),
      reason: String(reason || '').trim().slice(0, 500),
      at: new Date().toISOString(),
    };
    this.audit.unshift(event);
    this.audit = this.audit.slice(0, 1000);
    if (this.auditPersistence) await this.auditPersistence.save(event);
    return event;
  }

  async recordResolution({ datasetId, organizationId = null, userId = null, question = '', refs = [], conflicts = [] } = {}) {
    const event = {
      id: auditId(),
      schema: 'wynai.skill-runtime/v1',
      kind: 'skill-runtime',
      action: 'skill.resolved',
      datasetId: String(datasetId || '').slice(0, 100) || null,
      organizationId: organizationId ? String(organizationId).slice(0, 100) : null,
      userId: userId ? String(userId).slice(0, 100) : null,
      question: String(question || '').slice(0, 500),
      skillRefs: [...new Set((refs || []).map(String).filter(Boolean))].slice(0, 32),
      conflictCount: Array.isArray(conflicts) ? conflicts.length : 0,
      at: new Date().toISOString(),
    };
    this.audit.unshift(event);
    this.audit = this.audit.slice(0, 1000);
    if (this.auditPersistence) await this.auditPersistence.save(event);
    return event;
  }

  async saveOverride(skill, options = {}) {
    const normalized = normalizedSkill(skill);
    this.registry.register(normalized);
    if (this.overridePersistence) {
      await this.overridePersistence.save({
        id: `skill-override-${randomUUID()}`,
        kind: 'skill-override',
        schema: 'wynai.skill-override/v1',
        skill: normalized,
        updatedAt: new Date().toISOString(),
      });
    }
    const event = await this.record(options.action || 'skill.updated', normalized, options);
    return { skill: normalized, audit: event };
  }

  async setStatus(id, version, status, options = {}) {
    const current = this.registry.get(id, version);
    if (!current) throw Object.assign(new Error('Skill 版本不存在'), { status: 404 });
    if (!['draft', 'approved', 'retired'].includes(status)) throw Object.assign(new Error('Skill 状态无效'), { status: 400 });
    return this.saveOverride({ ...current, status }, { ...options, action: `skill.${status}` });
  }

  async rollback(id, version, options = {}) {
    const target = this.registry.get(id, version);
    if (!target) throw Object.assign(new Error('回滚目标 Skill 版本不存在'), { status: 404 });
    const versions = this.registry.versions(id);
    for (const item of versions) {
      if (item.version === target.version) continue;
      if (item.status === 'approved') await this.saveOverride({ ...item, status: 'retired' }, { ...options, action: 'skill.rollback.retire' });
    }
    return this.saveOverride({ ...target, status: 'approved' }, { ...options, action: 'skill.rollback.approve' });
  }

  auditLog({ limit = 100 } = {}) {
    return this.audit.slice(0, Math.max(1, Math.min(1000, Number(limit) || 100)));
  }
}
