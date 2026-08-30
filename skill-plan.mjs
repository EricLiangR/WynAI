const VERSION = 'wynai.skill-plan/v1';

function unique(values) {
  return [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))];
}

export function compileSkillPlan({ skills = [], schema = [], question = '' } = {}) {
  const fields = new Set((schema || []).map(field => String(field?.name || '').trim()).filter(Boolean));
  const methods = new Map();
  for (const skill of skills || []) {
    const core = new Set(unique(skill?.coreMethods));
    const optional = new Set(unique([...(skill?.optionalMethods || []), ...(skill?.extendedMethods || [])]));
    const ids = unique([...(skill?.insightMethods || []), ...core, ...optional]);
    for (const id of ids) {
      const requiredFields = Array.isArray(skill?.evidenceRequirements?.[id]) ? unique(skill.evidenceRequirements[id]) : [];
      const current = methods.get(id) || { id, priority: core.has(id) ? 'core' : optional.has(id) ? 'extended' : 'optional', blocking: core.has(id), requiredFields: [], missingFields: [], skillRefs: [], rowLevel: false };
      // A method is core if any approved Skill declares it core. This prevents
      // an optional profile from weakening a platform core contract.
      if (core.has(id)) { current.priority = 'core'; current.blocking = true; }
      current.requiredFields = unique([...current.requiredFields, ...requiredFields]);
      current.missingFields = unique([...current.missingFields, ...requiredFields.filter(field => !fields.has(field))]);
      current.skillRefs = unique([...current.skillRefs, `${skill.id}@${skill.version}`]);
      current.rowLevel = current.rowLevel || (skill?.rowLevelMethods || []).includes(id) || Boolean(skill?.methodPolicies?.[id]?.requiresRowLevelEvidence);
      methods.set(id, current);
    }
  }
  const methodList = [...methods.values()].map(method => ({ ...method, available: method.missingFields.length === 0 }));
  return {
    schema: VERSION,
    question: String(question || '').slice(0, 4000),
    skillRefs: unique((skills || []).map(skill => `${skill.id}@${skill.version}`)),
    methods: methodList,
    coreMethods: methodList.filter(method => method.priority === 'core').map(method => method.id),
    optionalMethods: methodList.filter(method => method.priority !== 'core').map(method => method.id),
    requiredFacts: unique((skills || []).flatMap(skill => skill?.requiredFacts || [])),
    unavailableCoreMethods: methodList.filter(method => method.priority === 'core' && !method.available).map(method => ({ id: method.id, missingFields: method.missingFields })),
    rowLevelMethods: methodList.filter(method => method.rowLevel).map(method => method.id),
    maxRowLevelChunks: Math.max(1, Math.min(32, Number((skills || []).find(skill => skill?.maxRowLevelChunks != null)?.maxRowLevelChunks) || 32)),
    fields: [...fields],
  };
}

export const skillPlanVersion = VERSION;
