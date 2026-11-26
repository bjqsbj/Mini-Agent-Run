import { setTimeout as wait } from 'node:timers/promises'
import { readConfig, type Service } from './scenarios.ts'
import type { Store } from './store.ts'

export const services = ['gateway', 'sync', 'exporter', 'agent'] as const
const serviceProp = { type: 'string', enum: services }
function define(
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties: { service: serviceProp, ...properties },
        required: ['service'],
        additionalProperties: false,
      },
    },
  }
}
export const schemas = [
  define('get_status', '查询指定模拟服务的健康探针。同步探针较慢，可能超时。'),
  define(
    'search_logs',
    '检索并保存完整日志快照。返回匹配总数、少量样本及关键错误行。keyword 和 level 可省略。',
    {
      keyword: { type: 'string', maxLength: 120 },
      level: { type: 'string', enum: ['INFO', 'WARN', 'ERROR'] },
    },
  ),
  define('get_config', '读取模拟配置及最近一次观测值，用于交叉核对证据。'),
]
export async function execute(
  store: Store,
  run: string,
  name: string,
  raw: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  const args = JSON.parse(raw)
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    !services.includes(args.service)
  )
    throw Error('service 必须为 ' + services.join('、'))
  const schema = schemas.find((s) => s.function.name === name)
  if (!schema) throw Error('工具未注册')
  for (const key of Object.keys(args))
    if (!Object.hasOwn(schema.function.parameters.properties, key))
      throw Error('不支持参数 ' + key)
  const service = args.service as Service
  if (
    args.keyword !== undefined &&
    (typeof args.keyword !== 'string' || args.keyword.length > 120)
  )
    throw Error('keyword 最长 120 个字符')
  if (
    args.level !== undefined &&
    !['INFO', 'WARN', 'ERROR'].includes(args.level)
  )
    throw Error('日志级别无效')
  const slow = name === 'get_status' && service === 'sync'
  await wait(slow ? 4800 : 240, undefined, { signal })
  if (slow)
    throw Error(
      'PROBE_TIMEOUT：同步探针在 4.8 秒内未响应。可继续查询日志和配置。',
    )
  if (name === 'get_status')
    return {
      service,
      health: 'degraded',
      detail:
        service === 'agent'
          ? 'last turn rejected: tool result association'
          : service === 'gateway'
            ? 'readiness blocked: database'
            : 'last export failed: archive writer',
    }
  if (name === 'get_config') return { service, ...readConfig(service) }
  store.snapshot(run, service)
  const { total, rows: samples } = store.logs(
    run,
    service,
    args.level ?? '',
    args.keyword ?? '',
    1,
    4,
  )
  const errors =
    args.level && args.level !== 'ERROR'
      ? []
      : store.logs(run, service, 'ERROR', args.keyword ?? '', 1, 4).rows
  return {
    service,
    total,
    samples,
    errors,
    context: errors.length ? store.context(run, service, errors[0].n) : [],
    logSource: service,
    filter: { level: args.level ?? '', keyword: args.keyword ?? '' },
  }
}
