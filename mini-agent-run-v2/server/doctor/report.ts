export interface Evidence {
  ref: string
  tool: string
  round: number
  value: any
}
export interface Report {
  confidence: 'supported' | 'insufficient'
  step: number | null
  root: string
  evidence: { ref: string; quote: string }[]
  alternatives: string
  fix: string[]
  acceptance: string[]
}
export function verifyReport(r: Report, seen: Evidence[]) {
  if (!r || !['supported', 'insufficient'].includes(r.confidence))
    throw Error('confidence 必须是 supported 或 insufficient')
  if (typeof r.root !== 'string' || !r.root.trim())
    throw Error('root 必须是非空中文字符串')
  if (typeof r.alternatives !== 'string')
    throw Error('alternatives 必须是单个字符串')
  if (
    ![r.fix, r.acceptance].every(
      (a) =>
        Array.isArray(a) &&
        a.length &&
        a.every((x) => typeof x === 'string' && x.trim()),
    )
  )
    throw Error('需要修复方案和可操作的验收标准')
  if (!Array.isArray(r.evidence) || !r.evidence.length)
    throw Error('需要引用工具证据')
  const cited = r.evidence.map((c) => {
    const item = seen.find((e) => e.ref === c?.ref)
    if (
      !item ||
      typeof c.quote !== 'string' ||
      !c.quote.trim() ||
      !JSON.stringify(item.value).includes(c.quote)
    )
      throw Error('引用必须来自对应工具的真实返回值：' + c?.ref)
    return item
  })
  const trace = cited.find(
    (e) => e.tool === 'get_execution_trace' && Array.isArray(e.value),
  )
  if (
    r.step !== null &&
    (!Number.isInteger(r.step) ||
      !trace?.value.some((t: any) => t.step === r.step))
  )
    throw Error('关键步骤必须引用实际轨迹序号')
  if (
    r.confidence === 'supported' &&
    (r.step === null ||
      new Set(cited.map((e) => e.tool)).size < 3 ||
      new Set(cited.map((e) => e.round)).size < 2 ||
      !cited.some((e) => e.tool === 'inspect_code_snippet'))
  )
    throw Error('确定根因需要跨轮引用轨迹、源码及独立观测')
  return r
}
export function formatReport(r: Report, seen: Evidence[]) {
  const trace = seen.find(
    (e) => e.tool === 'get_execution_trace' && Array.isArray(e.value),
  )?.value
  const step = trace?.find((t: any) => t.step === r.step)
  return [
    r.confidence === 'supported'
      ? '诊断结论 · 当前现场支持'
      : '诊断结论 · 证据不足',
    r.root,
    '关键故障步骤',
    step
      ? '#' +
        step.step +
        ' ' +
        (typeof step.event === 'string'
          ? step.event
          : JSON.stringify(step.event))
      : '当前证据无法确定具体步骤',
    '可复核证据',
    ...r.evidence.map(
      (c) =>
        c.ref +
        ' · ' +
        seen.find((e) => e.ref === c.ref)!.tool +
        ' · ' +
        c.quote,
    ),
    '交叉验证与边界',
    r.alternatives,
    '修复方案',
    ...r.fix.map((s, i) => i + 1 + '. ' + s),
    '修复验收标准',
    ...r.acceptance.map((s, i) => i + 1 + '. ' + s),
  ].join('\n')
}
interface Profile {
  tools: string[]
  topic: RegExp
  matches: (v: Record<string, any>) => boolean
  event: string
  code: string
  root: string
  alternative: string
  fix: string[]
  acceptance: string[]
}
// Offline teaching policy. Its predicates consume only observations already returned by tools.
// Neither this module's conclusions nor the test oracle is sent to the live model.
export const profiles: Record<string, Profile> = {
  WAITING_MODEL: {
    tools: ['get_tool_calls', 'get_model_requests'],
    topic: /thinking|模型|等待|不返回|无输出|首.?token|卡住|24850/i,
    matches: (v) =>
      v.get_tool_calls?.every((c: any) => c.status === 'completed') &&
      v.get_model_requests?.at(-1)?.firstToken === false &&
      v.get_agent_config?.firstTokenTimeoutMs === null,
    event: 'watchRequest',
    code: 'timeoutMs !== null',
    root: '第二轮模型请求一直没有首 token，运行时没有首 token 等待上限，任务一直停在等待模型阶段。',
    alternative:
      '工具已经完成。现场能说明请求无进展，无法仅凭等待时间确定上游服务器内部为何无响应。',
    fix: [
      '分别配置首 token 超时与流式空闲超时。超时后中断请求并持久化失败终态。',
    ],
    acceptance: [
      '首包永久不来时在设定阈值转 FAILED；部分输出后挂起时保留已有内容。',
      '缓慢但在阈值内返回时成功；恢复模拟接口后重试并回看原失败记录。',
    ],
  },
  AGENT_LOOP: {
    tools: ['get_tool_calls', 'get_model_requests'],
    topic: /循环|重复|反复|read_file|26019/i,
    matches: (v) =>
      v.get_run_status?.status.uniqueToolResults === 1 &&
      v.get_tool_calls?.length >= 3 &&
      v.get_agent_config?.maxSteps === null &&
      v.get_agent_config.loopDetectionEnabled === false,
    event: 'nextStep',
    code: 'return {tool:',
    root: '调度器没有利用相同观测改变动作。相同路径和结果反复进入下一轮，重复检测和步数上限均未生效。',
    alternative:
      '工具能成功读取文件；不断返回同一哈希表明采样期间没有新增信息。',
    fix: [
      '按工具、参数和返回摘要检测连续无进展；先提示换策略，到最大轮数时记录终态。',
    ],
    acceptance: [
      '让模型永远请求同一文件，应在配置上限（如 10 轮）内结束。',
      '轮询时改变返回哈希，应允许继续；仍受全局预算约束。',
    ],
  },
  CANCELLATION: {
    tools: ['get_tool_calls', 'get_model_requests'],
    topic: /停止|取消|终止|escape|26802/i,
    matches: (v) =>
      v.get_run_status?.status.status === 'STOPPED' &&
      v.get_tool_calls?.some((c: any) => c.aborted === false) &&
      v.get_model_requests?.requestsAfterStop > 0 &&
      v.get_agent_config?.terminalStateGuard === false,
    event: 'agent.next_step.scheduled',
    code: 'run.modelAborted=true',
    root: '停止操作只中断模型流。并行工具没有收到取消信号，其迟到的结果又通过缺少终态保护的调度器启动下一轮。',
    alternative:
      '已记录 STOPPED 和流中断，但之后出现新的模型请求，单纯界面显示滞后不能解释这条轨迹。',
    fix: [
      '同一取消信号传给模型和每个工具。提交结果和调度下一步前核对任务代次及终态。',
    ],
    acceptance: [
      '分别在模型输出、单工具、并行工具运行时停止，全部可取消工作结束。',
      '注入迟到结果及第二次停止；停止后新增模型请求数为 0，历史保留停止前事件。',
    ],
  },
  TOOL_ARGUMENTS: {
    tools: ['get_model_requests', 'get_tool_calls'],
    topic: /参数|分片|解析|service|keyword|8394|35514/i,
    matches: (v) =>
      v.get_model_requests?.fragments?.length > 1 &&
      v.get_tool_calls?.[0]?.missing?.length > 0 &&
      v.get_agent_config?.dispatchOn === 'first_delta',
    event: 'dispatchFirst',
    code: 'JSON.parse(delta)',
    root: '首个参数分片到达就触发解析，异常回退为空对象并派发工具；完整参数随后才到达。',
    alternative: '模型分片拼接后包含参数，错误发生在派发和解析边界。',
    fix: [
      '按调用 index / ID 缓存分片，收到结束标记后统一解析并校验 schema，再派发一次。',
    ],
    acceptance: [
      '使用不同字节切分、交错两个调用，校验每个工具的实参与完整 JSON 相同。',
      '截断或缺必填参数时必须报告错误且零派发。',
    ],
  },
  MODEL_API: {
    tools: ['get_model_requests'],
    topic: /限流|429|模型|接口|并发|重试|rate.?limit/i,
    matches: (v) =>
      v.get_model_requests?.attempts?.filter((x: any) => x.status === 429)
        .length >= 2 && v.get_agent_config?.retryDelayMs === 0,
    event: 'requestWithRetry',
    code: 'elapsedMs:0',
    root: '上游返回 429 后，同一时刻立即重试。没有并发上限或退避，加剧请求压力并耗尽重试次数。',
    alternative:
      '记录指向限流；没有认证失败的观测，也无法由此确定服务商精确配额。',
    fix: [
      '限制并发并排队；对 429 设置有界指数退避和抖动，遵循 Retry-After，对 401 立即提示认证错误。',
    ],
    acceptance: [
      '令接口依次返回 429、429、200；验证虚拟等待间隔至少为 1 秒、2 秒，并成功完成。',
      '持续 429 时在预算内结束；401 仅请求一次。',
    ],
  },
  OUTPUT_RENDER: {
    tools: ['get_resource_metrics', 'get_model_requests', 'get_tool_calls'],
    topic: /日志|渲染|上下文|token|卡顿|33822|24048|22091/i,
    matches: (v) =>
      v.get_resource_metrics?.renderedDomNodes ===
        v.get_resource_metrics?.outputLines &&
      v.get_model_requests?.error === 'context_length_exceeded' &&
      v.get_agent_config?.rawOutputIncludedInModelContext === true,
    event: 'prepareOutput',
    code: 'modelContextBytes:lines*bytesPerLine',
    root: '工具已经完成。前端把原始输出逐行映射成渲染节点，后端又把相同的完整输出放入模型上下文，形成两个独立瓶颈。',
    alternative: '长任务耗时和内存是模拟现场样本；工具本身已经返回。',
    fix: [
      '原始日志独立存档并分页或虚拟滚动；模型只接收限长摘要、错误行与引用。',
    ],
    acceptance: [
      '依次用 100、1000、10000、100000 行测首屏、内存、检索耗时与停止按钮响应。',
      '保留原始行号；DOM 节点数受页大小约束，模型上下文受独立预算约束。',
    ],
  },
  HISTORY_RESTORE: {
    tools: ['get_storage_status', 'get_session_status'],
    topic: /历史|重启|记录|报告|丢失|42311/i,
    matches: (v) =>
      v.get_storage_status?.finalReportExists === true &&
      v.get_session_status?.hasMore === true &&
      v.get_session_status?.pageRequests === 1 &&
      v.get_storage_status.databaseEventCount >
        v.get_session_status.frontendRenderedEventCount,
    event: 'restoreHistory',
    code: 'fetchEvents(database,0,20)',
    root: '数据库中有完整事件和报告，API 只返回第一页。前端收到 hasMore 后没有继续请求，所以历史显示不完整。',
    alternative:
      '数据库持久化成功；第一页返回条数与渲染条数相符，差异发生在后续页的消费。',
    fix: ['跟随游标分页直到结束，按事件 ID 去重并显示加载和失败状态。'],
    acceptance: [
      '重启后加载 86 条事件，跨越 20 条页边界，确认 86 个唯一 ID 和最终报告可见。',
      '覆盖单页、刚好满页以及中间页失败后重试。',
    ],
  },
  MCP_DISCOVERY: {
    tools: ['get_mcp_status', 'get_session_status', 'get_tool_calls'],
    topic: /mcp|重连|找不到|注册|38043/i,
    matches: (v) =>
      v.get_mcp_status?.connection === 'CONNECTED' &&
      v.get_mcp_status.available?.includes('read_file') &&
      v.get_session_status?.registered?.length === 0 &&
      v.get_agent_config?.refreshOnReconnect === false,
    event: 'mcp.reconnected',
    code: "session.connection='CONNECTED'",
    root: '连接恢复时只更新连接状态；断线时清空的会话工具注册表未刷新，下一次模型请求仍看不到工具。',
    alternative:
      '服务端已连接且列出 read_file，可将问题缩小到会话注册表与下一轮工具定义的同步。',
    fix: [
      '重连后重新列出工具并原子替换会话注册表，刷新下一轮模型请求的工具定义。',
    ],
    acceptance: [
      '断开并重连后，不重建会话即可查询 read_file；模型收到服务端最新三个工具。',
      '重复重连应去重，并移除服务端已经删除的工具。',
    ],
  },
}

export function offlineReport(question: string, seen: Evidence[]): Report {
  const v = Object.fromEntries(seen.map((e) => [e.tool, e.value]))
  const p = profiles[v.get_run_status?.status?.phase]
  const step = v.get_execution_trace?.find?.((t: any) =>
    String(t.event).includes(p?.event ?? '__missing__'),
  )
  const code = v.inspect_code_snippet?.lines?.find(
    (l: any) =>
      p && l.text.replace(/\s/g, '').includes(p.code.replace(/\s/g, '')),
  )
  const supported = p && p.topic.test(question) && p.matches(v) && step && code
  const evidence = seen.map((e) => {
    let quote = JSON.stringify(e.value)
    if (e.tool === 'get_execution_trace' && step) quote = String(step.event)
    else if (e.tool === 'inspect_code_snippet' && code)
      quote = JSON.stringify(code).slice(1, -1)
    return { ref: e.ref, quote: quote.slice(0, 180) }
  })
  if (!supported)
    return {
      confidence: 'insufficient',
      step: null,
      root: '当前观测不足以对这条反馈确认根因。',
      alternatives:
        '检查反馈与观测是否来自同一次运行，以及模块是否提供完整轨迹。',
      fix: ['补充缺失现场，或切换真实模型对自定义源码进行调查。'],
      acceptance: [
        '以相同输入复现，取得同一运行的源码、轨迹及独立观测后重新评估。',
      ],
      evidence,
    }
  return {
    confidence: 'supported',
    step: step.step,
    root: p.root,
    alternatives: p.alternative,
    fix: p.fix,
    acceptance: p.acceptance,
    evidence,
  }
}
