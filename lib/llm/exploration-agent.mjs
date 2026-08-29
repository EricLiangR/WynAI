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
  const detail = ['detail', 'mining'].includes(outcome.request.mode);
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

  async function call(messages, { signal = null, operation = 'exploration', onEvent = null } = {}) {
    if (!enabled) throw new Error('未配置探索式分析大模型');
    if (typeof transport === 'function') return transport({ messages, signal, model, endpoint, apiKey, maxOutputTokens: outputTokenLimit, enableThinking, operation, onEvent });
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
        'mode 只能使用 aggregate/compare/verify/detail/mining；聚合只能使用 sum/average/min/max/countRows/distinctCount。',
        'select 最多包含 8 个字段；时间 grain 只能是 day/week/month/quarter/year，不支持 hour。',
        'orderBy.field 必须逐字等于某个 select.alias 或 measures.alias，不得使用未声明的利润率、变化率、移动平均等派生别名。',
        'filters 的 operator 只能使用 eq/neq/gt/gte/lt/lte/in/isNotNull；in 最多 50 个同类型值。非空判断使用 isNotNull；当前不支持筛选空值。单值使用 eq，日期范围使用 gte/lt，不要用 in 枚举每日日期。TopN 请用 orderBy 和 limit 表达。',
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
          skills: skills.map(skill => ({ id: skill.id, version: skill.version, name: skill.name, metrics: skill.metrics, workflows: skill.workflows, diagnostics: skill.diagnostics, assumptions: skill.assumptions, forbidden: skill.forbidden })),
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
          'filters 的 operator 只能使用 eq/neq/gt/gte/lt/lte/in/isNotNull；in 最多 50 个同类型值。非空判断使用 isNotNull；当前不支持筛选空值。单值使用 eq，日期范围使用 gte/lt，不要用 in 枚举每日日期。TopN 请用 orderBy 和 limit 表达。',
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
          skills: skills.map(skill => ({ id: skill.id, version: skill.version, name: skill.name, metrics: skill.metrics, workflows: skill.workflows, diagnostics: skill.diagnostics, assumptions: skill.assumptions, forbidden: skill.forbidden })),
          queryContract: {
            groupableFields: profile.fieldCatalog.filter(field => ['categorical', 'boolean', 'temporal'].includes(field.valueKind)).map(field => field.name),
            verifyIdentifierFields: profile.fieldCatalog.filter(field => field.valueKind === 'identifier').map(field => field.name),
            measureFields: profile.fieldCatalog.filter(field => ['continuous', 'duration', 'boolean'].includes(field.valueKind)).map(field => field.name),
          },
          initialPlan: { intent: initialPlan.intent, hypotheses: initialPlan.hypotheses, requests: initialPlan.requests },
          outcomes: outcomes.filter(item => !['detail', 'mining'].includes(item.request.mode)).map(item => safeOutcome(item, evidenceRowLimit)),
          remainingBudget,
          validationFeedback: validationError || null,
          previousInvalidCritique: validationError ? previousPlan : null,
          repairInstruction: validationError ? `必须修复校验错误“${validationError}”。删除无法由 Canonical 契约表达的查询，不得原样重试；countRows 不得指定 field 且同一查询只能出现一次；时间顺序只能比较两个 temporal 字段。` : null,
        }),
      },
    ]);
  }

  async function planQueryIntent({ metadata, question, previousIntent = null, skills = [], timeZone = 'Asia/Shanghai', deterministicIntent = null, signal = null }) {
    return call([
      {
        role: 'system',
        content: [
          '你是企业问数意图解析器。把用户问题转换为 BusinessQueryIntent v2，只输出一个 JSON 对象。',
          '你只描述平台无关的业务意图，不得输出 SQL、WAX、query、payload、pivotPayload、HTML 或可执行图表代码。',
          '只使用 fieldCatalog 中逐字存在的字段名；不得杜撰字段、业务口径、筛选值或外部事实。',
          '输出字段：schema、businessQuestion、metrics、derivedMetrics、dimensions、filters、time、ranking、expectedResult、constraints、assumptions、confidence。输入中的 questionSemanticFrame 是原问题约束基线，禁止遗漏或改变其含义。',
          'schema 固定为 wynai.business-query-intent/v2。metrics 每项为 {field,aggregation,alias,concept,metricId,internal}；aggregation 仅限 sum/average/min/max/countRows/distinctCount。',
          '公式派生指标只能逐字保留 deterministicCandidate 和已审批 skillKnowledge 中已有的 metricId、operator、dependencies、alias、skillRef 与 aggregationOrder，不得发明公式、修改依赖或输出公式字符串。基础依赖先聚合，再由平台计算派生指标。',
          'dimensions 每项为 {field,alias,grain,concept}，grain 只能为 null/day/week/month/quarter/year。filters 仅允许 eq/neq/gt/gte/lt/lte/in/isNotNull。',
          'time 为 {field,calendar,timeZone,periods,range,grain,grouping,explicit,modifier,groupedYears}，range 使用 {start,endExclusive} 的 YYYY-MM-DD 边界。时间过滤范围和时间分组是不同概念；“过去五年累计”只设置范围和累计语义，不得自动按年分组。时间表达应依据 temporal-semantics Skill 的概念解释；明确年月、年和月、月份、每个月等表达统一为 month，明确分别或层级展开才使用 year-month-hierarchy。',
          'expectedResult 必须明确 shape、minimumRows、maximumRows、requiredPeriods、requiredMetrics、requiredDimensions、timeZone。',
          'constraints 为用户每个显式要求的账本，逐项输出 {id,type,source,normalized,required,status}，status 只能 resolved/unresolved。',
          '明确列举多个年份并要求分别/逐年时按 year 分组；相对多年窗口只有出现每年/逐年/趋势才按 year 分组。修改式追问只改变用户明确提出的约束，继承 priorIntent 的其余约束与 skillRefs。',
          '“最高/最低/最大/最小”是 limit=1 的排名；“前五/后三”保留明确数量。商品类别、商品名称、地区、省份、城市属于不同层级，不得互换。',
          '无法可靠解析的必需约束必须标为 unresolved，不要猜测。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          question,
          timeZone,
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
          skillKnowledge: skills.map(skill => ({ id: skill.id, version: skill.version, name: skill.name, temporalSemantics: skill.temporalSemantics || [], metrics: skill.metrics, workflows: skill.workflows, diagnostics: skill.diagnostics, assumptions: skill.assumptions, forbidden: skill.forbidden })),
          deterministicCandidate: deterministicIntent,
          questionSemanticFrame: deterministicIntent?.semanticFrame || null,
        }),
      },
    ], { signal, operation: 'intent' });
  }

  // Reuse the guarded transport for feature-specific JSON orchestrators.
  async function completeJson(messages, { signal = null, operation = 'exploration', onEvent = null } = {}) {
    return call(messages, { signal, operation, onEvent });
  }

  return { enabled, model: enabled ? model : null, probe, plan, critique, planQueryIntent, completeJson };
}
