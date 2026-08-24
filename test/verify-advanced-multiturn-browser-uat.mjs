import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), 'uat-artifacts', 'advanced-multiturn-50', '2026-08-24');
const evidenceRoot = join(root, 'browser-evidence');
const api = JSON.parse(await readFile(join(root, 'api-results.json'), 'utf8'));
const desktop = JSON.parse(await readFile(join(evidenceRoot, 'browser-desktop-results.json'), 'utf8'));
const mobile = JSON.parse(await readFile(join(evidenceRoot, 'browser-mobile-results.json'), 'utf8'));
const apiById = new Map(api.results.map((item) => [item.id, item]));
const desktopById = new Map(desktop.results.map((item) => [item.id, item]));
const hashes = new Set();
const checks = [];
const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const percentFormat = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 2 });

function jpegInfo(buffer) {
  assert.equal(buffer[0], 0xff, '截图不是 JPEG');
  assert.equal(buffer[1], 0xd8, '截图不是 JPEG');
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    assert.ok(length >= 2, 'JPEG 段长度无效');
    offset += 2 + length;
  }
  assert.fail('无法读取 JPEG 尺寸');
}

function visibleCandidates(value, column = {}) {
  if (value == null) return [];
  if (column.format === 'percentage' || column.role === 'derived-measure') {
    return [percentFormat.format(Number(value))];
  }
  if (column.type === 'number' || typeof value === 'number') {
    return [numberFormat.format(Number(value))];
  }
  if (column.type === 'date' || column.grain) {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) {
      const year = date.getUTCFullYear();
      const month = date.getUTCMonth() + 1;
      if (column.grain === 'year') return [year + '年', String(year)];
      if (column.grain === 'quarter') return [year + '年第' + (Math.floor((month - 1) / 3) + 1) + '季度'];
      if (column.grain === 'month') return [year + '年' + month + '月', year + '-' + String(month).padStart(2, '0')];
    }
  }
  return [String(value)];
}

async function verifyScreenshot(relativePath, expectedWidth, expectedHeight) {
  const path = join(evidenceRoot, relativePath);
  const buffer = await readFile(path);
  const file = await stat(path);
  assert.ok(file.size >= 30_000, relativePath + ' 文件异常偏小');
  const image = jpegInfo(buffer);
  assert.deepEqual(image, { width: expectedWidth, height: expectedHeight }, relativePath + ' 尺寸错误');
  const hash = createHash('sha256').update(buffer).digest('hex');
  assert.ok(!hashes.has(hash), relativePath + ' 与其他验收截图完全重复');
  hashes.add(hash);
  return { path: relativePath, bytes: file.size, size: image.width + 'x' + image.height, sha256: hash };
}

function verifyTurnContract(ui, source, errors) {
  if (ui.turns.length !== source.turns.length) errors.push('浏览器/API 轮次不一致');
  source.turns.forEach((turn, index) => {
    const browserTurn = ui.turns[index];
    if (!browserTurn) return;
    if (browserTurn.question !== turn.question) errors.push('第 ' + (index + 1) + ' 轮问题不一致');
    if (browserTurn.expectedStatus !== turn.expectedStatus || browserTurn.actualStatus !== turn.actualStatus) {
      errors.push('第 ' + (index + 1) + ' 轮状态不一致');
    }
    if (!browserTurn.passed) errors.push('第 ' + (index + 1) + ' 轮浏览器断言失败');
    if (!ui.visibleText.includes(turn.question)) errors.push('页面缺少第 ' + (index + 1) + ' 轮用户问题');
  });
}

function verifyFinalAnswer(ui, source, errors) {
  const turn = [...source.turns].reverse().find((item) => item.actualStatus === 'ok');
  if (!turn?.result) return;
  if (!turn.semanticValidation?.valid) errors.push('最终结果未通过语义校验');
  const firstRow = turn.result.firstRows?.[0];
  for (const column of turn.result.schema || []) {
    const title = column.displayName || column.sourceField || column.name;
    if (title && !ui.visibleText.includes(title)) errors.push('页面缺少结果标题 ' + title);
    if (!firstRow || firstRow[column.name] == null) continue;
    const candidates = visibleCandidates(firstRow[column.name], column);
    if (candidates.length && !candidates.some((value) => ui.visibleText.includes(value))) {
      errors.push('页面缺少首行结果 ' + column.name + '=' + candidates.join('/'));
    }
  }
}

assert.equal(api.schema, 'wynai.advanced-multiturn-uat/v1');
assert.deepEqual(api.summary, { scenarios: 50, turns: 101, passed: 50, failed: 0 });
for (const [surface, data, expected] of [
  ['desktop', desktop, { total: 50, width: 1440, height: 1000 }],
  ['mobile', mobile, { total: 10, width: 390, height: 844 }],
]) {
  assert.equal(data.summary.total, expected.total, surface + ' 用例数错误');
  assert.equal(data.summary.passed, expected.total, surface + ' 通过数错误');
  assert.equal(data.summary.failed, 0, surface + ' 存在失败用例');
  assert.equal(data.summary.pageOverflow, 0, surface + ' 页面横向溢出');
  assert.equal(data.summary.messageOverflow, 0, surface + ' 消息区横向溢出');
  assert.equal(data.summary.composerOverlap, 0, surface + ' 输入区遮挡');
  assert.equal(data.summary.consoleErrors, 0, surface + ' 控制台存在错误');
}

for (const [surface, data, width, height] of [
  ['desktop', desktop, 1440, 1000],
  ['mobile', mobile, 390, 844],
]) {
  for (const ui of data.results) {
    const source = apiById.get(ui.id);
    const errors = [];
    if (!source) errors.push('缺少 API 对照场景');
    if (surface === 'mobile' && !desktopById.has(ui.id)) errors.push('缺少桌面对照场景');
    if (!ui.completed) errors.push('页面未完成渲染');
    if (ui.layout.pageOverflow || ui.layout.messageOverflow || ui.layout.composerOverlap) errors.push(surface + ' 布局不合格');
    if (ui.layout.viewport.width !== width || ui.layout.viewport.height !== height) errors.push(surface + ' 视口记录错误');
    if (source) {
      verifyTurnContract(ui, source, errors);
      verifyFinalAnswer(ui, source, errors);
    }
    const image = await verifyScreenshot(ui.screenshot, width, height);
    checks.push({ id: ui.id, surface, title: ui.title, passed: errors.length === 0, errors, turns: ui.turns, image });
  }
}

const report = {
  schema: 'wynai.advanced-browser-api-crosscheck/v1',
  verifiedAt: new Date().toISOString(),
  summary: {
    apiScenarios: api.summary.scenarios,
    apiTurns: api.summary.turns,
    desktop: desktop.summary,
    mobile: mobile.summary,
    screenshots: checks.length,
    uniqueScreenshots: hashes.size,
    passed: checks.filter((item) => item.passed).length,
    failed: checks.filter((item) => !item.passed).length,
  },
  checks,
};

await writeFile(join(root, 'browser-evidence-verification.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
assert.equal(report.summary.failed, 0, report.summary.failed + ' 个高级 UAT 截图/API 交叉核验失败');
assert.equal(report.summary.uniqueScreenshots, 60);
console.log(JSON.stringify(report.summary));