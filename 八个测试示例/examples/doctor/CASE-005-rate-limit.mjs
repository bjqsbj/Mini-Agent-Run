// CASE-005 · 连续请求后频繁限流
// 文档所引来源：DeepSeek 官方 HTTP 429。以下为本地合成复现，使用虚拟时间。
// 用户反馈：Agent 平时使用没有问题，但连续执行几个排查任务之后就会频繁报错。有时重试一下能恢复，有时会连续失败。请检查模型 API 的请求记录，判断是否存在接口限流、并发过高或者重试策略不合理的问题。
function requestWithRetry(responses, maxRetries) {
  const attempts = []
  for (let i = 0; i <= maxRetries; i++) {
    const status = responses[Math.min(i, responses.length - 1)]
    attempts.push({ attempt: i + 1, status, elapsedMs: 0 })
    if (status === 200) break
  }
  return attempts
}
export function observe({
  responses = [429, 429, 429, 429],
  activeRequests = 8,
} = {}) {
  const attempts = requestWithRetry(responses, 3)
  return {
    status: {
      phase: 'MODEL_API',
      activeRequests,
      status: attempts.at(-1).status === 200 ? 'COMPLETED' : 'FAILED',
    },
    models: { earlier: [200, 200], attempts },
    config: {
      maxConcurrentRequests: null,
      maxRetries: 3,
      retryDelayMs: 0,
      exponentialBackoff: false,
    },
    trace: [
      'two previous calls returned 200',
      'model.request concurrent=' + activeRequests,
      'first response=' + attempts[0].status,
      'requestWithRetry delay_ms=0',
      'final status=' + attempts.at(-1).status,
    ],
    logs: attempts.map(
      (r) =>
        '18:30:02 ' +
        (r.status === 200 ? 'INFO' : 'WARN') +
        ' http=' +
        r.status +
        ' attempt=' +
        r.attempt +
        ' elapsed_ms=' +
        r.elapsedMs,
    ),
  }
}

// node CASE-005-rate-limit.mjs [JSON参数]
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
