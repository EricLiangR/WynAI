const NUMBER_WORDS = new Map([
  ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4], ['五', 5],
  ['六', 6], ['七', 7], ['八', 8], ['九', 9], ['十', 10],
]);

const METRIC_PATTERNS = [
  { concept: 'profit', pattern: /利润|毛利|盈利/, source: '利润' },
  { concept: 'revenue', pattern: /销售额|销售收入|营收|收入|订单金额|销售(?!利润|员|经理|代表|城市|区域|省份)/, source: '销售额' },
  { concept: 'quantity', pattern: /销量|销售数量|购买数量|件数|数量/, source: '销量' },
];

const DIMENSION_PATTERNS = [
  { concept: 'headquarterProvince', level: 'province', entity: 'organization', pattern: /总部(?:所在)?省份?|总部所在地区/ },
  { concept: 'customerProvince', level: 'province', entity: 'customer-geography', pattern: /客户(?:所在)?省份?|销售省份|收货省份/ },
  { concept: 'city', level: 'city', entity: 'customer-geography', pattern: /客户(?:所在)?城市|销售城市|城市/ },
  { concept: 'province', level: 'province', entity: 'geography', pattern: /(?:各|每个|每一)?省份?|省级/ },
  { concept: 'region', level: 'region', entity: 'customer-geography', pattern: /客户地区|销售区域|区域|地区/ },
  { concept: 'category', level: 'category', entity: 'product', pattern: /每(?:一)?类(?:商品|产品)?|各类(?:商品|产品)?|商品种类|产品种类|商品类别|产品类别|品类|类别/ },
  { concept: 'product', level: 'item', entity: 'product', pattern: /商品名称|产品名称|(?:商品|产品)(?!类别|种类)/ },
  { concept: 'customer', level: 'customer', entity: 'customer', pattern: /客户名称|顾客|客户(?!城市|省份|地区|区域|编号)/ },
  { concept: 'supplier', level: 'supplier', entity: 'supplier', pattern: /供应商/ },
  { concept: 'employee', level: 'employee', entity: 'employee', pattern: /员工(?:姓名)?|销售经理|销售员|业务员|销售代表/ },
  { concept: 'payment', level: 'payment', entity: 'order', pattern: /支付方式|付款方式/ },
  { concept: 'shipper', level: 'shipper', entity: 'order', pattern: /运货商|承运商/ },
];

function matchSource(text, pattern, fallback) {
  return text.match(pattern)?.[0] || fallback;
}

function parseRanking(text) {
  const top = text.match(/(?:前|top\s*)(\d{1,3}|[一二两三四五六七八九十])(?:名|个|项|位)?/i);
  const bottom = text.match(/(?:后|倒数)(\d{1,3}|[一二两三四五六七八九十])(?:名|个|项|位)?/i);
  const explicit = top || bottom;
  if (explicit) {
    return {
      source: explicit[0],
      limit: Math.max(1, Math.min(100, Number(explicit[1]) || NUMBER_WORDS.get(explicit[1]) || 10)),
      direction: bottom ? 'asc' : 'desc',
      kind: 'rank',
      explicit: true,
    };
  }
  const boundedSuperlative = text.match(/(最高|最大|最多|最低|最小|最少)(?:的)?(\d{1,3}|[一二两三四五六七八九十])(?:名|个|项|位)?/);
  if (boundedSuperlative) return {
    source: boundedSuperlative[0],
    limit: Math.max(1, Math.min(100, Number(boundedSuperlative[2]) || NUMBER_WORDS.get(boundedSuperlative[2]) || 1)),
    direction: /最低|最小|最少/.test(boundedSuperlative[1]) ? 'asc' : 'desc',
    kind: 'superlative',
    explicit: true,
  };
  const superlative = text.match(/最高|最大|最多|第一|最优|最低|最小|最少|最后/);
  if (!superlative) return null;
  return {
    source: superlative[0],
    limit: 1,
    direction: /最低|最小|最少|最后/.test(superlative[0]) ? 'asc' : 'desc',
    kind: 'superlative',
    explicit: true,
  };
}

function parseDerivedMetrics(text, metrics) {
  const matches = [];
  for (const match of text.matchAll(/同比(?:增长率|增幅)?|环比(?:增长率|增幅)?/g)) {
    const type = match[0].startsWith('同比') ? 'yoy' : 'mom';
    const before = text.slice(0, match.index);
    const conceptMentions = [
      { concept: 'revenue', index: Math.max(before.lastIndexOf('销售额'), before.lastIndexOf('营收'), before.lastIndexOf('收入')) },
      { concept: 'profit', index: Math.max(before.lastIndexOf('利润'), before.lastIndexOf('毛利')) },
      { concept: 'quantity', index: Math.max(before.lastIndexOf('销量'), before.lastIndexOf('数量')) },
    ].filter(item => item.index >= 0).sort((left, right) => right.index - left.index);
    const sourceConcept = conceptMentions[0]?.concept || metrics[0]?.concept || 'revenue';
    matches.push({
      type,
      source: match[0],
      sourceConcept,
      alias: sourceConcept + '_' + type,
      offset: 1,
      resultType: 'percentage',
      required: true,
    });
  }
  return matches.filter((item, index, values) => values.findIndex(value => value.alias === item.alias) === index);
}
function requestedOutputs(text, metrics, dimensions, ranking, derivedMetrics = []) {
  const outputs = [];
  for (const dimension of dimensions) outputs.push({ kind: 'entity', concept: dimension.concept, source: dimension.source, required: true });
  for (const metric of metrics) outputs.push({ kind: 'metric', concept: metric.concept, source: metric.source, required: true });
  for (const metric of derivedMetrics) outputs.push({ kind: 'derived-metric', concept: metric.sourceConcept, derivation: metric.type, alias: metric.alias, source: metric.source, required: true });
  if (ranking && !outputs.some(item => item.kind === 'entity')) {
    outputs.push({ kind: 'entity', concept: null, source: ranking.source, required: true, status: 'unresolved' });
  }
  return outputs;
}

export function extractQuestionSemanticFrame(question, { time = null } = {}) {
  const text = String(question || '').trim();
  const metrics = METRIC_PATTERNS
    .map(item => {
      const match = text.match(item.pattern);
      return match ? { concept: item.concept, source: match[0] || item.source, required: true, sourceIndex: match.index ?? Number.MAX_SAFE_INTEGER } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.sourceIndex - right.sourceIndex)
    .map(({ sourceIndex, ...item }) => item);
  const dimensions = [];
  for (const item of DIMENSION_PATTERNS) {
    const source = matchSource(text, item.pattern, null);
    if (!source) continue;
    if (item.concept === 'product' && dimensions.some(value => value.concept === 'category') && /产品|商品/.test(source)) continue;
    if (item.concept === 'province' && dimensions.some(value => ['customerProvince', 'headquarterProvince'].includes(value.concept))) continue;
    dimensions.push({ concept: item.concept, level: item.level, entity: item.entity, source, required: true });
  }
  dimensions.sort((left, right) => text.indexOf(left.source) - text.indexOf(right.source));
  const rankingBase = parseRanking(text);
  const partitionBy = rankingBase && time?.grouping && (time?.periods || []).length > 1
    ? ['period']
    : rankingBase && /每(?:个|一)?[^，,。]{0,12}(?:最高|最低|最大|最小|最多|最少)/.test(text) && dimensions.length > 1
      ? [dimensions[0].concept]
      : [];
  const ranking = rankingBase ? { ...rankingBase, partitionBy } : null;
  const derivedMetrics = parseDerivedMetrics(text, metrics);
  const accumulation = /累计|累积/.test(text)
    ? { mode: 'cumulative-window', source: matchSource(text, /累计|累积/, '累计'), required: true }
    : { mode: 'period-total', source: null, required: false };
  const groupingQuantifiers = [...text.matchAll(/每(?:一|个)?|各(?:个|类|省|市)?|分别|逐(?:年|月|季|日)/g)].map(match => match[0]);
  const frame = {
    schema: 'wynai.question-semantic-frame/v2',
    question: text,
    metrics,
    dimensions,
    time: time ? {
      explicit: Boolean(time.explicit),
      scopeExplicit: Boolean(time.scopeExplicit),
      groupingExplicit: Boolean(time.groupingExplicit),
      scopePolicy: time.scopePolicy || 'unspecified',
      source: time.source || null,
      periods: time.periods || [],
      range: time.range || null,
      grouping: time.grouping || time.grain || null,
      aggregationMode: accumulation.mode,
    } : { explicit: false, scopeExplicit: false, groupingExplicit: false, scopePolicy: 'unspecified', source: null, periods: [], range: null, grouping: null, aggregationMode: accumulation.mode },
    accumulation,
    ranking,
    derivedMetrics,
    groupingQuantifiers: [...new Set(groupingQuantifiers)],
    requestedOutputs: [],
    complexity: 0,
  };
  frame.requestedOutputs = requestedOutputs(text, metrics, dimensions, ranking, derivedMetrics);
  frame.complexity = [metrics.length > 1, dimensions.length > 1, Boolean(time?.scopeExplicit), Boolean(time?.groupingExplicit), Boolean(ranking), accumulation.required, derivedMetrics.length > 0, /占比|增长|下钻|上卷|原因/.test(text)]
    .filter(Boolean).length;
  return frame;
}

export function semanticFrameConstraintIds(frame) {
  return [
    ...(frame?.metrics || []).map((_, index) => `frame-metric-${index + 1}`),
    ...(frame?.dimensions || []).map((_, index) => `frame-dimension-${index + 1}`),
    ...(frame?.time?.scopeExplicit ? ['frame-time-scope'] : []),
    ...(frame?.time?.grouping ? ['frame-time-grouping'] : []),
    ...(frame?.accumulation?.required ? ['frame-accumulation'] : []),
    ...(frame?.ranking ? ['frame-ranking'] : []),
    ...(frame?.derivedMetrics || []).map((_, index) => 'frame-derived-' + (index + 1)),
    ...(frame?.requestedOutputs || []).map((_, index) => `frame-output-${index + 1}`),
  ];
}
