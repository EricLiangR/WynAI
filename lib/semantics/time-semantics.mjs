const GRAIN_PATTERNS = [
  ['year', /(?:按年|每个?年|逐年|年度|各年|历年|年年|年趋势|年维度|按年度|按年份)/],
  ['quarter', /(?:按季|每个?季|逐季|每个?季度|季度|季趋势)/],
  ['month', /(?:按月|每个?月|逐月|月份|月度|月趋势)/],
  ['week', /(?:按周|每个?周|逐周|周度|周趋势)/],
  ['day', /(?:按日|每个?天|逐日|每日|日度|天趋势)/],
];

const CHINESE_NUMBERS = new Map([
  ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6],
  ['七', 7], ['八', 8], ['九', 9], ['十', 10], ['十一', 11], ['十二', 12],
]);

function unique(values) {
  return [...new Set(values)];
}

function yearToken(value, nowYear) {
  const text = String(value || '').trim();
  if (!/^\d{2}(?:\d{2})?$/.test(text)) return null;
  const number = Number(text);
  if (text.length === 4) return number >= 1900 && number <= 2199 ? number : null;
  const century = Math.floor(nowYear / 100) * 100;
  let resolved = century + number;
  if (resolved > nowYear + 20) resolved -= 100;
  return resolved;
}

function parseYearList(text, nowYear) {
  const years = [];
  const add = value => {
    const year = yearToken(value, nowYear);
    if (year) years.push(year);
  };

  for (const match of text.matchAll(/((?:\d{2,4}\s*(?:[、,，/]|和|与|及)\s*)+\d{2,4})\s*年/g)) {
    match[1].split(/\s*(?:[、,，/]|和|与|及)\s*/).forEach(add);
  }
  for (const match of text.matchAll(/((?:19|20|21)\d{2}|\d{2})\s*年/g)) add(match[1]);
  for (const match of text.matchAll(/(\d{2,4})\s*(?:-|—|–|~|至|到)\s*(\d{2,4})(?:\s*年)?/g)) {
    const start = yearToken(match[1], nowYear);
    const end = yearToken(match[2], nowYear);
    if (!start || !end || end < start || end - start > 20) continue;
    for (let year = start; year <= end; year += 1) years.push(year);
  }
  return unique(years).sort((left, right) => left - right);
}

function periodExpressionKind(text, periods) {
  if (!periods.length) return null;
  if (/(?:近|最近|过去)(?:\d{1,2}|[一二两三四五六七八九十]{1,2})年/.test(text)) return 'relative-window';
  if (/(?:-|—|–|~|至|到)/.test(text)) return 'range';
  if (/(?:[、,，/]|和|与|及)/.test(text) && periods.length > 1) return 'list';
  return 'single';
}

function configuredRelativeYears(text, nowYear, skills = []) {
  const matches = [];
  for (const skill of skills || []) {
    if (skill.status && skill.status !== 'approved') continue;
    for (const semantic of skill.relativeTemporalSemantics || []) {
      if (semantic.unit !== 'year' || !Number.isInteger(semantic.offset)) continue;
      const expression = (semantic.expressions || []).find(item => String(item) && String(text).includes(String(item)));
      if (expression) matches.push({ semantic, expression: String(expression) });
    }
  }
  matches.sort((left, right) => right.expression.length - left.expression.length);
  return matches.length ? { years: [nowYear + matches[0].semantic.offset], match: matches[0] } : null;
}

function relativeYears(text, nowYear, skills = []) {
  const configured = configuredRelativeYears(text, nowYear, skills);
  if (configured) return configured.years;
  // This is a language-level normalization rule, not a dataset-specific
  // synonym list. Skills can extend the accepted expressions and business
  // calendar policy through relativeTemporalSemantics.
  if (/(?:前年|前一年度|前一年)/.test(text)) return [nowYear - 2];
  if (/(?:去年|上一?年(?:度)?|上个年度)/.test(text)) return [nowYear - 1];
  if (/(?:今年|本年(?:度)?|当年(?:度)?)/.test(text)) return [nowYear];
  const recent = text.match(/(?:近|最近|过去)(\d{1,2}|[一二两三四五六七八九十]{1,2})年/);
  if (!recent) return [];
  const count = Number(recent[1]) || CHINESE_NUMBERS.get(recent[1]) || 0;
  if (count < 1 || count > 20) return [];
  // Relative year windows use complete business years. The current, possibly incomplete year
  // is only included when the user explicitly says this year.
  return Array.from({ length: count }, (_, index) => nowYear - count + index);
}

function configuredGrain(text, skills = []) {
  const matches = [];
  for (const skill of skills || []) {
    if (skill.status && skill.status !== 'approved') continue;
    for (const semantic of skill.temporalSemantics || []) {
      if (!semantic.grain) continue;
      const hit = (semantic.expressions || []).find(expression => String(text).includes(expression));
      if (hit) matches.push({ grain: semantic.grain, expression: hit, semantic });
    }
  }
  matches.sort((left, right) => right.expression.length - left.expression.length);
  return matches[0] || null;
}

function explicitGrain(text) {
  return GRAIN_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] || null;
}

function rangeForYears(years) {
  if (!years.length) return null;
  return {
    start: `${years[0]}-01-01`,
    endExclusive: `${years.at(-1) + 1}-01-01`,
  };
}

export function parseBusinessTimeSemantics(question, {
  now = new Date(),
  previous = null,
  timeZone = 'Asia/Shanghai',
  skills = [],
} = {}) {
  const text = String(question || '').trim();
  const nowYear = now.getFullYear();
  const listedYears = parseYearList(text, nowYear);
  const relative = listedYears.length ? [] : relativeYears(text, nowYear, skills);
  const periods = listedYears.length ? listedYears : relative;
  const periodKind = periodExpressionKind(text, periods);
  const configured = configuredGrain(text, skills);
  const grainMention = configured?.grain || explicitGrain(text);
  const derivedYearGrain = !grainMention && /同比/.test(text) && periods.length > 0;
  // A multi-year range followed by a comparison request is explicit year grouping.
  // A single period with a category-level comparison must not invent a time axis.
  const periodComparison = periods.length > 1 && /分别|各自|逐年|每年|按年/.test(text);
  const groupedYears = grainMention === 'year'
    || /(?:每个年份|各年度|逐年|每年|历年|年年|年度趋势|年趋势|按年度|按年份|趋势)/.test(text)
    || (periodKind === 'list' && periods.length > 1)
    || periodComparison
    || derivedYearGrain;
  const grain = grainMention || (groupedYears ? 'year' : null);
  const explicitRange = rangeForYears(periods);
  const modifier = /^(?:继续|再|然后|接着|改为|改成|换成|只看|仅看|筛选|限定|按|同时|增加|加上|再加|另外加|并且)/.test(text);
  const inheritedRange = modifier && !explicitRange ? previous?.range || null : null;
  const inheritedPeriods = modifier && !periods.length ? previous?.periods || [] : [];
  const effectivePeriods = periods.length ? periods : inheritedPeriods;
  const range = explicitRange || inheritedRange;
  const scopeExplicit = periods.length > 0;
  const groupingExplicit = Boolean(grainMention || groupedYears);
  const explicit = scopeExplicit || groupingExplicit;
  const scopePolicy = periodKind === 'relative-window' ? 'latest-complete-years' : scopeExplicit ? 'explicit-periods' : 'unspecified';
  const assumptions = [];
  if (configured) assumptions.push(`时间表达“${configured.expression}”按 ${configured.grain} 粒度解释（${configured.semantic.meaning || '已审批时间语义 Skill'}）`);
  if (/\b\d{2}\b/.test(text) && periods.some(year => year >= 1900)) {
    assumptions.push(`两位年份按当前世纪和业务时间解释为 ${periods.join('、')} 年`);
  }
  const constraints = [];
  if (periods.length) constraints.push({
    id: 'time-periods', type: 'time-periods', source: text,
    normalized: periods, required: true, status: 'resolved',
  });
  if (grainMention || groupedYears) constraints.push({
    id: 'time-grain', type: 'time-grain', source: text,
    normalized: grain || 'year', required: true, status: 'resolved',
  });
  return {
    calendar: 'gregorian',
    timeZone,
    periods: effectivePeriods,
    range,
    source: periods.length ? text.match(/(?:前年|前一年度|前一年|去年|上一?年(?:度)?|上个年度|今年|本年(?:度)?|当年(?:度)?|(?:近|最近|过去)(?:\d{1,2}|[一二两三四五六七八九十]{1,2})年|(?:\d{2,4}[^\s]{0,20}年))/)?.[0] || text : null,
    periodKind,
    grouping: grain || (modifier ? previous?.grouping || previous?.grain || null : null),
    grain: grain || (modifier ? previous?.grain || null : null),
    grainRole: derivedYearGrain ? 'derivation' : grain ? 'analysis' : modifier ? previous?.grainRole || 'analysis' : null,
    explicit,
    scopeExplicit,
    groupingExplicit,
    scopePolicy,
    modifier,
    groupedYears,
    assumptions,
    constraints,
  };
}

export function datePartsInTimeZone(value, timeZone = 'Asia/Shanghai') {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
  } catch {
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  }
}

export function bucketDate(value, grain, timeZone = 'Asia/Shanghai') {
  const parts = datePartsInTimeZone(value, timeZone);
  if (!parts || !grain) return value;
  let { year, month, day } = parts;
  if (grain === 'year') { month = 1; day = 1; }
  else if (grain === 'quarter') { month = Math.floor((month - 1) / 3) * 3 + 1; day = 1; }
  else if (grain === 'month') day = 1;
  else if (grain === 'week') {
    const anchor = new Date(Date.UTC(year, month - 1, day));
    const weekday = anchor.getUTCDay() || 7;
    anchor.setUTCDate(anchor.getUTCDate() - weekday + 1);
    year = anchor.getUTCFullYear();
    month = anchor.getUTCMonth() + 1;
    day = anchor.getUTCDate();
  }
  const padded = number => String(number).padStart(2, '0');
  return `${year}-${padded(month)}-${padded(day)}T00:00:00.000Z`;
}

export function formatBusinessPeriod(value, grain = null, locale = 'zh-CN', timeZone = 'Asia/Shanghai') {
  const parts = datePartsInTimeZone(value, timeZone);
  if (!parts) return String(value ?? '—');
  if (grain === 'year') return `${parts.year}年`;
  if (grain === 'quarter') return `${parts.year}年第${Math.floor((parts.month - 1) / 3) + 1}季度`;
  if (grain === 'month') return `${parts.year}年${parts.month}月`;
  if (grain === 'week') return `${parts.year}年${parts.month}月${parts.day}日所在周`;
  if (grain === 'day') return `${parts.year}年${parts.month}月${parts.day}日`;
  return new Intl.DateTimeFormat(locale, { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}
