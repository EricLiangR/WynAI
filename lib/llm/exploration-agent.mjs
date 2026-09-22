function parseJson(content) {
  const text = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  if (!text) throw new Error('模型返回为空');
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error('模型未返回合法 JSON');
  }
}

function safeOutcome(outcome, maxRows) {
  const detail = ['projection', 'mining'].includes(outcome.request.mode);
  return {
    request: outcome.request,
    resultSet: {
      id: outcome.resultSet.id,
      schema: outcome.resultSet.schema,
      statistics: outcome.resultSet.statistics,
      scope: outcome.resultSet.scope,
      quality: outcome.resultSet.quality,
      rows: detail ? [] : outcome.resultSet.rows.slice(0, maxRows),
    },
  };
}

function numericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Number(String(value ?? '').replace(/[,，\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function measureEvidence(rows, schema, complete) {
  const evidence = {};
  for (const column of (schema || []).filter(item => /measure/.test(String(item?.role || '')))) {
    const values = rows.map(row => numericValue(row?.[column.name])).filter(value => value != null);
    if (!values.length) continue;
    const additive = ['sum', 'countRows'].includes(column.aggregation) || (rows.length === 1 && column.aggregation !== 'average');
    evidence[column.name] = {
      values,
      total: complete && additive ? values.reduce((sum, value) => sum + value, 0) : null,
      aggregation: column.aggregation || null,
    };
  }
  return evidence;
}

function monetaryClaims(text) {
  const claims = [];
  const pattern = /(?:人民币|美元|USD\s*)?(约为|大约|约)?\s*([0-9][\d,，]*(?:\.\d+)?)\s*(万|亿)?\s*(元|人民币|美元|USD)/giu;
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(Math.max(0, match.index - 12), match.index);
    if (/(?:>|<|≥|≤|大于|小于|超过|低于|高于|至少|至多|不低于|不超过)\s*$/.test(before)) continue;
    const rawNumber = match[2].replace(/[,，]/g, '');
    const number = Number(rawNumber);
    if (!Number.isFinite(number)) continue;
    const factor = match[3] === '亿' ? 1e8 : match[3] === '万' ? 1e4 : 1;
    const decimals = rawNumber.includes('.') ? rawNumber.length - rawNumber.indexOf('.') - 1 : 0;
    claims.push({
      source: match[0],
      value: number * factor,
      tolerance: match[1] ? 0.5 * factor * (10 ** -decimals) : Math.max(0.01, Math.abs(number * factor) * 1e-12),
      index: match.index,
    });
  }
  return claims;
}

function queryNumericThresholds(request) {
  return [...(request?.filters || []), ...(request?.resultFilters || [])]
    .flatMap(item => Array.isArray(item?.value) ? item.value : [item?.value])
    .filter(value => value != null && String(value).trim() !== '')
    .map(numericValue)
    .filter(value => value != null);
}

function isConditionThresholdClaim(text, claim, request) {
  const thresholds = queryNumericThresholds(request);
  if (!thresholds.some(value => Math.abs(value - claim.value) <= claim.tolerance)) return false;
  const before = text.slice(Math.max(0, claim.index - 48), claim.index);
  return /(?:[><=≥≤]|大于|小于|超过|低于|高于|至少|至多|不低于|不超过|等于|不等于)\s*$/.test(before)
    || /(?:筛选|过滤)?(?:条件|阈值|门槛)(?:为|是|[:：])\s*$/.test(before);
}

function duplicatedEnumLabels(text, request) {
  const duplicates = [];
  const values = [...(request?.filters || []), ...(request?.resultFilters || [])]
    .flatMap(item => Array.isArray(item?.value) ? item.value : [item?.value])
    .map(value => String(value ?? '').trim())
    .filter(Boolean);
  for (const value of values) {
    const match = value.match(/^(.+?)\s*[（(]\s*([^（）()]{1,24})\s*[）)]$/u);
    if (!match) continue;
    const fullName = match[1].trim();
    const abbreviation = match[2].trim();
    const nestedForms = [
      `${abbreviation}（${value}）`, `${abbreviation}(${value})`,
      `${fullName}（${value}）`, `${fullName}(${value})`,
    ];
    if (nestedForms.some(form => text.includes(form))) duplicates.push(value);
  }
  return [...new Set(duplicates)];
}

function narrationDeliveryErrors(result, delivery, fullResultProfile = null, request = null, schema = [], question = '') {
  if (!result || typeof result.summary !== 'string' || !result.summary.trim()) return ['摘要缺失'];
  const text = [result.summary, ...(Array.isArray(result.keyPoints) ? result.keyPoints : []), ...(Array.isArray(result.limitations) ? result.limitations : [])].join('\n');
  const errors = [];
  // Validate explicit delivery claims; never rewrite the model's answer here.
  for (const match of text.matchAll(/(?:仅|只)(?:能)?(?:展示|显示|返回|提供|列出|交付)(?:了)?\s*(?:前\s*)?([\d,，]+)\s*(?:条|行)/g)) {
    // The narrator may explicitly describe the bounded model preview. That is
    // not a claim about the rows delivered to the user and must not be rejected.
    const context = text.slice(Math.max(0, match.index - 32), Math.min(text.length, match.index + match[0].length + 32));
    if (/(?:模型).{0,16}(?:预览|样本)/.test(context)) continue;
    if (Number(match[1].replace(/[,，]/g, '')) !== delivery.returnedRows) errors.push('摘要把叙述样本行数误称为实际交付行数');
  }
  if (delivery.completeness === 'complete'
    && /(?:无法|不能)(?:完整)?(?:列出|展示|提供|返回)(?:全部|所有)|(?:仅|只)(?:能)?(?:展示|显示|返回|提供)(?:部分|样本|预览)/.test(text)
    && !/(?:共|合计|返回|包含|涉及)\s*[\d,，]+\s*(?:条|行)/.test(text)) {
    errors.push('完整交付结果不能被描述为只能提供部分记录');
  }
  const numericEvidence = Object.values(fullResultProfile?.measures || {}).flatMap(item => [
    ...(item.values || []),
    ...(item.total == null ? [] : [item.total]),
  ]);
  for (const claim of monetaryClaims(text)) {
    if (isConditionThresholdClaim(text, claim, request)) continue;
    if (!numericEvidence.some(value => Math.abs(value - claim.value) <= claim.tolerance)) {
      errors.push(`摘要金额缺少查询结果证据：${claim.source}`);
    }
  }
  // sourceField, displayName, and the result alias are different labels for
  // the same resolved column. The narration contract must not turn a label
  // preference into a failed business query. Technical-only fields remain
  // governed by the explicit prompt and schema boundary below.
  const forbiddenTechnicalField = /(?:trace(?:id|\s*id)?|prompt|systemprompt|modelcontrol|querymode|repairfeedback)/i;
  for (const column of schema || []) {
    const sourceField = String(column?.sourceField || '').trim();
    if (sourceField && forbiddenTechnicalField.test(sourceField) && text.includes(sourceField)) {
      errors.push(`摘要不得展示内部技术字段“${sourceField}”`);
    }
  }
  for (const value of duplicatedEnumLabels(text, request)) {
    errors.push(`摘要重复嵌套枚举全称与简称：${value}`);
  }
  return [...new Set(errors)];
}

const NARRATION_MAX_ATTEMPTS = 3;

function endpointHost(endpoint) {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'configured LLM endpoint';
  }
}

function transportError(error, endpoint, timedOut, timeoutMs) {
  if (timedOut) {
    const wrapped = new Error(`大模型请求超时 (${endpointHost(endpoint)}; ${timeoutMs}ms)`);
    wrapped.code = 'LLM_TIMEOUT';
    wrapped.cause = error;
    return wrapped;
  }
  const cause = error?.cause;
  const code = cause?.code || error?.code || '';
  const detail = cause?.message && cause.message !== error?.message ? cause.message : '';
  const target = endpointHost(endpoint);
  const diagnostics = [code, detail].filter(Boolean).join(': ');
  const wrapped = new Error(`大模型请求失败 (${target}${diagnostics ? `; ${diagnostics}` : ''}): ${error?.message || '未知网络错误'}`);
  wrapped.code = code || 'LLM_REQUEST_FAILED';
  wrapped.cause = error;
  return wrapped;
}

export function createExplorationLlm({
  baseUrl = '',
  apiKey = '',
  model = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = 180_000,
  maxOutputTokens = 4096,
  maxEvidenceRows = 20,
  enableThinking = null,
  transport = null,
} = {}) {
  const normalizedBase = String(baseUrl || '').replace(/\/$/, '');
  const enabled = Boolean(normalizedBase && model && fetchImpl);
  const endpoint = /\/chat\/completions$/i.test(normalizedBase) ? normalizedBase : `${normalizedBase}/chat/completions`;
  const requestTimeoutMs = Math.max(1, Number(timeoutMs) || 180_000);
  const outputTokenLimit = Math.max(256, Number(maxOutputTokens) || 4096);
  const evidenceRowLimit = Math.max(1, Math.min(50, Number(maxEvidenceRows) || 20));

  async function call(messages, { signal = null, operation = 'exploration', onEvent = null, cacheKey = undefined } = {}) {
    if (!enabled) throw new Error('未配置探索式分析大模型');
    if (typeof transport === 'function') return transport({ messages, signal, model, endpoint, apiKey, maxOutputTokens: outputTokenLimit, enableThinking, operation, onEvent, cacheKey });
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const abortFromCaller = () => {
      cancelled = true;
      controller.abort(signal?.reason);
    };
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            temperature: 0.1,
            max_tokens: outputTokenLimit,
            ...(typeof enableThinking === 'boolean' ? { enable_thinking: enableThinking } : {}),
            response_format: { type: 'json_object' },
            messages,
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (cancelled) {
          const wrapped = new Error('请求已取消');
          wrapped.code = 'REQUEST_ABORTED';
          wrapped.cause = error;
          throw wrapped;
        }
        throw transportError(error, endpoint, timedOut, requestTimeoutMs);
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || payload.message || `模型返回 ${response.status}`);
      const choice = payload.choices?.[0];
      const content = choice?.message?.content || payload.output_text || '';
      if (!String(content).trim()) {
        const finishReason = choice?.finish_reason || 'unknown';
        const completionTokens = payload.usage?.completion_tokens;
        throw new Error(`模型返回为空 (finish_reason=${finishReason}${Number.isFinite(completionTokens) ? `, completion_tokens=${completionTokens}` : ''})`);
      }
      return parseJson(content);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  async function probe() {
    const startedAt = Date.now();
    const result = await call([
      { role: 'system', content: 'This is a JSON connectivity check. Return only a JSON object with {"ok":true}.' },
      { role: 'user', content: 'Confirm connectivity.' },
    ]);
    return { ok: result?.ok === true, model, latencyMs: Date.now() - startedAt };
  }

  async function plan({ metadata, profile, focus, filters, skills = [], budget, validationError = '', previousPlan = null }) {
    const systemContent = validationError
      ? [
        '你是企业数据分析方法 Planner。上一个详细查询计划未通过校验，现在只选择分析方向，不再输出 requests。',
        '只输出 JSON：{intent,summary,methods,hypotheses}。',
        'intent 只能是 profitability/customer/product/anomaly/open，并应与用户问题一致。',
        'methods 只能从 profit_trend、profit_structure、customer_concentration、customer_region、product_portfolio、category_portfolio、anomaly_trend、open_trend、open_customer、open_product、open_region、operational_trend、operational_efficiency、compliance_rate、process_status、critical_response、outsourcing_performance 中选择。',
        'hypotheses 每项包含 id、question、businessValue、priority、requiredEvidence；不要输出 SQL、WAX、Payload、字段表达式或查询结构。',
      ].join('\n')
      : [
        '你是企业数据分析 Planner。根据用户问题和数据集语义生成差异化分析假设与 CanonicalQueryRequest。',
        '只输出合法 JSON 对象，包含 intent、summary、hypotheses、requests。',
        'intent 只能是 profitability/customer/product/anomaly/open。',
        'hypotheses 每项包含 id、question、businessValue、priority、requiredEvidence。',
        'requests 每项包含 id、hypothesisId、purpose、mode、topic、select、measures、filters、orderBy、limit。',
        'id 和 alias 只能使用英文字母、数字、连字符或下划线，id 必须以字母开头。',
        'mode 只能使用 aggregate/compare/verify/projection/mining；聚合只能使用 sum/average/min/max/countRows/distinctCount。',
        'select 最多包含 8 个字段；时间 grain 只能是 day/week/month/quarter/year，不支持 hour。',
        'orderBy.field 必须逐字等于某个 select.alias 或 measures.alias，不得使用未声明的利润率、变化率、移动平均等派生别名。',
        'filters 的 operator 只能使用 eq/neq/gt/gte/lt/lte/in/isNotNull/containsAny/containsAll/notContainsAny/notContainsAll；in 和四个多值字符串操作符最多 50 个同类型值。containsAny/containsAll/notContainsAny/notContainsAll 只用于字符串字段，表示字符串成员包含语义，不要把数组字符串当作普通标量等值。非空判断使用 isNotNull；当前不支持筛选空值。单值使用 eq，日期范围使用 gte/lt，不要用 in 枚举每日日期。TopN 请用 orderBy 和 limit 表达。',
        '只使用输入 fieldCatalog 中逐字存在的字段。不得输出 SQL、WAX、query、payload、pivotPayload、adapter 或任何执行语言。',
        '最多生成 5 个查询。问题明确时优先回答问题，不要固定生成月度趋势、类别贡献和区域贡献。',
        '收入与利润同时存在时，利润问题应同时查询二者以寻找反例；客户问题应使用客户字段；产品问题应使用产品或类别字段。',
        '运营数据集应优先使用字段描述中的时长、达标、准时、状态、委外和通知语义，不得把类型编码、状态编码或布尔编码解释为金额或利润。',
      ].join('\n');
    const result = await call([
      {
        role: 'system',
        content: systemContent,
      },
      {
        role: 'user',
        content: JSON.stringify({
          focus: focus || '未指定关注方向，请自主发现最有价值的经营问题',
          dataset: profile.dataset,
          capabilities: profile.capabilities,
          semanticRisks: profile.semanticRisks,
          fieldCatalog: profile.fieldCatalog,
          userFilters: filters,
          skills: skills.map(skill => ({ id: skill.id, version: skill.version, name: skill.name, fieldSemantics: skill.fieldSemantics || [], metrics: skill.metrics, businessEntities: skill.businessEntities, valueMappings: skill.valueMappings, workflows: skill.workflows, diagnostics: skill.diagnostics, assumptions: skill.assumptions, forbidden: skill.forbidden })),
          budget: { maxExplorationQueries: Math.min(5, Math.max(1, budget.maxQueries - 2)), maxRows: budget.maxAggregateRowsPerQuery },
          note: `datasetId=${metadata.id}，系统会另行注入质量与概览探针，不要重复生成基线查询`,
          validationFeedback: validationError || null,
          previousInvalidPlan: validationError ? previousPlan : null,
          repairInstruction: validationError ? '请根据用户问题选择 methods，不要再次输出 requests。' : null,
        }),
      },
    ]);
    return { plan: result, model };
  }

  async function critique({ profile, focus, skills = [], initialPlan, outcomes, remainingBudget, validationError = '', previousPlan = null }) {
    return call([
      {
        role: 'system',
        content: [
          '你是企业数据分析 Critic。评价查询结果是否支持假设，并仅在结果确实暴露了需要解释的信号时提出后续查询。',
          '只输出 JSON：{summary,assessments,hypotheses,requests}。',
          'assessment status 只能是 supported/rejected/inconclusive/needs_followup，并包含 hypothesisId、reason、triggerResultSetIds。',
          '后续 hypothesis 格式与 Planner 相同。后续 request 必须包含 lineage:{parentHypothesisId,triggerResultSetIds,reason}。',
          '每个 request.hypothesisId 必须引用 initialPlan.hypotheses 或本次 hypotheses 中逐字存在的 ID；新假设必须声明 parentHypothesisId。triggerResultSetIds 只能引用 outcomes 中真实存在的 resultSet.id。',
          'request 的 mode 只能是 aggregate/compare/verify；select 最多 8 个字段；时间 grain 只能是 day/week/month/quarter/year。',
          'select 分组只能使用 fieldCatalog 中 valueKind 为 categorical、boolean 或 temporal 的字段；continuous 与 duration 只能作为 measures。boolean 字段既可分组检查 0/1 分布，也可用 average 计算达标率。',
          '聚合只能是 sum/average/min/max/countRows/distinctCount，不支持 rollingMean、ratio、formula 或窗口函数。countRows 不得指定 field，且同一查询只能有一个 countRows；它只统计应用全部 filters/fieldComparisons 后的记录数。字段非空计数应拆成独立查询，使用 isNotNull 筛选后再 countRows。相同 field+aggregation 不得用多个 alias 重复查询，Top5/Top10 占比也不能靠重复 sum 伪造。',
          'orderBy.field 必须逐字等于某个 select.alias 或 measures.alias；需要利润率等派生判断时查询收入与利润原值，由程序计算，不得虚构派生排序字段。',
          'filters 的 operator 只能使用 eq/neq/gt/gte/lt/lte/in/isNotNull/containsAny/containsAll/notContainsAny/notContainsAll；in 和四个多值字符串操作符最多 50 个同类型值。containsAny/containsAll/notContainsAny/notContainsAll 只用于字符串字段，表示字符串成员包含语义，不要把数组字符串当作普通标量等值。非空判断使用 isNotNull；当前不支持筛选空值。单值使用 eq，日期范围使用 gte/lt，不要用 in 枚举每日日期。TopN 请用 orderBy 和 limit 表达。',
          '两个数据集字段之间的质量比较使用 fieldComparisons:[{left,operator,right}]；filters.value 只能是字面量，不能放另一个字段名。fieldComparisons 两端必须同为 temporal 或同为 numeric；时间顺序验证必须使用 fieldComparisons，不能只把两个时间字段放入 select。',
          '时间趋势必须过滤空时间与空指标；覆盖完整期间时优先使用 month 粒度，禁止用 day 粒度加很小 limit 后把早期片段解释成近期趋势。',
          '维度值若包含逗号、顿号或分号，应按“组合值”描述，不得把其中成员当成独立分组结论；优先选择单值业务维度。',
          '不得引入输入语义目录和结果证据中不存在的行业阈值、常规标准或外部事实。',
          '只能使用 fieldCatalog 中存在的字段以及受控 CanonicalQueryRequest，不得输出 SQL、WAX、Payload 或 adapter。',
          '最多提出 3 个查询，不要重复已经执行的查询。证据充分或没有显著信号时 requests 返回空数组。',
          '完整明细不会提供给你；不得猜测未输入的数据。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          focus: focus || '开放探索',
          fieldCatalog: profile.fieldCatalog,
          skills: skills.map(skill => ({ id: skill.id, version: skill.version, name: skill.name, defaultCalendar: skill.defaultCalendar || null, calendarPolicy: skill.calendarPolicy || null, fieldSemantics: skill.fieldSemantics || [], metrics: skill.metrics, workflows: skill.workflows, diagnostics: skill.diagnostics, assumptions: skill.assumptions, forbidden: skill.forbidden })),
          queryContract: {
            groupableFields: profile.fieldCatalog.filter(field => ['categorical', 'boolean', 'temporal'].includes(field.valueKind)).map(field => field.name),
            verifyIdentifierFields: profile.fieldCatalog.filter(field => field.valueKind === 'identifier').map(field => field.name),
            measureFields: profile.fieldCatalog.filter(field => ['continuous', 'duration', 'boolean'].includes(field.valueKind)).map(field => field.name),
          },
          initialPlan: { intent: initialPlan.intent, hypotheses: initialPlan.hypotheses, requests: initialPlan.requests },
          outcomes: outcomes.filter(item => !['projection', 'mining'].includes(item.request.mode)).map(item => safeOutcome(item, evidenceRowLimit)),
          remainingBudget,
          validationFeedback: validationError || null,
          previousInvalidCritique: validationError ? previousPlan : null,
          repairInstruction: validationError ? `必须修复校验错误“${validationError}”。删除无法由 Canonical 契约表达的查询，不得原样重试；countRows 不得指定 field 且同一查询只能出现一次；时间顺序只能比较两个 temporal 字段。` : null,
        }),
      },
    ]);
  }

  async function planQueryIntent({ metadata, question, previousIntent = null, previousRequest = null, skills = [], skillConflicts = [], semanticCatalog = null, supportedCapabilities = [], timeZone = 'Asia/Shanghai', currentDate = null, temporalReference = null, signal = null, repairFeedback = '', previousInvalidIntent = null, repairAttempt = 0, onEvent = null }) {
    return call([
      {
        role: 'system',
        content: [
          '你是企业问数意图解析器。把用户问题转换为 BusinessQueryIntent v2，只输出一个 JSON 对象。',
          '你只描述平台无关的业务意图，不得输出 SQL、WAX、query、payload、pivotPayload、HTML 或可执行图表代码。',
          '只使用 fieldCatalog 中逐字存在的字段名；不得杜撰字段、业务口径、筛选值或外部事实。',
          '输出字段：schema、businessQuestion、metrics、derivedMetrics、dimensions、filters、resultFilters、time、ranking、expectedResult、constraints、assumptions、confidence、skillRefs、mappingEvidence、ambiguities。不得输出 queryMode。你是唯一的自然语言语义理解者，不存在需要遵守的确定性语义候选；请根据用户问题、对话上下文、字段语义和 Skill 独立判断。',
          'schema 固定为 wynai.business-query-intent/v2。metrics 每项为 {field,aggregation,alias,concept,metricId,internal}；aggregation 仅限 sum/average/min/max/countRows/distinctCount。',
          '用户明确要求每条原始记录、原始明细、不聚合、不去重或保留重复行时，expectedResult.shape 必须为 detail-table，metrics、derivedMetrics 和 ranking 必须为空；所有需要返回的原始字段（包括数值和日期字段）放入 dimensions。其他汇总、统计、排名和去重名单使用 grouped-table、scalar 或相应结果形态。',
          '判断“列出对象”时按业务实体语义区分结果粒度：如果用户问的是“哪些商机/订单/交易/记录”并要求返回金额等源字段，且没有要求合计、总额、数量、统计、分组或排名，应把这些源字段作为 dimensions，使用逐条实体投影；如果用户问的是项目、客户、产品等汇总对象并要求金额，则按这些对象聚合。不要用表格名称或 queryMode 决定执行方式。',
          '这一条是强制的语义契约，不是可选的展示偏好：例如“去年 recurring 的商机有哪些，返回项目名称、客户名称、商机金额、recurring 类型”和“Risk Management 产品中 MNC 或 POE 客户的商机有哪些，返回客户名称、商机金额和项目名称”，其中“商机金额”是每条商机要展示的源字段，必须放入 dimensions，metrics 必须为空，expectedResult.shape 必须为 detail-table；不得把它写成 sum。只有“商机金额是多少”“按产品/客户统计商机金额”“总额/合计/数量/排名”等明确聚合语义，才把商机金额放入 metrics。',
          '公式派生指标只能使用已加载 Skill 中已有的 metricId、operator、dependencies、alias、skillRef 与 aggregationOrder，不得发明公式、修改依赖或输出公式字符串。基础依赖先聚合，再由平台计算派生指标。',
          'dimensions 每项为 {field,alias,grain,concept}，grain 只能为 null/day/week/month/quarter/year。只有用户明确要求按、以、各、每个、分别、列出、返回或展示某实体时，才把该实体作为输出维度；“某类实体的金额/数量”中的实体通常限定筛选范围，不得仅因被提及就自动分组。',
          'filters 是 Wyn 在源记录上执行的字段筛选，允许 eq/neq/gt/gte/lt/lte/in/isNotNull/containsAny/containsAll/notContainsAny/notContainsAll；后四个只用于字符串字段的多值成员包含语义。',
          'resultFilters 是基础分组聚合完成后的数值结果筛选，每项为 {field,operator,value}；field 必须逐字引用 metrics 或 derivedMetrics 的 alias，operator 只能为 eq/neq/gt/gte/lt/lte，value 必须为数字。例如“按产品统计总金额并筛选总金额大于1000万”应输出 resultFilters:[{field:"revenue",operator:"gt",value:10000000}]。不得把指标别名阈值放入源字段 filters。最高、最低、最热卖、最畅销、冠军、排名、前 N 等语义不是 resultFilters，必须写入 ranking。',
          'ranking 必须表达为 {source:<原问题中的排名表达>,orderBy:<metric alias>,direction:"asc|desc",limit:<整数>,percentage?:<数字>,partitionBy?:<维度 alias 数组>,thenDrilldown?:true,byDimension?:<维度 alias>,drilldownDimensions?:<维度 alias 数组>}。byDimension 是先按指标聚合并参与排名的业务对象，绝不能填写排名后才要列出的明细对象；drilldownDimensions 是固定胜出排名对象后才查询的返回维度，必须与 byDimension 不同。只要 thenDrilldown=true，就必须同时提供 byDimension 和非空 drilldownDimensions。该规则适用于任意业务领域。用户要求“最热卖产品及其客户”时，产品是 byDimension，客户是 drilldownDimensions；先按受 Skill 约定的指标完成产品排名，再把胜出产品作为后续 Wyn 查询的源端筛选条件查询客户。不得把客户反向作为排名对象，也不得把排名词写成聚合结果筛选。',
          '业务简称、枚举、字段绑定和默认口径只能依据当前数据集语义与已加载 Skill 的 valueMappings、workflows、assumptions、forbidden。先由你理解用户所指概念，再输出对应源字段、源值和操作符；不得将其它数据集的业务规则套用到本数据集。用户明确要求返回的字段必须逐项进入 dimensions 和 requiredDimensions，不得因其是日期或筛选字段而省略。',
          'time 为 {field,calendar,timeZone,periods,range,grain,grouping,explicit,modifier,groupedYears}，range 使用 {start,endExclusive} 的 YYYY-MM-DD 边界。时间过滤范围和时间分组是不同概念；“过去五年累计”只设置范围和累计语义，不得自动按年分组。时间表达应依据 temporal-semantics Skill 的概念解释；明确年月、年和月、月份、每个月等表达统一为 month，明确分别或层级展开才使用 year-month-hierarchy。',
          'expectedResult 必须明确 shape、minimumRows、maximumRows、requiredPeriods、requiredMetrics、requiredDimensions、timeZone。requiredMetrics 和 requiredDimensions 必须是字符串数组，其中每一项分别逐字引用 metrics 或 dimensions 中实际存在的 alias，不得输出序号、数量或字段位置。',
          'constraints 为用户每个显式要求的账本，逐项输出 {id,type,source,normalized,required,status}，status 只能 resolved/unresolved。聚合结果筛选的 normalized 必须为 {scope:"aggregate-result",field,operator,value}，且与 resultFilters 中的可执行条件逐项一致。',
          'filters 数组的各条条件按 AND 连接。同一多值字段列举多个备选成员时，用一条 containsAny 加完整成员数组表达并集；只有用户要求同时具备全部成员时才用 containsAll。不得拆成多个单值 containsAny 来表达任一匹配。',
          'currentDate 是本轮统一的业务日期锚点；temporalReference 是已配置日历的物化依据。时间筛选、time、expectedResult.requiredPeriods、约束账本与 assumptions 必须保持一致，不得沿用历史样例中的年份。',
          'temporalReference.scope=requested-period 表示 periods 已应用用户相对年份偏移，是最终查询期间；anchorFiscalYear 才是当前日期所属财年。不得对 periods 再做去年/前年偏移。时间范围粒度不等于时间分组；仅按产品等业务维度统计时，不增加时间分组。',
          'ambiguities 只能输出真正阻断查询的业务歧义对象，格式为 {id,slotId,question,options:[{label,concepts,mode}|string],blocking:true,required:true}；不要把“未指定但平台已有合理默认值”、币种默认、是否包含全部状态等说明放入 ambiguities，应放入 assumptions。若一个歧义已有明确默认且不影响当前查询执行，ambiguities 必须为空。已加载 Skill 声明 defaultCalendar=fiscal 时，未明确自然年的今年/去年/前年按赢单财年处理；明确自然年时按赢单日期处理，并在 assumptions 回显口径。',
          '明确列举多个年份并要求分别/逐年时按 year 分组；相对多年窗口只有出现每年/逐年/趋势才按 year 分组。修改式追问只改变用户明确提出的约束，继承 priorIntent 的其余约束与 skillRefs。',
          '“最高/最低/最大/最小”是 limit=1 的排名；“前五/后三”保留明确数量。商品类别、商品名称、地区、省份、城市属于不同层级，不得互换。',
          '“销售顾问”“销售代表”“业务员”“销售员”“销售经理”在字段目录只有员工姓名时，都映射到员工姓名这一销售人员维度；不要因为名称不同而产生维度歧义。',
          '只有用户明确使用“排名、排行、前N、后N、最高、最低、最大、最小、最多、最少、第一”等极值/排序表达时，才允许输出 ranking；“多少、是多少、总额、合计、营收、收入、销售额”本身绝不表示排名。普通“营收是多少”必须输出一个 sum 指标、空 dimensions、ranking=null、time.grouping=null、expectedResult.shape=scalar、expectedResult.maximumRows=1。',
          '标杆：问题“营收是多少”应映射为 metrics:[{field:"订单金额",aggregation:"sum",alias:"revenue",concept:"revenue",internal:false}], dimensions:[], filters:[], ranking:null；不要添加任何未被用户提出的约束。',
          '标杆：问题“销售额按年”必须在 dimensions 中加入 {field:"订购日期",alias:"year",grain:"year",concept:"time"}；问题“2025年每月销售额”必须加入同一时间字段且 grain:"month"，并用 time.range 过滤 2025-01-01 至 2026-01-01。',
          '若输入 validationFeedback 非空，这是上一版输出的校验错误；必须逐项修复并重新输出完整意图，不能重复原错误，也不能把普通总额问题改成排名问题。',
          '无法可靠解析的必需约束必须标为 unresolved，并在 ambiguities 中说明候选和需要用户确认的信息，不要猜测。',
          'skillConflicts 仅是结构化提示；请结合用户上下文选择正确业务口径，无法选择时输出 ambiguities，不要因为冲突直接套用字符串顺序。',
          '只允许映射到 supportedCapabilities 中已有的能力；能力不在列表中时输出 ambiguities 或 unsupported，不得自行创造新功能。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          question,
          timeZone,
          currentDate: currentDate || new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
          temporalReference,
          dataset: { id: metadata?.id, revision: metadata?.revision, name: metadata?.name },
          fieldCatalog: (metadata?.fields || []).map(field => ({
            name: field.name,
            displayName: field.displayName,
            role: field.role,
            type: field.type,
            rawType: field.rawType,
            description: field.description || field.semanticDescription || '',
            synonyms: field.synonyms || [],
          })),
          priorIntent: previousIntent,
          previousRequest,
          skillConflicts,
          validationFeedback: repairFeedback || null,
          previousInvalidIntent: repairFeedback ? previousInvalidIntent : null,
          repairAttempt,
          repairInstruction: repairFeedback ? '这是校验修复轮次：必须逐项修复 validationFeedback 并重新检查完整问题；若要求原始记录、不聚合或不去重，expectedResult.shape 必须为 detail-table，且不得增加任何聚合指标；若要求按年或按月，dimensions 必须包含对应日期字段和 grain，不能只设置 expectedResult；requiredMetrics 和 requiredDimensions 的每一项必须引用实际输出 alias；只有明确的数值阈值才同时写入 resultFilters 和 scope=aggregate-result 的结构化约束；排名、TopN、最高/最低和最热卖必须改为 ranking，不能写入 resultFilters。排名后下钻还必须重新核对：byDimension 是被指标排序的对象，drilldownDimensions 是固定胜出对象后才列出的信息，两者不得颠倒。' : null,
          semanticCatalog,
          supportedCapabilities,
          skillKnowledge: skills.map(skill => ({ id: skill.id, version: skill.version, name: skill.name, defaultCalendar: skill.defaultCalendar || null, calendarPolicy: skill.calendarPolicy || null, fieldSemantics: skill.fieldSemantics || [], temporalSemantics: skill.temporalSemantics || [], relativeTemporalSemantics: skill.relativeTemporalSemantics || [], metrics: skill.metrics, businessEntities: skill.businessEntities || [], valueMappings: skill.valueMappings || [], workflows: skill.workflows, diagnostics: skill.diagnostics, assumptions: skill.assumptions, forbidden: skill.forbidden })),
        }),
      },
    ], { signal, operation: 'intent', onEvent, cacheKey: repairFeedback ? null : undefined });
  }

  async function narrateQueryResult({ question, request, resultSet, intent = null, signal = null, onEvent = null }) {
    const allRows = Array.isArray(resultSet?.rows) ? resultSet.rows : [];
    const timeZone = resultSet?.scope?.timeZone || 'Asia/Shanghai';
    const dateColumns = new Set((resultSet?.schema || []).filter(field => field.type === 'date').map(field => field.name));
    const businessDate = value => {
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return value;
      try {
        return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
      } catch {
        return value;
      }
    };
    const displayRows = allRows.map(row => Object.fromEntries(
      Object.entries(row).map(([name, value]) => [name, dateColumns.has(name) && value != null ? businessDate(value) : value]),
    ));
    const previewRows = displayRows.slice(0, evidenceRowLimit);
    const deliveredRowCount = allRows.length;
    const sourceLimited = Boolean(resultSet?.quality?.isSample || resultSet?.quality?.isTruncated || resultSet?.quality?.limitReached);
    const userLimit = Boolean(resultSet?.quality?.userLimitApplied);
    const declaredTotal = resultSet?.quality?.totalRowCount ?? resultSet?.statistics?.totalRowCount;
    const totalRowCount = declaredTotal != null && Number.isSafeInteger(Number(declaredTotal)) && Number(declaredTotal) >= deliveredRowCount
      ? Number(declaredTotal) : sourceLimited ? null : deliveredRowCount;
    const delivery = {
      returnedRows: deliveredRowCount, totalRows: totalRowCount,
      isTruncated: sourceLimited || (!userLimit && totalRowCount != null && deliveredRowCount < totalRowCount),
      completeness: sourceLimited || totalRowCount == null || (!userLimit && totalRowCount > deliveredRowCount) ? 'limited' : 'complete',
    };
    const dimensionProfile = Object.fromEntries((resultSet?.schema || [])
      .filter(field => field?.role === 'dimension')
      .map(field => {
        const values = displayRows.map(row => row?.[field.name]).filter(value => value != null && value !== '');
        const uniqueValues = new Set(values.map(value => String(value)));
        const profile = { cardinality: uniqueValues.size };
        if (field.type === 'date' || field.grain) {
          const ordered = [...uniqueValues].sort((left, right) => left.localeCompare(right));
          profile.minimum = ordered[0] || null;
          profile.maximum = ordered.at(-1) || null;
        }
        return [field.name, profile];
      }));
    const measures = measureEvidence(displayRows, resultSet?.schema || [], delivery.completeness === 'complete');
    const narrationEvidence = {
      schema: resultSet?.schema || [],
      rows: previewRows,
      preview: {
        returnedRows: previewRows.length,
        totalRows: deliveredRowCount,
        isPartial: previewRows.length < deliveredRowCount,
      },
      delivery,
      fullResultProfile: {
        rowCount: deliveredRowCount,
        scope: 'delivered-result',
        dimensions: dimensionProfile,
        measures,
      },
      statistics: {
        ...(resultSet?.statistics || {}),
        ...Object.fromEntries(['minimums', 'maximums'].map(key => [key, Object.fromEntries(
          Object.entries(resultSet?.statistics?.[key] || {}).map(([name, value]) => [
            name, dateColumns.has(name) ? businessDate(value) : value,
          ]),
        )])),
      },
      quality: resultSet?.quality || {},
      scope: resultSet?.scope || {},
    };
    const messages = [
      {
        role: 'system',
        content: [
          '你是企业问数回答生成器。只能根据输入的已验证查询和结果回答用户。',
          '只输出 JSON：{summary,keyPoints,limitations}。summary 是简洁中文结论；keyPoints 和 limitations 都是字符串数组。',
          '不得添加结果中不存在的数字、实体、期间、指标定义或外部事实；不确定或结果为空时必须明确说明。',
          'resultSet.rows 是预览证据；当 resultSet.preview.isPartial=true 时，不得根据这些预览行推断全量数据的时间覆盖、极值、排名、趋势或分布。',
          'delivery.returnedRows 是实际交付行数，delivery.totalRows 是底层结果总行数；不得把 rows 的预览长度当作用户交付行数。',
          'preview 仅用于控制模型输入长度，不代表表格被截断。delivery.completeness=complete 时不得声称无法列出全部或仅提供样本。分页是展示机制，不改变交付范围。',
          'preview.returnedRows 是内部证据窗口，严禁在 summary、keyPoints 或 limitations 中提及该数字，也不得写“仅展示/返回/提供/列出前 N 条预览”。用户界面实际展示 delivery.returnedRows 行。',
          'delivery.completeness=limited 时，只能按 delivery 说明实际返回行数和范围限制；delivery.totalRows=null 时必须说底层总行数未知，不得猜测总量。',
          'fullResultProfile 只概括实际交付范围，不代表被截断的底层全集；totalRows=null 表示未知，不能写成0。',
          '全量行数、维度基数、时间边界和可加总指标总值只能使用 fullResultProfile；聚合数值范围只能使用 statistics。无法由全量概要证明的结论不要写。',
          '日期列已按 scope.timeZone 转为用户业务日期；不得从 UTC 时间戳截取日期或自行改变日期。',
          'summary、keyPoints 和 limitations 面向业务用户，字段必须使用 schema.displayName；除非用户问题原文明确使用源字段，否则不得展示 schema.sourceField、查询别名或内部查询模式。技术字段只在平台详情中展示。',
          '筛选枚举值若已经采用“全称（简称）”形式，直接使用该完整显示值，或只使用用户原文中的简称；不得生成“简称（全称（简称））”一类重复嵌套标签。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({ question, request, intent, resultSet: narrationEvidence }),
      },
    ];
    let result;
    for (let attempt = 0; attempt < NARRATION_MAX_ATTEMPTS; attempt += 1) {
      result = await call(messages, { signal, operation: 'intent', onEvent: event => onEvent?.({ ...event, operation: 'narration' }), cacheKey: attempt > 0 ? null : undefined });
      const errors = narrationDeliveryErrors(result, delivery, narrationEvidence.fullResultProfile, request, narrationEvidence.schema, question);
      if (!errors.length) break;
      if (attempt === NARRATION_MAX_ATTEMPTS - 1) throw Object.assign(new Error(`回答交付范围校验失败：${errors.join('；')}`), { code: 'NARRATION_DELIVERY_INVALID' });
      try { onEvent?.({ type: 'narration.repair', operation: 'narration', attempt: attempt + 1 }); } catch { /* observation must not change the answer */ }
      messages.push({ role: 'assistant', content: JSON.stringify(result) });
      messages.push({ role: 'user', content: JSON.stringify({
        repairFeedback: errors,
        delivery,
        forbiddenInternalPreviewRowCount: previewRows.length,
        instruction: '重新生成答案。完全删除内部证据预览及其行数；只使用 delivery.returnedRows 描述用户表格的实际行数。金额结论必须逐字依据 fullResultProfile.measures 中的值或总值，不能估算或改写为不一致的精确金额。可以原样说明 request.filters/resultFilters 中的查询阈值，但必须明确写成筛选条件或阈值，不得把阈值写成查询结果金额。字段名称使用 schema.displayName；除非用户问题原文明确使用源字段，否则不得展示 schema.sourceField、查询别名或内部查询模式。枚举值已包含“全称（简称）”时不得再次嵌套全称和简称。若 completeness=limited，明确结果范围受限；若 totalRows=null，明确底层总行数未知。不得复述上一版错误表述。',
      }) });
    }
    return {
      summary: typeof result?.summary === 'string' ? result.summary.trim().slice(0, 2000) : '',
      keyPoints: Array.isArray(result?.keyPoints) ? result.keyPoints.filter(item => typeof item === 'string').slice(0, 8) : [],
      limitations: Array.isArray(result?.limitations) ? result.limitations.filter(item => typeof item === 'string').slice(0, 8) : [],
    };
  }

  // Reuse the guarded transport for feature-specific JSON orchestrators.
  async function completeJson(messages, { signal = null, operation = 'exploration', onEvent = null } = {}) {
    return call(messages, { signal, operation, onEvent });
  }

  return { enabled, model: enabled ? model : null, probe, plan, critique, planQueryIntent, narrateQueryResult, completeJson };
}
