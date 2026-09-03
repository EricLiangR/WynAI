import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIndependentQueryInsightContract } from './independent-query-insight-contract.mjs';
import { normalizeInsightInput } from './lib/data-insights/insight-input.mjs';

test('智能问数派生指标按洞察输入契约注册', () => {
  const normalized = normalizeIndependentQueryInsightContract({
    schema: 'wynai.insight-input/v1',
    title: '按年查看毛利率',
    resultSets: [{
      id: 'result-1',
      schema: [
        { name: 'year', type: 'date', role: 'dimension', grain: 'year' },
        { name: 'gross_margin_rate', displayName: '毛利率', type: 'number', role: 'derived-measure', aggregation: 'ratio', format: 'percentage' },
      ],
      rows: [{ year: '2025-01-01', gross_margin_rate: 0.48 }],
    }],
  });

  const field = normalized.resultSets[0].schema[1];
  assert.equal(field.role, 'measure');
  assert.equal(field.aggregation, 'none');
  assert.equal(field.semanticType, 'ratio');
  assert.equal(field.additivity, 'non-additive');
  assert.equal(field.isPreAggregated, true);
  assert.doesNotThrow(() => normalizeInsightInput(normalized));
});
