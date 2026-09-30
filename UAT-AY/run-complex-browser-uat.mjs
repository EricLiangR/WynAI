import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'file:///C:/Users/zenoszeng/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const root = process.cwd();
const outputDir = path.join(root, 'UAT-AY', 'complex-browser-uat');
const screenshotDir = path.join(outputDir, 'screenshots');
const datasetLabel = '01测试销售订单-09';
const cases = [
  { id: 'B-001', question: '今年 x-ssl 的项目，而且是 POE 类型的有哪些，返回项目名称、客户名称、销售总监、合作伙伴、创建日期、预计结束日期', must: ['x-ssl', 'POE', '项目名称', '客户名称', '销售总监', '合作伙伴', '创建日期', '预计结束日期'] },
  { id: 'B-002', question: '今年 x-ssl 的 MNC 项目有哪些？请列出项目名称、客户名称、产品、销售总监和商机金额', must: ['x-ssl', 'MNC', '项目名称', '客户名称', '产品', '销售总监', '商机金额'] },
  { id: 'B-003', question: '去年 x-ssl 且 recurring 的项目有哪些？请返回项目名称、客户名称、recurring 类型和订单金额', must: ['x-ssl', 'recurring', '项目名称', '客户名称', '订单金额'] },
  { id: 'B-004', question: '今年 POE 客户中 recurring 的项目有哪些？请列出项目名称、客户名称、产品和预计结束日期', must: ['POE', 'recurring', '项目名称', '客户名称', '产品', '预计结束日期'] },
  { id: 'B-005', question: 'x-ssl 项目中，哪些是 PSM？请列出项目名称、客户名称、客户类型、prime office 和产品', must: ['x-ssl', 'PSM', '项目名称', '客户名称', '客户类型', 'prime office', '产品'] },
  { id: 'B-006', question: '今年属于 PSM 的 x-ssl 项目有哪些？返回项目名称、客户名称、销售总监、合作伙伴和 prime office', must: ['PSM', 'x-ssl', '项目名称', '客户名称', '销售总监', '合作伙伴', 'prime office'] },
  { id: 'B-007', question: '今年 x-ssl 项目中，产品是 Safety Production and Risk Control in Manufacturing 的有哪些？请列出项目名称、客户名称、客户类型和商机金额', must: ['x-ssl', 'Safety Production and Risk Control in Manufacturing', '项目名称', '客户名称', '客户类型', '商机金额'] },
  { id: 'B-008', question: '今年 MNC 和 POE 客户的 x-ssl 项目，按产品统计商机金额和项目数量', must: ['MNC', 'POE', 'x-ssl', '产品', '商机金额', '项目数量'] },
  { id: 'B-009', question: 'x-ssl 项目中，MNC 客户且商机金额大于 20 万的有哪些？请列出客户名称、项目名称、产品、商机金额', must: ['x-ssl', 'MNC', '20', '客户名称', '项目名称', '产品', '商机金额'] },
  { id: 'B-010', question: '去年 Digital Ecosystem Enterprise Alliances 产品中，POE 客户有哪些？请列出客户名称、项目名称、订单金额和创建日期', must: ['Digital Ecosystem Enterprise Alliances', 'POE', '客户名称', '项目名称', '订单金额', '创建日期'], followUpOption: 'code_open_date' },
];

await fs.mkdir(screenshotDir, { recursive: true });
const browser = await chromium.launch({
  headless: process.argv.includes('--headless'),
  executablePath: 'C:/Users/zenoszeng/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe',
});
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const consoleEntries = [];
const pageErrors = [];
page.on('console', message => consoleEntries.push({ type: message.type(), text: message.text(), at: new Date().toISOString() }));
page.on('pageerror', error => pageErrors.push({ message: error.message, stack: error.stack, at: new Date().toISOString() }));

async function waitForSmartQueryTerminal() {
  await page.locator('#smart-message-loading').waitFor({ state: 'attached', timeout: 10_000 });
  await page.locator('#smart-message-loading').waitFor({ state: 'detached', timeout: 120_000 });
  await page.waitForFunction(() => {
    const status = document.querySelector('#smart-query-status')?.textContent || '';
    return status === '等待你补充信息'
      || status === '已完成，可以继续追问'
      || status === '大模型服务暂时不可用，请稍后重试。'
      || document.querySelector('.smart-message-error, .smart-message-cancelled');
  }, undefined, { timeout: 5_000 });
}

await page.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
const dataset = page.locator('#smart-dataset-select');
await dataset.waitFor({ state: 'visible', timeout: 30_000 });
if (await dataset.inputValue() !== datasetLabel) {
  await dataset.selectOption({ label: datasetLabel });
  await page.waitForTimeout(1_500);
}

const requestedId = process.argv[2] || null;
const runCases = requestedId ? cases.filter(item => item.id === requestedId) : cases;
if (!runCases.length) throw new Error(`Unknown case id: ${requestedId}`);
let previousResults = [];
if (requestedId) {
  try { previousResults = JSON.parse(await fs.readFile(path.join(outputDir, 'results.json'), 'utf8')); } catch { previousResults = []; }
}

const currentResults = [];
for (const item of runCases) {
  await page.locator('#smart-new-conversation').click();
  await page.locator('#smart-question').fill(item.question);
  const beforeText = await page.locator('#smart-query-output').innerText();
  const startedAt = new Date().toISOString();
  await page.locator('#smart-ask-button').click();
  await waitForSmartQueryTerminal();
  await page.waitForTimeout(700);
  let uiText = await page.locator('#smart-query-output').innerText();
  const screenshot = path.join(screenshotDir, `${item.id}.png`);
  await page.screenshot({ path: screenshot, fullPage: false });
  let clarificationText = null;
  let followUpScreenshot = null;
  if (item.followUpOption && uiText.includes('需要确认')) {
    clarificationText = uiText;
    await page.getByRole('button', { name: item.followUpOption, exact: true }).click();
    await waitForSmartQueryTerminal();
    await page.waitForTimeout(700);
    uiText = await page.locator('#smart-query-output').innerText();
    followUpScreenshot = path.join(screenshotDir, `${item.id}-confirmed.png`);
    await page.screenshot({ path: followUpScreenshot, fullPage: false });
  } else if (item.followUpOption) {
    await fs.rm(path.join(screenshotDir, `${item.id}-confirmed.png`), { force: true });
  }
  const missing = item.must.filter(token => !uiText.toLowerCase().includes(token.toLowerCase()));
  const completed = uiText.includes('已完成，可以继续追问');
  const needsConfirmation = uiText.includes('需要确认') || uiText.includes('本轮未完成');
  currentResults.push({
    id: item.id,
    question: item.question,
    mustCheck: item.must,
    startedAt,
    completedAt: new Date().toISOString(),
    status: completed && !needsConfirmation && missing.length === 0 ? 'passed' : 'needs-review',
    completionState: completed ? 'completed' : needsConfirmation ? 'needs-confirmation' : 'other',
    missingExpectedText: missing,
    clarificationText,
    uiText,
    screenshot: path.relative(root, screenshot).replaceAll('\\', '/'),
    followUpScreenshot: followUpScreenshot ? path.relative(root, followUpScreenshot).replaceAll('\\', '/') : null,
  });
}

const currentIds = new Set(currentResults.map(item => item.id));
const results = [...previousResults.filter(item => !currentIds.has(item.id)), ...currentResults]
  .sort((a, b) => a.id.localeCompare(b.id));
await fs.writeFile(path.join(outputDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
await fs.writeFile(path.join(outputDir, 'console.json'), `${JSON.stringify(consoleEntries, null, 2)}\n`);
await fs.writeFile(path.join(outputDir, 'page-errors.json'), `${JSON.stringify(pageErrors, null, 2)}\n`);
await browser.close();
console.log(JSON.stringify({
  dataset: datasetLabel,
  cases: results.map(({ id, question, status, completionState, missingExpectedText, screenshot }) => ({ id, question, status, completionState, missingExpectedText, screenshot })),
  consoleEntries: consoleEntries.length,
  pageErrors: pageErrors.length,
}, null, 2));
