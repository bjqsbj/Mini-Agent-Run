import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Store } from '../server/store.ts'
import { Runner } from '../server/runner.ts'
import { samples, sampleFiles, logPage } from '../server/doctor/tools.ts'
import { verifyReport } from '../server/doctor/report.ts'
import { importIssue } from '../server/doctor/issue.ts'

const tmp = mkdtempSync(join(tmpdir(), 'doctor-observations-')),
  store = new Store(tmp),
  runner = new Runner(store)
after(() => {
  store.db.close()
  rmSync(tmp, { recursive: true, force: true })
})
async function finish(run) {
  while (store.get(run.id).status === 'running') await once(runner.bus, run.id)
  const events = store.after(run.id, 0)
  assert.equal(store.get(run.id).status, 'completed', store.get(run.id).result)
  return {
    report: events.find((e) => e.type === 'doctor.report').data.report,
    events,
  }
}
// These expectations are visible to the tests only. They are never passed into a model prompt.
const oracle = [
  [5, '首 token', 'get_model_requests'],
  [3, '步数', 'get_tool_calls'],
  [8, '取消信号', 'get_tool_calls'],
  [2, '分片', 'get_model_requests'],
  [4, '429', 'get_model_requests'],
  [2, '上下文', 'get_resource_metrics'],
  [4, '第一页', 'get_storage_status'],
  [5, '注册表', 'get_mcp_status'],
]
for (const [index, s] of samples.entries())
  test(s.id + ' · 上传单文件、执行、多轮取证和报告', async () => {
    const file = sampleFiles(s.id)[0]
    const cli = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../examples/doctor/' + s.file, import.meta.url))],
      { encoding: 'utf8' },
    )
    assert.equal(cli.status, 0, cli.stderr)
    const snapshot = JSON.parse(cli.stdout)
    assert.ok(snapshot.trace.length)
    const run = runner.start(s.question, 'agent', 'demo', null, undefined, {
      files: [{ ...file, path: 'renamed.mjs' }],
    })
    const { report, events } = await finish(run)
    const [step, root, tool] = oracle[index]
    assert.equal(report.confidence, 'supported')
    assert.equal(report.step, step)
    assert.ok(report.root.includes(root))
    assert.ok(report.acceptance.length)
    const facts = events
      .filter((e) => e.type === 'observation')
      .map((e) => e.data.output)
    assert.ok(facts.some((f) => f.tool === tool))
    assert.ok(new Set(facts.map((f) => f.round)).size >= 2)
    assert.deepEqual(verifyReport(report, facts), report)
    if (index === 5) {
      const page = runner.doctor.page(run.id, 'archive', 'ERROR', 'checksum', 1)
      assert.equal(page.total, 1)
      assert.equal(page.rows[0].n, 100000)
      assert.equal(
        runner.doctor.page(run.id, 'archive', '', '', 2000).rows.length,
        50,
      )
      assert.equal(
        facts.filter((f) => f.tool === 'search_logs').at(-1).value.rows.length,
        1,
      )
    }
  })
test('源码改变后重新取证，不套用原案例结论', async () => {
  const files = sampleFiles('CASE-007').map((f) => ({
    ...f,
    content: f.content.replace(/count\s*=\s*86/, 'count=10'),
  }))
  const { report } = await finish(
    runner.start(samples[6].question, 'agent', 'demo', null, undefined, {
      files,
    }),
  )
  assert.equal(report.confidence, 'insufficient')
})
test('普通源码或问题与现场不符时不编造肯定结论', async () => {
  for (const files of [
    [{ path: 'plain.js', content: 'export const label="test"' }],
    sampleFiles('CASE-001'),
  ]) {
    const { report } = await finish(
      runner.start(samples[7].question, 'agent', 'demo', null, undefined, {
        files,
      }),
    )
    assert.equal(report.confidence, 'insufficient')
  }
})
test('报告拒绝虚构证据、同轮证据和不存在的轨迹步骤', () => {
  const observed = [
    {
      ref: 'E1',
      round: 1,
      tool: 'get_execution_trace',
      value: [{ step: 1, event: 'stop' }],
    },
    { ref: 'E2', round: 1, tool: 'inspect_code_snippet', value: 'guard' },
    { ref: 'E3', round: 2, tool: 'get_tool_calls', value: 'done' },
  ]
  const report = {
    confidence: 'supported',
    step: 1,
    root: '测试',
    alternatives: '待排除',
    fix: ['核对'],
    acceptance: ['复现'],
    evidence: observed.map((e, i) => ({
      ref: e.ref,
      quote: ['stop', 'guard', 'done'][i],
    })),
  }
  assert.equal(verifyReport(report, observed), report)
  assert.throws(() => verifyReport({ ...report, step: 3 }, observed))
  assert.throws(() =>
    verifyReport(
      report,
      observed.map((e) => ({ ...e, round: 1 })),
    ),
  )
  assert.throws(() =>
    verifyReport(
      { ...report, evidence: [{ ref: 'E9', quote: 'invented' }] },
      observed,
    ),
  )
})
test('压缩日志分页保留原始行号、总数与关键字过滤', () => {
  const s = {
    archive: [
      { count: 99999, level: 'INFO', text: 'record' },
      { count: 1, level: 'ERROR', text: 'bad' },
    ],
  }
  assert.equal(logPage(s, 'archive', '', '', 2000).rows.at(-1).n, 100000)
  assert.equal(logPage(s, 'archive', '', 'bad', 1).total, 1)
})
test('导入公开 Issue 的标题与正文，并处理错误链接和 PR', async (t) => {
  const url = 'https://github.com/example/agent/issues/23'
  const fetch = t.mock.method(globalThis, 'fetch', async (req) => {
    assert.equal(
      String(req),
      'https://api.github.com/repos/example/agent/issues/23',
    )
    return Response.json({
      title: '运行挂起',
      body: '工具结束后一直没有首 token。',
    })
  })
  assert.match((await importIssue(url)).question, /运行挂起[\s\S]+工具结束/)
  await assert.rejects(importIssue('https://example.org/issues/23'), /公开/)
  assert.equal(fetch.mock.callCount(), 1)
  fetch.mock.mockImplementation(async () =>
    Response.json({ title: 'PR', pull_request: {} }),
  )
  await assert.rejects(importIssue(url), /没有指向 Issue/)
})
test('Doctor 在采集及发起模型请求前处理空泛或无关反馈', async () => {
  for (const [question, status] of [
    ['我觉得Agent不好用', 'clarify'],
    ['解方程', 'rejected'],
  ]) {
    const run = runner.start(question, 'agent', 'live', null, undefined, {
      sample: 'CASE-004',
    })
    while (store.get(run.id).status === 'running')
      await once(runner.bus, run.id)
    assert.equal(store.get(run.id).status, status)
    assert.equal(
      store.after(run.id, 0).filter((e) => e.type === 'call').length,
      0,
    )
  }
})
