import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExplorationArtifacts } from '../lib/analytics/exploration-artifacts.mjs';

test('负时长保留为质量证据但不参与效率排名和图表', () => {
  const request = {
    id: 'qry-operational-efficiency', purpose: '比较科室处理效率', topic: 'open', mode: 'aggregate',
    dataset: { id: 'lab', revision: 3 },
    select: [{ field: '科室名称', alias: 'department' }],
    measures: [
      { field: '总TAT', alias: 'total_tat', aggregation: 'average' },
      { field: '前处理TAT', alias: 'pre_tat', aggregation: 'average' },
      { field: '分析TAT', alias: 'analysis_tat', aggregation: 'average' },
      { field: '后处理TAT', alias: 'post_tat', aggregation: 'average' },
    ],
    filters: [], orderBy: [{ field: 'total_tat', direction: 'desc' }], limit: 30,
  };
  const result = buildExplorationArtifacts([{
    request,
    executionPlan: { adapter: 'wyn-wax-controlled' },
    resultSet: {
      id: 'rs-qry-operational-efficiency',
      rows: [
        { department: 'A科', total_tat: -120, pre_tat: 30, analysis_tat: 80, post_tat: -10 },
        { department: 'B科', total_tat: -90, pre_tat: 45, analysis_tat: 60, post_tat: -20 },
      ],
      statistics: { rowCount: 2 }, quality: { isTruncated: false },
    },
  }]);

  assert.deepEqual(result.evidence[0].scope.invalidDurationFields, ['总TAT', '后处理TAT']);
  assert.equal(result.evidence[0].scope.invalidDurationValueCount, 4);
  assert.equal(result.charts[0].yField, '前处理TAT');
  assert.deepEqual(result.charts[0].values, [45, 30]);
  assert.ok(!result.charts[0].series.some(item => ['total_tat', 'post_tat'].includes(item.alias)));
  assert.match(result.insights[0].statement, /负值聚合结果.*排除.*前处理TAT平均值最高/s);
  assert.doesNotMatch(result.insights[0].statement, /总TAT平均值最高/);
});

test('时间字段 min/max 聚合保留时间文本且不伪装成数值图表序列', () => {
  const result = buildExplorationArtifacts([{
    request: {
      id: 'qry-critical-detail', purpose: '危急值项目详情', topic: 'open', mode: 'verify',
      dataset: { id: 'lab', revision: 3 }, select: [{ field: '危急值检测项目名称', alias: 'entity' }],
      measures: [
        { field: '通知耗时', alias: 'duration', aggregation: 'average' },
        { field: '危急结果产生时间', alias: 'result_time', aggregation: 'min' },
      ], filters: [], orderBy: [{ field: 'duration', direction: 'desc' }], limit: 30,
    },
    executionPlan: { adapter: 'wyn-wax-controlled' },
    resultSet: {
      id: 'rs-qry-critical-detail',
      rows: [{ entity: '钾离子', duration: 39.85, result_time: '2025-12-08T16:31:28' }],
      statistics: { rowCount: 1 }, quality: { isTruncated: false },
    },
  }]);
  assert.match(result.insights[0].statement, /危急结果产生时间为 2025-12-08T16:31:28/);
  assert.doesNotMatch(result.insights[0].statement, /产生时间为 0/);
  assert.deepEqual(result.charts[0].series.map(item => item.name), ['通知耗时']);
});
