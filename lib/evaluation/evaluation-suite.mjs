function values(items = [], key = 'field') { return (items || []).map(item => item?.[key]).filter(Boolean); }

export function normalizeEvaluationPack(input = {}) {
  const id = String(input.id || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{2,100}$/i.test(id)) throw new Error('评测包 ID 无效');
  if (!String(input.domain || '').trim()) throw new Error('评测包缺少行业领域');
  if (!String(input.datasetId || '').trim()) throw new Error('评测包缺少数据集');
  const cases = (input.cases || []).map((item, index) => ({
    id: String(item.id || `${id}-${index + 1}`), question: String(item.question || '').trim(), risk: ['low', 'medium', 'high'].includes(item.risk) ? item.risk : 'medium',
    expected: { status: item.expected?.status || 'supported', metrics: [...new Set(item.expected?.metrics || [])], dimensions: [...new Set(item.expected?.dimensions || [])], grain: item.expected?.grain || null, clarification: Boolean(item.expected?.clarification) },
    variants: [...new Set((item.variants || []).map(String).filter(Boolean))], tags: [...new Set((item.tags || []).map(String).filter(Boolean))],
  }));
  if (!cases.length || cases.some(item => !item.question)) throw new Error('评测包必须包含非空问题');
  return { schema: 'wynai.evaluation-pack/v1', id, version: String(input.version || '1.0.0'), domain: String(input.domain), datasetId: String(input.datasetId), owner: String(input.owner || 'unassigned'), status: input.status === 'approved' ? 'approved' : 'draft', cases };
}

export function evaluatePlanningResult(testCase, plan) {
  const actualMetrics = values(plan?.intent?.metrics);
  const actualDimensions = values(plan?.intent?.dimensions);
  const checks = [
    { name: 'status', passed: plan?.status === testCase.expected.status },
    { name: 'metrics', passed: testCase.expected.metrics.every(field => actualMetrics.includes(field)) },
    { name: 'dimensions', passed: testCase.expected.dimensions.every(field => actualDimensions.includes(field)) },
    { name: 'grain', passed: !testCase.expected.grain || plan?.intent?.time?.grain === testCase.expected.grain },
    { name: 'clarification', passed: !testCase.expected.clarification || plan?.status === 'needs_clarification' },
  ];
  return { id: testCase.id, passed: checks.every(check => check.passed), checks, actual: { status: plan?.status, metrics: actualMetrics, dimensions: actualDimensions, grain: plan?.intent?.time?.grain || null, risk: plan?.plannerDiagnostics?.riskAssessment?.level || null } };
}

export async function runEvaluationPack(packInput, planner) {
  const pack = normalizeEvaluationPack(packInput);
  const startedAt = new Date().toISOString();
  const results = [];
  for (const testCase of pack.cases) {
    for (const question of [testCase.question, ...testCase.variants]) {
      const plan = await planner({ ...testCase, question, datasetId: pack.datasetId });
      results.push({ question, ...evaluatePlanningResult(testCase, plan) });
    }
  }
  return { schema: 'wynai.evaluation-run/v1', packRef: `${pack.id}@${pack.version}`, domain: pack.domain, datasetId: pack.datasetId, startedAt, completedAt: new Date().toISOString(), total: results.length, passed: results.filter(item => item.passed).length, failed: results.filter(item => !item.passed).length, results };
}

