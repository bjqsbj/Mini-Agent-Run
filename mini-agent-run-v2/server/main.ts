import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, extname } from 'node:path'
import { Store, type Item } from './store.ts'
import { Runner } from './runner.ts'
import { scenarios } from './scenarios.ts'
import { cases, example } from './codebase.ts'
import { services } from './tools.ts'
import { samples } from './doctor/tools.ts'
import { importIssue } from './doctor/issue.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const store = new Store(process.env.RUN_DATA_DIR || join(root, 'data'))
const runner = new Runner(store)
const port = Number(process.env.PORT ?? 4318)
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw Error('PORT 无效')
const json = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(data))
}
async function body(req: IncomingMessage) {
  let size = 0
  const parts: Buffer[] = []
  for await (const part of req) {
    size += part.length
    if (size > 600000) throw Error('请求过大')
    parts.push(part)
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')
}
function stream(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  cursor: number,
) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write('retry: 1200\n\n')
  function write(e: Item) {
    if (res.writableEnded || res.destroyed) return
    res.write('id: ' + e.id + '\ndata: ' + JSON.stringify(e) + '\n\n')
    if (e.type === 'end') res.end()
    else if (res.writableLength > 1024 * 1024) res.destroy()
  }
  // No awaits between replay and subscribe: both observe a single event-loop turn.
  for (const e of store.after(id, cursor)) write(e)
  if (store.get(id)?.status !== 'running') {
    res.end()
    return
  }
  runner.bus.on(id, write)
  const beat = setInterval(() => res.write(': heartbeat\n\n'), 12000)
  res.on('close', () => {
    clearInterval(beat)
    runner.bus.off(id, write)
  })
}
const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host ?? ''
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host))
      return json(res, 403, { error: '仅接受本机请求' })
    const url = new URL(req.url ?? '/', 'http://' + host)
    const path = url.pathname
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    )
    if (req.method === 'POST') {
      if (
        (req.headers.origin && req.headers.origin !== 'http://' + host) ||
        req.headers['sec-fetch-site'] === 'cross-site'
      )
        return json(res, 403, { error: '请求来源不匹配' })
      if (!req.headers['content-type']?.startsWith('application/json'))
        return json(res, 415, { error: '需要 JSON 请求体' })
    }
    if (req.method === 'GET' && path === '/api/config')
      return json(res, 200, {
        scenarios,
        doctorSamples: samples,
        cases: cases.map(({ demoEdits, ...c }) => c),
        liveReady: Boolean(process.env.DEEPSEEK_API_KEY),
        model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
      })
    if (req.method === 'POST' && path === '/api/doctor/issue')
      return json(res, 200, await importIssue((await body(req)).url))
    if (req.method === 'POST' && path === '/api/doctor') {
      const b = await body(req)
      if (
        typeof b.question !== 'string' ||
        !b.question.trim() ||
        b.question.length > 12000 ||
        !['demo', 'live'].includes(b.mode) ||
        !b.input
      )
        return json(res, 400, {
          error: '请选择现场并填写 1–12000 字的反馈或 Issue 正文',
        })
      return json(
        res,
        201,
        runner.start(
          b.question.trim(),
          'agent',
          b.mode,
          null,
          undefined,
          b.input,
        ),
      )
    }
    if (path === '/api/runs') {
      if (req.method === 'GET') return json(res, 200, store.list())
      if (req.method === 'POST') {
        const b = await body(req)
        if (
          !Object.hasOwn(scenarios, b.scenario) ||
          !['demo', 'live'].includes(b.mode) ||
          typeof b.question !== 'string' ||
          !b.question.trim() ||
          b.question.length > 2000
        )
          return json(res, 400, {
            error: '请选择现场与引擎，输入 1–2000 字的问题',
          })
        const scene = b.scenario as keyof typeof scenarios
        if (
          b.mode === 'demo' &&
          !b.repair &&
          b.question.trim() !== scenarios[scene].question
        )
          return json(res, 400, {
            error: '自由提问请选择 DeepSeek 引擎；离线演示使用场景示例',
          })
        if (
          b.repair &&
          !b.repair.files &&
          !b.repair.project &&
          example(b.repair.caseId).scene !== scene
        )
          return json(res, 400, { error: '模拟现场与案例不匹配' })
        return json(
          res,
          201,
          runner.start(b.question.trim(), scene, b.mode, null, b.repair),
        )
      }
    }
    const m =
      /^\/api\/runs\/([a-f0-9-]{36})(?:\/(events|logs|stop|retry|code|revision|rollback))?$/.exec(
        path,
      )
    if (m) {
      const [, id, action] = m,
        run = store.get(id)
      if (!run) return json(res, 404, { error: '未找到任务' })
      if (req.method === 'GET' && !action) return json(res, 200, run)
      if (req.method === 'GET' && action === 'code')
        return json(res, 200, runner.code.details(id))
      if (req.method === 'GET' && action === 'revision') {
        const c = runner.code.context(id)
        if (!c) return json(res, 404, { error: '无源码版本' })
        return json(
          res,
          200,
          runner.code.files(c.project, url.searchParams.get('id') ?? c.base),
        )
      }
      if (req.method === 'POST' && action === 'rollback') {
        if (run.status === 'running')
          return json(res, 409, { error: '请等待任务结束或先停止' })
        const b = await body(req)
        runner.code.rollback(id, b.target, b.head)
        return json(res, 200, runner.code.details(id))
      }
      if (req.method === 'POST' && action === 'stop') {
        if (!runner.stop(id)) return json(res, 409, { error: '任务已结束' })
        return json(res, 200, store.get(id))
      }
      if (req.method === 'POST' && action === 'retry') {
        if (run.status === 'running')
          return json(res, 409, { error: '任务仍在执行' })
        const ctx = runner.code.context(id)
        const doctor = runner.doctor.read(id)
        if (doctor)
          return json(
            res,
            201,
            runner.start(
              run.question,
              run.scenario,
              run.mode,
              run.id,
              undefined,
              doctor,
            ),
          )
        return json(
          res,
          201,
          runner.start(
            run.question,
            run.scenario,
            run.mode,
            run.id,
            ctx
              ? { caseId: ctx.caseId, project: ctx.project, checks: ctx.checks }
              : undefined,
          ),
        )
      }
      if (req.method === 'GET' && action === 'events') {
        const cursor = Number(
          req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0,
        )
        if (!Number.isSafeInteger(cursor) || cursor < 0)
          return json(res, 400, { error: '事件游标无效' })
        return stream(req, res, id, cursor)
      }
      if (req.method === 'GET' && action === 'logs') {
        const service = url.searchParams.get('service') ?? '',
          level = url.searchParams.get('level') ?? '',
          q = url.searchParams.get('q') ?? ''
        const page = Number(url.searchParams.get('page') ?? 1)
        if (
          ['doctor-archive', 'doctor-logs'].includes(service) &&
          ['', 'INFO', 'WARN', 'ERROR', 'DEBUG'].includes(level) &&
          q.length <= 120 &&
          Number.isSafeInteger(page) &&
          page >= 1
        )
          return json(
            res,
            200,
            runner.doctor.page(id, service.slice(7), level, q, page),
          )
        if (
          !services.some((s) => s === service) ||
          !['', 'INFO', 'WARN', 'ERROR'].includes(level) ||
          q.length > 120 ||
          !Number.isSafeInteger(page) ||
          page < 1
        )
          return json(res, 400, { error: '日志筛选参数无效' })
        return json(res, 200, store.logs(id, service, level, q, page, 50))
      }
    }
    if (
      req.method === 'GET' &&
      (path === '/' || /^\/assets\/[\w.-]+$/.test(path))
    ) {
      const file = join(
        root,
        'dist',
        path === '/' ? 'index.html' : path.slice(1),
      )
      if (!existsSync(file))
        return json(res, 404, {
          error: '缺少网页构建产物，请运行 npm ci 和 npm run build',
        })
      const mime: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
      }
      res.writeHead(200, {
        'Content-Type': mime[extname(file)] || 'application/octet-stream',
      })
      return res.end(readFileSync(file))
    }
    json(res, 404, { error: '路径不存在' })
  } catch (err) {
    if (!res.headersSent)
      json(res, 400, { error: err instanceof Error ? err.message : '请求无效' })
    else res.destroy()
  }
})
server.on('error', (err) => {
  console.error('启动失败：' + err.message)
  process.exit(1)
})
server.listen(port, '127.0.0.1', () => {
  store.recover()
  const address = server.address()
  console.log(
    'Mini Agent Run · http://127.0.0.1:' +
      (typeof address === 'object' ? address?.port : port),
  )
})
