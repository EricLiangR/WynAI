import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), 'uat-artifacts', 'semantic-50', '2026-08-23');
const api = JSON.parse(await readFile(join(root, 'api-results.json'), 'utf8'));
const browser = JSON.parse(await readFile(join(root, 'browser-results.json'), 'utf8'));
const apiById = new Map(api.results.map(item => [item.id, item]));
const checks = [];
const hashes = new Set();
const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });

function imageInfo(buffer) {
  if (buffer.subarray(1, 4).toString('ascii') === 'PNG') {
    return { format: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { format: 'jpeg', height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  return { format: 'unknown', width: 0, height: 0 };
}

assert.equal(api.summary.total, 50);
assert.equal(api.summary.failed, 0);
assert.equal(browser.summary.total, 50);
assert.equal(browser.summary.consoleErrors, 0);

for (const ui of browser.results) {
  const source = apiById.get(ui.id);
  const errors = [];
  if (!source) errors.push('缺少 API 对照记录');
  if (!ui.completed) errors.push('页面未完成渲染');
  if (ui.layout.pageOverflow || ui.layout.messageOverflow) errors.push('页面存在横向溢出');
  const imageEvidence = [];
  for (const [kind, relativePath] of [['detail', ui.screenshot], ['overview', ui.overviewScreenshot]]) {
    if (!relativePath) { errors.push(`缺少${kind}截图索引`); continue; }
    const screenshotPath = join(root, relativePath);
    const screenshot = await readFile(screenshotPath);
    const screenshotStat = await stat(screenshotPath);
    if (screenshotStat.size < 10_000) errors.push(`${kind}截图文件异常偏小`);
    const image = imageInfo(screenshot);
    if (image.format === 'unknown') errors.push(`${kind}截图不是受支持的 PNG/JPEG`);
    const { width, height } = image;
    if (width < 800 || height < 600) errors.push(`${kind}截图尺寸不足 ${width}x${height}`);
    const hash = createHash('sha256').update(screenshot).digest('hex');
    if (hashes.has(hash)) errors.push(`${kind}截图与其他用例完全重复`);
    hashes.add(hash);
    imageEvidence.push({ kind, path: relativePath, bytes: screenshotStat.size, size: `${width}x${height}`, format: image.format });
  }

  if (source?.actualStatus === 'ok') {
    const summary = source.resultSummary;
    const request = source.request;
    const firstRow = summary?.firstRows?.[0] || {};
    if (!source.semanticValidation?.valid) errors.push('API 语义结果校验未通过');
    for (const select of request.select) {
      if (!ui.visibleText.includes(select.field)) errors.push(`页面缺少维度标题 ${select.field}`);
      if (firstRow[select.alias] != null) {
        const value = select.grain
          ? String(firstRow[select.alias]).slice(0, 4)
          : String(firstRow[select.alias]);
        if (!ui.visibleText.includes(value)) errors.push(`页面缺少首行实体/期间 ${value}`);
      }
    }
    for (const measure of request.measures) {
      if (!ui.visibleText.includes(measure.field)) errors.push(`页面缺少指标标题 ${measure.field}`);
      const value = Number(firstRow[measure.alias]);
      if (Number.isFinite(value) && !ui.visibleText.includes(numberFormat.format(value))) errors.push(`页面缺少首行精确指标值 ${numberFormat.format(value)}`);
    }
    if (request.select.length) {
      const expectedRows = Math.min(summary.rowCount, 30);
      if (ui.tableRows !== expectedRows) errors.push(`页面表格行数 ${ui.tableRows} 与 API ${expectedRows} 不一致`);
    }
  } else if (!ui.visibleText.includes('查询结果未通过原问题语义校验')) {
    errors.push('无数据场景没有显示受控提示');
  }
  checks.push({
    id: ui.id,
    question: ui.question,
    passed: errors.length === 0,
    errors,
    screenshot: ui.screenshot,
    overviewScreenshot: ui.overviewScreenshot,
    imageEvidence,
    apiRows: source?.resultSummary?.rowCount ?? 0,
    uiRows: ui.tableRows,
    firstRows: source?.resultSummary?.firstRows?.slice(0, 3) || [],
  });
}

const report = {
  schema: 'wynai.browser-api-crosscheck/v1',
  verifiedAt: new Date().toISOString(),
  summary: {
    total: checks.length,
    passed: checks.filter(item => item.passed).length,
    failed: checks.filter(item => !item.passed).length,
    uniqueScreenshots: hashes.size,
  },
  checks,
};
await writeFile(join(root, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
assert.equal(report.summary.failed, 0, `${report.summary.failed} 个截图/API 交叉核验失败`);
console.log(JSON.stringify(report.summary));
