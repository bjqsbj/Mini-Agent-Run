import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { setTimeout as wait } from 'node:timers/promises'
import { scenarios } from '../server/scenarios.ts'

const folder = mkdtempSync(join(tmpdir(), 'mini-run-test-'))
let server, base
async function boot() {
  server = spawn(process.execPath, ['server/main.ts'], {
    cwd: new URL('../', import.meta.url),
    env: {
      ...process.env,
      PORT: '0',
      RUN_DATA_DIR: folder,
      DEEPSEEK_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  base = await new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => reject(Error('服务启动超时')), 10000)
    server.stdout.on('data', (chunk) => {
      output += chunk
      const m = output.match(/http:\/\/127\.0\.0\.1:\d+/)
      if (m) {
        clearTimeout(timeout)
        resolve(m[0])
      }
    })
    server.once('exit', (code) => {
      clearTimeout(timeout)
      reject(Error('服务提前退出 ' + code))
    })
  })
}
async function shutdown() {
  if (server && server.exitCode === null && server.signalCode === null) {
    const done = once(server, 'exit')
    server.kill()
    await done
  }
}
before(boot)
test('HTTP 上传、回滚、刷新与重启后导出相同原始文件', async () => {
  const cfg = await json('config'),
    c = cfg.cases.find((c) => c.id === 'parallel-tools')
  const run = await post('runs', {
    scenario: c.scene,
    mode: 'demo',
    question: c.question,
    repair: {
      caseId: c.id,
      files: c.files,
      checks: c.checks,
      name: '上传的工具模块',
    },
  })
  assert.equal((await finished(run.id)).status, 'completed')
  const path = 'runs/' + run.id,
    info = await json(path + '/code')
  assert.equal(info.versions.length, 2)
  const rollback = await post(path + '/rollback', {
    target: info.base,
    head: info.head,
  })
  assert.equal(rollback.versions.length, 3)
  await shutdown()
  await boot()
  assert.deepEqual(await json(path + '/revision?id=' + rollback.head), c.files)
  const retry = await post(path + '/retry')
  assert.equal((await finished(retry.id)).status, 'completed')
  assert.equal((await json('runs/' + retry.id + '/code')).base, rollback.head)
})
after(async () => {
  await shutdown()
  rmSync(folder, { recursive: true, force: true })
})
async function json(path, options) {
  const r = await fetch(base + '/api/' + path, options)
  const v = await r.json()
  assert.ok(r.ok, JSON.stringify(v))
  return v
}
const post = (path, data = {}) =>
  json(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
const create = (scene) =>
  post('runs', {
    scenario: scene,
    mode: 'demo',
    question: scenarios[scene].question,
  })
const get = (id) => json('runs/' + id)
async function finished(id) {
  for (let i = 0; i < 200; i++) {
    const r = await get(id)
    if (r.status !== 'running') return r
    await wait(80)
  }
  throw Error('任务超时')
}
async function replay(id, after = 0) {
  const r = await fetch(base + '/api/runs/' + id + '/events', {
    headers: { 'Last-Event-ID': String(after) },
    signal: AbortSignal.timeout(14000),
  })
  return (await r.text())
    .split('\n')
    .filter((x) => x.startsWith('data: '))
    .map((x) => JSON.parse(x.slice(6)))
}
test('启动故障有多轮证据，SSE 游标只补发未读事件', async () => {
  const r = await create('boot'),
    events = await replay(r.id)
  assert.equal(events.at(-1).data.status, 'completed')
  assert.match(events.at(-1).data.result, /5433/)
  assert.equal(events.filter((e) => e.type === 'call').length, 3)
  const cut = events[4].id
  assert.deepEqual(
    (await replay(r.id, cut)).map((e) => e.id),
    events.filter((e) => e.id > cut).map((e) => e.id),
  )
})
test('探针等待期间停止；旧任务无后续事件，新任务保留来源并处理工具超时', async () => {
  const r = await create('sync')
  // Wait for the actual tool call, rather than relying on timing guesses.
  const stream = await fetch(base + '/api/runs/' + r.id + '/events', {
    signal: AbortSignal.timeout(12000),
  })
  const reader = stream.body.getReader()
  let text = ''
  while (!text.includes('"type":"call"')) {
    const { value, done } = await reader.read()
    assert.ok(!done)
    text += new TextDecoder().decode(value)
  }
  await reader.cancel()
  await post('runs/' + r.id + '/stop')
  const old = await replay(r.id)
  assert.equal(old.at(-1).data.status, 'stopped')
  const again = await post('runs/' + r.id + '/retry')
  assert.equal(again.parent, r.id)
  assert.notEqual(again.id, r.id)
  const events = await replay(again.id)
  assert.ok(events.some((e) => e.type === 'observation' && e.data.ok === false))
  assert.equal(events.at(-1).data.status, 'completed')
  assert.deepEqual(await replay(r.id), old)
})
test('5000 行日志支持安全分页、级别筛选和错误上下文；重启可恢复', async () => {
  const r = await create('export')
  await finished(r.id)
  const observation = (await replay(r.id)).find(
    (e) => e.type === 'observation' && e.data.name === 'search_logs',
  )
  assert.deepEqual(
    observation.data.output.context.map((r) => r.n),
    [3883, 3884, 3885],
  )
  const url = 'runs/' + r.id + '/logs?service=exporter'
  assert.equal((await json(url)).total, 5000)
  const err = await json(url + '&level=ERROR&q=ENOSPC')
  assert.equal(err.total, 1)
  assert.equal(err.rows[0].n, 3884)
  const p = await json(url + '&page=78')
  assert.equal(p.rows.length, 50)
  assert.ok(p.rows.some((l) => l.n === 3885))
  assert.equal(
    (await json(url + '&q=' + encodeURIComponent('<em>literal text</em>')))
      .total,
    1,
  )
  const interrupted = await create('sync')
  await shutdown()
  await boot()
  assert.equal((await get(interrupted.id)).status, 'failed')
  assert.equal((await replay(interrupted.id)).at(-1).type, 'end')
  assert.equal((await get(r.id)).status, 'completed')
  assert.deepEqual(await json(url + '&level=ERROR&q=ENOSPC'), err)
})
test('未配置密钥的真实任务明确失败，可重新执行并保留原记录', async () => {
  const r = await post('runs', {
    scenario: 'boot',
    mode: 'live',
    question: '检查网关配置',
  })
  assert.match((await finished(r.id)).result, /DEEPSEEK_API_KEY/)
  const again = await post('runs/' + r.id + '/retry')
  assert.equal(again.parent, r.id)
  assert.equal((await finished(again.id)).status, 'failed')
})
test('拒绝跨站写入，拒绝用演示引擎提交自由问题', async () => {
  const alien = await fetch(base + '/api/runs', {
    method: 'POST',
    headers: {
      origin: 'http://example.invalid',
      'Content-Type': 'application/json',
    },
    body: '{}',
  })
  assert.equal(alien.status, 403)
  await assert.rejects(
    post('runs', { scenario: 'boot', mode: 'demo', question: '任意' }),
    /自由提问/,
  )
})
