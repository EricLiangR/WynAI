function text(value) {
  return String(value || '').trim();
}

function fieldEntry(field) {
  return {
    fieldRef: text(field?.name),
    displayName: text(field?.displayName || field?.name),
    type: field?.type || null,
    rawType: field?.rawType || null,
    role: field?.role || null,
    description: text(field?.description || field?.semanticDescription),
    aliases: [...new Set((field?.synonyms || []).map(text).filter(Boolean))],
  };
}

function skillEntry(skill) {
  return {
    id: text(skill?.id),
    version: text(skill?.version),
    name: text(skill?.name || skill?.id),
    defaultCalendar: text(skill?.defaultCalendar),
    calendarPolicy: skill?.calendarPolicy || null,
    fieldSemantics: skill?.fieldSemantics || [],
    metrics: skill?.metrics || [],
    businessEntities: skill?.businessEntities || [],
    temporalSemantics: skill?.temporalSemantics || [],
    relativeTemporalSemantics: skill?.relativeTemporalSemantics || [],
    valueMappings: skill?.valueMappings || [],
    workflows: skill?.workflows || [],
    assumptions: skill?.assumptions || [],
    forbidden: skill?.forbidden || [],
  };
}

export function buildSemanticCatalog({ metadata = null, skills = [] } = {}) {
  return {
    schema: 'wynai.semantic-catalog/v1',
    dataset: metadata ? { id: metadata.id || null, revision: metadata.revision ?? null, name: metadata.name || null, description: metadata.description || metadata.semanticDescription || '' } : null,
    fields: (metadata?.fields || []).map(fieldEntry).filter(field => field.fieldRef),
    skills: skills.map(skillEntry).filter(skill => skill.id),
  };
}

export function resolveApplicableSkills(skillRegistry, { datasetId, organizationId = null, userId = null } = {}) {
  if (!skillRegistry || typeof skillRegistry.list !== 'function') return { skills: [], conflicts: [], refs: [] };
  const skills = skillRegistry.list()
    .filter(skill => skill.status === 'approved')
    .filter(skill => skill.scope === 'system'
      || (skill.scope === 'dataset' && skill.datasetIds.includes(datasetId))
      || (skill.scope === 'organization' && skill.organizationIds.includes(organizationId))
      || (skill.scope === 'user' && skill.userIds.includes(userId)))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)) || String(right.version).localeCompare(String(left.version), undefined, { numeric: true }))
    .slice(0, 32);
  return {
    skills,
    conflicts: typeof skillRegistry.detectConflicts === 'function' ? skillRegistry.detectConflicts(skills) : [],
    refs: skills.map(skill => `${skill.id}@${skill.version}`),
  };
}

export function validateSemanticMapping({ intent = null, metadata = null, skills = [] } = {}) {
  const fields = new Set((metadata?.fields || []).map(field => field.name));
  const skillRefs = new Set(skills.map(skill => `${skill.id}@${skill.version}`));
  const errors = [];
  for (const item of [...(intent?.metrics || []), ...(intent?.dimensions || []), ...(intent?.filters || [])]) {
    const field = item?.field || item?.fieldRef;
    if (field && !fields.has(field)) errors.push(`映射字段不存在于 Wyn 返回字段：${field}`);
  }
  for (const ref of intent?.skillRefs || []) if (skillRefs.size && !skillRefs.has(ref)) errors.push(`Skill 引用未加载：${ref}`);
  const mappings = skills.flatMap(skill => skill.valueMappings || []);
  for (const filter of intent?.filters || []) {
    const values = Array.isArray(filter.value) ? filter.value : [filter.value];
    for (const value of values) {
      if (value == null) continue;
      const canonicalMappings = mappings.filter(item => String(item.canonicalValue) === String(value));
      if (canonicalMappings.length && !canonicalMappings.some(item => item.field === filter.field)) {
        errors.push(`Skill 规范值字段绑定冲突：${filter.field}=${value}；该值只允许绑定到 ${[...new Set(canonicalMappings.map(item => item.field))].join('、')}`);
      }
    }
    const fieldMappings = mappings.filter(item => item.field === filter.field);
    for (const value of values) {
      if (value == null || fieldMappings.some(item => String(item.canonicalValue) === String(value))) continue;
      const aliases = fieldMappings.filter(item => (item.synonyms || []).includes(String(value)));
      if (aliases.length) errors.push(`筛选值未使用 Skill 源值：${filter.field}=${value}；候选源值：${[...new Set(aliases.map(item => item.canonicalValue))].join('、')}`);
    }
    for (const mapping of fieldMappings.filter(item => values.some(value => String(value) === String(item.canonicalValue)))) {
      const containsOperator = ['containsAny', 'containsAll', 'notContainsAny', 'notContainsAll'].includes(filter.operator);
      if (['containsAny', 'containsAll'].includes(mapping.matchMode) && !containsOperator) {
        errors.push(`Skill 规范值操作符不匹配：${filter.field}=${mapping.canonicalValue} 必须使用多值成员操作符`);
      }
      if (mapping.matchMode === 'exact' && containsOperator) {
        errors.push(`Skill 规范值操作符不匹配：${filter.field}=${mapping.canonicalValue} 必须使用精确值操作符`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
