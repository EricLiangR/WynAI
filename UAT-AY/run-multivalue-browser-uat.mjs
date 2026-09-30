import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'file:///C:/Users/zenoszeng/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const root = process.cwd();
const outputDir = path.join(root, 'UAT-AY', 'multivalue-browser-uat');
const screenshotDir = path.join(outputDir, 'screenshots');
const datasetLabel = '01测试销售订单-09';
const cases = [
  { id: 'MV-001', question: '我的POE客户名单' },
  { id: 'MV-002', question: '我的MNC客户名单' },
  { id: 'MV-003', question: '我的POE、MNC客户名单' },
  { id: 'MV-004', question: 'MNC、POE客户的商机金额是多少' },
  { id: 'MV-005', question: '不是MNC和POE客户的商机金额是多少' },
  { id: 'MV-006', question: 'MNC 客户的商机金额大于20万的商机有几个' },
];

await fs.mkdir(screenshotDir, { recursive: true });
const browser = await chromium.launch({
  headless: false,
  executablePath: 'C:/Users/zenoszeng/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe',
});
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const consoleEntries = [];
const pageErrors = [];
page.on('console', message => consoleEntries.push({ type: message.type(), text: message.text(), at: new Date().toISOString() }));
page.on('pageerror', error => pageErrors.push({ message: error.message, stack: error.stack, at: new Date().toISOString() }));

await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle', timeout: 60_000 });
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
const results = [];
for (const item of runCases) {
  await page.locator('#smart-new-conversation').click();
  await page.locator('#smart-question').fill(item.question);
  const previous = await page.locator('#smart-query-output').innerText();
  const startedAt = new Date().toISOString();
  await page.locator('#smart-ask-button').click();
  await page.waitForFunction(({ before }) => {
    const output = document.querySelector('#smart-query-output')?.innerText || '';
    return output !== before && (output.includes('已完成，可以继续追问') || output.includes('需要确认') || output.includes('本轮未完成'));
  }, { before: previous }, { timeout: 120_000 });
  await page.waitForTimeout(700);
  const uiText = await page.locator('#smart-query-output').innerText();
  const screenshot = path.join(screenshotDir, `${item.id}.png`);
  await page.screenshot({ path: screenshot, fullPage: false });
  results.push({
    ...item,
    startedAt,
    completedAt: new Date().toISOString(),
    status: uiText.includes('需要确认') || uiText.includes('本轮未完成') ? 'not-passed' : 'passed',
    uiText,
    screenshot: path.relative(root, screenshot).replaceAll('\\', '/'),
  });
}

const currentIds = new Set(results.map(item => item.id));
const combinedResults = [...previousResults.filter(item => !currentIds.has(item.id)), ...results]
  .sort((left, right) => left.id.localeCompare(right.id));
await fs.writeFile(path.join(outputDir, 'results.json'), `${JSON.stringify(combinedResults, null, 2)}\n`);
await fs.writeFile(path.join(outputDir, 'console.json'), `${JSON.stringify(consoleEntries, null, 2)}\n`);
await fs.writeFile(path.join(outputDir, 'page-errors.json'), `${JSON.stringify(pageErrors, null, 2)}\n`);
await browser.close();
console.log(JSON.stringify({
  dataset: datasetLabel,
  cases: combinedResults.map(item => ({ id: item.id, question: item.question, status: item.status, screenshot: item.screenshot })),
  consoleEntries: consoleEntries.length,
  pageErrors: pageErrors.length,
}, null, 2));
