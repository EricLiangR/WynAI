import { createHash } from 'node:crypto';
import { normalizeCanonicalQueryRequest } from '../planning/query-request-schema.mjs';

function words(value) {
  return String(value || '').toLowerCase().split(/[\s,，。；;、:：()（）/]+/).filter(Boolean);
}

function fieldText(field) {
  return [field.name, field.description, ...(field.synonyms || [])].filter(Boolean).join(' ').toLowerCase();
}

function scoreField(field, question, { role } = {}) {
  if (role && field.role !== role) return -100;
  const text = fieldText(field);
  let score = 0;
  for (const token of words(question)) if (token.length > 1 && (text.includes(token) || token.includes(String(field.name).toLowerCase()))) score += token.length;
  if (question.includes(field.name)) score += 20;
  return score;
}

function bestField(metadata, question, role, skillMetrics = []) {
  for (const metric of skillMetrics) {
    if (question.includes(metric.name || '') && metadata.fields.some(field => field.name === metric.field)) return metadata.fields.find(field => field.name === metric.field);
  }
  return [...(metadata.fields || [])].sort((a, b) => scoreField(b, question, { role }) - scoreField(a, question, { role }))[0];
}

function stableId(prefix, input) {
  return `${prefix}-${createHash('sha256').update(String(input)).digest('hex').slice(0, 16)}`;
}

function inferAggregation(question) {
  if (/平均|均值|日均/.test(question)) return 'average';
  if (/最大|最高|峰值/.test(question)) return 'max';
  if (/最小|最低|谷值/.test(question)) return 'min';
  if (/去重|客户数|产品数/.test(question)) return 'distinctCount';
  if (/数量|笔数|记录数|明细数/.test(question)) return 'countRows';
  return 'sum';
}

function inferGrain(question) {
  if (/年度|每年|按年|同比/.test(question)) return 'year';
  if (/季度|每季|按季/.test(question)) return 'quarter';
  if (/月度|每月|按月|环比/.test(question)) return 'month';
  if (/每日|每天|按日/.test(question)) return 'day';
  return null;
}

function inferShape(intent) {
  const stated = intent.expectedResult?.shape;
  if (stated && stated !== 'unknown') return stated;
  const question = intent.businessQuestion;
  if (/明细/.test(question)) return 'detail-table';
  if (/交叉|矩阵/.test(question)) return 'matrix';
  if (/趋势|同比|环比/.test(question)) return 'time-series';
  if (/按.+(?:统计|汇总|排名|占比)/.test(question)) return 'grouped-table';
  return 'scalar';
}

export function proposeCanonicalQueries({ metadataItems = [], intent, skills = [] } = {}) {
  if (!intent?.businessQuestion) throw Object.assign(new Error('缺少业务查询意图'), { status: 400 });
  if (!metadataItems.length) throw Object.assign(new Error('缺少数据集语义目录'), { status: 400 });
  const question = intent.businessQuestion;
  const shape = inferShape(intent);
  const requests = [];
  const candidates = [];
  for (const metadata of metadataItems) {
    const skillMetrics = skills.flatMap(skill => skill.metrics || []);
    const measure = bestField(metadata, question, 'measure', skillMetrics);
    const time = bestField(metadata, question, 'time');
    const dimension = bestField(metadata, question, 'dimension') || bestField(metadata, question, 'identifier');
    const aggregation = inferAggregation(question);
    const grain = inferGrain(question);
    const isDetail = shape === 'detail-table';
    const select = [];
    if (isDetail) {
      const explicit = (metadata.fields || []).filter(field => question.includes(field.name)).slice(0, 12);
      select.push(...(explicit.length ? explicit : (metadata.fields || []).slice(0, 8)).map((field, index) => ({ field: field.name, alias: `field${index + 1}` })));
    } else if (grain && time) select.push({ field: time.name, alias: 'period', grain });
    else if (['grouped-table', 'matrix', 'chart'].includes(shape) && dimension) select.push({ field: dimension.name, alias: 'group' });
    if (shape === 'matrix') {
      const second = (metadata.fields || []).filter(field => field.role === 'dimension' && field.name !== dimension?.name).sort((a, b) => scoreField(b, question, { role: 'dimension' }) - scoreField(a, question, { role: 'dimension' }))[0];
      if (second) select.push({ field: second.name, alias: 'group2' });
    }
    const measures = isDetail ? [] : [{ field: aggregation === 'countRows' ? null : measure?.name, aggregation, alias: 'value' }];
    if (!isDetail && aggregation !== 'countRows' && !measure) {
      candidates.push({ datasetId: metadata.id, confidence: 0, warnings: ['未找到可用于聚合的指标字段'] });
      continue;
    }
    const raw = {
      id: stableId('qry', `${metadata.id}|${question}`),
      purpose: question,
      mode: isDetail ? 'detail' : /同比|环比|比较/.test(question) ? 'compare' : 'aggregate',
      topic: 'open',
      dataset: { id: metadata.id, revision: metadata.revision ?? null },
      select,
      measures,
      filters: intent.context?.filters || [],
      orderBy: /排名|最高|前\s*\d+|top/i.test(question) && measures.length ? [{ field: 'value', direction: 'desc' }] : [],
      limit: intent.expectedResult?.maximumRows || (isDetail ? 100 : 50),
      expectedResult: { shape: isDetail ? 'table' : shape, maximumRows: intent.expectedResult?.maximumRows || 100 },
    };
    requests.push(normalizeCanonicalQueryRequest(metadata, raw));
    candidates.push({ datasetId: metadata.id, measure: measure?.name || null, dimension: select.map(item => item.field), aggregation, grain, confidence: Math.min(0.95, 0.55 + Math.max(0, scoreField(measure || {}, question, { role: 'measure' })) / 40), warnings: select.length || shape === 'scalar' ? [] : ['未识别分组维度，已生成单值聚合'] });
  }
  return { schema: 'wynai.binding-proposal/v1', intent, requests, candidates, requiresUserConfirmation: true };
}

export function proposeFormula(question) {
  const text = String(question || '');
  if (/完成率|达成率/.test(text)) return { schema: 'wynai.formula/v1', operator: 'ratio', inputs: ['actual', 'target'], scale: 100, precision: 2, divideByZero: 'null' };
  if (/同比|环比|增长率|变化率/.test(text)) return { schema: 'wynai.formula/v1', operator: 'change', inputs: ['current', 'previous'], scale: 100, precision: 2, divideByZero: 'null' };
  if (/占比/.test(text)) return { schema: 'wynai.formula/v1', operator: 'percentage', inputs: ['part', 'total'], scale: 100, precision: 2, divideByZero: 'null' };
  if (/差额|增加额|减少额/.test(text)) return { schema: 'wynai.formula/v1', operator: 'difference', inputs: ['current', 'previous'], precision: 2 };
  return null;
}
