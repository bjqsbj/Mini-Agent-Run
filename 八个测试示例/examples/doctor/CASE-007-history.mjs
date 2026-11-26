// CASE-007 · 重启后历史记录不完整
// 文档所引来源：openai/codex#42311。以下为本地合成复现，使用虚拟时间。
// 用户反馈：昨天让 Agent 完成了一次比较长的故障排查，当时能够看到完整的执行过程和最终报告。但是今天重新打开软件后，历史任务只显示了部分内容，工具调用记录和最后的诊断报告都不见了。请检查是不是数据持久化或历史加载逻辑存在问题。
function fetchEvents(database, offset, limit) {
  return {
    items: database.slice(offset, offset + limit),
    hasMore: offset + limit < database.length,
  }
}
function restoreHistory(database) {
  const first = fetchEvents(database, 0, 20)
  return { rendered: first.items, hasMore: first.hasMore, requests: 1 }
}
export function observe({ count = 86 } = {}) {
  const db = Array.from(
    { length: Math.max(1, Math.min(1000, count)) },
    (_, i) => ({ id: i + 1, type: i === count - 1 ? 'report' : 'event' }),
  )
  const view = restoreHistory(db)
  return {
    status: { phase: 'HISTORY_RESTORE', status: 'COMPLETED' },
    storage: {
      databaseEventCount: db.length,
      finalReportExists: db.some((e) => e.type === 'report'),
    },
    session: {
      apiReturnedEventCount: view.rendered.length,
      frontendRenderedEventCount: view.rendered.length,
      hasMore: view.hasMore,
      pageRequests: view.requests,
      reportVisible: view.rendered.some((e) => e.type === 'report'),
    },
    config: { limit: 20, offset: 0, frontendFetchNextPage: false },
    trace: [
      'restart; database connected',
      'read persisted run',
      'GET events offset=0 limit=20',
      'restoreHistory renders first page',
      'history load finished',
    ],
    logs: [
      '09:00:03 INFO database.events.total=' + db.length,
      '09:00:03 INFO api.events.returned=' + view.rendered.length,
      '09:00:03 INFO pagination.has_more=' + view.hasMore,
      '09:00:04 INFO frontend.page_requests=' + view.requests,
    ],
  }
}

// node CASE-007-history.mjs [JSON参数]
if (
  typeof process !== 'undefined' &&
  process.argv[1] &&
  decodeURIComponent(new URL(import.meta.url).pathname).replace(
    /^\/(?=[A-Za-z]:)/,
    '',
  ) === process.argv[1].replaceAll('\\', '/')
) {
  console.log(
    JSON.stringify(observe(JSON.parse(process.argv[2] || '{}')), null, 2),
  )
}
