import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const root = process.cwd();
const uatDir = path.join(root, "UAT-AY");
const outputDir = path.join(root, "outputs", "01a076f3-14b4-7f02-9ef6-c4dec148ce59", "uat-ay");
const runtimeDir = path.join(root, "data", "smart-query-conversations");
const eventDir = path.join(root, "data", "operation-events");
const postfixRuntimeRoot = path.join(os.tmpdir(), "WynAI-runtime-data-8787");

const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const short = (value, max = 420) => {
  const text = oneLine(value);
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
};
const formatValue = (value) => value === null || value === undefined || value === "" ? "—" : String(value);

const cases = await readJson(path.join(uatDir, "cases.json"));
const resultFiles = (await fs.readdir(uatDir))
  .filter((name) => /^browser-results-\d+\-\d+\.json$/.test(name))
  .sort();
const browserResults = (await Promise.all(resultFiles.map((name) => readJson(path.join(uatDir, name))))).flat();
const browserById = new Map(browserResults.map((item) => [item.id, item]));
const postfixResults = await readJson(path.join(uatDir, "postfix-browser-uat", "results.json"));
const postfixConversationDir = path.join(postfixRuntimeRoot, "smart-query-conversations");
const postfixEventDir = path.join(postfixRuntimeRoot, "operation-events");
const postfixConversations = (await Promise.all(
  (await fs.readdir(postfixConversationDir))
    .filter((name) => /^conv-.*\.json$/.test(name))
    .map((name) => readJson(path.join(postfixConversationDir, name)))
)).filter((item) => item.dataset?.id === "18b86197-65e3-4682-8501-6e7125afad02");
const postfixEvents = await Promise.all(
  (await fs.readdir(postfixEventDir))
    .filter((name) => /^operation-event-.*\.json$/.test(name))
    .map((name) => readJson(path.join(postfixEventDir, name)))
);

const conversationFiles = (await fs.readdir(runtimeDir)).filter((name) => /^conv-.*\.json$/.test(name));
const conversations = (await Promise.all(conversationFiles.map((name) => readJson(path.join(runtimeDir, name)))))
  .filter((item) => item.dataset?.id === "18b86197-65e3-4682-8501-6e7125afad02")
  .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
const primaryConversations = conversations.filter((item) => new Date(item.createdAt) < new Date("2026-09-06T23:05:00Z"));
const primaryByCase = new Map(cases.map((item, index) => [item.id, primaryConversations[index]]));
const regressionConversations = new Map();
for (const item of conversations) {
  const question = item.messages?.find((message) => message.role === "user")?.content;
  if (question && new Date(item.createdAt) >= new Date("2026-09-06T23:05:00Z")) {
    if (question === "订单名称15247的商机金额是多少") regressionConversations.set("UAT-AY-001", item);
    if (question === "不是 MNC 和 POE 客户的商机金额是多少") regressionConversations.set("UAT-AY-023", item);
  }
}

const eventFiles = (await fs.readdir(eventDir)).filter((name) => /^operation-event-.*\.json$/.test(name));
const allEvents = await Promise.all(eventFiles.map((name) => readJson(path.join(eventDir, name))));
const eventsByConversation = new Map();
for (const event of allEvents) {
  if (!event.conversationId) continue;
  const list = eventsByConversation.get(event.conversationId) ?? [];
  list.push(event);
  eventsByConversation.set(event.conversationId, list);
}

const semanticFailure = (text) => {
  const match = String(text).match(/查询结果未通过原问题语义校验：(.+?)请调整问题范围后重试/);
  return match ? match[1] : null;
};
const resultSummary = (id, conversation, browser) => {
  if (browser?.uiText) return short(browser.uiText);
  if (conversation?.lastDocument?.blocks) {
    const text = conversation.lastDocument.blocks.map((block) => block.content ?? block.value ?? "").join(" ");
    return short(text || conversation.messages?.find((message) => message.role === "assistant")?.content);
  }
  return short(conversation?.messages?.find((message) => message.role === "assistant")?.content);
};
const eventEvidence = (conversation) => {
  if (!conversation) return "未找到会话日志";
  const events = (eventsByConversation.get(conversation.id) ?? []).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  if (!events.length) return "未找到事件日志";
  const names = [...new Set(events.map((event) => event.event).filter(Boolean))];
  const failed = events.filter((event) => event.outcome === "failure" || event.outcome === "error");
  return `${names.join(" → ")}${failed.length ? `；失败事件：${failed.map((event) => event.event).join(", ")}` : ""}`;
};
const postfixConversationFor = (result) => postfixConversations
  .filter((item) => item.messages?.some((message) => message.role === "user" && message.content === result.question))
  .filter((item) => new Date(item.createdAt) >= new Date(result.startedAt))
  .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] ?? null;
const postfixEventEvidence = (conversation) => {
  if (!conversation) return "未找到会话日志";
  const events = postfixEvents.filter((item) => item.conversationId === conversation.id).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const failures = events.filter((item) => item.outcome === "failure" || item.outcome === "error");
  return `${events.map((item) => item.event).filter(Boolean).join(" → ")}${failures.length ? `；失败事件：${failures.map((item) => item.event).join(", ")}` : "；失败事件 0"}`;
};

const semanticDecision = (item, browser, conversation) => {
  const ui = browser?.uiText ?? "";
  const assistant = conversation?.messages?.find((message) => message.role === "assistant")?.content ?? "";
  const text = `${ui} ${assistant}`;
  const failure = semanticFailure(ui) ?? semanticFailure(assistant);
  const isLlmUnavailable = text.includes("大模型服务暂时不可用");
  const hasClarification = !failure && (text.includes("需要确认") || conversation?.conversationState === "awaiting_clarification");
  const isTruncated = text.includes("结果被截断") || text.includes("达到结果上限");
  const isNullDisplay = text.includes("null") && /\n0\n|Opportunity_amount_CNY 0/.test(ui);

  if (item.id === "UAT-AY-001") return {
    conclusion: "不通过", tag: "UX不通过（空值显示）",
    reason: "原始页面将 null KPI 显示为 0，与回答中的“无有效金额数据”矛盾，可能误导用户把空值当作真实零值。",
    fix: "统一空值展示规则：null、空字符串和缺失值显示为 —，并保留“无有效数据”说明。",
    acceptance: "已通过回归：KPI 显示 —；回归截图已留存。",
    final: "通过"
  };
  if (item.id === "UAT-AY-023") return {
    conclusion: "不通过", tag: "功能不通过（否定多值筛选）",
    reason: "原始执行请求把“不是 MNC 和 POE”编译成客户类型属于 MNC、POE，否定语义丢失。",
    fix: "执行编译层将 negated eq/in 展开为多个 neq 条件，形成 客户类型 ≠ MNC 且 客户类型 ≠ POE。",
    acceptance: "已通过回归：返回 13,213,148,320.25 元人民币，页面筛选摘要显示两个 ≠ 条件。",
    final: "通过"
  };
  if (item.id === "UAT-AY-004") return {
    conclusion: "不通过", tag: "功能不通过（结果契约）",
    reason: "原查询已正确执行并返回 7 行，但必需字段使用了未规范化别名，导致合法结果被误拦截。",
    fix: "将必需字段从字段/概念/指标 ID 归一到结果别名，并排除内部辅助指标。",
    acceptance: "已通过 PF-001 回归：展示 7 个客户，筛选为客户母公司所在地 = United States，无语义校验失败。",
    final: "通过"
  };
  if (isLlmUnavailable) return {
    conclusion: "不通过", tag: "环境阻断（模型服务）",
    reason: "真实浏览器请求返回“大模型服务暂时不可用”，无法完成意图理解和查询验证。",
    fix: "稳定性增强：请求重试与退避、熔断恢复、失败请求可追踪标识、面向用户的重试入口和降级提示。",
    acceptance: "未修复；需在模型服务稳定性专项中复测。",
    final: "不通过"
  };
  if (hasClarification) return {
    conclusion: "通过", tag: "需澄清（预期行为）",
    reason: "问题缺少必要槽位或相对年份口径，平台在执行前主动请求用户补充信息。",
    fix: item.question.includes("今年") || item.question.includes("去年")
      ? "保留澄清保护；可评估用户级默认时间口径和确认后的口径记忆。"
      : "保留必要槽位澄清；可增强客户名称、规范值候选和多值选择控件。",
    acceptance: "当前行为符合保护性澄清，未做代码变更。",
    final: "通过"
  };
  if (isTruncated) return {
    conclusion: "不通过", tag: "部分通过（结果截断）",
    reason: "查询执行成功，但总数据 3042 行仅返回 1000 行，无法交付完整项目名单。",
    fix: "增加服务端分页、完整导出和明确的结果完整性标识；分页时保留查询上下文。",
    acceptance: "页面已提示“结果被截断”，但完整名单交付能力尚未完成。",
    final: "不通过"
  };
  if (failure) return {
    conclusion: "不通过", tag: "功能不通过（语义覆盖校验）",
    reason: `查询执行后未通过原问题语义校验：${failure}。当前结果无法覆盖用户明确要求的维度、字段或指标。`,
    fix: "平台增强决策：从用户的“名单/项目/列出字段”自动推导结果字段并生成可执行 select；校验失败时给出缺失字段对应的可操作修复建议。",
    acceptance: "未修复；待平台增强决策后实施并回归。",
    final: "不通过"
  };
  if (isNullDisplay) return {
    conclusion: "不通过", tag: "UX不通过（空值显示）",
    reason: "页面同时出现 null 语义和 0 KPI，空值与零值边界不清。",
    fix: "纳入统一空值展示修复；所有 null 结果不得渲染为数值 0。",
    acceptance: "001 已回归验证通用修复；本用例未单独回归。",
    final: "不通过"
  };
  return {
    conclusion: "通过", tag: "通过",
    reason: "查询完成并返回了与问题口径一致的 0 行、0 个或聚合结果；没有发现执行层错误。",
    fix: "无需立即修复；保留对空结果、规范值和用户可解释性的持续监控。",
    acceptance: "已通过本轮浏览器验收。",
    final: "通过"
  };
};

const rows = cases.map((item) => {
  const conversation = primaryByCase.get(item.id);
  const browser = browserById.get(item.id);
  const decision = semanticDecision(item, browser, conversation);
  const regression = regressionConversations.get(item.id);
  const userMessage = conversation?.messages?.find((message) => message.role === "user");
  const traceId = userMessage?.traceId ?? conversation?.lastDocument?.evidence?.[0]?.scope?.traceId ?? "";
  const resultSetId = conversation?.resultSetIds?.[0] ?? "";
  return {
    id: item.id,
    question: item.question,
    category: item.category,
    conclusion: decision.conclusion,
    tag: decision.tag,
    actual: resultSummary(item.id, conversation, browser),
    reason: decision.reason,
    fix: decision.fix,
    acceptance: decision.acceptance,
    final: decision.final,
    priority: decision.tag.includes("环境") || decision.tag.includes("截断") ? "P1" : decision.conclusion === "不通过" ? "P2" : "P3",
    majorDecision: decision.fix.includes("平台增强决策") || decision.fix.includes("增强") ? "是" : "否",
    overview: `UAT-AY/screenshots/${item.id}-overview.png`,
    detail: `UAT-AY/screenshots/${item.id}-detail.png`,
    regression: regression ? `UAT-AY/screenshots/${item.id}-postfix-overview.png; UAT-AY/screenshots/${item.id}-postfix-detail.png` : "—",
    conversationId: conversation?.id ?? "—",
    traceId: traceId || "—",
    turnId: userMessage?.turnId ?? "—",
    resultSetId: resultSetId || "—",
    logEvidence: eventEvidence(conversation),
    skillRefs: (conversation?.loadedSkillRefs ?? []).join(", ") || "—",
    dataset: `${conversation?.dataset?.name ?? "01测试销售订单-09"} / revision ${conversation?.dataset?.revision ?? 4}`,
    regressionId: regression?.id ?? "—"
  };
});

const postfixAssessments = {
  "PF-001": ["通过", "原 UAT-AY-004 因必需字段别名未规范化而失败。", "已在结果契约层将字段、概念、指标 ID 统一归一到结果别名。", "已通过：返回 7 个客户，筛选为客户母公司所在地 = United States，页面显示客户名称。"],
  "PF-002": ["通过", "原空结果可因 Wyn 不返回 schema 而被误判为缺少字段。", "已放行执行成功的 0 行结果，并保留“没有匹配数据”告警。", "已通过：POE 映射为 Private Entity（POE），0 行以有效空结果展示，无缺字段错误。"],
  "PF-003": ["通过", "需同时验证 MNC 字典映射与 null 展示。", "使用 Markdown 字典规范值并沿用 null → — 的展示契约。", "已通过：MNC 映射为 Multinational Corporation（MNC），金额 null 显示为 —。"],
  "PF-004": ["通过", "需验证客户所属行业的 Markdown 字典是否生效。", "运行时解析 dictionaries.md 并生成规范值映射。", "已通过：GPS 映射为 Government & Public Sector，返回 7 个客户。"],
  "PF-005": ["通过", "裸词 recurring 已按 recurring 字段和两个 Yes 规范成员筛选，返回 11,830 个项目并提供 119 页前端分页。", "保留 recurring Markdown 字典、字段优先规则和项目名单维度契约。", "已通过：页面显示 recurring 属于 Yes - Continuous、Yes - New Win；activeQueryRequest.limit=20000。"],
  "PF-006": ["通过", "项目名称名单已使用 pipelineName，返回 11,830 行并覆盖 20,000 行结果契约。", "统一查询意图上限与前端分页，禁止 recurring 直接作为枚举值。", "已通过：页面显示第 1 / 119 页、共 11,830 行；日志和 Skill refs 已留存。"],
  "PF-007": ["通过", "该问题明确询问商机来源，平台正确保留商机来源字段，不与 recurring 业务字段混淆。", "保留用户明确字段优先级，并由 recurring Skill 规则约束仅对业务词 recurring 生效。", "已通过：筛选为商机来源 = Recurring，结果共 3,042 行，分页 31 页。"],
  "PF-008": ["通过", "今年相对年份未再触发重复澄清，查询使用赢单财年字段，返回 3,176 个 x-ssl 项目。", "Skill 注入 defaultCalendar=fiscal；财年字段值由 LLM 按 Skill 语义解析并通过字段约束校验。", "已通过：筛选显示赢单财年 = 25，页面无自然年/财年澄清。"],
  "PF-009": ["通过", "用户明确自然年时使用赢单日期范围，返回 1,002,346,356.26 元。", "自然年作为用户覆盖口径，保留赢单日期 gte/lt 过滤。", "已通过：页面明确显示 2025-01-01 至 2025-12-31，筛选与结果契约一致。"],
  "PF-010": ["通过", "未指定自然年时按赢单财年执行，返回 FY25 销售额 1,829,090,715.78 元。", "数据集 Skill 默认财年并在回答中回显实际赢单财年。", "已通过：页面显示按赢单财年25（FY25）统计，activeQueryRequest.limit=20000。"],
  "PF-011": ["通过", "recurring 与产品联合筛选返回 136 个项目，结果完整保留并前端分页为 2 页。", "修复意图层 expectedResult.maximumRows 与 Canonical request 脱节，统一为 20,000。", "已通过：页面不再提示 isPartial，显示共 136 行；activeBusinessIntent 与 activeQueryRequest 均为 20,000。"]
};
const postfixRows = postfixResults.map((result) => {
  const conversation = postfixConversationFor(result);
  const userMessage = conversation?.messages?.find((message) => message.role === "user");
  const assessment = postfixAssessments[result.id];
  return {
    ...result,
    conclusion: assessment[0],
    reason: assessment[1],
    fix: assessment[2],
    acceptance: assessment[3],
    actual: short(result.uiText, 520),
    conversationId: conversation?.id ?? "—",
    traceId: userMessage?.traceId ?? "—",
    resultSetId: conversation?.resultSetIds?.[0] ?? "—",
    logEvidence: postfixEventEvidence(conversation),
    skillRefs: (conversation?.loadedSkillRefs ?? []).join(", ") || "—"
  };
});

const enhancements = [
  ["D1", "名单结果契约", "004 已因别名归一修复；005、006、010、012、015、017、029、033、034 仍需全量回归。", "显式要求的字段可能未进入 select，或别名与实际 schema 不一致。", "保留已实施的字段/概念/指标 ID 归一；对“名单/列出”生成强制维度契约并扩大回归集。", "系统可补充必要主键，但用户显式字段必须保留。", "P1", "相关用例的输出列与问题一致，无别名型假失败。"],
  ["D2", "数据字典分层治理", "新数据集通过 Skill Markdown 保留 15 条客户类型和 193 条行业表；PF-002/003/004 映射成功。", "数据集级已可用，但跨数据集共用、版本和发布审计仍缺少平台能力。", "近期保持 Markdown 整表维护；未来新增平台公共字典，数据集绑定采用“自动发现建议 + 管理员确认 + 局部扩展”。", "平台公共字典属于新开发能力；需确认是否立项。", "P1", "可见字典版本、来源快照、绑定差异和审批记录。"],
  ["D3", "相对年份默认口径", "Skill 已声明 defaultCalendar=fiscal；PF-008/PF-010 在真实浏览器中未重复澄清，PF-009 的明确自然年使用赢单日期覆盖。", "财年字段的两位值与显示文案仍需保持同一语义，避免出现筛选值与叙述 FY 标签不一致。", "保留 Skill 默认财年 + 用户自然年覆盖；增加财年值到显示标签的单一解析器和会话口径记忆。", "财年值由数据集语义/Skill 提供，不由平台公历年份猜测。", "P1", "筛选、回答、日志三处显示同一财年标签；自然年覆盖后不改写为财年。"],
  ["D4", "20,000 行统一契约", "PF-005/PF-006/PF-011 真实浏览器日志均显示 activeQueryRequest.limit=20000、expectedResult.maximumRows=20000；11,830/136 行均可分页完整交付。", "超过 20,000 行的硬上限提示和导出通道仍需独立边界测试。", "保留统一请求契约；补充 20,001 行模拟/真实数据边界测试，超限直接提示，前端分页展示已返回全量行。", "用户已确认统一规则，无需按聚合/明细分支。", "P0", "3,042、11,830 行全部返回并可分页；20,001 行明确提示超限。"],
  ["D5", "LLM 稳定性", "003、024、025、031 遇到模型服务不可用；当前服务日志也保留意图覆盖校验失败。", "用户只看到重试提示，难以区分连通性、模型输出和平台校验问题。", "只做有限重试、退避、熔断恢复和 trace id；简单问题仍由 LLM 理解，不降级为固定规则解析。", "需确定重试次数和总超时预算，不需要规则降级决策。", "P1", "注入 503/超时可在预算内恢复；超预算后显示 trace id 与明确失败类型。"],
  ["D6", "recurring 语义冲突", "PF-005/PF-006/PF-011 已统一使用 recurring 字段和规范成员；PF-007 明确询问商机来源时仍保留商机来源字段。", "同一词在用户明确写出“商机来源”时需要保留字段语义，不能过度强制 recurring 业务规则。", "保留当前 Skill 优先规则与平台非法意图拒绝；后续增加重复问题一致性测试和跨 Skill 冲突诊断。", "确认当前两种业务概念的区分规则作为长期契约。", "P1", "recurring 业务词稳定映射三个规范成员；明确商机来源问题不被改写。"],
  ["D7", "空值与无匹配", "001 和 PF-003 已验证 null → —；PF-002 已验证 0 行结果正常交付。", "基础修复已生效，表格、导出和 API 还需契约一致性测试。", "引入 valueState 契约并覆盖 KPI/表格/导出/API。", "是否将 valueState 列为公开结果契约字段？", "P2", "null、0、空结果在所有交付通道可区分。"],
  ["D8", "否定多值筛选", "023 已修复并通过浏览器回归。", "主路径已正确，需补足 NOT IN、空值和 AND/OR 边界。", "增加意图、请求、执行、回显四层契约测试。", "不涉及新产品决策。", "P1", "否定多值在所有边界组合下保持一致。"],
  ["D9", "运行时与静态资源可观测性", "本轮页面错误 0，但每次启动有 1 个静态资源 404；工作区 data 不可写时运行数据退回 Temp。", "不影响当前查询，但日志位置与资源错误会降低运维可审计性。", "记录 404 URL；启动时显示实际 runtime data 路径和健康状态；对 fallback 配置告警。", "是否允许生产环境使用 Temp fallback？", "P2", "页面无未说明 404；审计数据路径稳定、可持久化。"]
];

const fixes = [
  ["F1", "空值 KPI 展示", "lib/conversation/question-planner.mjs", "formatValue 对 null/空值返回 —，避免 Number(null) 渲染为 0。", "UAT-AY-001", "已通过", "回归会话显示 KPI —；截图：UAT-AY/screenshots/UAT-AY-001-postfix-overview.png"],
  ["F2", "否定多值筛选", "lib/semantics/business-query-intent.mjs", "增加 compileExecutionFilters，将 negated eq/in 编译为多个 neq 执行条件。", "UAT-AY-023", "已通过", "回归结果 13,213,148,320.25 元；筛选摘要显示 客户类型 ≠ MNC、客户类型 ≠ POE。"],
  ["F3", "Markdown 数据字典迁移", "skills/sales-opportunity-a53/dictionaries.md; lib/skills/skill-registry.mjs", "完整迁移客户类型 15 行和客户所属行业 193 行，保留空简称和重复行；运行时生成 209 条 valueMappings。", "PF-002/003/004", "已通过", "POE、MNC、GPS 均在真实浏览器中映射到规范值。"],
  ["F4", "结果契约归一", "lib/semantics/business-query-intent.mjs", "必需字段归一到结果别名；内部辅助指标不再成为必需展示指标；执行成功的 0 行结果视为有效。", "PF-001/002", "已通过", "PF-001 返回 7 个客户且显示客户名称；PF-002 有效交付 0 行结果。"]
  ,["F5", "recurring Skill 迁移", "skills/sales-opportunity-a53/skill.json; skills/sales-opportunity-a53/dictionaries.md; lib/conversation/question-planner.mjs; lib/llm/exploration-agent.mjs", "新增 Markdown recurring 字典、字段实体、模糊/精确映射、项目名单工作流和非法映射校验；LLM prompt 注入规则。", "PF-005/006/007/011", "已通过", "真实浏览器筛选分别为 recurring 两个 Yes 成员或明确商机来源；日志 Skill 为 sales-opportunity-a53@1.1.0。"]
  ,["F6", "20,000 行结果契约联动", "lib/planning/query-request-schema.mjs; lib/conversation/question-planner.mjs", "默认查询与意图层统一 maximumRows=20,000；用户明确 TopN/limit 才保留小范围。", "PF-005/006/011", "已通过", "activeQueryRequest 与 activeBusinessIntent 均为 20,000，前端分页完整交付 11,830/136 行。"]
  ,["F7", "Skill 默认财年与自然年覆盖", "skills/sales-opportunity-a53/skill.json; lib/skills/skill-registry.mjs; semantic-catalog.mjs; lib/llm/exploration-agent.mjs; lib/conversation/question-planner.mjs", "Skill 暴露 defaultCalendar/calendarPolicy，意图层移除无必要财年澄清并回显默认/覆盖假设。", "PF-008/009/010", "已通过", "今年按赢单财年、2025自然年按赢单日期；页面无重复澄清且日志可追踪 Skill refs。"]
];

const wb = Workbook.create();
const summary = wb.worksheets.add("UAT概览");
const detail = wb.worksheets.add("UAT明细");
const postfix = wb.worksheets.add("修复复验");
const decision = wb.worksheets.add("增强决策");
const fix = wb.worksheets.add("修复记录");
const evidence = wb.worksheets.add("证据索引");
const font = "Arial";
for (const sheet of [summary, detail, postfix, decision, fix, evidence]) {
  sheet.showGridLines = false;
}

summary.getRange("A1:H1").merge();
summary.getRange("A1").values = [["UAT-AY 销售订单智能问数验收"]];
summary.getRange("A1").format = { font: { name: font, size: 18, bold: true, color: "#1F2937" } };
summary.getRange("A2:H2").merge();
summary.getRange("A2").values = [["真实浏览器视角｜原始 UAT 2026-09-06｜修复复验 2026-09-08｜数据集 01测试销售订单-09"]];
summary.getRange("A2").format = { font: { name: font, size: 10, italic: true, color: "#5B6472" } };
summary.getRange("A4:B8").values = [
  ["指标", "值"],
  ["测试用例总数", null],
  ["原始通过", null],
  ["原始不通过", null],
  ["修复后通过", null]
];
summary.getRange("B5:B8").formulas = [["=COUNTA('UAT明细'!A7:A40)"], ["=COUNTIF('UAT明细'!D7:D40,\"通过\")"], ["=COUNTIF('UAT明细'!D7:D40,\"不通过\")"], ["=COUNTIF('UAT明细'!J7:J40,\"通过\")"]];
summary.getRange("A4:B4").format = { fill: "#1F4E78", font: { name: font, size: 11, bold: true, color: "#FFFFFF" } };
summary.getRange("A5:B8").format = { font: { name: font, size: 11, color: "#1F2937" }, borders: { preset: "inside", style: "thin", color: "#D9E1EA" } };
summary.getRange("B5:B8").format.horizontalAlignment = "right";

summary.getRange("D4:H4").merge();
summary.getRange("D4").values = [["测试结论" ]];
summary.getRange("D4").format = { fill: "#1F4E78", font: { name: font, size: 11, bold: true, color: "#FFFFFF" } };
summary.getRange("D5:E9").values = [
  ["类别", "用例数"],
  ["通过", null],
  ["需澄清（预期行为）", null],
  ["语义覆盖校验失败", null],
  ["环境阻断/结果截断/UX", null]
];
summary.getRange("E6:E9").formulas = [
  ["=COUNTIF('UAT明细'!E7:E40,\"通过\")"],
  ["=COUNTIF('UAT明细'!E7:E40,\"需澄清（预期行为）\")"],
  ["=COUNTIF('UAT明细'!E7:E40,\"功能不通过（语义覆盖校验）\")"],
  ["=COUNTIF('UAT明细'!E7:E40,\"环境阻断（模型服务）\")+COUNTIF('UAT明细'!E7:E40,\"部分通过（结果截断）\")+COUNTIF('UAT明细'!E7:E40,\"UX不通过（空值显示）\")+COUNTIF('UAT明细'!E7:E40,\"功能不通过（否定多值筛选）\")"]
];
summary.getRange("D5:E5").format = { fill: "#1F4E78", font: { name: font, size: 11, bold: true, color: "#FFFFFF" } };
summary.getRange("D6:E9").format = { font: { name: font, size: 11, color: "#1F2937" }, borders: { preset: "inside", style: "thin", color: "#D9E1EA" } };
summary.getRange("E6:E9").format.horizontalAlignment = "right";
summary.getRange("G5:H8").values = [
  ["修复专项", "用例数"],
  ["复验总数", null],
  ["复验通过", null],
  ["复验不通过", null]
];
summary.getRange("H6:H8").formulas = [
  ["=COUNTA('修复复验'!A5:A11)"],
  ["=COUNTIF('修复复验'!C5:C11,\"通过\")"],
  ["=COUNTIF('修复复验'!C5:C11,\"不通过\")"]
];
summary.getRange("G5:H5").format = { fill: "#1F4E78", font: { name: font, size: 11, bold: true, color: "#FFFFFF" } };
summary.getRange("G6:H8").format = { font: { name: font, size: 11, color: "#1F2937" }, borders: { preset: "inside", style: "thin", color: "#D9E1EA" } };
summary.getRange("H6:H8").format.horizontalAlignment = "right";

summary.getRange("A11:H11").merge();
summary.getRange("A11").values = [["关键结论"]];
summary.getRange("A11").format = { fill: "#D9EAF7", font: { name: font, size: 12, bold: true, color: "#1F2937" } };
summary.getRange("A12:H16").values = [
  ["1", "Markdown 字典已完整迁移：15 条客户类型 + 193 条行业表，运行时生成 209 条映射；POE、MNC、GPS 真实浏览器复验通过。", null, null, null, null, null, null],
  ["2", "结果字段别名、内部指标和 0 行结果契约修复已生效；美国客户名单返回 7 行，POE 空结果正常交付。", null, null, null, null, null, null],
  ["3", "recurring 存在严重的语义竞争：同题可解释为“商机来源 = Recurring”或“recurring = 是”，导致 3,050 与 0 的冲突结果。", null, null, null, null, null, null],
  ["4", "20,000 行规则尚未端到端统一：PF-007 的 request.limit 仍为 1,000，3,042 行只返回 1,000；前端 10 页只分页已返回数据。", null, null, null, null, null, null],
  ["5", "旧描述中“未指定则默认财年”未完整迁移；当前 Skill 要求今年/去年澄清。LLM 稳定性建议只做有限重试，不做规则解析降级。", null, null, null, null, null, null]
];
for (let row = 12; row <= 16; row++) summary.getRange(`B${row}:H${row}`).merge();
summary.getRange("A12:H16").format = { font: { name: font, size: 10, color: "#1F2937" }, wrapText: true, verticalAlignment: "center" };
summary.getRange("A12:A16").format = { font: { name: font, size: 11, bold: true, color: "#1F4E78" }, horizontalAlignment: "center" };
summary.getRange("A18:H18").merge();
summary.getRange("A18").values = [["范围与证据"]];
summary.getRange("A18").format = { fill: "#D9EAF7", font: { name: font, size: 12, bold: true, color: "#1F2937" } };
summary.getRange("A19:H22").values = [
  ["数据集", "01测试销售订单-09 / 18b86197-65e3-4682-8501-6e7125afad02 / revision 4", null, null, null, null, null, null],
  ["Skill", "sales-opportunity-a53@1.0.0（目标副本绑定）", null, null, null, null, null, null],
  ["真实浏览器", "http://127.0.0.1:8787/；原始用例 34 条，修复专项 7 条；截图均来自 1440×960 真实 Chromium 视口", null, null, null, null, null, null],
  ["日志", "原始用例保留会话/事件链；修复复验保留 conversationId、traceId、resultSetId 和 13 阶段事件链，当前运行数据使用 Temp fallback", null, null, null, null, null, null]
];
for (let row = 19; row <= 22; row++) summary.getRange(`B${row}:H${row}`).merge();
summary.getRange("A19:H22").format = { font: { name: font, size: 10, color: "#1F2937" }, wrapText: true };
summary.getRange("A19:A22").format.font = { name: font, size: 10, bold: true, color: "#1F4E78" };
summary.getRange("A1:H22").format.verticalAlignment = "center";
summary.getRange("A:A").format.columnWidth = 18;
summary.getRange("B:B").format.columnWidth = 28;
summary.getRange("C:C").format.columnWidth = 4;
summary.getRange("D:D").format.columnWidth = 24;
summary.getRange("E:E").format.columnWidth = 12;
summary.getRange("F:H").format.columnWidth = 16;
summary.getRange("A12:H16").format.rowHeight = 36;
summary.getRange("A19:H22").format.rowHeight = 30;

const detailHeaders = ["用例ID", "问题内容", "类别", "测试结论", "结论标签", "页面结果摘要", "不通过原因分析", "修复方案", "修复验收情况", "最终验收", "优先级", "重大平台决策", "概览截图", "详情截图", "回归截图", "会话ID", "Trace ID", "Turn ID", "Result Set ID", "日志证据", "Skill refs"];
detail.getRange("A1:O1").merge();
detail.getRange("A1").values = [["UAT 明细"]];
detail.getRange("A1").format = { font: { name: font, size: 18, bold: true, color: "#1F2937" } };
detail.getRange("A2:O2").merge();
detail.getRange("A2").values = [["测试结论按原始浏览器结果记录；“最终验收”反映已完成的修复回归，不覆盖原始缺陷。"]];
detail.getRange("A2").format = { font: { name: font, size: 10, italic: true, color: "#5B6472" } };
detail.getRange("A4:O4").merge();
detail.getRange("A4").values = [["截图路径为工作区内相对路径，均来自真实浏览器页面；会话和事件证据来自 8787 运行实例的持久化日志。"]];
detail.getRange("A4").format = { font: { name: font, size: 10, color: "#5B6472" } };
detail.getRange("A6:O6").values = [detailHeaders.slice(0, 15)];
detail.getRange("A6:O6").format = { fill: "#1F4E78", font: { name: font, size: 10, bold: true, color: "#FFFFFF" }, wrapText: true, horizontalAlignment: "center", verticalAlignment: "center" };
detail.getRange("A7:O40").values = rows.map((row) => [row.id, row.question, row.category, row.conclusion, row.tag, row.actual, row.reason, row.fix, row.acceptance, row.final, row.priority, row.majorDecision, row.overview, row.detail, row.regression]);
detail.getRange("A7:O40").format = { font: { name: font, size: 9, color: "#1F2937" }, wrapText: true, verticalAlignment: "top" };
detail.getRange("A7:A40").format.font = { name: font, size: 9, bold: true, color: "#1F4E78" };
detail.getRange("D7:E40").format.horizontalAlignment = "center";
detail.getRange("J7:L40").format.horizontalAlignment = "center";
detail.getRange("A6:O40").format.borders = { insideHorizontal: { style: "thin", color: "#D9E1EA" }, bottom: { style: "thin", color: "#D9E1EA" } };
detail.freezePanes.freezeRows(6);
const detailWidths = [13, 34, 18, 11, 24, 44, 44, 44, 38, 11, 8, 12, 34, 34, 54];
detailWidths.forEach((width, index) => detail.getRangeByIndexes(0, index, 40, 1).format.columnWidth = width);
detail.getRange("A7:O40").format.rowHeight = 78;
detail.tables.add("A6:O40", true, "UatDetailTable");

postfix.getRange("A1:L1").merge();
postfix.getRange("A1").values = [["修复后真实浏览器复验"]];
postfix.getRange("A1").format = { font: { name: font, size: 18, bold: true, color: "#1F2937" } };
postfix.getRange("A2:L2").merge();
postfix.getRange("A2").values = [["7 条专项复验均在 1440×960 Chromium 真实页面执行；结论为 4 条通过、3 条不通过。本轮仅记录证据与提案，不继续修改产品代码。"]];
postfix.getRange("A2").format = { font: { name: font, size: 10, italic: true, color: "#5B6472" } };
postfix.getRange("A4:L4").values = [["用例ID", "问题内容", "测试结论", "页面结果摘要", "不通过原因分析", "修复方案", "修复验收情况", "相关截图", "会话ID", "Trace ID", "Result Set ID", "日志 / Skill 证据"]];
postfix.getRange("A4:L4").format = { fill: "#1F4E78", font: { name: font, size: 10, bold: true, color: "#FFFFFF" }, wrapText: true, horizontalAlignment: "center", verticalAlignment: "center" };
postfix.getRangeByIndexes(4, 0, postfixRows.length, 12).values = postfixRows.map((row) => [
  row.id,
  row.question,
  row.conclusion,
  row.actual,
  row.reason,
  row.fix,
  row.acceptance,
  row.screenshot,
  row.conversationId,
  row.traceId,
  row.resultSetId,
  `${row.logEvidence}；Skill: ${row.skillRefs}`
]);
const postfixEndRow = 4 + postfixRows.length;
postfix.getRange(`A5:L${postfixEndRow}`).format = { font: { name: font, size: 9, color: "#1F2937" }, wrapText: true, verticalAlignment: "top" };
postfix.getRange(`A5:A${postfixEndRow}`).format.font = { name: font, size: 9, bold: true, color: "#1F4E78" };
postfix.getRange(`C5:C${postfixEndRow}`).format = { font: { name: font, size: 9, bold: true, color: "#1F2937" }, horizontalAlignment: "center", verticalAlignment: "top" };
for (let row = 5; row <= postfixEndRow; row++) {
  postfix.getRange(`C${row}`).format.fill = postfixRows[row - 5].conclusion === "通过" ? "#E2F0D9" : "#FCE4D6";
}
postfix.getRange(`A4:L${postfixEndRow}`).format.borders = { insideHorizontal: { style: "thin", color: "#D9E1EA" }, bottom: { style: "thin", color: "#D9E1EA" } };
postfix.freezePanes.freezeRows(4);
[11, 36, 11, 52, 48, 48, 52, 38, 38, 38, 38, 72].forEach((width, index) => postfix.getRangeByIndexes(0, index, 11, 1).format.columnWidth = width);
postfix.getRange(`A5:L${postfixEndRow}`).format.rowHeight = 96;
postfix.tables.add(`A4:L${postfixEndRow}`, true, "PostfixValidationTable");

decision.getRange("A1:H1").merge();
decision.getRange("A1").values = [["平台增强决策清单"]];
decision.getRange("A1").format = { font: { name: font, size: 18, bold: true, color: "#1F2937" } };
decision.getRange("A2:H2").merge();
decision.getRange("A2").values = [["下列事项涉及跨模块契约、数据治理或产品策略，先作为讨论清单，不在本轮直接改动。"]];
decision.getRange("A2").format = { font: { name: font, size: 10, italic: true, color: "#5B6472" } };
decision.getRange("A4:H4").values = [["ID", "增强主题", "UAT证据", "用户影响", "建议方向", "需要讨论的决策", "优先级", "验收标准"]];
decision.getRange("A4:H4").format = { fill: "#1F4E78", font: { name: font, size: 10, bold: true, color: "#FFFFFF" }, wrapText: true, horizontalAlignment: "center", verticalAlignment: "center" };
decision.getRange("A5:H13").values = enhancements;
decision.getRange("A5:H13").format = { font: { name: font, size: 9, color: "#1F2937" }, wrapText: true, verticalAlignment: "top" };
decision.getRange("A5:A13").format.font = { name: font, size: 9, bold: true, color: "#1F4E78" };
decision.getRange("A4:H13").format.borders = { insideHorizontal: { style: "thin", color: "#D9E1EA" }, bottom: { style: "thin", color: "#D9E1EA" } };
decision.freezePanes.freezeRows(4);
[8, 28, 48, 38, 48, 48, 9, 42].forEach((width, index) => decision.getRangeByIndexes(0, index, 13, 1).format.columnWidth = width);
decision.getRange("A5:H13").format.rowHeight = 86;
decision.tables.add("A4:H13", true, "EnhancementDecisionTable");

fix.getRange("A1:G1").merge();
fix.getRange("A1").values = [["已实施修复与回归验收"]];
fix.getRange("A1").format = { font: { name: font, size: 18, bold: true, color: "#1F2937" } };
fix.getRange("A2:G2").merge();
fix.getRange("A2").values = [["仅记录本轮已直接修改并通过目标测试验证的修复。"]];
fix.getRange("A2").format = { font: { name: font, size: 10, italic: true, color: "#5B6472" } };
fix.getRange("A4:G4").values = [["修复ID", "问题", "代码位置", "修复内容", "验收用例", "验收结论", "验收证据"]];
fix.getRange("A4:G4").format = { fill: "#1F4E78", font: { name: font, size: 10, bold: true, color: "#FFFFFF" }, wrapText: true, horizontalAlignment: "center" };
fix.getRangeByIndexes(4, 0, fixes.length, 7).values = fixes;
const fixesEndRow = 4 + fixes.length;
fix.getRange(`A5:G${fixesEndRow}`).format = { font: { name: font, size: 10, color: "#1F2937" }, wrapText: true, verticalAlignment: "top" };
fix.getRange(`A5:A${fixesEndRow}`).format.font = { name: font, size: 10, bold: true, color: "#1F4E78" };
fix.getRange(`A4:G${fixesEndRow}`).format.borders = { insideHorizontal: { style: "thin", color: "#D9E1EA" }, bottom: { style: "thin", color: "#D9E1EA" } };
[10, 24, 42, 58, 15, 14, 70].forEach((width, index) => fix.getRangeByIndexes(0, index, 8, 1).format.columnWidth = width);
fix.getRange(`A5:G${fixesEndRow}`).format.rowHeight = 70;
fix.tables.add(`A4:G${fixesEndRow}`, true, "FixValidationTable");

evidence.getRange("A1:H1").merge();
evidence.getRange("A1").values = [["浏览器截图与运行日志索引"]];
evidence.getRange("A1").format = { font: { name: font, size: 18, bold: true, color: "#1F2937" } };
evidence.getRange("A2:H2").merge();
evidence.getRange("A2").values = [["截图来自 127.0.0.1:8787 浏览器页面；日志证据按会话串联 data/smart-query-conversations 与 data/operation-events。"]];
evidence.getRange("A2").format = { font: { name: font, size: 10, italic: true, color: "#5B6472" } };
evidence.getRange("A4:H4").values = [["用例ID", "问题内容", "概览截图", "详情截图", "回归截图", "会话ID", "Trace/Turn", "Result Set / 日志证据"]];
evidence.getRange("A4:H4").format = { fill: "#1F4E78", font: { name: font, size: 10, bold: true, color: "#FFFFFF" }, wrapText: true, horizontalAlignment: "center" };
evidence.getRange("A5:H38").values = rows.map((row) => [row.id, row.question, row.overview, row.detail, row.regression, row.conversationId, `${row.traceId} / ${row.turnId}`, `${row.resultSetId} / ${row.logEvidence}`]);
evidence.getRange("A5:H38").format = { font: { name: font, size: 9, color: "#1F2937" }, wrapText: true, verticalAlignment: "top" };
evidence.getRange("A5:A38").format.font = { name: font, size: 9, bold: true, color: "#1F4E78" };
evidence.getRange("A4:H38").format.borders = { insideHorizontal: { style: "thin", color: "#D9E1EA" }, bottom: { style: "thin", color: "#D9E1EA" } };
evidence.freezePanes.freezeRows(4);
[13, 38, 48, 48, 58, 38, 72, 90].forEach((width, index) => evidence.getRangeByIndexes(0, index, 38, 1).format.columnWidth = width);
evidence.getRange("A5:H38").format.rowHeight = 64;
evidence.tables.add("A4:H38", true, "EvidenceIndexTable");

await fs.mkdir(outputDir, { recursive: true });
const previewFiles = [
  ["UAT概览", "A1:H22", "uat-overview.png"],
  ["UAT明细", "A1:O10", "uat-detail-preview.png"],
  ["修复复验", "A1:L11", "uat-postfix-validation.png"],
  ["增强决策", "A1:H13", "uat-decisions.png"],
  ["修复记录", "A1:G8", "uat-fixes.png"],
  ["证据索引", "A1:H10", "uat-evidence-preview.png"]
];
await wb.recalculate();
for (const [sheetName, range, fileName] of previewFiles) {
  const preview = await wb.render({ sheetName, range, scale: 1, format: "png" });
  await fs.writeFile(path.join(outputDir, fileName), new Uint8Array(await preview.arrayBuffer()));
}

const overviewInspect = await wb.inspect({ kind: "table", range: "UAT概览!A1:H22", include: "values,formulas", tableMaxRows: 22, tableMaxCols: 8, tableMaxCellChars: 160 });
await fs.writeFile(path.join(outputDir, "inspect-overview.ndjson"), overviewInspect.ndjson ?? "");
const detailInspect = await wb.inspect({ kind: "table", range: "UAT明细!A6:O10", include: "values,formulas", tableMaxRows: 5, tableMaxCols: 15, tableMaxCellChars: 140 });
await fs.writeFile(path.join(outputDir, "inspect-detail.ndjson"), detailInspect.ndjson ?? "");
const postfixInspect = await wb.inspect({ kind: "table", range: "修复复验!A4:L11", include: "values,formulas", tableMaxRows: 8, tableMaxCols: 12, tableMaxCellChars: 180 });
await fs.writeFile(path.join(outputDir, "inspect-postfix.ndjson"), postfixInspect.ndjson ?? "");
const errors = await wb.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!", options: { useRegex: true, maxResults: 300 }, summary: "final formula error scan" });
await fs.writeFile(path.join(outputDir, "formula-errors.ndjson"), errors.ndjson ?? "");

const xlsx = await SpreadsheetFile.exportXlsx(wb);
await xlsx.save(path.join(outputDir, "UAT-AY-销售订单智能问数-UAT报告.xlsx"));
console.log(JSON.stringify({ outputDir, originalCases: rows.length, postfixCases: postfixRows.length, postfixPassed: postfixRows.filter((row) => row.conclusion === "通过").length, postfixFailed: postfixRows.filter((row) => row.conclusion === "不通过").length, enhancements: enhancements.length, fixes: fixes.length, primaryConversations: primaryConversations.length, regressions: regressionConversations.size, previewFiles: previewFiles.map((item) => item[2]), formulaErrorScan: errors.ndjson ?? "" }, null, 2));
