// CASE-002 · 反复读取同一文件
// 文档所引来源：langchain-ai/langchain#26019。以下为本地合成复现，使用虚拟时间。
// 用户反馈：Agent 在执行代码分析任务时，一直重复调用 read_file 工具读取同一个文件，已经连续调用很多次了，但始终没有给出分析结果。请帮我定位是否存在 Agent Loop 设计问题，并给出修复建议。
function nextStep(observation, step, maxSteps) {
  if (maxSteps !== null && step >= maxSteps) return 'stop'
  return { tool: 'read_file', path: 'src/app.ts' }
}

export function observe({
  sampleSteps = 26,
  maxSteps = null,
  polling = false,
} = {}) {
  const tools = [],
    hashes = new Set()
  let last = null
  // A virtual observer stops sampling after 26 rounds; the agent has its own limit.
  for (let step = 0; step < Math.min(100, sampleSteps); step++) {
    const call = nextStep(last, step, maxSteps)
    if (call === 'stop') break
    last = { ...call, hash: polling ? 'rev-' + step : 'abc123' }
    hashes.add(last.hash)
    tools.push({ step: step + 1, ...last })
  }
  const repeating = tools.length > 1 && hashes.size === 1
  return {
    status: {
      phase: 'AGENT_LOOP',
      currentStep: tools.length,
      uniqueToolResults: hashes.size,
    },
    tools,
    models: { requests: tools.length, latestAction: 'tool_call' },
    config: { maxSteps, loopDetectionEnabled: false },
    trace: [
      'dispatch first read_file',
      'append observation hash=' + tools[0]?.hash,
      'nextStep schedules same path',
      'sample ended at step ' + tools.length,
    ],
    logs: [
      '15:00:01 INFO read_file path=src/app.ts',
      '15:00:02 INFO result_hash=' + tools[0]?.hash,
      '15:01:00 INFO consecutive_identical_calls=' +
        (repeating ? tools.length : 1),
    ],
  }
}

// node CASE-002-loop.mjs [JSON参数]
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
