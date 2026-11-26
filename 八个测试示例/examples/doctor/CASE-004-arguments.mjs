// CASE-004 · 流式工具参数缺失
// 文档所引来源：langchain-ai/langchainjs#8394、langchain-ai/langchain#35514。以下为本地合成复现，使用虚拟时间。
// 用户反馈：Agent 在搜索系统日志时频繁报错，提示工具缺少 service 和 keyword 参数。但从模型的输出看，它似乎已经生成了正确的参数。请排查工具调用参数是不是在流式传输或解析过程中出现了问题。
function dispatchFirst(delta) {
  let args
  try {
    args = JSON.parse(delta)
  } catch {
    args = {}
  }
  return {
    name: 'search_logs',
    args,
    missing: ['service', 'keyword'].filter((k) => !args[k]),
  }
}

export function observe({
  chunks = [
    '{"service":',
    '"backend",',
    '"keyword":',
    '"ERROR",',
    '"limit":100}',
  ],
} = {}) {
  const call = dispatchFirst(chunks[0])
  const joined = chunks.join('')
  return {
    status: {
      phase: 'TOOL_ARGUMENTS',
      status: call.missing.length ? 'FAILED' : 'COMPLETED',
    },
    tools: [call],
    models: {
      index: 0,
      id: 'call_search',
      fragments: chunks,
      joined,
      finishReason: 'tool_calls',
    },
    config: { dispatchOn: 'first_delta', parseFailureFallback: '{}' },
    trace: [
      'model.tool_call.delta index=0',
      'dispatchFirst before stream finish',
      'tool.started search_logs',
      'validate.required missing=' + call.missing.join(','),
      'remaining_arguments_received',
    ],
    logs: [
      '17:00:01 DEBUG first_fragment=' + chunks[0],
      ...(call.missing.length
        ? [
            '17:00:01 ERROR JSON_PARSE_ERROR',
            '17:00:01 WARN fallback_arguments={}',
            '17:00:01 ERROR Missing required argument: ' +
              call.missing.join(','),
          ]
        : []),
      '17:00:02 INFO received_fragments=' + chunks.length,
    ],
  }
}

// node CASE-004-arguments.mjs [JSON参数]
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
