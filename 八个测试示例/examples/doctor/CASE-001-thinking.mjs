// CASE-001 · 工具结束后一直 Thinking
// 文档所引来源：openai/codex#24850。以下为本地合成复现，使用虚拟时间。
// 用户反馈：我让 Agent 帮我分析项目代码，前面几个工具都已经执行完成了，但之后一直显示 Thinking，等待了好几分钟也没有任何输出。请帮我排查究竟是模型响应太慢、工具执行失败，还是 Agent 自身的运行状态出了问题。
function watchRequest(ageMs, firstToken, timeoutMs) {
  return timeoutMs !== null && ageMs >= timeoutMs
    ? 'FAILED'
    : firstToken
      ? 'STREAMING'
      : 'WAITING_MODEL'
}

export function observe({
  waitMs = 480000,
  firstToken = false,
  timeoutMs = null,
} = {}) {
  const phase = watchRequest(waitMs, firstToken, timeoutMs)
  const status = {
    phase,
    status: phase === 'FAILED' ? 'FAILED' : 'RUNNING',
    elapsedSeconds: waitMs / 1000 + 4,
    activeTools: 0,
    pendingModelRequests: phase === 'FAILED' ? 0 : 1,
  }
  const tools = [
    { id: 'call_001', tool: 'read_file', status: 'completed', durationMs: 800 },
  ]
  const models = [
    { step: 1, firstToken: true, status: 'tool_calls' },
    { step: 2, firstToken, ageMs: waitMs, stream: phase },
  ]
  const config = { firstTokenTimeoutMs: timeoutMs, idleTimeoutMs: null }
  const trace = [
    'run.started',
    'model.step1.tool_call read_file',
    'tool.completed call_001',
    'model.request.started step=2',
    'watchRequest phase=' + phase,
  ]
  const logs = [
    '14:20:04 INFO tool.completed duration_ms=800',
    '14:20:04 INFO model.request.started step=2',
    '14:20:34 WARN model.first_token_pending',
    '14:28:04 WARN model.stream phase=' + phase + ' age_ms=' + waitMs,
  ]
  return { status, tools, models, config, trace, logs }
}

// node CASE-001-thinking.mjs [JSON参数]
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
