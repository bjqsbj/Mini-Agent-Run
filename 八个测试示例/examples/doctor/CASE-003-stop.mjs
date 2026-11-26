// CASE-003 · 点击停止后仍有新输出
// 文档所引来源：anthropics/claude-code#26802。以下为本地合成复现，使用虚拟时间。
// 用户反馈：我发现 Agent 执行任务时，点击停止按钮虽然会显示已停止，但过几秒之后它又开始输出新的内容，有时候还会继续调用工具和消耗 Token。请检查停止机制是否真正终止了后端任务。
function stopRun(run) {
  run.modelAborted = true
  run.status = 'STOPPED'
}
function receiveCompletion(run, call) {
  call.state = 'completed'
  run.trace.push('tool.completed ' + call.id + ' after ' + run.status)
  if (run.tools.every((t) => t.state === 'completed')) {
    run.trace.push('agent.next_step.scheduled', 'llm.request.started step=4')
    run.modelRequests++
  }
}

export function observe() {
  const run = {
    status: 'RUNNING',
    modelAborted: false,
    modelRequests: 3,
    tools: ['search_logs', 'get_metrics'].map((name, index) => ({
      id: 'call_00' + (index + 1),
      name,
      state: 'running',
      aborted: false,
    })),
    trace: [
      'run.started',
      'tool.started call_001 search_logs',
      'tool.started call_002 get_metrics',
    ],
  }
  run.trace.push('stop.requested')
  stopRun(run)
  run.trace.push('llm.stream.aborted; run.status=STOPPED')
  for (const call of run.tools) receiveCompletion(run, call)
  return {
    status: {
      phase: 'CANCELLATION',
      status: run.status,
      modelAborted: run.modelAborted,
    },
    tools: run.tools,
    models: {
      requests: run.modelRequests,
      requestsAfterStop: run.modelRequests - 3,
    },
    config: { toolAbortPropagation: false, terminalStateGuard: false },
    trace: run.trace,
    logs: run.trace.map(
      (e, i) =>
        '16:00:' +
        String(i + 1).padStart(2, '0') +
        ' ' +
        (i >= 7 ? 'WARN ' : 'INFO ') +
        e,
    ),
  }
}

// node CASE-003-stop.mjs [JSON参数]
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
