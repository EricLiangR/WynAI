import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareStructuredReport, validateStructuredReport } from '../lib/report/structured-report.mjs';

function analysisFixture(scope = {}) {
  return {
    evidence: [{ id: 'ev-response', title: '危急值响应', scope }],
    insights: [{
      title: '钾离子及时率偏低',
      statement: '当前返回范围内，钾离子及时率为 15.38%。',
      evidenceIds: ['ev-response'],
    }],
  };
}

function reportFixture(actionText = '优先复核危急值通知流程') {
  const item = text => [{ text, evidenceIds: ['ev-response'], verificationRequired: false }];
  return {
    managementSummary: item('危急值响应存在风险'),
    keyFindings: item('钾离子及时率偏低'),
    risks: item('通知流程需要复核'),
    actions: item(actionText),
  };
}

test('行动可以引用同一证据洞察中的现状数字', () => {
  const report = validateStructuredReport(reportFixture('优先复核及时率为 15.38% 的钾离子通知流程'), analysisFixture());
  assert.equal(report.actions[0].text, '优先复核及时率为 15.38% 的钾离子通知流程');
});

test('行动中的无证据数字和定量目标会被拒绝', () => {
  assert.throws(
    () => validateStructuredReport(reportFixture('将及时率提升至 90%'), analysisFixture()),
    /无证据支持的数字/,
  );
  const analysis = analysisFixture();
  analysis.insights[0].statement += ' 对照值为 90%。';
  assert.throws(
    () => validateStructuredReport(reportFixture('将及时率提升至 90%'), analysis),
    /定量目标或阈值/,
  );
});

test('历史月份写法差异与历史增长不会被误判为新目标', () => {
  const analysis = analysisFixture();
  analysis.insights[0].statement = '2025-02 较 2025-01 增长 23.2%。';
  assert.doesNotThrow(() => validateStructuredReport(
    reportFixture('验证 2025 年 2 月较 1 月增长 23.2% 期间的业务变化'),
    analysis,
  ));
});

test('日期中的月份数字不会碰巧匹配分组指标并触发实体上下文误判', () => {
  const analysis = analysisFixture();
  analysis.evidence[0].value = [{ label: '2026-03-29T00:00:00.000Z', records: 3 }];
  const report = reportFixture();
  report.keyFindings[0].text = '2026年3月业务量需要复核';
  assert.doesNotThrow(() => validateStructuredReport(report, analysis));
});

test('受限结果不能被改写为整体结论', () => {
  const analysis = analysisFixture({ resultLimited: true });
  const report = reportFixture();
  report.keyFindings[0].text = '整体及时率最低';
  assert.throws(() => validateStructuredReport(report, analysis), /整体及时率最低/);
});

test('分组数值必须保留唯一实体上下文，组合占比不得变成单项占比', () => {
  const analysis = analysisFixture();
  analysis.evidence[0].value = [{ label: '口腔科B区', duration: 667.04 }];
  const report = reportFixture();
  report.keyFindings[0].text = '分析TAT平均值为667.04';
  assert.throws(() => validateStructuredReport(report, analysis), /实体上下文/);
  report.keyFindings[0].text = '口腔科B区分析TAT平均值为667.04';
  assert.doesNotThrow(() => validateStructuredReport(report, analysis));
  report.keyFindings[0].text = '已完成订单占比100%（前三项合计）';
  assert.throws(() => validateStructuredReport(report, analysis), /组合占比/);
});

test('复合实体上下文允许不同连接符但不得丢失任一组成部分', () => {
  const analysis = analysisFixture();
  analysis.evidence[0].value = [{ label: '点心 · 2025-02-01T00:00:00.000Z', revenue: 158508.77 }];
  const report = reportFixture();
  report.keyFindings[0].text = '点心·2025-02-01T00:00:00.000Z订单金额为158,508.77';
  assert.doesNotThrow(() => validateStructuredReport(report, analysis));
  report.keyFindings[0].text = '点心订单金额为158,508.77';
  assert.throws(() => validateStructuredReport(report, analysis), /实体上下文/);
});

test('管理摘要中的分组数字在验证前删除，详细发现仍保留严格实体校验', () => {
  const analysis = analysisFixture();
  analysis.evidence[0].value = [{ label: '点心 · 2025-02-01T00:00:00.000Z', revenue: 158508.77 }];
  const report = reportFixture();
  report.managementSummary[0].text = '交叉结果金额达到158,508.77';
  report.keyFindings[0].text = '点心 · 2025-02-01T00:00:00.000Z金额为158,508.77';
  const prepared = prepareStructuredReport(report, analysis);
  assert.doesNotMatch(prepared.managementSummary[0].text, /158,508\.77/);
  assert.doesNotThrow(() => validateStructuredReport(prepared, analysis));
  prepared.keyFindings[0].text = '金额为158,508.77';
  assert.throws(() => validateStructuredReport(prepared, analysis), /实体上下文/);
});

test('含负时长的证据不能直接形成正常效率排名', () => {
  const analysis = analysisFixture({ invalidDurationFields: ['总TAT'] });
  const report = reportFixture();
  assert.throws(() => validateStructuredReport(report, analysis), /未披露负时长证据/);
  report.keyFindings[0].text = '神经外科总TAT最高，是当前瓶颈';
  assert.throws(() => validateStructuredReport(report, analysis), /负时长/);
  report.keyFindings[0].text = '总TAT存在负值异常，不能直接用于瓶颈排名';
  assert.doesNotThrow(() => validateStructuredReport(report, analysis));
  report.keyFindings[0].text = '排除负值字段后，前处理TAT平均值最高';
  assert.doesNotThrow(() => validateStructuredReport(report, analysis));
});
