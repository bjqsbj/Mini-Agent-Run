import type { Source } from '../codebase.ts'
import { evaluate } from '../evaluate.ts'
import { readFileSync } from 'node:fs'

export interface Sample {
  id: string
  title: string
  question: string
  file: string
  source: string
}
export const samples: Sample[] = JSON.parse(
  readFileSync(
    new URL('../../examples/doctor/catalog.json', import.meta.url),
    'utf8',
  ),
)
export function sampleFiles(id: string): Source[] {
  const sample = samples.find((s) => s.id === id)
  if (!sample) throw Error('示例不存在')
  return [
    {
      path: sample.file,
      content: readFileSync(
        new URL('../../examples/doctor/' + sample.file, import.meta.url),
        'utf8',
      ),
    },
  ]
}
export type Snapshot = Record<string, any>
export async function capture(
  files: Source[],
  entry: string | undefined,
  signal: AbortSignal,
): Promise<Snapshot> {
  const path =
    entry ||
    files.find((f) => /export\s+(?:function|const)\s+observe\b/.test(f.content))
      ?.path
  if (!path) return { missing: '上传源码未提供 observe()，仅有静态源码证据。' }
  if (!files.some((f) => f.path === path)) throw Error('观测入口不在上传文件中')
  const [row] = await evaluate(
    files,
    [{ name: '隔离采集', file: path, fn: 'observe', args: [], expected: null }],
    signal,
  )
  signal.throwIfAborted()
  if (row.error) return { missing: '隔离观测未成功：' + row.error }
  if (
    !row.actual ||
    typeof row.actual !== 'object' ||
    Array.isArray(row.actual)
  )
    return { missing: 'observe() 应返回现场数据对象' }
  const input = row.actual as Snapshot
  // Only telemetry channels may cross the observation boundary.
  return Object.fromEntries(
    [
      'status',
      'config',
      'trace',
      'logs',
      'tools',
      'models',
      'storage',
      'session',
      'metrics',
      'mcp',
      'archive',
    ]
      .filter((k) => Object.hasOwn(input, k))
      .map((k) => [k, input[k]]),
  )
}
const fields: Record<string, string> = {
  get_run_status: 'status',
  get_execution_trace: 'trace',
  get_agent_config: 'config',
  get_tool_calls: 'tools',
  get_model_requests: 'models',
  get_resource_metrics: 'metrics',
  get_session_status: 'session',
  get_storage_status: 'storage',
  get_mcp_status: 'mcp',
}
const descriptions: Record<string, string> = {
  get_run_status: '获取模拟 Agent 当前状态及可用观测通道',
  get_execution_trace: '按原始序号读取执行步骤，返回 step 和 event',
  get_agent_config: '读取上传模拟 Agent 的配置',
  get_tool_calls: '获取工具名称、参数、结果及状态',
  get_model_requests: '读取模型请求、首 token、重试和参数分片',
  get_resource_metrics: '读取输出规模、内存、渲染及上下文观测值',
  get_session_status: '检查会话注册表或历史分页消费状态',
  get_storage_status: '检查持久化事件和最终报告是否存在',
  get_mcp_status: '检查 MCP 连接状态和服务端工具列表',
  search_logs: '检索诊断日志或原始归档，返回行号和少量样本；关键词可省略',
  inspect_code_snippet:
    '读取一个上传源码文件中指定行附近的原始代码；文件名来自清单',
}
export const doctorTools = Object.entries(descriptions).map(
  ([name, description]) => ({
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties:
          name === 'search_logs'
            ? {
                keyword: { type: 'string' },
                source: { type: 'string', enum: ['logs', 'archive'] },
              }
            : name === 'inspect_code_snippet'
              ? {
                  file: { type: 'string' },
                  line: { type: 'integer', minimum: 1 },
                  find: { type: 'string' },
                }
              : {},
        additionalProperties: false,
      },
    },
  }),
)
interface Group {
  count: number
  level: string
  text: string
}
export function logPage(
  snapshot: Snapshot,
  source: string,
  level: string,
  q: string,
  page: number,
  limit = 50,
) {
  const groups: Group[] =
    source === 'archive'
      ? Array.isArray(snapshot.archive)
        ? snapshot.archive
        : []
      : (Array.isArray(snapshot.logs) ? snapshot.logs : []).map(
          (v: unknown) => {
            const message = typeof v === 'string' ? v : JSON.stringify(v)
            return {
              count: 1,
              level:
                message.match(/\b(ERROR|WARN|DEBUG|INFO)\b/)?.[1] ?? 'INFO',
              text: message,
            }
          },
        )
  let n = 0,
    total = 0
  const matches: { group: Group; start: number; offset: number }[] = []
  for (const g of groups) {
    if (
      !g ||
      !Number.isSafeInteger(g.count) ||
      g.count < 0 ||
      g.count > 1000000 ||
      typeof g.text !== 'string' ||
      typeof g.level !== 'string'
    )
      continue
    if (
      (!level || level === g.level) &&
      g.text.toLowerCase().includes(q.toLowerCase())
    ) {
      matches.push({ group: g, start: n + 1, offset: total })
      total += g.count
    }
    n += g.count
  }
  const pages = Math.max(1, Math.ceil(total / limit)),
    current = Math.min(page, pages),
    skip = (current - 1) * limit
  const rows = []
  for (const { group, start, offset } of matches) {
    for (
      let i = Math.max(0, skip - offset);
      i < Math.min(group.count, skip + limit - offset);
      i++
    )
      rows.push({
        n: start + i,
        time: '',
        level: group.level,
        message: group.text,
      })
  }
  return { page: current, pages, total, rows }
}
export function inspect(
  snapshot: Snapshot,
  files: Source[],
  tool: string,
  args: Record<string, unknown>,
) {
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw Error('需要参数对象')
  const schema = doctorTools.find((t) => t.function.name === tool)
  if (
    !schema ||
    Object.keys(args).some(
      (k) => !Object.hasOwn(schema.function.parameters.properties, k),
    )
  )
    throw Error('未知工具或参数')
  if (tool === 'inspect_code_snippet') {
    const f =
      args.file === undefined
        ? files[0]
        : files.find((f) => f.path === args.file)
    if (!f) throw Error('文件不存在')
    const lines = f.content.split(/\r?\n/),
      needle = args.find
    if (
      needle !== undefined &&
      (typeof needle !== 'string' || !needle.trim() || needle.length > 120)
    )
      throw Error('find 需为 1–120 字符的源码片段')
    const match =
      typeof needle === 'string'
        ? lines.findIndex((s) =>
            s.replace(/\s/g, '').includes(needle.replace(/\s/g, '')),
          )
        : -1
    if (needle !== undefined && match < 0)
      return {
        file: f.path,
        totalLines: lines.length,
        lines: [],
        notFound: needle,
      }
    const line = args.line ?? (match < 0 ? 1 : Math.max(1, match - 4))
    if (
      typeof line !== 'number' ||
      !Number.isSafeInteger(line) ||
      line < 1 ||
      line > lines.length
    )
      throw Error('行号越界')
    return {
      file: f.path,
      totalLines: lines.length,
      lines: lines
        .slice(line - 1, line + 18)
        .map((s, i) => ({ n: line + i, text: s.slice(0, 320) })),
    }
  }
  if (tool === 'search_logs') {
    const source = args.source ?? 'logs',
      keyword = args.keyword ?? ''
    if (
      !['logs', 'archive'].includes(String(source)) ||
      typeof keyword !== 'string' ||
      keyword.length > 120
    )
      throw Error('日志查询参数无效')
    const result = logPage(snapshot, String(source), '', keyword, 1, 8)
    return {
      source,
      total: result.total,
      rows: result.rows.map((r) => ({
        ...r,
        message: r.message.trimEnd().slice(0, 400),
      })),
    }
  }
  const field = fields[tool]
  const data = snapshot[field] ?? {
    unavailable: snapshot.missing || '上传现场未提供该观测',
  }
  if (tool === 'get_run_status')
    return {
      status: data,
      channels: Object.keys(snapshot).filter((k) => k !== 'missing'),
    }
  if (tool === 'get_execution_trace' && Array.isArray(data))
    return data.slice(0, 80).map((event, i) => ({ step: i + 1, event }))
  return data
}
