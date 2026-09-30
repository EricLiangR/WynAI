import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "file:///C:/Users/zenoszeng/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const root = process.cwd();
const outputDir = path.join(root, "UAT-AY", "postfix-browser-uat");
const screenshotDir = path.join(root, "UAT-AY", "screenshots");
const datasetLabel = "01测试销售订单-09";
const cases = [
  { id: "PF-001", question: "我的客户中head_office_location是美国的名单" },
  { id: "PF-002", question: "我的POE客户名单" },
  { id: "PF-003", question: "MNC 客户的商机金额是多少" },
  { id: "PF-004", question: "GPS行业的客户名单" },
  { id: "PF-005", question: "有什么recurring的项目" },
  { id: "PF-006", question: "请列出所有recurring项目的项目名称" },
  { id: "PF-007", question: "请列出所有商机来源为Recurring（结转）的项目名称" },
  { id: "PF-008", question: "今年x-ssl的项目有哪些" },
  { id: "PF-009", question: "2025自然年销售额是多少" },
  { id: "PF-010", question: "今年销售额是多少" },
  { id: "PF-011", question: "recurring的商机，产品是 Safety Production and Risk Control in Manufacturing 的有哪些" },
];

await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(screenshotDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:/Users/zenoszeng/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
const consoleEntries = [];
const pageErrors = [];
page.on("console", (message) => consoleEntries.push({
  at: new Date().toISOString(),
  type: message.type(),
  text: message.text(),
}));
page.on("pageerror", (error) => pageErrors.push({
  at: new Date().toISOString(),
  message: error.message,
  stack: error.stack,
}));

await page.goto("http://127.0.0.1:8787/", { waitUntil: "networkidle", timeout: 60_000 });
const dataset = page.locator("#smart-dataset-select");
await dataset.waitFor({ state: "visible", timeout: 30_000 });
if ((await dataset.inputValue()) !== datasetLabel) {
  await dataset.selectOption({ label: datasetLabel });
  await page.waitForTimeout(1_500);
}

const selectedCaseId = process.argv[2] ?? null;
const runCases = selectedCaseId ? cases.filter((item) => item.id === selectedCaseId) : cases;
if (!runCases.length) throw new Error(`Unknown case id: ${selectedCaseId}`);
let previousResults = [];
if (selectedCaseId) {
  try {
    previousResults = JSON.parse(await fs.readFile(path.join(outputDir, "results.json"), "utf8"));
  } catch {
    previousResults = [];
  }
}
const currentResults = [];
for (const item of runCases) {
  await page.locator("#smart-new-conversation").click();
  await page.locator("#smart-question").fill(item.question);
  const startedAt = new Date().toISOString();
  const beforeText = await page.locator("#smart-query-output").innerText();
  await page.locator("#smart-ask-button").click();
  await page.waitForFunction(
    ({ previous }) => {
      const output = document.querySelector("#smart-query-output")?.innerText ?? "";
      return output !== previous && (
        output.includes("已完成，可以继续追问") ||
        output.includes("需要确认") ||
        output.includes("本轮未完成")
      );
    },
    { previous: beforeText },
    { timeout: 120_000 },
  );
  await page.waitForTimeout(500);
  const uiText = await page.locator("#smart-query-output").innerText();
  const screenshot = path.join(screenshotDir, `${item.id}-postfix.png`);
  await page.screenshot({ path: screenshot, fullPage: false });
  currentResults.push({
    ...item,
    startedAt,
    completedAt: new Date().toISOString(),
    uiText,
    screenshot: path.relative(root, screenshot).replaceAll("\\", "/"),
  });
}

const currentIds = new Set(currentResults.map((item) => item.id));
const results = [...previousResults.filter((item) => !currentIds.has(item.id)), ...currentResults]
  .sort((a, b) => a.id.localeCompare(b.id));

await fs.writeFile(path.join(outputDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
await fs.writeFile(path.join(outputDir, "console.json"), `${JSON.stringify(consoleEntries, null, 2)}\n`);
await fs.writeFile(path.join(outputDir, "page-errors.json"), `${JSON.stringify(pageErrors, null, 2)}\n`);
await browser.close();

console.log(JSON.stringify({
  cases: results.map(({ id, question, screenshot }) => ({ id, question, screenshot })),
  consoleEntries: consoleEntries.length,
  pageErrors: pageErrors.length,
}, null, 2));
