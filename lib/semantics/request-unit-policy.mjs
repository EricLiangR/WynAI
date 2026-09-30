const UNIT_STATUSES = new Set(['executable', 'unsupported', 'ambiguous', 'invalid']);
const UNIT_KINDS = new Set(['metric', 'dimension', 'filter', 'projection', 'ranking', 'derived', 'visualization']);
const UNIT_CRITICALITIES = new Set(['scope-defining', 'dependency', 'required-output', 'optional-output', 'independent']);

function list(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

function normalizeUnit(value, index) {
  const status = UNIT_STATUSES.has(value?.status) ? value.status : 'executable';
  const kind = UNIT_KINDS.has(value?.kind) ? value.kind : 'projection';
  const criticality = UNIT_CRITICALITIES.has(value?.criticality)
    ? value.criticality
    : ['filter', 'ranking'].includes(kind) ? 'scope-defining'
      : kind === 'derived' ? 'dependency' : 'required-output';
  return {
    id: text(value?.id) || `request-unit-${index + 1}`,
    kind,
    sourceText: text(value?.sourceText || value?.source),
    status,
    criticality,
    reason: text(value?.reason) || null,
    field: text(value?.field) || null,
    alias: text(value?.alias) || null,
    dependencies: [...new Set(list(value?.dependencies).map(text).filter(Boolean))],
  };
}

export function normalizeRequestUnits(value) {
  return list(value).slice(0, 32).map(normalizeUnit);
}

function unitMatches(unit, item) {
  const identities = new Set([
    item?.field,
    item?.fieldRef,
    item?.alias,
    item?.concept,
    item?.metricId,
    item?.source,
    item?.byDimension,
    item?.orderBy,
    ...list(item?.drilldownDimensions),
  ].map(text).filter(Boolean));
  if (identities.has(unit.field) || identities.has(unit.alias)) return true;
  // A time scope such as “所有财年” is executable without a source filter.
  // It still needs to be represented by the structured time contract so the
  // request unit is not mistaken for an omitted filter. Match the model's
  // declared phrase to the structured time phrase; do not infer a business
  // condition from the raw user question here.
  if (unit.kind === 'filter' && !unit.field && !unit.alias && item?.scopePolicy
      && text(unit.sourceText) && text(item.source)
      && (text(item.source).includes(text(unit.sourceText)) || text(unit.sourceText).includes(text(item.source)))) return true;
  return false;
}

function isExecutableRanking(ranking) {
  return Boolean(
    ranking
    && text(ranking.source)
    && text(ranking.orderBy)
    && ['asc', 'desc'].includes(text(ranking.direction))
    && Number.isInteger(Number(ranking.limit))
    && Number(ranking.limit) > 0
  );
}

function executableTimeTargets(output) {
  const time = output?.time;
  if (!time?.field) return [];
  const hasScope = list(time.periods).length > 0
    || Boolean(time.range?.start || time.range?.endExclusive)
    || Boolean(text(time.modifier) || text(time.scopePolicy));
  return hasScope
    ? [{ field: time.field, fieldRef: time.field, alias: time.field, concept: 'time', source: time.source || null, scopePolicy: time.scopePolicy || null }]
    : [];
}

function executableUnitTarget(output, unit) {
  if (unit.kind === 'metric') return list(output.metrics);
  if (unit.kind === 'dimension') return list(output.dimensions);
  if (unit.kind === 'projection') {
    const dimensions = list(output.dimensions);
    // A list request such as “有哪些商机” is an output-grain request, not
    // a request for a field literally named “有哪些”. The LLM expresses the
    // requested grain through one or more dimensions; there is no field-level
    // identity to compare when the projection unit has no field or alias.
    if (!unit.field && !unit.alias) {
      // Shape is a presentation contract and may be absent or temporarily
      // normalized by the LLM repair path. The semantic evidence is the
      // resolved non-internal business projection itself; requiring a shape
      // label here caused valid list requests to fail before Wyn was called.
      return dimensions.some(item => !item?.internal) ? [dimensions[0]] : [];
    }
    return dimensions;
  }
  // A filter request can be applied either to source rows or to a grouped
  // aggregate result. Both are executed by the query adapter; excluding
  // resultFilters here would reject valid HAVING-style requests before Wyn.
  if (unit.kind === 'filter') {
    // Time filters are represented by the structured time contract before
    // they are materialized into ordinary Canonical filters. Treat that
    // contract as executable coverage so a valid relative-period request is
    // not rejected merely because it has not reached compilation yet.
    return [...list(output.filters), ...list(output.resultFilters), ...executableTimeTargets(output)];
  }
  if (unit.kind === 'derived') return list(output.derivedMetrics);
  if (unit.kind === 'ranking') return isExecutableRanking(output.ranking) ? [output.ranking] : [];
  return null;
}

function materializeExecutableProjectionUnits(output, knownFields) {
  const dimensions = [...list(output.dimensions)];
  const represented = unit => dimensions.some(item => unitMatches(unit, item));
  for (const unit of normalizeRequestUnits(output.requestUnits)) {
    if (unit.status !== 'executable' || !['dimension', 'projection'].includes(unit.kind)) continue;
    if (!unit.field || !knownFields.has(unit.field) || represented(unit)) continue;
    dimensions.push({
      field: unit.field,
      alias: unit.alias || unit.field,
      concept: null,
      grain: null,
      internal: false,
    });
  }
  return dimensions.length === list(output.dimensions).length ? output : { ...output, dimensions };
}

export function executableRequestUnitCoverageErrors(output = {}) {
  const units = normalizeRequestUnits(output.requestUnits);
  const missing = units.filter(unit => {
    if (unit.status !== 'executable' || unit.kind === 'visualization') return false;
    const targets = executableUnitTarget(output, unit);
    if (targets == null) return false;
    if (unit.kind === 'ranking') return targets.length === 0;
    if (unit.kind === 'projection' && !unit.field && !unit.alias) return targets.length === 0;
    return !targets.some(item => unitMatches(unit, item));
  });
  return missing.map(unit => `requestUnits 声明为可执行的要求未进入实际查询意图：${unit.sourceText || unit.field || unit.alias || unit.id}（${unit.kind}）`);
}

export function compiledRequestUnitCoverageErrors(intent = {}, compiled = {}) {
  const request = compiled?.request || compiled?.queryProgram?.baseQuery || {};
  const staged = compiled?.queryProgram?.stagedQuery;
  const stagedDrilldownDimensions = staged?.type === 'wyn-rank-then-drilldown'
    ? list(staged.drilldownDimensions)
    : [];
  const derivedShareFilters = list(compiled?.queryProgram?.steps)
    .filter(step => step?.type === 'derive-share-of-total' && step?.shareDimensionAlias && list(step.selectedValues).length)
    .map(step => {
      const dimension = list(request.select).find(item => item?.alias === step.shareDimensionAlias);
      const field = dimension?.field || step.shareDimensionAlias;
      return { field, fieldRef: field, operator: 'eq', value: step.selectedValues[0] };
    });
  const executionView = {
    requestUnits: intent.requestUnits,
    metrics: list(request.measures),
    dimensions: [...list(request.select), ...stagedDrilldownDimensions],
    filters: [...list(request.filters), ...derivedShareFilters],
    resultFilters: list(request.resultFilters),
    // Relative and open-ended time scopes are compiled as a structured
    // contract before they become ordinary source filters. Keep that
    // contract in the final execution view so a valid no-filter scope such
    // as “所有财年” is not reported as an omitted request unit.
    time: compiled?.intent?.time || intent.time || null,
    derivedMetrics: list(compiled?.intent?.derivedMetrics || intent.derivedMetrics),
    ranking: compiled?.intent?.ranking || intent.ranking || null,
  };
  return executableRequestUnitCoverageErrors(executionView)
    .map(message => message.replace('实际查询意图', '最终 Canonical 查询'));
}

function assertExecutableUnitsRepresented(output) {
  const errors = executableRequestUnitCoverageErrors(output);
  if (!errors.length) return;
  const error = new Error(errors.join('；'));
  error.code = 'REQUEST_UNIT_COVERAGE_INVALID';
  error.details = errors;
  throw error;
}

function isBlocking(unit) {
  return unit.criticality === 'scope-defining'
    || ['filter', 'ranking'].includes(unit.kind);
}

function omission(unit, fallbackReason = null) {
  return {
    id: unit.id,
    kind: unit.kind,
    sourceText: unit.sourceText || unit.field || unit.alias || '未命名要求',
    status: unit.status,
    criticality: unit.criticality,
    reason: unit.reason || fallbackReason || '当前数据集或查询能力无法执行该要求',
  };
}

/**
 * Applies only model-declared request-unit decisions and catalog validity.
 * It never infers a second business intent from the user question.
 */
export function applyExecutableRequestSubset(output = {}, metadata = null) {
  const knownFields = new Set(list(metadata?.fields).map(item => text(item?.name)).filter(Boolean));
  output = materializeExecutableProjectionUnits(output, knownFields);
  const units = normalizeRequestUnits(output.requestUnits);
  assertExecutableUnitsRepresented(output);
  const unavailableUnits = units.filter(unit => unit.status !== 'executable');
  const blockingUnits = unavailableUnits.filter(isBlocking);
  if (blockingUnits.length) {
    return {
      status: 'blocked',
      intent: { ...output, requestUnits: units },
      completion: {
        status: 'unavailable',
        executedUnitIds: units.filter(unit => unit.status === 'executable').map(unit => unit.id),
        omittedUnits: blockingUnits.map(unit => omission(unit)),
      },
    };
  }

  const omittedUnits = unavailableUnits.map(unit => omission(unit));
  const omittableUnits = unavailableUnits.filter(unit => !isBlocking(unit));
  const shouldOmit = item => omittableUnits.some(unit => unitMatches(unit, item));
  let metrics = list(output.metrics).filter(item => !shouldOmit(item));
  let dimensions = list(output.dimensions).filter(item => !shouldOmit(item));
  let filters = list(output.filters).filter(item => !shouldOmit(item));
  let derivedMetrics = list(output.derivedMetrics).filter(item => !shouldOmit(item));

  const unknownItems = units.length ? [
    ...metrics.map(item => ({ kind: 'metric', item })),
    ...dimensions.map(item => ({ kind: 'dimension', item })),
    ...filters.map(item => ({ kind: 'filter', item })),
  ].filter(({ item }) => text(item?.field || item?.fieldRef) && !knownFields.has(text(item?.field || item?.fieldRef))) : [];

  for (const { kind, item } of unknownItems) {
    const matchingUnit = units.find(unit => unitMatches(unit, item));
    const canOmit = matchingUnit && !isBlocking(matchingUnit);
    if (!canOmit) {
      const field = text(item?.field || item?.fieldRef);
      return {
        status: 'blocked',
        intent: { ...output, requestUnits: units },
        completion: {
          status: 'unavailable',
          executedUnitIds: units.filter(unit => unit.status === 'executable').map(unit => unit.id),
          omittedUnits: [omission(matchingUnit || normalizeUnit({
            kind,
            sourceText: field,
            field,
            status: 'unsupported',
            criticality: kind === 'filter' ? 'scope-defining' : 'required-output',
          }, units.length), `字段“${field}”不在当前数据集字段目录中`)],
        },
      };
    }
    omittedUnits.push(omission(matchingUnit, `字段“${text(item?.field || item?.fieldRef)}”不在当前数据集字段目录中`));
    metrics = metrics.filter(candidate => candidate !== item);
    dimensions = dimensions.filter(candidate => candidate !== item);
    filters = filters.filter(candidate => candidate !== item);
  }

  const remainingAliases = new Set([...metrics, ...dimensions, ...derivedMetrics]
    .flatMap(item => [item?.alias, item?.metricId]).map(text).filter(Boolean));
  derivedMetrics = derivedMetrics.filter(item => {
    const dependencies = list(item?.dependencies).flatMap(dependency => [dependency?.sourceAlias, dependency?.metricId]).map(text).filter(Boolean);
    const missing = dependencies.filter(dependency => !remainingAliases.has(dependency));
    if (!missing.length) return true;
    const unit = units.find(candidate => unitMatches(candidate, item));
    omittedUnits.push(omission(unit || normalizeUnit({
      kind: 'derived', sourceText: item?.source || item?.alias, alias: item?.alias,
      status: 'unsupported', criticality: 'dependency', reason: `缺少派生指标依赖：${missing.join('、')}`,
    }, units.length), `缺少派生指标依赖：${missing.join('、')}`));
    return false;
  });

  const survivingAliases = new Set([...metrics, ...dimensions, ...derivedMetrics].map(item => text(item?.alias)).filter(Boolean));
  const requiredMetrics = list(output.expectedResult?.requiredMetrics).map(text).filter(alias => survivingAliases.has(alias));
  const requiredDimensions = list(output.expectedResult?.requiredDimensions).map(text).filter(alias => survivingAliases.has(alias));
  const executable = metrics.length > 0 || dimensions.length > 0 || derivedMetrics.length > 0;
  const uniqueOmissions = [...new Map(omittedUnits.map(item => [item.id, item])).values()];

  return {
    status: executable ? 'executable' : 'blocked',
    intent: {
      ...output,
      metrics,
      dimensions,
      filters,
      derivedMetrics,
      requestUnits: units,
      expectedResult: {
        ...(output.expectedResult || {}),
        requiredMetrics,
        requiredDimensions,
      },
    },
    completion: {
      status: uniqueOmissions.length ? (executable ? 'partial' : 'unavailable') : 'complete',
      executedUnitIds: units.filter(unit => unit.status === 'executable').map(unit => unit.id),
      omittedUnits: uniqueOmissions,
    },
  };
}

