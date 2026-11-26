export const scenarios = {
  agent: {
    title: '并行工具结果错配',
    kind: 'Agent 工具调度',
    service: 'agent',
    question: '两个工具逆序完成时，结果关联到错误的调用 ID。请定位关联逻辑。',
  },
  boot: {
    title: '启动卡在加载页',
    kind: '多步排查',
    service: 'gateway',
    question:
      '客户端一直停在加载页，请检查网关状态、错误日志和连接配置，给出证据及修复后的验证方法。',
  },
  sync: {
    title: '同步长时间无响应',
    kind: '慢速探测',
    service: 'sync',
    question:
      '同步进度停在 87%，请先探测同步服务状态。如果探测超时，请沿日志和配置继续调查。',
  },
  export: {
    title: '批量导出失败',
    kind: '海量日志',
    service: 'exporter',
    question:
      '批量导出在最后一步失败。请检索导出服务的完整日志，定位关键错误及其前后记录，并核对配置。',
  },
} as const
export type Scenario = keyof typeof scenarios
export type Service = (typeof scenarios)[Scenario]['service']
export type Mode = 'live' | 'demo'
export type Level = 'INFO' | 'WARN' | 'ERROR'

const config = {
  agent: {
    parallelCalls: 2,
    completionOrder: ['call_B', 'call_A'],
    firstAssignedId: 'call_A',
  },
  gateway: { databasePort: 5433, registeredDatabasePort: 5432, retries: 3 },
  sync: { requestTimeoutMs: 2000, retryLimit: 4, lastUpstreamLatencyMs: 7800 },
  exporter: { target: '/cache/exports', freeMiB: 8, requiredMiB: 64 },
}
export function readConfig(service: Service) {
  return config[service]
}

export function makeLogs(service: Service) {
  const size = service === 'exporter' ? 5000 : 64
  const markers: Record<number, [Level, string]> =
    service === 'agent'
      ? {
          26: ['INFO', 'turn=8 dispatch call_A read_state; call_B list_jobs'],
          27: [
            'ERROR',
            'turn=8 CALL_ID_MISMATCH first completion=call_B attached=call_A',
          ],
          28: ['WARN', 'turn=8 tool message rejected: mismatched tool_call_id'],
        }
      : service === 'exporter'
        ? {
            140: ['WARN', 'queue watermark reached'],
            3883: ['WARN', 'job=EX-204 final archive requires 64 MiB'],
            3884: [
              'ERROR',
              'job=EX-204 ENOSPC write archive.tmp; available=8MiB',
            ],
            3885: ['INFO', 'job=EX-204 rollback complete'],
            4800: ['INFO', 'renderer input sample: <em>literal text</em>'],
          }
        : service === 'gateway'
          ? {
              48: ['WARN', 'health probe pending; client waits for /ready'],
              49: ['ERROR', 'DB_CONNECT ECONNREFUSED db.local:5433'],
              50: ['INFO', 'service registry: db.local:5432 active'],
            }
          : {
              32: ['WARN', 'job=SY-087 upstream latency=7800ms'],
              33: [
                'ERROR',
                'job=SY-087 DEADLINE_EXCEEDED deadline=2000ms retry=4/4',
              ],
              34: ['INFO', 'checkpoint saved at 87%'],
            }
  return Array.from({ length: size }, (_, i) => {
    const n = i + 1
    const [level, message] = markers[n] ?? [
      'INFO',
      service + ' heartbeat ok; seq=' + n,
    ]
    return {
      n,
      time: new Date(Date.UTC(2026, 9, 12, 9) + n * 1000).toISOString(),
      level,
      message,
    }
  })
}
