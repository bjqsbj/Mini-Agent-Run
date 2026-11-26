// CASE-008 · MCP 重连后找不到工具
// 文档所引来源：anthropics/claude-code#38043。以下为本地合成复现，使用虚拟时间。
// 用户反馈：Agent 原本可以通过 MCP 工具查询项目文件，但一次网络断开后，即使 MCP 服务已经重新显示连接成功，Agent 仍然提示找不到相关工具。只有重新创建会话才能恢复，请帮我排查原因。
function onReconnect(session) {
  session.connection = 'CONNECTED'
}
export function observe() {
  const published = ['read_file', 'search_file', 'list_directory']
  const session = { connection: 'CONNECTED', registry: [...published] }
  const trace = [
    'mcp.connected',
    'register three tools',
    'network disconnect',
    'clear session registry',
  ]
  session.connection = 'DISCONNECTED'
  session.registry = []
  onReconnect(session)
  trace.push('mcp.reconnected', 'agent.tool_search read_file')
  const found = session.registry.includes('read_file')
  trace.push(found ? 'tool.started' : 'TOOL_NOT_FOUND')
  return {
    status: { phase: 'MCP_DISCOVERY', status: found ? 'RUNNING' : 'FAILED' },
    mcp: {
      server: 'project-files',
      connection: session.connection,
      available: published,
      lastDisconnectReason: 'NETWORK_TIMEOUT',
    },
    session: {
      registered: session.registry,
      nextModelTools: [...session.registry],
      lastToolsRefresh: 'before_disconnect',
    },
    config: { refreshOnReconnect: false },
    tools: [{ name: 'read_file', found }],
    trace,
    logs: [
      '10:05:00 WARN mcp.disconnected',
      '10:05:00 INFO tools.unregistered count=3',
      '10:05:08 INFO mcp.reconnected',
      '10:05:10 ERROR TOOL_NOT_FOUND',
      '10:05:11 WARN session.tool_registry.count=' + session.registry.length,
    ],
  }
}

// node CASE-008-mcp.mjs [JSON参数]
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
