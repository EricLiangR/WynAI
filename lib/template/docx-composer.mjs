import { deflateRawSync } from 'node:zlib';
import { basename, dirname } from 'node:path';
import { readZipEntries } from './docx-parser.mjs';

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function xmlEscape(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function replaceVisibleText(container, value) {
  let replaced = false;
  return String(container).replace(/<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (node, attributes = '') => {
    if (replaced) return `<w:t${attributes}></w:t>`;
    replaced = true;
    return `<w:t${attributes}>${xmlEscape(value)}</w:t>`;
  });
}

function blockCoordinates(blockId, replacement = {}) {
  const match = String(blockId || '').match(/^blk-(.+)-(p|tbl)-(\d+)$/);
  if (!match) throw Object.assign(new Error(`无效的 Block ID：${blockId}`), { status: 400 });
  const part = replacement.part || (match[1].replaceAll('-', '/').replace(/\/xml$/, '.xml'));
  return { part, type: replacement.type || (match[2] === 'p' ? 'paragraph' : 'table'), index: Number(match[3]) - 1 };
}

function replaceIndexedContainer(xml, expression, index, transform) {
  let cursor = -1;
  let found = false;
  const output = String(xml).replace(expression, container => {
    cursor += 1;
    if (cursor !== index) return container;
    found = true;
    return transform(container);
  });
  if (!found) throw Object.assign(new Error(`模板 Block 已失效：索引 ${index + 1}`), { status: 409 });
  return output;
}

function fillTableRow(rowXml, values) {
  const cells = [...String(rowXml).matchAll(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g)].map(match => match[0]);
  let expanded = String(rowXml);
  if (cells.length && values.length > cells.length) {
    const extra = Array.from({ length: values.length - cells.length }, () => cells.at(-1)).join('');
    expanded = expanded.replace(/<\/w:tr>$/, `${extra}</w:tr>`);
  }
  let cellIndex = -1;
  return expanded.replace(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g, cell => {
    cellIndex += 1;
    return replaceVisibleText(cell, values[cellIndex] ?? '');
  });
}

function drawingXml({ relationId, name, width = 5486400, height = 2743200, docPrId = 5000 }) {
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${width}" cy="${height}"/><wp:docPr id="${docPrId}" name="${xmlEscape(name)}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="${xmlEscape(name)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

function replaceParagraphWithDrawing(paragraph, options) {
  const properties = paragraph.match(/<w:pPr(?:\s[^>]*)?>[\s\S]*?<\/w:pPr>/)?.[0] || '';
  return paragraph.replace(/(<w:p(?:\s[^>]*)?>)[\s\S]*?(<\/w:p>)/, `$1${properties}${drawingXml(options)}$2`);
}

function ensureSvgContentType(entries) {
  const name = '[Content_Types].xml';
  const xml = entries.get(name)?.toString('utf8');
  if (!xml || /Extension="svg"/.test(xml)) return;
  entries.set(name, Buffer.from(xml.replace('</Types>', '<Default Extension="svg" ContentType="image/svg+xml"/></Types>'), 'utf8'));
}

function addSvgRelationship(entries, partName, mediaName) {
  const relationshipsName = `${dirname(partName)}/_rels/${basename(partName)}.rels`;
  let xml = entries.get(relationshipsName)?.toString('utf8') || '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  const ids = [...xml.matchAll(/Id="rId(\d+)"/g)].map(match => Number(match[1]));
  const relationId = `rId${Math.max(0, ...ids) + 1}`;
  const target = `${partName.startsWith('word/') ? '' : '../'}media/${mediaName}`;
  xml = xml.replace('</Relationships>', `<Relationship Id="${relationId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/></Relationships>`);
  entries.set(relationshipsName, Buffer.from(xml, 'utf8'));
  return relationId;
}

function replaceTableRows(tableXml, rows, { keepHeader = true } = {}) {
  const sourceRows = [...String(tableXml).matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g)].map(match => match[0]);
  if (!sourceRows.length) throw Object.assign(new Error('目标表格没有可复制的行'), { status: 409 });
  const templateRow = sourceRows[Math.min(keepHeader ? 1 : 0, sourceRows.length - 1)];
  const generated = (Array.isArray(rows) ? rows : []).map(row => fillTableRow(templateRow, Array.isArray(row) ? row : Object.values(row || {})));
  const replacementRows = keepHeader ? [sourceRows[0], ...generated] : generated;
  const firstStart = tableXml.indexOf(sourceRows[0]);
  const lastEnd = tableXml.lastIndexOf(sourceRows.at(-1)) + sourceRows.at(-1).length;
  return `${tableXml.slice(0, firstStart)}${replacementRows.join('')}${tableXml.slice(lastEnd)}`;
}

function applyBlockReplacements(entries, replacements = []) {
  for (const replacement of Array.isArray(replacements) ? replacements : []) {
    const location = blockCoordinates(replacement.blockId, replacement);
    const partName = entries.has(location.part) ? location.part : [...entries.keys()].find(name => `blk-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-`.startsWith(`blk-${String(replacement.blockId).slice(4).replace(/-(?:p|tbl)-\d+$/, '')}-`));
    if (!partName || !entries.has(partName)) throw Object.assign(new Error(`模板部件不存在：${location.part}`), { status: 409 });
    const xml = entries.get(partName).toString('utf8');
    if (location.type === 'paragraph') {
      if (replacement.svg) {
        ensureSvgContentType(entries);
        const mediaName = `wynai-chart-${replacement.blockId.replace(/[^a-z0-9]+/gi, '-').slice(-50)}.svg`;
        entries.set(`word/media/${mediaName}`, Buffer.from(String(replacement.svg), 'utf8'));
        const relationId = addSvgRelationship(entries, partName, mediaName);
        entries.set(partName, Buffer.from(replaceIndexedContainer(xml, /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, location.index, paragraph => replaceParagraphWithDrawing(paragraph, { relationId, name: replacement.name || 'WynAI Chart', width: replacement.width, height: replacement.height })), 'utf8'));
      } else entries.set(partName, Buffer.from(replaceIndexedContainer(xml, /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, location.index, paragraph => replaceVisibleText(paragraph, replacement.text ?? '')), 'utf8'));
    } else {
      entries.set(partName, Buffer.from(replaceIndexedContainer(xml, /<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>/g, location.index, table => replaceTableRows(table, replacement.rows || [], replacement)), 'utf8'));
    }
  }
}

export function replaceTextNodes(xml, values) {
  const containers = /<w:(?:p|tc)(?:\s[^>]*)?>[\s\S]*?<\/w:(?:p|tc)>/g;
  return String(xml).replace(containers, container => {
    const nodes = [...container.matchAll(/<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g)];
    if (!nodes.length) return container;
    const decoded = nodes.map(node => node[2].replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'")).join('');
    const matches = [...decoded.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)];
    if (!matches.length) return container;
    let next = container;
    const offsets = [];
    let cursor = 0;
    for (const node of nodes) {
      const start = node.index + node[0].indexOf('>') + 1;
      const end = start + node[2].length;
      offsets.push({ start, end });
      cursor = end;
    }
    for (const match of matches.reverse()) {
      const value = xmlEscape(values[match[1].trim()] ?? '');
      const startText = match.index;
      const endText = startText + match[0].length;
      const covered = [];
      let textCursor = 0;
      for (let index = 0; index < nodes.length; index += 1) {
        const length = nodes[index][2].length;
        const nodeStart = textCursor;
        const nodeEnd = textCursor + length;
        if (endText > nodeStart && startText < nodeEnd) covered.push({ index, nodeStart, nodeEnd });
        textCursor = nodeEnd;
      }
      if (!covered.length) continue;
      for (let index = covered.length - 1; index >= 0; index -= 1) {
        const item = covered[index];
        const node = nodes[item.index];
        const localStart = Math.max(0, startText - item.nodeStart);
        const localEnd = Math.min(node[2].length, endText - item.nodeStart);
        const replacement = item.index === covered[0].index ? value : '';
        const nextText = `${node[2].slice(0, localStart)}${replacement}${node[2].slice(localEnd)}`;
        next = next.replace(node[0], `<w:t${node[1] || ''}>${nextText}</w:t>`);
      }
    }
    return next;
  });
}

function writeZip(entries) {
  const files = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const filename = Buffer.from(name);
    const compressed = deflateRawSync(data);
    const local = Buffer.alloc(30 + filename.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10); local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26); local.writeUInt16LE(0, 28); filename.copy(local, 30);
    const central = Buffer.alloc(46 + filename.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(0, 12); central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42); filename.copy(central, 46);
    files.push({ local, central }); offset += local.length + compressed.length;
  }
  const locals = []; let localOffset = 0; let index = 0;
  for (const [name, data] of entries) { const local = files[index].local; const compressed = deflateRawSync(data); locals.push(local, compressed); localOffset += local.length + compressed.length; index += 1; }
  const central = Buffer.concat(files.map(file => file.central));
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, central, end]);
}

export function composeDocxTemplate(buffer, values = {}, options = {}) {
  const entries = readZipEntries(buffer);
  for (const name of [...entries.keys()].filter(item => /^word\/(?:document|header\d+|footer\d+)\.xml$/.test(item))) entries.set(name, Buffer.from(replaceTextNodes(entries.get(name).toString('utf8'), values), 'utf8'));
  applyBlockReplacements(entries, options.blockReplacements || []);
  return writeZip(entries);
}

export { replaceTableRows, replaceVisibleText };
