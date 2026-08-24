import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDocxTemplate } from '../lib/template/docx-parser.mjs';
import { composeDocxTemplate, replaceTextNodes } from '../lib/template/docx-composer.mjs';

test('真实能耗 Word 模板可解析为标准 Block 模型', async () => {
  const source = await readFile(new URL('../WordTemplates/能耗分析报告6月.docx', import.meta.url));
  const model = parseDocxTemplate(source, { filename: '能耗分析报告6月.docx' });
  assert.equal(model.schema, 'wynai.docx-template/v1');
  assert.ok(model.parts.includes('word/document.xml'));
  assert.ok(model.blocks.some(block => block.type === 'paragraph'));
  assert.ok(model.blocks.some(block => block.type === 'table'));
  assert.ok(model.template.sha256.startsWith('sha256:'));
});

test('跨 Word run 的占位符可以回填且重新打包后仍可解析', async () => {
  const xml = '<w:p><w:r><w:t>{{sales_</w:t></w:r><w:r><w:t>amount}}</w:t></w:r></w:p>';
  assert.match(replaceTextNodes(xml, { sales_amount: '123.45' }), /123\.45/);
  const source = await readFile(new URL('../WordTemplates/能耗分析报告6月.docx', import.meta.url));
  const output = composeDocxTemplate(source, { report_period: '2026年7月' });
  const model = parseDocxTemplate(output, { filename: 'output.docx' });
  assert.ok(model.blocks.length > 0);
});
