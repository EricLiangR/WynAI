const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function uniqueStrings(values = []) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function fields(items = []) {
  return uniqueStrings(items.map(item => item?.field));
}

function check(name, passed, expected, actual) {
  return { name, passed: Boolean(passed), expected, actual };
}

export function isApprovedSkillIdentity(item = {}) {
  return Boolean(String(item.id || '').trim() && SEMVER.test(String(item.version || '')) && item.status === 'approved');
}

export function normalizeUatCase(pack = {}, input = {}) {
  const expected = input.expected || {};
  const status = expected.status === 'needs_clarification' ? 'needs_clarification' : 'ok';
  return {
    caseId: String(input.id || '').trim(),
    domain: String(pack.domain || '').trim(),
    datasetId: String(pack.datasetId || '').trim(),
    packRef: `${pack.id}@${pack.version}`,
    source: input.source || 'evaluation-pack',
    userQuestion: String(input.question || '').trim(),
    conversationSteps: Array.isArray(input.conversationSteps) ? input.conversationSteps : [],
    expectedSemanticFrame: { metrics: uniqueStrings(expected.metrics), dimensions: uniqueStrings(expected.dimensions), grain: expected.grain || null },
    expectedIntent: { status, clarification: Boolean(expected.clarification) },
    expectedQueryInvariants: { minimumResultSets: status === 'ok' ? 1 : 0, ...(input.expectedQueryInvariants || {}) },
    expectedResultInvariants: { minimumRows: status === 'ok' ? 1 : 0, ...(input.expectedResultInvariants || {}) },
    expectedPresentation: { ...(input.expectedPresentation || {}) },
    expectedTraceEvents: uniqueStrings(input.expectedTraceEvents || ['request.accepted', 'turn.received', 'planning.completed', 'request.completed']),
    screenshotEvidence: { desktop: 'required', mobile390x844: 'required', ...(input.screenshotEvidence || {}) },
    defects: Array.isArray(input.defects) ? input.defects : [],
  };
}

export function evaluateUatCase(uatCase, response = {}, traceItems = []) {
  const intent = response.businessIntent || {};
  const responseMetrics = fields(intent.metrics);
  const responseDimensions = fields(intent.dimensions);
  const resultSets = response.resultSets || [];
  const resultRows = resultSets.reduce((total, item) => total + (item?.rows || []).length, 0);
  const request = response.queryRequests?.[0] || {};
  const presentation = response.presentationPlan || response.document?.presentationPlan || {};
  const eventNames = uniqueStrings(traceItems.map(item => item?.event));
  const checks = [
    check('response.status', response.status === uatCase.expectedIntent.status, uatCase.expectedIntent.status, response.status || null),
    check('semantic.metrics', uatCase.expectedSemanticFrame.metrics.every(field => responseMetrics.includes(field)), uatCase.expectedSemanticFrame.metrics, responseMetrics),
    check('semantic.dimensions', uatCase.expectedSemanticFrame.dimensions.every(field => responseDimensions.includes(field)), uatCase.expectedSemanticFrame.dimensions, responseDimensions),
    check('semantic.grain', !uatCase.expectedSemanticFrame.grain || intent.time?.grain === uatCase.expectedSemanticFrame.grain, uatCase.expectedSemanticFrame.grain, intent.time?.grain || null),
    check('query.resultSets', resultSets.length >= uatCase.expectedQueryInvariants.minimumResultSets, uatCase.expectedQueryInvariants.minimumResultSets, resultSets.length),
    check('query.requiredMeasures', (uatCase.expectedQueryInvariants.requiredMeasures || []).every(field => fields(request.measures).includes(field)), uatCase.expectedQueryInvariants.requiredMeasures || [], fields(request.measures)),
    check('result.minimumRows', resultRows >= uatCase.expectedResultInvariants.minimumRows, uatCase.expectedResultInvariants.minimumRows, resultRows),
    check('presentation.mode', !uatCase.expectedPresentation.mode || presentation.mode === uatCase.expectedPresentation.mode, uatCase.expectedPresentation.mode || null, presentation.mode || null),
    check('presentation.chartType', !uatCase.expectedPresentation.chartType || presentation.chart?.visualization?.type === uatCase.expectedPresentation.chartType, uatCase.expectedPresentation.chartType || null, presentation.chart?.visualization?.type || null),
    check('trace.events', uatCase.expectedTraceEvents.every(event => eventNames.includes(event)), uatCase.expectedTraceEvents, eventNames),
  ];
  return { schema: 'wynai.uat-case-result/v1', caseId: uatCase.caseId, passed: checks.every(item => item.passed), checks, evidence: { traceId: response.trace?.traceId || null, turnId: response.trace?.turnId || null, query: { measures: fields(request.measures), dimensions: fields(request.select), resultSetCount: resultSets.length }, result: { rows: resultRows, scope: resultSets[0]?.scope || null }, presentation: { mode: presentation.mode || null, chartType: presentation.chart?.visualization?.type || null }, traceEvents: eventNames, screenshots: uatCase.screenshotEvidence } };
}

export function summarizeUatRun(caseResults = []) {
  const passed = caseResults.filter(item => item.passed).length;
  return { total: caseResults.length, passed, failed: caseResults.length - passed, status: passed === caseResults.length ? 'passed' : 'failed' };
}
