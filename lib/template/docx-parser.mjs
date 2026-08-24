import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

function xmlDecode(value) {
  return String(value || '')
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'").replaceAll('&amp;', '&');
}

function readUInt(buffer, offset, length) {
  return length === 2 ? buffer.readUInt16LE(offset) : buffer.readUInt32LE(offset);
}

function readZipEntries(buffer) {
  const endSignature = 0x06054b50;
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === endSignature) { end = offset; break; }
  }
  if (end < 0) throw new Error('DOCX 不是有效的 ZIP 文档');
  const count = readUInt(buffer, end + 10, 2);
  const centralOffset = readUInt(buffer, end + 16, 4);
  const entries = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('DOCX ZIP 中央目录损坏');
    const compression = readUInt(buffer, cursor + 10, 2);
    const compressedSize = readUInt(buffer, cursor + 20, 4);
    const uncompressedSize = readUInt(buffer, cursor + 24, 4);
    const nameLength = readUInt(buffer, cursor + 28, 2);
    const extraLength = readUInt(buffer, cursor + 30, 2);
    const commentLength = readUInt(buffer, cursor + 32, 2);
    const localOffset = readUInt(buffer, cursor + 42, 4);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const localNameLength = readUInt(buffer, localOffset + 26, 2);
    const localExtraLength = readUInt(buffer, localOffset + 28, 2);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(start, start + compressedSize);
    let content;
    if (compression === 0) content = compressed;
    else if (compression === 8) content = inflateRawSync(compressed);
    else throw new Error(`DOCX 使用不支持的压缩方式：${compression}`);
    if (content.length !== uncompressedSize) throw new Error(`DOCX 条目长度校验失败：${name}`);
    entries.set(name, content);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function textFromXml(xml) {
  return [...String(xml || '').matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(match => xmlDecode(match[1])).join('');
}

function blockHash(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function parsePlaceholders(text) {
  return [...String(text || '').matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(match => ({ token: match[0], key: match[1].trim() }));
}

function parseXmlPart(name, xml, blocks) {
  const paragraphs = [...String(xml).matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)];
  paragraphs.forEach((match, index) => {
    const text = textFromXml(match[0]);
    if (!text.trim()) return;
    blocks.push({ id: `blk-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-p-${index + 1}`, part: name, type: 'paragraph', text, placeholders: parsePlaceholders(text), contentHash: blockHash(text), anchorText: text.slice(0, 120) });
  });
  const tables = [...String(xml).matchAll(/<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>/g)];
  tables.forEach((match, tableIndex) => {
    const rows = [...match[0].matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g)].map(row => [...row[0].matchAll(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g)].map(cell => textFromXml(cell[0])));
    blocks.push({ id: `blk-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-tbl-${tableIndex + 1}`, part: name, type: 'table', rows, text: rows.map(row => row.join(' | ')).join('\n'), placeholders: parsePlaceholders(rows.flat().join(' ')), contentHash: blockHash(JSON.stringify(rows)), anchorText: rows.flat().join(' | ').slice(0, 160) });
  });
}

export function parseDocxTemplate(buffer, { filename = 'template.docx' } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 100) throw new Error('DOCX 文件为空或过小');
  const entries = readZipEntries(buffer);
  const xmlParts = [...entries.keys()].filter(name => /^word\/(?:document|header\d+|footer\d+)\.xml$/.test(name));
  if (!xmlParts.includes('word/document.xml')) throw new Error('DOCX 缺少 word/document.xml');
  const blocks = [];
  for (const part of xmlParts) parseXmlPart(part, entries.get(part).toString('utf8'), blocks);
  const allText = blocks.map(block => block.text).join('\n');
  const warnings = [];
  if (entries.has('word/document.xml') && /<w:(?:txbxContent|drawing|object)\b/.test(entries.get('word/document.xml').toString('utf8'))) warnings.push('模板包含文本框、绘图或嵌入对象，首期只保证标准段落和表格回填');
  return {
    schema: 'wynai.docx-template/v1',
    template: { filename, sha256: `sha256:${createHash('sha256').update(buffer).digest('hex')}`, byteLength: buffer.length },
    parts: xmlParts,
    blocks,
    placeholders: [...new Map(blocks.flatMap(block => block.placeholders.map(item => [item.key, { key: item.key, blocks: [block.id] }]))).values()].map(item => ({ ...item, blocks: [...new Set(item.blocks)] })),
    compatibility: { level: warnings.length ? 'standard-with-warnings' : 'standard', warnings },
  };
}

export { readZipEntries, textFromXml };
