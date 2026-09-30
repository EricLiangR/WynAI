import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'file:///C:/Users/zenoszeng/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const root = process.cwd();
const outputDir = path.join(root, 'UAT-AY', 'multivalue-browser-uat');
const browser = await chromium.launch({
  headless: false,
  executablePath: 'C:/Users/zenoszeng/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle', timeout: 60_000 });
const dataset = page.locator('#smart-dataset-select');
await dataset.waitFor({ state: 'visible', timeout: 30_000 });
if (await dataset.inputValue() !== '01测试销售订单-09') await dataset.selectOption({ label: '01测试销售订单-09' });
await page.locator('#smart-new-conversation').click();
await page.locator('#smart-question').fill('我的POE、MNC客户名单');
const before = await page.locator('#smart-query-output').innerText();
await page.locator('#smart-ask-button').click();
await page.waitForFunction(({ previous }) => {
  const text = document.querySelector('#smart-query-output')?.innerText || '';
  return text !== previous && text.includes('第 1 / 200 页');
}, { previous: before }, { timeout: 120_000 });
const pageOne = await page.locator('#smart-query-output').innerText();
await page.screenshot({ path: path.join(outputDir, 'screenshots', 'MV-003-page-1.png'), fullPage: false });
const firstRowPageOne = await page.locator('#smart-query-output table tbody tr').first().innerText();
const next = page.getByRole('button', { name: '下一页' });
await next.click();
await page.waitForFunction(() => (document.querySelector('#smart-query-output')?.innerText || '').includes('第 2 / 200 页'), undefined, { timeout: 30_000 });
const pageTwo = await page.locator('#smart-query-output').innerText();
await page.screenshot({ path: path.join(outputDir, 'screenshots', 'MV-003-page-2.png'), fullPage: false });
const firstRowPageTwo = await page.locator('#smart-query-output table tbody tr').first().innerText();
const evidence = {
  question: '我的POE、MNC客户名单',
  dataset: '01测试销售订单-09',
  totalRows: 20000,
  pageCount: 200,
  pageOneVisible: pageOne.includes('第 1 / 200 页'),
  pageTwoVisible: pageTwo.includes('第 2 / 200 页'),
  firstRowPageOne,
  firstRowPageTwo,
  rowsChanged: firstRowPageOne !== firstRowPageTwo,
  screenshots: ['UAT-AY/multivalue-browser-uat/screenshots/MV-003-page-1.png', 'UAT-AY/multivalue-browser-uat/screenshots/MV-003-page-2.png'],
};
await fs.writeFile(path.join(outputDir, 'pagination-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
await browser.close();
