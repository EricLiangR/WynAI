const AGGREGATION_LABELS = {
  sum: '求和', average: '平均值', min: '最小值', max: '最大值',
  countRows: '计数', distinctCount: '去重计数',
};

function text(value) { return String(value ?? '').trim(); }

export function resolveFieldDisplayLabel({ field, metadataField = null, aggregation = null, distinct = false, role = 'measure', explicitLabel = null } = {}) {
  const sourceField = text(field);
  const businessLabel = text(explicitLabel) || text(metadataField?.displayName) || text(metadataField?.label) || sourceField;
  if (role !== 'measure') return businessLabel || sourceField;
  const effectiveAggregation = distinct ? 'distinctCount' : text(aggregation);
  if (effectiveAggregation === 'distinctCount' && !/（去重）$/.test(businessLabel)) return `${businessLabel}（去重）`;
  return businessLabel || sourceField;
}

export function decorateQueryField({ item, metadata, role = 'measure' } = {}) {
  const sourceField = text(item?.field);
  const metadataField = (metadata?.fields || []).find(candidate => candidate?.name === sourceField) || null;
  const distinct = Boolean(item?.distinct || item?.aggregation === 'distinctCount');
  return {
    ...item,
    sourceField,
    displayName: resolveFieldDisplayLabel({ field: sourceField, metadataField, aggregation: item?.aggregation, distinct, role, explicitLabel: item?.label || item?.displayName }),
  };
}

export const DISPLAY_LABEL_CONTRACT = 'wynai.field-display-labels/v1';
