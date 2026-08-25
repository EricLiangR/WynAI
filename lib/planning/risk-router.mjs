const LEVELS = Object.freeze({ low: 0, medium: 1, high: 2 });

function addReason(reasons, code, score, message) {
  reasons.push({ code, score, message });
  return score;
}

/** Classifies semantic-planning risk without granting either planner execution authority. */
export function assessPlanningRisk({ question = '', plan = null, skillRefs = [], skillConflicts = [] } = {}) {
  const text = String(question || '');
  const reasons = [];
  let score = 0;
  const constraints = plan?.intent?.constraints || [];
  const unresolved = constraints.filter(item => item.required && item.status !== 'resolved');
  const metrics = plan?.intent?.metrics || [];
  const dimensions = (plan?.intent?.dimensions || []).filter(item => !item.internal);
  const derivedMetrics = plan?.intent?.derivedMetrics || [];
  const confidence = Number(plan?.intent?.confidence);

  if (![...new Set(skillRefs.map(String).filter(Boolean))].length) score += addReason(reasons, 'NO_APPROVED_DOMAIN_SKILL', 25, '本轮没有命中已审批领域 Skill');
  if (unresolved.length) score += addReason(reasons, 'UNRESOLVED_REQUIRED_CONSTRAINT', 45, `存在 ${unresolved.length} 个必需未决约束`);
  if (skillConflicts.length) score += addReason(reasons, 'SKILL_CONFLICT', 60, '领域 Skill 存在口径冲突');
  if (derivedMetrics.length || /同比|环比|增长率|占比|贡献率|转化率|达成率/.test(text)) score += addReason(reasons, 'DERIVED_METRIC', 25, '包含派生指标或比较计算');
  if (metrics.length > 1) score += addReason(reasons, 'MULTIPLE_METRICS', 10, '包含多个指标');
  if (dimensions.length > 1) score += addReason(reasons, 'MULTIPLE_DIMENSIONS', 10, '包含多个维度');
  if (/预测|原因|归因|异常|诊断|建议|为什么/.test(text)) score += addReason(reasons, 'OPEN_ANALYTICAL_REASONING', 25, '需要开放式分析推理');
  if (/财务报表|审计|税|合规|医疗|诊断|处方|法律|授信|风控|薪酬/.test(text)) score += addReason(reasons, 'HIGH_STAKES_DOMAIN', 35, '涉及高影响业务领域');
  if (Number.isFinite(confidence) && confidence < 0.85) score += addReason(reasons, 'LOW_SEMANTIC_CONFIDENCE', 30, '语义意图置信度低于 0.85');
  if (plan?.status !== 'supported') addReason(reasons, 'PLANNER_INCOMPLETE', 0, '确定性计划尚不可执行；该项属于技术就绪度，不提高业务风险分值');

  const level = score >= 60 ? 'high' : score >= 25 ? 'medium' : 'low';
  const policy = level === 'low'
    ? { llm: 'skip', failureMode: 'validated-deterministic', execution: 'allowed' }
    : level === 'medium'
      ? { llm: 'required-when-available', failureMode: 'validated-deterministic-with-warning', execution: 'allowed-after-validation' }
      : { llm: 'required', failureMode: 'clarify-or-refuse', execution: 'blocked-until-validated' };
  return { schema: 'wynai.planning-risk-assessment/v1', level, score: Math.min(100, score), reasons, plannerReadiness: plan?.status === 'supported' ? 'executable' : 'incomplete', policy, evaluatedAt: new Date().toISOString() };
}

export function planningRiskAtLeast(assessment, level) {
  return (LEVELS[assessment?.level] ?? 0) >= (LEVELS[level] ?? 0);
}

