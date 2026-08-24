const ACTION_KINDS = new Set(['replace-metric', 'add-dimension', 'add-time-grain', 'rank']);

function text(value, maximum = 200) {
  return String(value ?? '').trim().slice(0, maximum);
}

function isMeasure(field) {
  return field?.role === 'measure' || /number|decimal|double|float|int|long/i.test(`${field?.type || ''} ${field?.rawType || ''}`);
}

function isTime(field) {
  return field?.role === 'time' || /date|time|日期|时间/i.test(`${field?.type || ''} ${field?.rawType || ''} ${field?.name || ''}`);
}

function isDimension(field) {
  return !isMeasure(field) && !isTime(field);
}

function action({ id, kind, label, question, source, basedOn }) {
  return { schema: 'wynai.follow-up-action/v1', id, kind, label, question, source, confidence: 1, basedOn };
}

// These actions remain natural-language messages. They never carry executable query data.
export function buildFollowUpActions({ metadata, plan, resultSet, question = '' } = {}) {
  if (!metadata?.id || !plan?.request || !resultSet || resultSet.quality?.isSample || resultSet.quality?.isTruncated) return [];
  const fields = Array.isArray(metadata.fields) ? metadata.fields : [];
  const activeMetric = plan.request.measures?.[0]?.field || null;
  const activeDimensions = plan.request.select?.map(item => item.field).filter(Boolean) || [];
  const hasTimeDimension = plan.request.select?.some(item => item.grain) || false;
  const ranking = Boolean(plan.intent?.ranking) || /(?:前|top\s*)\d+|排名|排行/i.test(question);
  const basedOn = { datasetId: metadata.id, metric: activeMetric, dimensions: activeDimensions };
  const actions = [];

  const alternativeMetric = fields.find(field => isMeasure(field) && field.name !== activeMetric);
  if (alternativeMetric) {
    actions.push(action({
      id: 'replace-metric-1', kind: 'replace-metric', label: `改看${alternativeMetric.name}`,
      question: `改为查看${alternativeMetric.name}`, source: 'semantic-catalog', basedOn,
    }));
  }

  const alternativeDimension = fields.find(field => isDimension(field) && !activeDimensions.includes(field.name));
  if (alternativeDimension && activeMetric) {
    actions.push(action({
      id: 'add-dimension-1', kind: 'add-dimension', label: `按${alternativeDimension.name}查看`,
      question: `按${alternativeDimension.name}查看${activeMetric}`, source: 'semantic-catalog', basedOn,
    }));
  }

  const timeField = fields.find(isTime);
  if (timeField && !hasTimeDimension && activeMetric) {
    actions.push(action({
      id: 'add-time-grain-1', kind: 'add-time-grain', label: '按月查看趋势',
      question: `按月查看${activeMetric}`, source: 'semantic-catalog', basedOn,
    }));
  }

  if (!ranking && activeMetric && activeDimensions.length) {
    actions.push(action({
      id: 'rank-1', kind: 'rank', label: `查看${activeDimensions[0]}前5名`,
      question: `按${activeDimensions[0]}查看${activeMetric}前5名`, source: 'query-plan', basedOn,
    }));
  }

  return normalizeFollowUpActions(actions).slice(0, 3);
}

export function normalizeFollowUpActions(actions = []) {
  const seenQuestions = new Set();
  return (Array.isArray(actions) ? actions : [])
    .filter(item => item && ACTION_KINDS.has(item.kind))
    .map((item, index) => {
      const question = text(item.question);
      const label = text(item.label, 100);
      if (!question || !label || seenQuestions.has(question)) return null;
      seenQuestions.add(question);
      return {
        schema: 'wynai.follow-up-action/v1',
        id: text(item.id || `action-${item.kind}-${index + 1}`, 100),
        kind: item.kind,
        label,
        question,
        source: ['semantic-catalog', 'query-plan', 'result-shape'].includes(item.source) ? item.source : 'semantic-catalog',
        confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0)),
        basedOn: {
          datasetId: text(item.basedOn?.datasetId, 100) || null,
          metric: text(item.basedOn?.metric, 200) || null,
          dimensions: [...new Set((Array.isArray(item.basedOn?.dimensions) ? item.basedOn.dimensions : []).map(value => text(value, 200)).filter(Boolean))].slice(0, 8),
        },
      };
    })
    .filter(Boolean)
    .slice(0, 3);
}