import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readProjectFile = path => readFile(new URL(path, import.meta.url), 'utf8');

test('智能问数回答区使用合并结果工具栏和低依赖导出方案', async () => {
  const [app, css, packageJson] = await Promise.all([
    readProjectFile('./public/app.js'),
    readProjectFile('./public/styles.css'),
    readProjectFile('./package.json'),
  ]);
  const packageData = JSON.parse(packageJson);
  assert.match(app, /data-smart-copy-answer=/);
  assert.match(app, /<summary>详情<\/summary>/);
  assert.match(app, /业务理解/);
  assert.match(app, /聚合后筛选/);
  assert.match(app, /高级诊断/);
  assert.match(app, /payload\.response \|\| \{\}/);
  assert.match(app, /copy: '<rect x="9" y="9" width="11" height="11" rx="2"\/><path d="M15 9V6/);
  assert.doesNotMatch(app, /const answerHead =|smart-analysis-details-head/);
  assert.match(app, /const key = block\.dataRef \|\| block\.id/);
  assert.match(app, /class="smart-query-result wide"/);
  assert.match(app, /\$\{insightToolbar\}\$\{chartGroupBeforeDivider\}\$\{chartControls\}\$\{chartGroupAfterDivider\}\$\{chartDownloads\}\$\{chartDivider\}\$\{tableActions\}\$\{maximizeDivider\}/);
  assert.doesNotMatch(app, /data-smart-table-copy-mode="page"/);
  assert.match(app, /data-smart-table-copy-mode="all"[\s\S]*smartIcon\('copy'\)/);
  assert.match(app, /getDataURL\(\{ type: 'png', pixelRatio: 2, backgroundColor: '#fff' \}\)/);
  assert.match(app, /type: 'text\/csv;charset=utf-8'/);
  assert.match(app, /data-smart-result-maximize/);
  assert.match(app, /smart-result-close/);
  assert.match(app, /previousSection === 'smart-query' && requestedSection !== 'smart-query'/);
  assert.match(app, /is-table-only-maximized/);
  assert.match(app, /filter\(isCredibilityWarning\)/);
  assert.match(app, /回答有问题/);
  assert.match(app, /smart-feedback-positive/);
  assert.match(app, /smart-feedback-negative/);
  assert.match(app, /smartIcon\('thumbUp'\)/);
  assert.match(app, /data-smart-copy-question/);
  assert.match(app, /问题已复制/);
  assert.match(css, /smart-message-user:hover \.smart-question-copy/);
  assert.match(app, /smart-feedback-dialog/);
  assert.match(app, /smart-feedback-reason/);
  assert.match(app, /dialog\.classList\.add\('is-closing'\)/);
  assert.match(app, /event\.animationName === 'smart-result-close'/);
  assert.match(app, /没有回答我的问题/);
  assert.doesNotMatch(app, /class="smart-chart-decision"/);
  assert.equal(packageData.dependencies.xlsx, undefined);
  assert.equal(packageData.dependencies.exceljs, undefined);
  assert.match(css, /\.agent-workspace\.smart-query-mode \.smart-message \{ max-width: 1180px; \}/);
  assert.match(css, /\.smart-query-result\.is-maximized \{ position: fixed;/);
  assert.match(css, /\.smart-query-result\.is-maximized\.is-table-only-maximized \.smart-table-scroll \{ min-height: 0; flex: 1; max-height: none;/);
  assert.match(css, /\.smart-query-table th \{ position: sticky; top: 0; z-index: 2;/);
  assert.match(css, /@keyframes smart-result-open/);
  assert.match(css, /@keyframes smart-result-close/);
  assert.match(css, /--dialog-open-animation: var\(--smart-dialog-open-animation\)/);
  assert.match(css, /--dialog-close-animation: var\(--smart-dialog-close-animation\)/);
  assert.match(css, /--smart-dialog-open-animation: smart-result-open/);
  assert.match(css, /--smart-dialog-close-animation: smart-result-close/);
  assert.match(css, /--dialog-backdrop-open-animation: var\(--smart-dialog-backdrop-open-animation\)/);
  assert.match(css, /--dialog-backdrop-close-animation: var\(--smart-dialog-backdrop-close-animation\)/);
  assert.match(css, /smart-feedback-dialog \.smart-feedback-correction \{[^}]*width: min\(944px/);
  assert.match(css, /smart-feedback-dialog \.smart-feedback-correction \{[^}]*height: min\(550px/);
  assert.match(css, /smart-feedback-dialog \.smart-feedback-correction fieldset \{[^}]*grid-template-columns: repeat\(2/);
  assert.match(css, /smart-feedback-dialog-actions button \{[^}]*width: 80px; height: 36px; min-height: 36px/);
  assert.match(css, /smart-feedback-dialog \.smart-feedback-correction \{[^}]*animation: var\(--smart-dialog-open-animation\)/);
  assert.match(css, /smart-feedback-dialog\.is-closing \.smart-feedback-correction \{[^}]*animation: var\(--smart-dialog-close-animation\)/);
  assert.match(css, /prefers-reduced-motion/);
});
