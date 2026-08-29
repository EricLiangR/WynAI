const NUMBER_WORDS = new Map([
  ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4], ['五', 5],
  ['六', 6], ['七', 7], ['八', 8], ['九', 9], ['十', 10],
]);

const METRIC_PATTERNS = [
  { concept: 'profit', pattern: /利润|毛利(?!率)|盈利/, source: '利润' },
  { concept: 'revenue', pattern: /销售额|销售收入|营收|收入|订单金额|销售(?!利润|毛利率|员|经理|代表|城市|区域|省份)/, source: '销售额' },
  { concept: 'orderCount', pattern: /订单(?:数量|数|量|笔数)|下单(?:数量|数|量)/, source: '订单数' },
  { concept: 'quantity', pattern: /销量|销售数量|购买数量|件数|(?<!订单)数量/, source: '销量' },
];

const DIMENSION_PATTERNS = [
  { concept: 'headquarterProvince', level: 'province', entity: 'organization', pattern: /总部(?:所在)?省份?|总部所在地区/ },
  { concept: 'customerProvince', level: 'province', entity: 'customer-geography', pattern: /客户(?:所在)?省份?|销售省份|收货省份/ },
  { concept: 'city', level: 'city', entity: 'customer-geography', pattern: /客户(?:所在)?城市|销售城市|城市/ },
  { concept: 'province', level: 'province', entity: 'geography', pattern: /(?:各|每个|每一)?省份?|省级/ },
  { concept: 'region', level: 'region', entity: 'customer-geography', pattern: /客户地区|销售大区|大区|销售区域|区域|地区/ },
  { concept: 'category', level: 'category', entity: 'product', pattern: /每(?:一)?类(?:商品|产品)?|各类(?:商品|产品)?|商品种类|产品种类|商品类别|产品类别|品类|类别/ },
  // “产品销量/商品销量” is a metric phrase. Do not turn its entity prefix
  // into an additional product dimension when extracting dimensions.
  { concept: 'product', level: 'item', entity: 'product', pattern: /商品名称|产品名称|(?:商品|产品)(?!类别|种类|销量|销售数量|购买数量)/ },
  { concept: 'customer', level: 'customer', entity: 'customer', pattern: /客户名称|顾客|客户(?!城市|省份|地区|区域|编号)/ },
  { concept: 'supplier', level: 'supplier', entity: 'supplier', pattern: /供应商/ },
  { concept: 'employee', level: 'employee', entity: 'employee', pattern: /员工(?:姓名)?|销售经理|销售员|业务员|销售代表/ },
  { concept: 'payment', level: 'payment', entity: 'order', pattern: /支付方式|付款方式/ },
  { concept: 'shipper', level: 'shipper', entity: 'order', pattern: /运货商|承运商/ },
];

function matchSource(text, pattern, fallback) {
  const matcher = pattern.global ? pattern : new RegExp(pattern.source, pattern.flags + 'g');
  const matches = [...String(text || '').matchAll(matcher)].map(match => match[0]).filter(Boolean);
  return matches.sort((left, right) => right.length - left.length)[0] || fallback;
}

function parseRanking(text) {
  const percent = text.match(/(?:前|top\s*)(\d{1,3})\s*%/i) || text.match(/(?:后|倒数|bottom\s*)(\d{1,3})\s*%/i);
  if (percent) return {
    source: percent[0],
    limit: 20000,
    percentage: Math.max(1, Math.min(100, Number(percent[1]))),
    direction: /后|倒数|bottom/i.test(percent[0]) ? 'asc' : 'desc',
    kind: 'rank-percentage',
    explicit: true,
  };
  const top = text.match(/(?:前|top\s*)(\d{1,3}|[一二两三四五六七八九十])(?:名|个|项|位)?/i);
  const bottom = text.match(/(?:后|倒数)(\d{1,3}|[一二两三四五六七八九十])(?:名|个|项|位)?/i);
  const explicit = top || bottom;
  if (explicit) return {
    source: explicit[0],
    limit: Math.max(1, Math.min(100, Number(explicit[1]) || NUMBER_WORDS.get(explicit[1]) || 10)),
    direction: bottom ? 'asc' : 'desc',
    kind: 'rank',
    explicit: true,
  };
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

function parseFormulaDerivedMetrics(text, skills = []) {
  const matches = [];
  for (const skill of skills || []) {
    if (skill.status && skill.status !== 'approved') continue;
    for (const metric of skill.metrics || []) {
      if (!metric.formula) continue;
      const terms = [metric.name, metric.id, ...(metric.synonyms || [])]
        .map(value => String(value || '').trim()).filter(Boolean).sort((left, right) => right.length - left.length);
      const source = terms.find(term => text.includes(term));
      if (!source) continue;
      matches.push({
        type: 'formula',
        operator: metric.formula.operator,
        metricId: metric.id,
        concept: metric.concept || metric.id,
        source,
        alias: metric.outputAlias || metric.id,
        dependencyMetricIds: [...(metric.formula.inputs || [])],
        resultType: metric.unitFamily === 'percentage' ? 'percentage' : 'number',
        unitFamily: metric.unitFamily || null,
        aggregationOrder: metric.formula.aggregationOrder || 'aggregate-then-calculate',
        zeroDivision: metric.formula.zeroDivision || 'null',
        skillRef: skill.id && skill.version ? `${skill.id}@${skill.version}` : null,
        required: true,
      });
    }
  }
  return matches.filter((item, index, values) => values.findIndex(value => value.alias === item.alias) === index);
}

function parseVisualizationIntent(text) {
  const patterns = [
    ['none', /不要图表|无需图表|只(?:要|显示|看)?(?:明细)?表格/],
    ['combo', /柱线|组合图|双轴/],
    ['stacked-column', /堆叠(?:柱形图|柱状图|柱图|条形图)/],
    ['donut', /环形图|圆环图/],
    ['pie', /饼图|饼状图/],
    ['bar', /横向(?:条形图|柱状图)|条形图/],
    ['column', /柱形图|柱状图/],
    ['line', /折线图|趋势线|曲线图/],
  ];
  for (const [type, pattern] of patterns) {
    const match = text.match(pattern);
    if (match) return { type, source: match[0], explicit: true };
  }
  return null;
}

function parseDerivedMetrics(text, metrics, dimensions, skills = []) {
  const matches = parseFormulaDerivedMetrics(text, skills);
  const conceptTerms = [
    { concept: 'revenue', terms: ['销售收入', '销售额', '营收', '收入'] },
    { concept: 'profit', terms: ['订单利润', '利润', '毛利'] },
    { concept: 'orderCount', terms: ['订单数量', '订单笔数', '订单数', '订单量'] },
    { concept: 'quantity', terms: ['销售数量', '购买数量', '销量'] },
  ];
  const termMatches = value => conceptTerms.flatMap(item => item.terms
    .flatMap(term => [...value.matchAll(new RegExp(term, 'g'))].map(match => ({ concept: item.concept, term, index: match.index ?? -1 }))))
    .sort((left, right) => left.index - right.index);
  const explicitBindings = before => {
    const clause = before.split(/[；;。！？!?]/).at(-1) || before;
    const local = clause.slice(-80).replace(/[\s，,、；;：:]+$/g, '').replace(/的$/g, '');
    const mentioned = termMatches(local);
    if (!mentioned.length) return [];
    const last = mentioned.at(-1);
    const tail = local.slice(last.index + last.term.length);
    // With multiple preceding measures, a bare trailing "同比" is ambiguous:
    // it may qualify only the last item or every item in the enumeration. Do
    // not silently pick the last measure; the clarification state owns it.
    if (/^[\s的]*$/.test(tail)) {
      const repeatedExplicitMetric = mentioned.filter(item => item.concept === last.concept).length > 1;
      return mentioned.length === 1 || repeatedExplicitMetric ? [last.concept] : [];
    }
    if (/^[\s的]*(?:和|与|及)[\s]*$/.test(tail) && mentioned.length === 1) return [last.concept];
    const relationScope = local.slice(Math.max(0, mentioned[0].index));
    if (/(?:分别|各自|都|均|全部|一起)(?:计算|看|做|分析)?\s*$/.test(relationScope)) return [...new Set(mentioned.map(item => item.concept))];
    return [];
  };
  let relationIndex = 0;
  for (const match of text.matchAll(/同比(?:增长率|增幅)?|环比(?:增长率|增幅)?/g)) {
    relationIndex += 1;
    const type = match[0].startsWith('同比') ? 'yoy' : 'mom';
    const before = text.slice(0, match.index);
    const clause = text.slice(Math.max(0, Math.max(before.lastIndexOf('；'), before.lastIndexOf('。')) + 1), match.index + match[0].length);
    const allRequested = /(?:各(?:项|个)?指标|以上指标|这些指标|所有指标|全部指标).*(?:同比|环比)|(?:都|均|全部|各自|分别)(?:计算|看|做|分析)?\s*(?:同比|环比)/.test(clause);
    const explicitConcepts = explicitBindings(before);
    const requestedConcepts = allRequested
      ? [...new Set(metrics.map(item => item.concept).filter(Boolean))]
      : explicitConcepts.length ? explicitConcepts
        : metrics.length === 1 ? [metrics[0].concept]
          : [];
    if (!requestedConcepts.length) {
      matches.push({
        slotId: `derived-binding:${type}:${relationIndex}`,
        type,
        source: match[0],
        sourceConcept: null,
        alias: `unresolved_${type}_binding`,
        bindingCandidates: [...new Set(metrics.map(item => item.concept).filter(Boolean))],
        offset: 1,
        resultType: 'percentage',
        required: true,
        status: 'unresolved',
      });
      continue;
    }
    for (const sourceConcept of requestedConcepts) matches.push({
      slotId: `derived-binding:${type}:${relationIndex}:${sourceConcept}`,
      type,
      source: match[0],
      sourceConcept,
      alias: sourceConcept + '_' + type,
      offset: 1,
      resultType: 'percentage',
      required: true,
      status: 'resolved',
    });
  }
  const composition = text.match(/占比|份额|构成(?:占比|分布)?|比例分布/);
  if (composition) {
    const before = text.slice(0, composition.index);
    const mentioned = termMatches(before);
    const sourceConcept = mentioned.at(-1)?.concept || (metrics.length === 1 ? metrics[0].concept : null);
    const shareDimensionConcept = dimensions.at(-1)?.concept || null;
    matches.push({
      slotId: `derived-binding:share-of-total:${sourceConcept || 'unresolved'}`,
      type: 'share-of-total',
      source: composition[0],
      sourceConcept,
      shareDimensionConcept,
      alias: sourceConcept ? `${sourceConcept}_share` : 'unresolved_share_binding',
      bindingCandidates: sourceConcept ? undefined : [...new Set(metrics.map(item => item.concept).filter(Boolean))],
      denominatorScope: 'filtered-result',
      resultType: 'percentage',
      unitFamily: 'percentage',
      required: true,
      status: sourceConcept && shareDimensionConcept ? 'resolved' : 'unresolved',
    });
  }
  const unknownRate = text
    .split(/[，,、；;。！？!?\s]+|(?:以及|并且|同时|和|与|及)/)
    .map(value => value.replace(/^(?:请|帮我|分析|统计|查看|查询|计算|展示|显示|比较|对比|想看|需要)/, ''))
    .map(value => value.match(/[一-龥A-Za-z]{2,12}(?:率|占比|比例)$/)?.[0] || null)
    .find(Boolean) || null;
  if (unknownRate && !composition && !matches.some(item => unknownRate.includes(item.source) || String(item.source).includes(unknownRate))) {
    matches.push({
      type: 'formula',
      metricId: null,
      concept: null,
      source: unknownRate,
      alias: 'unresolved_formula_metric',
      dependencyMetricIds: [],
      resultType: 'percentage',
      unitFamily: 'percentage',
      skillRef: null,
      required: true,
      status: 'unresolved',
    });
  }
  return matches.filter((item, index, values) => values.findIndex(value => value.alias === item.alias) === index);
}
function requestedOutputs(text, metrics, dimensions, ranking, derivedMetrics = []) {
  const outputs = [];
  for (const dimension of dimensions) outputs.push({ kind: 'entity', concept: dimension.concept, source: dimension.source, required: true });
  for (const metric of metrics) outputs.push({ kind: 'metric', concept: metric.concept, source: metric.source, required: true });
  for (const metric of derivedMetrics) outputs.push({ kind: 'derived-metric', concept: metric.concept || metric.sourceConcept, derivation: metric.type, alias: metric.alias, source: metric.source, required: true });
  if (ranking && !outputs.some(item => item.kind === 'entity')) {
    outputs.push({ kind: 'entity', concept: null, source: ranking.source, required: true, status: 'unresolved' });
  }
  return outputs;
}

export function extractQuestionSemanticFrame(question, { time = null, skills = [] } = {}) {
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
    if (item.concept === 'product' && dimensions.some(value => value.concept === 'category') && /^(?:产品|商品)$/.test(source)) continue;
    if (item.concept === 'province' && dimensions.some(value => ['customerProvince', 'headquarterProvince'].includes(value.concept))) continue;
    dimensions.push({ concept: item.concept, level: item.level, entity: item.entity, source, required: true });
  }
  dimensions.sort((left, right) => text.indexOf(left.source) - text.indexOf(right.source));
  const rankingBase = parseRanking(text);
  const partitionBy = rankingBase && time?.grouping
    ? ['period']
    : rankingBase && /每(?:个|一)?[^，,。]{0,12}(?:最高|最低|最大|最小|最多|最少)/.test(text) && dimensions.length > 1
      ? [dimensions[0].concept]
      : [];
  const ranking = rankingBase ? { ...rankingBase, partitionBy } : null;
  const derivedMetrics = parseDerivedMetrics(text, metrics, dimensions, skills);
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
    visualizationIntent: parseVisualizationIntent(text),
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
    ...(frame?.visualizationIntent?.explicit ? ['frame-visualization'] : []),
    ...(frame?.derivedMetrics || []).map((_, index) => 'frame-derived-' + (index + 1)),
    ...(frame?.requestedOutputs || []).map((_, index) => `frame-output-${index + 1}`),
  ];
}
