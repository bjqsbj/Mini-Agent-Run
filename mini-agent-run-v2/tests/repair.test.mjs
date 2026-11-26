import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { Store } from '../server/store.ts'
import { Runner } from '../server/runner.ts'
import {
  cases,
  example,
  applyEdits,
  validateFiles,
} from '../server/codebase.ts'
import { evaluate } from '../server/evaluate.ts'
import { ruleGate, triage } from '../server/repair.ts'

const folder = mkdtempSync(join(tmpdir(), 'agent-repair-')),
  store = new Store(folder),
  runner = new Runner(store)
after(() => {
  store.db.close()
  rmSync(folder, { recursive: true, force: true })
})
async function runCase(c, overrides = {}) {
  const run = runner.start(c.question, c.scene, 'demo', null, {
    caseId: c.id,
    ...overrides,
  })
  while (store.get(run.id).status === 'running') await once(runner.bus, run.id)
  return {
    run: store.get(run.id),
    events: store.after(run.id, 0),
    info: runner.code.details(run.id),
  }
}
for (const c of cases) {
  test('清单 / ' + c.title, async () => {
    const { run, events, info } = await runCase(c)
    const stage = (name) =>
      events.find((e) => e.type === 'stage' && e.data.stage === name)?.data
    assert.equal(
      run.status,
      {
        published: 'completed',
        unchanged: 'completed',
        failed: 'failed',
        clarify: 'clarify',
        reject: 'rejected',
      }[c.expected],
      run.result,
    )
    assert.equal(info.versions.length, c.expected === 'published' ? 2 : 1)
    if (['clarify', 'reject'].includes(c.expected)) {
      assert.ok(!events.some((e) => e.type === 'call'))
      return
    }
    const base = stage('基线结果').rows
    if (c.expected === 'unchanged') {
      assert.ok(base.every((r) => r.pass))
      return
    }
    const after = stage('候选测评').rows
    assert.ok(base.some((r) => !r.pass))
    assert.equal(after.length, base.length)
    assert.equal(
      after.every((r) => r.pass),
      c.expected === 'published',
    )
    if (c.expected === 'failed')
      assert.ok(base.some((r, i) => r.pass && !after[i].pass))
    if (c.expected === 'published')
      assert.notDeepEqual(runner.code.files(info.project, info.head), c.files)
  })
}
test('回滚追加版本，过时的写入不能覆盖较新版本', async () => {
  const c = example('gateway-port'),
    { run, info } = await runCase(c)
  const id = runner.code.rollback(run.id, info.base, info.head)
  assert.deepEqual(runner.code.files(info.project, id), c.files)
  assert.equal(runner.code.details(run.id).versions.length, 3)
  assert.throws(
    () => runner.code.rollback(run.id, info.base, info.head),
    /版本已变化/,
  )
  assert.equal(runner.code.project(info.project).head, id)
})
test('代码副本和上下文锚点校验', () => {
  assert.throws(() => validateFiles([{ path: '../mod.js', content: '' }]))
  assert.throws(
    () =>
      applyEdits(
        [{ path: 'm.js', content: 'aa' }],
        [{ path: 'm.js', before: 'a', after: 'b' }],
      ),
    /不唯一/,
  )
})
test('上传的多文件模块在隔离引擎实跑，耗时循环受限且后续断言独立', async () => {
  const files = [
    {
      path: 'src/a.ts',
      content:
        "import { plus } from './b.js'; export function calc(n:number){if(n<0)while(true){};return plus(n,2)}",
    },
    {
      path: 'src/b.ts',
      content: 'export function plus(a:number,b:number){return a+b}',
    },
  ]
  const rows = await evaluate(
    files,
    [-1, 3].map((n) => ({
      file: 'src/a.ts',
      fn: 'calc',
      name: '输入 ' + n,
      args: [n],
      expected: n + 2,
    })),
    new AbortController().signal,
  )
  assert.equal(rows[0].pass, false)
  assert.equal(rows[1].actual, 5)
  assert.equal(rows[1].pass, true)
})
test('规则保留带具体症状的口语反馈，真实筛选把含糊表达送入 LLM', async (t) => {
  assert.equal(ruleGate(example('parallel-tools').question), null)
  const key = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = 'local-test'
  t.after(() => {
    if (key === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = key
  })
  let called = 0
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    called++
    const b = JSON.parse(options.body)
    assert.ok(b.messages[1].content.includes('src/dispatch.ts'))
    const packet = {
      choices: [
        {
          delta: {
            content: JSON.stringify({
              decision: 'clarify',
              reason: '哪一个工具响应出错？',
            }),
          },
          finish_reason: 'stop',
        },
      ],
    }
    return new Response(
      'data: ' + JSON.stringify(packet) + '\n\ndata: [DONE]\n\n',
    )
  })
  const verdict = await triage(
    {
      mode: 'live',
      question: '最近有时表现挺奇怪，你能看看吗？',
      model: 'test',
    },
    { files: example('parallel-tools').files },
    new AbortController().signal,
    () => {},
  )
  assert.equal(verdict.decision, 'clarify')
  assert.equal(called, 1)
})
