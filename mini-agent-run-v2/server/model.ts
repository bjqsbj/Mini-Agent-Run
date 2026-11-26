import { setTimeout as wait } from 'node:timers/promises'
import { schemas } from './tools.ts'
import type { Service } from './scenarios.ts'

export interface Call {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string
  tool_calls?: Call[]
}
export interface Turn {
  content: string
  calls: Call[]
}
type Delta = (text: string) => void

// Parse the event stream incrementally. A TCP chunk can end inside a UTF-8 character.
export async function decodeStream(
  body: ReadableStream<Uint8Array>,
  delta: Delta,
): Promise<Turn> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const calls = new Map<number, Call>()
  let content = '',
    buffer = '',
    finish = '',
    done = false
  function line(raw: string) {
    if (!raw.startsWith('data:')) return
    const value = raw.slice(5).trim()
    if (!value) return
    if (value === '[DONE]') {
      done = true
      return
    }
    const packet = JSON.parse(value)
    if (packet.error) throw Error('模型在流式传输期间返回错误')
    const choice = packet.choices?.[0]
    if (!choice) return
    if (choice.finish_reason) finish = choice.finish_reason
    const part = choice.delta ?? {}
    if (typeof part.content === 'string' && part.content) {
      content += part.content
      delta(part.content)
    }
    for (const x of part.tool_calls ?? []) {
      if (!Number.isInteger(x.index) || x.index < 0 || x.index >= 8)
        throw Error('单轮工具调用超出限制')
      const c = calls.get(x.index) ?? {
        id: '',
        type: 'function',
        function: { name: '', arguments: '' },
      }
      c.id += x.id ?? ''
      c.function.name += x.function?.name ?? ''
      c.function.arguments += x.function?.arguments ?? ''
      if (c.function.arguments.length > 16384) throw Error('工具参数过长')
      calls.set(x.index, c)
    }
  }
  try {
    while (!done) {
      const chunk = await reader.read()
      if (chunk.done) {
        buffer += decoder.decode()
        if (buffer) line(buffer)
        break
      }
      buffer += decoder.decode(chunk.value, { stream: true })
      let pos
      while ((pos = buffer.indexOf('\n')) !== -1) {
        line(buffer.slice(0, pos))
        buffer = buffer.slice(pos + 1)
      }
      if (buffer.length > 262144) throw Error('模型数据帧过大')
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  if (!['stop', 'tool_calls'].includes(finish))
    throw Error('模型输出中断或达到长度限制，请重新执行')
  const ordered = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, c]) => c)
  if (
    (finish === 'tool_calls') !== Boolean(ordered.length) ||
    ordered.some((c) => !c.id || !c.function.name)
  )
    throw Error('模型工具调用协议不完整')
  return { content, calls: ordered }
}

export async function liveTurn(
  messages: Message[],
  model: string,
  signal: AbortSignal,
  delta: Delta,
  structured = false,
  tools: readonly object[] = schemas,
): Promise<Turn> {
  const key = process.env.DEEPSEEK_API_KEY
  if (!key) throw Error('未配置 DEEPSEEK_API_KEY，请填写 .env 后重启服务')
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
    },
    signal,
    redirect: 'error',
    body: JSON.stringify({
      model,
      messages,
      ...(structured
        ? { response_format: { type: 'json_object' } }
        : { tools }),
      stream: true,
      thinking: { type: 'disabled' },
      max_tokens: structured ? 4096 : 1200,
    }),
  })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    const hint: Record<number, string> = {
      401: '检查服务端密钥',
      402: '检查测试账户余额',
      404: '检查模型名称',
      429: '请求过于频繁，请稍后重试',
    }
    throw Error(
      'DeepSeek HTTP ' +
        response.status +
        '，' +
        (hint[response.status] ?? '请检查模型配置或稍后重试'),
    )
  }
  return decodeStream(response.body, delta)
}

// Deterministic demonstration provider. Observations are produced by the same tools as live runs.
export async function demoTurn(
  messages: Message[],
  service: Service,
  signal: AbortSignal,
  delta: Delta,
): Promise<Turn> {
  const observations = messages
    .filter((m) => m.role === 'tool')
    .map((m) => JSON.parse(m.content!))
  const status = observations.find((o) => o.health || o.error)
  const logs = observations.find((o) => o.logSource)
  const config = observations.find(
    (o) =>
      'databasePort' in o ||
      'requestTimeoutMs' in o ||
      'freeMiB' in o ||
      'parallelCalls' in o,
  )
  let next = '',
    content = ''
  if (!status) {
    next = 'get_status'
    content = '先读取目标服务的健康探针。'
  } else if (!logs) {
    next = 'search_logs'
    content = status.error
      ? '探针超时，改用日志追踪最后一次操作。'
      : '探针报告异常，检索运行日志并保存现场。'
  } else if (!config) {
    next = 'get_config'
    content = '已找到异常记录，读取配置以交叉核对。'
  } else {
    const error = logs.errors[0]
    const cause =
      service === 'agent'
        ? '两个工具并行返回，首先完成的 call_B 被标成派发队列首位的 call_A。'
        : service === 'gateway'
          ? `网关使用端口 ${config.databasePort}，注册中心记录的数据库端口为 ${config.registeredDatabasePort}。`
          : service === 'sync'
            ? `上游最近耗时 ${config.lastUpstreamLatencyMs} ms，超过客户端期限 ${config.requestTimeoutMs} ms。`
            : `归档需要 ${config.requiredMiB} MiB，目标目录仅余 ${config.freeMiB} MiB。`
    const action =
      service === 'agent'
        ? '让完成事件携带自身调用 ID，分别回放逆序完成与顺序完成。'
        : service === 'gateway'
          ? '核对并更正连接端口，重启网关后验证 /ready 和客户端加载。'
          : service === 'sync'
            ? '先检查上游耗时，再评估超时设置；重试同一同步任务并核对检查点。'
            : '释放导出目录空间或更换目标目录，重跑 EX-204 并校验归档。'
    content = `可能根因\n${cause}\n\n日志证据\n${service} 第 ${error.n} 行 · ${error.message}\n\n验证建议\n${action}`
  }
  for (const part of content.match(/[\s\S]{1,9}/gu) ?? []) {
    await wait(65, undefined, { signal })
    delta(part)
  }
  return {
    content,
    calls: next
      ? [
          {
            id: 'demo-' + observations.length,
            type: 'function',
            function: { name: next, arguments: JSON.stringify({ service }) },
          },
        ]
      : [],
  }
}
