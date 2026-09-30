/**
 * 运行时过程数据的保留策略（单一事实来源）。
 *
 * 每个条目对应 `data/` 下的一个 JsonRunStore 目录：
 * - name        目录名
 * - maxItems    运行时内存与磁盘共同遵守的保留条数（与 server.mjs 保持一致）
 * - retentionDays  按时间滚动保留的天数；诊断类数据按此滚动清理
 * - disposition 运行期持久数据 (durable) / 审计留痕 (audit) / 可回收诊断数据 (diagnostic)
 *
 * diagnostic 类目录（事件流、诊断日志）只服务于近期排障，
 * 只保留最近 WYN_AI_RUNTIME_RETENTION_DAYS 天（默认 7 天），
 * 超出窗口的记录在启动与每次写入时滚动删除。
 */
export const DEFAULT_RETENTION_DAYS = 7;

export const RUNTIME_RETENTION = Object.freeze({
  'analysis-runs': { maxItems: 100, disposition: 'durable' },
  'data-insights': { maxItems: 30, disposition: 'durable' },
  'insight-runs': { maxItems: 200, disposition: 'durable' },
  'smart-query-conversations': { maxItems: 100, disposition: 'durable' },
  'report-templates': { maxItems: 100, disposition: 'durable' },
  'report-runs': { maxItems: 100, disposition: 'durable' },
  'skill-overrides': { maxItems: 500, disposition: 'durable' },
  'user-feedback': { maxItems: 5000, disposition: 'durable' },
  'learning-candidates': { maxItems: 5000, disposition: 'durable' },
  'request-audit': { maxItems: 2000, disposition: 'audit' },
  'skill-audit': { maxItems: 1000, disposition: 'audit' },
  'insight-audit': { maxItems: 5000, disposition: 'audit' },
  'operation-events': { maxItems: 10_000, retentionDays: DEFAULT_RETENTION_DAYS, disposition: 'diagnostic' },
  'insight-diagnostics': { maxItems: 5000, retentionDays: DEFAULT_RETENTION_DAYS, disposition: 'diagnostic' },
});

/** 默认只回收诊断类目录，避免误删业务数据。 */
export const DEFAULT_MAINTENANCE_DISPOSITIONS = Object.freeze(['diagnostic']);

export function resolveRetention(name) {
  return RUNTIME_RETENTION[name] || null;
}

/** 单条诊断记录体积偏大（洞察诊断常见 5~13MB），给出可读的体积提示。 */
export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 2)}${units[index]}`;
}
