// CASE-006 · 大日志卡顿与上下文溢出
// 文档所引来源：openai/codex#33822、#24048、#22091。以下为本地合成复现，使用虚拟时间。
// 用户反馈：使用 Agent 排查大型项目时，只要工具返回大量运行日志，整个页面就会出现严重卡顿，甚至无法点击停止按钮。继续执行后，内存和 Token 消耗也会明显增加。请帮我判断是不是日志渲染和上下文管理存在问题。
// Run-length representation of a raw UTF-8 archive. Each line is 184 ASCII bytes plus LF.
export function rawLine(n, total) {
  return (
    n === total
      ? 'ERROR archive checksum mismatch'
      : 'INFO scanner visited project record'
  ).padEnd(184, ' ')
}
function prepareOutput(lines, bytesPerLine) {
  return { renderedDomNodes: lines, modelContextBytes: lines * bytesPerLine }
}
export function observe({ lines = 100000 } = {}) {
  lines = Math.max(1, Math.min(100000, Math.trunc(lines)))
  const bytesPerLine = 185
  const metrics = {
    ...prepareOutput(lines, bytesPerLine),
    outputLines: lines,
    outputBytes: lines * bytesPerLine,
    // Recorded synthetic samples for the 100k profile, not measurements of the Doctor UI.
    longTaskMs: lines === 100000 ? 2800 : null,
    memoryMiB: lines === 100000 ? 3800 : null,
  }
  const archive = [
    { count: lines - 1, level: 'INFO', text: rawLine(1, Math.max(2, lines)) },
    { count: 1, level: 'ERROR', text: rawLine(lines, lines) },
  ]
  return {
    status: { phase: 'OUTPUT_RENDER', status: 'TOOL_COMPLETED' },
    metrics,
    archive,
    tools: [{ name: 'search_logs', status: 'completed', lines }],
    models: {
      contextBytes: metrics.modelContextBytes,
      error:
        metrics.modelContextBytes > 1000000 ? 'context_length_exceeded' : null,
    },
    config: {
      virtualScrollEnabled: false,
      paginationEnabled: false,
      rawOutputIncludedInModelContext: true,
      contextTruncationEnabled: false,
    },
    trace: [
      'search_logs completes',
      'prepareOutput sends all rows to renderer',
      'same raw payload appended to model context',
      'model budget checked',
    ],
    logs: [
      '19:20:02 INFO tool.completed lines=' + lines,
      '19:20:03 WARN renderer.dom_nodes=' + metrics.renderedDomNodes,
      '19:20:05 WARN long_task_ms=' + metrics.longTaskMs,
      '19:20:09 INFO context_bytes=' + metrics.modelContextBytes,
    ],
  }
}

// node CASE-006-large-log.mjs [JSON参数]
if (
  typeof process !== 'undefined' &&
  process.argv[1] &&
  decodeURIComponent(new URL(import.meta.url).pathname).replace(
    /^\/(?=[A-Za-z]:)/,
    '',
  ) === process.argv[1].replaceAll('\\', '/')
) {
  if (process.argv[2] === '--bench') {
    const results = [100, 1000, 10000, 100000].map((lines) => {
      const start = performance.now(),
        heap = process.memoryUsage().heapUsed
      const raw = Array.from({ length: lines }, (_, i) => rawLine(i + 1, lines))
      const generated = performance.now(),
        firstPage = raw.slice(0, 50)
      const pageReady = performance.now(),
        errorLine = raw.findIndex((line) => line.includes('checksum')) + 1
      return {
        lines,
        generateMs: generated - start,
        pageMs: pageReady - generated,
        searchMs: performance.now() - pageReady,
        heapDeltaBytes: process.memoryUsage().heapUsed - heap,
        visibleLines: firstPage.length,
        errorLine,
        rawBytes: lines * 185,
        sampleContextBytes: Buffer.byteLength(
          JSON.stringify({
            lines,
            errorLine,
            error: raw[errorLine - 1].trimEnd(),
          }),
        ),
      }
    })
    console.table(results)
  } else
    console.log(
      JSON.stringify(observe(JSON.parse(process.argv[2] || '{}')), null, 2),
    )
}
