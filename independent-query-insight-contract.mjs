const INSIGHT_AGGREGATIONS = new Set(['sum', 'average', 'min', 'max', 'count', 'distinctCount', 'none']);

export function normalizeIndependentQueryInsightContract(input = {}) {
  return {
    ...input,
    resultSets: (input.resultSets || []).map(resultSet => ({
      ...resultSet,
      schema: (resultSet.schema || []).map(field => {
        const aggregation = String(field?.aggregation || '').trim();
        const isDerived = field?.role === 'derived-measure'
          || Boolean(field?.derivedFrom || field?.formula)
          || (aggregation && !INSIGHT_AGGREGATIONS.has(aggregation));
        if (!isDerived) return field;
        return {
          ...field,
          role: 'measure',
          aggregation: 'none',
          semanticType: field.semanticType || aggregation || 'derived',
          additivity: 'non-additive',
          isPreAggregated: true,
        };
      }),
    })),
  };
}
