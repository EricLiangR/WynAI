import { randomUUID } from 'node:crypto';

function now() { return new Date().toISOString(); }

function evidenceSummary(evidence = []) {
  return evidence.slice(0, 8).map(item => `${item.label || item.id}：${item.displayValue ?? item.value ?? '见关联结果'}`).join('；');
}

export function createContentSession({ blockId, title = '数据洞察', evidence = [], prompt = '' } = {}) {
  const summary = evidenceSummary(evidence);
  const text = summary
    ? `${title}：${summary}。以上结论仅覆盖关联查询返回的范围，建议结合业务背景复核异常变化并明确责任人与跟进时点。`
    : `${title}：当前没有足够的已绑定数据证据，暂不生成定量结论。`;
  const at = now();
  return {
    schema: 'wynai.content-session/v1',
    id: `content-${randomUUID()}`,
    blockId,
    prompt: String(prompt || '').slice(0, 4000),
    messages: [{ role: 'assistant', content: text, at }],
    drafts: [{ version: 1, source: 'system-generated', text, evidenceIds: evidence.map(item => item.id), createdAt: at }],
    selectedVersion: 1,
    status: 'ai-generated',
    updatedAt: at,
  };
}

export function continueContentSession(session, { message = '', manualText = null, confirm = false } = {}, evidence = []) {
  const instruction = String(message || '').trim().slice(0, 4000);
  const latest = session.drafts.find(item => item.version === session.selectedVersion) || session.drafts.at(-1);
  let text;
  let source;
  if (manualText != null) {
    text = String(manualText).trim().slice(0, 20000);
    source = 'user-edited';
  } else {
    if (!instruction) throw Object.assign(new Error('讨论要求或手工内容不能为空'), { status: 400 });
    const summary = evidenceSummary(evidence);
    text = `${instruction}\n\n${latest?.text || ''}${summary ? `\n\n证据摘要：${summary}` : ''}`.trim();
    source = 'ai-generated';
  }
  const version = Math.max(0, ...session.drafts.map(item => item.version)) + 1;
  const at = now();
  session.messages.push({ role: manualText != null ? 'user' : 'user', content: instruction || '手工编辑', at }, { role: 'assistant', content: text, at });
  session.drafts.push({ version, source, text, evidenceIds: evidence.map(item => item.id), createdAt: at });
  session.selectedVersion = version;
  session.status = confirm ? 'user-confirmed' : source;
  session.updatedAt = at;
  return session;
}

export function selectedContent(session) {
  return session?.drafts?.find(item => item.version === session.selectedVersion)?.text || '';
}
