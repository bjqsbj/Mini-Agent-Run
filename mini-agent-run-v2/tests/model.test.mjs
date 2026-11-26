import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeStream, liveTurn } from '../server/model.ts'
import { Runner } from '../server/runner.ts'
import { Store } from '../server/store.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'

function wire(chunks) {
  const lines = chunks
    .map((c) => 'data: ' + JSON.stringify({ choices: [c] }) + '\r\n\r\n')
    .join('')
  const bytes = new TextEncoder().encode(
    ': heartbeat\r\n' + lines + 'data: [DONE]\r\n\r\n',
  )
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 3)
        controller.enqueue(bytes.slice(i, i + 3))
      controller.close()
    },
  })
}
test('跨字节中文、跨帧参数及交错工具索引可以复原', async () => {
  let visible = ''
  const out = await decodeStream(
    wire([
      {
        delta: {
          content: '读日志',
          reasoning_content: 'private',
          tool_calls: [
            {
              index: 1,
              id: 'b',
              function: { name: 'get_config', arguments: '{}' },
            },
            {
              index: 0,
              id: 'a',
              function: { name: 'search_', arguments: '{"ser' },
            },
          ],
        },
      },
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              function: { name: 'logs', arguments: 'vice":"sync"}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ]),
    (t) => (visible += t),
  )
  assert.equal(visible, '读日志')
  assert.deepEqual(
    out.calls.map((x) => x.id),
    ['a', 'b'],
  )
  assert.equal(out.calls[0].function.name, 'search_logs')
  assert.deepEqual(JSON.parse(out.calls[0].function.arguments), {
    service: 'sync',
  })
})
test('断流和长度截断都不能被记作完整回答', async () => {
  for (const finish_reason of [null, 'length'])
    await assert.rejects(
      decodeStream(
        wire([{ delta: { content: '片段' }, finish_reason }]),
        () => {},
      ),
      /中断/,
    )
})
test('真实适配器按 tool_call_id 回传观测，第二轮接收模型结论', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'mini-model-'))
  const store = new Store(folder),
    runner = new Runner(store),
    requests = []
  const key = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = 'local-protocol-test'
  t.after(() => {
    if (key === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = key
    store.db.close()
    rmSync(folder, { recursive: true, force: true })
  })
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions')
    const body = JSON.parse(options.body)
    requests.push(body)
    const response =
      requests.length === 1
        ? {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  function: {
                    name: 'get_config',
                    arguments: '{"service":"gateway"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          }
        : {
            delta: { content: '网关配置端口与注册端口不同。' },
            finish_reason: 'stop',
          }
    return new Response(wire([response]))
  })
  const run = runner.start('网关的端口是多少？', 'boot', 'live')
  while (store.get(run.id).status === 'running') await once(runner.bus, run.id)
  assert.equal(store.get(run.id).status, 'completed')
  assert.equal(requests.length, 2)
  const obs = requests[1].messages.at(-1)
  assert.equal(obs.role, 'tool')
  assert.equal(obs.tool_call_id, 'call_1')
  assert.equal(JSON.parse(obs.content).databasePort, 5433)
})
test('上游鉴权失败展示可操作提示并隐藏响应正文', async (t) => {
  const key = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = 'local-only'
  t.after(() => {
    if (key === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = key
  })
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('private response', { status: 401 }),
  )
  await assert.rejects(
    liveTurn([], 'test', new AbortController().signal, () => {}),
    /HTTP 401，检查服务端密钥$/,
  )
})
